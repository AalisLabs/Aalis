import type { Context } from './context.js';
import type { Logger } from './logger.js';
import { type NormalizedDependency, normalizeDependency } from './service.js';
import type { ConfigSchema, InjectDeclaration } from './types/index.js';

// ----- 插件定义格式 -----

export interface PluginModule {
  name: string;
  /** 插件的显示名称，用于前端展示 */
  displayName?: string;
  inject?: InjectDeclaration;
  provides?: string[];
  /** 标记为 core 的插件不能被用户禁用 */
  core?: boolean;
  /**
   * 是否允许同一插件以不同配置多次加载（多实例）
   *
   * 默认 false：同一 module 只能注册一次（防止重复注册命令等副作用）。
   * 设为 true 后，可通过 `name:suffix` 格式注册多个实例，
   * 每个实例拥有独立的 Context、配置和 contextId。
   *
   * 适合多实例的插件：LLM adapters、embedding adapters、platform adapters、memory backends。
   */
  reusable?: boolean;
  /** 配置 Schema，用于前端自动生成配置表单 */
  configSchema?: ConfigSchema;
  /** 插件默认配置，当主配置文件中无此插件配置时使用 */
  defaultConfig?: Record<string, unknown>;
  /**
   * 通用命名的插件 RPC 动作表 —— 供 host （如 WebUI / CLI / IPC 层）远程调用。
   *
   * core 不负责调起，仅存为​​传输插槽；在 listPlugins() 中以 `actionNames`
   * （售本 key 列表）导出，供 host 路由。调用方使用 host 提供的
   * `entry.context` 及 args 调用 handler；core 本身不感知 webui/cli 这样的
   * 具体消费者。
   */
  actions?: Record<string, (ctx: Context, args: Record<string, unknown>) => Promise<unknown>>;
  apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>;
  // 注：subsystem / extends 等纯 WebUI 展示元数据由
  // @aalis/plugin-webui-api 通过 declaration merging 注入；core 不读取它们，
  // 仅在 listPlugins() 中以 unknown 类型透传。
  // webuiPages 已迁移到 useWebuiService(ctx).registerPage()。
}

// ----- 插件状态 -----

export type PluginState = 'pending' | 'activating' | 'active' | 'disabled' | 'disposed' | 'error';

/**
 * recompute() 的触发原因。所有导致插件库状态需重新计算的事件
 * 都收拢到这个判别联合上，让 PluginManager 只有一条状态转移路径。
 *
 * - service-up：某服务刚被 provide —— 可能让 pending 插件能激活
 * - service-down：某服务刚被 unregister —— required 依赖其的要停用，
 *   optional 依赖其的要 bounce（重新 apply 以对接可能的新实例）
 * - plugin-state-changed：插件被显式禁用/启用/重载/改配置后调用
 * - shutdown：App.stop() 调用，按拓扑逆序 dispose 所有插件
 */
type RecomputeReason =
  | { type: 'service-up'; service: string }
  | { type: 'service-down'; service: string }
  | { type: 'plugin-state-changed' }
  | { type: 'shutdown' };

export interface PluginEntry {
  module: PluginModule;
  /** 实例 ID：单实例时与 module.name 相同，多实例时为 `name:suffix` */
  instanceId: string;
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  context?: Context;
  requiredDeps: NormalizedDependency[];
  optionalDeps: NormalizedDependency[];
}

/**
 * 解析插件实例 ID
 *
 * 格式：`@scope/plugin-name:suffix` → { moduleName: '@scope/plugin-name', suffix: 'suffix' }
 * 无 suffix 时返回 { moduleName, suffix: undefined }
 */
export function parseInstanceId(instanceId: string): { moduleName: string; suffix?: string } {
  // 从右侧找最后一个冒号，但跳过 scope 中的冒号
  // 格式: @scope/name:suffix 或 name:suffix
  const slashIdx = instanceId.indexOf('/');
  const searchFrom = slashIdx >= 0 ? slashIdx + 1 : 0;
  const colonIdx = instanceId.indexOf(':', searchFrom);
  if (colonIdx < 0) return { moduleName: instanceId };
  return {
    moduleName: instanceId.slice(0, colonIdx),
    suffix: instanceId.slice(colonIdx + 1),
  };
}

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
  private reloading = false;
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

  constructor(rootCtx: Context, logger: Logger) {
    this.rootCtx = rootCtx;
    this.logger = logger.child('plugin');

    // 监听服务注册/注销，路由到统一 recompute()。reloading 期间与关机后一律跳过。
    rootCtx.on('service:registered', name => {
      if (this.reloading || this.shuttingDown) return;
      this.recompute({ type: 'service-up', service: name }).catch(err => {
        this.logger.error(`recompute(service-up:${name}) 报错: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    rootCtx.on('service:unregistered', name => {
      if (this.reloading || this.shuttingDown) return;
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

    if (entry.state === 'active' && entry.context) {
      entry.context.dispose();
      this.rootCtx.emit('plugin:unloaded', name).catch(() => {});
    }
    entry.state = 'disposed';
    this.plugins.delete(name);
    this.logger.info(`插件已卸载: ${name}`);
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

    // 设置 reloading 防止 dispose 产生的事件触发重入
    this.reloading = true;
    try {
      if (entry.state === 'active' && entry.context) {
        entry.context.dispose();
        entry.context = undefined;
        this.rootCtx.emit('plugin:unloaded', name).catch(() => {});
      }

      entry.state = 'disabled';
      this.rootCtx.config.setPluginEnabled(name, false);
      this.logger.info(`插件已禁用: ${name}`);
    } finally {
      this.reloading = false;
    }

    await this.softReload();
    return true;
  }

  /**
   * 获取所有已注册插件的状态
   */
  getStatus(): Array<{
    name: string;
    instanceId: string;
    displayName?: string;
    subsystem?: string;
    state: PluginState;
    provides?: string[];
    core?: boolean;
    reusable?: boolean;
    extends?: unknown;
    config: Record<string, unknown>;
    configSchema?: ConfigSchema;
    defaultConfig?: Record<string, unknown>;
    actionNames?: string[];
    error?: string;
  }> {
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
        actionNames: entry.module.actions ? Object.keys(entry.module.actions) : undefined,
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
   * 更新插件配置（需要重新激活才生效）
   */
  async updatePluginConfig(name: string, config: Record<string, unknown>): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;

    entry.config = config;
    this.rootCtx.config.setPluginConfig(name, config);

    // 若插件在运行中，dispose 旧上下文后转为 pending 重新激活
    if (entry.state === 'active' && entry.context) {
      // 先把所有依赖该插件 provided 服务的 active 下游消费者也一并 pending：
      // 服务实例即将被 dispose+重新 provide，下游持有的引用即失效。
      // 反应式 listener 走异步 recompute，错过 dispose 同步窗口；这里显式标记。
      this.evictDownstreamConsumers(entry);
      entry.context.dispose();
      entry.context = undefined;
      entry.state = 'pending';
      this.rootCtx.emit('plugin:unloaded', name).catch(() => {});
      await this.softReload();
    } else if (entry.state === 'error') {
      // 之前 apply 抛错而停在 error 态：新配置可能修复问题，重置为 pending 重试
      entry.state = 'pending';
      entry.error = undefined;
      await this.softReload();
    }

    return true;
  }

  /**
   * 增量重载单个插件：dispose 旧 ctx，可选替换 module 引用，转为 pending 后
   * 走 softReload 让依赖该插件 provided 服务的下游插件自动级联 bounce。
   *
   * 不负责"重新从磁盘 import"——那是宿主层（App.reloadPlugin）的职责，因为
   * PluginManager 不感知 pluginLoader / descriptor。
   *
   * @returns false 表示找不到 entry 或处于 disabled 态（拒绝 bounce）。
   */
  async bouncePlugin(name: string, newModule?: PluginModule): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    if (entry.state === 'disabled') {
      this.logger.warn(`bouncePlugin: 插件 "${name}" 处于 disabled 态，跳过`);
      return false;
    }

    if (entry.state === 'active' && entry.context) {
      this.evictDownstreamConsumers(entry);
      entry.context.dispose();
      entry.context = undefined;
      this.rootCtx.emit('plugin:unloaded', name).catch(() => {});
    }
    if (newModule) entry.module = newModule;
    entry.state = 'pending';
    entry.error = undefined;
    await this.softReload();
    return true;
  }

  /**
   * 把所有依赖 `provider` 所提供服务的 active 下游消费者降级为 pending。
   *
   * 用于 updatePluginConfig / bouncePlugin：当某 provider 即将被 dispose+重启
   * 时，optional 依赖该 provider 服务的下游插件持有的服务引用会失效，必须 bounce
   * 以重新 apply 拿到新实例。required 依赖则更明显：服务消失 = 必须停。
   *
   * 同步执行（不 await），因为 caller 紧接着会 await softReload 完成全部重激活。
   */
  private evictDownstreamConsumers(provider: PluginEntry): void {
    const provided = provider.module.provides ?? [];
    if (provided.length === 0) return;
    const providedSet = new Set(provided);
    for (const other of this.plugins.values()) {
      if (other === provider || other.state !== 'active') continue;
      const allDeps = [...other.requiredDeps, ...other.optionalDeps];
      if (!allDeps.some(d => providedSet.has(d.service))) continue;
      if (other.context) {
        try {
          other.context.dispose();
        } catch (err) {
          this.logger.error(
            `下游消费者 "${other.instanceId}" dispose 抛错: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        other.context = undefined;
      }
      other.state = 'pending';
      this.rootCtx.emit('plugin:unloaded', other.instanceId).catch(() => {});
    }
  }

  /**
   * 基于已注册的 reusable 插件创建新实例
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
    if (this.shuttingDown && reason.type !== 'shutdown') return;
    if (reason.type === 'shutdown') this.shuttingDown = true;

    // 重入保护：上层 reactive 监听器在 reloading=true 时已 skip；这里再加一道兜底。
    if (this.reloading) return;
    this.reloading = true;

    try {
      let currentReason = reason;
      let changed = true;
      let rounds = 0;
      const maxRounds = 20;

      while (changed && rounds < maxRounds) {
        changed = false;
        rounds++;

        const entries = [...this.plugins.values()];
        const order = this.topoSortByDeps(entries);

        // Phase A: 反向遍历，关掉目标不是 active 的 active entry
        for (const entry of [...order].reverse()) {
          if (entry.state !== 'active') continue;
          const target = this.computeTargetState(entry, currentReason);
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
            this.rootCtx.emit('plugin:unloaded', entry.instanceId).catch(() => {});
          }
          changed = true;
        }

        // 关机不需要再激活
        if (currentReason.type === 'shutdown') break;

        // Phase B: 正向遍历，激活目标 active 的 pending entry
        for (const entry of order) {
          if (entry.state !== 'pending') continue;
          const target = this.computeTargetState(entry, currentReason);
          if (target !== 'active') continue;
          await this.tryActivate(entry);
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
    } finally {
      this.reloading = false;
    }

    if (reason.type === 'shutdown') return;

    // 必需服务自动恢复
    for (const service of this.requiredServices) {
      if (!this.rootCtx.hasService(service)) {
        this.logger.warn(`必需服务 "${service}" 缺失，尝试自动恢复...`);
        const activated = await this.ensureServiceProvider(service);
        if (activated) {
          this.logger.info(`必需服务 "${service}" 已通过插件 "${activated}" 恢复`);
        } else {
          this.logger.error(`必需服务 "${service}" 自动恢复失败！`);
        }
      }
    }

    this.rootCtx.emit('plugins:changed').catch(() => {});
  }

  /**
   * 计算单个 entry 的目标状态。
   *
   * - disabled / disposed / error 是显式态，recompute 不动它们
   * - required 依赖不满足 → pending
   * - service-down 命中 optional 依赖且服务确实没了 → pending（强制 bounce 重新 apply）
   * - 其余 active / pending / activating → active
   */
  private computeTargetState(entry: PluginEntry, reason: RecomputeReason): PluginState {
    if (entry.state === 'disabled' || entry.state === 'disposed' || entry.state === 'error') {
      return entry.state;
    }
    // 关机：所有 active/pending/activating 都目标 disposed
    if (reason.type === 'shutdown') return 'disposed';
    const reqUnmet = entry.requiredDeps.some(
      d => !this.rootCtx.hasService(d.service, d.capabilities.length > 0 ? d.capabilities : undefined),
    );
    if (reqUnmet) return 'pending';
    if (reason.type === 'service-down') {
      const optHit = entry.optionalDeps.find(d => d.service === reason.service);
      if (
        optHit &&
        !this.rootCtx.hasService(optHit.service, optHit.capabilities.length > 0 ? optHit.capabilities : undefined)
      ) {
        return 'pending';
      }
    }
    return 'active';
  }

  /**
   * 按"提供者 → 消费者"方向的拓扑排序（Kahn）。
   *
   * 关闭顺序 = 此结果反向；激活顺序 = 此结果正序。
   * 服务名 → 提供者映射只取首个 provides 该服务名的 entry，足以表达依赖图。
   * 残留环按声明序兜底追加。
   */
  private topoSortByDeps(entries: PluginEntry[]): PluginEntry[] {
    const providerOf = new Map<string, string>();
    for (const e of entries) {
      for (const svc of e.module.provides ?? []) {
        if (!providerOf.has(svc)) providerOf.set(svc, e.instanceId);
      }
    }
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, Set<string>>();
    const entryById = new Map(entries.map(e => [e.instanceId, e]));
    for (const e of entries) {
      inDegree.set(e.instanceId, 0);
      dependents.set(e.instanceId, new Set());
    }
    for (const e of entries) {
      const deps = [...e.requiredDeps, ...e.optionalDeps];
      const seenProviders = new Set<string>();
      for (const dep of deps) {
        const providerId = providerOf.get(dep.service);
        if (!providerId || providerId === e.instanceId) continue;
        if (!entryById.has(providerId)) continue;
        if (seenProviders.has(providerId)) continue;
        seenProviders.add(providerId);
        dependents.get(providerId)!.add(e.instanceId);
        inDegree.set(e.instanceId, (inDegree.get(e.instanceId) ?? 0) + 1);
      }
    }
    const result: PluginEntry[] = [];
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    while (queue.length) {
      const id = queue.shift()!;
      result.push(entryById.get(id)!);
      for (const dep of dependents.get(id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
        if (inDegree.get(dep) === 0) queue.push(dep);
      }
    }
    if (result.length < entries.length) {
      const seen = new Set(result.map(e => e.instanceId));
      for (const e of entries) {
        if (!seen.has(e.instanceId)) result.push(e);
      }
      this.logger.warn(`topoSortByDeps: 检测到依赖环，残留 ${entries.length - seen.size} 个按声明序追加`);
    }
    return result;
  }

  private async tryActivate(entry: PluginEntry): Promise<void> {
    if (entry.state !== 'pending') return;

    // 检查所有必需依赖是否满足
    for (const dep of entry.requiredDeps) {
      if (!this.rootCtx.hasService(dep.service, dep.capabilities.length > 0 ? dep.capabilities : undefined)) {
        this.logger.debug(
          `插件 "${entry.instanceId}" 等待服务: ${dep.service}${dep.capabilities.length ? ` [${dep.capabilities.join(', ')}]` : ''}`,
        );
        return;
      }
    }

    // 先标记为 activating，防止 service:registered 事件导致重入
    entry.state = 'activating';

    // 所有依赖已满足，激活插件（使用 instanceId 作为 contextId，以区分多实例）
    const ctx = this.rootCtx.fork(entry.instanceId);
    entry.context = ctx;

    try {
      await entry.module.apply(ctx, entry.config);

      // 校验 provides 声明与实际注册的一致性
      if (entry.module.provides) {
        const missing = entry.module.provides.filter(
          name => !this.rootCtx.serviceContainer.hasByContext(name, entry.instanceId),
        );
        if (missing.length > 0) {
          throw new Error(`声明 provides [${missing.join(', ')}] 但未实际注册这些服务`);
        }
      }

      entry.state = 'active';
      entry.error = undefined;
      this.logger.info(`插件已激活: ${entry.instanceId}`);
      await this.rootCtx.emit('plugin:loaded', entry.instanceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`插件 "${entry.instanceId}" 激活失败: ${message}`);
      ctx.dispose();
      entry.context = undefined;
      entry.state = 'error';
      entry.error = message;
    }
  }

  /**
   * 查找能提供指定服务的插件并尝试激活它
   *
   * 用于核心必需服务的自动恢复：
   * 1. 优先找已注册但被禁用的提供者 → 启用
   * 2. 其次找已注册但处于 pending/error 的提供者 → 重新激活
   * 3. 同时跳过已经 active 的（说明服务应该已存在）
   *
   * @returns 成功激活的插件名，或 undefined
   */
  async ensureServiceProvider(serviceName: string, _resolving?: Set<string>): Promise<string | undefined> {
    // 先检查是否已经有提供者在运行
    if (this.rootCtx.hasService(serviceName)) {
      return undefined; // 已存在，无需处理
    }

    // 循环依赖检测
    const resolving = _resolving ?? new Set<string>();
    if (resolving.has(serviceName)) {
      this.logger.error(`检测到循环依赖，跳过: ${serviceName}`);
      return undefined;
    }
    resolving.add(serviceName);

    // 遍历所有已注册插件，找到声明 provides 包含该服务名的
    const candidates: PluginEntry[] = [];
    for (const entry of this.plugins.values()) {
      if (!entry.module.provides?.includes(serviceName)) continue;
      candidates.push(entry);
    }

    if (candidates.length === 0) {
      this.logger.error(`必需服务 "${serviceName}" 无可用提供者插件`);
      return undefined;
    }

    // 尝试激活一个候选者（优先 disabled → pending/error）
    const ordered = [
      ...candidates.filter(e => e.state === 'disabled'),
      ...candidates.filter(e => e.state === 'pending' || e.state === 'error'),
    ];

    for (const candidate of ordered) {
      if (candidate.state === 'disabled') {
        this.logger.warn(`必需服务 "${serviceName}" 缺失，自动启用插件: ${candidate.instanceId}`);
        candidate.state = 'pending';
        candidate.error = undefined;
        this.rootCtx.config.setPluginEnabled(candidate.instanceId, true);
      } else {
        this.logger.warn(`必需服务 "${serviceName}" 缺失，尝试激活插件: ${candidate.instanceId}`);
        candidate.state = 'pending';
        candidate.error = undefined;
      }

      // 递归确保该候选者的依赖链也有提供者
      for (const dep of candidate.requiredDeps) {
        if (!this.rootCtx.hasService(dep.service, dep.capabilities.length > 0 ? dep.capabilities : undefined)) {
          await this.ensureServiceProvider(dep.service, resolving);
        }
      }

      await this.tryActivate(candidate);
      if ((candidate.state as PluginState) === 'active') {
        this.rootCtx.config.save();
        return candidate.instanceId;
      }
    }

    // 如果有 active 的候选者但服务仍然不存在，可能是插件 bug
    const active = candidates.find(e => e.state === 'active');
    if (active) {
      this.logger.warn(`插件 "${active.instanceId}" 已激活但未提供 "${serviceName}" 服务`);
    }

    this.logger.error(`无法为必需服务 "${serviceName}" 找到可用的提供者`);
    return undefined;
  }
}

// ----- 辅助 -----
