import type { AppService, ConfigManager, Context, Logger, SafetyLevel } from '@aalis/core';
import type { ExecutionGuardContext, UserIdentity } from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import type {
  AuthorityService,
  DangerousConfirmHandler,
  DangerousConfirmRequest,
  DangerousConfirmResult,
  DangerousGrant,
} from './types.js';

export type {
  AuthorityService,
  DangerousConfirmHandler,
  DangerousConfirmRequest,
  DangerousConfirmResult,
  DangerousGrant,
  DangerousGrantRequest,
} from './types.js';

// ===== AuthorityManager 实现 =====

export class AuthorityManager implements AuthorityService {
  private users = new Map<string, number>();
  private config: ConfigManager;
  private logger: Logger;
  private storage: StorageService;
  private fileUri: string;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();
  private confirmHandlers = new Map<string, DangerousConfirmHandler>();
  private dangerousGrants = new Map<string, DangerousGrant>();
  private grantSeq = 0;
  /**
   * dangerous 策略的开启时间（运行时状态，不序列化到 config）。
   * 进程重启后重置为 null，对限时策略而言等同于「重启即失效」。
   */
  private dangerousEnabledAt: number | null = null;

  constructor(config: ConfigManager, logger: Logger, storage: StorageService) {
    this.config = config;
    this.logger = logger.child('authority');
    this.storage = storage;
    this.fileUri = 'data:/users.json';
  }

  getAuthority(platform: string, userId?: string): number {
    if (!userId) return this.config.get('defaultAuthority') ?? 1;
    if ((platform === 'webui' || platform === 'cli') && userId === 'console') {
      return this.config.get('ownerAuthority') ?? 5;
    }
    const owners = this.config.get('owners') ?? [];
    if (owners.some((o: UserIdentity) => o.platform === platform && o.userId === userId)) {
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
    // 有限时策略时检查过期；未记录 enabledAt 视为未启用（重启后自动失效）
    if (policy.duration && policy.duration > 0) {
      if (!this.dangerousEnabledAt) return false;
      const elapsed = (Date.now() - this.dangerousEnabledAt) / 1000;
      if (elapsed > policy.duration) {
        this.logger.info('dangerous 白名单已过期');
        return false;
      }
    }
    return this.matchAny(policy.allow, [name, ...permissions]);
  }

  /** 刷新 dangerous 策略启动时间戳（运行时状态） */
  markDangerousEnabled(): void {
    this.dangerousEnabledAt = Date.now();
  }

  /** 清除 dangerous 策略启动时间戳 */
  clearDangerousEnabled(): void {
    this.dangerousEnabledAt = null;
  }

  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  async confirmDangerous(request: DangerousConfirmRequest): Promise<boolean> {
    if (this.isDangerousAllowed(request.name, request.permissions)) return true;
    const grant = this.consumeDangerousGrant(request);
    if (grant) {
      this.logger.info(
        `命中高危会话授权: ${request.type}:${request.name} session=${request.sessionId} grant=${grant.id} used=${grant.used}${grant.maxUses ? `/${grant.maxUses}` : ''}`,
      );
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

  /**
   * 计算一组细粒度权限所要求的最低权限等级。
   *
   * 用于「同一工具按参数动态提权」：例如 file_write 写普通文件只需声明的
   * authority:3，但写 data:/users.json（用户权限表）或 data:/scheduler-jobs.json
   * （计划任务，可注入 owner 身份的 actor）这类敏感文件时要求 owner 等级，
   * 防止低权限用户通过覆盖这些文件自我提权。
   *
   * 默认保护清单可被 config.permissionAuthority 覆盖/扩展（同模式取配置值，
   * 新模式叠加；命中多个模式时取最大要求）。
   */
  requiredAuthorityFor(permissions: string[]): number {
    if (permissions.length === 0) return 0;
    const ownerLevel = this.config.get('ownerAuthority') ?? 5;
    const map: Record<string, number> = {
      'storage:path:data:/users.json:write': ownerLevel,
      'storage:path:data:/users.json:delete': ownerLevel,
      'storage:path:data:/scheduler-jobs.json:write': ownerLevel,
      'storage:path:data:/scheduler-jobs.json:delete': ownerLevel,
      ...(this.config.get('permissionAuthority') ?? {}),
    };
    let required = 0;
    for (const [pattern, level] of Object.entries(map)) {
      if (level > required && this.matchAny([pattern], permissions)) required = level;
    }
    return required;
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
    this.logger.info(
      `创建高危会话授权: ${request.type}:${request.name} session=${request.sessionId} duration=${durationSeconds}s maxUses=${grant.maxUses ?? 'unlimited'} grant=${grant.id}`,
    );
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
    return owners.some((o: UserIdentity) => o.platform === platform && o.userId === userId);
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
    const data: Record<string, number> = {};
    for (const [key, level] of this.users) data[key] = level;
    const payload = JSON.stringify(data, null, 2);
    this.dirty = false;
    this.saveChain = this.saveChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => {
          this.logger.debug('用户权限数据已保存');
        },
        err => {
          this.logger.warn(`保存用户权限数据失败: ${err}`);
          this.dirty = true;
        },
      );
  }

  async init(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = (await this.storage.readFile(this.fileUri, 'utf-8')) as string;
      } catch {
        return;
      }
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
export const subsystem = 'authority';
export const provides = ['authority'];
export const inject = {
  optional: ['commands', 'tools'],
};

const webuiPages: WebuiPage[] = [
  { key: 'authority', label: '权限管理', icon: 'authority', order: 50, renderer: 'authority' },
];

// ===== 插件入口 =====

export async function apply(ctx: Context, _config: Record<string, unknown>): Promise<void> {
  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  const cmds = useCommandService(ctx);
  const storage = createStorageGateway(ctx);
  const authority = new AuthorityManager(ctx.config, ctx.logger, storage);
  await authority.init();
  ctx.provide('authority', authority);

  // ===== 向 tools/commands 注入执行守卫 =====

  const guard = async (guardCtx: ExecutionGuardContext): Promise<string | null> => {
    const userAuth = authority.getAuthority(guardCtx.platform, guardCtx.userId);
    // 参数级动态提权：某些权限标识（如写 data:/users.json）要求比工具声明更高的等级。
    const required = Math.max(guardCtx.authority, authority.requiredAuthorityFor(guardCtx.permissions ?? []));
    if (userAuth < required) {
      return `权限不足: ${guardCtx.type === 'command' ? '指令' : '工具'} "${guardCtx.name}" 需要权限等级 ${required}，当前用户等级 ${userAuth}`;
    }
    const permissionDenied = authority.checkPermissionPolicy(
      guardCtx.permissions ?? [`${guardCtx.type}:${guardCtx.name}`],
    );
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

  // 注入到 commands / tools 服务。whenService 会在 provider 上线（含 bounce 后
  // 重新 provide）时各调一次，自动覆盖"authority 早于 provider"和"provider 重启"两种场景。
  ctx.whenService<CommandService>('commands', svc => {
    if (svc.setExecutionGuard) {
      svc.setExecutionGuard(guard);
      ctx.logger.debug('权限守卫已注入: commands');
    }
  });
  ctx.whenService<ToolService>('tools', svc => {
    if (svc.setExecutionGuard) {
      svc.setExecutionGuard(guard);
      ctx.logger.debug('权限守卫已注入: tools');
    }
    const toolOvr = ctx.config.get('toolOverrides');
    if (toolOvr && svc.loadOverrides) {
      svc.loadOverrides(toolOvr as Record<string, { authority?: number; safety?: SafetyLevel }>);
    }
  });

  // ===== 应用停止时保存 =====
  ctx.on('app:stopping', () => {
    authority.save();
  });

  // ===== 权限指令 =====

  // /grant — 设置用户权限等级
  cmds
    .command('grant <target:string> <level:number>', '设置用户权限等级', { authority: 2 })
    .example('/grant onebot:12345 2')
    .action(async (argv, target, level) => {
      const t = target as string;
      const lvl = level as number;
      if (Number.isNaN(lvl) || lvl < 0) return '权限等级必须是非负整数。';
      const callerAuth = authority.getAuthority(argv.session.platform, argv.session.userId);
      if (lvl >= callerAuth) return `不能将权限设置为 >= 您自身的等级 (${callerAuth})。`;
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>，例如 onebot:12345';
      const platform = t.slice(0, sep);
      const userId = t.slice(sep + 1);
      authority.setAuthority(platform, userId, lvl);
      authority.save();
      return `已将 ${t} 的权限等级设置为 ${lvl}。`;
    });

  // /authority — 查看当前用户权限等级
  cmds.command('authority [target:string]', '查看自己或指定用户的权限等级').action(async (argv, target) => {
    const t = target as string | undefined;
    if (t) {
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      const level = authority.getAuthority(t.slice(0, sep), t.slice(sep + 1));
      return `${t} 的权限等级: ${level}`;
    }
    const level = authority.getAuthority(argv.session.platform, argv.session.userId);
    const isOwner = authority.isOwner(argv.session.platform, argv.session.userId);
    return `您的权限等级: ${level}${isOwner ? ' (owner)' : ''}`;
  });
}

// ===== WebUI 操作处理器 =====

export const actions: Record<string, (ctx: Context, args: Record<string, unknown>) => Promise<unknown>> = {
  /** 获取权限概览 */
  async getOverview(ctx) {
    const auth = ctx.getService<AuthorityService>('authority');
    const users = auth?.listUsers() ?? [];
    const owners: Array<{ platform: string; userId: string }> = ctx.config.get('owners') ?? [];
    const overrides = ctx.getService<CommandService>('commands')?.getOverrides() ?? {};
    // 扁平化所有指令节点，按 dot 名顺序排列，便于 UI 表格渲染
    const cmdNodes = ctx.getService<CommandService>('commands')?.getAll() ?? [];
    const commandPrefix = ctx.getService<CommandService>('commands')?.prefix ?? '/';
    const cmdNames = new Set(cmdNodes.map(n => n.name));
    const tools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    // 当前已注册的平台 contextId 列表（用于 WebUI 下拉选择，避免手写）
    const platformEntries = ctx.getServiceEntries('platform');
    const platformsFromServices = platformEntries.map(e => e.contextId);
    const platformsFromUsers = users.map(u => u.platform);
    const platformsFromOwners = owners.map(o => o.platform);
    const platforms = Array.from(
      new Set([...platformsFromServices, ...platformsFromUsers, ...platformsFromOwners]),
    ).filter(Boolean);
    return {
      users,
      owners,
      platforms,
      defaultAuthority: ctx.config.get('defaultAuthority') ?? 1,
      ownerAuthority: ctx.config.get('ownerAuthority') ?? 5,
      dangerousPolicy: ctx.config.get('dangerousPolicy') ?? {},
      permissionPolicy: ctx.config.get('permissionPolicy') ?? {},
      dangerousGrants: auth?.listDangerousGrants() ?? [],
      commandPrefix,
      commands: cmdNodes.map(n => {
        const path = n.name.split('.');
        const depth = path.length - 1;
        const hasSubcommands = cmdNodes.some(other => other.name.startsWith(`${n.name}.`));
        return {
          // key 同时是 override 的查找键与 setCommandOverride 的入参；如 'profile.clear.nuke'
          key: n.name,
          // 兼容旧前端：以 name 作 React key
          name: n.name,
          // 用于显示，如 '/profile clear nuke'
          displayName: `${commandPrefix}${path.join(' ')}`,
          // 叶子段名（'nuke'）用于子行紧凑显示
          leafName: path[path.length - 1],
          path,
          depth,
          isRoot: depth === 0,
          hasSubcommands,
          hasAction: !!n.handler,
          description: n.description,
          authority: n.authority,
          safety: n.safety,
          permissions: n.permissions,
          baseAuthority: n.baseAuthority,
          baseSafety: n.baseSafety,
          basePermissions: n.basePermissions,
          overridden: n.overridden,
          pluginName: n.pluginName,
        };
      }),
      commandOverrides: overrides,
      orphanCommandOverrides: Object.keys(overrides).filter(k => !cmdNames.has(k)),
      tools,
      toolOverrides: ctx.getService<ToolService>('tools')?.getOverrides?.() ?? {},
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
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('owners', owners);
    app.saveConfig();
    return { message: 'Owner 列表已更新' };
  },

  /** 更新 dangerousPolicy */
  async setDangerousPolicy(ctx, args) {
    const policy = args.policy as Record<string, unknown>;
    if (!policy || typeof policy !== 'object') throw new Error('policy 必须是对象');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('dangerousPolicy', policy);
    app.saveConfig();
    // 启用限时策略时，标记运行时启动时间戳（不写入 config）
    if (Array.isArray(policy.allow) && policy.allow.length > 0) {
      const auth = ctx.getService<AuthorityService>('authority');
      (auth as unknown as { markDangerousEnabled?: () => void } | undefined)?.markDangerousEnabled?.();
    }
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
    const app = ctx.getService<AppService>('app');
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
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const override: { authority?: number; safety?: SafetyLevel } = {};
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
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.getService<CommandService>('commands')?.removeOverride(name);
    ctx.config.set('commandOverrides', ctx.getService<CommandService>('commands')?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 覆盖已重置` };
  },

  /** 更新单个工具的权限覆盖 */
  async setToolOverride(ctx, args) {
    const { name, authority, safety } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    const tools = ctx.getService<ToolService>('tools');
    if (!app) throw new Error('App 不可用');
    if (!tools?.setOverride) throw new Error('ToolService 未支持 override');
    const override: { authority?: number; safety?: SafetyLevel } = {};
    if (typeof authority === 'number') override.authority = authority;
    if (typeof safety === 'string' && (safety === 'safe' || safety === 'dangerous')) override.safety = safety;
    if (Object.keys(override).length === 0) {
      tools.removeOverride?.(name);
    } else {
      tools.setOverride(name, override);
    }
    ctx.config.set('toolOverrides', tools.getOverrides?.() ?? {});
    app.saveConfig();
    return { message: `工具 ${name} 权限已更新` };
  },

  /** 重置工具覆盖 */
  async resetToolOverride(ctx, args) {
    const { name } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    const tools = ctx.getService<ToolService>('tools');
    if (!app) throw new Error('App 不可用');
    tools?.removeOverride?.(name);
    ctx.config.set('toolOverrides', tools?.getOverrides?.() ?? {});
    app.saveConfig();
    return { message: `工具 ${name} 覆盖已重置` };
  },
};
