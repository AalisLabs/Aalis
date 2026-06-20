import type { AppService, Context, PluginModule } from '@aalis/core';
import type {
  AuthorityService,
  CapabilityConfirm,
  ExecutionGuardContext,
  TierName,
  UserIdentity,
} from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import { getPlatformNames } from '@aalis/plugin-platform-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import { AuthorityManager } from './authority-manager.js';
import { TIER_LABEL } from './tier-model.js';

export type { AuthorityService } from '@aalis/plugin-authority-api';
export { AuthorityManager } from './authority-manager.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-authority';
export const displayName = '权限管理';
export const subsystem = 'authority';
export const provides = ['authority'];
export const inject = {
  optional: ['commands', 'tools'],
};

// 权限管理页（自定义 renderer 在 webui-client）。单 owner 终态无委托树，故无委托关系图。
const webuiPages: WebuiPage[] = [
  { key: 'authority', label: '权限管理', icon: 'authority', order: 50, renderer: 'authority' },
];

// ===== 插件入口 =====

export async function apply(ctx: Context, _config: Record<string, unknown>): Promise<void> {
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  const cmds = useCommandService(ctx);
  const storage = createStorageGateway(ctx);
  const authority = new AuthorityManager(ctx.config, ctx.logger, storage);
  await authority.init();
  ctx.provide('authority', authority);

  // ===== 执行守卫：两轴正交闸 —— 轴 A 授权（authorize）+ 轴 B 确认（confirm，owner 也吃）=====
  const guard = async (g: ExecutionGuardContext): Promise<string | null> => {
    const capability = `${g.type}:${g.name}`;
    // 确认覆盖：'off' 强制关确认；否则覆盖值优先，回退插件声明。
    const confOv = (ctx.config.get('confirmOverrides') ?? {}) as Record<string, CapabilityConfirm | 'off'>;
    const cOv = confOv[capability];
    const confirm = cOv === 'off' ? undefined : (cOv ?? g.confirm);
    const identity = { platform: g.platform, userId: g.userId };
    const accessBase = {
      name: g.name,
      type: g.type,
      capability,
      resourceCapabilities: g.permissions,
      args: g.args,
      sessionId: g.sessionId,
      platform: g.platform,
      userId: g.userId,
    } as const;

    // ── 轴 A · 授权：档位裁决（minTier 由 risk/visibility/tierOverrides 在 manager 内派生）——系统源也评估，防绕过提权 ──
    const denied = authority.authorize(identity, {
      capability,
      visibility: g.visibility,
      risk: g.risk,
      resourceCapabilities: g.permissions,
    });
    if (denied) {
      // 受限被拒：系统/受信源无人确认，直接拒；否则走交互授予（白名单/会话授予/回调）。
      // 必须带上 confirm —— 否则 confirm='always' 的操作在此路径被降级为可白名单/会话记忆。
      if (g.skipConfirm) return denied;
      const granted = await authority.requestAccess({ ...accessBase, confirm });
      return granted ? null : denied;
    }

    // ── 轴 B · 确认：授权已过（含 owner / public / 已授予），但操作声明了 confirm 仍需「意图确认」 ──
    if (confirm && !g.skipConfirm) {
      const ok = await authority.requestAccess({ ...accessBase, confirm });
      if (!ok) return `操作已取消：${capability} 需确认后执行`;
    }
    return null;
  };

  // 注入到 commands / tools（whenService 在 provider 上线/重启时各调一次）
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
  });

  ctx.on('app:stopping', () => authority.save());

  // ===== 权限指令 =====

  // /authority [target] — 查看自己或指定用户的档位
  cmds.command('authority [target:string]', '查看自己或指定用户的权限档位').action(async (argv, target) => {
    const describe = (platform: string, userId: string | undefined, self: boolean): string => {
      const isOwner = authority.isOwner(platform, userId);
      const who = self ? '您' : `${platform}:${userId}`;
      if (isOwner) return `${who}（owner，拥有全部权限）`;
      const entry = userId
        ? authority.listUsers().find(u => u.platform === platform && u.userId === userId)
        : undefined;
      const tier = entry?.tier ?? 'visitor';
      return `${who} 档位: ${TIER_LABEL[tier]}（${tier}）`;
    };
    const t = target as string | undefined;
    if (t) {
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      return describe(t.slice(0, sep), t.slice(sep + 1), false);
    }
    return describe(argv.session.platform, argv.session.userId, true);
  });

  // /tier <target> <档名> — owner 给外部身份设档（封禁/访客/朋友/信任）。权限管理仅 owner 可达（防自授）。
  const TIER_BY_NAME: Record<string, TierName> = {
    封禁: 'banned',
    访客: 'visitor',
    朋友: 'friend',
    信任: 'trusted',
    banned: 'banned',
    visitor: 'visitor',
    friend: 'friend',
    trusted: 'trusted',
  };
  cmds
    .command('tier <target:string> <tier:string>', '设置用户权限档位（封禁/访客/朋友/信任）', {
      visibility: 'restricted',
    })
    .example('/tier onebot:12345 朋友')
    .action(async (argv, target, tier) => {
      if (!authority.isOwner(argv.session.platform, argv.session.userId)) return '只有 owner 可管理权限';
      const t = String(target);
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      const tierName = TIER_BY_NAME[String(tier).trim()];
      if (!tierName) return '档位只能是：封禁 / 访客 / 朋友 / 信任';
      authority.setUserTier({ platform: t.slice(0, sep), userId: t.slice(sep + 1) }, tierName);
      authority.save();
      return `已设 ${t} 档位: ${TIER_LABEL[tierName]}`;
    });
}

// ===== WebUI 操作处理器（最小新模型集；委托树/图 Phase 4 充实）=====

function asStringList(v: unknown, label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${label} 必须是字符串数组`);
  return v as string[];
}

export const actions: PluginModule['actions'] = {
  /** 权限概览：用户能力委托 + owner + 操作可见性 + 临时委托 + 受限/禁用清单 */
  async getOverview(ctx) {
    const auth = ctx.getService<AuthorityService>('authority');
    const users = auth?.listUsers() ?? [];
    const owners: UserIdentity[] = ctx.config.get('owners') ?? [];
    const commandsSvc = ctx.getService<CommandService>('commands');
    const commandPrefix = commandsSvc?.prefix ?? '/';
    const cmdNodes = commandsSvc?.getAll() ?? [];
    const tools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    const platforms = Array.from(
      new Set([
        ...getPlatformNames(ctx),
        'webui',
        'cli',
        ...users.map(u => u.platform),
        ...owners.map(o => o.platform),
      ]),
    ).filter(Boolean);
    return {
      users,
      owners,
      platforms,
      restrictedCapabilities: ctx.config.get('restrictedCapabilities') ?? [],
      deniedCapabilities: ctx.config.get('deniedCapabilities') ?? [],
      tierOverrides: ctx.config.get('tierOverrides') ?? {},
      confirmOverrides: ctx.config.get('confirmOverrides') ?? {},
      restrictedPolicy: ctx.config.get('restrictedPolicy') ?? {},
      temporaryGrants: auth?.listTemporaryGrants() ?? [],
      commandPrefix,
      // 操作清单：指令 + 工具统一带 pluginName/type/confirm，供前端「操作」视图按插件分组、显示两轴默认。
      commands: cmdNodes.map(n => ({
        key: n.name,
        name: n.name,
        type: 'command' as const,
        displayName: `${commandPrefix}${n.name.split('.').join(' ')}`,
        pluginName: n.pluginName,
        visibility: n.visibility ?? 'public',
        confirm: n.confirm,
      })),
      tools: tools.map(t => ({
        key: t.name,
        name: t.name,
        type: 'tool' as const,
        displayName: t.name,
        pluginName: t.pluginName,
        visibility: t.visibility ?? 'public',
        confirm: t.confirm,
      })),
    };
  },

  /** 设置外部身份档位（覆盖式）。权限管理仅 owner 可达（防自我提权）。 */
  async setUserTier(ctx, args, caller) {
    const { platform, userId, tier } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    if (tier !== 'banned' && tier !== 'visitor' && tier !== 'friend' && tier !== 'trusted') {
      throw new Error('tier 只能是 banned/visitor/friend/trusted');
    }
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    if (caller && !auth.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    auth.setUserTier({ platform: platform as string, userId: userId as string }, tier as TierName);
    auth.save();
    return { message: `${platform}:${userId} 档位已更新为 ${tier}` };
  },

  /** 删除用户记录 */
  async deleteUser(ctx, args) {
    const { platform, userId } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    auth?.removeUser(platform as string, userId as string);
    auth?.save();
    return { message: `${platform}:${userId} 记录已删除` };
  },

  /** 更新 owner 列表（仅 owner 可达：防非 owner 把自己加成 owner 提权） */
  async setOwners(ctx, args, caller) {
    const owners = args.owners;
    if (!Array.isArray(owners)) throw new Error('owners 必须是数组');
    const auth = ctx.getService<AuthorityService>('authority');
    if (caller && !auth?.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理 owner 列表');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('owners', owners);
    app.saveConfig();
    return { message: 'Owner 列表已更新' };
  },

  /** 更新受限能力的临时放行策略（restrictedPolicy） */
  async setRestrictedPolicy(ctx, args) {
    const policy = args.policy as Record<string, unknown>;
    if (!policy || typeof policy !== 'object') throw new Error('policy 必须是对象');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('restrictedPolicy', policy);
    app.saveConfig();
    if (Array.isArray(policy.allow) && policy.allow.length > 0) {
      (
        ctx.getService<AuthorityService>('authority') as unknown as { markPolicyEnabled?: () => void } | undefined
      )?.markPolicyEnabled?.();
    }
    return { message: '临时放行策略已更新' };
  },

  /** 撤销一个临时能力委托 */
  async revokeTemporaryGrant(ctx, args) {
    const id = args.id as string;
    if (!id) throw new Error('id 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const ok = auth.revokeTemporaryGrant(id);
    return { ok, message: ok ? '临时委托已撤销' : '不存在或已过期' };
  },

  /** owner 覆盖单条操作的最低档（0 访客/1 朋友/2 信任），无需改插件声明。key=能力键 `type:name`；非法值清除该条。 */
  async setTierOverride(ctx, args, caller) {
    const { name, tier } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (caller && !auth?.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const overrides = { ...((ctx.config.get('tierOverrides') ?? {}) as Record<string, number>) };
    if (tier === 0 || tier === 1 || tier === 2) overrides[name] = tier;
    else delete overrides[name];
    ctx.config.set('tierOverrides', overrides);
    app.saveConfig();
    return { message: `操作 ${name} 最低档已更新` };
  },

  /** owner 覆盖单条操作的确认要求（session/always/off）。key=能力键 `type:name`；非法值清除该条。 */
  async setConfirmOverride(ctx, args, caller) {
    const { name, confirm } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (caller && !auth?.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const overrides = { ...((ctx.config.get('confirmOverrides') ?? {}) as Record<string, CapabilityConfirm | 'off'>) };
    if (confirm === 'session' || confirm === 'always' || confirm === 'off') overrides[name] = confirm;
    else delete overrides[name];
    ctx.config.set('confirmOverrides', overrides);
    app.saveConfig();
    return { message: `操作 ${name} 确认要求已更新` };
  },

  /** 更新受限/禁用能力清单 */
  async setConfig(ctx, args) {
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const restricted = asStringList(args.restrictedCapabilities, 'restrictedCapabilities');
    const denied = asStringList(args.deniedCapabilities, 'deniedCapabilities');
    if (restricted) ctx.config.set('restrictedCapabilities', restricted);
    if (denied) ctx.config.set('deniedCapabilities', denied);
    app.saveConfig();
    return { message: '权限配置已更新' };
  },
};
