// ============================================================
// plugin-activation.ts — 插件激活路径辅助
//
// 从 plugin.ts 拆出的"如何把单个 entry 推进到 active 态"逻辑：
//   - computeTargetState：单个 entry 此刻的目标态
//   - activatePlugin：建激活 → 挂载定义 → 校验 provides → 标记 active/error
//
// 这些都需要 PluginManager 的状态（host / logger），
// 但被有意提成 free function：传入 deps 对象，方便单测 mock + 让 PluginManager
// 自身只负责"事件路由 + recompute 编排"。
// ============================================================

import type { PluginEntry, PluginState } from '../types/plugin.js';

import type { ServiceContainer } from '../primitives/services.js';

import type { Activation } from './activation.js';
import type { ActivationHost } from './activation-host.js';
import { closeActivations } from './close-plan.js';
import { isRequiredServiceUnavailable } from '../composition/binding.js';
import type { Logger } from '../infrastructure/logger.js';

/** 注册表内部的记录：公开的 {@link PluginEntry} 加上这次激活（不进公开类型） */
export interface PluginRecord extends PluginEntry {
  activation?: Activation;
}

/**
 * 编排层自由函数的宿主注入件。领域数据（entry、注册表、目标态）按位置传，注入件统一收在这里，
 * 由 PluginManager 构造一次、各函数按需读取。
 */
export interface ActivationDeps {
  host: ActivationHost;
  logger: Logger;
  /** 拆卸时单个异步清理项的等待上限（毫秒；缺省不设限） */
  disposeTimeoutMs?: number;
}

/**
 * 拆卸方的唯一形状：先写终态 → 带超时拆激活 → 清引用 → 发 plugin:unloaded。单条也走这里。
 *
 * 这四步的**顺序**是并发正确性的承重墙：漏一步或抄错顺序就是覆写竞态。约定只有一条：
 * 「拆卸不许手写，调本函数」——由 test/architecture/state-write-sites.test.ts 的写入点定格测试机器守。
 *
 * - 先写终态：拆卸 await 期间并发管理操作的写入必须是后写者（管理意图胜）；
 *   同时给 activatePlugin 的接管检查提供让位信号。
 * - 判据用 entry.activation 而非 state：'activating' 的在飞激活同样要拆，
 *   关闭会先等 apply 落定（Resources.trackInitialization）。
 * - 拆激活统一 try/catch：拆卸抛出不得让 entry.activation 悬置（否则
 *   重激活闸永挂、插件静默不可激活）。
 * - 清引用带恒等卫：并发路径若已 join 同一次拆卸并清过引用，不重复置空。
 *
 * 「拆激活」对整批统一编排：消费者先于它依赖的提供者关闭，归属树与服务依赖一起决定顺序
 * （见 close-plan.ts）。同一轮里要停的插件必须一起传入，否则它们之间的关闭次序只剩注册序。
 * entries 的给定次序是无依赖关系时的关闭次序。
 *
 * @param targetState 整批的目标态，或按条目给（管理动作的主体另有终态，同批下游转 pending）
 * @param planRoot 停机时传根激活：宿主的根绑定（app.bind）与全部插件进同一张计划，
 *   宿主的收尾因此排在它用到的插件关闭之前。
 * @param settle 已冻的计划（`App.stop` 在 `app:stopping` 之前 freeze）；缺省由 closeActivations 现冻。
 */
export async function retireBatch(
  entries: PluginRecord[],
  targetState: PluginState | ((entry: PluginRecord) => PluginState),
  deps: ActivationDeps,
  opts?: { emitUnloaded?: boolean; planRoot?: Activation; settle?: Map<Activation, () => void> },
): Promise<void> {
  const closing: Array<{ entry: PluginRecord; activation: Activation }> = [];
  for (const entry of entries) {
    entry.state = typeof targetState === 'function' ? targetState(entry) : targetState;
    if (entry.activation) closing.push({ entry, activation: entry.activation });
  }
  try {
    const roots = opts?.planRoot ? [opts.planRoot] : closing.map(item => item.activation);
    await closeActivations(roots, deps.disposeTimeoutMs, deps.logger, opts?.settle);
  } catch (err) {
    deps.logger.error('拆卸抛错:', err);
  }
  for (const { entry, activation } of closing) {
    if (entry.activation === activation) entry.activation = undefined;
    if (opts?.emitUnloaded !== false) deps.host.runtime.notify('plugin:unloaded', entry.instanceId);
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
export function computeTargetState(entry: PluginRecord, services: ServiceContainer): PluginState {
  if (entry.state === 'disabled' || entry.state === 'disposed' || entry.state === 'error') {
    return entry.state;
  }
  return entry.required.some(name => services.get(name) === undefined) ? 'pending' : 'active';
}

/**
 * 尝试激活一个 pending 插件：依赖检查 → 建激活 → 挂载定义 → provides 校验。
 *
 * 本次 required 引用缺席：清理失败激活后回到 pending，并让重算继续观察可能已恢复的依赖。
 * 其余失败转为 error 态（带 message），外层 recompute 不会重试。
 * 前置条件（唯一调用方 recomputeOnce 的 Phase B 在同一拍里已判定）：entry 为 pending，required 依赖都有提供者。
 */
export async function activatePlugin(entry: PluginRecord, deps: ActivationDeps): Promise<'retry' | undefined> {
  const { host, logger } = deps;
  const services = host.runtime.services;

  // 旧激活仍在拆卸中（bounce 先置 'pending'、后异步拆旧激活，拆完才清
  // entry.activation）：此刻重新激活会让新旧实例同 instanceId 并存——同名服务重复
  // provide、偏好按 contextId 二义。跳过本轮，等管理路径收尾后的 recompute 重新调度。
  if (entry.activation) return;

  // 先标记为 activating，防止 service:registered 事件导致重入
  entry.state = 'activating';

  const activation = host.create(host.root, entry.instanceId, entry.config);
  entry.activation = activation;

  try {
    // 登记后再 await，让拆卸路径能先等 apply 落定（见 Resources.trackInitialization）
    const applying = Promise.resolve(host.mount(activation, entry.definition));
    activation.resources.trackInitialization(applying);
    await applying;

    // 根已冻进停机计划：App 正等当前 recompute 落定后才执行该计划。
    // 此处不能转入 retireBatch 再 join 计划，否则有限 apply 也会与 stop 互等。
    if (host.root.resources.disposed) return;

    // 接管检查（CAS 式）：unload / disable / bounce 撞上在飞 apply 时
    // 会先把 state 改离 'activating' 再 disposeAsync（等的正是上面这个 applying）。
    // 此处一旦观察到 state 被改走，说明终态与激活的拆卸责任已归管理路径所有，
    // 本次激活的收尾（置 active / 报 error / 发 plugin:loaded）全部让位。
    // 检查与下方各写入之间无 await，不存在二次窗口。
    if (entry.state !== 'activating') {
      logger.debug(`插件 "${entry.instanceId}" 激活期间被管理操作接管（现态 ${entry.state}），本次激活让位`);
      return;
    }

    // 激活期间资源被拆卸（宿主直调 disposeAsync 撞上在飞 apply，state 未被改走）：
    // provide 已被 post-dispose 守卫吞掉，provides 校验必然失败——但那是框架层
    // 竞态，不是作者的声明错误，必须如实归因，不能报「声明了但未注册」的假罪名。
    if (activation.resources.disposed) {
      throw new Error('激活期间资源已被拆卸，插件未完成注册');
    }
    const provides = entry.definition.provides?.map(descriptor => descriptor.name) ?? [];
    const missing = provides.filter(name => !services.hasByContext(name, entry.instanceId));
    if (missing.length > 0) {
      throw new Error(`声明 provides [${missing.join(', ')}] 但未实际注册这些服务`);
    }

    // dev mode：反向一致性检查 —— 实际注册的服务名是否都在 provides 中声明
    // provides 供启动排序使用；关闭编排仍按激活实际持有的依赖建边
    // 注：是否 dev 由宿主通过 `App({ devMode })` 显式注入，core 不读 process.env
    if (host.runtime.devMode) {
      const declared = new Set(provides);
      const actuallyProvided = services.getServiceNames().filter(name => services.hasByContext(name, entry.instanceId));
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
    // apply 拒绝也不能夺回停机已接管的拆卸责任；资源由同一计划回滚。
    if (host.root.resources.disposed) return;
    // 接管让位同上：管理路径已持有终态与激活的拆卸责任，此处再写 error /
    // 二次 dispose 会踩掉 disposed / disabled / pending 终态。
    if (entry.state !== 'activating') {
      logger.debug(`插件 "${entry.instanceId}" 激活中止且已被管理操作接管（现态 ${entry.state}）:`, err);
      return;
    }
    if (isRequiredServiceUnavailable(err, activation.resources, entry.required)) {
      logger.debug(`插件 "${entry.instanceId}" 初始化期间 required 服务不可用，清理后等待依赖恢复`);
      entry.error = undefined;
      await retireBatch([entry], 'pending', deps, { emitUnloaded: false });
      return 'retry';
    }
    logger.error(`插件 "${entry.instanceId}" 激活失败:`, err);
    // retireBatch 先写 'error' 再等清理——并发观察者（getStatus / 早退返回的
    // 调用方）依赖状态机即时转移，异步清理不该拖延 'error' 的可见时点。
    // 不发 unloaded：本插件从未 loaded 过，配对事件无从谈起。
    entry.error = message;
    await retireBatch([entry], 'error', deps, { emitUnloaded: false });
    return;
  }

  // 激活成败只由 apply/provides 校验决定，旁观者的监听器不参与归因。不等监听器：本函数在
  // recompute flight 内逐个 entry 调用，等会让一个旁观者的慢 handler 挡住下一个插件的激活，
  // 监听器里 `await plugins.idle()` 更是互等死锁（idle 等 flight 排干，flight 等它返回）。
  host.runtime.notify('plugin:loaded', entry.instanceId);
}
