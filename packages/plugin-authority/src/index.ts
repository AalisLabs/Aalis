import { approvals } from '@aalis/api-approval';
import type { CapabilityConfirm, ExecutionGuardContext, UserIdentity } from '@aalis/api-authority';
import { authority as authorityService, capabilityMinLevel } from '@aalis/api-authority';
import { commands as commandsService } from '@aalis/api-commands';
import { type HostConfig, hostConfig } from '@aalis/api-host-config';
import { createStorageGateway, storage as storageService } from '@aalis/api-storage';
import { tools as toolsService } from '@aalis/api-tools';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { setNetworkPolicy } from '@aalis/util-network-guard';
import { AuthorityManager } from './authority-manager.js';
import { DEFAULT_AUTHORITY, originKind } from './authority-model.js';

// ===== 插件入口 =====

// 裁决要读整份宿主配置（owners / deniedCapabilities / confirmOverrides…），缺了它权限系统无从裁决，
// 故 apply 里 require()、缺席即抛；但它由宿主在根上提供、没有任何插件 provide 它，写进激活闸
// 只会让依赖图上挂一条永远解析不到提供者的告警。被守卫、被管理的那几项
// （commands / tools / webui / storage）缺席时只是少一条接线，不该拦住权限服务本身上线。
// approvals 缺席时需要确认的工具调用一律拒绝。
const uses = {
  provide,
  hostConfig: optional(hostConfig),
  logger,
  lifecycle,
  webui: optional(webuiServer),
  commands: optional(commandsService),
  tools: optional(toolsService),
  storage: optional(storageService),
  approvals: optional(approvals),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-authority',
  displayName: '权限管理',
  subsystem: 'authority',
  provides: [authorityService],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { commands, lifecycle, logger, storage, tools, webui } = caps;
  const config = caps.hostConfig.require();

  const manager = new AuthorityManager(config, logger, createStorageGateway(storage));
  caps.provide(authorityService, manager);
  const page = defineAuthorityPage({ webui, commands, tools, config, manager });

  // 用户等级存于 data:/users.json，读取依赖 storage 服务。storage provider 可能晚于本插件
  // 上线（在 init 阶段直接 readFile 会失败且被静默吞 → 重启后等级不回载），故等 storage 就绪
  // 再 load，规避初始化时序竞态。follow 对「已在线」的服务也会立即触发，故任意加载序都成立。
  let loading: Promise<void> | undefined;
  // 读一次即完，storage 换人时没有要拆的东西，故不返回清理
  storage.follow(() => {
    loading = manager
      .init()
      .then(
        () => logger.debug('授权用户等级已加载'),
        // err 作参数交给 logger 渲染：模板字符串遇到转不成字符串的值会抛，被下面的兜底吞掉、一条告警都不留
        err => logger.warn('授权用户等级加载失败:', err),
      )
      // 上报器自身失败（宿主经 AppOptions 注入的 logger 或时钟抛错）不再外抛，成败两条回调都算：
      // storage 已在线时下面的 await 会让激活失败，晚上线时没人等这个 Promise，未处理的拒绝会被宿主当致命错误退出进程
      .catch(() => {});
  });
  // storage 已在线时 follow 是同步首挂：把加载等完再让 apply 返回，避免「等级表还空着
  // 就开始裁决」的窗口（封禁用户在这段时间按默认 0 级通过）。storage 晚上线时无从等待，仍异步。
  if (loading) await loading;

  // 网络出口闸（SSRF）：把宿主配置 network 注入进程级 safeFetch 策略（启动一次）。
  // 安全归属在权限域；本地固定服务走裸 fetch、不过 safeFetch，故不受影响。
  setNetworkPolicy(config.get('network') ?? {});

  // ===== 执行守卫：两轴正交闸 —— 轴 A 授权（authorize）+ 轴 B 确认（confirm，owner 也吃）=====
  const guard = async (g: ExecutionGuardContext): Promise<string | null> => {
    const capability = `${g.type}:${g.name}`;
    // 确认覆盖：'off' 强制关确认；否则覆盖值优先，回退插件声明。
    const confOv = (config.get('confirmOverrides') ?? {}) as Record<string, CapabilityConfirm | 'off'>;
    const cOv = confOv[capability];
    const confirm = cOv === 'off' ? undefined : (cOv ?? g.confirm);

    // ── 轴 A · 授权：数字等级裁决按授权身份（actor 缺省即会话身份）——系统源也评估，防绕过提权。
    // 等级不够即拒，没有别的放行口：发起者本人不能靠确认给自己提权。
    const denied = manager.authorize(g.actor ?? { platform: g.platform, userId: g.userId }, {
      capability,
      visibility: g.visibility,
      risk: g.risk,
    });
    if (denied) return denied;

    // ── 轴 B · 确认：授权已过，但操作声明了 confirm 仍要有人确认（owner 也吃，防注入借权）。
    // 非 always 的确认可免：没人可问的受信来源（skipConfirm）、owner 配的 restrictedPolicy 白名单。always 什么都免不掉
    if (!confirm) return null;
    if (confirm !== 'always' && (g.skipConfirm || manager.waivesConfirm(capability))) return null;

    // 指令由人亲手输入：确认的是发出者本人的意图，由指令服务当面问；问不到（注入的指令）就拒
    if (g.type === 'command') {
      if (!g.confirmIntent) return `操作已取消：${capability} 需要发出者本人确认，这条指令不是人亲手输入的，无从确认`;
      return (await g.confirmIntent()) ? null : `操作已取消：${capability} 没有得到发出者确认`;
    }

    // 工具由模型调用：确认是 owner 审批。哪些回合能产生审批由审批服务按发起类别裁决，不能的立即拒绝、不推给任何面
    const service = caps.approvals.current;
    if (!service) {
      return `操作已取消：${capability} 需要 owner 批准，但审批服务不在（由 @aalis/plugin-session-server 提供）`;
    }
    const outcome = await service.request(
      {
        sessionId: g.sessionId,
        turnId: g.turnId,
        callId: g.callId,
        origin: { kind: originKind(g, (p, u) => manager.isOwner(p, u)), platform: g.platform, userId: g.userId },
        tool: g.name,
        args: g.args ?? {},
        rule: cOv ? `confirmOverrides 把 ${capability} 设为 ${cOv}` : `${capability} 声明 confirm=${confirm}`,
      },
      g.signal,
    );
    return outcome.approved ? null : outcome.message;
  };

  // 注入到 commands / tools（follow 在 provider 上线/重启时各调一次）。
  // 不给清理：守卫是提供者身上的一格状态，提供者换人时随旧实例一起消失；而契约里没有
  // 「摘掉守卫」的口；真要摘，tools / commands 会退回无守卫的 fail-closed（需要更高等级或确认的一律拒绝）。
  commands.follow(svc => {
    svc.setExecutionGuard(guard);
    logger.debug('权限守卫已注入: commands');
  });
  tools.follow(svc => {
    svc.setExecutionGuard(guard);
    logger.debug('权限守卫已注入: tools');
  });

  // 落盘走 onDispose 而非 app:stopping：后者只在全局停机触发一次，覆盖不了
  // bounce / unload / disable / 依赖降级级联这些拆卸路径，热重载即丢等级数据。
  //
  // 必须 async 并 await flushed()：save() 只是把写挂到 saveChain 上就同步返回，
  // 而清理链只在回调返回 thenable 时才等待——回调返回 void 时整条拆卸链一个环节都不等
  // 这次写，CLI 子命令退出与 bounce 都会静默丢掉封禁/等级。
  // flushed() 无条件 await：dirty 已为 false 时 save() 会早退，要等的是先前挂上去的那次写。
  lifecycle.onDispose(async () => {
    manager.save();
    await manager.flushed();
  });

  // ===== 权限指令 =====

  // /authority [target] — 查看自己或指定用户的权限等级
  // 读类敏感操作：会披露他人的权限等级 → risk:'sensitive'（推出 restricted=等级 2，不强制确认）。
  commands
    .command('authority [target:string]', '查看自己或指定用户的权限等级', { risk: 'sensitive' })
    .action(async (argv, target) => {
      const describe = (platform: string, userId: string | undefined, self: boolean): string => {
        const isOwner = manager.isOwner(platform, userId);
        const who = self ? '您' : `${platform}:${userId}`;
        if (isOwner) return `${who}（owner，等级 ∞，拥有全部权限）`;
        const entry = userId
          ? manager.listUsers().find(u => u.platform === platform && u.userId === userId)
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
  commands
    .command('level <target:string> <level:number>', '设置用户权限等级（整数，越大越高；0 默认，负数封禁）', {
      visibility: 'restricted',
    })
    .example('/level onebot:12345 5')
    .action(async (argv, target, level) => {
      if (!manager.isOwner(argv.session.platform, argv.session.userId)) return '只有 owner 可管理权限';
      const t = String(target);
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      const lv = Number(level);
      if (!Number.isInteger(lv)) return '等级必须是整数';
      const message = await applyUserChange(
        manager,
        () => manager.setUserLevel({ platform: t.slice(0, sep), userId: t.slice(sep + 1) }, lv),
        `已设 ${t} 等级: ${lv}`,
      );
      page.invalidate();
      return message;
    });
}

/**
 * 等级管理入口（/level、权限页的设等级、加用户与删除记录）的共同流程。
 * 先等在飞的等级表读取落定再改：首次读取完成前内存里查不到文件里的记录。storage 未上线时首次读取尚未发起，
 * 这里无从等待：改等级（含降为 0 级）保留文件里的备注、删除不随文件回来，由 setUserLevel 在首次读取落定前不删记录、
 * UserStore 的字段合并与删除墓碑保证，不靠这次等待。
 * 等落盘结束再生成回执，改动没写进 users.json 时如实注明，别让 owner 以为封禁或提权已经落盘：
 * 加载失败而拒写时只在本次运行生效、重启即失；首次读取尚未落定（storage 未上线）时改动留在内存，读完后写盘；
 * 写盘失败时改动留在内存，下次保存时重写。
 */
async function applyUserChange(manager: AuthorityManager, change: () => void, message: string): Promise<string> {
  await manager.whenLoaded();
  change();
  manager.save();
  await manager.flushed();
  if (manager.persistBlocked) return `${message}；仅本次运行生效，未写入 users.json（加载失败，见日志）`;
  if (manager.awaitingFirstLoad) return `${message}；未写入 users.json（等级表尚未载入），载入后写入`;
  if (manager.lastSaveFailed) return `${message}；未写入 users.json（写入失败，见日志），下次保存时重试`;
  return message;
}

// ===== 权限的设置页（数字等级单轴：用户等级、owner、操作门槛、禁用与免确认）=====

/** 页面用到的能力：几个服务引用 + 这次激活自己的 manager 与宿主配置 */
type PageDeps = Pick<Caps, 'webui' | 'commands' | 'tools'> & { config: HostConfig; manager: AuthorityManager };

/** 表格里的身份写成「平台:用户 ID」，按第一个冒号拆回 */
function identityOf(key: string): UserIdentity {
  const sep = key.indexOf(':');
  if (sep < 1) throw new Error(`身份要写成「平台:用户 ID」，收到的是 ${key}`);
  return { platform: key.slice(0, sep), userId: key.slice(sep + 1) };
}

const CONFIRM_TEXT: Record<CapabilityConfirm, string> = { session: '每会话一次', always: '每次' };

/** 「禁用与免确认」表的两种规则：禁用写进 deniedCapabilities，免确认写进 restrictedPolicy.allow */
const RULE_KINDS = { deny: '禁用（连 owner 也拒）', waive: '免确认' } as const;
type RuleKind = keyof typeof RULE_KINDS;

/**
 * 权限页放在设置里。改宿主配置的动作先改运行态（即刻生效）再等落盘：save 拒绝时从处理函数抛出，写明改动已在本次运行
 * 生效、没写进配置文件及原因。等级改动走 applyUserChange，回执注明没落盘的情形。每次改动后页面重取，落盘失败也一样
 */
function defineAuthorityPage({ webui, commands, tools, config, manager }: PageDeps) {
  /** 指令与工具统一成「操作」：能力键、所属插件、后端派生的默认门槛（不含 authorityOverrides） */
  const operations = () => {
    const prefix = commands.current?.prefix ?? '/';
    const entries = [
      ...(commands.current?.getAll() ?? []).map(n => ({
        type: 'command' as const,
        name: n.name,
        display: `${prefix}${n.name.split('.').join(' ')}`,
        pluginName: n.pluginName,
        visibility: n.visibility,
        risk: n.risk,
        confirm: n.confirm,
      })),
      ...(tools.current?.getAll() ?? []).map(t => ({
        type: 'tool' as const,
        name: t.name,
        display: t.name,
        pluginName: t.pluginName,
        visibility: t.visibility,
        risk: t.risk,
        confirm: t.confirm,
      })),
    ];
    return entries.map(op => ({
      ...op,
      capability: `${op.type}:${op.name}`,
      minLevel: capabilityMinLevel({ risk: op.risk, visibility: op.visibility }),
    }));
  };
  const overrides = (): Record<string, number> => ({ ...(config.get('authorityOverrides') ?? {}) });
  const rules = (kind: RuleKind): string[] =>
    kind === 'deny' ? (config.get('deniedCapabilities') ?? []) : (config.get('restrictedPolicy')?.allow ?? []);
  const owners = (): UserIdentity[] => config.get('owners') ?? [];
  const sameIdentity = (a: UserIdentity, b: UserIdentity) => a.platform === b.platform && a.userId === b.userId;

  /** 写宿主配置并落盘，页面重取 */
  async function saveConfig(write: () => void, message: string): Promise<string> {
    write();
    try {
      await config.save();
    } catch (err) {
      throw new Error(`已在本次运行中生效，但没写进配置文件：${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    } finally {
      page.invalidate();
    }
    return message;
  }
  async function saveUser(change: () => void, message: string): Promise<string> {
    const receipt = await applyUserChange(manager, change, message);
    page.invalidate();
    return receipt;
  }
  async function setRules(kind: RuleKind, next: string[], message: string): Promise<string> {
    return saveConfig(() => {
      if (kind === 'deny') config.set('deniedCapabilities', next);
      else {
        config.set('restrictedPolicy', { ...config.get('restrictedPolicy'), allow: next });
        // 白名单的生效时长从这一刻起算
        if (next.length > 0) manager.markPolicyEnabled();
      }
    }, message);
  }
  async function addRule(kind: RuleKind, pattern: string): Promise<string> {
    const rule = pattern.trim();
    if (!rule) throw new Error('能力不能为空');
    const current = rules(kind);
    if (current.includes(rule)) throw new Error(`${rule} 已经在${RULE_KINDS[kind]}清单里`);
    return setRules(kind, [...current, rule], `已把 ${rule} 加进${RULE_KINDS[kind]}清单`);
  }
  async function setOverrides(capabilities: string[], level: number | undefined, message: string) {
    const next = overrides();
    for (const capability of capabilities) {
      if (level === undefined) delete next[capability];
      else next[capability] = level;
    }
    return saveConfig(() => config.set('authorityOverrides', next), message);
  }

  const RULE_INPUT = {
    pattern: {
      type: 'string',
      label: '能力',
      required: true,
      description: '能力键或通配，如 tool:shell_exec、command:level、tool:*',
    },
  } as const;
  const LEVEL_DESCRIPTION = '整数，越大权限越高；0 是默认，负数是封禁';
  const THRESHOLD = {
    level: { type: 'number', label: '最低等级', integer: true, description: '整数；留空恢复按风险派生的默认门槛' },
  } as const;

  const page = webui.definePage({
    key: 'authority',
    title: '权限',
    icon: 'shield',
    placement: 'settings',
    actions: {
      setUserLevel: {
        label: '设等级',
        effect: 'write',
        row: true,
        input: {
          level: { type: 'number', label: '等级', integer: true, required: true, description: LEVEL_DESCRIPTION },
        },
        handler: ({ rowKey, input }) =>
          saveUser(
            () => manager.setUserLevel(identityOf(rowKey), input.level),
            `${rowKey} 的等级已设为 ${input.level}`,
          ),
      },
      addUser: {
        label: '加用户',
        effect: 'write',
        input: {
          platform: { type: 'string', label: '平台', required: true, description: '如 onebot' },
          userId: { type: 'string', label: '用户 ID', required: true },
          level: { type: 'number', label: '等级', integer: true, required: true, description: LEVEL_DESCRIPTION },
        },
        handler: ({ input }) =>
          saveUser(
            () => manager.setUserLevel({ platform: input.platform, userId: input.userId }, input.level),
            `${input.platform}:${input.userId} 的等级已设为 ${input.level}`,
          ),
      },
      deleteUser: {
        label: '删除记录',
        effect: 'destructive',
        confirm: '删除这条记录？封禁的用户删掉记录就等于解封。',
        row: true,
        handler({ rowKey }) {
          const { platform, userId } = identityOf(rowKey);
          return saveUser(() => manager.removeUser(platform, userId), `${rowKey} 的记录已删除`);
        },
      },
      addOwner: {
        label: '加 owner',
        effect: 'write',
        input: {
          platform: { type: 'string', label: '平台', required: true, description: '如 onebot' },
          userId: { type: 'string', label: '用户 ID', required: true },
        },
        handler({ input }) {
          const owner = { platform: input.platform, userId: input.userId };
          if (owners().some(o => sameIdentity(o, owner)))
            throw new Error(`${input.platform}:${input.userId} 已经是 owner`);
          return saveConfig(
            () => config.set('owners', [...owners(), owner]),
            `已把 ${input.platform}:${input.userId} 加为 owner`,
          );
        },
      },
      removeOwner: {
        label: '移除',
        effect: 'destructive',
        confirm: '移除这个 owner？它之后按登记的等级裁决。',
        row: true,
        handler({ rowKey }) {
          const owner = identityOf(rowKey);
          if (!owners().some(o => sameIdentity(o, owner))) throw new Error(`${rowKey} 不是 owner`);
          return saveConfig(
            () =>
              config.set(
                'owners',
                owners().filter(o => !sameIdentity(o, owner)),
              ),
            `已移除 owner ${rowKey}`,
          );
        },
      },
      setGroupLevel: {
        label: '整组设门槛',
        effect: 'write',
        row: true,
        input: THRESHOLD,
        handler({ rowKey, input }) {
          const group = operations().filter(op => op.pluginName === rowKey);
          if (group.length === 0) throw new Error(`${rowKey} 没有登记指令或工具`);
          return setOverrides(
            group.map(op => op.capability),
            input.level,
            input.level === undefined
              ? `${rowKey} 的 ${group.length} 项操作已恢复默认门槛`
              : `${rowKey} 的 ${group.length} 项操作门槛已设为 ${input.level}`,
          );
        },
      },
      setOperationLevel: {
        label: '设门槛',
        effect: 'write',
        row: true,
        input: THRESHOLD,
        handler({ rowKey, input }) {
          if (!operations().some(op => op.capability === rowKey)) throw new Error(`没有操作 ${rowKey}`);
          return setOverrides(
            [rowKey],
            input.level,
            input.level === undefined ? `${rowKey} 已恢复默认门槛` : `${rowKey} 的门槛已设为 ${input.level}`,
          );
        },
      },
      denyCapability: {
        label: '禁用',
        effect: 'write',
        input: RULE_INPUT,
        handler: ({ input }) => addRule('deny', input.pattern),
      },
      waiveConfirm: {
        label: '免确认',
        effect: 'write',
        input: RULE_INPUT,
        handler: ({ input }) => addRule('waive', input.pattern),
      },
      removeRule: {
        label: '移除',
        effect: 'write',
        row: true,
        handler({ rowKey }) {
          const sep = rowKey.indexOf(':');
          const kind = rowKey.slice(0, sep) as RuleKind;
          const rule = rowKey.slice(sep + 1);
          const current = Object.hasOwn(RULE_KINDS, kind) ? rules(kind) : [];
          if (!current.includes(rule)) throw new Error(`没有这条规则：${rowKey}`);
          return setRules(
            kind,
            current.filter(r => r !== rule),
            `已把 ${rule} 移出${RULE_KINDS[kind]}清单`,
          );
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'users',
          title: '用户',
          content: [
            {
              type: 'table',
              id: 'users',
              rowKey: 'identity',
              description: `给外部身份设一个整数等级：越大权限越高，默认 ${DEFAULT_AUTHORITY}，负数是封禁；owner 不看等级。`,
              empty: `还没有登记的用户，所有人按默认等级 ${DEFAULT_AUTHORITY} 裁决`,
              columns: [
                { key: 'identity', label: '身份', primary: true },
                { key: 'level', label: '等级', primary: true },
                { key: 'note', label: '备注' },
              ],
              rowActions: [{ action: 'setUserLevel' }, { action: 'deleteUser' }],
              data: () =>
                manager
                  .listUsers()
                  .filter(u => !u.isOwner)
                  .map(u => ({ identity: `${u.platform}:${u.userId}`, level: u.level, note: u.note ?? '' })),
            },
            { type: 'actions', actions: ['addUser'] },
          ],
        },
        {
          key: 'owners',
          title: 'Owner',
          content: [
            {
              type: 'table',
              id: 'owners',
              rowKey: 'identity',
              description: 'owner 拥有全部权限；本机的控制台恒为 owner，不在这里列出。',
              empty: '没有另外登记的 owner',
              columns: [{ key: 'identity', label: '身份', primary: true }],
              rowActions: [{ action: 'removeOwner' }],
              data: () => owners().map(o => ({ identity: `${o.platform}:${o.userId}` })),
            },
            { type: 'actions', actions: ['addOwner'] },
          ],
        },
        {
          key: 'operations',
          title: '操作门槛',
          content: [
            {
              type: 'table',
              id: 'groups',
              rowKey: 'plugin',
              description: '每个指令与工具有一个最低等级，默认按风险派生（安全 0、敏感 1、危险 2）；多数不用动。',
              empty: '没有登记的指令或工具',
              columns: [
                { key: 'plugin', label: '插件', primary: true },
                { key: 'count', label: '操作数', primary: true },
                { key: 'overridden', label: '已改门槛' },
              ],
              rowActions: [{ action: 'setGroupLevel' }],
              data() {
                const set = overrides();
                const groups = new Map<string, { count: number; overridden: number }>();
                for (const op of operations()) {
                  const group = groups.get(op.pluginName) ?? { count: 0, overridden: 0 };
                  group.count++;
                  if (Object.hasOwn(set, op.capability)) group.overridden++;
                  groups.set(op.pluginName, group);
                }
                return [...groups]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([plugin, group]) => ({ plugin, ...group }));
              },
              detail: [
                {
                  type: 'table',
                  id: 'operations',
                  rowKey: 'capability',
                  columns: [
                    { key: 'display', label: '操作', primary: true },
                    { key: 'kind', label: '种类' },
                    { key: 'defaultLevel', label: '默认门槛' },
                    { key: 'effectiveLevel', label: '生效门槛', primary: true },
                    { key: 'confirm', label: '确认' },
                  ],
                  rowActions: [{ action: 'setOperationLevel' }],
                  data({ rowKey }) {
                    const set = overrides();
                    return operations()
                      .filter(op => op.pluginName === rowKey)
                      .map(op => ({
                        capability: op.capability,
                        display: op.display,
                        kind: op.type === 'command' ? '指令' : '工具',
                        defaultLevel: op.minLevel,
                        effectiveLevel: set[op.capability] ?? op.minLevel,
                        // 设门槛的表单按它预填：只有改过的才有
                        level: set[op.capability],
                        confirm: op.confirm ? CONFIRM_TEXT[op.confirm] : '',
                      }));
                  },
                },
              ],
            },
          ],
        },
        {
          key: 'rules',
          title: '禁用与免确认',
          content: [
            {
              type: 'table',
              id: 'rules',
              rowKey: 'key',
              description:
                '禁用压过一切，连 owner 也拒；免确认只免每会话一次的确认，不放宽等级，给自动化用。都可以写通配，如 tool:*。',
              empty: '没有禁用或免确认的规则',
              columns: [
                { key: 'rule', label: '能力', kind: 'code', primary: true },
                { key: 'kind', label: '规则', primary: true },
              ],
              rowActions: [{ action: 'removeRule' }],
              data: () =>
                (Object.keys(RULE_KINDS) as RuleKind[]).flatMap(kind =>
                  rules(kind).map(rule => ({ key: `${kind}:${rule}`, rule, kind: RULE_KINDS[kind] })),
                ),
            },
            { type: 'actions', actions: ['denyCapability', 'waiveConfirm'] },
          ],
        },
      ],
    },
  });
  return page;
}
