import { z } from 'zod';

import { Autowired, Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { Selection, SelectionDirection } from '@opensumi/monaco-editor-core/esm/vs/editor/common/core/selection';

import { IMCPServerRegistry, MCPLogger, MCPServerContribution, MCPToolDefinition } from '../../types';
import { LiveInlineDiffPreviewer } from '../../widget/inline-diff/inline-diff-previewer';
import { InlineDiffController } from '../../widget/inline-diff/inline-diff.controller';

const inputSchema = z.object({
  text: z.string().describe('The new content to replace the entire file with'),
});

@Domain(MCPServerContribution)
export class ReplaceOpenEditorFileByDiffPreviewerTool implements MCPServerContribution {
  @Autowired(WorkbenchEditorService)
  private readonly editorService: WorkbenchEditorService;

  registerMCPServer(registry: IMCPServerRegistry): void {
    registry.registerMCPTool(this.getToolDefinition());
  }

  getToolDefinition(): MCPToolDefinition {
    return {
      name: 'replace_open_in_editor_file_text',
      description:
        'Replaces the entire content of the currently active file in the IDE editor with specified new text using diff previewer. ' +
        "Use this tool when you need to completely overwrite the current file's content with diff preview. " +
        'Requires a text parameter containing the new content. ' +
        'Returns one of three possible responses: ' +
        '"ok" if the file content was successfully replaced, ' +
        '"no file open" if no editor is active, ' +
        '"unknown error" if the operation fails.',
      inputSchema,
      handler: this.handler.bind(this),
    };
  }

  private async handler(args: z.infer<typeof inputSchema>, logger: MCPLogger) {
    try {
      const editor = this.editorService.currentEditor;
      if (!editor || !editor.monacoEditor) {
        logger.appendLine('Error: No active text editor found');
        return {
          content: [{ type: 'text', text: 'no file open' }],
          isError: true,
        };
      }

      // Get the model and its full range
      const model = editor.monacoEditor.getModel();
      if (!model) {
        logger.appendLine('Error: No model found for current editor');
        return {
          content: [{ type: 'text', text: 'unknown error' }],
          isError: true,
        };
      }

      const fullRange = model.getFullModelRange();
      const inlineDiffHandler = InlineDiffController.get(editor.monacoEditor)!;

      // Create diff previewer
      const previewer = inlineDiffHandler.createDiffPreviewer(
        editor.monacoEditor,
        Selection.fromRange(fullRange, SelectionDirection.LTR),
        {
          disposeWhenEditorClosed: false,
          renderRemovedWidgetImmediately: true,
        },
      ) as LiveInlineDiffPreviewer;

      // Set the new content
      previewer.setValue(args.text);

      logger.appendLine('Successfully created diff preview with new content');
      return {
        content: [{ type: 'text', text: 'ok' }],
      };
    } catch (error) {
      logger.appendLine(`Error during file content replacement: ${error}`);
      return {
        content: [{ type: 'text', text: 'unknown error' }],
        isError: true,
      };
    }
  }
}
