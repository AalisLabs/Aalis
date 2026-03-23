import { EventBus } from './events.js';
import { ServiceContainer } from './service.js';
import { ToolRegistry } from './tools.js';
import { HookRegistry } from './hooks.js';
import { Context } from './context.js';
import { ConfigManager } from './config.js';
import { PluginManager, type PluginModule } from './plugin.js';
import { Logger, type LogLevel } from './logger.js';
import { Agent } from './agent.js';
import { InMemoryFallbackService } from './memory-fallback.js';

/**
 * Aalis 应用主容器
 *
 * 职责:
 * - 初始化所有核心子系统 (事件总线, 服务容器, 工具注册表, 配置)
 * - 创建根 Context
 * - 管理插件生命周期
 * - 启动 Agent
 */
export class App {
  readonly ctx: Context;
  readonly plugins: PluginManager;
  readonly logger: Logger;

  private events: EventBus;
  private agent?: Agent;

  constructor(configPath?: string) {
    // 1. 核心子系统
    const config = new ConfigManager(configPath);
    this.events = new EventBus();
    const services = new ServiceContainer();
    this.logger = new Logger('aalis', config.get('logLevel') as LogLevel);
    const tools = new ToolRegistry(this.logger);
    const hooks = new HookRegistry();

    // 2. 根上下文
    this.ctx = new Context({
      id: 'root',
      events: this.events,
      services,
      tools,
      hooks,
      logger: this.logger,
      config,
    });

    // 3. 插件管理器
    this.plugins = new PluginManager(this.ctx, this.logger);

    // 4. 注册核心服务（让插件能通过 ctx.getService 访问）
    this.ctx.provide('app', this, { capabilities: ['lifecycle', 'config'] });

    this.logger.info(`Aalis v0.1.0 - ${config.get('name')}`);
  }

  /**
   * 注册插件
   */
  async plugin(module: PluginModule, config?: Record<string, unknown>): Promise<void> {
    // 合并配置: 代码传入的 config 优先于配置文件中的
    const fileConfig = this.ctx.config.getPluginConfig(module.name);
    const mergedConfig = { ...fileConfig, ...config };
    await this.plugins.register(module, mergedConfig);
  }

  /**
   * 保存当前配置到磁盘
   */
  saveConfig(): void {
    this.ctx.config.save();
    this.logger.info('配置已保存');
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    this.logger.info('正在启动...');

    // 检查是否有 memory 服务，没有则注册 fallback
    if (!this.ctx.hasService('memory')) {
      this.logger.warn('未检测到记忆服务插件，启用内存 fallback (数据不会持久化)');
      const fallback = new InMemoryFallbackService();
      this.ctx.provide('memory', fallback, {
        capabilities: ['history'],
        priority: -100, // 最低优先级
      });
    }

    // 应用配置文件中的服务偏好
    const prefs = this.ctx.config.getServicePreferences();
    for (const [service, contextId] of Object.entries(prefs)) {
      this.ctx.preferService(service, contextId);
    }

    // 初始化 Agent
    this.agent = new Agent(this.ctx);

    // 发出 ready 事件
    await this.ctx.emit('ready');
    this.logger.info('启动完成');
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    this.logger.info('正在停止...');
    await this.ctx.emit('dispose');
    this.ctx.dispose();
    this.logger.info('已停止');
  }
}
