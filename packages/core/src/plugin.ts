import { Context } from './context.js';
import { normalizeDependency, type NormalizedDependency } from './service.js';
import type { InjectDeclaration, DependencyDeclaration } from './types.js';
import type { Logger } from './logger.js';

// ----- 插件定义格式 -----

export interface PluginModule {
  name: string;
  inject?: InjectDeclaration;
  provides?: string[];
  /** 标记为 core 的插件不能被用户禁用 */
  core?: boolean;
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

  constructor(rootCtx: Context, logger: Logger) {
    this.rootCtx = rootCtx;
    this.logger = logger.child('plugin');

    // 监听服务注册/注销，自动激活/停用插件
    rootCtx.on('service:registered', () => {
      this.checkPendingPlugins();
    });
    rootCtx.on('service:unregistered', (name) => {
      this.checkActivePlugins(name);
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
    await this.tryActivate(entry);
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

    if (entry.state === 'active' && entry.context) {
      entry.context.dispose();
      entry.context = undefined;
      this.rootCtx.emit('plugin:unloaded', name).catch(() => {});
    }

    entry.state = 'disabled';
    this.rootCtx.config.setPluginEnabled(name, false);
    this.logger.info(`插件已禁用: ${name}`);
    return true;
  }

  /**
   * 获取所有已注册插件的状态
   */
  getStatus(): Array<{ name: string; state: PluginState; provides?: string[]; core?: boolean; config: Record<string, unknown>; error?: string }> {
    return [...this.plugins.entries()].map(([name, entry]) => ({
      name,
      state: entry.state,
      provides: entry.module.provides,
      core: entry.module.core,
      config: entry.config,
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
      await this.tryActivate(entry);
    }

    return true;
  }

  // ---- 内部逻辑 ----

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
}

// ----- 辅助 -----

function normalizeDep(dep: DependencyDeclaration): NormalizedDependency {
  return normalizeDependency(dep);
}
