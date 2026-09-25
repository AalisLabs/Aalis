// ============================================================
// @aalis/api-hooks — 钩子契约
//
// 每个钩子键代表一个语义清晰的生命周期事件（如 inbound:command / agent:llm:before），
// handler 在事件内部按**登记顺序**串行执行洋葱模型（next 交棒）。不用数字 priority：
// 相位之间的次序由调度方显式表达；相位内部的 handler 应顺序无关，或由相位拥有方约定。
// 登记序是每条登记自带的序号，提供者按它排链：换提供者时各账本整批重挂，链序不变；
// 提供者重启时依赖方随之重启、重新登记，链序即重新激活的次序（与冷启动相同）。
// 默认提供者：@aalis/plugin-hooks。没有提供者时 run 返回被拒的 Promise（不执行默认动作）。
//
// 钩子键由各 -api 包经 declaration merging 注入 HookContextMap：
//   declare module '@aalis/api-hooks' {
//     interface HookContextMap { 'schedule:before': { jobId: string } }
//   }
// ============================================================

import { defineService } from '@aalis/core';

/** 钩子扩展点（空接口；由各 -api 包经 declaration merging 注入「钩子名 → 中间件上下文」） */
export interface HookContextMap {}

/** 中间件 next：把控制交给下一个中间件或默认动作 */
export type MiddlewareNext = () => Promise<void>;

/** 中间件：可改 data（引用传递），调 next() 继续，不调即截停（含默认动作） */
export type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;

/** `run` 的选项 */
export interface RunOptions {
  /** 广播型相位：某 handler 返回却没调 next() 时点名告警（其后的注入会被静默丢弃） */
  warnOnStall?: boolean;
}

/**
 * 提供者契约（钩子登记表本体）。插件不直接调用：登记经 {@link hooks} 的绑定门面，
 * 它盖上本激活 id、随激活撤回。
 */
export interface HookRegistry {
  /**
   * 按 order 升序插入该钩子链。order 是门面在登记时分配的登记序（进程内全部 api-hooks 副本共用一个计数器，单调递增），换提供者重挂时原样带过来，
   * 提供者据它还原原来的交错次序。contextId 供卡链告警点名。返回退订（幂等，只撤这一条）
   */
  register(hook: string, fn: MiddlewareFn<unknown>, contextId: string, order: number): () => void;
  /** 驱动一条钩子链；true = 走到底（含执行了默认动作或本就没有 handler），false = 被截停 */
  run(hook: string, data: unknown, defaultAction?: () => Promise<void>, opts?: RunOptions): Promise<boolean>;
}

/** `hooks` 的绑定接口 */
export interface Hooks {
  /** 注册中间件（洋葱模型，按登记顺序）；返回退订，随这次激活撤回 */
  middleware<K extends string & keyof HookContextMap>(hook: K, fn: MiddlewareFn<HookContextMap[K]>): () => void;
  /** 驱动一条钩子链；返回 false 表示被某个中间件截停 */
  run<K extends string & keyof HookContextMap>(
    hook: K,
    data: HookContextMap[K],
    defaultAction?: () => Promise<void>,
    opts?: RunOptions,
  ): Promise<boolean>;
}

/**
 * 登记序计数器：进程内全部 api-hooks 副本共用一个（经全局符号表取同一个对象），登记即取号。
 * 契约包可能装了两份，各自从 0 计数的话序号不可比，提供者按序排链就会把后登记的排到前面。
 */
const ORDER = Symbol.for('@aalis/api-hooks.order');
const shared = globalThis as Record<symbol, { n: number } | undefined>;
shared[ORDER] ??= { n: 0 };
const orderCounter = shared[ORDER];

export const hooks = defineService<HookRegistry, Hooks>('hooks', port => {
  // 每次登记一个独立账目：同一激活可在同一钩子上挂多个 handler，没有「同键替换」。登记序全局唯一，
  // 用作账本键不会撞；键带钩子名，关闭后登记的告警能点名
  const ledger = port.registrar<{ hook: string; fn: MiddlewareFn<unknown>; order: number }>({
    key: ({ hook, order }) => `${hook}#${order}`,
    register: (registry, { hook, fn, order }) => registry.register(hook, fn, port.id, order),
  });
  return {
    middleware: (hook, fn) => ledger.add({ hook, fn: fn as MiddlewareFn<unknown>, order: ++orderCounter.n }),
    // async：没有提供者时以被拒的 Promise 传出，不在调用点同步抛（与提供者 run 的异步口径一致）
    run: async (hook, data, defaultAction, opts) => port.require().run(hook, data, defaultAction, opts),
  };
});
