import type { Context } from './context.js';
import type { Logger } from './logger.js';
import { activatePlugin, computeTargetState } from './plugin-activation.js';
import { evictDownstreamConsumers, topoSortByDeps } from './plugin-topology.js';
import { normalizeDependency } from './services.js';
import type { PluginStatusEntry } from './types/index.js';
import {
  type PluginEntry,
  type PluginModule,
  type PluginState,
  parseInstanceId,
  type RecomputeReason,
} from './types/plugin.js';

export type { PluginEntry, PluginModule, PluginState };
// 类型与纯辅助 re-export，保留同名旧导入路径
export { parseInstanceId };

/**
 * 插件管理器
 *
 * 负责:
 * - 注册/加载/卸载插件
 * - 依赖追踪 (required + optional, 支持 capability 匹配)
 * - 当所需服务就绪时自动激活插件
 * - 当所需服务移除时自动停用插件
 * - 插件启用/禁用控制
 */
export class PluginManager {
  private plugins = new Map<string, PluginEntry>();
  private rootCtx: Context;
  private logger: Logger;
  /** recompute 单飞标志：true 表示一次 recompute（含排队补跑）正在进行 */
  private reloading = false;
  /**
   * 手动 dispose 段计数器：disablePlugin / unload / bouncePlugin 在「dispose 旧
   * ctx → 改 entry.state」这段不可分割的状态变更期间 +1。期间 dispose 触发的
   * service:unregistered 反应式 recompute 会被**排队**（而非立即跑——那会看到
   * 半成品状态，比如把正在禁用的插件重新激活），由这些方法收尾的 softReload 统一消化。
   *
   * 用计数器而非布尔：dispose hook 内可能同步级联调用 disablePlugin/unload（级联
   * 禁用），嵌套时内层的 finally 若复位布尔会过早解除外层的挂起态——计数器确保
   * 只有最外层退出（归零）才解除。
   */
  private suspendDepth = 0;
  private get suspended(): boolean {
    return this.suspendDepth > 0;
  }
  /**
   * 被推迟的 recompute 请求（修 lost wakeup：在飞期间到达的请求不再被丢弃）。
   * 多个请求合并为一——除 shutdown 保留原 reason 外统一退化为
   * plugin-state-changed（service-up/down 的特殊语义本就只在第一轮生效）。
   */
  private queuedReason: RecomputeReason | null = null;
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
   * ⚠． **不得在插件 apply / onDispose 内调用**——flight 正等着你返回，
   *    等 flight 结束即互等死锁。
   */
  idle(): Promise<void> {
    if (!this.reloading && !this.suspended && this.queuedReason === null) return Promise.resolve();
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  private settleIdleWaiters(): void {
    if (this.reloading || this.suspended || this.queuedReason !== null) return;
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

    // 监听服务注册/注销，路由到统一 recompute()。
    // 单飞/挂起/关机的取舍都在 recompute 内部处理（在飞期间排队，关机后跳过）。
    rootCtx.on('service:registered', name => {
      this.recompute({ type: 'service-up', service: name }).catch(err => {
        this.logger.error(`recompute(service-up:${name}) 报错: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    rootCtx.on('service:unregistered', name => {
      this.recompute({ type: 'service-down', service: name }).catch(err => {
        this.logger.error(`recompute(service-down:${name}) 报错: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  /**
   * 注册并尝试加载一个插件
   *
   * @param module    插件模块
   * @param config    插件配置
   * @param instanceId 实例 ID（多实例时为 `name:suffix`，留空则使用 module.name）
   */
  async register(module: PluginModule, config: Record<string, unknown> = {}, instanceId?: string): Promise<void> {
    const id = instanceId ?? module.name;

    // 多实例检查：同一 module 非 reusable 时不允许重复注册
    if (this.plugins.has(id)) {
      this.logger.warn(`插件 "${id}" 已注册，跳过`);
      return;
    }
    if (id !== module.name && !module.reusable) {
      this.logger.warn(`插件 "${module.name}" 未声明 reusable，不允许多实例注册 "${id}"`);
      return;
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
  }

  /**
   * 卸载一个插件
   */
  async unload(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;

    // dispose 段守卫（与 disablePlugin 对齐）：dispose 触发的反应式 recompute
    // 排队到收尾的 softReload，避免在 entry 半卸载态下重算。
    this.suspendDepth++;
    try {
      if (entry.state === 'active' && entry.context) {
        await entry.context.disposeAsync(this.disposeTimeoutMs);
        entry.context = undefined;
        this.rootCtx.emit('plugin:unloaded', name).catch(err => {
          this.logger.warn(`emit plugin:unloaded 失败 (${name}): ${err}`);
        });
      }
      entry.state = 'disposed';
      this.plugins.delete(name);
      this.logger.info(`插件已卸载: ${name}`);
    } finally {
      this.suspendDepth--;
    }

    // 级联重算：依赖被卸载插件所提供服务的下游需要转 pending
    await this.softReload();
  }

  /**
   * 启用一个已禁用的插件
   */
  async enablePlugin(name: string): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;

    if (entry.state !== 'disabled' && entry.state !== 'error') return true; // 已经启用
    entry.state = 'pending';
    entry.error = undefined;
    this.rootCtx.config.setPluginEnabled(name, true);
    this.logger.info(`插件已启用: ${name}`);
    await this.softReload();
    return true;
  }

  /**
   * 禁用一个活跃的插件（core 插件不能禁用）
   */
  async disablePlugin(name: string): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;

    if (entry.module.core) {
      this.logger.warn(`核心插件 "${name}" 不能被禁用`);
      return false;
    }

    if (entry.state === 'disabled') return true; // 已经禁用

    // dispose 段守卫：期间反应式 recompute 排队到收尾的 softReload
    this.suspendDepth++;
    try {
      if (entry.state === 'active' && entry.context) {
        await entry.context.disposeAsync(this.disposeTimeoutMs);
        entry.context = undefined;
        this.rootCtx.emit('plugin:unloaded', name).catch(err => {
          this.logger.warn(`emit plugin:unloaded 失败 (${name}): ${err}`);
        });
      }

      entry.state = 'disabled';
      this.rootCtx.config.setPluginEnabled(name, false);
      this.logger.info(`插件已禁用: ${name}`);
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
    // 状态摘要只含内核事实。配置详情（config / configSchema / defaultConfig）与
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
  getPlugin(name: string): PluginEntry | undefined {
    return this.plugins.get(name);
  }

  /**
   * 更新插件配置（thin alias，转发到 bouncePlugin）。保留独立方法名是为了
   * 让 host 层调用点（WebUI / 配置文件热重载）语义清晰且向后兼容。
   */
  async updatePluginConfig(name: string, config: Record<string, unknown>): Promise<boolean> {
    return this.bouncePlugin(name, { config });
  }

  /**
   * 增量重载单个插件（核心入口）：
   *
   * 1. 持久化新 config（如有）+ 替换 module（如有）+ dispose 旧 ctx
   *    + 转 pending + softReload 重新激活。下游消费者默认不会被级联 bounce，
   *    除非显式声明 `requiresBounceOnDepChange: true`（见 evictDownstreamConsumers）。
   * 2. `error` 态插件会被重置为 pending 重试 apply。
   *
   * 不负责"重新从磁盘 import"——那是宿主层的职责。
   *
   * @returns false 表示找不到 entry 或处于 disabled 态（拒绝 bounce）。
   */
  async bouncePlugin(
    name: string,
    opts?: { config?: Record<string, unknown>; module?: PluginModule },
  ): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    if (entry.state === 'disabled') {
      this.logger.warn(`bouncePlugin: 插件 "${name}" 处于 disabled 态，跳过`);
      return false;
    }

    const newConfig = opts?.config;
    const newModule = opts?.module;

    if (newConfig) {
      entry.config = newConfig;
      this.rootCtx.config.setPluginConfig(name, newConfig);
    }
    if (newModule) entry.module = newModule;

    // dispose 段守卫（与 disablePlugin / unload 对齐）：dispose 触发的反应式
    // recompute 不能在 entry 尚未转 pending 时跑——会把半 bounce 态误判。
    this.suspendDepth++;
    try {
      if (entry.state === 'active' && entry.context) {
        await evictDownstreamConsumers({
          provider: entry,
          plugins: this.plugins,
          rootCtx: this.rootCtx,
          logger: this.logger,
          disposeTimeoutMs: this.disposeTimeoutMs,
        });
        await entry.context.disposeAsync(this.disposeTimeoutMs);
        entry.context = undefined;
        this.rootCtx.emit('plugin:unloaded', name).catch(err => {
          this.logger.warn(`emit plugin:unloaded 失败 (${name}): ${err}`);
        });
      }
      entry.state = 'pending';
      entry.error = undefined;
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

  // ---- 单一状态转移入口 ----

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
   *    （消费者先关、提供者后关，dispose hook 访问依赖服务安全）。
   * 4. Phase B（非 shutdown）：正向遍历，激活"目标 active 且依赖满足"的 pending entry
   *    （提供者先起、消费者后起）。
   * 5. 若本轮有变动则继续下一轮，直到稳定或达到 maxRounds。
   * 6. 非 shutdown 时发出 plugins:changed。
   *
   * Aalis 直接用"服务在不在 + capabilities 命中"
   * 做判断 —— 表达力等价、复杂度更低。
   */
  async recompute(reason: RecomputeReason): Promise<void> {
    if (this.shuttingDown && reason.type !== 'shutdown') {
      // 关机已置位时非关机请求无意义；但若队列里躺着一个被挂起的 shutdown
      // （stop() 与手动 dispose 段竞态），借这次调用把它接过来跑完。
      if (this.queuedReason?.type !== 'shutdown') return;
      reason = this.queuedReason;
      this.queuedReason = null;
    }
    if (reason.type === 'shutdown') this.shuttingDown = true;

    // 单飞 + 排队（修 lost wakeup）：在飞期间/手动 dispose 段的请求合并排队，
    // 由在飞 run 收尾时补跑或 dispose 段收尾的 softReload 消化。注意这里必须
    // 立即返回而不能把在飞 promise 交还调用方——若调用方恰在某插件 apply()
    // 内同步调用（在飞 run 正 await 它），等待在飞 promise 会自我死锁。
    if (this.reloading || this.suspended) {
      this.queuedReason = reason.type === 'shutdown' ? reason : (this.queuedReason ?? { type: 'plugin-state-changed' });
      return;
    }

    this.reloading = true;
    try {
      let current: RecomputeReason | null = reason;
      while (current) {
        await this.recomputeOnce(current);
        current = this.queuedReason;
        this.queuedReason = null;
      }
    } finally {
      this.reloading = false;
      this.settleIdleWaiters();
    }
  }

  /** 单次完整重算：fixed-point 状态转移 + （非关机）plugins:changed 通知 */
  private async recomputeOnce(reason: RecomputeReason): Promise<void> {
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

    while (changed && rounds < maxRounds()) {
      changed = false;
      rounds++;
      lastRoundFlips = [];

      const entries = [...this.plugins.values()];
      const order = topoSortByDeps(entries, this.logger);

      // Phase A: 反向遍历，关掉目标不是 active 的 active entry
      for (const entry of [...order].reverse()) {
        if (entry.state !== 'active') continue;
        const target = computeTargetState(entry, currentReason, this.rootCtx);
        if (target === 'active') continue;

        // 日志：区分 shutdown / required 不满 / optional bounce
        if (currentReason.type === 'shutdown') {
          // 静默
        } else {
          const unmet = entry.requiredDeps.find(d => this.rootCtx.getService(d.service) === undefined);
          if (unmet) {
            this.logger.info(`依赖 "${unmet.service}" 不可用，停用插件: ${entry.instanceId}`);
          } else if (currentReason.type === 'service-down') {
            // 被动级联降级（依赖服务下线 → 转 pending 等待重新满足），
            // 区别于 bouncePlugin() 的主动重载，措辞不混用 bounce。
            this.logger.info(`依赖服务 "${currentReason.service}" 已下线，降级插件为待激活: ${entry.instanceId}`);
          }
        }

        if (entry.context) {
          try {
            await entry.context.disposeAsync(this.disposeTimeoutMs);
          } catch (err) {
            this.logger.error(
              `插件 "${entry.instanceId}" dispose 抛错: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          entry.context = undefined;
        }
        entry.state = currentReason.type === 'shutdown' ? 'disposed' : 'pending';
        if (currentReason.type !== 'shutdown') {
          this.rootCtx.emit('plugin:unloaded', entry.instanceId).catch(err => {
            this.logger.warn(`emit plugin:unloaded 失败 (${entry.instanceId}): ${err}`);
          });
        }
        changed = true;
        lastRoundFlips.push(entry.instanceId);
      }

      // 关机不需要再激活
      if (currentReason.type === 'shutdown') break;

      // Phase B: 正向遍历，激活目标 active 的 pending entry
      for (const entry of order) {
        if (entry.state !== 'pending') continue;
        const target = computeTargetState(entry, currentReason, this.rootCtx);
        if (target !== 'active') continue;
        await activatePlugin(entry, {
          plugins: this.plugins,
          rootCtx: this.rootCtx,
          logger: this.logger,
          disposeTimeoutMs: this.disposeTimeoutMs,
        });
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

    this.rootCtx.emit('plugins:changed').catch(err => {
      this.logger.warn(`emit plugins:changed 失败: ${err}`);
    });
  }
}
