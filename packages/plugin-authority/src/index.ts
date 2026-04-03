import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Context, WebuiPage, ConfigManager, Logger, App, ToolService, CommandService, ExecutionGuardContext, AuthorityService, DangerousConfirmRequest, DangerousConfirmHandler } from '@aalis/core';

// ===== AuthorityManager 实现 =====

class AuthorityManager implements AuthorityService {
  private users = new Map<string, number>();
  private config: ConfigManager;
  private logger: Logger;
  private filePath: string;
  private dirty = false;
  private confirmHandlers = new Map<string, DangerousConfirmHandler>();

  constructor(config: ConfigManager, logger: Logger) {
    this.config = config;
    this.logger = logger.child('authority');
    this.filePath = resolve(config.getConfigDir(), 'data', 'users.json');
    this.load();
  }

  getAuthority(platform: string, userId?: string): number {
    if (!userId) return this.config.get('defaultAuthority') ?? 1;
    if (platform === 'webui' && userId === 'console') {
      return this.config.get('ownerAuthority') ?? 5;
    }
    const owners = this.config.get('owners') ?? [];
    if (owners.some((o: { platform: string; userId: string }) => o.platform === platform && o.userId === userId)) {
      return this.config.get('ownerAuthority') ?? 5;
    }
    const key = `${platform}:${userId}`;
    if (this.users.has(key)) return this.users.get(key)!;
    return this.config.get('defaultAuthority') ?? 1;
  }

  setAuthority(platform: string, userId: string, level: number): void {
    const key = `${platform}:${userId}`;
    this.users.set(key, level);
    this.dirty = true;
    this.logger.debug(`设置用户权限: ${key} → ${level}`);
  }

  isDangerousAllowed(name: string): boolean {
    const policy = this.config.get('dangerousPolicy');
    if (!policy?.allow || policy.allow.length === 0) return false;
    // 有限时策略时检查过期；缺少 enabledAt 视为已过期（重启后自动失效）
    if (policy.duration && policy.duration > 0) {
      if (!policy.enabledAt) return false;
      const elapsed = (Date.now() - policy.enabledAt) / 1000;
      if (elapsed > policy.duration) {
        this.logger.info('dangerous 白名单已过期');
        return false;
      }
    }
    if (policy.allow.includes('*')) return true;
    return policy.allow.includes(name);
  }

  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  async confirmDangerous(request: DangerousConfirmRequest): Promise<boolean> {
    if (this.isDangerousAllowed(request.name)) return true;
    const handler = this.confirmHandlers.get(request.platform);
    if (handler) {
      try {
        return await handler(request);
      } catch (err) {
        this.logger.warn(`高危确认回调异常: ${err}`);
        return false;
      }
    }
    return false;
  }

  isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    if (platform === 'webui' && userId === 'console') return true;
    const owners = this.config.get('owners') ?? [];
    return owners.some((o: { platform: string; userId: string }) => o.platform === platform && o.userId === userId);
  }

  listUsers(): Array<{ platform: string; userId: string; authority: number }> {
    const result: Array<{ platform: string; userId: string; authority: number }> = [];
    for (const [key, level] of this.users) {
      const idx = key.indexOf(':');
      result.push({
        platform: key.slice(0, idx),
        userId: key.slice(idx + 1),
        authority: level,
      });
    }
    return result;
  }

  save(): void {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: Record<string, number> = {};
      for (const [key, level] of this.users) data[key] = level;
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
      this.logger.debug('用户权限数据已保存');
    } catch (err) {
      this.logger.warn(`保存用户权限数据失败: ${err}`);
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number>;
      for (const [key, level] of Object.entries(data)) {
        if (typeof level === 'number') this.users.set(key, level);
      }
      this.logger.debug(`加载了 ${this.users.size} 条用户权限记录`);
    } catch (err) {
      this.logger.warn(`加载用户权限数据失败: ${err}`);
    }
  }
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-authority';
export const displayName = '权限管理';
export const provides = ['authority'];
export const inject = {
  optional: ['commands', 'tools'],
};

export const webuiPages: WebuiPage[] = [
  { key: 'authority', label: '权限管理', icon: 'authority', order: 50, renderer: 'authority' },
];

// ===== 插件入口 =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const authority = new AuthorityManager(ctx.config, ctx.logger);
  ctx.provide('authority', authority);

  // ===== 向 tools/commands 注入执行守卫 =====

  const guard = async (guardCtx: ExecutionGuardContext): Promise<string | null> => {
    const userAuth = authority.getAuthority(guardCtx.platform, guardCtx.userId);
    if (userAuth < guardCtx.authority) {
      return `权限不足: ${guardCtx.type === 'command' ? '指令' : '工具'} "${guardCtx.name}" 需要权限等级 ${guardCtx.authority}，当前用户等级 ${userAuth}`;
    }
    if (guardCtx.safety === 'dangerous' && !guardCtx.skipSafetyCheck) {
      const confirmed = await authority.confirmDangerous({
        name: guardCtx.name,
        type: guardCtx.type,
        args: guardCtx.args,
        sessionId: guardCtx.sessionId,
        platform: guardCtx.platform,
      });
      if (!confirmed) {
        return guardCtx.type === 'command'
          ? `已取消执行指令 ${guardCtx.name}。`
          : `用户已取消执行工具 "${guardCtx.name}"`;
      }
    }
    return null;
  };

  // 注入到已有的 tools/commands 服务
  const injectGuard = (svcName: string) => {
    if (svcName === 'tools' || svcName === 'commands') {
      const svc = ctx.getService<ToolService | CommandService>(svcName);
      svc?.setExecutionGuard(guard);
    }
  };

  // 当前已注册的服务立即注入
  injectGuard('tools');
  injectGuard('commands');

  // 未来注册的服务也注入
  ctx.on('service:registered', injectGuard);

  // ===== 应用停止时保存 =====
  ctx.on('app:stopping', () => { authority.save(); });

  // ===== 权限指令 =====

  // /grant — 设置用户权限等级
  ctx.command('grant', '设置用户权限 (用法: grant <platform:userId> <level>)', async (cmdCtx) => {
    if (cmdCtx.args.length < 2) {
      const prefix = ctx.commands!.prefix;
      return `用法: ${prefix}grant <platform:userId> <level>`;
    }
    const [target, levelStr] = cmdCtx.args;
    const level = parseInt(levelStr, 10);
    if (isNaN(level) || level < 0) {
      return '权限等级必须是非负整数。';
    }
    const callerAuth = authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
    if (level >= callerAuth) {
      return `不能将权限设置为 >= 您自身的等级 (${callerAuth})。`;
    }
    const sep = target.indexOf(':');
    if (sep < 1) {
      return '目标格式: <platform:userId>，例如 onebot:12345';
    }
    const platform = target.slice(0, sep);
    const userId = target.slice(sep + 1);
    authority.setAuthority(platform, userId, level);
    authority.save();
    return `已将 ${target} 的权限等级设置为 ${level}。`;
  }, { authority: 2 });

  // /authority — 查看当前用户权限等级
  ctx.command('authority', '查看自己或指定用户的权限等级', async (cmdCtx) => {
    if (cmdCtx.args.length > 0) {
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

// ===== WebUI 操作处理器 =====

export const webuiHandlers: Record<string, (ctx: Context, args: Record<string, unknown>) => Promise<unknown>> = {
  /** 获取权限概览 */
  async getOverview(ctx) {
    const auth = ctx.getService<AuthorityService>('authority');
    const users = auth?.listUsers() ?? [];
    const owners: Array<{ platform: string; userId: string }> = ctx.config.get('owners') ?? [];
    const commands = ctx.commands?.getAll() ?? [];
    const overrides = ctx.commands?.getOverrides() ?? {};
    const tools = ctx.tools?.getAll() ?? [];
    const toolOverrides = ctx.tools?.getOverrides() ?? {};
    return {
      users,
      owners,
      defaultAuthority: ctx.config.get('defaultAuthority') ?? 1,
      ownerAuthority: ctx.config.get('ownerAuthority') ?? 5,
      dangerousPolicy: ctx.config.get('dangerousPolicy') ?? {},
      commandPrefix: ctx.commands?.prefix ?? '/',
      commands: commands.map(c => {
        const o = overrides[c.name];
        return {
          name: c.name,
          description: c.description,
          authority: o?.authority ?? c.authority ?? 1,
          safety: o?.safety ?? c.safety ?? 'safe',
          baseAuthority: c.authority ?? 1,
          baseSafety: c.safety ?? 'safe',
          overridden: !!o,
          pluginName: c.pluginName,
        };
      }),
      commandOverrides: overrides,
      tools,
      toolOverrides,
    };
  },

  /** 设置用户权限等级 */
  async setUser(ctx, args) {
    const { platform, userId, authority } = args;
    if (!platform || !userId || typeof authority !== 'number') {
      throw new Error('platform, userId, authority(number) 必填');
    }
    if (authority < 0) throw new Error('权限等级必须 >= 0');
    const auth = ctx.getService<AuthorityService>('authority');
    auth?.setAuthority(platform as string, userId as string, authority);
    auth?.save();
    return { message: `${platform}:${userId} 权限已设为 ${authority}` };
  },

  /** 删除用户权限记录（回退到默认等级） */
  async deleteUser(ctx, args) {
    const { platform, userId } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    auth?.setAuthority(platform as string, userId as string, (ctx.config.get('defaultAuthority') ?? 1) as number);
    auth?.save();
    return { message: `${platform}:${userId} 权限已重置` };
  },

  /** 更新 owner 列表 */
  async setOwners(ctx, args) {
    const owners = args.owners;
    if (!Array.isArray(owners)) throw new Error('owners 必须是数组');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('owners', owners);
    app.saveConfig();
    return { message: 'Owner 列表已更新' };
  },

  /** 更新 dangerousPolicy */
  async setDangerousPolicy(ctx, args) {
    const policy = args.policy as Record<string, unknown>;
    if (!policy || typeof policy !== 'object') throw new Error('policy 必须是对象');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    // 设置激活时间戳，使 duration 限时机制生效
    if (Array.isArray(policy.allow) && policy.allow.length > 0) {
      policy.enabledAt = Date.now();
    }
    ctx.config.set('dangerousPolicy', policy);
    app.saveConfig();
    return { message: '高危策略已更新' };
  },

  /** 更新全局权限配置（defaultAuthority, ownerAuthority） */
  async setConfig(ctx, args) {
    const { defaultAuthority, ownerAuthority } = args;
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    if (typeof defaultAuthority === 'number') ctx.config.set('defaultAuthority', defaultAuthority);
    if (typeof ownerAuthority === 'number') ctx.config.set('ownerAuthority', ownerAuthority);
    app.saveConfig();
    return { message: '权限配置已更新' };
  },

  /** 更新单条指令的权限覆盖 */
  async setCommandOverride(ctx, args) {
    const { name, authority, safety } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    const override: { authority?: number; safety?: string } = {};
    if (typeof authority === 'number') override.authority = authority;
    if (typeof safety === 'string' && (safety === 'safe' || safety === 'dangerous')) override.safety = safety;
    if (Object.keys(override).length === 0) {
      ctx.commands?.removeOverride(name);
    } else {
      ctx.commands?.setOverride(name, override);
    }
    ctx.config.set('commandOverrides', ctx.commands?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 权限已更新` };
  },

  /** 重置指令覆盖 */
  async resetCommandOverride(ctx, args) {
    const { name } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    ctx.commands?.removeOverride(name);
    ctx.config.set('commandOverrides', ctx.commands?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 覆盖已重置` };
  },

  /** 更新单条工具的权限覆盖 */
  async setToolOverride(ctx, args) {
    const { name, authority, safety } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    const override: { authority?: number; safety?: string } = {};
    if (typeof authority === 'number') override.authority = authority;
    if (typeof safety === 'string' && (safety === 'safe' || safety === 'dangerous')) override.safety = safety;
    if (Object.keys(override).length === 0) {
      ctx.tools?.removeOverride(name);
    } else {
      ctx.tools?.setOverride(name, override);
    }
    ctx.config.set('toolOverrides', ctx.tools?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `工具 ${name} 权限已更新` };
  },

  /** 重置工具覆盖 */
  async resetToolOverride(ctx, args) {
    const { name } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    ctx.tools?.removeOverride(name);
    ctx.config.set('toolOverrides', ctx.tools?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `工具 ${name} 覆盖已重置` };
  },
};
