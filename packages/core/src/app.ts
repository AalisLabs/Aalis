import { EventBus } from './events.js';
import { ServiceContainer } from './service.js';
import { ToolRegistry } from './tools.js';
import { HookRegistry } from './hooks.js';
import { CommandRegistry } from './commands.js';
import { AuthorityManager } from './authority.js';
import { Context } from './context.js';
import { ConfigManager } from './config.js';
import { PluginManager, type PluginModule } from './plugin.js';
import { Logger, type LogLevel } from './logger.js';
import { InMemoryFallbackService } from './memory-fallback.js';
import type { AgentService, MemoryService, VectorStoreService, RegisteredCommand } from './types.js';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';

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
  readonly packagesDir: string;

  private events: EventBus;

  constructor(configPath?: string) {
    // 1. 核心子系统
    const config = new ConfigManager(configPath);
    this.events = new EventBus();
    const services = new ServiceContainer();
    this.logger = new Logger('aalis', config.get('logLevel') as LogLevel);
    const tools = new ToolRegistry(this.logger);
    const hooks = new HookRegistry();
    const commands = new CommandRegistry(this.logger);
    commands.prefix = config.get('commandPrefix') ?? '/';
    commands.globalAsTools = config.get('commandAsTools') ?? false;

    // 加载管理员对指令的覆盖配置
    const cmdOverrides = config.get('commandOverrides');
    if (cmdOverrides) commands.loadOverrides(cmdOverrides);

    // 1.5 权限管理
    const authority = new AuthorityManager(config, this.logger);
    commands.setAuthority(authority);
    tools.setAuthority(authority);

    // 指令 → 工具桥接: 当指令声明 asTools 时自动注册为 AI 工具
    commands.onToolBridge = (cmd: RegisteredCommand) => {
      return tools.register(
        {
          definition: {
            type: 'function' as const,
            function: {
              name: `cmd_${cmd.name}`,
              description: `[指令] ${cmd.description}`,
              parameters: {
                type: 'object',
                properties: {
                  args: { type: 'string', description: '指令参数(空格分隔)' },
                },
                required: [],
              },
            },
          },
          handler: async (args, callCtx) => {
            const argsStr = typeof args.args === 'string' ? args.args : '';
            const result = await commands.execute(cmd.name, {
              args: argsStr ? argsStr.split(/\s+/) : [],
              raw: `${commands.prefix}${cmd.name}${argsStr ? ' ' + argsStr : ''}`,
              sessionId: callCtx.sessionId,
              platform: callCtx.platform ?? 'unknown',
              userId: callCtx.userId,
            });
            return result ?? '(指令已执行)';
          },
          safety: cmd.safety,
          authority: cmd.authority,
        },
        cmd.pluginName,
      );
    };

    // 2. 根上下文
    this.ctx = new Context({
      id: 'root',
      events: this.events,
      services,
      tools,
      hooks,
      commands,
      authority,
      logger: this.logger,
      config,
    });

    // 3. 插件管理器
    this.plugins = new PluginManager(this.ctx, this.logger);
    this.packagesDir = resolve(process.cwd(), 'packages');

    // 4. 注册核心服务（让插件能通过 ctx.getService 访问）
    this.ctx.provide('app', this, { capabilities: ['lifecycle', 'config'] });

    // 5. 注册内置指令
    this.registerBuiltinCommands();

    this.logger.info(`Aalis v0.1.0 - ${config.get('name')}`);
  }

  /**
   * 注册插件
   */
  async plugin(module: PluginModule, config?: Record<string, unknown>): Promise<void> {
    // 合并优先级: 插件默认配置 ← 配置文件 ← 代码传入
    const defaults = module.defaultConfig ?? {};
    const fileConfig = this.ctx.config.getPluginConfig(module.name);
    const mergedConfig = { ...defaults, ...fileConfig, ...config };
    await this.plugins.register(module, mergedConfig);
  }

  /**
   * 自动扫描 packages/ 目录，动态加载所有插件
   *
   * 规则:
   * - 跳过 package.json 中标记 `"aalis": { "core": true }` 的包
   * - 其余包全部视为插件，通过 dynamic import() 加载
   */
  async autoLoadPlugins(packagesDir?: string): Promise<void> {
    const dir = packagesDir ?? this.packagesDir;
    const discovered = await this.discoverPlugins(dir);
    this.logger.info(`发现 ${discovered.length} 个插件`);

    for (const pkg of discovered) {
      try {
        const mod = await import(pathToFileURL(pkg.entry).href) as PluginModule;
        await this.plugin(mod);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`加载插件 "${pkg.name}" 失败: ${message}`);
      }
    }

    // 将插件默认配置中缺失的字段同步到配置文件
    this.syncPluginDefaults();

    // 确保核心配置的所有字段都落盘到 YAML（补齐用户可能缺少的条目）
    this.saveConfig();
  }

  /**
   * 将各插件 defaultConfig 中缺失的字段同步到配置文件，
   * 同时移除 configSchema 中未定义的多余字段
   */
  private syncPluginDefaults(): void {
    const plugins = this.plugins.getStatus();
    let changed = false;

    for (const plugin of plugins) {
      const defaults = plugin.defaultConfig ?? {};
      const schema = plugin.configSchema;
      const fileConfig = this.ctx.config.getPluginConfig(plugin.name);

      // 步骤 1: 补充缺失的默认值
      let merged = this.deepMergeDefaults(defaults, fileConfig);

      // 步骤 2: 移除 schema 中未定义的多余字段
      if (schema && Object.keys(schema).length > 0) {
        merged = this.removeExtraFields(merged, schema);
      }

      if (JSON.stringify(merged) !== JSON.stringify(fileConfig)) {
        this.ctx.config.setPluginConfig(plugin.name, merged);
        changed = true;
        this.logger.debug(`同步插件配置: ${plugin.name}`);
      }
    }

    if (changed) {
      this.ctx.config.save();
      this.logger.info('已将插件配置同步到配置文件');
    }
  }

  /**
   * 根据 configSchema 移除多余字段
   * SchemaGroup (含 fields) 对应嵌套对象，SchemaArray (type=array) 直接保留，SchemaField 对应普通字段
   */
  private removeExtraFields(
    config: Record<string, unknown>,
    schema: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (!(key in schema)) continue; // 多余字段，丢弃
      const schemaDef = schema[key] as Record<string, unknown>;
      // SchemaArray: type === 'array'，数组内容由用户管理，直接保留
      if (schemaDef.type === 'array') {
        result[key] = value;
      // SchemaGroup: 有 fields 子对象，递归清理
      } else if (schemaDef.fields && typeof schemaDef.fields === 'object'
        && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.removeExtraFields(
          value as Record<string, unknown>,
          schemaDef.fields as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 深度合并默认值：只填充缺失的键，不覆盖已有值
   */
  private deepMergeDefaults(
    defaults: Record<string, unknown>,
    current: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...current };
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (!(key in result)) {
        result[key] = defaultValue;
      } else if (
        defaultValue !== null &&
        typeof defaultValue === 'object' &&
        !Array.isArray(defaultValue) &&
        result[key] !== null &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        // 嵌套对象递归合并
        result[key] = this.deepMergeDefaults(
          defaultValue as Record<string, unknown>,
          result[key] as Record<string, unknown>,
        );
      }
    }
    return result;
  }

  /**
   * 重新扫描 packages/ 目录，加载新发现的插件（已注册的跳过）
   * 返回新加载的插件名列表
   */
  async rescanPlugins(): Promise<string[]> {
    const discovered = await this.discoverPlugins(this.packagesDir);
    const loaded: string[] = [];

    for (const pkg of discovered) {
      // 跳过已注册的
      if (this.plugins.getPlugin(pkg.name)) continue;

      try {
        const mod = await import(pathToFileURL(pkg.entry).href) as PluginModule;
        await this.plugin(mod);
        loaded.push(pkg.name);
        this.logger.info(`热加载插件: ${pkg.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`热加载插件 "${pkg.name}" 失败: ${message}`);
      }
    }

    return loaded;
  }

  /**
   * 从 npm 安装插件到 packages/ 目录并加载
   * @param npmPkg npm 包名，如 "@aalis/plugin-example"
   * @returns 安装结果
   */
  async installPlugin(npmPkg: string): Promise<{ ok: boolean; message: string }> {
    // 从包名推导目录名: @aalis/plugin-xxx → plugin-xxx
    const dirName = npmPkg.replace(/^@[^/]+\//, '');
    const targetDir = resolve(this.packagesDir, dirName);

    if (existsSync(targetDir)) {
      return { ok: false, message: `目录 ${dirName} 已存在` };
    }

    this.logger.info(`正在安装插件: ${npmPkg} → packages/${dirName}`);

    try {
      // 使用 npm pack 下载到临时目录，然后解压到 packages/
      const tempTgz = resolve(this.packagesDir, `${dirName}.tgz`);

      await this.exec('npm', ['pack', npmPkg, '--pack-destination', this.packagesDir]);

      // npm pack 产出的文件名格式: scope-name-version.tgz
      // 找到 tgz 文件
      const dirents = await readdir(this.packagesDir);
      const tgzFile = dirents.find(f =>
        f.endsWith('.tgz') && f.includes(dirName),
      );
      if (!tgzFile) {
        return { ok: false, message: '下载包失败: 未找到 tgz 文件' };
      }

      const tgzPath = resolve(this.packagesDir, tgzFile);

      // 创建目录并解压
      await this.exec('mkdir', ['-p', targetDir]);
      await this.exec('tar', ['xzf', tgzPath, '-C', targetDir, '--strip-components=1']);

      // 清理 tgz
      await this.exec('rm', ['-f', tgzPath]);

      // 安装依赖
      await this.exec('pnpm', ['install', '--filter', npmPkg], process.cwd());

      // 加载插件
      const newPlugins = await this.rescanPlugins();

      if (newPlugins.length > 0) {
        return { ok: true, message: `已安装并加载: ${newPlugins.join(', ')}` };
      } else {
        return { ok: true, message: `已安装到 packages/${dirName}，但未发现新插件` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`安装插件 "${npmPkg}" 失败: ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * 卸载插件：停用并删除 packages/ 下的目录
   */
  async uninstallPlugin(pluginName: string): Promise<{ ok: boolean; message: string }> {
    // 先卸载
    await this.plugins.unload(pluginName);

    // 从包名推导目录名
    const dirName = pluginName.replace(/^@[^/]+\//, '');
    const targetDir = resolve(this.packagesDir, dirName);

    if (!existsSync(targetDir)) {
      return { ok: true, message: `插件 ${pluginName} 已卸载（目录不存在）` };
    }

    try {
      await this.exec('rm', ['-rf', targetDir]);
      this.logger.info(`已删除插件目录: packages/${dirName}`);
      return { ok: true, message: `插件 ${pluginName} 已卸载并删除` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  // ---- 内部方法 ----

  /**
   * 扫描目录，返回可加载的插件列表
   */
  private async discoverPlugins(dir: string): Promise<Array<{ name: string; dir: string; entry: string }>> {
    this.logger.info(`正在扫描插件目录: ${dir}`);

    let entries: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents
        .filter(d => d.isDirectory() || d.isSymbolicLink())
        .map(d => d.name);
    } catch {
      this.logger.warn(`无法读取 packages 目录: ${dir}`);
      return [];
    }

    const discovered: Array<{ name: string; dir: string; entry: string }> = [];

    for (const entry of entries) {
      const pkgJsonPath = resolve(dir, entry, 'package.json');
      let pkgJson: Record<string, unknown>;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      } catch {
        this.logger.debug(`跳过 ${entry}: 无法读取 package.json`);
        continue;
      }

      // 跳过标记为 core 的包
      const aalisMeta = pkgJson['aalis'] as Record<string, unknown> | undefined;
      if (aalisMeta?.core) {
        this.logger.debug(`跳过核心包: ${pkgJson['name']}`);
        continue;
      }

      const main = (pkgJson['main'] as string) || 'dist/index.js';
      discovered.push({
        name: pkgJson['name'] as string,
        dir: resolve(dir, entry),
        entry: resolve(dir, entry, main),
      });
    }

    return discovered;
  }

  private exec(cmd: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, {
        cwd: cwd ?? this.packagesDir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  /**
   * 保存当前配置到磁盘
   */
  saveConfig(): void {
    this.ctx.config.save();
    this.logger.info('配置已保存');
  }

  /**
   * 注册内置指令 (/help, /status)
   */
  private registerBuiltinCommands(): void {
    // /help — 动态列出所有已注册指令（Markdown 格式）
    this.ctx.command('help', '显示可用指令列表', async () => {
      const all = this.ctx.commands.getAll();
      const prefix = this.ctx.commands.prefix;
      const lines = ['**可用指令：**', ''];
      for (const cmd of all) {
        lines.push(`- \`${prefix}${cmd.name}\` — ${cmd.description}`);
      }
      return lines.join('\n');
    });

    // /status — 显示系统状态（Markdown 格式）
    this.ctx.command('status', '显示系统状态', async () => {
      const lines = ['**系统状态：**', ''];
      const checks = [
        ['LLM 服务', this.ctx.hasService('llm')],
        ['记忆服务', this.ctx.hasService('memory')],
        ['人格服务', this.ctx.hasService('persona')],
        ['Embedding', this.ctx.hasService('embedding')],
        ['向量库', this.ctx.hasService('vectorstore')],
      ] as const;
      for (const [label, ok] of checks) {
        lines.push(`- ${label}: ${ok ? '✅ 可用' : '❌ 不可用'}`);
      }
      const tools = this.ctx.tools.getDefinitions();
      lines.push(`- 已注册工具: ${tools.length} 个`);
      const cmds = this.ctx.commands.getAll();
      lines.push(`- 已注册指令: ${cmds.length} 个`);
      return lines.join('\n');
    });

    // /shutdown — 关闭应用
    this.ctx.command('shutdown', '关闭应用', async () => {
      // 异步执行，先返回消息再关闭
      setTimeout(async () => {
        await this.stop();
        process.exit(0);
      }, 500);
      return '正在关闭应用…';
    }, { authority: 5, safety: 'dangerous' });

    // /restart — 重新启动应用（重新执行原始启动命令）
    this.ctx.command('restart', '重启应用', async () => {
      setTimeout(async () => {
        await this.stop();
        const scriptFile = process.argv[1];
        let exec: string;
        let args: string[];
        if (scriptFile?.endsWith('.ts')) {
          // tsx 运行时 argv[0] 是 node，需要用 tsx 重新启动
          const tsxBin = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
          exec = existsSync(tsxBin) ? tsxBin : 'tsx';
          args = process.argv.slice(1);
        } else {
          [exec, ...args] = process.argv;
        }
        const child = spawn(exec, args, {
          cwd: process.cwd(),
          stdio: 'inherit',
          detached: true,
          env: process.env,
        });
        child.unref();
        process.exit(0);
      }, 500);
      return '正在重启应用…';
    }, { authority: 5, safety: 'dangerous' });

    // /grant — 设置用户权限等级（只能授予低于自身等级的权限）
    this.ctx.command('grant', '设置用户权限 (用法: grant <platform:userId> <level>)', async (cmdCtx) => {
      if (cmdCtx.args.length < 2) {
        const prefix = this.ctx.commands.prefix;
        return `用法: ${prefix}grant <platform:userId> <level>`;
      }
      const [target, levelStr] = cmdCtx.args;
      const level = parseInt(levelStr, 10);
      if (isNaN(level) || level < 0) {
        return '权限等级必须是非负整数。';
      }
      const callerAuth = this.ctx.authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
      if (level >= callerAuth) {
        return `不能将权限设置为 >= 您自身的等级 (${callerAuth})。`;
      }
      const sep = target.indexOf(':');
      if (sep < 1) {
        return '目标格式: <platform:userId>，例如 onebot:12345';
      }
      const platform = target.slice(0, sep);
      const userId = target.slice(sep + 1);
      this.ctx.authority.setAuthority(platform, userId, level);
      this.ctx.authority.save();
      return `已将 ${target} 的权限等级设置为 ${level}。`;
    }, { authority: 2 });

    // /authority — 查看当前用户权限等级
    this.ctx.command('authority', '查看自己或指定用户的权限等级', async (cmdCtx) => {
      const authority = this.ctx.authority;
      if (cmdCtx.args.length > 0) {
        // 查看指定用户
        const target = cmdCtx.args[0];
        const sep = target.indexOf(':');
        if (sep < 1) return '目标格式: <platform:userId>';
        const level = authority.getAuthority(target.slice(0, sep), target.slice(sep + 1));
        return `${target} 的权限等级: ${level}`;
      }
      const level = authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
      const isOwner = authority.isOwner(cmdCtx.platform, cmdCtx.userId);
      return `您的权限等级: ${level}${isOwner ? ' (owner)' : ''}`;
    });
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

      // fallback 场景下也注册 /clear
      this.ctx.command('clear', '清空当前会话历史及长期记忆', async (cmdCtx) => {
        await fallback.clearSession(cmdCtx.sessionId);
        // 同时清空向量记忆
        const vectorstore = this.ctx.getService<VectorStoreService>('vectorstore');
        if (vectorstore) {
          await vectorstore.clear();
          this.logger.info('向量记忆已清空');
        }
        return '会话历史与长期记忆已清空。';
      });
    }

    // 应用配置文件中的服务偏好
    const prefs = this.ctx.config.getServicePreferences();
    for (const [service, contextId] of Object.entries(prefs)) {
      this.ctx.preferService(service, contextId);
    }

    // 将 message:received 事件路由到 agent 服务
    // Agent 现在是一个可替换的服务，由 plugin-agent-default 或任何外部插件提供
    this.ctx.on('message:received', async (msg) => {
      const agent = this.ctx.getService<AgentService>('agent');
      if (agent) {
        await agent.handleMessage(msg);
      } else {
        this.logger.warn('Agent 服务不可用，消息将不会被处理');
        await this.ctx.emit('message:send', {
          content: '[系统] Agent 服务不可用，请检查插件配置。',
          sessionId: msg.sessionId,
          platform: msg.platform,
        });
      }
    });

    // 发出 ready 事件
    await this.ctx.emit('ready');
    this.logger.info('启动完成');
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    this.logger.info('正在停止...');
    this.ctx.authority.save();
    await this.ctx.emit('dispose');
    this.ctx.dispose();
    this.logger.info('已停止');
  }
}
