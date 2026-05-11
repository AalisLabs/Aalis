// ----- 服务自清理协议 -----

/**
 * 服务自清理协议
 *
 * 任何接受插件注册项（tools / commands / pages / strategies 等）的服务，
 * **应当**实现该接口的 `unregisterByPlugin(contextId)`。当某个 Context dispose 时，
 * core 会遍历所有已注册服务并调用该方法，使服务释放属于该 contextId 的所有注册项。
 *
 * 该协议是 internal-framework 风格 "context dispose 自动级联清理副作用" 的扩展：
 * core 自身不需要知道每个服务内部的注册结构，只通过这个简单接口与服务沟通。
 *
 * @example
 * class ToolService implements DisposableService {
 *   private byPlugin = new Map<string, Set<string>>();
 *   register(tool: Tool, contextId: string) { ... }
 *   unregisterByPlugin(contextId: string) {
 *     for (const name of this.byPlugin.get(contextId) ?? []) {
 *       this.tools.delete(name);
 *     }
 *     this.byPlugin.delete(contextId);
 *   }
 * }
 */
export interface DisposableService {
  /**
   * 清理由指定 contextId 注册到本服务的所有副作用。
   *
   * 在 Context.dispose() 时由 core 自动调用。
   * 失败应当抛错（core 会记录 warn 日志但不中断 dispose 链）。
   */
  unregisterByPlugin(contextId: string): void;
}
