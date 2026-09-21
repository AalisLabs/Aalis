import type { PluginManagerService, PluginStatusEntry } from '../types/index.js';
import { type PluginEntry, type PluginState, parseInstanceId } from '../types/plugin.js';

import { reportQuietly } from '../kernel/disposable-chain.js';

import { optionalNames, requiredNames } from '../context/binding.js';
import { events } from '../context/builtins.js';
import type { ConfigManager } from '../context/config.js';
import { assertValidInstanceId, type PluginDefinition, validateDefinition } from '../context/definition.js';
import type { Logger } from '../context/logger.js';
import { cloneConfigObject } from '../context/safe-keys.js';

import type { Activation } from './activation.js';
import type { ActivationHost } from './activation-host.js';
import { freezeActivations } from './close-plan.js';
import {
  type ActivationDeps,
  activatePlugin,
  computeTargetState,
  type PluginRecord,
  retireBatch,
  retireEntry,
} from './plugin-activation.js';
import { topoSortByDeps } from './plugin-topology.js';

export type { PluginEntry, PluginState };
export { parseInstanceId };

/** 一次重算的种类：普通状态变化（服务上下线、注册、启停、重载）合并处理；停机覆盖整批 */
type RecomputeKind = 'changed' | 'shutdown';

/**
 * 插件管理器
 *
 * 负责:
 * - 注册/加载/卸载插件
 * - 依赖追踪 (required + optional，判据=服务是否在容器中)
 * - 当所需服务就绪时自动激活插件
 * - 当所需服务移除时自动停用插件
 * - 插件启用/禁用控制
 */
export class PluginManager implements PluginManagerService {
  private plugins = new Map<string, PluginRecord>();
  private logger: Logger;
  /** 交给编排层自由函数（activatePlugin / retireEntry / retireBatch）的宿主注入件，构造一次 */
  private readonly deps: ActivationDeps;
  /** recompute 单飞标志：true 表示一次 recompute（含排队补跑）正在进行 */
  private reloading = false;
  /**
   * 手动 dispose 段计数器：disable / unload / bounce 在「dispose 旧
   * 激活 → 改 entry.state」这段不可分割的状态变更期间 +1。期间 dispose 触发的
   * service:unregistered 反应式 recompute 会被**排队**（而非立即跑——那会看到
   * 半成品状态，比如把正在禁用的插件重新激活），由这些方法收尾的 softReload 统一消化。
   *
   * 用计数器而非布尔：dispose hook 内可能同步级联调用 disable/unload（级联
   * 禁用），嵌套时内层的 finally 若复位布尔会过早解除外层的挂起态——计数器确保
   * 只有最外层退出（归零）才解除。
   */
  private suspendDepth = 0;
  private get suspended(): boolean {
    return this.suspendDepth > 0;
  }
  /**
   * 被推迟的重算：在飞 recompute 或手动 dispose 段期间到来的请求合并成一次，停机覆盖普通变化。
   * 目标态只看容器里此刻有没有服务，合并不丢信息。消费前先摘下，执行期间的新请求另起一次。
   */
  private queued: RecomputeKind | null = null;
  /**
   * 全局关机标志。app.stop() 在 dispose 前置位，所有反应式级联（service:registered/
   * unregistered → checkPending/Active）都会因此跳过——避免「正在关机还去 bounce
   * 一个永远不会被重新激活的插件」这种无意义噪声，也避免下游插件 dispose 中
   * 试图 register 命令 / 监听服务等动作触发误重入。
   */
  private shuttingDown = false;
  /** 停机计划的完成信号：beginShutdown 冻树时填，stopAll 执行该计划 */
  private shutdownSettle?: Map<Activation, () => void>;

  /** 是否正在关机——供插件 dispose hook 短路用 */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * 停机截止点：置 shuttingDown，并把根激活整棵树冻进一张计划。
   * 之后 register 拒绝；对本树的 disposeAsync 汇入该计划。真正的 drain/close 由 stopAll 执行。
   */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownSettle = freezeActivations([this.host.root]);
  }

  /** idle() 的等待者——在 recompute flight 排干（无在飞、无排队、无挂起段）时统一放行 */
  private idleWaiters: Array<() => void> = [];

  /**
   * 等待插件状态机静置：无在飞 recompute、无排队请求、无手动 dispose 段。
   *
   * register/unload/enable/disable 等变更 API 在已有 flight 在飞时会**排队并
   * 立即返回**（单飞早退是刻意设计，join 在飞 promise 会在 apply/onDispose 内
   * 同步触发的变更调用上自我死锁）。需要"尘埃落定后再观察"的外部调用方
   * （宿主引导、WebUI 刷新、测试断言）在变更后 await 本方法。
   *
   * **不得在插件 apply / onDispose 内调用**——flight 正等着你返回，
   * 等 flight 结束即互等死锁。
   */
  idle(): Promise<void> {
    if (!this.reloading && !this.suspended && this.queued === null) return Promise.resolve();
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  private settleIdleWaiters(): void {
    if (this.reloading || this.suspended || this.queued !== null) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  constructor(
    private readonly host: ActivationHost,
    private readonly config: ConfigManager,
    logger: Logger,
    /** 单个异步清理项的等待上限（毫秒；0=不设限），由 App 从 AppOptions 注入 */
    private readonly disposeTimeoutMs?: number,
  ) {
    this.logger = logger.child('plugins');
    this.deps = { host, logger: this.logger, disposeTimeoutMs };

    // 监听服务注册/注销，路由到统一 recompute()。
    // 单飞/挂起/关机的取舍都在 recompute 内部处理（在飞期间排队，关机后跳过）。
    const boundEvents = host.bind(host.root, { events }).events;
    for (const event of ['service:registered', 'service:unregistered'] as const) {
      boundEvents.on(event, name => {
        this.recompute().catch(err => reportQuietly(() => this.logger.error(`recompute(${event}:${name}) 报错:`, err)));
      });
    }
  }

  /**
   * 注册并尝试加载一个插件
   *
   * @param definition 插件定义（definePlugin 的产物）
   * @param config    插件配置
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 definition.name）
   * @returns 口径见 {@link PluginManagerService}：false = 重名、未声明 reusable 却要多实例、或定义 / 实例 id 校验失败
   *   （缺 / 空 / 非法 name、uses 非描述符、非法 instanceId；各记一笔 warn）；true = 已落账（含注册为 disabled 态），激活是否已发生另看 idle()
   */
  async register(
    definition: PluginDefinition,
    config: Record<string, unknown> = {},
    instanceId?: string,
  ): Promise<boolean> {
    // 手写的定义对象（没经 definePlugin）在这里补上同一道校验。失败不抛——六个管理动作统一 Promise<boolean>
    try {
      validateDefinition(definition);
      if (instanceId !== undefined) assertValidInstanceId(instanceId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`插件定义校验失败，拒绝注册: ${reason}`);
      return false;
    }

    const id = instanceId ?? definition.name;

    if (this.shuttingDown) return this.refuse('register', id, '处于停机终态');

    // 多实例检查：同一份定义非 reusable 时不允许重复注册
    if (this.plugins.has(id)) {
      this.logger.warn(`插件 "${id}" 已注册，跳过`);
      return false;
    }
    if (id !== definition.name && !definition.reusable) {
      this.logger.warn(`插件 "${definition.name}" 未声明 reusable，不允许多实例注册 "${id}"`);
      return false;
    }

    // 检查是否被配置禁用（按 instanceId 检查）
    const isDisabled = this.config.isPluginDisabled(id);

    const entry: PluginRecord = {
      definition,
      instanceId: id,
      config: cloneConfigObject(config),
      state: isDisabled ? 'disabled' : 'pending',
      required: requiredNames(definition.uses ?? {}),
      optional: optionalNames(definition.uses ?? {}),
    };

    this.plugins.set(id, entry);

    if (isDisabled) {
      this.logger.info(`插件已注册(禁用): ${id}`);
    } else {
      this.logger.info(`插件已注册: ${id}`);
      // 走统一 recompute：依赖满足则被拓扑正序激活，否则保持 pending
      await this.recompute();
    }
    return true;
  }

  /**
   * 卸载一个插件
   *
   * @returns 口径见 {@link PluginManagerService}：false = 注册表里没有这个实例；true = 其余（含卸载
   *   已在途时 join 它——返回时该实例已拆卸并离开注册表）
   */
  async unload(instanceId: string): Promise<boolean> {
    const entry = this.plugins.get(instanceId);
    if (!entry) return this.refuse('unload', instanceId, '不在注册表');

    if (this.shuttingDown) {
      // 停机中 unload 必须在 disposed-join 之前：retireBatch 会先把条目标 disposed，
      // 若走 join #closing，drain 里再 unload 会与计划互等。汇入后立即 true。
      if (entry.activation) void entry.activation.disposeAsync(this.disposeTimeoutMs);
      this.logger.debug(`unload: 插件 "${instanceId}" 停机中已汇入停机计划`);
      return true;
    }

    // 'disposed' 单向化的 unload 侧：已有卸载在途（或停机遗留终态）时不再二次
    // retire/emit——join 其拆卸（disposeAsync 幂等）后只确保注册表摘除。删除必须
    // 带恒等卫：并发首个 unload 完成后同 id 可能已重新注册，按名盲删会把无辜的
    // 新 entry 扫出注册表，留下注册表外的活实例。
    if (entry.state === 'disposed') {
      const inflight = entry.activation;
      if (inflight) await inflight.disposeAsync(this.disposeTimeoutMs);
      if (this.plugins.get(instanceId) === entry) this.plugins.delete(instanceId);
      return true;
    }

    // dispose 段守卫（与 disable 对齐）：dispose 触发的反应式 recompute
    // 排队到收尾的 softReload，避免在 entry 半卸载态下重算。
    this.suspendDepth++;
    try {
      // delete 必须留在拆卸**之后**：注册表是 register/rescan 的查重闸
      // （plugins.has(id)），提前摘除会让同 id 在旧激活 排空期间重新注册，
      // 新旧实例同 instanceId 并存——同名服务重复 provide、偏好按 contextId 二义。
      await this.retire(entry, 'disposed');
      if (this.plugins.get(instanceId) === entry) this.plugins.delete(instanceId);
      this.logger.info(`插件已卸载: ${instanceId}`);
    } finally {
      this.suspendDepth--;
    }

    // 级联重算：依赖被卸载插件所提供服务的下游需要转 pending
    await this.softReload();
    return true;
  }

  /**
   * 管理动作的 false 分支之一：主体不在注册表，或处于 'disposed' 单向终态。记 debug 而非 warn——
   * 这不是故障，调用方（WebUI 路由、市场卸载流程）常在探测；被政策挡下的分支各自就地 warn。
   */
  private refuse(action: string, instanceId: string, why: string): false {
    this.logger.debug(`${action}: 插件 "${instanceId}" ${why}`);
    return false;
  }

  private retire(entry: PluginRecord, target: PluginState, opts?: { emitUnloaded?: boolean }): Promise<void> {
    return retireEntry(entry, target, this.deps, opts);
  }

  /**
   * 启用一个已禁用的插件
   */
  async enable(instanceId: string): Promise<boolean> {
    const entry = this.plugins.get(instanceId);
    if (!entry) return this.refuse('enable', instanceId, '不在注册表');
    // 'disposed' 对管理路径单向（见 bounce 内注释）
    if (entry.state === 'disposed') return this.refuse('enable', instanceId, '处于 disposed 终态');
    if (entry.state !== 'disabled' && entry.state !== 'error') return true; // 已经启用
    // 依赖不变量：disabled/error 态的 entry 必然 activation 已清（disable 与激活失败
    // 都经 retireEntry 清引用；锚在 admin-during-activation 测试）——否则此处转
    // pending 后会被激活侧的「旧激活 未清」闸永久跳过。
    entry.state = 'pending';
    entry.error = undefined;
    this.config.setPluginEnabled(instanceId, true);
    this.logger.info(`插件已启用: ${instanceId}`);
    await this.softReload();
    return true;
  }

  /**
   * 禁用一个活跃的插件（core 插件不能禁用）
   */
  async disable(instanceId: string): Promise<boolean> {
    const entry = this.plugins.get(instanceId);
    if (!entry) return this.refuse('disable', instanceId, '不在注册表');

    if (entry.definition.core) {
      this.logger.warn(`核心插件 "${instanceId}" 不能被禁用`);
      return false;
    }

    // 'disposed' 对管理路径单向（见 bounce 内注释）
    if (entry.state === 'disposed') return this.refuse('disable', instanceId, '处于 disposed 终态');
    if (entry.state === 'disabled') return true; // 已经禁用

    if (this.shuttingDown) {
      if (entry.activation) void entry.activation.disposeAsync(this.disposeTimeoutMs);
      this.logger.debug(`disable: 插件 "${instanceId}" 停机中已汇入停机计划`);
      return true;
    }

    // dispose 段守卫：期间反应式 recompute 排队到收尾的 softReload
    this.suspendDepth++;
    try {
      this.config.setPluginEnabled(instanceId, false);
      await this.retire(entry, 'disabled');
      this.logger.info(`插件已禁用: ${instanceId}`);
    } finally {
      this.suspendDepth--;
    }

    await this.softReload();
    return true;
  }

  /**
   * 获取所有已注册插件的状态
   *
   * 返回类型即 PluginManagerService 接口的 PluginStatusEntry（types/app.ts），
   * 编译期保证两边不漂移。
   */
  getStatus(): PluginStatusEntry[] {
    // 状态摘要只含内核事实。配置详情（config / configSchema）与展示元数据（subsystem / extends）
    // 由消费者经 getPlugin(instanceId) 从 entry.config / entry.definition 读取——core 状态契约不携带。
    return [...this.plugins.values()].map(entry => ({
      name: entry.definition.name,
      instanceId: entry.instanceId,
      displayName: entry.definition.displayName,
      state: entry.state,
      provides: entry.definition.provides?.map(descriptor => descriptor.name),
      core: entry.definition.core,
      reusable: entry.definition.reusable,
      requiredServices: entry.required.length > 0 ? entry.required : undefined,
      optionalServices: entry.optional.length > 0 ? entry.optional : undefined,
      error: entry.error,
    }));
  }

  /**
   * 获取单个插件
   */
  getPlugin(instanceId: string): PluginEntry | undefined {
    return this.plugins.get(instanceId);
  }

  /**
   * 更新插件配置：`bounce(instanceId, { config })` 的薄壳，独立成名只为让调用点
   * （WebUI / 配置文件热重载）语义清晰。
   */
  async updateConfig(instanceId: string, config: Record<string, unknown>): Promise<boolean> {
    return this.bounce(instanceId, { config });
  }

  /**
   * 增量重载单个插件（核心入口）：持久化新 config（如有）→ 拆掉当前激活 → 转 pending → 重算后重新激活。
   * `error` 态插件会被重置为 pending 重试。
   *
   * 下游不跟着重启：消费者经绑定接口每次解析当前提供者，有状态的接线由 follow 在提供者换人时交接。
   * 不换代码：跑的仍是注册时的那份定义。要换代码走 `unload` + `register`。
   *
   * @returns false 表示找不到 entry、处于 disabled 态或 'disposed' 终态，或停机进行中（拒绝重建）。
   */
  async bounce(instanceId: string, opts?: { config?: Record<string, unknown> }): Promise<boolean> {
    const entry = this.plugins.get(instanceId);
    if (!entry) return this.refuse('bounce', instanceId, '不在注册表');
    if (entry.state === 'disabled') {
      this.logger.warn(`bounce: 插件 "${instanceId}" 处于 disabled 态，跳过`);
      return false;
    }
    // 'disposed' 对管理路径单向（含卸载在途与停机后的遗留终态两种情形）：
    // unload 写入终态与从注册表摘除之间隔着 retire 的微任务（即使无激活可拆，
    // await 也让出）——此窗口内把它覆写回 'pending' 会重新武装 entry，激活出
    // 一个注册表外的永生孤儿实例；停机后覆写则会把插件误写进持久化禁用清单。
    if (entry.state === 'disposed') return this.refuse('bounce', instanceId, '处于 disposed 终态');
    if (this.shuttingDown) return this.refuse('bounce', instanceId, '停机中不重建');
    // 旧调用方（JS 无类型约束）传 module 期望换码：拒绝而非静默跑旧代码，否则调用方以为换成功了。
    if (opts && 'module' in opts) {
      this.logger.warn(`bounce: 插件 "${instanceId}" 不再支持 module 热替换，改走 unload + register`);
      return false;
    }

    const newConfig = opts?.config;
    if (newConfig) {
      // 入参可能是调用方还要继续用的活对象（WebUI PUT / config-sync 浅铺开的 payload）。
      // entry 与 ConfigManager 各持一份拷贝：插件经内置 config 就地改嵌套不得写穿快照。
      entry.config = cloneConfigObject(newConfig);
      this.config.setPluginConfig(instanceId, cloneConfigObject(newConfig));
    }

    // dispose 段守卫（与 disable / unload 对齐）：dispose 触发的反应式
    // recompute 不能在 entry 尚未转 pending 时跑——会把半 bounce 态误判。
    this.suspendDepth++;
    try {
      entry.error = undefined;
      await this.retire(entry, 'pending');
    } finally {
      this.suspendDepth--;
    }
    await this.softReload();
    return true;
  }

  // 多实例的配置文件编排属管理面（消费者基于公开的 register / unload / config API 组合实现）；
  // 内核只保留多实例机制本身（register 带 instanceId + reusable 校验）。

  /**
   * 全局停机：全部 active 插件与宿主的根激活进同一张关停计划——消费者先于它依赖的提供者关闭，
   * 下游的收尾还能把数据交给下层（见 orchestration/close-plan.ts）。
   *
   * 停机置位后服务上下线不再触发反应式重算，本方法是关机时唯一的拆卸编排者。
   */
  async stopAll(): Promise<void> {
    await this.recompute('shutdown');
  }

  /** 软重载：管理动作（启停、重载、卸载）收尾时请求一次重算 */
  async softReload(): Promise<void> {
    await this.recompute();
  }

  // ----- 单一状态转移入口 -----

  /**
   * 重算所有插件的目标态并按依赖拓扑序应用转移。这是 PluginManager 唯一的状态变更入口。
   *
   * 每轮：
   * 1. 按 required 依赖正序（提供者→消费者）拓扑排序。
   * 2. Phase A：把目标不再是 active 的成批关闭，它们之间的次序由关停编排按实际依赖定。
   * 3. Phase B：正向遍历，激活目标 active 且依赖满足的 pending entry（提供者先起、消费者后起）。
   * 4. 本轮有变动则继续下一轮，直到稳定或达到 maxRounds；非停机时发 plugins:changed。
   *
   * 判据只有一条：服务此刻在不在容器里。
   */
  async recompute(kind: RecomputeKind = 'changed'): Promise<void> {
    if (this.shuttingDown && kind !== 'shutdown') {
      // 关机已置位时非关机请求无意义；但若队列里躺着一个被挂起的 shutdown
      // （stop() 与手动 dispose 段竞态），借这次调用把它接过来跑完。
      if (this.queued !== 'shutdown') {
        // 早退也要结算 idle 等待者：管理段收尾的 softReload 走到这里时状态机已静置，
        // 不结算的话此前压进来的 idle() 永不落定（结算自己会核对三条静置守卫）
        this.settleIdleWaiters();
        return;
      }
    }
    if (kind === 'shutdown') this.shuttingDown = true;
    if (this.queued === null || kind === 'shutdown') this.queued = kind;

    // 单飞 + 排队（修 lost wakeup）：在飞期间/手动 dispose 段的请求合并排队，
    // 由在飞 run 收尾时补跑或 dispose 段收尾的 softReload 消化。注意这里必须
    // 立即返回而不能把在飞 promise 交还调用方——若调用方恰在某插件 apply()
    // 内同步调用（在飞 run 正 await 它），等待在飞 promise 会自我死锁。
    if (this.reloading || this.suspended) {
      return;
    }

    this.reloading = true;
    // 只约束 required 缺失触发的自动重试。按 entry 记整个 flight 的余量，queued / softReload
    // 不能给同一失败者补满预算；暂停它不妨碍其他插件或管理状态收敛。flight 结束即释放。
    const retryBudget = new Map<PluginRecord, number>();
    try {
      while (this.queued) {
        const current = this.queued;
        this.queued = null;
        await this.recomputeOnce(current, retryBudget);
      }
    } finally {
      this.reloading = false;
      this.settleIdleWaiters();
    }
  }

  /** 单次完整重算：fixed-point 状态转移 + （非关机）plugins:changed 通知 */
  private async recomputeOnce(kind: RecomputeKind, retryBudget: Map<PluginRecord, number>): Promise<void> {
    // 停机：全部插件激活与宿主的根激活进同一张计划（无依赖关系时后注册的先关）
    if (kind === 'shutdown') {
      const live = [...this.plugins.values()].filter(entry => entry.activation !== undefined).reverse();
      await retireBatch(live, 'disposed', this.deps, {
        emitUnloaded: false,
        planRoot: this.host.root,
        settle: this.shutdownSettle,
      });
      return;
    }

    let changed = true;
    let rounds = 0;
    // 普通依赖级联的拆除波、激活波按图规模取 2N+8 轮（+8 为小图垫底），不暴露调优旋钮。
    // 初始化期间 required 再次消失不属于单调级联：它的自动重试另用整段 flight 的 entry 预算，
    // 防止 queued 补跑不断重置本函数的轮数。这里仍保留普通状态振荡的点名上限。
    // 每轮现算而非入口冻结：注册期 recompute 排队立即返回，后续 app.plugin() 会在本
    // recomputeOnce 在飞时追加 entry（每轮快照重取），上限须随图同步增长，否则合法的增量注册流会被按
    // 旧规模误判为振荡。
    const maxRounds = (): number => this.plugins.size * 2 + 8;
    let lastRoundFlips: string[] = [];

    converge: while (changed && rounds < maxRounds()) {
      changed = false;
      rounds++;
      lastRoundFlips = [];

      const order = topoSortByDeps([...this.plugins.values()], this.logger);

      // Phase A: 本轮目标不再是 active 的，成批关闭——它们之间的次序由关停编排按实际依赖定
      const retiring: PluginRecord[] = [];
      for (const entry of [...order].reverse()) {
        if (entry.state !== 'active') continue;
        if (computeTargetState(entry, this.host.runtime.services) === 'active') continue;
        const unmet = entry.required.find(name => this.host.runtime.services.get(name) === undefined);
        this.logger.info(`依赖 "${unmet}" 不可用，停用插件: ${entry.instanceId}`);
        retiring.push(entry);
        lastRoundFlips.push(entry.instanceId);
      }
      if (retiring.length > 0) {
        await retireBatch(retiring, 'pending', this.deps);
        changed = true;
      }

      // Phase B: 正向遍历，激活目标 active 的 pending entry
      for (const entry of order) {
        // 停机已在排队：不再启动新的实例
        if (this.shuttingDown || this.queued === 'shutdown') break converge;
        if (entry.state !== 'pending') continue;
        if (retryBudget.get(entry) === 0) continue;
        if (computeTargetState(entry, this.host.runtime.services) !== 'active') continue;
        const result = await activatePlugin(entry, this.deps);
        if (result === 'retry') {
          // 首次失败按当时图规模取额；后续新增插件也不能让失稳 entry 不断扩额。
          const remaining = (retryBudget.get(entry) ?? maxRounds()) - 1;
          retryBudget.set(entry, remaining);
          if (remaining === 0) {
            this.logger.warn(`插件 "${entry.instanceId}" required 依赖重试未收敛，本轮暂缓自动激活，保持 pending`);
            continue;
          }
          changed = true;
          lastRoundFlips.push(entry.instanceId);
        } else if ((entry.state as PluginState) === 'active') {
          changed = true;
          lastRoundFlips.push(entry.instanceId);
        }
      }
    }

    if (changed && rounds >= maxRounds()) {
      // 静态 required 环由 topoSortByDeps 检出并另行告警；到这里仍在翻转的
      // 状态变化已超出本轮收敛上限。点名末轮
      // 仍在翻转的插件——矛盾对必在其中。
      this.logger.warn(
        `recompute ${rounds} 轮未收敛（上限 ${maxRounds()} = 2×插件数+8），` +
          `疑似插件间状态振荡。最后一轮仍在翻转: ${lastRoundFlips.join(', ') || '(无记录)'}`,
      );
    }

    this.host.runtime.notify('plugins:changed');
  }
}
