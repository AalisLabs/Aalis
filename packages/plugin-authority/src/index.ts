import type { AppService, Context, PluginModule } from '@aalis/core';
import type {
  AuthorityService,
  CapabilityVisibility,
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
import { AuthorityManager } from './authority-manager.js';

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

// 权限管理页（自定义 renderer 在 webui-client）+ 委托关系图（声明式 graph 组件，
// 复用通用 cytoscape 渲染器）：能力委托模型下"上层分发下层"天然是一张图，比扁平列表直观。
const webuiPages: WebuiPage[] = [
  { key: 'authority', label: '权限管理', icon: 'authority', order: 50, renderer: 'authority' },
  {
    key: 'authority-graph',
    label: '委托关系图',
    icon: 'authority',
    order: 51,
    content: [
      {
        type: 'graph',
        label: '委托关系图：owner → 子 → 孙 委托链 + 授予/拒绝能力 + 跨平台绑定（点节点看详情）',
        source: 'getDelegationGraph',
        detailSource: 'getDelegationNode',
        defaultMaxDepth: 2,
        nodeKinds: [
          { kind: 'owner', label: 'Owner（*）', shape: 'diamond', color: '#fbbf24' },
          { kind: 'user', label: '用户', shape: 'circle', color: '#60a5fa' },
          { kind: 'cap', label: '能力', shape: 'round-rect', color: '#9ca3af' },
        ],
        edgeKinds: [
          { kind: 'delegate', label: '委托', color: '#34d399' },
          { kind: 'grant', label: '授予', color: '#60a5fa' },
          { kind: 'deny', label: '拒绝', color: '#ef4444', dashed: true },
          { kind: 'bind', label: '绑定', color: '#a78bfa', dashed: true },
        ],
      },
    ],
  },
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

  // ===== 执行守卫：能力统一闸 + 受限能力的临时委托确认 =====
  const guard = async (g: ExecutionGuardContext): Promise<string | null> => {
    const capability = `${g.type}:${g.name}`;
    const overrides = (ctx.config.get('visibilityOverrides') ?? {}) as Record<string, CapabilityVisibility>;
    const visibility = overrides[g.name] ?? g.visibility;
    const identity = { platform: g.platform, userId: g.userId };
    // authorize 永远先评估（含系统源）——防"桥接/系统调用"绕过能力检查提权
    const denied = authority.authorize(identity, { capability, visibility, resourceCapabilities: g.permissions });
    if (!denied) return null;
    // 受限被拒：系统/受信源无人确认，直接返回拒绝；否则走交互确认（白名单/会话授予/回调）
    if (g.skipConfirm) return denied;
    const granted = await authority.requestAccess({
      name: g.name,
      type: g.type,
      capability,
      resourceCapabilities: g.permissions,
      args: g.args,
      sessionId: g.sessionId,
      platform: g.platform,
      userId: g.userId,
    });
    return granted ? null : denied;
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

  // /authority [target] — 查看自己或指定用户的能力
  cmds.command('authority [target:string]', '查看自己或指定用户的能力授予').action(async (argv, target) => {
    const describe = (platform: string, userId: string | undefined, self: boolean): string => {
      const isOwner = authority.isOwner(platform, userId);
      const who = self ? '您' : `${platform}:${userId}`;
      const lines = [`${who}${isOwner ? '（owner，拥有全部能力）' : ''}`];
      const entry = userId
        ? authority.listUsers().find(u => u.platform === platform && u.userId === userId)
        : undefined;
      if (entry?.linkedTo) lines.push(`已绑定到主账户 ${entry.linkedTo}（能力以账户为准）`);
      if (entry?.links?.length) lines.push(`已绑定身份: ${entry.links.join(', ')}`);
      if (entry?.grant?.length) lines.push(`授予能力: ${entry.grant.join(', ')}`);
      if (entry?.deny?.length) lines.push(`禁用能力: ${entry.deny.join(', ')}`);
      if (entry?.grantedBy) lines.push(`委托自: ${entry.grantedBy}`);
      if (!isOwner && !entry?.grant?.length) lines.push('（默认拥有全部 public 能力）');
      return lines.join('\n');
    };
    const t = target as string | undefined;
    if (t) {
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      return describe(t.slice(0, sep), t.slice(sep + 1), false);
    }
    return describe(argv.session.platform, argv.session.userId, true);
  });

  // /grant <target> <capability> — 委托一个能力（子集约束在 manager 内校验）
  cmds
    .command('grant <target:string> <capability:string>', '授予用户一个能力', { visibility: 'restricted' })
    .example('/grant onebot:12345 tool:weather')
    .action(async (argv, target, capability) => editCaps(argv, target, capability, 'grant'));

  // /deny <target> <capability> — 禁用一个能力
  cmds
    .command('deny <target:string> <capability:string>', '禁用用户一个能力', { visibility: 'restricted' })
    .example('/deny onebot:12345 tool:shell.exec')
    .action(async (argv, target, capability) => editCaps(argv, target, capability, 'deny'));

  /** /grant、/deny 共用：往目标用户的 grant/deny 集追加一条能力（委托子集校验在 setUserCapabilities） */
  function editCaps(
    argv: { session: { platform: string; userId?: string } },
    target: unknown,
    capability: unknown,
    field: 'grant' | 'deny',
  ): string {
    const t = String(target);
    const cap = String(capability).trim();
    const sep = t.indexOf(':');
    if (sep < 1) return '目标格式: <platform:userId>';
    if (!cap) return '能力不能为空';
    const granter: UserIdentity = { platform: argv.session.platform, userId: argv.session.userId ?? '' };
    const targetId: UserIdentity = { platform: t.slice(0, sep), userId: t.slice(sep + 1) };
    const cur = authority.listUsers().find(u => u.platform === targetId.platform && u.userId === targetId.userId);
    const next = [...new Set([...(cur?.[field] ?? []), cap])];
    try {
      authority.setUserCapabilities(granter, targetId, {
        grant: field === 'grant' ? next : cur?.grant,
        deny: field === 'deny' ? next : cur?.deny,
      });
      authority.save();
      return `已${field === 'grant' ? '授予' : '禁用'} ${t}: ${cap}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // /bind <code> — 把当前平台账号绑定到 WebUI 主账户（码在 WebUI 权限页生成）。
  // 仅限私聊：群聊发码会暴露给旁观者。
  cmds
    .command('bind <code:string>', '将当前平台账号绑定到 WebUI 账户', { visibility: 'public' })
    .example('/bind AB12CD34')
    .action(async (argv, code) => {
      const { platform, userId, sessionType } = argv.session;
      if (!userId) return '无法识别您的身份，无法绑定。';
      if (platform === 'webui' || platform === 'cli') return '请在外部平台（如 QQ）私聊中向机器人发送本指令。';
      if (sessionType !== 'private') return '为防止绑定码泄露，请在私聊中使用本指令。';
      try {
        const account = authority.consumeBindCode(String(code).trim().toUpperCase(), { platform, userId });
        authority.save();
        return `绑定成功：${platform}:${userId} ↔ ${account.platform}:${account.userId}。可在 WebUI 权限页解绑。`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
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
      visibilityOverrides: ctx.config.get('visibilityOverrides') ?? {},
      restrictedPolicy: ctx.config.get('restrictedPolicy') ?? {},
      temporaryGrants: auth?.listTemporaryGrants() ?? [],
      commandPrefix,
      commands: cmdNodes.map(n => ({
        key: n.name,
        name: n.name,
        displayName: `${commandPrefix}${n.name.split('.').join(' ')}`,
        visibility: n.visibility ?? 'public',
      })),
      tools: tools.map(t => ({ key: t.name, name: t.name, visibility: t.visibility ?? 'public' })),
    };
  },

  /**
   * 委托关系图数据（喂通用 cytoscape graph 组件，协议与 user-relation getRelationGraph 对齐）：
   * 用户节点（owner/user）+ 能力节点，边 = 委托(父→子) / 授予 / 拒绝 / 绑定(被绑身份→主账户)。
   * 保证每条边两端节点都存在；支持焦点子图导航（args.focusId 为节点或边 id + maxDepth/maxBreadth），
   * 点边时回 focusEdge（详情卡片用）。无 focusId 返回全图。
   */
  async getDelegationGraph(ctx, args) {
    const auth = ctx.getService<AuthorityService>('authority');
    const users = auth?.listUsers() ?? [];
    const owners: UserIdentity[] = ctx.config.get('owners') ?? [];
    const nodes = new Map<string, { data: Record<string, unknown> }>();
    const edges: Array<{ data: Record<string, unknown> }> = [];
    const ensureUser = (key: string) => {
      const id = `user:${key}`;
      if (nodes.has(id)) return id;
      const i = key.indexOf(':');
      const isOwner = i > 0 ? (auth?.isOwner(key.slice(0, i), key.slice(i + 1)) ?? false) : false;
      nodes.set(id, { data: { id, label: key, kind: isOwner ? 'owner' : 'user', pageRankScale: isOwner ? 0.7 : 0.5 } });
      return id;
    };
    const ensureCap = (pat: string) => {
      const id = `cap:${pat}`;
      if (!nodes.has(id)) nodes.set(id, { data: { id, label: pat, kind: 'cap', pageRankScale: 0.3 } });
      return id;
    };
    for (const o of owners) ensureUser(`${o.platform}:${o.userId}`);
    for (const u of users) {
      const key = `${u.platform}:${u.userId}`;
      const src = ensureUser(key);
      for (const g of u.grant ?? [])
        edges.push({
          data: { id: `grant:${key}:${g}`, source: src, target: ensureCap(g), label: '授予', kind: 'grant' },
        });
      for (const d of u.deny ?? [])
        edges.push({
          data: { id: `deny:${key}:${d}`, source: src, target: ensureCap(d), label: '拒绝', kind: 'deny' },
        });
      if (u.grantedBy)
        edges.push({
          data: {
            id: `delegate:${key}`,
            source: ensureUser(u.grantedBy),
            target: src,
            label: '委托',
            kind: 'delegate',
            directed: true,
          },
        });
      if (u.linkedTo)
        edges.push({
          data: {
            id: `bind:${key}`,
            source: src,
            target: ensureUser(u.linkedTo),
            label: '绑定',
            kind: 'bind',
            directed: true,
          },
        });
    }
    // owner → 「* 全部能力」：owner 持有 `*`，不逐条 grant，否则会是孤立节点。连一个
    // `*` 能力节点直观表达"拥有一切"，也让焦点/邻域有内容可展开。
    const ownerIds = [...nodes.values()].filter(n => n.data.kind === 'owner').map(n => String(n.data.id));
    if (ownerIds.length > 0) {
      const allCap = 'cap:*';
      if (!nodes.has(allCap))
        nodes.set(allCap, { data: { id: allCap, label: '★ 全部能力 (*)', kind: 'cap', pageRankScale: 0.6 } });
      for (const id of ownerIds)
        edges.push({
          data: { id: `own:${id}`, source: id, target: allCap, label: '拥有全部', kind: 'grant', directed: true },
        });
    }
    const stats = {
      用户: users.length,
      owner: owners.length,
      能力节点: [...nodes.keys()].filter(k => k.startsWith('cap:')).length,
    };

    // 焦点子图导航：无 focusId → 全图；有则从焦点（节点或边两端）BFS maxDepth/maxBreadth。
    const focusId = typeof args?.focusId === 'string' && args.focusId.trim() ? args.focusId.trim() : undefined;
    if (!focusId) return { nodes: [...nodes.values()], edges, stats };

    const maxDepth = Number.isFinite(Number(args?.maxDepth)) ? Number(args?.maxDepth) : 2;
    const maxBreadth = Number.isFinite(Number(args?.maxBreadth)) ? Number(args?.maxBreadth) : 10;
    const edgeMatch = edges.find(e => e.data.id === focusId);
    const starts = edgeMatch
      ? [String(edgeMatch.data.source), String(edgeMatch.data.target)]
      : nodes.has(focusId)
        ? [focusId]
        : [];
    const focusEdge = edgeMatch
      ? {
          id: String(edgeMatch.data.id),
          kind: String(edgeMatch.data.kind ?? ''),
          description: String(edgeMatch.data.label ?? ''),
          endpoints: [String(edgeMatch.data.source), String(edgeMatch.data.target)],
          directed: edgeMatch.data.directed === true,
        }
      : undefined;

    // 无向邻接：节点 id → [{edgeId, other}]
    const adj = new Map<string, Array<{ edgeId: string; other: string }>>();
    for (const e of edges) {
      const s = String(e.data.source);
      const t = String(e.data.target);
      const id = String(e.data.id);
      (adj.get(s) ?? adj.set(s, []).get(s))?.push({ edgeId: id, other: t });
      (adj.get(t) ?? adj.set(t, []).get(t))?.push({ edgeId: id, other: s });
    }
    const keptNodes = new Set<string>(starts.filter(id => nodes.has(id)));
    const keptEdges = new Set<string>(edgeMatch ? [focusId] : []);
    let frontier = [...keptNodes];
    for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const { edgeId, other } of (adj.get(id) ?? []).slice(0, maxBreadth)) {
          keptEdges.add(edgeId);
          if (!keptNodes.has(other)) {
            keptNodes.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return {
      focusId,
      focusEdge,
      nodes: [...nodes.values()].filter(n => keptNodes.has(String(n.data.id))),
      edges: edges.filter(
        e =>
          keptEdges.has(String(e.data.id)) &&
          keptNodes.has(String(e.data.source)) &&
          keptNodes.has(String(e.data.target)),
      ),
      stats,
    };
  },

  /** 委托关系图节点详情（detailSource；点节点时调用） */
  async getDelegationNode(ctx, args) {
    const nodeId = String(args.nodeId ?? '');
    const auth = ctx.getService<AuthorityService>('authority');
    const users = auth?.listUsers() ?? [];
    if (nodeId.startsWith('user:')) {
      const key = nodeId.slice(5);
      const i = key.indexOf(':');
      const isOwner = i > 0 ? (auth?.isOwner(key.slice(0, i), key.slice(i + 1)) ?? false) : false;
      const u = users.find(x => `${x.platform}:${x.userId}` === key);
      return {
        身份: key,
        类型: isOwner ? 'owner（拥有一切能力）' : '用户',
        授予: u?.grant?.join('、') || '（无）',
        拒绝: u?.deny?.join('、') || '（无）',
        委托自: u?.grantedBy || '（顶层 / owner 直接）',
        可登录账户: u?.hasPassword ? '是' : '否',
        绑定: u?.links?.join('、') || (u?.linkedTo ? `→ ${u.linkedTo}` : '（无）'),
      };
    }
    if (nodeId.startsWith('cap:')) {
      const pat = nodeId.slice(4);
      const granters = users.filter(u => (u.grant ?? []).some(g => g === pat)).map(u => `${u.platform}:${u.userId}`);
      const deniers = users.filter(u => (u.deny ?? []).some(d => d === pat)).map(u => `${u.platform}:${u.userId}`);
      return { 能力: pat, 授予给: granters.join('、') || '（无）', 拒绝于: deniers.join('、') || '（无）' };
    }
    return { id: nodeId };
  },

  /** 委托：设置用户能力 grant/deny（caller 为授予方，非 owner 时子集校验在 manager 内） */
  async setUserCapabilities(ctx, args, caller) {
    const { platform, userId, grant, deny } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    auth.setUserCapabilities(
      caller ?? null,
      { platform: platform as string, userId: userId as string },
      { grant: asStringList(grant, 'grant'), deny: asStringList(deny, 'deny') },
    );
    auth.save();
    return { message: `${platform}:${userId} 的能力委托已更新` };
  },

  /** 设置/重置账户密码（owner 或本人） */
  async setPassword(ctx, args, caller) {
    const { platform, userId, password } = args;
    if (!platform || !userId || typeof password !== 'string') throw new Error('platform, userId, password 必填');
    if (password.length < 6) throw new Error('密码长度至少 6 位');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const isSelf = caller && caller.platform === platform && caller.userId === userId;
    if (caller && !isSelf && !auth.isOwner(caller.platform, caller.userId)) {
      throw new Error('只有 owner 或本人可设置密码');
    }
    await auth.setPassword(platform as string, userId as string, password);
    auth.save();
    return { message: `${platform}:${userId} 密码已更新` };
  },

  async createBindCode(ctx, _args, caller) {
    if (!caller) throw new Error('无法识别调用者身份');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const { code, expiresAt } = auth.createBindCode(caller.platform, caller.userId);
    const prefix = ctx.getService<CommandService>('commands')?.prefix ?? '/';
    return { code, expiresAt, hint: `请在 5 分钟内用要绑定的平台账号私聊机器人发送：${prefix}bind ${code}` };
  },

  async unlinkIdentity(ctx, args, caller) {
    const { platform, userId } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    if (caller) {
      const owning = auth.listUsers().find(u => u.links?.includes(`${platform}:${userId}`));
      const isSelf = owning && owning.platform === caller.platform && owning.userId === caller.userId;
      if (!isSelf && !auth.isOwner(caller.platform, caller.userId)) {
        throw new Error('只有绑定所属账户本人或 owner 可以解绑');
      }
    }
    const ok = auth.unlinkIdentity(platform as string, userId as string);
    auth.save();
    return { ok, message: ok ? `${platform}:${userId} 已解绑` : '该身份没有绑定记录' };
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

  /** owner 覆盖单条操作的可见性（public ↔ restricted），无需改插件声明 */
  async setVisibilityOverride(ctx, args) {
    const { name, visibility } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const overrides = { ...((ctx.config.get('visibilityOverrides') ?? {}) as Record<string, CapabilityVisibility>) };
    if (visibility === 'public' || visibility === 'restricted') overrides[name] = visibility;
    else delete overrides[name];
    ctx.config.set('visibilityOverrides', overrides);
    app.saveConfig();
    return { message: `操作 ${name} 可见性已更新` };
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

// createBindCode / unlinkIdentity 对任何登录账户开放（绑码只能绑自己；解绑有 handler 内本人/owner 检查）；
// 其余 action 不声明 → 默认 restricted（仅 owner / 被委托）。
export const actionsMeta: PluginModule['actionsMeta'] = {
  createBindCode: { visibility: 'public' },
  unlinkIdentity: { visibility: 'public' },
};
