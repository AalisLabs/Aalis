// ============================================================
// close-plan.ts — 关停编排
//
// 两种关系共同决定关闭顺序，谁也替代不了谁：
//   - 归属树：根激活是全部插件激活的父（子的撤回必先于父的撤回）；
//   - 服务依赖：消费者关闭时还要用到提供者。
// 每个激活的关闭拆成两个阶段：收尾（onDrain，此刻登记与依赖都在）与撤回加清理。数据交接放在收尾段。
// 承诺按依赖的形状分三种，不是一条无条件规则：
//   1. 普通依赖（别的插件）：消费者整个关完，提供者才开始收尾（close → providerDrain）。
//   2. 根用插件提供的服务（宿主经 App.bind 绑定）：根的收尾先于插件的撤回（drain → childClose）；到根的
//      撤回与清理时插件已按归属关闭。根 drain 时全部插件仍活着。
//   3. 插件用根登记的服务：不往排序图加边。归属树已保证插件的撤回先于根的撤回，收尾在撤回之前，
//      故插件 drain 时根仍活着。根若同时用这个插件的服务（第 2 种），第 2 种边把根 drain 插在插件 close
//      之前，两笔收尾都能 require 到对方。两边都收成 drain→drain 会让同一对成二元环，Kahn 让步后
//      根 drain 时插件已死，所以不这样收。
// 依赖交接放 onDrain；onDispose 阶段依赖可能已不可用。
// 资源内核只提供「分阶段关闭」，不认识服务；依赖政策全在这里。
//
// 依赖成环时：optional 边构成的强连通分量（≥2 个激活）先让成员全部 drain，再任一 close——
// drain 期间对方仍活着，双方 onDrain 都能 require。不告警（互为 optional 是常态）。
// 环里只剩 required 边仍无解才告警并强行放行。归属约束与环外的约束一条不松。
//
// 边只来自框架自己管理的关系：每个激活声明的依赖（含尚未访问的 optional）在编排
// 那一刻解析到的胜者，以及存活的托管绑定与尚未落地的撤回。不追踪调用方缓存的裸引用，
// 经 services 动态查到的服务不产生边。
// ============================================================

import { reportQuietly } from '../kernel/disposable-chain.js';

import type { Activation } from './activation.js';
import type { Logger } from '../infrastructure/logger.js';

type Kind = 'drain' | 'close';
interface Stage {
  ctx: Activation;
  kind: Kind;
  /** 无约束时的自然次序：子先于父、同层后挂的先关、同一激活先收尾后关闭 */
  index: number;
  /** 必须先于本阶段的阶段 → 该约束是否为硬约束（归属、required 依赖；optional 依赖为软） */
  after: Map<Stage, boolean>;
  before: Set<Stage>;
}

function link(earlier: Stage, later: Stage, hard: boolean): void {
  if (earlier === later) return;
  earlier.before.add(later);
  later.after.set(earlier, hard || later.after.get(earlier) === true);
}

/**
 * 截止点：本轮涉及的激活停止新增绑定、登记「正由本计划关闭」。
 * 真正的 drain/close 仍由 {@link closeActivations} 执行。已在别的计划里的节点跳过。
 */
export function freezeActivations(roots: Activation[]): Map<Activation, () => void> {
  const settle = new Map<Activation, () => void>();
  const freeze = (ctx: Activation): void => {
    if (settle.has(ctx)) return;
    const done = ctx.joinPlan();
    if (!done) return; // 已在别的计划里：由那边负责关它
    settle.set(ctx, done);
    for (const child of ctx.closeInfo().children) freeze(child);
  };
  for (const root of roots) freeze(root);
  return settle;
}

/**
 * 关闭一组激活（连同它们的子树）。roots 的给定次序就是无依赖关系时的关闭次序。
 * 逐阶段串行等待；没有待等的阶段不让出——单个叶子激活的撤回与调用同栈发起，没有待等的下游交接时首个清理回调也同栈。
 *
 * `settle` 传入时复用已冻的计划（停机：先冻再发 `app:stopping`，监听器里的 dispose 汇入同一张图）。
 */
export async function closeActivations(
  roots: Activation[],
  timeoutMs: number | undefined,
  logger: Logger,
  settle?: Map<Activation, () => void>,
): Promise<void> {
  const owned = settle ?? freezeActivations(roots);
  const mine = roots.filter(root => owned.has(root));
  try {
    for (const stage of planClose(mine, logger)) {
      // 单阶段失败不拖垮同批：与清理链「单项失败继续后续」同一政策
      try {
        const pending =
          stage.kind === 'drain' ? stage.ctx.resources.drain(timeoutMs) : stage.ctx.resources.disposeAsync(timeoutMs);
        if (pending) await pending;
      } catch (err) {
        reportQuietly(() =>
          logger.error(`关停 "${stage.ctx.id}" 的${stage.kind === 'drain' ? '收尾' : '关闭'}阶段抛错:`, err),
        );
      }
      if (stage.kind === 'close') owned.get(stage.ctx)?.();
    }
  } finally {
    for (const done of owned.values()) done();
  }
  // 根里有已被别的计划接管的：等它们各自关完，调用方拿到的仍是「全部已关闭」
  await Promise.all(roots.filter(root => !owned.has(root)).map(root => root.disposeAsync(timeoutMs)));
}

function planClose(roots: Activation[], logger: Logger): Stage[] {
  const drainOf = new Map<Activation, Stage>();
  const closeOf = new Map<Activation, Stage>();
  const parentOf = new Map<Activation, Activation>();
  const providersOf = new Map<Activation, Map<Activation, boolean>>();
  const stages: Stage[] = [];

  const visit = (ctx: Activation): void => {
    if (drainOf.has(ctx)) return;
    const info = ctx.closeInfo();
    providersOf.set(ctx, info.providers);
    // 先占位再下探子树：自然次序是「子全部在前」，但占位保证成环的树形输入也能终止
    const drain: Stage = { ctx, kind: 'drain', index: -1, after: new Map(), before: new Set() };
    const close: Stage = { ctx, kind: 'close', index: -1, after: new Map(), before: new Set() };
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

  const isAncestor = (ancestor: Activation, ctx: Activation): boolean => {
    for (let at = parentOf.get(ctx); at; at = parentOf.get(at)) if (at === ancestor) return true;
    return false;
  };

  for (const [ctx, drain] of drainOf) {
    const close = closeOf.get(ctx)!;
    link(drain, close, true);
    const parent = parentOf.get(ctx);
    // 归属：子的撤回先于父的撤回
    if (parent) link(close, closeOf.get(parent)!, true);
    for (const [provider, required] of providersOf.get(ctx)!) {
      const providerDrain = drainOf.get(provider);
      if (!providerDrain) continue; // 提供者不在本次关闭范围内：它活得更久，无需约束
      if (isAncestor(ctx, provider)) {
        // 用的是自己子树里的服务：父 drain 先于子 close，父收尾时子树仍活着
        link(drain, closeOf.get(provider)!, required);
      } else if (!isAncestor(provider, ctx)) {
        // 普通依赖：消费者整个关完，提供者才开始收尾。祖先边不加——归属树已保证。
        link(close, providerDrain, required);
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
    // 按自然次序排：点名的顺序就是环内实际的关闭次序，与图的遍历次序无关
    const cycle = sourceCycle(remaining).sort((x, y) => x.index - y.index);
    const names = [...new Set(cycle.map(stage => stage.ctx.id))].join(', ');
    // 源分量之外没有未放行的前驱，故只被软约束挡着的阶段放行后不违反任何硬约束
    const yielding = cycle.filter(stage => ![...stage.after].some(([prev, hard]) => hard && remaining.has(prev)));
    if (yielding.length > 0) {
      const drainYielding = yielding.filter(stage => stage.kind === 'drain');
      if (drainYielding.length > 0) {
        reportQuietly(() => logger.debug(`关停顺序：optional 依赖成环 [${names}]，环内成员先全部收尾再撤回`));
        for (const stage of drainYielding) {
          if (!remaining.has(stage)) continue;
          blockers.set(stage, 0);
          release(stage);
        }
        continue;
      }
      reportQuietly(() => logger.debug(`关停顺序：optional 依赖成环 [${names}]，环内按自然次序让步`));
      const forced = yielding[0];
      blockers.set(forced, 0);
      release(forced);
      continue;
    }
    reportQuietly(() =>
      logger.warn(`关停顺序：required 依赖成环 [${names}]，环内无法保证都先于各自的提供者，其余顺序不受影响`),
    );
    const forced = cycle[0];
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
    component.some(stage => [...stage.after.keys()].some(prev => remaining.has(prev) && componentOf.get(prev) !== id));
  const source = components.findIndex((component, id) => component.length > 1 && !hasOutsideBlocker(component, id));
  // 卡住时必有一个不被外部阻塞的多节点分量；找不到就退回第一个多节点分量（防御）
  return components[source >= 0 ? source : components.findIndex(c => c.length > 1)] ?? [...remaining];
}
