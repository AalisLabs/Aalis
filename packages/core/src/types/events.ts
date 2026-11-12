// ============================================================
// events.ts — 事件扩展点：业务事件的 declaration merging 靶子。
// 服务类型由各自的描述符承载。
// ============================================================

/**
 * 事件表：业务事件的 declaration merging 靶子，core 自己不发任何事件。
 *
 * 契约包与插件经 TypeScript declaration merging 声明自己的事件（未声明的事件名编译报错）：
 * ```ts
 * declare module '@aalis/core' {
 *   interface AalisEvents {
 *     'scheduler:tick': [jobId: string];
 *   }
 * }
 * ```
 * 消息事件在 @aalis/schema-message，工具事件在 @aalis/api-tools，网关相位事件在 @aalis/api-gateway。发射方等不等监听器由它自己定。
 *
 * 生命周期与变化通知不在这里：启动就绪是 `lifecycle.onReady`，停机看 `lifecycle.stopping`，某个服务的提供者变了是
 * 选择层的 `watch`，插件状态变了是 `plugins.watch`。
 */
export interface AalisEvents {}

/** 事件 E 的参数表。表里没有条目时 `AalisEvents[E]` 推不出数组形状，经它收成参数表 */
export type EventArgs<E extends keyof AalisEvents> = AalisEvents[E] extends infer Args extends unknown[] ? Args : never;
