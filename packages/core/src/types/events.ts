// ============================================================
// events.ts — 事件扩展点：内置事件表 + declaration merging 靶子。
// 与 hooks / services / contributions 的扩展点文件同构——一原语一文件。
// ============================================================

/**
 * 内置事件表
 *
 * 第三方插件可通过 TypeScript declaration merging 扩展：
 * ```ts
 * declare module '@aalis/core' {
 *   interface AalisEvents {
 *     'scheduler:tick': [jobId: string];
 *   }
 * }
 * ```
 *
 * core 自持的条目按「发射方等不等监听器」分两节，这是契约，节由前缀判定：
 * - **屏障**（`app:*`）：emit 是 `App` 生命周期方法里的一步，监听器全部返回后才推进下一步，
 *   监听器可以据此在「X 之前 / 之后」插入工作。
 * - **通知**（`service:*` / `plugin:*` / `plugins:changed`）：发射方经 `Context.emitQuietly` 发出，**不等**
 *   监听器。发射点要么是同步的注册 / 拆卸收尾（`provide`、退订、teardown），要么在 `PluginManager` 的
 *   recompute flight 或挂起段内——那里等监听器会与 `plugins.idle()` 互等死锁。监听器因此不能假设
 *   「我返回了状态机才继续」，要看尘埃落定后的状态请 `await plugins.idle()`。
 * 两节的调用形式由 `test/core/architecture.test.ts` 按语法树守；第三方增广的事件由其发射方自定。
 */
export interface AalisEvents {
  // 业务消息事件（inbound:message / inbound:message:archived / outbound:message / outbound:stream）
  // 已通过 declaration merging 由 @aalis/schema-message 注入（cleanup-8）。
  // 业务工具事件（tool:execute）已通过 declaration merging 由 @aalis/api-tools 注入（cleanup-8）。
  // gateway:phase:done 由 @aalis/api-gateway 注入（cleanup-7）。
  /** 通知：某服务多了一个提供者（`ctx.provide`） */
  'service:registered': [name: string];
  /** 通知：某服务少了一个提供者（退订闭包或 Context 拆卸） */
  'service:unregistered': [name: string];
  /**
   * 通知：某服务的偏好 provider 发生切换（preferService / unpreferService）。
   * 偏好切换会改变 getService(name) 的胜者但不改变 entry 集合，
   * 因此不能复用 registered/unregistered 语义；whenService 借此事件跟随重挂。
   */
  'service:preference-changed': [name: string];
  /** 通知：插件已激活。同一轮 recompute 可能紧接着激活下一个插件，不等本事件的监听器 */
  'plugin:loaded': [instanceId: string];
  /** 通知：插件已拆卸。激活失败的回滚（从未 loaded）与关机拆卸（`stop()` 自有事件）不发 */
  'plugin:unloaded': [instanceId: string];
  /** 通知：一轮 recompute 收敛，插件状态集合可能已变；关机轮不发 */
  'plugins:changed': [];
  /** 屏障：`start()` 的第一步，早于 `app:ready` */
  'app:starting': [];
  /**
   * 屏障：应用启动的第一相位，插件在此建立「启动后才成立」的东西。
   *
   * 与 `app:started` 是两个相位，不是同一里程碑的两个名字：`start()` 串行 await 两次 emit，
   * 全部 `app:ready` 监听器完成之后才发 `app:started`。要在别人都就绪之后才动手（如 CLI 接管终端），
   * 挂 `app:started`。两者都是 sticky：晚注册的监听器（如 bounce 出来的新实例）会在下一个微任务被补发一次。
   */
  'app:ready': [];
  /** 屏障：应用启动的第二相位，全部 `app:ready` 监听器已完成，适合 CLI / TUI 等用户交互入口接管终端 */
  'app:started': [];
  /** 屏障：`App.restart()` 先发本事件，监听器全部完成后才把控制交给宿主注入的 `RestartStrategy` */
  'app:restarting': [];
  /**
   * 屏障：`stop()` 开头，在插件拓扑逆序 dispose 之前。
   *
   * 本事件用于**知会**（如 CLI 打印告别语、状态条切换），**不是清理通道**。
   *
   * ⚠． 插件内部清理副作用（关连接、停计时器、flush 缓冲区、落盘等）一律用
   *    `ctx.onDispose(cb)`：它覆盖 bounce / unload / updateConfig 等
   *    全部拆卸路径，且异步清理会被编排层的 disposeAsync 等待完成。
   *    本事件只在 app 全局停机时触发一次，用它做清理会在热重载路径上
   *    造成资源泄漏与数据丢失。
   */
  'app:stopping': [];
}
