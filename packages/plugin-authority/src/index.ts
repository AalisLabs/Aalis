import type { AppService, Context, PluginModule } from '@aalis/core';
import type {
  AuthorityService,
  CapabilityConfirm,
  ExecutionGuardContext,
  UserIdentity,
} from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import { getPlatformNames } from '@aalis/plugin-platform-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import { setNetworkPolicy } from '@aalis/util-network-guard';
import { AuthorityManager } from './authority-manager.js';
import { autoConfirmActive, DEFAULT_AUTHORITY, shouldSkipConfirm } from './authority-model.js';

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

  // 网络出口闸（SSRF）：把 core 配置 network 注入进程级 safeFetch 策略（启动一次）。
  // 安全归属在权限域；本地固定服务走裸 fetch、不过 safeFetch，故不受影响。
  setNetworkPolicy(ctx.config.get('network') ?? {});

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

    // ── 轴 A · 授权：数字等级裁决（minLevel 由 risk/visibility/authorityOverrides 在 manager 内派生）——系统源也评估，防绕过提权 ──
    const denied = authority.authorize(identity, {
      capability,
      visibility: g.visibility,
      risk: g.risk,
      resourceCapabilities: g.permissions,
    });
    if (denied) {
      // 未授权（等级不够 / 硬禁 / 资源受限）：**绝不**让发起者本人弹确认自我提权。
      // 仅 owner 预先配置的放行（restrictedPolicy 白名单 / 该用户在本会话已有的授予）可救；否则硬拒。
      // 注意：这里**不**调 requestAccess（那会询问发起者）——只查 isPreApproved（不问人）。
      if (g.skipConfirm) return denied;
      return authority.isPreApproved(accessBase) ? null : denied;
    }

    // ── 轴 B · 确认：授权已过（含 owner / public / 已授予），但操作声明了 confirm 仍需「意图确认」 ──
    // 仅对**已授权**操作做意图确认（owner 也吃，防注入借权）；不再是提权入口。
    // 跳过判定见 shouldSkipConfirm：always 永不跳（cron 无人确认即拒）；非 always 可被
    // skipConfirm(系统/受信源) 或 owner 本人 auto 模式 跳过。修 #6：旧实现用 `!g.skipConfirm`
    // 门控整块 → skipConfirm 会连 always 一起绕过。
    if (confirm) {
      const skip = shouldSkipConfirm({
        confirm,
        skipConfirm: !!g.skipConfirm,
        isOwner: authority.isOwner(g.platform, g.userId),
        autoConfirmUntil: (ctx.config.get('autoConfirmUntil') as number) ?? 0,
        now: Date.now(),
      });
      if (!skip) {
        const ok = await authority.requestAccess({ ...accessBase, confirm });
        if (!ok) return `操作已取消：${capability} 需确认后执行`;
      }
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

  // /authority [target] — 查看自己或指定用户的权限等级
  cmds.command('authority [target:string]', '查看自己或指定用户的权限等级').action(async (argv, target) => {
    const describe = (platform: string, userId: string | undefined, self: boolean): string => {
      const isOwner = authority.isOwner(platform, userId);
      const who = self ? '您' : `${platform}:${userId}`;
      if (isOwner) return `${who}（owner，等级 ∞，拥有全部权限）`;
      const entry = userId
        ? authority.listUsers().find(u => u.platform === platform && u.userId === userId)
        : undefined;
      return `${who} 等级: ${entry?.level ?? DEFAULT_AUTHORITY}`;
    };
    const t = target as string | undefined;
    if (t) {
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      return describe(t.slice(0, sep), t.slice(sep + 1), false);
    }
    return describe(argv.session.platform, argv.session.userId, true);
  });

  // /level <target> <整数> — owner 给外部身份设等级（越大越高，0=默认，负数=封禁）。权限管理仅 owner 可达（防自授）。
  cmds
    .command('level <target:string> <level:number>', '设置用户权限等级（整数，越大越高；0 默认，负数封禁）', {
      visibility: 'restricted',
    })
    .example('/level onebot:12345 5')
    .action(async (argv, target, level) => {
      if (!authority.isOwner(argv.session.platform, argv.session.userId)) return '只有 owner 可管理权限';
      const t = String(target);
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      const lv = Number(level);
      if (!Number.isInteger(lv)) return '等级必须是整数';
      authority.setUserLevel({ platform: t.slice(0, sep), userId: t.slice(sep + 1) }, lv);
      authority.save();
      return `已设 ${t} 等级: ${lv}`;
    });

  // /auto [分钟|off|on] — owner 临时免 dangerous 二次确认（批处理便利）。on=一直, off=关, 数字=分钟。
  cmds
    .command('auto [arg:string]', '自动确认模式：临时免 dangerous 二次确认（仅 owner 本人）', {
      visibility: 'restricted',
    })
    .example('/auto 30')
    .example('/auto off')
    .action(async (argv, arg) => {
      if (!authority.isOwner(argv.session.platform, argv.session.userId)) return '只有 owner 可管理权限';
      const a = arg === undefined ? undefined : String(arg).trim().toLowerCase();
      const setUntil = (u: number) => {
        ctx.config.set('autoConfirmUntil', u);
        ctx.getService<AppService>('app')?.saveConfig();
      };
      if (a === undefined) {
        const u = (ctx.config.get('autoConfirmUntil') as number) ?? 0;
        if (u === -1) return '自动确认：一直开启';
        if (autoConfirmActive(u, Date.now())) return `自动确认：开启中，剩 ${Math.ceil((u - Date.now()) / 60000)} 分钟`;
        return '自动确认：关闭';
      }
      if (a === 'off' || a === '0') {
        setUntil(0);
        return '已关闭自动确认';
      }
      if (a === 'on') {
        setUntil(-1);
        return '已开启自动确认（一直，直到手动关闭）';
      }
      const m = Number(a);
      if (!Number.isInteger(m) || m <= 0) return '用法：/auto <分钟> | off | on';
      setUntil(Date.now() + m * 60000);
      return `已开启自动确认 ${m} 分钟`;
    });
}

// ===== WebUI 操作处理器（数字等级单轴：用户等级 + 操作门槛 + owner 列表 + 高级）=====

function asStringList(v: unknown, label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${label} 必须是字符串数组`);
  return v as string[];
}

export const actions: PluginModule['actions'] = {
  /** 权限概览：用户等级 + owner + 操作门槛/确认 + 临时放行 + 受限/禁用清单 */
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
      authorityOverrides: ctx.config.get('authorityOverrides') ?? {},
      defaultAuthority: DEFAULT_AUTHORITY,
      confirmOverrides: ctx.config.get('confirmOverrides') ?? {},
      autoConfirmUntil: (ctx.config.get('autoConfirmUntil') as number) ?? 0,
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
        risk: n.risk,
        permissions: n.permissions,
      })),
      tools: tools.map(t => ({
        key: t.name,
        name: t.name,
        type: 'tool' as const,
        displayName: t.name,
        pluginName: t.pluginName,
        visibility: t.visibility ?? 'public',
        confirm: t.confirm,
        risk: t.risk,
        permissions: t.permissions,
      })),
    };
  },

  /** 设置外部身份等级（覆盖式整数）。权限管理仅 owner 可达（防自我提权）。 */
  async setUserLevel(ctx, args, caller) {
    const { platform, userId, level } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    if (typeof level !== 'number' || !Number.isInteger(level)) throw new Error('level 必须是整数');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    if (caller && !auth.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    auth.setUserLevel({ platform: platform as string, userId: userId as string }, level);
    auth.save();
    return { message: `${platform}:${userId} 等级已更新为 ${level}` };
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

  /** owner 覆盖单条操作的最低等级（任意整数），无需改插件声明。key=能力键 `type:name`；传非整数则清除该条（回退默认派生）。 */
  async setAuthorityOverride(ctx, args, caller) {
    const { name, level } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (caller && !auth?.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const overrides = { ...((ctx.config.get('authorityOverrides') ?? {}) as Record<string, number>) };
    if (typeof level === 'number' && Number.isInteger(level)) overrides[name] = level;
    else delete overrides[name];
    ctx.config.set('authorityOverrides', overrides);
    app.saveConfig();
    return { message: `操作 ${name} 最低等级已更新` };
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

  /** owner 切换 auto 确认模式。minutes: -1=一直 / 0=关 / N=N 分钟。仅 owner 可达。 */
  async setAutoConfirm(ctx, args, caller) {
    const auth = ctx.getService<AuthorityService>('authority');
    if (caller && !auth?.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const m = args.minutes;
    if (typeof m !== 'number' || !Number.isInteger(m)) throw new Error('minutes 必须是整数（-1 一直 / 0 关 / N 分钟）');
    const until = m === -1 ? -1 : m <= 0 ? 0 : Date.now() + m * 60000;
    ctx.config.set('autoConfirmUntil', until);
    app.saveConfig();
    return { message: until === -1 ? '自动确认：一直' : until === 0 ? '自动确认：关' : `自动确认：${m} 分钟`, until };
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
