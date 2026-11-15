// ============================================================
// plugin-activation.ts — 插件激活路径辅助
//
// 从 plugin.ts 拆出的单个条目的推进与拆卸：
//   - retireBatch：拆卸的唯一形状
//   - activatePlugin：建激活 → 挂载定义 → 校验 provides → 标记 active/error
//
// 需要的 PluginManager 状态经 deps 传入，PluginManager 自身只负责服务变更的路由与重算编排。
// ============================================================

import { coreFailure } from '../types/failure.js';
import type { PluginEntry, PluginState } from '../types/plugin.js';

import type { Activation } from './activation.js';
import type { ActivationHost } from './activation-host.js';
import { closeActivations } from './close-plan.js';
import { missingRequiredService } from '../composition/binding.js';
import type { DefinitionSpec } from '../composition/plugin-definition.js';
import { cloneConfigObject } from '../infrastructure/config-values.js';
import { type Logger, type LogWriter, quietLogger, summarizeError } from '../infrastructure/logger.js';

/**
 * 注册表里的记录：公开的 {@link PluginEntry} 加上登记时取定的定义、子日志器与这次激活（不进公开类型）。
 * 失败只存一份 failure，error 在投影时现算。failure 只在激活失败、转 error 的那个同步段里写入，离开 error 的 enable、disable、
 * bounce 都先清掉它：pending、activating、active、disabled 下它恒为空，激活成功与回到 pending 时不必再清
 */
export interface PluginRecord extends Omit<PluginEntry, 'error'> {
  /** 登记时取定的定义：core 只读它，不回到 definition 上现读 */
  readonly spec: DefinitionSpec;
  /** 登记时派生的子日志器：这条登记的每次激活都用它 */
  readonly logger: Logger;
  activation?: Activation;
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
  /** 激活刚落定为 active：就绪相位已开始时由此跑它的就绪回调，不等 */
  activated: (activation: Activation) => void;
  /** 关完的激活仍有工作没落定（rest 落定时兑现）：记在实例 id 名下，落定之前同一 id 不启动新实例 */
  linger: (instanceId: string, rest: Promise<unknown>) => void;
}

/**
 * 拆卸方的唯一形状：先写终态 → 带超时拆激活 → 清引用。单条也走这里。
 *
 * 这三步的**顺序**是并发正确性的承重墙：漏一步或抄错顺序就是覆写竞态。约定只有一条：
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
 * @param settle 已冻的计划（`App.stop` 一开始就 freeze）；缺省由 closeActivations 现冻。
 */
export async function retireBatch(
  entries: PluginRecord[],
  targetState: PluginState | ((entry: PluginRecord) => PluginState),
  deps: ActivationDeps,
  opts?: { planRoot?: Activation; settle?: Map<Activation, () => void> },
): Promise<void> {
  const closing: Array<{ entry: PluginRecord; activation: Activation }> = [];
  for (const entry of entries) {
    entry.state = typeof targetState === 'function' ? targetState(entry) : targetState;
    if (entry.activation) closing.push({ entry, activation: entry.activation });
  }
  try {
    // 给定次序就是无依赖时的关闭次序；停机时根排在最后（它名下其余的激活随根补进计划）
    const roots = closing.map(item => item.activation);
    if (opts?.planRoot) roots.push(opts.planRoot);
    await closeActivations(roots, deps.disposeTimeoutMs, deps.logger, opts?.settle);
  } catch (err) {
    deps.logger.error('拆卸抛错:', err);
  }
  for (const { entry, activation } of closing) {
    const rest = activation.resources.lingering();
    if (rest) deps.linger(entry.instanceId, rest);
    if (entry.activation === activation) entry.activation = undefined;
  }
}

/**
 * 尝试激活一个 pending 插件：建激活 → 挂载定义 → provides 校验。
 *
 * 本次 required 依赖的 use 句柄抛出不可用错误：条目回到 pending，这次激活清理完之后重算再按依赖重新激活，不计次数。其余失败转为 error 态
 * （带 message），外层 recompute 不会重试。激活期间已被关闭计划接手的不改条目，终态归那张计划。
 * 前置条件（唯一调用方 PluginManager.#activate 由 Phase B 调用，Phase B 在同一拍里已判定）：entry 为 pending、
 * 旧激活已清，required 依赖都有提供者，且它为这些服务选中的那一家都未进关闭计划。同步段返回时 entry.activation 已是本次激活。
 * 转入后台期间它的服务暂不对外（ServiceContainer.hold）；成功时先写 active 再上线，失败与被接管时随拆卸摘除。
 */
export async function activatePlugin(entry: PluginRecord, deps: ActivationDeps): Promise<void> {
  const { host, logger } = deps;
  const services = host.runtime.services;

  // 建激活记录、写状态、挂记录在同一个同步段里做完，中间不执行外来代码：之后的外来代码（拷配置时的陷阱、装配函数、apply）
  // 里发起的管理动作，接手的都是挂好的这次激活，下方照常让位。日志器与其他内置服务一样每次激活一份：登记时派生的那一个
  // 每次激活包一层新的，插件就地改它、改它再派生出的子日志器，都只影响本次激活
  const activation = host.create(entry.instanceId, quietLogger(entry.logger));
  entry.state = 'activating';
  entry.activation = activation;
  try {
    // 配置同样每次激活一份：插件改它只影响本次激活，碰不到注册表与下一次激活。按引用透传的叶子此刻可能
    // 读不了（如登记后被撤销的 Proxy），照激活失败转 error
    activation.config = cloneConfigObject(entry.config);
    // 按取定的 uses 装配。拷配置的陷阱里已被接手的不装配，装配函数里已被接手的不调 apply，都由下方让位
    const caps = activation.resources.disposed ? undefined : host.bind(activation, entry.spec.uses);
    if (caps && !activation.resources.disposed) {
      // this 仍是定义对象。登记后再 await，让拆卸路径能先等 apply 落定（见 Resources.trackInitialization）
      const applying = Promise.resolve(Reflect.apply(entry.spec.apply, entry.definition, [caps]));
      activation.resources.trackInitialization(applying);
      await applying;
    }

    // 接管检查：本次激活已冻进某张关闭计划，拆卸与终态归那张计划，本次激活的收尾（置 active / 报 error / 跑就绪回调）
    // 全部让位，也不转入 retireBatch 再 join 计划（停机时 App 正等当前 recompute 落定才执行计划，再 join
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

    // 反向核对：实际注册的服务名都要在 provides 里声明。provides 供启动排序使用；关闭编排仍按激活实际持有的依赖建边
    const undeclared = registered.filter(name => !provides.includes(name));
    if (undeclared.length > 0) {
      logger.warn(
        `插件 "${entry.instanceId}" 注册了服务 [${undeclared.join(', ')}] 但未在 provides 中声明 —— ` +
          `下游依赖排序将无法找到该 provider（仅靠 reactive 兜底），建议补全 provides 列表`,
      );
    }

    entry.state = 'active';
    // 转入过后台的激活此刻上线服务：先写 active，上线这次调用里同步执行的跟随才读得到它已激活
    for (const name of services.release(activation.owner)) host.runtime.serviceChanged(name);
    logger.info(`插件已激活: ${entry.instanceId}`);
  } catch (err) {
    // 接管让位同上：apply 拒绝也不夺回拆卸责任，资源由接手的那张计划回滚。认的是本次激活自己，不经 entry.activation：
    // 拆卸超过时限放行后它可能已被关闭计划清掉
    if (activation.resources.disposed) {
      logger.debug(`插件 "${entry.instanceId}" 激活中止且已被接手（现态 ${entry.state}）:`, err);
      return;
    }
    const missing = missingRequiredService(err, activation.resources, entry.spec.required);
    if (missing !== undefined) {
      logger.debug(`插件 "${entry.instanceId}" 初始化期间 required 服务不可用（缺 "${missing}"），清理后等待依赖恢复`);
      await retireBatch([entry], 'pending', deps);
      return;
    }
    logger.error(`插件 "${entry.instanceId}" 激活失败:`, err);
    // 抛出 undefined 时没有原值可存：换成说明它的 Error，免得 error 态没有原因
    entry.failure = err === undefined ? new Error(summarizeError(err)) : err;
    await retireBatch([entry], 'error', deps);
    return;
  }

  // 激活成败只由 apply/provides 校验决定，就绪回调不参与归因。flight 不等它：本函数在 recompute flight 内逐个 entry 调用，
  // 等会让一个慢回调挡住下一个插件的激活，回调里 `await plugins.idle()` 更是互等（idle 等 flight 排干，flight 等它返回）
  deps.activated(activation);
}
