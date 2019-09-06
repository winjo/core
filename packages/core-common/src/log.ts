import { Event } from './event';

export enum LogLevel {
  Verbose,
  Debug,
  Info,
  Warning,
  Error,
  Critical,
  Off,
}

export enum SupportLogNamespace {
  // 主进程
  Main = 'main',
  // 渲染进程
  Render = 'render',
  // Node进程
  Node = 'node',
  // 浏览器进程
  Browser = 'browser',
  // 插件进程
  ExtensionHost = 'extHost',
  // 应用层
  App = 'app',
  // 其他未分类
  OTHER = 'other',
}

export interface BaseLogServiceOptions {
  /**
   * 对应存储日志的文件名
   */
  namespace?: string;
  /**
   * 设置落盘级别，默认 LogLevel.Info
   */
  logLevel?: LogLevel;
  /**
   * 进程的PID，会作为日志内容的前缀
   */
  pid?: number;
  /**
   * 落盘日志的存储文件夹
   * 例如： ~/.kaitian/logs/20180909/
   */
  logDir?: string;
}

export interface ILogServiceOptions extends BaseLogServiceOptions {
  logServiceManager: ILogServiceManager;
  namespace: string;
  logLevel?: LogLevel;
  pid?: number;
  isShowConsoleLog?: boolean;
}

export interface Archive {
  /**
   * 将压缩的zip文件，写入流；通过该方法可以将zip文件写入本地或上传服务器
   * @param writeStream fs.WriteStream
   */
  pipe(writeStream: any);
}

export const ILogServiceManager = Symbol('ILogServiceManager');
export interface ILogServiceManager {
  onDidChangeLogLevel: Event<LogLevel>;

  getLogger(namespace: SupportLogNamespace, loggerOptions?: BaseLogServiceOptions): ILogService;
  getGlobalLogLevel(): LogLevel;
  removeLogger(namespace: SupportLogNamespace);
  setGlobalLogLevel(level: LogLevel);

  /**
   * 返回当前日志存放的目录
   */
  getLogFolder(): string;

  /**
   * 返回保存日志的根目录，为 getLogFolder() 的父目录
   */
  getRootLogFolder(): string;

  /**
   * 清理 getRootLogFolder() 中最近5天前的日志，仅保留最近5天日志
   */
  cleanOldLogs(): Promise<void>;

  /**
   * 清理 getRootLogFolder() 中的所有日志
   */
  cleanAllLogs(): Promise<void>;

  /**
   * 清理 day 之前的日志目录
   * @param day --格式为： 20190807
   */
  cleanExpiredLogs(day: number): Promise<void>;

  /**
   * @param day --格式为： 20190807
   */
  getLogZipArchiveByDay(day: number): Promise<Archive>;

  getLogZipArchiveByFolder(foldPath: string): Promise<Archive>;

  dispose();
}

export interface IBaseLogService {
  getLevel(): LogLevel;
  setLevel(level: LogLevel): void;

  verbose(...args: any[]): void;
  debug(...args: any[]): void;
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  critical(...args: any[]): void;

  sendLog(level: LogLevel, message: string): void;

  /**
   * 将缓存日志罗盘
   */
  drop():Promise<void>;

  dispose(): void;
}

export interface ILogService extends IBaseLogService {
  setOptions(options: BaseLogServiceOptions);
}

export const LogServiceForClientPath =  'LogServiceForClientPath';

export interface ILogServiceClient {
  getLevel():Promise<LogLevel>;
  setLevel(level: LogLevel): Promise<void>;

  verbose(...args: any[]): Promise<void>;
  debug(...args: any[]): Promise<void>;
  log(...args: any[]): Promise<void>;
  warn(...args: any[]): Promise<void>;
  error(...args: any[]): Promise<void>;
  critical(...args: any[]): Promise<void>;
  
  dispose(): Promise<void>;
}

export const ILoggerManagerClient = Symbol(`ILoggerManagerClient`);
export interface ILoggerManagerClient {
  onDidChangeLogLevel: Event<LogLevel>;
  getLogger(namespace: SupportLogNamespace, pid?: number): ILogServiceClient;

  setGlobalLogLevel(level: LogLevel): Promise<void>;
  getGlobalLogLevel(): Promise<LogLevel>;
  dispose(): Promise<void>;
}

/**
 * DebugLog
 */
export interface IDebugLog {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
  debug(...args: any[]): void;
  info(...args: any[]): void;

  destroy(): void;
}

/**
* 只输出在控制台，不会落盘
* const debugLog = new DebugLog('FileService');
*
* @export
* @class DebugLog
* @implements {IDebugLog}
*/
const isNode = typeof process !== undefined && process.release;
const isChrome = !isNode && /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
export class DebugLog implements IDebugLog {
  private namespace: string;
  private isEnable = false;

  constructor(namespace?: string) {

    if (typeof process !== undefined &&
      process.env &&
      process.env.KTLOG_SHOW_DEBUG) {
      this.isEnable = true;
    }

    this.namespace = namespace || '';
  }

  private getPre(level: string, color: string) {
    const text = this.namespace ? `[${this.namespace}:${level}]` : `[${level}]`;
    return this.getColor(color, text);
  }

  private getColor(color: string, message: string) {
    if (!isNode && !isChrome) {
      return message;
    }
    const colors = {
      reset: '\x1b[0m',

      //text color

      black: '\x1b[30m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b3[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',

      //background color

      blackBg: '\x1b[40m',
      redBg: '\x1b[41m',
      greenBg: '\x1b[42m',
      yellowBg: '\x1b[43m',
      blueBg: '\x1b[44m',
      magentaBg: '\x1b[45m',
      cyanBg: '\x1b[46m',
      whiteBg: '\x1b[47m'
    }

    return (colors[color] || '' ) + message + colors.reset;
  }

  log = (...args: any[]) => {
    if (!this.isEnable) {
      return;
    }
    return console.log(this.getPre('log', 'green'), ...args);
  }

  error = (...args: any[]) => {
    // 错误一直显示
    return console.error(this.getPre('error', 'red'), ...args);
  }

  warn = (...args: any[]) => {
    if (!this.isEnable) {
      return;
    }
    return console.warn(this.getPre('warn', 'yellow'), ...args);
  }

  info = (...args: any[]) => {
    if (!this.isEnable) {
      return;
    }
    return console.info(this.getPre('log', 'green'), ...args);
  }

  debug = (...args: any[]) => {
    if (!this.isEnable) {
      return;
    }
    return console.debug(this.getPre('debug', 'blue'), ...args);
  }

  destroy() { }
}

/**
 * 兼容旧logger 提供的类型，同 ILogServiceClient
 */
export const ILogger = Symbol('ILogger');
// tslint:disable-next-line:no-empty-interface
export interface ILogger extends ILogServiceClient {}

/** 
 * 只输出在控制台，不会落盘
 */
export function getLogger(namespace?: string): any {
  function showWarn() {
    // Do nothing
  }
  const debugLog = new DebugLog(namespace);
  return {
    get log() {
      showWarn();
      return debugLog.log;
    },
    get debug() {
      showWarn();
      return debugLog.debug;
    },
    get error() {
      showWarn();
      return debugLog.error;
    },
    get info() {
      showWarn();
      return debugLog.info;
    },
    get warn() {
      showWarn();
      return debugLog.warn;
    }
  }
}
