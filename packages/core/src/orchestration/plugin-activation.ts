// ============================================================
// plugin-activation.ts — 插件激活路径辅助
//
// 从 plugin.ts 拆出的"如何把单个 entry 推进到 active 态"逻辑：
//   - requiredSatisfied：单个 entry 的 required 依赖此刻是否都有提供者
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
import { type Logger, summarizeError } from '../infrastructure/logger.js';

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
  /** 拆卸时单个异步清理项的等待上限，也是 abort 后等在飞初始化落定的宽限（毫秒；缺省不设限） */
  disposeTimeoutMs?: number;
}

/**
 * 拆卸方的唯一形状：先写终态 → 带超时拆激活 → 清引用 → 发 plugin:unloaded（只给拆前已激活、发过 plugin:loaded
 * 的）。单条也走这里。
 *
 * 这四步的**顺序**是并发正确性的承重墙：漏一步或抄错顺序就是覆写竞态。约定只有一条：
 * 「拆卸不许手写，调本函数」——由 test/architecture/state-write-sites.test.ts 的写入点定格测试机器守。
 *
 * - 先写终态：拆卸 await 期间并发管理操作的写入必须是后写者（管理意图胜）；
 *   同时给 activatePlugin 的接管检查提供让位信号。
 * - 判据用 entry.activation 而非 state：'activating' 的在飞或后台激活同样要拆。冻结计划后它的
 *   signal 立即 abort，收尾段至多再等 disposeTimeoutMs 让 apply 落定（Resources.drain）；
 *   到期仍未落定的不再等，记 error 点名「未在宽限内停止」。目标态为 disabled / pending 的（停用 / 重启的主体、
 *   同批下游、required 依赖丢失被拆的后台激活）转 error 态：apply 仍在跑，不能再起新实例，依赖恢复也不自动
 *   重试；卸载与停机的 'disposed' 是单向终态，只记日志。
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
  const closing: Array<{ entry: PluginRecord; activation: Activation; target: PluginState; loaded: boolean }> = [];
  for (const entry of entries) {
    const target = typeof targetState === 'function' ? targetState(entry) : targetState;
    // 'active' 与 plugin:loaded 在同一同步段里写下；仍在初始化的、另一管理动作已改走终态的都不算
    const loaded = entry.state === 'active';
    entry.state = target;
    if (entry.activation) closing.push({ entry, activation: entry.activation, target, loaded });
  }
  try {
    const roots = opts?.planRoot ? [opts.planRoot] : closing.map(item => item.activation);
    await closeActivations(roots, deps.disposeTimeoutMs, deps.logger, opts?.settle);
  } catch (err) {
    deps.logger.error('拆卸抛错:', err);
  }
  for (const { entry, activation, target, loaded } of closing) {
    if (activation.resources.initializing) {
      const reason = `未在宽限内停止（abort 后收尾段又等了 ${deps.disposeTimeoutMs}ms，初始化仍未落定，不再等待）`;
      deps.logger.error(`插件 "${entry.instanceId}" ${reason}`);
      // 只改本批写下、至今未被别的管理动作改写的终态（与写入之间无 await）
      if (target !== 'disposed' && entry.state === target && entry.activation === activation) {
        entry.state = 'error';
        entry.error = reason;
      }
    }
    if (entry.activation === activation) entry.activation = undefined;
    if (loaded && opts?.emitUnloaded !== false) deps.host.runtime.notify('plugin:unloaded', entry.instanceId);
  }
}

/**
 * required 依赖此刻是否都有提供者：recompute 对 active / pending 条目的唯一判据（显式态不经这里，
 * 停机也不经这里）。optional 依赖的上下线不改变目标态：绑定接口每次查询解析当前值，
 * 有状态的接线经 follow 跟随提供者换人，不靠重启插件。
 */
export function requiredSatisfied(entry: PluginRecord, services: ServiceContainer): boolean {
  return entry.required.every(name => services.get(name) !== undefined);
}

/**
 * 尝试激活一个 pending 插件：建激活 → 挂载定义 → provides 校验（依赖与旧激活已清由调用方在同一拍判定，
 * 见前置条件）。
 *
 * 本次 required 引用缺席：清理失败激活后回到 pending，并让重算继续观察可能已恢复的依赖。
 * 其余失败转为 error 态（带 message），外层 recompute 不会重试。
 * 前置条件（唯一调用方 PluginManager.#activate 由 Phase B 调用，Phase B 在同一拍里已判定）：entry 为 pending、
 * 旧激活已清，required 依赖都有提供者且胜者都未进关闭计划。同步段返回时 entry.activation 已是本次激活。
 * 转入后台期间它的服务暂不对外（ServiceContainer.hold）；成功时先写 active 再上线，失败与被接管时随拆卸摘除。
 */
export async function activatePlugin(entry: PluginRecord, deps: ActivationDeps): Promise<'retry' | undefined> {
  const { host, logger } = deps;
  const services = host.runtime.services;

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
    // 还要比激活身份：超过宽限被放弃的 apply 迟到落定时，同一条目可能已起了新一轮激活（state 又是 activating）。
    // 检查与下方各写入之间无 await，不存在二次窗口。
    if (entry.state !== 'activating' || entry.activation !== activation) {
      logger.debug(`插件 "${entry.instanceId}" 激活期间被管理操作接管（现态 ${entry.state}），本次激活让位`);
      return;
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
    // 转入过后台的激活此刻上线服务：先写 active，上线触发的重算才看得到它已激活
    for (const name of services.release(activation.owner)) host.runtime.notify('service:registered', name);
    logger.info(`插件已激活: ${entry.instanceId}`);
  } catch (err) {
    // apply 拒绝也不能夺回停机已接管的拆卸责任；资源由同一计划回滚。
    if (host.root.resources.disposed) return;
    // 接管让位同上：管理路径已持有终态与激活的拆卸责任，此处再写 error /
    // 二次 dispose 会踩掉 disposed / disabled / pending 终态。
    if (entry.state !== 'activating' || entry.activation !== activation) {
      logger.debug(`插件 "${entry.instanceId}" 激活中止且已被管理操作接管（现态 ${entry.state}）:`, err);
      return;
    }
    if (isRequiredServiceUnavailable(err, activation.resources, entry.required)) {
      logger.debug(`插件 "${entry.instanceId}" 初始化期间 required 服务不可用，清理后等待依赖恢复`);
      entry.error = undefined;
      await retireBatch([entry], 'pending', deps);
      return 'retry';
    }
    logger.error(`插件 "${entry.instanceId}" 激活失败:`, err);
    // retireBatch 先写 'error' 再等清理——并发观察者（getStatus / 早退返回的
    // 调用方）依赖状态机即时转移，异步清理不该拖延 'error' 的可见时点。
    entry.error = summarizeError(err);
    await retireBatch([entry], 'error', deps);
    return;
  }

  // 激活成败只由 apply/provides 校验决定，旁观者的监听器不参与归因。不等监听器：本函数在
  // recompute flight 内逐个 entry 调用，等会让一个旁观者的慢 handler 挡住下一个插件的激活，
  // 监听器里 `await plugins.idle()` 更是互等死锁（idle 等 flight 排干，flight 等它返回）。
  host.runtime.notify('plugin:loaded', entry.instanceId);
}
