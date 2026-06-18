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
  const reqUnmet = entry.requiredDeps.some(
    d => !rootCtx.hasService(d.service, d.capabilities.length > 0 ? d.capabilities : undefined),
  );
  if (reqUnmet) return 'pending';
  if (reason.type === 'service-down' && entry.module.requiresBounceOnDepChange) {
    const optHit = entry.optionalDeps.find(d => d.service === reason.service);
    if (
      optHit &&
      !rootCtx.hasService(optHit.service, optHit.capabilities.length > 0 ? optHit.capabilities : undefined)
    ) {
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

  for (const dep of entry.requiredDeps) {
    if (!rootCtx.hasService(dep.service, dep.capabilities.length > 0 ? dep.capabilities : undefined)) {
      logger.debug(
        `插件 "${entry.instanceId}" 等待服务: ${dep.service}${dep.capabilities.length ? ` [${dep.capabilities.join(', ')}]` : ''}`,
      );
      return;
    }
  }

  // 先标记为 activating，防止 service:registered 事件导致重入
  entry.state = 'activating';

  const ctx = rootCtx.fork(entry.instanceId);
  entry.context = ctx;

  try {
    await entry.module.apply(ctx, entry.config);

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
    logger.error(`插件 "${entry.instanceId}" 激活失败: ${message}`);
    ctx.dispose();
    entry.context = undefined;
    entry.state = 'error';
    entry.error = message;
    return;
  }

  // 激活成败只由 apply/provides 校验决定。emit 放在 try 块外：旁观插件的
  // 监听器出问题不能把刚激活成功的无辜插件打成 error 终态（归因错位）。
  await rootCtx.emit('plugin:loaded', entry.instanceId);
}
