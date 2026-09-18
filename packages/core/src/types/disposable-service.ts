// ----- 服务自清理协议 -----

/**
 * 服务自清理协议
 *
 * 任何接受插件注册项（tools / commands / pages / strategies 等）的服务，
 * **应当**实现该接口的 `unregisterByPlugin(contextId)`。当某个 Context dispose 时，
 * core 会遍历所有已注册服务并调用该方法，使服务释放属于该 contextId 的所有注册项。
 *
 * core 自身不需要知道每个服务内部的注册结构，只通过这个简单接口与服务沟通。
 *
 * 钥匙是 `ctx.id`（逻辑身份），不是四原语用的清理归属 owner symbol，判据是**登记本在谁手里**：
 * 四原语的登记本在 core 手里，owner 由 core 自己发、自己收，同名 Context 互不误清；枢纽服务的登记本
 * 在服务自己手里，注册那一侧是插件作者亲手写的 `svc.register(x, ctx.id)`，清扫必须用同一把钥匙——
 * owner 是 symbol，插件作者写不出、日志打不出、跨进程传不了。代价如实：同 id 的两个 Context 并存时
 * 在枢纽层会互清。id 唯一由各路径自保：插件实例经 PluginManager 的查重闸，`useModule` 自动加 `~n` 后缀，
 * 手工 `fork(id)` 由调用方自己保证（core 不校验）。
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
