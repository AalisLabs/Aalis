// ============================================================
// plugin-activation.ts — 插件激活路径辅助
//
// 从 plugin.ts 拆出的"如何把单个 entry 推进到 active 态"逻辑：
//   - computeTargetState：单个 entry 此刻的目标态
//   - activatePlugin：建激活 → 挂载定义 → 校验 provides → 标记 active/error
//
// 这些都需要 PluginManager 的状态（rootCtx / logger），
// 但被有意提成 free function：传入 deps 对象，方便单测 mock + 让 PluginManager
// 自身只负责"事件路由 + recompute 编排"。
// ============================================================

import type { PluginEntry, PluginState } from '../types/plugin.js';

import { closeActivations } from '../context/close-plan.js';
import type { Context } from '../context/context.js';
import { mountDefinition } from '../context/definition.js';
import type { Logger } from '../context/logger.js';

/** 注册表内部的记录：公开的 {@link PluginEntry} 加上这次激活（不进公开类型） */
export interface PluginRecord extends PluginEntry {
  context?: Context;
}

/**
 * 编排层自由函数的宿主注入件。领域数据（entry、注册表、目标态）按位置传，注入件统一收在这里，
 * 由 PluginManager 构造一次、各函数按需读取。
 */
export interface ActivationDeps {
  rootCtx: Context;
  logger: Logger;
  /** 拆卸时单个异步清理项的等待上限（毫秒；缺省不设限） */
  disposeTimeoutMs?: number;
}

/**
 * 拆卸方的唯一形状：先写终态 → 带超时拆 ctx → 清引用 → 发 plugin:unloaded。
 *
 * 这四步的**顺序**是并发正确性的承重墙：漏一步或抄错顺序就是覆写竞态。约定只有一条：
 * 「拆卸不许手写，调本函数或 {@link retireBatch}」——由 test/architecture/state-write-sites.test.ts
 * 的写入点定格测试机器守。
 *
 * - 先写终态：拆卸 await 期间并发管理操作的写入必须是后写者（管理意图胜）；
 *   同时给 activatePlugin 的接管检查提供让位信号。
 * - 判据用 entry.context 而非 state：'activating' 的在飞 ctx 同样要拆，
 *   disposeAsync 会先等 apply 落定（Context._activation）。
 * - dispose 统一 try/catch：拆卸抛出不得让 entry.context 悬置（否则
 *   重激活闸永挂、插件静默不可激活）。
 * - 清引用带恒等卫：并发路径若已 join 同一次拆卸并清过引用，不重复置空。
 */
export async function retireEntry(
  entry: PluginRecord,
  targetState: PluginState,
  deps: ActivationDeps,
  opts?: { emitUnloaded?: boolean },
): Promise<void> {
  entry.state = targetState;
  const ctx = entry.context;
  if (!ctx) return;
  try {
    await ctx.disposeAsync(deps.disposeTimeoutMs);
  } catch (err) {
    deps.logger.error(`插件 "${entry.instanceId}" dispose 抛错:`, err);
  }
  if (entry.context === ctx) entry.context = undefined;
  if (opts?.emitUnloaded !== false) {
    deps.rootCtx.emitQuietly('plugin:unloaded', entry.instanceId);
  }
}

/**
 * 成批拆卸：与 {@link retireEntry} 同一四步，只是「拆 ctx」对整批激活（连同各自的子模块）统一编排——
 * 消费者先于它依赖的提供者关闭，归属树与服务依赖一起决定顺序（见 close-plan.ts）。同一轮里要停的
 * 插件必须走这里而不是逐个 retireEntry，否则它们之间的关闭次序只剩注册序。
 * entries 的给定次序是无依赖关系时的关闭次序。
 *
 * @param planRoot 停机时传根激活：宿主的根绑定（app.bind）与全部插件进同一张计划，
 *   宿主的收尾因此排在它用到的插件关闭之前。
 * @param settle 已冻的计划（`App.stop` 在 `app:stopping` 之前 freeze）；缺省由 closeActivations 现冻。
 */
export async function retireBatch(
  entries: PluginRecord[],
  targetState: 'pending' | 'disposed',
  deps: ActivationDeps,
  opts?: { emitUnloaded?: boolean; planRoot?: Context; settle?: Map<Context, () => void> },
): Promise<void> {
  const closing: Array<{ entry: PluginRecord; ctx: Context }> = [];
  for (const entry of entries) {
    entry.state = targetState;
    if (entry.context) closing.push({ entry, ctx: entry.context });
  }
  try {
    const roots = opts?.planRoot ? [opts.planRoot] : closing.map(item => item.ctx);
    await closeActivations(roots, deps.disposeTimeoutMs, deps.logger, opts?.settle);
  } catch (err) {
    deps.logger.error('成批拆卸抛错:', err);
  }
  for (const { entry, ctx } of closing) {
    if (entry.context === ctx) entry.context = undefined;
    if (opts?.emitUnloaded !== false) deps.rootCtx.emitQuietly('plugin:unloaded', entry.instanceId);
  }
}

/**
 * 计算单个 entry 此刻的目标状态（停机不经这里：那是整批单向关闭）。
 *
 * - disabled / disposed / error 是显式态，recompute 不动它们
 * - required 依赖不满足 → pending
 * - 其余 → active。optional 依赖的上下线不改变目标态：绑定接口每次查询解析当前值，
 *   有状态的接线经 follow 跟随提供者换人，不靠重启插件
 */
export function computeTargetState(entry: PluginRecord, rootCtx: Context): PluginState {
  if (entry.state === 'disabled' || entry.state === 'disposed' || entry.state === 'error') {
    return entry.state;
  }
  return entry.required.some(name => rootCtx.getService(name) === undefined) ? 'pending' : 'active';
}

/**
 * 尝试激活一个 pending 插件：依赖检查 → 建激活 → 挂载定义 → provides 校验。
 *
 * 失败时把 entry 转为 error 态（带 message），ctx 已 dispose，外层 recompute 不会重试。
 * 调用方需保证 entry.state === 'pending' 才调用本函数（否则直接 return）。
 */
export async function activatePlugin(entry: PluginRecord, deps: ActivationDeps): Promise<void> {
  const { rootCtx, logger } = deps;
  if (entry.state !== 'pending') return;

  // 旧 ctx 仍在拆卸中（bounce 先置 'pending'、后异步拆旧 ctx，拆完才清
  // entry.context）：此刻重新激活会让新旧实例同 instanceId 并存——同名服务重复
  // provide、偏好按 contextId 二义。跳过本轮，等管理路径收尾后的 softReload 重新调度。
  if (entry.context) return;

  for (const name of entry.required) {
    if (rootCtx.getService(name) === undefined) {
      logger.debug(`插件 "${entry.instanceId}" 等待服务: ${name}`);
      return;
    }
  }

  // 先标记为 activating，防止 service:registered 事件导致重入
  entry.state = 'activating';

  const ctx = rootCtx.fork(entry.instanceId);
  entry.context = ctx;

  try {
    // 登记后再 await，让拆卸路径能先等 apply 落定（见 Context.trackActivation）
    const applying = Promise.resolve(mountDefinition(ctx, entry.definition, entry.config));
    ctx.trackActivation(applying);
    await applying;

    // 接管检查（CAS 式）：unload / disable / bounce 撞上在飞 apply 时
    // 会先把 state 改离 'activating' 再 disposeAsync（等的正是上面这个 applying）。
    // 此处一旦观察到 state 被改走，说明终态与 ctx 的拆卸责任已归管理路径所有，
    // 本次激活的收尾（置 active / 报 error / 发 plugin:loaded）全部让位。
    // 检查与下方各写入之间无 await，不存在二次窗口。
    if (entry.state !== 'activating') {
      logger.debug(`插件 "${entry.instanceId}" 激活期间被管理操作接管（现态 ${entry.state}），本次激活让位`);
      return;
    }

    // 激活期间 ctx 被拆卸（宿主直调 disposeAsync 撞上在飞 apply，state 未被改走）：
    // provide 已被 post-dispose 守卫吞掉，provides 校验必然失败——但那是框架层
    // 竞态，不是作者的声明错误，必须如实归因，不能报「声明了但未注册」的假罪名。
    if (ctx.disposed) {
      throw new Error('激活期间 Context 已被拆卸，插件未完成注册');
    }
    const provides = entry.definition.provides?.map(descriptor => descriptor.name) ?? [];
    const missing = provides.filter(name => !rootCtx.serviceContainer.hasByContext(name, entry.instanceId));
    if (missing.length > 0) {
      throw new Error(`声明 provides [${missing.join(', ')}] 但未实际注册这些服务`);
    }

    // dev mode：反向一致性检查 —— 实际注册的服务名是否都在 provides 中声明
    // 不在 provides 的服务无法享受拓扑排序，下游可能错过依赖关系
    // 注：是否 dev 由宿主通过 `App({ devMode })` 显式注入，core 不读 process.env
    if (rootCtx.devMode) {
      const declared = new Set(provides);
      const actuallyProvided = rootCtx.serviceContainer
        .getServiceNames()
        .filter(name => rootCtx.serviceContainer.hasByContext(name, entry.instanceId));
      const undeclared = actuallyProvided.filter(name => !declared.has(name));
      if (undeclared.length > 0) {
        logger.warn(
          `插件 "${entry.instanceId}" 注册了服务 [${undeclared.join(', ')}] 但未在 provides 中声明 —— ` +
            `下游依赖排序将无法找到该 provider（仅靠 reactive 兜底），建议补全 provides 列表`,
        );
      }
    }

    entry.state = 'active';
    entry.error = undefined;
    logger.info(`插件已激活: ${entry.instanceId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 接管让位同上：管理路径已持有终态与 ctx 的拆卸责任，此处再写 error /
    // 二次 dispose 会踩掉 disposed / disabled / pending 终态。
    if (entry.state !== 'activating') {
      logger.debug(`插件 "${entry.instanceId}" 激活中止且已被管理操作接管（现态 ${entry.state}）:`, err);
      return;
    }
    logger.error(`插件 "${entry.instanceId}" 激活失败:`, err);
    // retireEntry 先写 'error' 再等清理——并发观察者（getStatus / 早退返回的
    // 调用方）依赖状态机即时转移，异步清理不该拖延 'error' 的可见时点。
    // 不发 unloaded：本插件从未 loaded 过，配对事件无从谈起。
    entry.error = message;
    await retireEntry(entry, 'error', deps, { emitUnloaded: false });
    return;
  }

  // 激活成败只由 apply/provides 校验决定，旁观者的监听器不参与归因。不等监听器：本函数在
  // recompute flight 内逐个 entry 调用，等会让一个旁观者的慢 handler 挡住下一个插件的激活，
  // 监听器里 `await plugins.idle()` 更是互等死锁（idle 等 flight 排干，flight 等它返回）。
  rootCtx.emitQuietly('plugin:loaded', entry.instanceId);
}
