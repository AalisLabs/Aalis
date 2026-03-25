// ----- CLI 服务接口 -----

/**
 * CLI 服务 —— 命令行交互界面
 *
 * 提供终端 REPL 交互，支持指令输入和对话。
 * 核心要求此服务必须运行。
 * 默认由 plugin-cli 提供，第三方可提供自己的 CLI 实现。
 */
export interface CLIService {
  /** 获取当前会话 ID */
  getSessionId(): string;
  /** CLI 是否正在运行 */
  isRunning(): boolean;
}
