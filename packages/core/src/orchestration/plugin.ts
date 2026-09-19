import type { PluginManagerService, PluginStatusEntry } from '../types/index.js';
import {
  type PluginEntry,
  type PluginModule,
  type PluginState,
  parseInstanceId,
  type RecomputeReason,
} from '../types/plugin.js';

import { reportQuietly } from '../kernel/disposable-chain.js';

import { normalizeDependency } from '../primitives/services.js';

import type { Context } from '../context/context.js';
import type { Logger } from '../context/logger.js';

import {
  type ActivationDeps,
  activatePlugin,
  computeTargetState,
  retireAll,
  retireEntry,
} from './plugin-activation.js';
import { evictDownstreamConsumers, topoSortByDeps } from './plugin-topology.js';

export type { PluginEntry, PluginModule, PluginState };
// 类型与纯辅助 re-export，保留同名旧导入路径
export { parseInstanceId };

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
export class PluginManager {
  private plugins = new Map<string, PluginEntry>();
  private rootCtx: Context;
  private logger: Logger;
  /** 交给编排层自由函数（activatePlugin / retireEntry / evictDownstreamConsumers）的宿主注入件，构造一次 */
  private readonly deps: ActivationDeps;
  /** recompute 单飞标志：true 表示一次 recompute（含排队补跑）正在进行 */
  private reloading = false;
  /**
   * 手动 dispose 段计数器：disable / unload / bounce 在「dispose 旧
   * ctx → 改 entry.state」这段不可分割的状态变更期间 +1。期间 dispose 触发的
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
   * 被推迟的重算批次。服务下线名去重保留，供首轮判断 optional bounce；
   * 普通状态变化合并处理，shutdown 覆盖整批。批次消费前先摘下，避免
   * 执行期间的新变化混入正在处理的服务集合。
   */
  private queuedBatch: { reason: RecomputeReason; serviceDowns: Set<string> } | null = null;
  /**
   * 全局关机标志。app.stop() 在 dispose 前置位，所有反应式级联（service:registered/
   * unregistered → checkPending/Active）都会因此跳过——避免「正在关机还去 bounce
   * 一个永远不会被重新激活的插件」这种无意义噪声，也避免下游插件 dispose 中
   * 试图 register 命令 / 监听服务等动作触发误重入。
   */
  private shuttingDown = false;

  /** 是否正在关机——供插件 dispose hook 短路用 */
  isShuttingDown(): boolean {
    return this.shuttingDown;
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
    if (!this.reloading && !this.suspended && this.queuedBatch === null) return Promise.resolve();
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  private settleIdleWaiters(): void {
    if (this.reloading || this.suspended || this.queuedBatch !== null) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  constructor(
    rootCtx: Context,
    logger: Logger,
    /** 单个异步清理项的等待上限（毫秒；0=不设限），由 App 从 AppOptions 注入 */
    private readonly disposeTimeoutMs?: number,
  ) {
    this.rootCtx = rootCtx;
    this.logger = logger.child('plugins');
    this.deps = { rootCtx, logger: this.logger, disposeTimeoutMs };

    // 监听服务注册/注销，路由到统一 recompute()。
    // 单飞/挂起/关机的取舍都在 recompute 内部处理（在飞期间排队，关机后跳过）。
    rootCtx.on('service:registered', name => {
      this.recompute({ type: 'service-up', service: name }).catch(err =>
        reportQuietly(() => this.logger.error(`recompute(service-up:${name}) 报错:`, err)),
      );
    });
    rootCtx.on('service:unregistered', name => {
      this.recompute({ type: 'service-down', service: name }).catch(err =>
        reportQuietly(() => this.logger.error(`recompute(service-down:${name}) 报错:`, err)),
      );
    });
  }

  /**
   * 注册并尝试加载一个插件
   *
   * @param module    插件模块
   * @param config    插件配置
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 module.name）
   * @returns 口径见 {@link PluginManagerService}：false = 重名，或未声明 reusable 却要多实例（各记一笔 warn）；
   *   true = 已落账（含注册为 disabled 态），激活是否已发生另看 idle()
   */
  async register(module: PluginModule, config: Record<string, unknown> = {}, instanceId?: string): Promise<boolean> {
    const id = instanceId ?? module.name;

    // 多实例检查：同一 module 非 reusable 时不允许重复注册
    if (this.plugins.has(id)) {
      this.logger.warn(`插件 "${id}" 已注册，跳过`);
      return false;
    }
    if (id !== module.name && !module.reusable) {
      this.logger.warn(`插件 "${module.name}" 未声明 reusable，不允许多实例注册 "${id}"`);
      return false;
    }

    const inject = module.inject ?? {};
    const requiredDeps = (inject.required ?? []).map(normalizeDependency);
    const optionalDeps = (inject.optional ?? []).map(normalizeDependency);

    // 检查是否被配置禁用（按 instanceId 检查）
    const isDisabled = this.rootCtx.config.isPluginDisabled(id);

    const entry: PluginEntry = {
      module,
      instanceId: id,
      config,
      state: isDisabled ? 'disabled' : 'pending',
      requiredDeps,
      optionalDeps,
    };

    this.plugins.set(id, entry);

    if (isDisabled) {
      this.logger.info(`插件已注册(禁用): ${id}`);
    } else {
      this.logger.info(`插件已注册: ${id}`);
      // 走统一 recompute：依赖满足则被拓扑正序激活，否则保持 pending
      await this.recompute({ type: 'plugin-state-changed' });
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

    // 'disposed' 单向化的 unload 侧：已有卸载在途（或停机遗留终态）时不再二次
    // retire/emit——join 其拆卸（disposeAsync 幂等）后只确保注册表摘除。删除必须
    // 带恒等卫：并发首个 unload 完成后同 id 可能已重新注册，按名盲删会把无辜的
    // 新 entry 扫出注册表，留下注册表外的活实例。
    if (entry.state === 'disposed') {
      const inflight = entry.context;
      if (inflight) await inflight.disposeAsync(this.disposeTimeoutMs);
      if (this.plugins.get(instanceId) === entry) this.plugins.delete(instanceId);
      return true;
    }

    // dispose 段守卫（与 disable 对齐）：dispose 触发的反应式 recompute
    // 排队到收尾的 softReload，避免在 entry 半卸载态下重算。
    this.suspendDepth++;
    try {
      // delete 必须留在拆卸**之后**：注册表是 register/rescan 的查重闸
      // （plugins.has(id)），提前摘除会让同 id 在旧 ctx 排空期间重新注册，
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

  private retire(entry: PluginEntry, target: PluginState, opts?: { emitUnloaded?: boolean }): Promise<void> {
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
    // 依赖不变量：disabled/error 态的 entry 必然 context 已清（disable 与激活失败
    // 都经 retireEntry 清引用；锚在 admin-during-activation 测试）——否则此处转
    // pending 后会被激活侧的「旧 ctx 未清」闸永久跳过。
    entry.state = 'pending';
    entry.error = undefined;
    this.rootCtx.config.setPluginEnabled(instanceId, true);
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

    if (entry.module.core) {
      this.logger.warn(`核心插件 "${instanceId}" 不能被禁用`);
      return false;
    }

    // 'disposed' 对管理路径单向（见 bounce 内注释）
    if (entry.state === 'disposed') return this.refuse('disable', instanceId, '处于 disposed 终态');
    if (entry.state === 'disabled') return true; // 已经禁用

    // dispose 段守卫：期间反应式 recompute 排队到收尾的 softReload
    this.suspendDepth++;
    try {
      this.rootCtx.config.setPluginEnabled(instanceId, false);
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
    // 状态摘要只含内核事实。配置详情（config / configSchema）与
    // WebUI 展示概念（subsystem/extends）由消费者经 getPlugin(instanceId) 从
    // entry.config / entry.module 读取——core 状态契约不携带。
    return [...this.plugins.entries()].map(([, entry]) => {
      return {
        name: entry.module.name,
        instanceId: entry.instanceId,
        displayName: entry.module.displayName,
        state: entry.state,
        provides: entry.module.provides,
        core: entry.module.core,
        reusable: entry.module.reusable,
        requiredServices: entry.requiredDeps.length > 0 ? entry.requiredDeps.map(d => d.service) : undefined,
        optionalServices: entry.optionalDeps.length > 0 ? entry.optionalDeps.map(d => d.service) : undefined,
        error: entry.error,
      };
    });
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
   * 增量重载单个插件（核心入口）：
   *
   * 1. 持久化新 config（如有）+ dispose 旧 ctx + 转 pending + softReload 重新激活。
   *    下游消费者默认不会被级联 bounce，除非显式声明 `requiresBounceOnDepChange: true`
   *    （见 evictDownstreamConsumers）。
   * 2. `error` 态插件会被重置为 pending 重试 apply。
   *
   * 不换模块：跑的仍是注册时的那份代码。要换代码走 `unload` + `register`。
   *
   * @returns false 表示找不到 entry 或处于 disabled 态（拒绝 bounce）。
   */
  async bounce(instanceId: string, opts?: { config?: Record<string, unknown> }): Promise<boolean> {
    const entry = this.plugins.get(instanceId);
    if (!entry) return this.refuse('bounce', instanceId, '不在注册表');
    if (entry.state === 'disabled') {
      this.logger.warn(`bounce: 插件 "${instanceId}" 处于 disabled 态，跳过`);
      return false;
    }
    // 'disposed' 对管理路径单向（含卸载在途与停机后的遗留终态两种情形）：
    // unload 写入终态与从注册表摘除之间隔着 retire 的微任务（即使无 ctx 可拆，
    // await 也让出）——此窗口内把它覆写回 'pending' 会重新武装 entry，激活出
    // 一个注册表外的永生孤儿实例；停机后覆写则会把插件误写进持久化禁用清单。
    if (entry.state === 'disposed') return this.refuse('bounce', instanceId, '处于 disposed 终态');
    // 旧调用方（JS 无类型约束）传 module 期望换码：拒绝而非静默跑旧代码，否则调用方以为换成功了。
    if (opts && 'module' in opts) {
      this.logger.warn(`bounce: 插件 "${instanceId}" 不再支持 module 热替换，改走 unload + register`);
      return false;
    }

    const newConfig = opts?.config;
    if (newConfig) {
      entry.config = newConfig;
      this.rootCtx.config.setPluginConfig(instanceId, newConfig);
    }

    // dispose 段守卫（与 disable / unload 对齐）：dispose 触发的反应式
    // recompute 不能在 entry 尚未转 pending 时跑——会把半 bounce 态误判。
    this.suspendDepth++;
    try {
      // 唯一不走 retireEntry 的拆卸点（见其 JSDoc）：写终态与拆卸之间要插入
      // evictDownstreamConsumers，且该 await 窗口要求状态已先落——塞进 helper
      // 需要回调钩子，不值得。本块内联复刻 helper 的四步顺序，勿改动次序。
      entry.state = 'pending';
      entry.error = undefined;
      // ctx 先捕获：evict 的 await 期间并发管理操作可能已拆掉并清空
      // entry.context，重读会 TypeError 并越过收尾的 softReload（queuedBatch
      // 悬挂 → idle() 永不落定）。disposeAsync 幂等，重复调用只会等在飞拆卸。
      const ctx = entry.context;
      if (ctx) {
        await evictDownstreamConsumers(entry, this.plugins, this.deps);
        try {
          await ctx.disposeAsync(this.disposeTimeoutMs);
        } catch (err) {
          this.logger.error(`插件 "${instanceId}" dispose 抛错:`, err);
        }
        if (entry.context === ctx) entry.context = undefined;
        this.rootCtx.emitQuietly('plugin:unloaded', instanceId);
      }
    } finally {
      this.suspendDepth--;
    }
    await this.softReload();
    return true;
  }

  // 多实例的配置文件编排属管理面（消费者基于公开的 register / unload / config API 组合实现）；
  // 内核只保留多实例机制本身（register 带 instanceId + reusable 校验）。

  /**
   * 全局停机：按依赖拓扑逆序 dispose 所有 active 插件。
   *
   * 顺序原则：「消费者先关，提供者后关」——一个插件若 require/optional 依赖另一个
   * 插件 provides 的服务，则前者 dispose 必须先于后者。这样下游插件的 dispose hook
   * 还能安全地访问其依赖的服务（如把待持久化数据冲到 storage、把订阅从 gateway 摘掉）。
   *
   * 实现是 Kahn 风格 BFS：
   * 1. 把 active 插件构成「依赖图」边：consumer → provider（基于 module.provides）
   * 2. 反复挑出 in-degree==0 的节点（没人依赖它们 = 处于拓扑顶端 = 应当先 dispose）
   * 3. dispose 后从图中移除，刷新 in-degree
   * 4. 若残留环（不应该发生，softReload 期间会警告），按声明顺序 dispose 兜底
   *
   * 此方法预设 `shuttingDown=true`，service:unregistered 不再触发反应式 bounce；
   * 因此本方法是**关机时唯一**的 dispose 编排者，不与级联机制竞争。
   */
  async stopAll(): Promise<void> {
    await this.recompute({ type: 'shutdown' });
  }

  /**
   * 软重载（薄壳）：把"插件状态需要重算"统一委托给 recompute()。
   *
   * 历史上 softReload / stopAll / checkActivePlugins / checkPendingPlugins 是四
   * 条独立路径，每条都自己判断"哪些插件该跑、按什么顺序"。逻辑漂移导致 stopAll
   * 之外的三条路径在"同一轮多个插件同时变状态"时无法保证消费者先于提供者关闭，
   * 瞬态会出现 dispose hook 访问已失效服务的情况。现在四条路径共用 recompute()。
   */
  async softReload(): Promise<void> {
    await this.recompute({ type: 'plugin-state-changed' });
  }

  // ----- 单一状态转移入口 -----

  /**
   * 重算所有插件的目标态并按依赖拓扑序应用转移。
   *
   * 这是 PluginManager 唯一的状态变更入口。
   *
   * 算法：
   * 1. 反应式 reason 决定"是否走完整 fixed-point + 是否触发 optional bounce"；
   *    shutdown 走单向 down 路径，其它走 fixed-point。
   * 2. 每轮先按依赖正序（提供者→消费者）做拓扑排序。
   * 3. Phase A：反向遍历，把"目标不再 active"的 entry 一并 dispose
   *    （本轮内消费者先关、提供者后关）。
   * 4. Phase B（非 shutdown）：正向遍历，激活"目标 active 且依赖满足"的 pending entry
   *    （提供者先起、消费者后起）。
   * 5. 若本轮有变动则继续下一轮，直到稳定或达到 maxRounds。
   * 6. 非 shutdown 时发出 plugins:changed。
   *
   * Aalis 直接用"服务在不在容器里"做判断（capability 匹配层已于 0.5.0
   * 删除）—— 表达力等价、复杂度更低。
   */
  async recompute(reason: RecomputeReason): Promise<void> {
    if (this.shuttingDown && reason.type !== 'shutdown') {
      // 关机已置位时非关机请求无意义；但若队列里躺着一个被挂起的 shutdown
      // （stop() 与手动 dispose 段竞态），借这次调用把它接过来跑完。
      if (this.queuedBatch?.reason.type !== 'shutdown') return;
    }
    if (reason.type === 'shutdown') this.shuttingDown = true;

    // 先合并再启动：手动 dispose 收尾的 softReload 必须与其间积累的
    // service-down 同批处理，不能先重激活一遍、再重放旧下线原因。
    if (!this.queuedBatch || reason.type === 'shutdown') {
      this.queuedBatch = { reason, serviceDowns: new Set() };
    }
    if (reason.type === 'service-down' && this.queuedBatch.reason.type !== 'shutdown') {
      this.queuedBatch.serviceDowns.add(reason.service);
    }

    // 单飞 + 排队（修 lost wakeup）：在飞期间/手动 dispose 段的请求合并排队，
    // 由在飞 run 收尾时补跑或 dispose 段收尾的 softReload 消化。注意这里必须
    // 立即返回而不能把在飞 promise 交还调用方——若调用方恰在某插件 apply()
    // 内同步调用（在飞 run 正 await 它），等待在飞 promise 会自我死锁。
    if (this.reloading || this.suspended) {
      return;
    }

    this.reloading = true;
    try {
      while (this.queuedBatch) {
        const current = this.queuedBatch;
        this.queuedBatch = null;
        await this.recomputeOnce(current.reason, current.serviceDowns);
      }
    } finally {
      this.reloading = false;
      this.settleIdleWaiters();
    }
  }

  /** 单次完整重算：fixed-point 状态转移 + （非关机）plugins:changed 通知 */
  private async recomputeOnce(reason: RecomputeReason, serviceDowns: Set<string>): Promise<void> {
    let currentReason = reason;
    let changed = true;
    let rounds = 0;
    // 收敛上限从图规模推导，不是调优旋钮。紧界推导：单个插件每次 recomputeOnce
    // 至多翻转 2 次。第 2 轮起 currentReason 退化为 plugin-state-changed（见下方），
    // 此时目标态 =「required 依赖齐则 active，否则 pending」，是服务可用集的单调
    // 函数；依赖图无环（静态 required 环由 topoSortByDeps 检出，且只致停滞不致振荡），
    // 故拆除波与激活波各自单调单向推进，每插件至多翻 1 次。唯一的第 2 次翻转来自
    // 首轮 optional bounce（active→pending→再 active），而 bounce 仅第 1 轮生效、
    // 不重复（其下游子树同样至多随之翻 2 次，仍 ≤2）。因此总翻转 ≤2N ⇒ 轮数 ≤2N：
    // 2N 是紧的最坏界而非余量，+8 只为小 N 垫底。真振荡（激活条件互相矛盾）翻转
    // 无界，必越过任何线性界——上限把"无限挂死"换成"有界放弃 + 点名"。
    // 每轮现算而非入口冻结：注册期 recompute 排队立即返回，后续 app.plugin() 会在
    // 本 recomputeOnce 在飞时追加 entry（每轮快照重取），上限须随图同步增长，否则
    // 合法的增量注册流会被按旧规模误判为振荡。
    const maxRounds = (): number => this.plugins.size * 2 + 8;
    let lastRoundFlips: string[] = [];

    converge: while (changed && rounds < maxRounds()) {
      changed = false;
      rounds++;
      lastRoundFlips = [];

      const entries = [...this.plugins.values()];
      const order = topoSortByDeps(entries, this.logger);

      // 停机：整批激活（含子模块）统一编排关闭顺序，不走逐个 retire
      if (currentReason.type === 'shutdown') {
        const active = entries.filter(entry => entry.state === 'active');
        // 无依赖关系时后注册的先关
        await retireAll(active.reverse(), this.deps);
        break;
      }

      // Phase A: 反向遍历，关掉目标不是 active 的 active entry（运行期级联：按声明拓扑的逆序）
      for (const entry of [...order].reverse()) {
        if (entry.state !== 'active') continue;
        const target = computeTargetState(entry, currentReason, this.rootCtx, serviceDowns);
        if (target === 'active') continue;

        // 日志：区分 required 不满 / optional 下线
        const unmet = entry.requiredDeps.find(d => this.rootCtx.getService(d.service) === undefined);
        if (unmet) {
          this.logger.info(`依赖 "${unmet.service}" 不可用，停用插件: ${entry.instanceId}`);
        } else {
          // 被动级联降级（依赖服务下线 → 转 pending 等待重新满足），
          // 区别于 bounce() 的主动重载，日志措辞不用「bounce」一词。
          const missing = entry.optionalDeps.find(
            d => serviceDowns.has(d.service) && this.rootCtx.getService(d.service) === undefined,
          );
          if (missing) {
            this.logger.info(`依赖服务 "${missing.service}" 已下线，降级插件为待激活: ${entry.instanceId}`);
          }
        }

        await this.retire(entry, 'pending');
        changed = true;
        lastRoundFlips.push(entry.instanceId);
      }

      // Phase B: 正向遍历，激活目标 active 的 pending entry
      for (const entry of order) {
        // 先消费等待中的下线/停机批次，再启动新的实例。否则它按最新服务
        // 状态初始化后，又会被此前排队的旧下线通知重复重建。
        if (this.queuedBatch?.serviceDowns.size || this.queuedBatch?.reason.type === 'shutdown') break converge;
        if (entry.state !== 'pending') continue;
        const target = computeTargetState(entry, currentReason, this.rootCtx, serviceDowns);
        if (target !== 'active') continue;
        await activatePlugin(entry, this.deps);
        if ((entry.state as PluginState) === 'active') {
          changed = true;
          lastRoundFlips.push(entry.instanceId);
        }
      }

      // service-up / service-down 的"特殊语义"只在第一轮生效（避免无限 bounce）；
      // 第二轮起退化为普通的 plugin-state-changed 重算。
      if (currentReason.type === 'service-up' || currentReason.type === 'service-down') {
        currentReason = { type: 'plugin-state-changed' };
      }
      serviceDowns.clear();
    }

    if (rounds >= maxRounds()) {
      // 静态 required 环由 topoSortByDeps 检出并另行告警；能撞到这里的只有
      // 状态振荡（插件间激活条件互相矛盾，状态在轮次间来回翻）。点名末轮
      // 仍在翻转的插件——矛盾对必在其中。
      this.logger.warn(
        `recompute ${rounds} 轮未收敛（上限 ${maxRounds()} = 2×插件数+8），` +
          `疑似插件间状态振荡。最后一轮仍在翻转: ${lastRoundFlips.join(', ') || '(无记录)'}`,
      );
    }

    if (reason.type === 'shutdown') return;

    this.rootCtx.emitQuietly('plugins:changed');
  }
}
