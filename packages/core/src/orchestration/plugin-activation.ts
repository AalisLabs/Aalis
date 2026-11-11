// ============================================================
// plugin-activation.ts — 插件激活路径辅助
//
// 从 plugin.ts 拆出的单个条目的推进与拆卸：
//   - retireBatch：拆卸的唯一形状
//   - activatePlugin：建激活 → 挂载定义 → 校验 provides → 标记 active/error
//
// 需要的 PluginManager 状态经 deps 传入，PluginManager 自身只负责事件路由与重算编排。
// ============================================================

import { coreFailure } from '../types/failure.js';
import type { PluginEntry, PluginState } from '../types/plugin.js';

import type { Activation } from './activation.js';
import type { ActivationHost } from './activation-host.js';
import { closeActivations } from './close-plan.js';
import { missingRequiredService } from '../composition/binding.js';
import type { DefinitionSpec } from '../composition/plugin-definition.js';
import { cloneConfigObject } from '../infrastructure/config-values.js';
import { type LogWriter, summarizeError } from '../infrastructure/logger.js';

/**
 * 注册表里的记录：公开的 {@link PluginEntry} 加上登记时取定的定义、这次激活与重试余额（不进公开类型）。
 * 失败只存一份 failure，error 在投影时现算
 */
export interface PluginRecord extends Omit<PluginEntry, 'error'> {
  /** 登记时取定的定义：core 只读它，不回到 definition 上现读 */
  readonly spec: DefinitionSpec;
  activation?: Activation;
  /** 初始化期 required 缺失的自动重试余额，跨重算累计；未取额时为 undefined（见 PluginManager 的 spendRetry） */
  retriesLeft?: number;
}

/**
 * 编排层自由函数的宿主注入件。领域数据（entry、注册表、目标态）按位置传，注入件统一收在这里，
 * 由 PluginManager 构造一次、各函数按需读取。
 */
export interface ActivationDeps {
  host: ActivationHost;
  logger: LogWriter;
  /** 拆卸时单个异步清理项的等待上限，也是 abort 后等在飞初始化落定的宽限（毫秒；缺省不设限） */
  disposeTimeoutMs?: number;
  /** 初始化期 required 缺失时记一次重试，返回这次拆卸的目标态（见 PluginManager 的 #spendRetry） */
  spendRetry: (entry: PluginRecord, missing: string, cause?: unknown) => 'pending' | 'error';
  /** 关完的激活仍有工作没落定（rest 落定时兑现）：记在实例 id 名下，落定之前同一 id 不启动新实例 */
  linger: (instanceId: string, rest: Promise<unknown>) => void;
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
 *   signal 立即 abort，收尾段至多再等 disposeTimeoutMs 让 apply 落定（Resources.drain）。
 * - 关完仍有工作没落定的（被拆的初始化或清理超过宽限，Resources.lingering）交给 deps.linger 记在 id 名下：终态照写，
 *   同一 id 等它落定才启动新实例（含卸载后同 id 重新登记）。
 * - 拆激活统一 try/catch：拆卸抛出不得让 entry.activation 悬置（否则
 *   重激活闸一直阻塞、插件静默不可激活）。
 * - 清引用带恒等卫：并发路径若已 join 同一次拆卸并清过引用，不重复置空。
 *
 * 「拆激活」对整批统一编排：消费者先于它依赖的提供者关闭，归属与服务依赖一起决定顺序
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
  const closing: Array<{ entry: PluginRecord; activation: Activation; loaded: boolean }> = [];
  for (const entry of entries) {
    // 'active' 与 plugin:loaded 在同一同步段里写下；仍在初始化的、另一管理动作已改走终态的都不算
    const loaded = entry.state === 'active';
    entry.state = typeof targetState === 'function' ? targetState(entry) : targetState;
    if (entry.activation) closing.push({ entry, activation: entry.activation, loaded });
  }
  try {
    // 给定次序就是无依赖时的关闭次序；停机时根排在最后（它名下其余的激活随根补进计划）
    const roots = closing.map(item => item.activation);
    if (opts?.planRoot) roots.push(opts.planRoot);
    await closeActivations(roots, deps.disposeTimeoutMs, deps.logger, opts?.settle);
  } catch (err) {
    deps.logger.error('拆卸抛错:', err);
  }
  for (const { entry, activation, loaded } of closing) {
    const rest = activation.resources.lingering();
    if (rest) deps.linger(entry.instanceId, rest);
    if (entry.activation === activation) entry.activation = undefined;
    if (loaded && opts?.emitUnloaded !== false) deps.host.runtime.notify('plugin:unloaded', entry.instanceId);
  }
}

/**
 * 尝试激活一个 pending 插件：建激活 → 挂载定义 → provides 校验。
 *
 * 本次 required 引用缺席：记一次重试（deps.spendRetry），清理失败激活后回到 pending，并让重算继续观察可能已恢复的
 * 依赖；重试余额用尽则转 error。其余失败转为 error 态（带 message），外层 recompute 不会重试。
 * 前置条件（唯一调用方 PluginManager.#activate 由 Phase B 调用，Phase B 在同一拍里已判定）：entry 为 pending、
 * 旧激活已清，required 依赖都有提供者，且它为这些服务选中的那一家都未进关闭计划。同步段返回时 entry.activation 已是本次激活（配置拷贝失败时没有激活）。
 * 转入后台期间它的服务暂不对外（ServiceContainer.hold）；成功时先写 active 再上线，失败与被接管时随拆卸摘除。
 */
export async function activatePlugin(entry: PluginRecord, deps: ActivationDeps): Promise<'retry' | undefined> {
  const { host, logger } = deps;
  const services = host.runtime.services;

  // 先标记为 activating，防止服务变更触发的重算导致重入
  entry.state = 'activating';

  // 提到 try 外：catch 里认接手看的是本次激活自己，拆卸超过时限放行后 entry.activation 可能已被关闭计划清掉
  let activation: Activation | undefined;
  try {
    // 与其他内置服务一样，每次激活一份：插件改它只影响本次激活，碰不到注册表与下一次激活。拷贝在 try 里：按引用透传的
    // 叶子此刻可能读不了（如登记后被撤销的 Proxy），这时没有激活可拆，照激活失败转 error
    activation = host.create(entry.instanceId, cloneConfigObject(entry.config));
    entry.activation = activation;
    // 登记后再 await，让拆卸路径能先等 apply 落定（见 Resources.trackInitialization）
    // 按取定的 uses 装配；this 仍是定义对象
    const caps = host.bind(activation, entry.spec.uses);
    const applying = Promise.resolve(Reflect.apply(entry.spec.apply, entry.definition, [caps]));
    activation.resources.trackInitialization(applying);
    await applying;

    // 接管检查：本次激活已冻进某张关闭计划，拆卸与终态归那张计划，本次激活的收尾（置 active / 报 error / 发
    // plugin:loaded）全部让位，也不转入 retireBatch 再 join 计划（停机时 App 正等当前 recompute 落定才执行计划，再 join
    // 就会与 stop 互等）。两种接手都表现为本激活已开始关闭：管理动作（retireBatch）改走 state 与冻结计划在同一同步段
    // （closeActivations 的第一句），停机冻结根激活时名下全部激活一并冻上。检查与下方各写入之间无 await，不存在二次窗口
    if (activation.resources.disposed) {
      logger.debug(`插件 "${entry.instanceId}" 激活期间已被接手（现态 ${entry.state}），本次激活让位`);
      return;
    }

    // 按归属核对：本次激活以任何逻辑身份登记的条目都算它的，别的激活登记的同 id 条目不算
    const provides = entry.spec.provides ?? [];
    const registered = services.namesOf(activation.owner);
    const missing = provides.filter(name => !registered.includes(name));
    if (missing.length > 0) {
      const message = `声明 provides [${missing.join(', ')}] 但未实际注册这些服务`;
      throw coreFailure(message, 'provides-not-registered', { services: missing });
    }

    // dev mode：反向一致性检查 —— 实际注册的服务名是否都在 provides 中声明
    // provides 供启动排序使用；关闭编排仍按激活实际持有的依赖建边
    // 注：是否 dev 由宿主通过 `App({ devMode })` 显式注入，core 不读 process.env
    if (host.runtime.devMode) {
      const undeclared = registered.filter(name => !provides.includes(name));
      if (undeclared.length > 0) {
        logger.warn(
          `插件 "${entry.instanceId}" 注册了服务 [${undeclared.join(', ')}] 但未在 provides 中声明 —— ` +
            `下游依赖排序将无法找到该 provider（仅靠 reactive 兜底），建议补全 provides 列表`,
        );
      }
    }

    entry.state = 'active';
    entry.failure = undefined;
    entry.retriesLeft = undefined;
    // 转入过后台的激活此刻上线服务：先写 active，上线触发的重算才看得到它已激活
    for (const name of services.release(activation.owner)) host.runtime.serviceChanged(name);
    logger.info(`插件已激活: ${entry.instanceId}`);
  } catch (err) {
    // 接管让位同上：apply 拒绝也不夺回拆卸责任，资源由接手的那张计划回滚。配置拷贝失败时没有激活，也谈不上被接手
    if (activation?.resources.disposed) {
      logger.debug(`插件 "${entry.instanceId}" 激活中止且已被接手（现态 ${entry.state}）:`, err);
      return;
    }
    // 配置拷贝失败时没有激活，也就谈不上缺服务
    const missing = activation && missingRequiredService(err, activation.resources, entry.spec.required);
    if (missing !== undefined) {
      entry.failure = undefined;
      const target = deps.spendRetry(entry, missing, err);
      // 用尽时 spendRetry 已记 error「已停止」，不再说等待恢复
      if (target === 'pending')
        logger.debug(`插件 "${entry.instanceId}" 初始化期间 required 服务不可用，清理后等待依赖恢复`);
      await retireBatch([entry], target, deps);
      return target === 'pending' ? 'retry' : undefined;
    }
    logger.error(`插件 "${entry.instanceId}" 激活失败:`, err);
    // 抛出 undefined 时没有原值可存：换成说明它的 Error，免得 error 态没有原因
    entry.failure = err === undefined ? new Error(summarizeError(err)) : err;
    await retireBatch([entry], 'error', deps);
    return;
  }

  // 激活成败只由 apply/provides 校验决定，旁观者的监听器不参与归因。不等监听器：本函数在
  // recompute flight 内逐个 entry 调用，等会让一个旁观者的慢 handler 挡住下一个插件的激活，
  // 监听器里 `await plugins.idle()` 更是互等死锁（idle 等 flight 排干，flight 等它返回）。
  host.runtime.notify('plugin:loaded', entry.instanceId);
}
