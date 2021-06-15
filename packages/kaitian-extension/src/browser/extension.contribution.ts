import { Autowired, Injector, INJECTOR_TOKEN } from '@ali/common-di';
import { WSChannelHandler } from '@ali/ide-connection/lib/browser/ws-channel-handler';
import { EDITOR_COMMANDS, UriComponents, ClientAppContribution, CommandContribution, CommandRegistry, CommandService, Domain, electronEnv, FILE_COMMANDS, formatLocalize, getIcon, IAsyncResult, IClientApp, IContextKeyService, IEventBus, IPreferenceSettingsService, isElectronEnv, localize, QuickOpenGroupItem, QuickOpenItem, QuickOpenItemOptions, QuickOpenService, replaceLocalizePlaceholder, URI, ILogger } from '@ali/ide-core-browser';
import { IStatusBarService, StatusBarAlignment, StatusBarEntryAccessor } from '@ali/ide-core-browser/lib/services/status-bar-service';
import { IWindowDialogService } from '@ali/ide-overlay';
import { IWebviewService } from '@ali/ide-webview';
import { IResourceOpenOptions, WorkbenchEditorService } from '@ali/ide-editor';
import type * as vscode from 'vscode';

import { TextDocumentShowOptions, ViewColumn } from '../common/vscode';
import { EMIT_EXT_HOST_EVENT, ExtensionHostProfilerServicePath, ExtensionHostType, ExtensionService, IExtensionHostProfilerService } from '../common';
import { ActivatedExtension } from '../common/activator';
import * as VSCodeBuiltinCommands from './vscode/builtin-commands';
import { AbstractExtInstanceManagementService, ExtensionApiReadyEvent, ExtHostEvent, IActivationEventService, Serializable } from './types';
import { fromRange, isLikelyVscodeRange, viewColumnToResourceOpenOptions } from '../common/vscode/converter';

@Domain(ClientAppContribution)
export class KaitianExtensionClientAppContribution implements ClientAppContribution {
  @Autowired(IPreferenceSettingsService)
  private readonly preferenceSettingsService: IPreferenceSettingsService;

  @Autowired(QuickOpenService)
  protected readonly quickOpenService: QuickOpenService;

  @Autowired(IStatusBarService)
  protected readonly statusBar: IStatusBarService;

  @Autowired(IEventBus)
  private readonly eventBus: IEventBus;

  @Autowired(IWebviewService)
  webviewService: IWebviewService;

  @Autowired(ExtensionService)
  private readonly extensionService: ExtensionService;

  async initialize() {
    await this.extensionService.activate();
    const disposer = this.webviewService.registerWebviewReviver({
      handles: (id: string) => 0,
      revive: async (id: string) => {
        return new Promise<void>((resolve) => {
          this.eventBus.on(ExtensionApiReadyEvent, () => {
            disposer.dispose();
            resolve(this.webviewService.tryReviveWebviewComponent(id));
          });
        });
      },
    });
  }

  async onStart() {
    this.preferenceSettingsService.registerSettingGroup({
      id: 'extension',
      title: localize('settings.group.extension'),
      iconClass: getIcon('extension'),
    });
  }

  onStop() {
    // IDE 关闭或者重启时销毁插件进程
    this.extensionService.disposeExtensions();
  }

  onContextKeyServiceReady(contextKeyService: IContextKeyService) {
    // `listFocus` 为 vscode 旧版 api，已经废弃，默认设置为 true
    contextKeyService.createKey('listFocus', true);
  }
}

@Domain(CommandContribution)
export class KaitianExtensionCommandContribution implements CommandContribution {
  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  @Autowired(WorkbenchEditorService)
  private readonly workbenchEditorService: WorkbenchEditorService;

  @Autowired(IActivationEventService)
  private readonly activationEventService: IActivationEventService;

  @Autowired(QuickOpenService)
  protected readonly quickOpenService: QuickOpenService;

  @Autowired(ExtensionHostProfilerServicePath)
  private readonly extensionProfiler: IExtensionHostProfilerService;

  @Autowired(IStatusBarService)
  protected readonly statusBar: IStatusBarService;

  @Autowired(IWindowDialogService)
  private readonly dialogService: IWindowDialogService;

  @Autowired(IClientApp)
  private readonly clientApp: IClientApp;

  @Autowired(IEventBus)
  private readonly eventBus: IEventBus;

  @Autowired(CommandService)
  private readonly commandService: CommandService;

  @Autowired(IContextKeyService)
  private readonly contextKeyService: IContextKeyService;

  @Autowired(IWebviewService)
  webviewService: IWebviewService;

  @Autowired(ExtensionService)
  private readonly extensionService: ExtensionService;

  @Autowired(AbstractExtInstanceManagementService)
  private readonly extensionInstanceManageService: AbstractExtInstanceManagementService;

  @Autowired(ILogger)
  private readonly logger: ILogger;

  private cpuProfileStatus: StatusBarEntryAccessor | null;

  registerCommands(registry: CommandRegistry) {
    registry.registerCommand({
      id: 'ext.restart',
      label: '重启进程',
    }, {
      execute: async () => {
        this.logger.log('插件进程开始重启');
        await this.extensionService.restartExtProcess();
        this.logger.log('插件进程重启结束');
      },
    });

    this.registerVSCBuiltinCommands(registry);
  }

  private registerVSCBuiltinCommands(registry: CommandRegistry) {
    // vscode `setContext` for extensions
    // only works for global scoped context
    registry.registerCommand(VSCodeBuiltinCommands.SET_CONTEXT, {
      execute: (contextKey: any, contextValue: any) => {
        this.contextKeyService.createKey(String(contextKey), contextValue);
      },
    });

    registry.registerCommand(VSCodeBuiltinCommands.RELOAD_WINDOW_COMMAND, {
      execute: () => {
        this.clientApp.fireOnReload();
      },
    });

    registry.registerCommand(EMIT_EXT_HOST_EVENT, {
      execute: async (eventName: string, ...eventArgs: Serializable[]) => {
        // activationEvent 添加 onEvent:xxx
        await this.activationEventService.fireEvent('onEvent:' + eventName);
        const results = await this.eventBus.fireAndAwait<any[]>(new ExtHostEvent({
          eventName,
          eventArgs,
        }));
        const mergedResults: IAsyncResult<any[]>[] = [];
        results.forEach((r) => {
          if (r.err) {
            mergedResults.push(r);
          } else {
            mergedResults.push(...r.result! || []);
          }
        });
        return mergedResults;
      },
    });

    registry.registerCommand(VSCodeBuiltinCommands.SHOW_RUN_TIME_EXTENSION, {
      execute: async () => {
        const activated = await this.extensionService.getActivatedExtensions();
        this.quickOpenService.open({
          onType: (lookFor: string, acceptor) => acceptor(this.asQuickOpenItems(activated)),
        }, { placeholder: '运行中的插件' });
      },
    });

    registry.registerCommand(VSCodeBuiltinCommands.START_EXTENSION_HOST_PROFILER, {
      execute: async () => {
        if (!this.cpuProfileStatus) {
          this.cpuProfileStatus = this.statusBar.addElement('ExtensionHostProfile', {
            tooltip: formatLocalize('extension.profiling.clickStop', 'Click to stop profiling.'),
            text: `$(sync~spin) ${formatLocalize('extension.profilingExtensionHost', 'Profiling Extension Host')}`,
            alignment: StatusBarAlignment.RIGHT,
            command: VSCodeBuiltinCommands.STOP_EXTENSION_HOST_PROFILER.id,
          });
        }
        await this.extensionProfiler.$startProfile(this.clientId);
      },
      isPermitted: () => false,
    });

    registry.registerCommand(VSCodeBuiltinCommands.STOP_EXTENSION_HOST_PROFILER, {
      execute: async () => {
        const successful = await this.extensionProfiler.$stopProfile(this.clientId);

        if (this.cpuProfileStatus) {
          this.cpuProfileStatus.dispose();
          this.cpuProfileStatus = null;
        }

        if (successful) {
          const saveUri = await this.dialogService.showSaveDialog({
            saveLabel: formatLocalize('extension.profile.save', 'Save Extension Host Profile'),
            showNameInput: true,
            defaultFileName: `CPU-${new Date().toISOString().replace(/[\-:]/g, '')}.cpuprofile`,
          });
          if (saveUri?.codeUri) {
            await this.extensionProfiler.$saveLastProfile(saveUri?.codeUri.fsPath);
          }
        }
      },
      isPermitted: () => false,
    });

    registry.registerCommand(VSCodeBuiltinCommands.COPY_FILE_PATH, {
      execute: async (uri: vscode.Uri) => {
        await this.commandService.executeCommand(FILE_COMMANDS.COPY_PATH.id, URI.from(uri));
      },
    });

    registry.registerCommand(VSCodeBuiltinCommands.COPY_RELATIVE_FILE_PATH, {
      execute: async (uri: vscode.Uri) => {
        await this.commandService.executeCommand(FILE_COMMANDS.COPY_RELATIVE_PATH.id, URI.from(uri));
      },
    });

    registry.registerCommand(VSCodeBuiltinCommands.OPEN, {
      execute: (uriComponents: UriComponents, columnOrOptions?: ViewColumn | TextDocumentShowOptions, label?: string) => {
        const uri = URI.from(uriComponents);
        const options: IResourceOpenOptions = {};
        if (columnOrOptions) {
          if (typeof columnOrOptions === 'number') {
            options.groupIndex = columnOrOptions;
          } else {
            options.groupIndex = columnOrOptions.viewColumn;
            options.preserveFocus = columnOrOptions.preserveFocus;
            // 这个range 可能是 vscode.range， 因为不会经过args转换
            if (columnOrOptions.selection && isLikelyVscodeRange(columnOrOptions.selection)) {
              columnOrOptions.selection = fromRange(columnOrOptions.selection);
            }
            options.range = columnOrOptions.selection;
            options.preview = columnOrOptions.preview;
          }
        }
        if (label) {
          options.label = label;
        }
        return this.workbenchEditorService.open(uri, options);
      },
    });

    registry.registerCommand(VSCodeBuiltinCommands.DIFF, {
      execute: (left: UriComponents, right: UriComponents, title: string, options: any = {}) => {
        const openOptions: IResourceOpenOptions = {
          ...viewColumnToResourceOpenOptions(options.viewColumn),
          revealFirstDiff: true,
          ...options,
        };
        return this.commandService.executeCommand(EDITOR_COMMANDS.COMPARE.id, {
          original: URI.from(left),
          modified: URI.from(right),
          name: title,
        }, openOptions);
      },
    });

    [
      // editor builtin commands
      VSCodeBuiltinCommands.WORKBENCH_CLOSE_ACTIVE_EDITOR,
      VSCodeBuiltinCommands.REVERT_AND_CLOSE_ACTIVE_EDITOR,
      VSCodeBuiltinCommands.SPLIT_EDITOR_RIGHT,
      VSCodeBuiltinCommands.SPLIT_EDITOR_DOWN,
      VSCodeBuiltinCommands.EDITOR_NAVIGATE_BACK,
      VSCodeBuiltinCommands.EDITOR_NAVIGATE_FORWARD,
      VSCodeBuiltinCommands.EDITOR_SAVE_ALL,
      VSCodeBuiltinCommands.CLOSE_ALL_EDITORS,
      VSCodeBuiltinCommands.PREVIOUS_EDITOR,
      VSCodeBuiltinCommands.PREVIOUS_EDITOR_IN_GROUP,
      VSCodeBuiltinCommands.NEXT_EDITOR,
      VSCodeBuiltinCommands.NEXT_EDITOR_IN_GROUP,
      VSCodeBuiltinCommands.EVEN_EDITOR_WIDTH,
      VSCodeBuiltinCommands.CLOSE_OTHER_GROUPS,
      VSCodeBuiltinCommands.LAST_EDITOR_IN_GROUP,
      VSCodeBuiltinCommands.OPEN_EDITOR_AT_INDEX,
      VSCodeBuiltinCommands.CLOSE_OTHER_EDITORS,
      VSCodeBuiltinCommands.NEW_UNTITLED_FILE,
      VSCodeBuiltinCommands.FILE_SAVE,
      VSCodeBuiltinCommands.SPLIT_EDITOR,
      VSCodeBuiltinCommands.SPLIT_EDITOR_ORTHOGONAL,
      VSCodeBuiltinCommands.NAVIGATE_LEFT,
      VSCodeBuiltinCommands.NAVIGATE_RIGHT,
      VSCodeBuiltinCommands.NAVIGATE_UP,
      VSCodeBuiltinCommands.NAVIGATE_DOWN,
      VSCodeBuiltinCommands.NAVIGATE_NEXT,
      VSCodeBuiltinCommands.REVERT_FILES,
      VSCodeBuiltinCommands.WORKBENCH_FOCUS_FILES_EXPLORER,
      VSCodeBuiltinCommands.WORKBENCH_FOCUS_ACTIVE_EDITOR_GROUP,
      // debug builtin commands
      VSCodeBuiltinCommands.DEBUG_COMMAND_STEP_INTO,
      VSCodeBuiltinCommands.DEBUG_COMMAND_STEP_OVER,
      VSCodeBuiltinCommands.DEBUG_COMMAND_STEP_OUT,
      VSCodeBuiltinCommands.DEBUG_COMMAND_CONTINUE,
      VSCodeBuiltinCommands.DEBUG_COMMAND_RUN,
      VSCodeBuiltinCommands.DEBUG_COMMAND_START,
      VSCodeBuiltinCommands.DEBUG_COMMAND_PAUSE,
      VSCodeBuiltinCommands.DEBUG_COMMAND_RESTART,
      VSCodeBuiltinCommands.DEBUG_COMMAND_STOP,
      VSCodeBuiltinCommands.EDITOR_SHOW_ALL_SYMBOLS,
      // explorer builtin commands
      VSCodeBuiltinCommands.REVEAL_IN_EXPLORER,
      VSCodeBuiltinCommands.OPEN_FOLDER,
      // terminal builtin commands
      VSCodeBuiltinCommands.CLEAR_TERMINAL,
      VSCodeBuiltinCommands.TOGGLE_WORKBENCH_VIEW_TERMINAL,
      // others
      VSCodeBuiltinCommands.RELOAD_WINDOW,
      VSCodeBuiltinCommands.SETTINGS_COMMAND_OPEN_SETTINGS,
    ].forEach((command) => {
      registry.registerCommand(command);
    });
  }

  private asQuickOpenItems(activated: { node?: ActivatedExtension[] | undefined; worker?: ActivatedExtension[] | undefined; }): QuickOpenItem<QuickOpenItemOptions>[] {
    const nodes = activated.node ? activated.node.map((e, i) => this.toQuickOpenItem(e, 'node', i === 0)) : [];
    const workers = activated.worker ? activated.worker.map((e, i) => this.toQuickOpenItem(e, 'worker', i === 0)) : [];
    return [
      ...nodes,
      ...workers,
    ];
  }

  private toQuickOpenItem(e: ActivatedExtension, host: ExtensionHostType, firstItem: boolean): QuickOpenItem<QuickOpenItemOptions> {
    const extension = this.extensionInstanceManageService.getExtensionInstanceByExtId(e.id);
    return new QuickOpenGroupItem({
      groupLabel: firstItem ? host : undefined,
      showBorder: !!firstItem,
      label: replaceLocalizePlaceholder(e.displayName, e.id),
      description: replaceLocalizePlaceholder(e.description, e.id),
      detail: extension?.realPath,
    });
  }

  /**
   * 当前客户端 id
   */
  private get clientId() {
    let clientId: string;
    if (isElectronEnv()) {
      clientId = electronEnv.metadata.windowClientId;
    } else {
      const channelHandler = this.injector.get(WSChannelHandler);
      clientId = channelHandler.clientId;
    }
    return clientId;
  }
}
