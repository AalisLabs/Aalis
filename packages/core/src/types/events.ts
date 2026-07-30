// ============================================================
// 事件扩展点：内置事件表 + declaration merging 靶子。
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
 */
export interface AalisEvents {
  // 业务消息事件（inbound:message / inbound:message:archived / outbound:message / outbound:stream）
  // 已通过 declaration merging 由 @aalis/schema-message 注入（cleanup-8）。
  // 业务工具事件（tool:execute）已通过 declaration merging 由 @aalis/plugin-tools-api 注入（cleanup-8）。
  // gateway:phase:done 由 @aalis/plugin-gateway-api 注入（cleanup-7）。
  'service:registered': [name: string];
  'service:unregistered': [name: string];
  /**
   * 某服务的偏好 provider 发生切换（preferService / unpreferService）。
   * 偏好切换会改变 getService(name) 的胜者但不改变 entry 集合，
   * 因此不能复用 registered/unregistered 语义；whenService 借此事件跟随重挂。
   */
  'service:preference-changed': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  ready: [];
  /** 应用已启动完成，适合 CLI / TUI 等用户交互入口接管终端 */
  'app:started': [];
  restarting: [];
  /** 应用正在启动（start() 开头，在服务检查和消息路由注册之前） */
  'app:starting': [];
  /**
   * 应用正在停止（stop() 开头，在插件拓扑逆序 dispose 之前）。
   *
   * 本事件的定位是**通知**（如 CLI 打印告别语、状态条切换），**不是清理通道**。
   *
   * ⚠． 插件内部清理副作用（关连接、停计时器、flush 缓冲区、落盘等）一律用
   *    `ctx.onDispose(cb)`：它覆盖 bounce / unload / updatePluginConfig 等
   *    全部拆卸路径，且异步清理会被编排层的 disposeAsync 等待完成。
   *    本事件只在 app 全局停机时触发一次，用它做清理会在热重载路径上
   *    造成资源泄漏与数据丢失。
   */
  'app:stopping': [];
}
