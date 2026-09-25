import type { CapabilityConfirm, ExecutionGuardContext, UserIdentity } from '@aalis/api-authority';
import { authority as authorityService, capabilityMinLevel } from '@aalis/api-authority';
import { commands as commandsService } from '@aalis/api-commands';
import { type HostConfig, hostConfig } from '@aalis/api-host-config';
import { getPlatformNames, platform as platformService } from '@aalis/api-platform';
import { createStorageGateway, storage as storageService } from '@aalis/api-storage';
import { tools as toolsService } from '@aalis/api-tools';
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { type BoundOf, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { setNetworkPolicy } from '@aalis/util-network-guard';
import { AuthorityManager } from './authority-manager.js';
import { autoConfirmActive, DEFAULT_AUTHORITY, shouldSkipConfirm } from './authority-model.js';

// 权限管理页（自定义 renderer 在 webui-client）。单 owner 终态无委托树，故无委托关系图。
const webuiPages: WebuiPage[] = [
  { key: 'authority', label: '权限管理', icon: 'authority', order: 50, renderer: 'authority' },
];

// ===== 插件入口 =====

// 裁决要读整份宿主配置（owners / deniedCapabilities / confirmOverrides…），缺了它权限系统无从裁决，
// 故 apply 里 require()、缺席即抛；但它由宿主在根上提供、没有任何插件 provide 它，写进激活闸
// 只会让依赖图上挂一条永远解析不到提供者的告警。被守卫、被管理的那几项
// （commands / tools / webui / storage / platform）缺席时只是少一条接线，不该拦住权限服务本身上线。
const uses = {
  provide,
  hostConfig: optional(hostConfig),
  logger,
  lifecycle,
  webui: optional(webuiServer),
  commands: optional(commandsService),
  tools: optional(toolsService),
  storage: optional(storageService),
  platform: optional(platformService),
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
  const { commands, lifecycle, logger, platform, storage, tools, webui } = caps;
  const config = caps.hostConfig.require();

  for (const page of webuiPages) webui.registerPage(page);

  const manager = new AuthorityManager(config, logger, createStorageGateway(storage));
  caps.provide(authorityService, manager);
  registerAdminActions({ webui, commands, tools, platform, config, manager });

  // 用户等级存于 data:/users.json，读取依赖 storage 服务。storage provider 可能晚于本插件
  // 上线（在 init 阶段直接 readFile 会失败且被静默吞 → 重启后等级不回载），故等 storage 就绪
  // 再 load，规避初始化时序竞态。follow 对「已在线」的服务也会立即触发，故任意加载序都成立。
  let loading: Promise<void> | undefined;
  // 读一次即完，storage 换人时没有要拆的东西，故不返回清理
  storage.follow(() => {
    loading = manager.init().then(
      () => logger.debug('授权用户等级已加载'),
      err => logger.warn(`授权用户等级加载失败: ${err}`),
    );
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
    // 等级裁决按授权身份（actor 缺省即会话身份）；accessBase 保持会话身份——
    // confirm 通道按 platform 选路必须落在会话所在平台，否则跨平台委派时
    // 确认提示会发进无人订阅的发起者平台通道、超时自动拒。
    const identity = g.actor ?? { platform: g.platform, userId: g.userId };
    const accessBase = {
      name: g.name,
      type: g.type,
      capability,
      args: g.args,
      sessionId: g.sessionId,
      platform: g.platform,
      userId: g.userId,
      signal: g.signal,
    } as const;

    // ── 轴 A · 授权：数字等级裁决（minLevel 由 risk/visibility/authorityOverrides 在 manager 内派生）——系统源也评估，防绕过提权 ──
    const denied = manager.authorize(identity, {
      capability,
      visibility: g.visibility,
      risk: g.risk,
    });
    if (denied) {
      // 未授权（等级不够 / 硬禁 / 资源受限）：**绝不**让发起者本人弹确认自我提权。
      // 仅 owner 预先配置的放行（restrictedPolicy 白名单 / 该用户在本会话已有的授予）可救；否则硬拒。
      // 注意：这里**不**调 requestAccess（那会询问发起者）——只查 isPreApproved（不问人）。
      if (g.skipConfirm) return denied;
      // 救援闸按会话身份查「某个人预先放行了自己」，只在被裁决的就是这个人时才成立。
      // actor 覆盖了会话身份（委派 / 定时 / 自发回合）时，物理发言者的白名单与授予不能替
      // 另一个身份解围——否则 interval 回合回填无主体 actor 后，owner 恰好最后发言时仍能
      // 借 owner 的 restrictedPolicy 白名单或会话授予免授权执行，且救援命中直接 return null
      // 连 confirm 轴（含 always 档）一并跳过。
      const sameIdentity = identity.platform === g.platform && identity.userId === g.userId;
      return sameIdentity && manager.isPreApproved(accessBase) ? null : denied;
    }

    // ── 轴 B · 确认：授权已过（含 owner / public / 已授予），但操作声明了 confirm 仍需「意图确认」 ──
    // 仅对**已授权**操作做意图确认（owner 也吃，防注入借权）；不是提权入口。
    // 跳过判定见 shouldSkipConfirm：always 永不跳（cron 无人确认即拒）；非 always 可被
    // skipConfirm(系统/受信源) 或 owner 本人 auto 模式 跳过。**不能**用 `!g.skipConfirm`
    // 门控整块 → 那会让 skipConfirm 连 always 一起绕过。
    if (confirm) {
      const skip = shouldSkipConfirm({
        confirm,
        skipConfirm: !!g.skipConfirm,
        isOwner: manager.isOwner(identity.platform, identity.userId),
        autoConfirmUntil: (config.get('autoConfirmUntil') as number) ?? 0,
        now: Date.now(),
      });
      if (!skip) {
        const hasChannel = manager.hasConfirmHandler(g.platform); // await 前取：等待期间通道可能被注销
        const ok = await manager.requestAccess({ ...accessBase, confirm });
        if (!ok) {
          return hasChannel
            ? `操作已取消：${capability} 需确认后执行`
            : `操作已取消：${capability} 需确认后执行，但平台 ${g.platform} 没有确认通道（未安装 @aalis/plugin-session-confirm）`;
        }
      }
    }
    return null;
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
      manager.setUserLevel({ platform: t.slice(0, sep), userId: t.slice(sep + 1) }, lv);
      manager.save();
      return `已设 ${t} 等级: ${lv}`;
    });

  // /auto [分钟|off|on] — owner 临时免 dangerous 二次确认（批处理便利）。on=一直, off=关, 数字=分钟。
  commands
    .command('auto [arg:string]', '自动确认模式：临时免 dangerous 二次确认（仅 owner 本人）', {
      visibility: 'restricted',
    })
    .example('/auto 30')
    .example('/auto off')
    .action(async (argv, arg) => {
      if (!manager.isOwner(argv.session.platform, argv.session.userId)) return '只有 owner 可管理权限';
      const a = arg === undefined ? undefined : String(arg).trim().toLowerCase();
      const setUntil = async (u: number) => {
        config.set('autoConfirmUntil', u);
        await config.save();
      };
      if (a === undefined) {
        const u = (config.get('autoConfirmUntil') as number) ?? 0;
        if (u === -1) return '自动确认：一直开启';
        if (autoConfirmActive(u, Date.now())) return `自动确认：开启中，剩 ${Math.ceil((u - Date.now()) / 60000)} 分钟`;
        return '自动确认：关闭';
      }
      if (a === 'off' || a === '0') {
        await setUntil(0);
        return '已关闭自动确认';
      }
      if (a === 'on') {
        await setUntil(-1);
        return '已开启自动确认（一直，直到手动关闭）';
      }
      const m = Number(a);
      if (!Number.isInteger(m) || m <= 0) return '用法：/auto <分钟> | off | on';
      await setUntil(Date.now() + m * 60000);
      return `已开启自动确认 ${m} 分钟`;
    });
}

// ===== WebUI 页面动作（数字等级单轴：用户等级 + 操作门槛 + owner 列表 + 高级）=====

function asStringList(v: unknown, label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${label} 必须是字符串数组`);
  return v as string[];
}

/** 页面动作用到的能力：几个服务引用 + 这次激活自己的 manager 与宿主配置 */
type AdminDeps = Pick<Caps, 'webui' | 'commands' | 'tools' | 'platform'> & {
  config: HostConfig;
  manager: AuthorityManager;
};

function registerAdminActions({ webui, commands, tools, platform, config, manager }: AdminDeps): void {
  /** 权限概览：用户等级 + owner + 操作门槛/确认 + 临时放行 + 受限/禁用清单 */
  webui.registerAction('getOverview', async () => {
    const users = manager.listUsers();
    const owners: UserIdentity[] = config.get('owners') ?? [];
    const commandsSvc = commands.current;
    const commandPrefix = commandsSvc?.prefix ?? '/';
    const cmdNodes = commandsSvc?.getAll() ?? [];
    const toolList = tools.current?.getAll() ?? [];
    const platforms = Array.from(
      new Set([
        ...getPlatformNames(platform),
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
      deniedCapabilities: config.get('deniedCapabilities') ?? [],
      authorityOverrides: config.get('authorityOverrides') ?? {},
      defaultAuthority: DEFAULT_AUTHORITY,
      confirmOverrides: config.get('confirmOverrides') ?? {},
      autoConfirmUntil: (config.get('autoConfirmUntil') as number) ?? 0,
      restrictedPolicy: config.get('restrictedPolicy') ?? {},
      temporaryGrants: manager.listTemporaryGrants(),
      commandPrefix,
      // 操作清单：指令 + 工具统一带 pluginName/type/confirm，供前端「操作」视图按插件分组、显示两轴默认。
      //
      // `minLevel` 是**派生默认值**（不含 authorityOverrides）——定级这件事收在权限服务这一侧，
      // 前端只渲染，不得自算：前端一旦自带一份 `derivedMinLevel`，risk 为非联合成员的真值串时
      // 就与后端分歧（后端落 visibility 兜底=2、前端只要 risk 为真就吐 0），方向是 fail-open 的显示。
      // overrides 不能由后端算进去：它是前端正在编辑中的状态，同一份 payload 里已整体下发。
      commands: cmdNodes.map(n => ({
        key: n.name,
        name: n.name,
        type: 'command' as const,
        displayName: `${commandPrefix}${n.name.split('.').join(' ')}`,
        pluginName: n.pluginName,
        visibility: n.visibility ?? 'public',
        confirm: n.confirm,
        risk: n.risk,
        minLevel: capabilityMinLevel({ risk: n.risk, visibility: n.visibility }),
      })),
      tools: toolList.map(t => ({
        key: t.name,
        name: t.name,
        type: 'tool' as const,
        displayName: t.name,
        pluginName: t.pluginName,
        visibility: t.visibility ?? 'public',
        confirm: t.confirm,
        risk: t.risk,
        minLevel: capabilityMinLevel({ risk: t.risk, visibility: t.visibility }),
      })),
    };
  });

  /** 设置外部身份等级（覆盖式整数）。权限管理仅 owner 可达（防自我提权）。 */
  webui.registerAction('setUserLevel', async (args, caller) => {
    const { platform, userId, level } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    if (typeof level !== 'number' || !Number.isInteger(level)) throw new Error('level 必须是整数');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    manager.setUserLevel({ platform: platform as string, userId: userId as string }, level);
    manager.save();
    return { message: `${platform}:${userId} 等级已更新为 ${level}` };
  });

  /** 删除用户记录（仅 owner 可达：删掉封禁记录等于解封） */
  webui.registerAction('deleteUser', async (args, caller) => {
    const { platform, userId } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    manager.removeUser(platform as string, userId as string);
    manager.save();
    return { message: `${platform}:${userId} 记录已删除` };
  });

  /** 更新 owner 列表（仅 owner 可达：防非 owner 把自己加成 owner 提权） */
  webui.registerAction('setOwners', async (args, caller) => {
    const owners = args.owners;
    if (!Array.isArray(owners)) throw new Error('owners 必须是数组');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理 owner 列表');
    config.set('owners', owners);
    await config.save();
    return { message: 'Owner 列表已更新' };
  });

  /** 更新受限能力的临时放行策略（restrictedPolicy）。仅 owner 可达：这是给受限能力开白名单。 */
  webui.registerAction('setRestrictedPolicy', async (args, caller) => {
    const policy = args.policy as Record<string, unknown>;
    if (!policy || typeof policy !== 'object') throw new Error('policy 必须是对象');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    config.set('restrictedPolicy', policy);
    if (Array.isArray(policy.allow) && policy.allow.length > 0) manager.markPolicyEnabled();
    // 内存态先整体落定再等落盘：save 拒绝会从这里抛出，其后的语句不再执行
    await config.save();
    return { message: '临时放行策略已更新' };
  });

  /** 撤销一个临时能力委托（仅 owner 可达） */
  webui.registerAction('revokeTemporaryGrant', async (args, caller) => {
    const id = args.id as string;
    if (!id) throw new Error('id 必填');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const ok = manager.revokeTemporaryGrant(id);
    return { ok, message: ok ? '临时委托已撤销' : '不存在或已过期' };
  });

  /** owner 覆盖单条操作的最低等级（任意整数），无需改插件声明。key=能力键 `type:name`；传非整数则清除该条（回退默认派生）。 */
  webui.registerAction('setAuthorityOverride', async (args, caller) => {
    const { name, level } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const overrides = { ...((config.get('authorityOverrides') ?? {}) as Record<string, number>) };
    if (typeof level === 'number' && Number.isInteger(level)) overrides[name] = level;
    else delete overrides[name];
    config.set('authorityOverrides', overrides);
    // 门槛变了就撤掉该能力上的旧会话授予：否则 authorize 已按新门槛拒绝，守卫的救援闸
    // 仍会靠旧授予放行，而救援命中直接 return null、连 confirm 轴（含 always）一并跳过。
    // 撤销与门槛更新必须在同一同步段完成，再等落盘：save 拒绝会从 await 抛出。
    const revoked = manager.revokeGrantsOfCapability(name);
    await config.save();
    return {
      message: `操作 ${name} 最低等级已更新${revoked > 0 ? `（已撤销 ${revoked} 条相关会话授予）` : ''}`,
    };
  });

  /** owner 覆盖单条操作的确认要求（session/always/off）。key=能力键 `type:name`；非法值清除该条。 */
  webui.registerAction('setConfirmOverride', async (args, caller) => {
    const { name, confirm } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const overrides = { ...((config.get('confirmOverrides') ?? {}) as Record<string, CapabilityConfirm | 'off'>) };
    if (confirm === 'session' || confirm === 'always' || confirm === 'off') overrides[name] = confirm;
    else delete overrides[name];
    config.set('confirmOverrides', overrides);
    await config.save();
    return { message: `操作 ${name} 确认要求已更新` };
  });

  /** owner 切换 auto 确认模式。minutes: -1=一直 / 0=关 / N=N 分钟。仅 owner 可达。 */
  webui.registerAction('setAutoConfirm', async (args, caller) => {
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const m = args.minutes;
    if (typeof m !== 'number' || !Number.isInteger(m)) throw new Error('minutes 必须是整数（-1 一直 / 0 关 / N 分钟）');
    const until = m === -1 ? -1 : m <= 0 ? 0 : Date.now() + m * 60000;
    config.set('autoConfirmUntil', until);
    await config.save();
    return { message: until === -1 ? '自动确认：一直' : until === 0 ? '自动确认：关' : `自动确认：${m} 分钟`, until };
  });

  /** 更新禁用能力清单（仅 owner 可达：这是压过一切的硬禁总闸） */
  webui.registerAction('setConfig', async (args, caller) => {
    if (caller && !manager.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
    const denied = asStringList(args.deniedCapabilities, 'deniedCapabilities');
    if (denied) config.set('deniedCapabilities', denied);
    await config.save();
    return { message: '权限配置已更新' };
  });
}
