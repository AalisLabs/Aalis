// ============================================================
// close-plan.ts — 关停编排
//
// 两种关系共同决定关闭顺序，谁也替代不了谁：
//   - 归属树：父激活负责清理子激活（子的撤回必先于父的撤回）；
//   - 服务依赖：消费者关闭时还要用到提供者。
// 每个激活的关闭拆成两个阶段：收尾（onDrain，此刻登记与依赖都在）与撤回加清理。数据交接放在收尾段。
// 承诺按依赖的形状分三种，不是一条无条件规则：
//   1. 普通依赖（别的插件、兄弟模块）：消费者整个关完，提供者才开始收尾。
//   2. 用的是自己子树里的服务：自己的收尾先于它的收尾；到自己的撤回与清理时它已按归属关闭。
//   3. 用的是祖先提供的服务：自己的收尾先于祖先的收尾；没有别的约束时自己整个关完祖先才收尾，
//      但祖先若同时依赖这棵子树里的服务（第 2 种），只保住收尾次序——自己清理段里再交给祖先的数据
//      可能已错过祖先的收尾。2 与 3 叠加时硬要「整个关完」会与归属自相矛盾，那不是业务依赖成环。
// 资源内核只提供「分阶段关闭」，不认识服务；依赖政策全在这里。
//
// 边只来自框架自己管理的关系：每个激活声明的依赖（含子模块的、含尚未访问的 optional）在编排
// 那一刻解析到的胜者，以及存活的托管绑定与尚未落地的撤回。不追踪调用方缓存的裸引用，
// 经 services 动态查到的服务不产生边。
// ============================================================

import { reportQuietly } from '../kernel/disposable-chain.js';

import type { Context } from './context.js';
import type { Logger } from './logger.js';

type Kind = 'drain' | 'close';
interface Stage {
  ctx: Context;
  kind: Kind;
  /** 无约束时的自然次序：子先于父、同层后挂的先关、同一激活先收尾后关闭 */
  index: number;
  after: Set<Stage>;
  before: Set<Stage>;
}

function link(earlier: Stage, later: Stage): void {
  if (earlier === later) return;
  earlier.before.add(later);
  later.after.add(earlier);
}

/**
 * 关闭一组激活（连同它们的子树）。roots 的给定次序就是无依赖关系时的关闭次序。
 * 逐阶段串行等待；没有待等的阶段不让出——单个叶子激活的首个清理回调与调用同栈发起。
 */
export async function closeActivations(roots: Context[], timeoutMs: number | undefined, logger: Logger): Promise<void> {
  // 截止点：本轮涉及的激活先全部停止新增绑定、并登记「正由本计划关闭」，再读依赖关系建计划。
  // 登记之后别的关闭入口（并发的 unload、子模块句柄）对其中任一激活的 disposeAsync 都汇入本计划，
  // 不会绕开排序另起一路；每个激活各有自己的完成信号，等的是它自己关完，不是整批。
  const settle = new Map<Context, () => void>();
  const freeze = (ctx: Context): void => {
    if (settle.has(ctx)) return;
    const done = ctx.joinPlan();
    if (!done) return; // 已在别的计划里：由那边负责关它
    settle.set(ctx, done);
    for (const child of ctx.closeInfo().children) freeze(child);
  };
  for (const root of roots) freeze(root);
  const mine = roots.filter(root => settle.has(root));
  try {
    for (const stage of planClose(mine, logger)) {
      // 单阶段失败不拖垮同批：与清理链「单项失败继续后续」同一政策
      try {
        const pending = stage.kind === 'drain' ? stage.ctx.drainStage(timeoutMs) : stage.ctx.closeStage(timeoutMs);
        if (pending) await pending;
      } catch (err) {
        reportQuietly(() =>
          logger.error(`关停 "${stage.ctx.id}" 的${stage.kind === 'drain' ? '收尾' : '关闭'}阶段抛错:`, err),
        );
      }
      if (stage.kind === 'close') settle.get(stage.ctx)?.();
    }
  } finally {
    for (const done of settle.values()) done();
  }
  // 根里有已被别的计划接管的：等它们各自关完，调用方拿到的仍是「全部已关闭」
  await Promise.all(roots.filter(root => !settle.has(root)).map(root => root.disposeAsync(timeoutMs)));
}

function planClose(roots: Context[], logger: Logger): Stage[] {
  const drainOf = new Map<Context, Stage>();
  const closeOf = new Map<Context, Stage>();
  const parentOf = new Map<Context, Context>();
  const providersOf = new Map<Context, Context[]>();
  const stages: Stage[] = [];

  const visit = (ctx: Context): void => {
    if (drainOf.has(ctx)) return;
    const info = ctx.closeInfo();
    providersOf.set(ctx, info.providers);
    // 先占位再下探子树：自然次序是「子全部在前」，但占位保证成环的树形输入也能终止
    const drain: Stage = { ctx, kind: 'drain', index: -1, after: new Set(), before: new Set() };
    const close: Stage = { ctx, kind: 'close', index: -1, after: new Set(), before: new Set() };
    drainOf.set(ctx, drain);
    closeOf.set(ctx, close);
    // 同层无依赖关系时后挂的先关（与清理链的逆序同一惯例；后挂的常隐含依赖先挂的）
    for (const child of [...info.children].reverse()) {
      parentOf.set(child, ctx);
      visit(child);
    }
    drain.index = stages.push(drain) - 1;
    close.index = stages.push(close) - 1;
  };
  for (const root of roots) visit(root);

  const isAncestor = (ancestor: Context, ctx: Context): boolean => {
    for (let at = parentOf.get(ctx); at; at = parentOf.get(at)) if (at === ancestor) return true;
    return false;
  };

  for (const [ctx, drain] of drainOf) {
    const close = closeOf.get(ctx)!;
    link(drain, close);
    const parent = parentOf.get(ctx);
    // 归属：子的撤回先于父的撤回
    if (parent) link(close, closeOf.get(parent)!);
    for (const provider of providersOf.get(ctx)!) {
      const providerDrain = drainOf.get(provider);
      if (!providerDrain) continue; // 提供者不在本次关闭范围内：它活得更久，无需约束
      if (isAncestor(ctx, provider) || isAncestor(provider, ctx)) {
        // 用的是自己子树里的、或祖先提供的服务：只约束收尾次序（自己先于提供者）。
        // 祖先那一种在没有别的约束时，自然次序本就让自己整个关完祖先才收尾
        link(drain, providerDrain);
      } else {
        // 普通依赖：消费者整个关完，提供者才开始收尾
        link(close, providerDrain);
      }
    }
  }

  // Kahn：就绪阶段里取自然次序最小的。卡住即有环——只放开环内的一个阶段，环外的约束一条不松
  const order: Stage[] = [];
  const blockers = new Map(stages.map(stage => [stage, stage.after.size]));
  const remaining = new Set(stages);
  const release = (stage: Stage): void => {
    remaining.delete(stage);
    order.push(stage);
    for (const next of stage.before) {
      if (remaining.has(next)) blockers.set(next, blockers.get(next)! - 1);
    }
  };
  while (remaining.size > 0) {
    let ready: Stage | undefined;
    for (const stage of remaining) {
      if (blockers.get(stage) === 0 && (!ready || stage.index < ready.index)) ready = stage;
    }
    if (ready) {
      release(ready);
      continue;
    }
    const cycle = sourceCycle(remaining);
    const names = [...new Set(cycle.map(stage => stage.ctx.id))];
    reportQuietly(() =>
      logger.warn(`关停顺序：依赖成环 [${names.join(', ')}]，环内无法保证都先于各自的提供者，其余顺序不受影响`),
    );
    const forced = cycle.reduce((a, b) => (a.index < b.index ? a : b));
    blockers.set(forced, 0);
    release(forced);
  }
  return order;
}

/**
 * 在剩余阶段里找一个「源」强连通分量（没有来自其它剩余分量的入边）——卡住时它必然是个环。
 * Tarjan；图很小（激活数 ×2），递归深度同量级。
 */
function sourceCycle(remaining: Set<Stage>): Stage[] {
  const indexOf = new Map<Stage, number>();
  const low = new Map<Stage, number>();
  const onStack = new Set<Stage>();
  const stack: Stage[] = [];
  const componentOf = new Map<Stage, number>();
  const components: Stage[][] = [];
  let counter = 0;

  const connect = (stage: Stage): void => {
    indexOf.set(stage, counter);
    low.set(stage, counter);
    counter++;
    stack.push(stage);
    onStack.add(stage);
    for (const next of stage.before) {
      if (!remaining.has(next)) continue;
      if (!indexOf.has(next)) {
        connect(next);
        low.set(stage, Math.min(low.get(stage)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(stage, Math.min(low.get(stage)!, indexOf.get(next)!));
      }
    }
    if (low.get(stage) === indexOf.get(stage)) {
      const component: Stage[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        componentOf.set(member, components.length);
        component.push(member);
        if (member === stage) break;
      }
      components.push(component);
    }
  };
  for (const stage of remaining) if (!indexOf.has(stage)) connect(stage);

  const hasOutsideBlocker = (component: Stage[], id: number): boolean =>
    component.some(stage => [...stage.after].some(prev => remaining.has(prev) && componentOf.get(prev) !== id));
  const source = components.findIndex((component, id) => component.length > 1 && !hasOutsideBlocker(component, id));
  // 卡住时必有一个不被外部阻塞的多节点分量；找不到就退回第一个多节点分量（防御）
  return components[source >= 0 ? source : components.findIndex(c => c.length > 1)] ?? [...remaining];
}
