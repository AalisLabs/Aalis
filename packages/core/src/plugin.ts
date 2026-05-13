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
   * 必需服务列表: softReload 完成后若缺失会自动恢复。
   * 由 App 设置。
   */
  requiredServices: readonly string[] = [];

  constructor(rootCtx: Context, logger: Logger) {
    this.rootCtx = rootCtx;
    this.logger = logger.child('plugin');

    // 监听服务注册/注销，自动激活/停用插件（softReload 期间跳过，避免重入）
    rootCtx.on('service:registered', () => {
      if (!this.reloading) this.checkPendingPlugins();
    });
    rootCtx.on('service:unregistered', name => {
      if (!this.reloading) this.checkActivePlugins(name);
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
      // 尝试立即激活
      await this.tryActivate(entry);
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

  // ---- 内部逻辑 ----

  /**
   * 软重载：最小范围级联
   *
   * 反复执行直到稳定（fixed-point）：
   * 1. 停用所有 required 依赖不满足的 active 插件 → 变为 pending
   * 2. 尝试激活所有 pending 插件
   * 3. 如果本轮有任何变动，重复；否则结束
   * 4. 发出 plugins:changed 事件通知前端
   */
  async softReload(): Promise<void> {
    this.reloading = true;
    try {
      let changed = true;
      let rounds = 0;
      const maxRounds = 20; // 防止无限循环

      while (changed && rounds < maxRounds) {
        changed = false;
        rounds++;

        // Phase 1: 停用依赖不满足的 active 插件
        for (const entry of this.plugins.values()) {
          if (entry.state !== 'active') continue;

          const unmet = entry.requiredDeps.find(
            dep => !this.rootCtx.hasService(dep.service, dep.capabilities.length > 0 ? dep.capabilities : undefined),
          );
          if (!unmet) continue;

          this.logger.info(`依赖 "${unmet.service}" 不可用，停用插件: ${entry.instanceId}`);
          if (entry.context) {
            entry.context.dispose();
            entry.context = undefined;
          }
          entry.state = 'pending';
          this.rootCtx.emit('plugin:unloaded', entry.instanceId).catch(() => {});
          changed = true;
        }

        // Phase 2: 尝试激活 pending 插件（不重试 error 态——error 仅由 updatePluginConfig 触发的显式重置驱动，
        // 避免依赖每次抖动都把同一个错误重新打印一遍）
        for (const entry of this.plugins.values()) {
          if (entry.state !== 'pending') continue;
          const prevState = entry.state;
          await this.tryActivate(entry);
          if (entry.state !== prevState) changed = true;
        }
      }

      if (rounds >= maxRounds) {
        this.logger.warn('softReload 达到最大迭代次数，可能存在循环依赖');
      }
    } finally {
      this.reloading = false;
    }

    // Phase 3: 检查必需服务，缺失则自动恢复
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

    // 通知前端刷新状态
    this.rootCtx.emit('plugins:changed').catch(() => {});
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
   * 检查是否有待激活的插件现在可以加载
   */
  private async checkPendingPlugins(): Promise<void> {
    for (const entry of this.plugins.values()) {
      if (entry.state === 'pending') {
        await this.tryActivate(entry);
      }
    }
  }

  /**
   * 当某个服务被移除时，bounce 依赖该服务的插件（required + optional 一视同仁）。
   *
   * - required 依赖：插件本来就无法在缺该服务时存活，转 pending 等待恢复（旧行为）。
   * - optional 依赖：服务实例发生替换（dispose + 重新 provide）时，下游插件持有
   *   的服务引用已失效（例如它们用 `useXxxService(ctx).register(...)` 注册过的
   *   东西在旧实例上）。bounce 让它们的 apply 重新跑一遍，对接新实例。
   *
   * 典型场景：plugin-commands 因 commandPrefix 改动而 reload → `commands` 服务
   * dispose 再重新 provide → plugin-doctor / plugin-agent-default / plugin-user-profile
   * 等以 optional 方式依赖 `commands` 的插件需要重新注册自己的命令，
   * 否则 `/help` 列表会丢失大半。
   */
  private checkActivePlugins(removedService: string): void {
    for (const entry of this.plugins.values()) {
      if (entry.state !== 'active') continue;

      const requiredDep = entry.requiredDeps.find(d => d.service === removedService);
      const optionalDep = entry.optionalDeps.find(d => d.service === removedService);
      if (!requiredDep && !optionalDep) continue;

      // 检查服务是否真的不可用了（可能还有其他提供者）
      const dep = (requiredDep ?? optionalDep)!;
      if (this.rootCtx.hasService(dep.service, dep.capabilities.length > 0 ? dep.capabilities : undefined)) {
        continue; // 还有其他提供者
      }

      // 转 pending：softReload / 后续 service:registered 会重新激活
      this.logger.info(`服务 "${removedService}" 不可用，${requiredDep ? '停用' : 'bounce'} 插件: ${entry.instanceId}`);
      if (entry.context) {
        entry.context.dispose();
        entry.context = undefined;
      }
      entry.state = 'pending';
      this.rootCtx.emit('plugin:unloaded', entry.instanceId).catch(() => {});
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
