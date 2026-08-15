// ============================================================
// plugin-activation.ts — 插件激活路径辅助
//
// 从 plugin.ts 拆出的"如何把单个 entry 推进到 active 态"逻辑：
//   - computeTargetState：给定 reason，单个 entry 的目标态是什么
//   - activatePlugin：fork ctx → apply → 校验 provides → 标记 active/error
//
// 这些都需要 PluginManager 的状态（plugins map / rootCtx），
// 但被有意提成 free function：传入 deps 对象，方便单测 mock + 让 PluginManager
// 自身只负责"事件路由 + recompute 编排"。
// ============================================================

import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type { PluginEntry, PluginState, RecomputeReason } from './types/plugin.js';

interface ActivationDeps {
  plugins: Map<string, PluginEntry>;
  rootCtx: Context;
  logger: Logger;
  /** 激活失败回滚 disposeAsync 时单个异步清理项的等待上限（毫秒；缺省不设限） */
  disposeTimeoutMs?: number;
}

/**
 * 拆卸方的唯一形状：先写终态 → 带超时拆 ctx → 清引用 → 发 plugin:unloaded。
 *
 * 这四步的**顺序**是并发正确性的承重墙，此前以约定形式散抄在五个拆卸点，
 * 漏抄或抄错顺序就是覆写竞态（刀 0 的 Phase A 回归即实证）。收编后约定
 * 只剩一条：「拆卸不许手写，调本函数」——由 test/architecture/
 * state-write-sites.test.ts 的写入点定格测试机器守。
 *
 * - 先写终态：拆卸 await 期间并发管理操作的写入必须是后写者（管理意图胜）；
 *   同时给 activatePlugin 的接管检查提供让位信号。
 * - 判据用 entry.context 而非 state：'activating' 的在飞 ctx 同样要拆，
 *   disposeAsync 会先等 apply 落定（Context._activation）。
 * - dispose 统一 try/catch：拆卸抛出不得让 entry.context 悬置（否则
 *   重激活闸永挂、插件静默不可激活）。
 * - 清引用带恒等卫：并发路径若已 join 同一次拆卸并清过引用，不重复置空。
 *
 * 唯一不用本函数的拆卸点是 bouncePlugin：它要在写终态与拆卸之间插入
 * evictDownstreamConsumers（该 await 窗口要求状态已先落），塞进本函数
 * 需要回调钩子——宁可让它保持内联并就地注释，也不给这里加第三个参数。
 */
export async function retireEntry(
  entry: PluginEntry,
  targetState: PluginState,
  deps: Pick<ActivationDeps, 'rootCtx' | 'logger' | 'disposeTimeoutMs'>,
  opts?: { emitUnloaded?: boolean },
): Promise<void> {
  entry.state = targetState;
  const ctx = entry.context;
  if (!ctx) return;
  try {
    await ctx.disposeAsync(deps.disposeTimeoutMs);
  } catch (err) {
    deps.logger.error(`插件 "${entry.instanceId}" dispose 抛错: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (entry.context === ctx) entry.context = undefined;
  if (opts?.emitUnloaded !== false) {
    deps.rootCtx.emit('plugin:unloaded', entry.instanceId).catch(err => {
      deps.logger.warn(`emit plugin:unloaded 失败 (${entry.instanceId}): ${err}`);
    });
  }
}

/**
 * 计算单个 entry 的目标状态。
 *
 * - disabled / disposed / error 是显式态，recompute 不动它们
 * - required 依赖不满足 → pending
 * - service-down 命中 optional 依赖且服务确实没了且声明了
 *   `requiresBounceOnDepChange: true` → pending（级联 bounce）；
 *   默认不级联，期望下游在每次访问时 `ctx.getService(...)` 惰性查询
 * - 其余 active / pending / activating → active
 */
export function computeTargetState(entry: PluginEntry, reason: RecomputeReason, rootCtx: Context): PluginState {
  if (entry.state === 'disabled' || entry.state === 'disposed' || entry.state === 'error') {
    return entry.state;
  }
  if (reason.type === 'shutdown') return 'disposed';
  const reqUnmet = entry.requiredDeps.some(d => rootCtx.getService(d.service) === undefined);
  if (reqUnmet) return 'pending';
  if (reason.type === 'service-down' && entry.module.requiresBounceOnDepChange) {
    const optHit = entry.optionalDeps.find(d => d.service === reason.service);
    if (optHit && rootCtx.getService(optHit.service) === undefined) {
      return 'pending';
    }
  }
  return 'active';
}

/**
 * 尝试激活一个 pending 插件：依赖检查 → fork ctx → apply → provides 校验。
 *
 * 失败时把 entry 转为 error 态（带 message），ctx 已 dispose，外层 recompute 不会重试。
 * 调用方需保证 entry.state === 'pending' 才调用本函数（否则直接 return）。
 */
export async function activatePlugin(entry: PluginEntry, deps: ActivationDeps): Promise<void> {
  const { rootCtx, logger } = deps;
  if (entry.state !== 'pending') return;

  // 旧 ctx 仍在拆卸中（bouncePlugin 先置 'pending'、后异步拆旧 ctx，拆完才清
  // entry.context）：此刻重新激活会让新旧实例同 contextId 并存，旧链排空时的
  // unregisterByContext 会连新实例的注册一并扫掉。跳过本轮，等管理路径收尾
  // 后的 softReload 重新调度。
  if (entry.context) return;

  for (const dep of entry.requiredDeps) {
    if (rootCtx.getService(dep.service) === undefined) {
      logger.debug(`插件 "${entry.instanceId}" 等待服务: ${dep.service}`);
      return;
    }
  }

  // 先标记为 activating，防止 service:registered 事件导致重入
  entry.state = 'activating';

  const ctx = rootCtx.fork(entry.instanceId);
  entry.context = ctx;

  try {
    // 登记后再 await，让拆卸路径能先等 apply 落定（见 Context.trackActivation）
    const applying = Promise.resolve(entry.module.apply(ctx, entry.config));
    ctx.trackActivation(applying);
    await applying;

    // 接管检查（CAS 式）：unload / disablePlugin / bouncePlugin 撞上在飞 apply 时
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
    if (entry.module.provides) {
      const missing = entry.module.provides.filter(
        name => !rootCtx.serviceContainer.hasByContext(name, entry.instanceId),
      );
      if (missing.length > 0) {
        throw new Error(`声明 provides [${missing.join(', ')}] 但未实际注册这些服务`);
      }
    }

    // dev mode：反向一致性检查 —— 实际注册的服务名是否都在 provides 中声明
    // 不在 provides 的服务无法享受拓扑排序，下游可能错过依赖关系
    // 注：是否 dev 由宿主通过 `App({ devMode })` 显式注入，core 不读 process.env
    if (rootCtx.devMode) {
      const declared = new Set(entry.module.provides ?? []);
      const actuallyProvided = rootCtx.serviceContainer
        .getServiceNames()
        .filter(name => rootCtx.serviceContainer.hasByContext(name, entry.instanceId));
      const undeclared = actuallyProvided.filter(name => !declared.has(name));
      if (undeclared.length > 0) {
        logger.warn(
          `插件 "${entry.instanceId}" 注册了服务 [${undeclared.join(', ')}] 但未在 module.provides 中声明 —— ` +
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
      logger.debug(`插件 "${entry.instanceId}" 激活中止且已被管理操作接管（现态 ${entry.state}）: ${message}`);
      return;
    }
    logger.error(`插件 "${entry.instanceId}" 激活失败: ${message}`);
    // retireEntry 先写 'error' 再等清理——并发观察者（getStatus / 早退返回的
    // 调用方）依赖状态机即时转移，异步清理不该拖延 'error' 的可见时点。
    // 不发 unloaded：本插件从未 loaded 过，配对事件无从谈起。
    entry.error = message;
    await retireEntry(entry, 'error', deps, { emitUnloaded: false });
    return;
  }

  // 激活成败只由 apply/provides 校验决定。emit 放在 try 块外：旁观插件的
  // 监听器出问题不能把刚激活成功的无辜插件打成 error 终态（归因错位）。
  await rootCtx.emit('plugin:loaded', entry.instanceId);
}
