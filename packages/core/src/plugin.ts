import { Context } from './context.js';
import { normalizeDependency, type NormalizedDependency } from './service.js';
import type { InjectDeclaration, DependencyDeclaration, ConfigSchema, ExtendDeclaration, WebuiPage } from './types.js';
import type { Logger } from './logger.js';

// ----- 插件定义格式 -----

export interface PluginModule {
  name: string;
  inject?: InjectDeclaration;
  provides?: string[];
  /** 标记为 core 的插件不能被用户禁用 */
  core?: boolean;
  /** 声明该插件对 core 的扩展（新增事件、钩子、mixin 方法） */
  extends?: ExtendDeclaration;
  /** 配置 Schema，用于前端自动生成配置表单 */
  configSchema?: ConfigSchema;
  /** 插件默认配置，当主配置文件中无此插件配置时使用 */
  defaultConfig?: Record<string, unknown>;
  /** 该插件提供的 WebUI 页面声明 */
  webuiPages?: WebuiPage[];
  apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>;
}

// ----- 插件状态 -----

export type PluginState = 'pending' | 'activating' | 'active' | 'disabled' | 'disposed' | 'error';

export interface PluginEntry {
  module: PluginModule;
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  context?: Context;
  requiredDeps: NormalizedDependency[];
  optionalDeps: NormalizedDependency[];
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
    rootCtx.on('service:unregistered', (name) => {
      if (!this.reloading) this.checkActivePlugins(name);
    });
  }

  /**
   * 注册并尝试加载一个插件
   */
  async register(
    module: PluginModule,
    config: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.plugins.has(module.name)) {
      this.logger.warn(`插件 "${module.name}" 已注册，跳过`);
      return;
    }

    const inject = module.inject ?? {};
    const requiredDeps = (inject.required ?? []).map(normalizeDep);
    const optionalDeps = (inject.optional ?? []).map(normalizeDep);

    // 检查是否被配置禁用
    const isDisabled = this.rootCtx.config.isPluginDisabled(module.name);

    const entry: PluginEntry = {
      module,
      config,
      state: isDisabled ? 'disabled' : 'pending',
      requiredDeps,
      optionalDeps,
    };

    this.plugins.set(module.name, entry);

    if (isDisabled) {
      this.logger.info(`插件已注册(禁用): ${module.name}`);
    } else {
      this.logger.info(`插件已注册: ${module.name}`);
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
  getStatus(): Array<{ name: string; state: PluginState; provides?: string[]; core?: boolean; extends?: ExtendDeclaration; config: Record<string, unknown>; configSchema?: ConfigSchema; defaultConfig?: Record<string, unknown>; webuiPages?: WebuiPage[]; error?: string }> {
    return [...this.plugins.entries()].map(([name, entry]) => ({
      name,
      state: entry.state,
      provides: entry.module.provides,
      core: entry.module.core,
      extends: entry.module.extends,
      config: entry.config,
      configSchema: entry.module.configSchema,
      defaultConfig: entry.module.defaultConfig,
      webuiPages: entry.module.webuiPages,
      error: entry.error,
    }));
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

    // 如果插件在运行中，需要重新加载
    if (entry.state === 'active' && entry.context) {
      entry.context.dispose();
      entry.context = undefined;
      entry.state = 'pending';
      this.rootCtx.emit('plugin:unloaded', name).catch(() => {});
      await this.softReload();
    }

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

          this.logger.info(`依赖 "${unmet.service}" 不可用，停用插件: ${entry.module.name}`);
          if (entry.context) {
            entry.context.dispose();
            entry.context = undefined;
          }
          entry.state = 'pending';
          this.rootCtx.emit('plugin:unloaded', entry.module.name).catch(() => {});
          changed = true;
        }

        // Phase 2: 尝试激活 pending 插件
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
          `插件 "${entry.module.name}" 等待服务: ${dep.service}${dep.capabilities.length ? ` [${dep.capabilities.join(', ')}]` : ''}`,
        );
        return;
      }
    }

    // 先标记为 activating，防止 service:registered 事件导致重入
    entry.state = 'activating';

    // 所有依赖已满足，激活插件
    const ctx = this.rootCtx.fork(entry.module.name);
    entry.context = ctx;

    try {
      await entry.module.apply(ctx, entry.config);
      entry.state = 'active';
      entry.error = undefined;
      this.logger.info(`插件已激活: ${entry.module.name}`);
      await this.rootCtx.emit('plugin:loaded', entry.module.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`插件 "${entry.module.name}" 激活失败: ${message}`);
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
   * 当某个服务被移除时，停用依赖该服务的插件
   */
  private checkActivePlugins(removedService: string): void {
    for (const entry of this.plugins.values()) {
      if (entry.state !== 'active') continue;

      const dependsOnRemoved = entry.requiredDeps.some(
        dep => dep.service === removedService,
      );
      if (!dependsOnRemoved) continue;

      // 检查服务是否真的不可用了（可能还有其他提供者）
      const dep = entry.requiredDeps.find(d => d.service === removedService)!;
      if (this.rootCtx.hasService(dep.service, dep.capabilities.length > 0 ? dep.capabilities : undefined)) {
        continue; // 还有其他提供者
      }

      // 停用插件
      this.logger.info(`服务 "${removedService}" 不可用，停用插件: ${entry.module.name}`);
      if (entry.context) {
        entry.context.dispose();
        entry.context = undefined;
      }
      entry.state = 'pending';
      this.rootCtx.emit('plugin:unloaded', entry.module.name).catch(() => {});
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
  async ensureServiceProvider(
    serviceName: string,
    _resolving?: Set<string>,
  ): Promise<string | undefined> {
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
        this.logger.warn(`必需服务 "${serviceName}" 缺失，自动启用插件: ${candidate.module.name}`);
        candidate.state = 'pending';
        candidate.error = undefined;
        this.rootCtx.config.setPluginEnabled(candidate.module.name, true);
      } else {
        this.logger.warn(`必需服务 "${serviceName}" 缺失，尝试激活插件: ${candidate.module.name}`);
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
        return candidate.module.name;
      }
    }

    // 如果有 active 的候选者但服务仍然不存在，可能是插件 bug
    const active = candidates.find(e => e.state === 'active');
    if (active) {
      this.logger.warn(`插件 "${active.module.name}" 已激活但未提供 "${serviceName}" 服务`);
    }

    this.logger.error(`无法为必需服务 "${serviceName}" 找到可用的提供者`);
    return undefined;
  }
}

// ----- 辅助 -----

function normalizeDep(dep: DependencyDeclaration): NormalizedDependency {
  return normalizeDependency(dep);
}
