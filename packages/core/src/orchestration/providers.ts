// ============================================================
// providers.ts — `@aalis/core` 注入点（host providers）
//
// 把"怎么重启"这件 I/O 相关的事抽成接口，由宿主（@aalis/runtime 或外部嵌入者）实现并注入。
// 插件从哪里来、配置存在哪里都不在 core：宿主把定义好的插件连同配置经 `app.plugin` / `app.pluginAll`
// 交进来。core 本身不 import 任何 `node:*` / `yaml`，可在浏览器、单文件二进制、嵌入式集成等场景里运行。
// ============================================================

// ----- 重启策略 -----

/**
 * 重启策略：`App.restart()` 把"如何重启"委托给宿主。
 *
 * - Node 进程宿主：spawn 一个新进程然后退出
 * - 浏览器宿主：`location.reload()`
 * - 嵌入式宿主：可能就是 noop，或者通知外层重新创建 App
 *
 * `restart(opts.stop)` 由 App 传入"先停掉当前实例"的回调；
 * **时序由 strategy 决定**——例如 HTTP 宿主可能想先延迟几百毫秒让响应返回客户端再 stop，
 * CLI/嵌入式宿主可能直接 `await stop()` 后立刻重启，core 不再硬编码时延。
 */
export interface RestartStrategy {
  /**
   * @param opts.stop 优雅停掉当前 App。
   * @param opts.rollback 发起方交给策略的**不透明**回滚凭据：仅当策略判定「新实例未能
   *   接管」时才使用。core 不解释它的形状——回滚内容只有发起方（如市场更新）知道，
   *   触发条件只有策略（父进程）观察得到，core 只做透传。
   */
  restart(opts: { stop: () => Promise<void>; rollback?: unknown }): void | Promise<void>;
}
