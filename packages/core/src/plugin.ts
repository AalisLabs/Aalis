import type { Context } from './context.js';
import type { Logger } from './logger.js';
import { activatePlugin, computeTargetState, ensureServiceProvider } from './plugin-activation.js';
import { evictDownstreamConsumers, topoSortByDeps } from './plugin-topology.js';
import { normalizeDependency } from './service.js';
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
   * 只有最外层退出（归零）才解除（审计 HIGH #3）。
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

  /**
   * 必需服务列表: softReload 完成后若缺失会自动恢复。
   * 由 App 设置。
   */
  requiredServices: readonly string[] = [];

  /**
   * 必需服务恢复政策（由 App 从 AppOptions.serviceRecovery 设置）。
   * autoEnableDisabled=false 时恢复路径不会自动启用被用户禁用的提供者插件。
   */
  recoveryPolicy: { autoEnableDisabled: boolean } = { autoEnableDisabled: true };

  constructor(rootCtx: Context, logger: Logger) {
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
        entry.context.dispose();
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
        entry.context.dispose();
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
    return [...this.plugins.entries()].map(([, entry]) => {
      // subsystem / extends 由 @aalis/plugin-webui-api 通过 declaration merging
      // 注入，core 不感知其语义，仅透传给 listPlugins() 调用方。
      // 实际消费者：plugin-webui-server（按 subsystem 将插件归组渲染到 dashboard，
      // 见 packages/plugin-webui-server/src/index.ts）。"core 不消费 ≠ 系统未消费"。
      const m = entry.module as {
        subsystem?: string;
        extends?: unknown;
      };
      return {
        name: entry.module.name,
        instanceId: entry.instanceId,
        displayName: entry.module.displayName,
        subsystem: m.subsystem,
        state: entry.state,
        provides: entry.module.provides,
        core: entry.module.core,
        reusable: entry.module.reusable,
        extends: m.extends,
        config: entry.config,
        configSchema: entry.module.configSchema,
        defaultConfig: entry.module.defaultConfig,
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
        evictDownstreamConsumers({
          provider: entry,
          plugins: this.plugins,
          rootCtx: this.rootCtx,
          logger: this.logger,
        });
        entry.context.dispose();
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

  /**
   * 在运行时基于 reusable 模块新增一个实例（写入配置 + 触发激活）。
   *
   * @param moduleName 原始模块名（如 `@aalis/plugin-openai`）
   * @param suffix     实例后缀（如 `vision`），将生成 instanceId `moduleName:suffix`
   * @param config     新实例的配置
   * @returns 新实例的 instanceId，失败返回 undefined
   */
  async createInstance(
    moduleName: string,
    suffix: string,
    config: Record<string, unknown> = {},
  ): Promise<string | undefined> {
    // 从已注册的插件中查找同 module 的 entry
    let sourceModule: PluginModule | undefined;
    for (const entry of this.plugins.values()) {
      if (entry.module.name === moduleName) {
        sourceModule = entry.module;
        break;
      }
    }
    if (!sourceModule) {
      this.logger.warn(`创建实例失败: 模块 "${moduleName}" 未找到`);
      return undefined;
    }
    if (!sourceModule.reusable) {
      this.logger.warn(`创建实例失败: 模块 "${moduleName}" 未声明 reusable`);
      return undefined;
    }

    const instanceId = `${moduleName}:${suffix}`;
    if (this.plugins.has(instanceId)) {
      this.logger.warn(`创建实例失败: "${instanceId}" 已存在`);
      return undefined;
    }

    // 合并配置：默认配置 ← 传入配置
    const defaults = sourceModule.defaultConfig ?? {};
    const mergedConfig = { ...defaults, ...config };

    // 写入配置文件
    this.rootCtx.config.setPluginConfig(instanceId, mergedConfig);

    // 注册并尝试激活
    await this.register(sourceModule, mergedConfig, instanceId);

    return instanceId;
  }

  /**
   * 移除一个多实例插件（不允许移除主实例）
   */
  async removeInstance(instanceId: string): Promise<boolean> {
    const { suffix } = parseInstanceId(instanceId);
    if (!suffix) {
      this.logger.warn(`不能移除主实例 "${instanceId}"`);
      return false;
    }

    const entry = this.plugins.get(instanceId);
    if (!entry) return false;

    // 卸载
    await this.unload(instanceId);

    // 从配置文件中移除
    this.rootCtx.config.removePluginConfig(instanceId);

    await this.softReload();
    return true;
  }

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
   * 这是 PluginManager 唯一的状态变更入口（除 ensureServiceProvider 这种显式
   * 启用 disabled 提供者的恢复策略之外）。
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
   * 6. 非 shutdown 时检查必需服务并发出 plugins:changed。
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
    }
  }

  /** 单次完整重算：fixed-point 状态转移 + （非关机）必需服务恢复与 plugins:changed 通知 */
  private async recomputeOnce(reason: RecomputeReason): Promise<void> {
    let currentReason = reason;
    let changed = true;
    let rounds = 0;
    const maxRounds = 20;

    while (changed && rounds < maxRounds) {
      changed = false;
      rounds++;

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
          const unmet = entry.requiredDeps.find(
            d => !this.rootCtx.hasService(d.service, d.capabilities.length > 0 ? d.capabilities : undefined),
          );
          if (unmet) {
            this.logger.info(`依赖 "${unmet.service}" 不可用，停用插件: ${entry.instanceId}`);
          } else if (currentReason.type === 'service-down') {
            this.logger.info(`服务 "${currentReason.service}" 已替换/撤销，bounce 插件: ${entry.instanceId}`);
          }
        }

        if (entry.context) {
          try {
            entry.context.dispose();
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
      }

      // 关机不需要再激活
      if (currentReason.type === 'shutdown') break;

      // Phase B: 正向遍历，激活目标 active 的 pending entry
      for (const entry of order) {
        if (entry.state !== 'pending') continue;
        const target = computeTargetState(entry, currentReason, this.rootCtx);
        if (target !== 'active') continue;
        await activatePlugin(entry, { plugins: this.plugins, rootCtx: this.rootCtx, logger: this.logger });
        if ((entry.state as PluginState) === 'active') changed = true;
      }

      // service-up / service-down 的"特殊语义"只在第一轮生效（避免无限 bounce）；
      // 第二轮起退化为普通的 plugin-state-changed 重算。
      if (currentReason.type === 'service-up' || currentReason.type === 'service-down') {
        currentReason = { type: 'plugin-state-changed' };
      }
    }

    if (rounds >= maxRounds) {
      this.logger.warn('recompute 达到最大迭代次数，可能存在循环依赖');
    }

    if (reason.type === 'shutdown') return;

    // 必需服务自动恢复
    for (const service of this.requiredServices) {
      if (!this.rootCtx.hasService(service)) {
        this.logger.warn(`必需服务 "${service}" 缺失，尝试自动恢复...`);
        const activated = await ensureServiceProvider(service, {
          plugins: this.plugins,
          rootCtx: this.rootCtx,
          logger: this.logger,
          recovery: this.recoveryPolicy,
        });
        if (activated) {
          this.logger.info(`必需服务 "${service}" 已通过插件 "${activated}" 恢复`);
        } else {
          this.logger.error(`必需服务 "${service}" 自动恢复失败！`);
        }
      }
    }

    this.rootCtx.emit('plugins:changed').catch(err => {
      this.logger.warn(`emit plugins:changed 失败: ${err}`);
    });
  }

  /**
   * 为外部（App）暴露的「必需服务自动恢复」入口。
   *
   * 实际逻辑在 plugin-activation.ts。PluginManager 仅负责注入 plugins/rootCtx/logger。
   */
  async ensureServiceProvider(serviceName: string): Promise<string | undefined> {
    return ensureServiceProvider(serviceName, {
      plugins: this.plugins,
      rootCtx: this.rootCtx,
      logger: this.logger,
      recovery: this.recoveryPolicy,
    });
  }
}
