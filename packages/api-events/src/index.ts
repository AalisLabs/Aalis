// ============================================================
// @aalis/api-events — 事件契约
//
// 事件是「通知多方」：emit 按登记顺序逐个调用监听器并等它落定，单个监听器抛错只影响它自己，emit 始终兑现。
// 发射方等不等 emit 由它自己定。登记序是每条登记自带的序号，提供者按它排：换提供者时各归属表整批重挂，
// 派发次序不变；提供者重启时必选依赖方随之重启、重新登记，排在不重启的登记（可选依赖方与宿主根，带原序号
// 重挂）之后，次序与冷启动可能不同。
// 默认提供者：@aalis/plugin-events。没有提供者时 emit 什么都不做（没有总线就没有可通知的监听器），
// on 的登记留在归属表里，提供者上线后挂上。
//
// 事件名由各契约包与插件经 declaration merging 注入 AalisEvents（未声明的事件名编译报错）：
//   declare module '@aalis/api-events' {
//     interface AalisEvents { 'scheduler:tick': [jobId: string] }
//   }
// 运行时动态生成的事件名在自己的命名空间内合并模板字面量签名。
// ============================================================

import { defineService } from '@aalis/core';

/** 事件扩展点（空接口；由各契约包与插件经 declaration merging 注入「事件名 → 参数元组」） */
export interface AalisEvents {}

/** 事件 E 的参数表。表里没有条目时 `AalisEvents[E]` 推不出数组形状，经它收成参数表 */
export type EventArgs<E extends keyof AalisEvents> = AalisEvents[E] extends infer Args extends unknown[] ? Args : never;

/** 监听器：返回 Promise 时 emit 等它落定再调下一个 */
export type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/**
 * 提供者契约（事件总线本体）。插件不直接调用：登记经 {@link events} 的绑定门面，
 * 它盖上本激活 id、随激活撤回。
 */
export interface EventBus {
  /**
   * 按 order 升序插入该事件的监听器表。order 是门面在登记时分配的登记序（进程内全部 api-events 副本共用一个计数器，单调递增），
   * 换提供者重挂时原样带过来，提供者据它还原原来的交错次序。contextId 供监听器抛错时点名。返回退订（幂等，只撤这一条）
   */
  on(event: string, handler: EventHandler<unknown[]>, contextId: string, order: number): () => void;
  /**
   * 按登记序逐个调用并等待。只送达派发开始时已登记的，途中退订的跳过；单个监听器抛错（同步或异步）只记录，
   * 不中断其余监听器，也不使返回的 Promise 被拒
   */
  emit(event: string, ...args: unknown[]): Promise<void>;
}

/** `events` 的绑定接口 */
export interface Events {
  /** 监听事件；返回退订，随这次激活撤回 */
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<EventArgs<E>>): () => void;
  /** 触发事件：监听器逐个执行完才兑现，始终兑现 */
  emit<E extends string & keyof AalisEvents>(event: E, ...args: EventArgs<E>): Promise<void>;
}

/**
 * 登记序计数器：进程内全部 api-events 副本共用一个（经全局符号表取同一个对象），登记即取号。
 * 契约包可能装了两份，各自从 0 计数的话序号不可比，提供者按序派发就会把后登记的排到前面。
 */
const ORDER = Symbol.for('@aalis/api-events.order');
const shared = globalThis as Record<symbol, { n: number } | undefined>;
shared[ORDER] ??= { n: 0 };
const orderCounter = shared[ORDER];

export const events = defineService<EventBus, Events>('events', port => {
  // 每次登记一个独立条目：同一函数登记两次各算各的，没有「同键替换」。登记序全局唯一，用作归属表的键不会撞；
  // 键带事件名，关闭后登记的告警能点名
  const ledger = port.registrar<{ event: string; handler: EventHandler<unknown[]>; order: number }>({
    key: ({ event, order }) => `${event}#${order}`,
    register: (bus, { event, handler, order }) => bus.on(event, handler, port.id, order),
  });
  return {
    on: (event, handler) => ledger.add({ event, handler: handler as EventHandler<unknown[]>, order: ++orderCounter.n }),
    emit: (event, ...args) => (port.present ? port.provider.emit(event, ...args) : Promise.resolve()),
  };
});
