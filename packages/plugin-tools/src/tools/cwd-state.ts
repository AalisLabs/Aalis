/**
 * 当前工作目录（cwd）状态 —— 跨工具共享的 per-session 内存。
 *
 * 设计动机：
 * - LLM agent 调 `cwd` / `cd` 都希望像 shell 一样有一个"我在哪"的概念，
 *   并且这个概念被 `file_*` 工具的相对路径解析共享，否则就出现"我 cd 了
 *   但 file_read 还在别处"的认知错位（这是改造前的实际问题）。
 * - 工具注册是进程级单例（ToolService 全局），但同一 Aalis 进程通常
 *   并发服务多个 session（OneBot 群聊、WebUI 多窗口…）。如果用单一变量
 *   保存 cwd，会出现 A 群把 cwd 切到 `tmp:/` 把 B 群也带跑了。所以状态
 *   按 `ToolCallContext.sessionId` 分桶。
 *
 * 生命周期：仅活在内存里，进程重启即回到 `initial`；`cd` 不落盘配置文件，
 * 这是有意为之 —— 配置文件是真理源，agent 不应该绕过审批层悄悄改它。
 */
export class CwdState {
  private readonly initial: string;
  private readonly perSession = new Map<string, string>();

  constructor(initial: string) {
    this.initial = initial || 'workspace:/';
  }

  /** 读取某 session 的当前 cwd；未设置过则回退到初始值。 */
  get(sessionId: string | undefined): string {
    if (!sessionId) return this.initial;
    return this.perSession.get(sessionId) ?? this.initial;
  }

  /**
   * 设置某 session 的当前 cwd。
   *
   * 没有 sessionId 时（理论上 ToolService 总是提供，但保险起见）静默丢弃，
   * 不污染初始值 —— 初始值由配置文件决定，运行时不该改。
   */
  set(sessionId: string | undefined, uri: string): void {
    if (!sessionId) return;
    this.perSession.set(sessionId, uri);
  }

  /** 进程级初始 cwd（用于 cwd 工具回显"会话未切换前是哪里"）。 */
  getInitial(): string {
    return this.initial;
  }
}
