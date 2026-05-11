import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Context, ConfigManager, Logger, App } from '@aalis/core';
import type { ExecutionGuardContext } from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import type {} from '@aalis/plugin-webui-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import type { AuthorityService, DangerousConfirmRequest, DangerousConfirmHandler, DangerousConfirmResult, DangerousGrant } from './types.js';

export type { AuthorityService, DangerousConfirmRequest, DangerousConfirmHandler, DangerousConfirmResult, DangerousGrant, DangerousGrantRequest } from './types.js';

// ===== AuthorityManager 实现 =====

class AuthorityManager implements AuthorityService {
  private users = new Map<string, number>();
  private config: ConfigManager;
  private logger: Logger;
  private filePath: string;
  private dirty = false;
  private confirmHandlers = new Map<string, DangerousConfirmHandler>();
  private dangerousGrants = new Map<string, DangerousGrant>();
  private grantSeq = 0;

  constructor(config: ConfigManager, logger: Logger) {
    this.config = config;
    this.logger = logger.child('authority');
    this.filePath = resolve(config.getConfigDir(), 'data', 'users.json');
    this.load();
  }

  getAuthority(platform: string, userId?: string): number {
    if (!userId) return this.config.get('defaultAuthority') ?? 1;
    if ((platform === 'webui' || platform === 'cli') && userId === 'console') {
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

  isDangerousAllowed(name: string, permissions: string[] = []): boolean {
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
    return this.matchAny(policy.allow, [name, ...permissions]);
  }

  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  async confirmDangerous(request: DangerousConfirmRequest): Promise<boolean> {
    if (this.isDangerousAllowed(request.name, request.permissions)) return true;
    const grant = this.consumeDangerousGrant(request);
    if (grant) {
      this.logger.info(`命中高危会话授权: ${request.type}:${request.name} session=${request.sessionId} grant=${grant.id} used=${grant.used}${grant.maxUses ? `/${grant.maxUses}` : ''}`);
      return true;
    }
    const handler = this.confirmHandlers.get(request.platform);
    if (handler) {
      try {
        const result = await handler(request);
        const normalized = this.normalizeConfirmResult(result);
        if (normalized.allowed && normalized.grant?.scope === 'session') {
          this.createDangerousGrant(request, normalized);
        }
        return normalized.allowed;
      } catch (err) {
        this.logger.warn(`高危确认回调异常: ${err}`);
        return false;
      }
    }
    return false;
  }

  checkPermissionPolicy(permissions: string[]): string | null {
    const policy = this.config.get('permissionPolicy') as { allow?: string[]; deny?: string[] } | undefined;
    if (!policy) return null;
    const deny = policy.deny ?? [];
    if (deny.length > 0 && this.matchAny(deny, permissions)) {
      return `权限策略拒绝: ${permissions.join(', ')}`;
    }
    const allow = policy.allow ?? [];
    if (allow.length > 0 && !this.matchAny(allow, permissions)) {
      return `权限策略未允许: ${permissions.join(', ')}`;
    }
    return null;
  }

  private matchAny(patterns: string[], values: string[]): boolean {
    return patterns.some(pattern => values.some(value => this.matchPattern(pattern, value)));
  }

  private matchPattern(pattern: string, value: string): boolean {
    if (pattern === '*' || pattern === value) return true;
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value);
  }

  listDangerousGrants(): DangerousGrant[] {
    this.pruneDangerousGrants();
    return [...this.dangerousGrants.values()].map(grant => ({ ...grant }));
  }

  revokeDangerousGrant(id: string): boolean {
    const ok = this.dangerousGrants.delete(id);
    if (ok) this.logger.info(`已撤销高危会话授权: ${id}`);
    return ok;
  }

  private normalizeConfirmResult(result: boolean | DangerousConfirmResult): DangerousConfirmResult {
    return typeof result === 'boolean' ? { allowed: result } : result;
  }

  private consumeDangerousGrant(request: DangerousConfirmRequest): DangerousGrant | undefined {
    this.pruneDangerousGrants();
    for (const grant of this.dangerousGrants.values()) {
      if (grant.type !== request.type) continue;
      if (grant.name !== request.name) continue;
      if (grant.sessionId !== request.sessionId) continue;
      if (grant.platform !== request.platform) continue;
      if (grant.userId && request.userId && grant.userId !== request.userId) continue;
      if (!this.samePermissions(grant.permissions, request.permissions)) continue;
      grant.used++;
      if (grant.maxUses && grant.used >= grant.maxUses) {
        this.dangerousGrants.delete(grant.id);
      }
      return grant;
    }
    return undefined;
  }

  private createDangerousGrant(request: DangerousConfirmRequest, result: DangerousConfirmResult): void {
    const grantRequest = result.grant;
    if (!grantRequest || grantRequest.scope !== 'session') return;
    const durationSeconds = Math.max(1, Math.min(grantRequest.durationSeconds ?? 600, 3600));
    const grant: DangerousGrant = {
      id: `grant_${Date.now()}_${++this.grantSeq}`,
      name: request.name,
      type: request.type,
      permissions: request.permissions,
      sessionId: request.sessionId,
      platform: request.platform,
      userId: request.userId,
      expiresAt: Date.now() + durationSeconds * 1000,
      maxUses: grantRequest.maxUses,
      used: 0,
      createdAt: Date.now(),
    };
    this.dangerousGrants.set(grant.id, grant);
    this.logger.info(`创建高危会话授权: ${request.type}:${request.name} session=${request.sessionId} duration=${durationSeconds}s maxUses=${grant.maxUses ?? 'unlimited'} grant=${grant.id}`);
  }

  private pruneDangerousGrants(): void {
    const now = Date.now();
    for (const [id, grant] of this.dangerousGrants) {
      if (grant.expiresAt <= now || (grant.maxUses && grant.used >= grant.maxUses)) {
        this.dangerousGrants.delete(id);
        this.logger.debug(`高危会话授权已过期: ${id}`);
      }
    }
  }

  private samePermissions(a: string[] | undefined, b: string[] | undefined): boolean {
    const left = [...new Set(a ?? [])].sort();
    const right = [...new Set(b ?? [])].sort();
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    if ((platform === 'webui' || platform === 'cli') && userId === 'console') return true;
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
      return `权限不足: 指令 "${guardCtx.name}" 需要权限等级 ${guardCtx.authority}，当前用户等级 ${userAuth}`;
    }
    const permissionDenied = authority.checkPermissionPolicy(guardCtx.permissions ?? [`${guardCtx.type}:${guardCtx.name}`]);
    if (permissionDenied) return permissionDenied;
    if (guardCtx.safety === 'dangerous' && !guardCtx.skipSafetyCheck) {
      const confirmed = await authority.confirmDangerous({
        name: guardCtx.name,
        type: guardCtx.type,
        args: guardCtx.args,
        permissions: guardCtx.permissions,
        sessionId: guardCtx.sessionId,
        platform: guardCtx.platform,
        userId: guardCtx.userId,
      });
      if (!confirmed) {
        return `已取消执行${guardCtx.type === 'command' ? '指令' : '工具'} ${guardCtx.name}。`;
      }
    }
    return null;
  };

  // 注入到已有的 commands/tools 服务
  const injectGuard = (svcName: string) => {
    if (svcName === 'commands') {
      const svc = ctx.getService<CommandService>(svcName);
      if (svc?.setExecutionGuard) {
        svc.setExecutionGuard(guard);
        ctx.logger.debug(`权限守卫已注入: ${svcName}`);
      }
    } else if (svcName === 'tools') {
      const svc = ctx.getService<ToolService>(svcName);
      if (svc?.setExecutionGuard) {
        svc.setExecutionGuard(guard);
        ctx.logger.debug(`权限守卫已注入: ${svcName}`);
      }
    }
  };

  // 当前已注册的服务立即注入
  injectGuard('tools');
  injectGuard('commands');

  // 未来注册的服务也注入（处理 authority 先于 commands 加载的情况）
  ctx.on('service:registered', (name: string) => injectGuard(name));

  // ===== 应用停止时保存 =====
  ctx.on('app:stopping', () => { authority.save(); });

  // ===== 权限指令 =====

  // /grant — 设置用户权限等级
  ctx.command('grant', '设置用户权限 (用法: grant <platform:userId> <level>)', async (cmdCtx) => {
    if (cmdCtx.args.length < 2) {
      const prefix = ctx.getService<CommandService>('commands')!.prefix;
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
    const overrides = ctx.getService<CommandService>('commands')?.getOverrides() ?? {};
    // 扁平化所有指令节点（含递归子指令），按深度优先顺序，便于 UI 表格渲染
    const cmdNodes = ctx.getService<CommandService>('commands')?.getAllNodes() ?? [];
    const tools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    // 当前已注册的平台 contextId 列表（用于 WebUI 下拉选择，避免手写）
    const platformEntries = ctx.serviceContainer?.getEntries?.('platform') ?? [];
    const platformsFromServices = platformEntries.map(e => e.contextId);
    const platformsFromUsers = users.map(u => u.platform);
    const platformsFromOwners = owners.map(o => o.platform);
    const platforms = Array.from(new Set([
      ...platformsFromServices,
      ...platformsFromUsers,
      ...platformsFromOwners,
    ])).filter(Boolean);
    return {
      users,
      owners,
      platforms,
      defaultAuthority: ctx.config.get('defaultAuthority') ?? 1,
      ownerAuthority: ctx.config.get('ownerAuthority') ?? 5,
      dangerousPolicy: ctx.config.get('dangerousPolicy') ?? {},
      permissionPolicy: ctx.config.get('permissionPolicy') ?? {},
      dangerousGrants: auth?.listDangerousGrants() ?? [],
      commandPrefix: ctx.getService<CommandService>('commands')?.prefix ?? '/',
      commands: cmdNodes.map(n => ({
        // key 同时是 override 的查找键与 setCommandOverride 的入参；如 'clear:all'
        key: n.key,
        // 兼容字段：旧前端使用 c.name 做 React key —— 这里给完整 key
        name: n.key,
        // 用于显示，如 '/clear nuke'
        displayName: `${ctx.getService<CommandService>('commands')?.prefix ?? '/'}${n.path.join(' ')}`,
        // 路径段名（'nuke'）用于子行紧凑显示
        leafName: n.name,
        path: n.path,
        depth: n.depth,
        isRoot: n.isRoot,
        hasSubcommands: n.hasSubcommands,
        hasAction: n.hasAction,
        description: n.description,
        authority: n.authority,
        safety: n.safety,
        permissions: n.permissions,
        baseAuthority: n.baseAuthority,
        baseSafety: n.baseSafety,
        basePermissions: n.basePermissions,
        overridden: n.overridden,
        pluginName: n.pluginName,
      })),
      commandOverrides: overrides,
      tools,
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

  /** 撤销一个高危会话授权 */
  async revokeDangerousGrant(ctx, args) {
    const id = args.id as string;
    if (!id) throw new Error('id 必须是字符串');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const ok = auth.revokeDangerousGrant(id);
    return { ok, message: ok ? '授权已撤销' : '授权不存在或已过期' };
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
      ctx.getService<CommandService>('commands')?.removeOverride(name);
    } else {
      ctx.getService<CommandService>('commands')?.setOverride(name, override);
    }
    ctx.config.set('commandOverrides', ctx.getService<CommandService>('commands')?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 权限已更新` };
  },

  /** 重置指令覆盖 */
  async resetCommandOverride(ctx, args) {
    const { name } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<App>('app');
    if (!app) throw new Error('App 不可用');
    ctx.getService<CommandService>('commands')?.removeOverride(name);
    ctx.config.set('commandOverrides', ctx.getService<CommandService>('commands')?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 覆盖已重置` };
  },

};
