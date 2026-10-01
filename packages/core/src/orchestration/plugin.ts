import type { PluginManagerService, PluginStatusEntry } from '../types/index.js';
import { type PluginEntry, type PluginState, parseInstanceId } from '../types/plugin.js';

import { reportQuietly } from '../kernel/disposable-chain.js';

import type { Activation } from './activation.js';
import type { ActivationHost } from './activation-host.js';
import { freezeActivations } from './close-plan.js';
import {
  type ActivationDeps,
  activatePlugin,
  type PluginRecord,
  requiredSatisfied,
  retireBatch,
} from './plugin-activation.js';
import { topoSortByDeps } from './plugin-topology.js';
import { events } from '../composition/core-services.js';
import { ForeignCoreError, isOptional, optionalNames, requiredNames, type Uses } from '../composition/descriptors.js';
import { assertValidInstanceId, type PluginDefinition, validateDefinition } from '../composition/plugin-definition.js';
import { cloneConfigObject } from '../infrastructure/config-values.js';
import { type Logger, summarizeError } from '../infrastructure/logger.js';

export type { PluginEntry, PluginState };
export { parseInstanceId };

/** 一条登记：定义、实例配置（原样生效）、实例 id、是否以禁用态登记。字段含义同 `app.plugin` 的参数 */
export interface PluginRegistration {
  definition: PluginDefinition;
  config?: Record<string, unknown>;
  instanceId?: string;
  disabled?: boolean;
}

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
  #plugins = new Map<string, PluginRecord>();
  #logger: Logger;
  readonly #host: ActivationHost;
  /** 单个异步清理项的等待上限（毫秒；0=不设限），由 App 从 AppOptions 注入 */
  readonly #disposeTimeoutMs: number;
  /** 激活超过它仍未完成即转入后台（毫秒；非正数=不设限），由 App 注入 */
  readonly #slowMs: number;
  /** 已转入后台、尚未落定也未被接手的激活（getStatus 据此给出 slow；abort 时据此判断 flight 是否早已放开它） */
  readonly #background = new Set<Activation>();
  /** 交给编排层自由函数（activatePlugin / retireBatch）的宿主注入件，构造一次 */
  readonly #deps: ActivationDeps;
  /** recompute 单飞标志：true 表示一次 recompute（含排队补跑）正在进行 */
  #reloading = false;
  /**
   * 手动 dispose 段计数器：disable / unload / bounce 在「dispose 旧
   * 激活 → 改 entry.state」这段不可分割的状态变更期间 +1。期间 dispose 触发的
   * service:unregistered 反应式 recompute 会被**排队**（而非立即跑——那会看到
   * 半成品状态，比如把正在禁用的插件重新激活），由这些方法收尾的 recompute 统一消化。
   *
   * 用计数器而非布尔：dispose hook 内可能同步级联调用 disable/unload（级联
   * 禁用），嵌套时内层的 finally 若复位布尔会过早解除外层的挂起态——计数器确保
   * 只有最外层退出（归零）才解除。
   */
  #suspendDepth = 0;
  get #suspended(): boolean {
    return this.#suspendDepth > 0;
  }
  /**
   * 被推迟的重算：在飞 recompute 或手动 dispose 段期间到来的请求合并成一次，停机覆盖普通变化。
   * 目标态只看容器里此刻有没有服务，合并不丢信息。消费前先摘下，执行期间的新请求另起一次。
   */
  #queued: RecomputeKind | null = null;
  /**
   * 全局关机标志。app.stop() 在 dispose 前置位，service:registered / unregistered 触发的
   * 反应式重算都会因此跳过——避免「正在关机还去 bounce
   * 一个永远不会被重新激活的插件」这种无意义噪声，也避免下游插件 dispose 中
   * 试图 register 命令 / 监听服务等动作触发误重入。
   */
  #shuttingDown = false;
  /** 停机计划的完成信号：beginShutdown 冻树时填，stopAll 执行该计划 */
  #shutdownSettle?: Map<Activation, () => void>;
  /** 激活序缓存：只随注册表增删失效（依赖声明与 provides 每条不变） */
  #order?: PluginRecord[];

  /**
   * 停机截止点：置 `#shuttingDown`，并把根激活整棵树冻进一张计划。
   * 之后管理动作拒绝；对本树的 disposeAsync 汇入该计划。真正的 drain/close 由 stopAll 执行。
   */
  beginShutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    // 普通重算已失效；清掉排队项，让在飞重算/手动拆卸结束后 idle 能落定。
    this.#queued = null;
    this.#shutdownSettle = freezeActivations([this.#host.root]);
  }

  /** idle() 的等待者——在 recompute flight 排干（无在飞、无排队、无挂起段）时统一放行 */
  #idleWaiters: Array<() => void> = [];

  /**
   * 等待插件状态机静置：无在飞 recompute、无排队请求、无手动 dispose 段。
   *
   * register/unload/enable/disable 等变更 API 在已有 flight 在飞时会**排队并
   * 立即返回**（单飞早退是刻意设计，join 在飞 promise 会在 apply/onDispose 内
   * 同步触发的变更调用上自我死锁）。需要"尘埃落定后再观察"的外部调用方
   * （宿主引导、WebUI 刷新、测试断言）在变更后 await 本方法。
   *
   * 不等转入后台的激活：flight 对单个激活至多等到阈值（或它被停机、管理动作接手）为止。
   * 后台激活落定时自己再触发一次重算。
   *
   * **不得在插件 apply / onDispose 内调用**——flight 正等着你返回，
   * 等 flight 结束即互等死锁。
   */
  idle(): Promise<void> {
    if (!this.#reloading && !this.#suspended && this.#queued === null) return Promise.resolve();
    return new Promise(resolve => {
      this.#idleWaiters.push(resolve);
    });
  }

  #settleIdleWaiters(): void {
    if (this.#reloading || this.#suspended || this.#queued !== null) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const w of waiters) w();
  }

  constructor(host: ActivationHost, logger: Logger, disposeTimeoutMs: number, slowMs: number) {
    this.#host = host;
    this.#disposeTimeoutMs = disposeTimeoutMs;
    this.#slowMs = slowMs;
    this.#logger = logger.child('plugins');
    this.#deps = { host, logger: this.#logger, disposeTimeoutMs, spendRetry: (...args) => this.#spendRetry(...args) };

    // 监听服务注册/注销，路由到统一 recompute()。
    // 单飞/挂起/关机的取舍都在 recompute 内部处理（在飞期间排队，关机后跳过）。
    const boundEvents = host.bind(host.root, { events }).events;
    for (const event of ['service:registered', 'service:unregistered'] as const) {
      boundEvents.on(event, name => this.#kick(`${event}:${name}`));
    }
  }

  /** 不等结果地发起一次重算（反应式触发、后台激活落定）；报错点名触发原因，不外泄成未处理拒绝 */
  #kick(why: string): void {
    this.recompute().catch(err => reportQuietly(() => this.#logger.error(`recompute(${why}) 报错:`, err)));
  }

  /**
   * 注册并尝试加载一个插件
   *
   * @param definition 插件定义（definePlugin 的产物）
   * @param config    实例配置，原样生效（入参会被拷贝，调用方之后改它不影响实例）
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 definition.name）
   * @param options.disabled 以禁用态登记，不激活；之后经 enable 启用
   * @returns 口径见 {@link PluginManagerService}：false = 重名、未声明 reusable 却要多实例、定义 / 实例 id 校验失败或配置无法拷贝
   *   （缺 / 空 / 非法 name、uses 非描述符、非法 instanceId；各记一笔 warn，定义里有另一份 core 造的对象时记 error）；
   *   true = 已落账（含注册为 disabled 态），激活是否已发生另看 idle()
   */
  async register(
    definition: PluginDefinition,
    config?: Record<string, unknown>,
    instanceId?: string,
    options?: { disabled?: boolean },
  ): Promise<boolean> {
    const [registered] = await this.registerAll([{ definition, config, instanceId, disabled: options?.disabled }]);
    return registered;
  }

  /**
   * 批量注册：整批同步落账后只重算一次。落账之间没有 await，在飞的重算看不到半批，
   * 依赖方因此在同一次重算里排在它 required 服务的全部提供者之后激活。
   * 返回值与 items 逐项对应，口径同 {@link register}。
   */
  async registerAll(items: ReadonlyArray<PluginRegistration>): Promise<boolean[]> {
    const admitted = items.map(({ definition, config, instanceId, disabled }) =>
      this.#admit(definition, config ?? {}, instanceId, disabled === true),
    );
    // 走统一 recompute：依赖满足则被拓扑正序激活，否则保持 pending。只落账了禁用条目时不必重算
    if (admitted.includes('pending')) await this.recompute();
    return admitted.map(state => state !== false);
  }

  /** 校验并落账一条（同步）。返回落账时的状态；被拒返回 false，拒因已记一笔 */
  #admit(
    definition: PluginDefinition,
    config: Record<string, unknown>,
    instanceId: string | undefined,
    disabled: boolean,
  ): 'pending' | 'disabled' | false {
    // 手写的定义对象（没经 definePlugin）在这里补上同一道校验。失败不抛——六个管理动作统一 Promise<boolean>
    try {
      validateDefinition(definition);
      if (instanceId !== undefined) assertValidInstanceId(instanceId);
    } catch (err) {
      const reason = summarizeError(err);
      // 另一份 core 造的定义是安装问题，不是作者的声明错误：按 error 记，其余仍是 warn
      if (err instanceof ForeignCoreError) this.#logger.error(`插件定义校验失败，拒绝注册: ${reason}`);
      else this.#logger.warn(`插件定义校验失败，拒绝注册: ${reason}`);
      return false;
    }

    const id = instanceId ?? definition.name;

    if (this.#shuttingDown) return this.#refuse('register', id, '处于停机终态');

    // 多实例检查：同一份定义非 reusable 时不允许重复注册
    if (this.#plugins.has(id)) {
      this.#logger.warn(`插件 "${id}" 已注册，跳过`);
      return false;
    }
    if (id !== definition.name && !definition.reusable) {
      this.#logger.warn(`插件 "${definition.name}" 未声明 reusable，不允许多实例注册 "${id}"`);
      return false;
    }

    // 环状引用、读取抛错的 getter 或 Proxy 只让本条注册失败，不让 registerAll 整批拒绝
    let copy: Record<string, unknown>;
    try {
      copy = cloneConfigObject(config);
    } catch (err) {
      this.#logger.warn(`插件 "${id}" 的配置无法拷贝，拒绝注册: ${summarizeError(err)}`);
      return false;
    }
    const state = disabled ? 'disabled' : 'pending';

    this.#plugins.set(id, {
      definition,
      instanceId: id,
      config: copy,
      state,
      required: requiredNames(definition.uses ?? {}),
      optional: optionalNames(definition.uses ?? {}),
    });
    this.#order = undefined;
    this.#logger.info(state === 'disabled' ? `插件已注册(禁用): ${id}` : `插件已注册: ${id}`);
    return state;
  }

  /**
   * 卸载一个插件
   *
   * @returns 口径见 {@link PluginManagerService}：false = 注册表里没有这个实例或已进入停机态；true = 其余（含卸载
   *   已在途时 join 它——返回时该实例已拆卸并离开注册表）
   */
  async unload(instanceId: string): Promise<boolean> {
    const entry = this.#plugins.get(instanceId);
    if (!entry) return this.#refuse('unload', instanceId, '不在注册表');

    // 必须在 disposed-join 之前拒绝，否则清理回调中的 unload 会与停机计划互等。
    if (this.#shuttingDown) return this.#refuse('unload', instanceId, '处于停机终态');

    // 'disposed' 单向化的 unload 侧：已有卸载在途时不再二次
    // retire/emit——join 其拆卸（disposeAsync 幂等）后只确保注册表摘除。删除必须
    // 带恒等卫：并发首个 unload 完成后同 id 可能已重新注册，按名盲删会把无辜的
    // 新 entry 扫出注册表，留下注册表外的活实例。
    if (entry.state === 'disposed') {
      const inflight = entry.activation;
      if (inflight) await inflight.disposeAsync(this.#disposeTimeoutMs);
      if (this.#plugins.get(instanceId) === entry) {
        this.#plugins.delete(instanceId);
        this.#order = undefined;
      }
      return true;
    }

    // dispose 段守卫（与 disable 对齐）：dispose 触发的反应式 recompute
    // 排队到收尾的 recompute，避免在 entry 半卸载态下重算。
    this.#suspendDepth++;
    try {
      // delete 必须留在拆卸**之后**：注册表是 register 与宿主热扫描的查重闸
      // （plugins.has(id)），提前摘除会让同 id 在旧激活 排空期间重新注册，
      // 新旧实例同 instanceId 并存——同名服务重复 provide、偏好按 contextId 二义。
      await this.#retire(entry, 'disposed');
      if (this.#plugins.get(instanceId) === entry) {
        this.#plugins.delete(instanceId);
        this.#order = undefined;
      }
      this.#logger.info(`插件已卸载: ${instanceId}`);
    } finally {
      this.#suspendDepth--;
    }

    // 级联重算：依赖被卸载插件所提供服务的下游需要转 pending
    await this.recompute();
    return true;
  }

  /**
   * 管理动作的 false 分支之一：主体不在注册表、处于 'disposed' 单向终态，或已进入停机态。记 debug
   * 而非 warn——这不是故障，调用方（WebUI 路由、市场卸载流程）常在探测，停机中的请求常见于收尾路径；被政策挡下的
   * 其余分支各自就地 warn。
   */
  #refuse(action: string, instanceId: string, why: string): false {
    this.#logger.debug(`${action}: 插件 "${instanceId}" ${why}`);
    return false;
  }

  /**
   * 管理动作的拆卸：依赖方正在用的提供者要走，依赖方先收尾再关，提供者之后。判据是活插件（已激活，或仍在
   * 初始化：在飞或后台）某个 required 服务此刻解析到的胜者归本批要关的激活所有（传递闭包）；空档里不切到后备
   * 提供者——依赖方对着旧实例收尾，提供者重启后再回到首选。仍在初始化的依赖方同样拆掉重来，否则它 apply 里
   * 拿到的是旧实例。unload / disable / bounce 三者同一路径。
   */
  #retire(entry: PluginRecord, target: PluginState): Promise<void> {
    const services = this.#host.runtime.services;
    const batch = [entry];
    const leaving = new Set<symbol>();
    if (entry.activation) leaving.add(entry.activation.owner);
    const stranded = (name: string): boolean => {
      const owner = services.ownerOf(name);
      return owner !== undefined && leaving.has(owner);
    };
    for (let grew = true; grew; ) {
      grew = false;
      for (const other of this.#plugins.values()) {
        if (!running(other) || !other.activation || batch.includes(other)) continue;
        if (!other.required.some(stranded)) continue;
        batch.push(other);
        leaving.add(other.activation.owner);
        grew = true;
      }
    }
    return retireBatch(batch, item => (item === entry ? target : 'pending'), this.#deps);
  }

  /**
   * 启用一个已禁用的插件
   */
  async enable(instanceId: string): Promise<boolean> {
    const entry = this.#plugins.get(instanceId);
    if (!entry) return this.#refuse('enable', instanceId, '不在注册表');
    if (this.#shuttingDown) return this.#refuse('enable', instanceId, '处于停机终态');
    // 'disposed' 对管理路径单向（见 bounce 内注释）
    if (entry.state === 'disposed') return this.#refuse('enable', instanceId, '处于 disposed 终态');
    if (entry.state !== 'disabled' && entry.state !== 'error') return true; // 已经启用
    // disabled/error 态的 entry 一般 activation 已清（disable 与激活失败都经 retireBatch 清引用；锚在
    // admin-during-activation 测试）。例外是后台激活落定失败：状态先写成 error，回滚在单飞之外进行，
    // 其间转 pending 会被激活侧的「旧激活未清」闸跳过——回滚完成后补跑的重算会把它接上。
    entry.state = 'pending';
    entry.error = undefined;
    entry.retriesLeft = undefined;
    this.#logger.info(`插件已启用: ${instanceId}`);
    await this.recompute();
    return true;
  }

  /**
   * 禁用一个活跃的插件
   */
  async disable(instanceId: string): Promise<boolean> {
    const entry = this.#plugins.get(instanceId);
    if (!entry) return this.#refuse('disable', instanceId, '不在注册表');
    if (this.#shuttingDown) return this.#refuse('disable', instanceId, '处于停机终态');

    // 'disposed' 对管理路径单向（见 bounce 内注释）
    if (entry.state === 'disposed') return this.#refuse('disable', instanceId, '处于 disposed 终态');
    if (entry.state === 'disabled') return true; // 已经禁用

    // dispose 段守卫：期间反应式 recompute 排队到收尾的 recompute
    this.#suspendDepth++;
    try {
      entry.error = undefined;
      await this.#retire(entry, 'disabled');
      // 宽限内没停下来的已转 error，上一条 error 日志已说明
      if (entry.state !== 'error') this.#logger.info(`插件已禁用: ${instanceId}`);
    } finally {
      this.#suspendDepth--;
    }

    await this.recompute();
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
    return [...this.#plugins.values()].map(entry => ({
      name: entry.definition.name,
      instanceId: entry.instanceId,
      displayName: entry.definition.displayName,
      state: entry.state,
      provides: entry.definition.provides?.map(descriptor => descriptor.name),
      reusable: entry.definition.reusable,
      uses: Object.entries<Uses[string]>(entry.definition.uses ?? {}).map(
        ([key, use]): PluginStatusEntry['uses'][number] => {
          const optional = isOptional(use);
          const descriptor = optional ? use.optional : use;
          return {
            key,
            service: descriptor.name,
            kind: optional ? 'optional' : 'required',
          };
        },
      ),
      requiredServices: entry.required.length > 0 ? entry.required : undefined,
      optionalServices: entry.optional.length > 0 ? entry.optional : undefined,
      error: entry.error,
      slow: (entry.activation !== undefined && this.#background.has(entry.activation)) || undefined,
    }));
  }

  /**
   * 获取单个插件
   */
  getPlugin(instanceId: string): PluginEntry | undefined {
    return this.#plugins.get(instanceId);
  }

  /**
   * 更新插件配置：`bounce(instanceId, { config })` 的薄壳，独立成名只为让调用点
   * （WebUI / 配置文件热重载）语义清晰。禁用态只换配置、保持禁用，启用时按新配置激活。
   */
  async updateConfig(instanceId: string, config: Record<string, unknown>): Promise<boolean> {
    return this.bounce(instanceId, { config });
  }

  /**
   * 增量重载单个插件（核心入口）：换上新 config（如有）→ 拆掉当前激活 → 转 pending → 重算后重新激活。
   * `error` 态插件会被重置为 pending 重试。
   *
   * 正在用本插件所提供服务的 required 下游随之重启：先于本插件收尾、关闭，本插件重新激活后按拓扑序
   * 重新激活；optional 依赖经 follow 在换人时交接。不换代码：跑的仍是注册时的那份定义。要换代码走
   * `unload` + `register`。disabled 态只换上新 config、保持禁用（启用时按它激活），不重建。
   *
   * @returns false 表示找不到 entry、disabled 态且不带 config、'disposed' 终态、停机进行中（拒绝重建），或新 config 无法拷贝（保留旧配置）。
   */
  async bounce(instanceId: string, opts?: { config?: Record<string, unknown> }): Promise<boolean> {
    const entry = this.#plugins.get(instanceId);
    if (!entry) return this.#refuse('bounce', instanceId, '不在注册表');
    // 'disposed' 对管理路径单向（含卸载在途与停机后的遗留终态两种情形）：
    // unload 写入终态与从注册表摘除之间隔着 retire 的微任务（即使无激活可拆，
    // await 也让出）——此窗口内把它覆写回 'pending' 会重新武装 entry，激活出
    // 一个注册表外的永生孤儿实例；停机后的遗留终态同理不得复活。
    if (entry.state === 'disposed') return this.#refuse('bounce', instanceId, '处于 disposed 终态');
    if (this.#shuttingDown) return this.#refuse('bounce', instanceId, '停机中不重建');
    const newConfig = opts?.config;
    if (newConfig) {
      // 入参可能是调用方还要继续用的活对象（WebUI PUT / config-sync 浅铺开的 payload）。
      // entry 持有自己的拷贝：插件经内置 config 就地改嵌套不得写穿调用方的对象。拷贝失败时保留旧配置并拒绝
      try {
        entry.config = cloneConfigObject(newConfig);
      } catch (err) {
        this.#logger.warn(`bounce: 插件 "${instanceId}" 的新配置无法拷贝，保留旧配置: ${summarizeError(err)}`);
        return false;
      }
    }
    if (entry.state === 'disabled') {
      if (newConfig) return true;
      this.#logger.warn(`bounce: 插件 "${instanceId}" 处于 disabled 态，跳过`);
      return false;
    }

    // dispose 段守卫（与 disable / unload 对齐）：dispose 触发的反应式
    // recompute 不能在 entry 尚未转 pending 时跑——会把半 bounce 态误判。
    this.#suspendDepth++;
    try {
      entry.error = undefined;
      entry.retriesLeft = undefined;
      await this.#retire(entry, 'pending');
    } finally {
      this.#suspendDepth--;
    }
    await this.recompute();
    return true;
  }

  // 多实例机制是 register 带 instanceId + reusable 校验；配置键 `name:suffix` 的自动登记在宿主。

  /**
   * 全局停机：全部 active 插件与宿主的根激活进同一张关停计划——消费者先于它依赖的提供者关闭，
   * 下游的收尾还能把数据交给下层（见 orchestration/close-plan.ts）。
   *
   * 停机置位后服务上下线不再触发反应式重算，本方法是关机时唯一的拆卸编排者。
   */
  async stopAll(): Promise<void> {
    await this.recompute('shutdown');
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
    if (this.#shuttingDown && kind !== 'shutdown') {
      // 关机已置位时非关机请求无意义；但若队列里躺着一个被挂起的 shutdown
      // （stop() 与手动 dispose 段竞态），借这次调用把它接过来跑完。
      if (this.#queued !== 'shutdown') {
        // 早退也要结算 idle 等待者：管理段收尾的 recompute 走到这里时状态机已静置，
        // 不结算的话此前压进来的 idle() 永不落定（结算自己会核对三条静置守卫）
        this.#settleIdleWaiters();
        return;
      }
    }
    if (kind === 'shutdown') this.#shuttingDown = true;
    if (this.#queued === null || kind === 'shutdown') this.#queued = kind;

    // 单飞 + 排队（修 lost wakeup）：在飞期间/手动 dispose 段的请求合并排队，
    // 由在飞 run 收尾时补跑或 dispose 段收尾的 recompute 消化。注意这里必须
    // 立即返回而不能把在飞 promise 交还调用方——若调用方恰在某插件 apply()
    // 内同步调用（在飞 run 正 await 它），等待在飞 promise 会自我死锁。
    if (this.#reloading || this.#suspended) {
      return;
    }

    this.#reloading = true;
    try {
      while (this.#queued) {
        const current = this.#queued;
        this.#queued = null;
        await this.#recomputeOnce(current);
      }
    } finally {
      this.#reloading = false;
      this.#settleIdleWaiters();
    }
  }

  /**
   * 按图规模取 2N+8（+8 为小图垫底），不暴露调优旋钮：重算的轮数上限，也是初始化期 required 缺失的重试额度。
   * 每次现算而非入口冻结：注册期 recompute 排队立即返回，后续 app.plugin() 会在 `#recomputeOnce` 在飞时追加
   * entry（每轮快照重取），上限须随图同步增长，否则合法的增量注册流会被按旧规模误判为振荡。
   */
  #maxRounds(): number {
    return this.#plugins.size * 2 + 8;
  }

  /**
   * 初始化期 required 缺失的自动重试预算。两条路径记同一本账：激活时 required 绑定抛不可用，后台激活的 required
   * 依赖下线被拆。按条目跨重算累计（`#queued` 补跑、落定后补的重算都不重置），首次按当时的 {@link #maxRounds}
   * 取额；激活成功、enable、bounce 时清零。返回这次拆卸的目标态：未用尽回 pending，用尽转 error、不再自动重试，
   * 说明里点名这次缺的服务 missing。在拆卸之前调用（写终态的是随后的 retireBatch），日志经 reportQuietly，不抛。
   */
  #spendRetry(entry: PluginRecord, missing: string): 'pending' | 'error' {
    entry.retriesLeft = (entry.retriesLeft ?? this.#maxRounds()) - 1;
    if (entry.retriesLeft > 0) return 'pending';
    entry.error = `初始化期间 required 依赖反复缺失（最后一次缺 "${missing}"），自动重试未收敛，已停止；enable 或 bounce 后重试`;
    reportQuietly(() => this.#logger.error(`插件 "${entry.instanceId}" ${entry.error}`));
    return 'error';
  }

  /** 单次完整重算：fixed-point 状态转移 + （非关机）plugins:changed 通知 */
  async #recomputeOnce(kind: RecomputeKind): Promise<void> {
    // 停机：全部插件激活与宿主的根激活进同一张计划（无依赖关系时后注册的先关）
    if (kind === 'shutdown') {
      const live = [...this.#plugins.values()].filter(entry => entry.activation !== undefined).reverse();
      await retireBatch(live, 'disposed', this.#deps, {
        emitUnloaded: false,
        planRoot: this.#host.root,
        settle: this.#shutdownSettle,
      });
      return;
    }

    let changed = true;
    let rounds = 0;
    // 普通依赖级联的拆除波、激活波至多 {@link #maxRounds} 轮，超出即点名振荡。初始化期间 required 再次消失
    // 不属于单调级联，它的自动重试另按条目计预算（{@link #spendRetry}），`#queued` 补跑重置本函数的轮数也放不开它。
    let lastRoundFlips: string[] = [];

    // 停机后不再做普通状态转移：拆卸全归停机计划，这里再拆已冻进计划的激活会与计划互等
    converge: while (changed && rounds < this.#maxRounds() && !this.#shuttingDown) {
      changed = false;
      rounds++;
      lastRoundFlips = [];

      this.#order ??= topoSortByDeps([...this.#plugins.values()], this.#logger);
      const order = this.#order;

      // Phase A: 本轮目标不再是 active 的，成批关闭——它们之间的次序由关停编排按实际依赖定。
      // 后台激活同样看：required 不在了，它 apply 里拿到的已是旧实例（本 flight 此刻没有在飞的激活，
      // activating 即后台），拆它记入重试预算
      const retiring = new Map<PluginRecord, PluginState>();
      for (const entry of [...order].reverse()) {
        if (!running(entry)) continue;
        if (requiredSatisfied(entry, this.#host.runtime.services)) continue;
        const unmet = entry.required.find(name => this.#host.runtime.services.get(name) === undefined)!;
        this.#logger.info(`依赖 "${unmet}" 不可用，停用插件: ${entry.instanceId}`);
        retiring.set(entry, entry.state === 'activating' ? this.#spendRetry(entry, unmet) : 'pending');
        lastRoundFlips.push(entry.instanceId);
      }
      if (retiring.size > 0) {
        await retireBatch([...retiring.keys()], e => retiring.get(e)!, this.#deps);
        changed = true;
      }

      // Phase B: 正向遍历，激活目标 active 的 pending entry
      for (const entry of order) {
        // 已进入停机：不再启动新的实例
        if (this.#shuttingDown) break converge;
        // 旧激活仍在拆卸中（bounce 先置 'pending'、后异步拆旧激活，拆完才清 entry.activation）：此刻重新激活
        // 会让新旧实例同 instanceId 并存——同名服务重复 provide、偏好按 contextId 二义。跳过本轮，等管理路径
        // 收尾后的 recompute 重新调度
        if (entry.state !== 'pending' || entry.activation) continue;
        if (!requiredSatisfied(entry, this.#host.runtime.services)) continue;
        // required 胜者已进关闭计划（如被管理动作接手、flight 已不再等的在飞激活）：激活到它上面拿到的是正在
        // 关闭的实例。等它关完、服务下线触发重算再判定
        if (entry.required.some(name => this.#host.closing(this.#host.runtime.services.ownerOf(name)!))) continue;
        // 'retry'：required 缺失、预算未用尽，已回到 pending，下一轮重新观察依赖
        if ((await this.#activate(entry)) === 'retry' || (entry.state as PluginState) === 'active') {
          changed = true;
          lastRoundFlips.push(entry.instanceId);
        }
      }
    }

    if (changed && rounds >= this.#maxRounds()) {
      // 静态 required 环由 topoSortByDeps 检出并另行告警；到这里仍在翻转的
      // 状态变化已超出本轮收敛上限。点名末轮仍在翻转的插件——矛盾对必在其中。
      // 每处 changed = true 都登记了翻转者，走到这里名单必不为空。
      this.#logger.warn(
        `recompute ${rounds} 轮未收敛（上限 ${this.#maxRounds()} = 2×插件数+8），` +
          `疑似插件间状态振荡。最后一轮仍在翻转: ${lastRoundFlips.join(', ')}`,
      );
    }

    this.#host.runtime.notify('plugins:changed');
  }

  /**
   * 激活一个条目，flight 至多等到阈值：超过仍未完成就转入后台，flight 接着处理后面的插件；停机或管理动作
   * 接手（signal 已断）时也不再等，拆卸方按宽限处理。flight 不再等的激活落定后补一次重算（成功、失败转 error、
   * 回到 pending 都未必有服务事件触发重算）。
   *
   * 一个 abort 监听器、一个只触发一次的阈值定时器看到落定或 abort 为止：到点转入后台、记一条 warn，此后不再提醒，
   * 后台状态经 getStatus 的 slow 查看。不留周期定时器，没调 stop 的嵌入式宿主至多被它拖到阈值到点才退出。
   */
  #activate(entry: PluginRecord): Promise<'retry' | undefined> {
    const landing = activatePlugin(entry, this.#deps);
    // 同步段已挂上本次激活；清引用最早在一个微任务之后
    const activation = entry.activation!;
    const { signal } = activation.resources;
    // 没有待落定的 apply（同步段里就失败了，正在回滚）：照旧等它收尾
    if (!activation.resources.initializing) return landing;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const letGo = (): void => {
        resolve(undefined);
        landing
          .finally(() => this.#kick(`${entry.instanceId} 激活落定`))
          .catch(err => reportQuietly(() => this.#logger.error(`插件 "${entry.instanceId}" 激活收尾报错:`, err)));
      };
      const unwatch = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.#background.delete(activation);
      };
      // 只看 apply 在飞的阶段：apply 已落定时，abort 与到点都来自它自己的收尾（失败回滚，有界），照旧等落定
      const onAbort = (): void => {
        if (!activation.resources.initializing) return;
        if (!this.#background.has(activation)) letGo(); // 已转入后台的早已放开 flight
        unwatch();
      };
      // 落定（含拒绝）原样交给 flight（已放开时无效果），并停止看守
      landing.then(resolve, reject);
      landing.then(unwatch, unwatch);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.#slowMs > 0) {
        timer = setTimeout(() => {
          if (!activation.resources.initializing) return;
          letGo();
          this.#toBackground(entry, activation);
        }, this.#slowMs);
      }
    });
  }

  /** 转入后台：它登记的服务在激活完成前不对依赖方开放（依赖方保持 pending），已对外的这里撤下 */
  #toBackground(entry: PluginRecord, activation: Activation): void {
    this.#background.add(activation);
    const runtime = this.#host.runtime;
    for (const name of runtime.services.hold(activation.owner)) runtime.notify('service:unregistered', name);
    reportQuietly(() =>
      this.#logger.warn(
        `插件 "${entry.instanceId}" 激活超过 ${this.#slowMs}ms 仍未完成，转入后台继续；它提供的服务在激活完成前不对依赖方开放`,
      ),
    );
  }
}

/** 有激活在跑、目标仍是 active 的条目：已激活的，与仍在初始化（在飞或后台）的 */
function running(entry: PluginRecord): boolean {
  return entry.state === 'active' || entry.state === 'activating';
}
