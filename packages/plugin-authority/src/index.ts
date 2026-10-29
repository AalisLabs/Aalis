import { approvals } from '@aalis/api-approval';
import type { CapabilityConfirm, ExecutionGuardContext, UserIdentity, Verdict } from '@aalis/api-authority';
import { authority as authorityService, capabilityMinLevel, sameParticipant } from '@aalis/api-authority';
import { commands as commandsService } from '@aalis/api-commands';
import { contributions as contributionsService } from '@aalis/api-contributions';
import { type HostConfig, hostConfig } from '@aalis/api-host-config';
import { sessionFields } from '@aalis/api-session-settings';
import { storage as storageService } from '@aalis/api-storage';
import { tools as toolsService } from '@aalis/api-tools';
import { type NoticeHandle, webuiServer } from '@aalis/api-webui';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { isUnsafeConfigKey } from '@aalis/schema-config';
import { isTextError, TextError, type TextRef, textClauses, textLines, textOf } from '@aalis/schema-i18n';
import { setNetworkPolicy } from '@aalis/util-network-guard';
import { AuthorityManager } from './authority-manager.js';
import { DEFAULT_AUTHORITY, isGrantEntry, isGroupName } from './authority-model.js';
import { t } from './texts.js';

// ===== 插件入口 =====

// 裁决要读整份宿主配置（owners / deniedCapabilities / confirmOverrides…），缺了它权限系统无从裁决，
// 故 apply 里直接用它的业务句柄、缺席即抛；但它由宿主在根上提供、没有任何插件 provide 它，写进激活闸
// 只会让依赖图上挂一条永远解析不到提供者的告警。被守卫、被管理的那几项
// （commands / tools / webui / storage）缺席时只是少一条接线，不该拦住权限服务本身上线。
// approvals 缺席时需要确认的工具调用一律拒绝。权限页的两个可选项来源经贡献点交付，缺席时页上的多选没有选项。
// 「操作门槛」里的设置项来自会话设置的只读列举，会话设置缺席时这一类为空。
const uses = {
  provide,
  hostConfig: optional(hostConfig),
  events,
  logger,
  lifecycle,
  webui: optional(webuiServer),
  commands: optional(commandsService),
  tools: optional(toolsService),
  storage: optional(storageService),
  approvals: optional(approvals),
  sessionFields: optional(sessionFields),
  contributions: optional(contributionsService),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-authority',
  displayName: t('displayName'),
  subsystem: 'authority',
  provides: [authorityService],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { commands, contributions, events, lifecycle, logger, storage, tools, webui } = caps;
  const config = caps.hostConfig.use;

  const manager = new AuthorityManager(config, logger.use, storage.use);
  caps.provide.use(authorityService, manager);
  const page = defineAuthorityPage({
    webui,
    commands,
    tools,
    sessionFields: caps.sessionFields,
    contributions,
    config,
    manager,
  });

  // 用户等级存于 data:/users.json，读取依赖 storage 服务。storage provider 可能晚于本插件
  // 上线（在 init 阶段直接 readFile 会失败且被静默吞 → 重启后等级不回载），故等 storage 就绪
  // 再 load，规避初始化时序竞态。follow 对「已在线」的服务也会立即触发，故任意加载序都成立。
  let loading: Promise<void> | undefined;
  // users.json 读不出来时拒写，文件里的封禁与等级也没载入：发提示让 owner 在「需要处理」看到，重读成功后撤回
  let loadNotice: NoticeHandle | undefined;
  const reportLoad = (): void => {
    loadNotice?.clear();
    const reason = manager.lastLoadError;
    loadNotice =
      reason === undefined
        ? undefined
        : webui.use.notify({
            id: 'users-load',
            level: 'error',
            title: t('loadFailedTitle'),
            detail: t('loadFailedDetail', { reason }),
          });
  };
  // 读一次即完，storage 换人时没有要拆的东西，故不返回清理
  storage.follow(() => {
    loading = manager
      .init()
      .then(
        () => logger.use.debug('授权用户等级已加载'),
        // err 作参数交给 logger 渲染：模板字符串遇到转不成字符串的值会抛，被下面的兜底吞掉、一条告警都不留
        err => logger.use.warn('授权用户等级加载失败:', err),
      )
      .then(reportLoad)
      // 上报器自身失败（宿主经 AppOptions 注入的 logger 或它的时钟抛错）不再外抛，成败两条回调都算：
      // storage 已在线时下面的 await 会让激活失败，晚上线时没人等这个 Promise，未处理的拒绝会被宿主当致命错误退出进程
      .catch(() => {});
  });
  // storage 已在线时 follow 是同步首挂：把加载等完再让 apply 返回，避免「等级表还空着
  // 就开始裁决」的窗口（封禁用户在这段时间按默认 0 级通过）。storage 晚上线时无从等待，仍异步。
  if (loading) await loading;

  // 网络出口闸（SSRF）：把宿主配置 network 注入进程级 safeFetch 策略。network 是宿主文档的顶层字段，文档变了（change 带 document）
  // 就重新注入，改了即时生效；写错时经出网闸的请求一律失败、权限照常裁决，并记一条 warn，不等出网时才发现。
  // 安全归属在权限域；本地固定服务走裸 fetch、不过 safeFetch，故不受影响。
  const injectNetwork = (): void => {
    const problem = setNetworkPolicy(config.get('network') ?? {});
    if (problem) logger.use.warn(problem);
  };
  injectNetwork();
  events.use.on('host-config:changed', change => {
    if ('document' in change) injectNetwork();
  });

  // ===== 执行守卫：两轴正交闸 —— 轴 A 授权（authorize）+ 轴 B 确认（confirm，owner 也吃）=====
  // 多人的一轮按动作判，对每个参与者各裁决一次：都过照常执行；有人过、有人不过，这一个调用要一道参与者审批，凡自己就能做的人
  // 都能批；都不过照旧拒，没有人能为它担保。一轮里能做的因此不超过参与者里最高的那位，也不用把权限排出高低（权限组让两个人
  // 各能做对方做不了的事时照样判得出）。工具执行中经 approveFor 交来的取用判定按同一条三分，判据换成它
  const isOwner = (who: UserIdentity) => manager.isOwner(who.platform, who.userId);
  const guard = async (g: ExecutionGuardContext): Promise<Verdict> => {
    const capability = `${g.type}:${g.name}`;
    // ── 轴 A · 授权：等级与权限组裁决——系统源也评估，防绕过提权。不看物理发言者
    const judge =
      g.check ??
      ((who: UserIdentity): Verdict => {
        const denied = manager.authorize(who, {
          capability,
          visibility: g.visibility,
          risk: g.risk,
          toolGroups: g.toolGroups,
        });
        return denied ? { ok: false, reason: denied } : { ok: true };
      });
    const verdicts = g.participants.map(judge);
    if (!verdicts.some(verdict => verdict.ok)) {
      // 一位参与者时用它的原因；几位时取用判定取第一位的，等级裁决不转述别人的拒绝语
      const [first] = verdicts;
      return first && (verdicts.length === 1 || g.check) ? first : { ok: false, reason: t('nobodyCan') };
    }
    const someCannot = verdicts.some(verdict => !verdict.ok);

    // ── 轴 B · 确认：操作声明了 confirm 仍要 owner 确认（owner 也吃，防注入借权）。免确认（确认覆盖 'off'、没人可问的受信来源
    // skipConfirm、owner 配的 restrictedPolicy 白名单）只在参与者都是 owner 时生效；always 只有确认覆盖 'off' 能免。
    // 取用判定不再判：确认在这次调用开始时已经判过
    const ownerActs = g.participants.length > 0 && g.participants.every(isOwner);
    const confOv = (config.get('confirmOverrides') ?? {}) as Record<string, CapabilityConfirm | 'off'>;
    const cOv = confOv[capability];
    // 确认覆盖 'off' 有别人时回落到声明的
    const override = cOv === 'off' && !ownerActs ? undefined : cOv;
    const confirm = g.check || override === 'off' ? undefined : (override ?? g.confirm);
    const waived = confirm !== 'always' && ownerActs && (g.skipConfirm || manager.waivesConfirm(capability));
    const ownerOnly = confirm !== undefined && !waived;
    if (!someCannot && !ownerOnly) return { ok: true };

    // 指令由人亲手输入，参与者只有发出者，走到这里的只有确认：确认的是发出者本人的意图，由指令服务当面问；问不到（注入的指令）就拒
    if (g.type === 'command') {
      if (!g.confirmIntent) return { ok: false, reason: t('intentUnreachable', { capability }) };
      return (await g.confirmIntent()) ? { ok: true } : { ok: false, reason: t('intentDeclined', { capability }) };
    }

    // 工具由模型调用：要确认的与参与者审批合成一张，只有 owner 能批；其余是参与者审批，自己就能做的人能批。哪些回合能产生审批
    // 由审批服务按发起类别与参与者裁决，不能的立即拒绝、不推给任何面
    if (!caps.approvals.present) return { ok: false, reason: t('approvalsAbsent', { capability }) };
    const outcome = await caps.approvals.use.request(
      {
        sessionId: g.sessionId,
        turnId: g.turnId,
        callId: g.callId,
        origin: { kind: manager.originOf(g), participants: [...g.participants] },
        tool: g.name,
        args: g.args ?? {},
        rule: ownerOnly
          ? cOv === confirm
            ? `confirmOverrides 把 ${capability} 设为 ${cOv}`
            : `${capability} 声明 confirm=${confirm}`
          : `这一轮的参与者里有人自己做不了这次 ${capability}`,
        canAnswer: ownerOnly ? isOwner : who => judge(who).ok,
        ownerOnly,
      },
      g.signal,
    );
    if (!outcome.approved) return { ok: false, reason: outcome.message };
    // 批的人替这个动作担保：他就是参与者之一时取那个参与者的身份（owner 的各个身份算一个）
    const by =
      g.participants.find(who =>
        sameParticipant(who, outcome.by, (platform, userId) => manager.isOwner(platform, userId)),
      ) ?? outcome.by;
    return { ok: true, by };
  };

  // 注入到 commands / tools（follow 在 provider 上线/重启时各调一次）。本插件停用时摘掉：守卫闭包里是这次激活的等级表与
  // 审批服务，留着的话停用之后执行仍按旧的裁决，帮助却已按没有权限服务列。摘掉后两处退回 fail-closed
  //（需要更高等级或确认的一律拒绝）
  commands.follow(svc => {
    svc.setExecutionGuard(guard);
    logger.use.debug('权限守卫已注入: commands');
    return () => svc.setExecutionGuard(undefined);
  });
  tools.follow(svc => {
    svc.setExecutionGuard(guard);
    logger.use.debug('权限守卫已注入: tools');
    return () => svc.setExecutionGuard(undefined);
  });

  // 落盘走 onDispose 而非 app:stopping：后者只在全局停机触发一次，覆盖不了
  // bounce / unload / disable / 依赖降级级联这些拆卸路径，热重载即丢等级数据。
  //
  // 必须 async 并 await flushed()：save() 只是把写挂到 saveChain 上就同步返回，
  // 而清理链只在回调返回 thenable 时才等待——回调返回 void 时整条拆卸链一个环节都不等
  // 这次写，CLI 子命令退出与 bounce 都会静默丢掉封禁/等级。
  // flushed() 无条件 await：dirty 已为 false 时 save() 会早退，要等的是先前挂上去的那次写。
  lifecycle.use.onDispose(async () => {
    manager.save();
    await manager.flushed();
  });

  // ===== 权限指令 =====

  // /authority [target] — 查看自己或指定用户的权限等级
  // 读类敏感操作：会披露他人的权限等级 → risk:'sensitive'（等级 1，不强制确认）。
  commands.use
    .command('authority [target:string]', t('authorityDescription'), { risk: 'sensitive' })
    .action(async (argv, target) => {
      const describe = (platform: string, userId: string | undefined, self: boolean): TextRef => {
        const who = `${platform}:${userId}`;
        if (manager.isOwner(platform, userId)) return self ? t('ownerSelf') : t('ownerOther', { who });
        const entry = userId
          ? manager.listUsers().find(u => u.platform === platform && u.userId === userId)
          : undefined;
        const level = entry?.level ?? DEFAULT_AUTHORITY;
        const line = self ? t('levelSelf', { level }) : t('levelOther', { who, level });
        if (!entry?.groups.length) return line;
        return textLines([line, t('memberOf', { groups: memberGroups(manager, entry.groups) })]);
      };
      if (target) {
        const identity = targetOf(String(target));
        if (!identity) return t('targetFormat');
        return describe(identity.platform, identity.userId, false);
      }
      return describe(argv.session.platform, argv.session.userId, true);
    });

  // /level <target> <整数> — owner 给外部身份设等级（越大越高，0=默认，负数=封禁）。权限管理仅 owner 可达（防自授）。
  commands.use
    .command('level <target:string> <level:number>', t('levelDescription'), { visibility: 'restricted' })
    .example('/level onebot:12345 5')
    .action(async (argv, target, level) => {
      if (!manager.isOwner(argv.session.platform, argv.session.userId)) return t('ownerOnly');
      const spec = String(target);
      const identity = targetOf(spec);
      if (!identity) return t('targetFormat');
      const lv = Number(level);
      if (!Number.isInteger(lv)) return t('levelNotInteger');
      const message = await applyUserChange(
        manager,
        () => manager.setUserLevel(identity, lv),
        t('levelSet', { target: spec, level: lv }),
      );
      page.invalidate();
      return message;
    });

  // /perm <target> [组名…] — owner 覆盖式设外部身份所属的权限组，不给组名即清空。组的定义只在权限页与配置里改
  commands.use
    .command('perm <target:string> [groups:text]', t('permDescription'), { visibility: 'restricted' })
    .example('/perm onebot:12345 helpers')
    .action(async (argv, target, groups) => {
      if (!manager.isOwner(argv.session.platform, argv.session.userId)) return t('ownerOnly');
      const spec = String(target);
      const identity = targetOf(spec);
      if (!identity) return t('targetFormat');
      const names = [...new Set(String(groups ?? '').match(/\S+/g))];
      try {
        const message = await applyUserChange(
          manager,
          () => manager.setUserGroups(identity, names),
          groupsReceipt(spec, names),
        );
        page.invalidate();
        return message;
      } catch (err) {
        // 这次新加的组没定义：setUserGroups 拒收并列出已有的组，原样回给 owner
        if (isTextError(err)) return err.text;
        throw err;
      }
    });
}

/** 成员记录里的组名，没定义的标出来（删组不级联，成员记录里的组名保留） */
function memberGroups(manager: AuthorityManager, names: readonly string[]): Array<string | TextRef> {
  const defined = manager.definedGroups();
  return names.map(name => (defined.has(name) ? name : t('undefinedGroup', { name })));
}

/** 设权限组的回执：给了组名就列出来，没给即清空 */
function groupsReceipt(target: string, names: readonly string[]): TextRef {
  return names.length > 0 ? t('groupsSet', { target, groups: names }) : t('groupsCleared', { target });
}

/**
 * 等级与组成员的管理入口（/level、/perm、权限页的设等级、设权限组、加用户与删除记录）的共同流程。
 * 先等在飞的等级表读取落定再改：首次读取完成前内存里查不到文件里的记录。storage 未上线时首次读取尚未发起，
 * 这里无从等待：改等级（含降为 0 级）保留文件里的备注、删除不随文件回来，由 setUserLevel 在首次读取落定前不删记录、
 * UserStore 的字段合并与删除墓碑保证，不靠这次等待。
 * 等落盘结束再生成回执，改动没写进 users.json 时如实注明，别让 owner 以为封禁或提权已经落盘：
 * 加载失败而拒写时只在本次运行生效、重启即失；首次读取尚未落定（storage 未上线）时改动留在内存，读完后写盘；
 * 写盘失败时改动留在内存，下次保存时重写。
 */
async function applyUserChange(manager: AuthorityManager, change: () => void, message: TextRef): Promise<TextRef> {
  await manager.whenLoaded();
  change();
  manager.save();
  await manager.flushed();
  if (manager.persistBlocked) return textClauses([message, t('persistBlocked')]);
  if (manager.awaitingFirstLoad) return textClauses([message, t('awaitingFirstLoad')]);
  if (manager.lastSaveFailed) return textClauses([message, t('saveFailedRetry')]);
  return message;
}

// ===== 权限的设置页（用户等级、权限组、owner、操作门槛、禁用与免确认）=====

/** 页面用到的能力：几个服务引用 + 这次激活自己的 manager 与宿主配置 */
type PageDeps = Pick<Caps, 'webui' | 'commands' | 'tools' | 'sessionFields' | 'contributions'> & {
  config: HostConfig;
  manager: AuthorityManager;
};

/** 「平台:用户 ID」按第一个冒号拆开；没有冒号或平台为空时取不到 */
function targetOf(spec: string): UserIdentity | undefined {
  const sep = spec.indexOf(':');
  return sep < 1 ? undefined : { platform: spec.slice(0, sep), userId: spec.slice(sep + 1) };
}

/** 表格里的身份写成「平台:用户 ID」，按第一个冒号拆回 */
function identityOf(key: string): UserIdentity {
  const identity = targetOf(key);
  if (!identity) throw new TextError(t('badIdentity', { key }));
  return identity;
}

const CONFIRM_TEXT: Record<CapabilityConfirm, TextRef> = { session: t('confirmSession'), always: t('confirmAlways') };

/** 「禁用与免确认」表的两种规则：禁用写进 deniedCapabilities，免确认写进 restrictedPolicy.allow；显示名与回执按种类取 */
const RULE_KINDS = ['deny', 'waive'] as const;
type RuleKind = (typeof RULE_KINDS)[number];

/**
 * 权限页放在设置里。改宿主配置的动作先改运行态（即刻生效）再等落盘：save 拒绝时从处理函数抛出，写明改动已在本次运行
 * 生效、没写进配置文件及原因。等级改动走 applyUserChange，回执注明没落盘的情形。每次改动后页面重取，落盘失败也一样
 */
function defineAuthorityPage({ webui, commands, tools, sessionFields, contributions, config, manager }: PageDeps) {
  /**
   * 指令、工具与设置项统一成「操作」：能力键、所属插件（设置项是实例）、默认门槛（指令与工具按风险派生，设置项按声明，没写的
   * 只有 owner；不含 authorityOverrides）
   */
  const operations = () => {
    const prefix = commands.present ? commands.use.prefix : '/';
    const entries = [
      ...(commands.present ? commands.use.getAll() : []).map(n => ({
        type: 'command' as const,
        name: n.name,
        display: `${prefix}${n.name.split('.').join(' ')}`,
        pluginName: n.pluginName,
        visibility: n.visibility,
        risk: n.risk,
        confirm: n.confirm,
      })),
      ...(tools.present ? tools.use.getAll() : []).map(tool => ({
        type: 'tool' as const,
        name: tool.name,
        display: tool.name,
        pluginName: tool.pluginName,
        visibility: tool.visibility,
        risk: tool.risk,
        confirm: tool.confirm,
      })),
    ];
    const settings = (sessionFields.present ? sessionFields.use.getAll() : []).map(entry => ({
      type: 'setting' as const,
      name: `${entry.plugin}/${entry.key}`,
      display: entry.label,
      pluginName: entry.plugin,
      confirm: undefined,
      minLevel: entry.minLevel ?? Number.POSITIVE_INFINITY,
    }));
    return [
      ...entries.map(op => ({
        ...op,
        capability: `${op.type}:${op.name}`,
        minLevel: capabilityMinLevel({ risk: op.risk, visibility: op.visibility }),
      })),
      ...settings.map(op => ({ ...op, capability: `${op.type}:${op.name}` })),
    ];
  };
  /** 门槛的显示：只有 owner 的不写 Infinity */
  const levelText = (level: number) => (level === Number.POSITIVE_INFINITY ? t('ownerOnlyLevel') : level);
  const KIND_TEXT = { command: t('commandKind'), tool: t('toolKind'), setting: t('settingKind') };
  const overrides = (): Record<string, number> => ({ ...(config.get('authorityOverrides') ?? {}) });
  const rules = (kind: RuleKind): string[] =>
    kind === 'deny' ? (config.get('deniedCapabilities') ?? []) : (config.get('restrictedPolicy')?.allow ?? []);
  const owners = (): UserIdentity[] => config.get('owners') ?? [];
  const sameIdentity = (a: UserIdentity, b: UserIdentity) => a.platform === b.platform && a.userId === b.userId;

  // 两个可选项来源（贡献点 webui:options）：放行条目可选全部指令与工具的能力键与已登记的工具分组，设权限组可选已定义的组，
  // 另列成员记录里指向的、已删掉的组并标出来：设权限组按这一行预填，原有的组照样能保存
  contributions.use.contribute('webui:options', {
    id: 'authority-operations',
    list: () =>
      [
        ...operations()
          .filter(op => op.type !== 'setting')
          .map(op => op.capability),
        ...(tools.present ? tools.use.getGroups() : []).map(group => `tool-group:${group.name}`),
      ].map(value => ({ value, label: value })),
  });
  contributions.use.contribute('webui:options', {
    id: 'authority-groups',
    list: () => {
      const names = [...new Set([...manager.definedGroups().keys(), ...manager.listUsers().flatMap(u => u.groups)])];
      const labels = memberGroups(manager, names);
      return names.map((value, i) => ({ value, label: labels[i] }));
    },
  });

  /** 写宿主配置并落盘，页面重取 */
  async function saveConfig(write: () => void, message: TextRef): Promise<TextRef> {
    write();
    try {
      await config.save();
    } catch (err) {
      throw new TextError(t('configSaveFailed', { error: textOf(err) }), { cause: err });
    } finally {
      page.invalidate();
    }
    return message;
  }
  async function saveUser(change: () => void, message: TextRef): Promise<TextRef> {
    const receipt = await applyUserChange(manager, change, message);
    page.invalidate();
    return receipt;
  }
  async function setRules(kind: RuleKind, next: string[], message: TextRef): Promise<TextRef> {
    return saveConfig(() => {
      if (kind === 'deny') config.set('deniedCapabilities', next);
      else {
        config.set('restrictedPolicy', { ...config.get('restrictedPolicy'), allow: next });
        // 白名单的生效时长从这一刻起算
        if (next.length > 0) manager.markPolicyEnabled();
      }
    }, message);
  }
  async function addRule(kind: RuleKind, pattern: string): Promise<TextRef> {
    const rule = pattern.trim();
    if (!rule) throw new TextError(t('emptyCapability'));
    const current = rules(kind);
    if (current.includes(rule)) throw new TextError(t('ruleExists', { rule, kind }));
    return setRules(kind, [...current, rule], t('ruleAdded', { rule, kind }));
  }
  async function setOverrides(capabilities: string[], level: number | undefined, message: TextRef) {
    const next = overrides();
    for (const capability of capabilities) {
      if (level === undefined) delete next[capability];
      else next[capability] = level;
    }
    return saveConfig(() => config.set('authorityOverrides', next), message);
  }
  /** 写一个组的放行条目：写法不对的当场报错；别的组原样写回 */
  async function setGroup(name: string, entries: readonly string[], message: TextRef): Promise<TextRef> {
    const next = [...new Set(entries.map(entry => entry.trim()))];
    const bad = next.filter(entry => !isGrantEntry(entry));
    if (bad.length > 0) throw new TextError(t('badEntries', { entries: bad }));
    return saveConfig(() => config.set('authorityGroups', { ...config.get('authorityGroups'), [name]: next }), message);
  }

  const RULE_INPUT = {
    pattern: { type: 'string', label: t('capability'), required: true, description: t('patternHint') },
  } as const;
  const LEVEL_DESCRIPTION = t('levelHint');
  const THRESHOLD = {
    level: { type: 'number', label: t('minLevel'), integer: true, description: t('thresholdHint') },
  } as const;
  const IDENTITY_INPUT = {
    platform: { type: 'string', label: t('platform'), required: true, description: t('platformHint') },
    userId: { type: 'string', label: t('userId'), required: true },
  } as const;
  const GRANTS = {
    entries: {
      type: 'multiselect',
      label: t('groupGrants'),
      required: true,
      dynamicOptions: 'authority-operations',
      allowCustom: true,
      description: t('grantsHint'),
    },
  } as const;

  const page = webui.use.definePage({
    key: 'authority',
    title: t('pageTitle'),
    icon: 'shield',
    placement: 'settings',
    actions: {
      setUserLevel: {
        label: t('setLevel'),
        effect: 'write',
        row: true,
        input: {
          level: { type: 'number', label: t('level'), integer: true, required: true, description: LEVEL_DESCRIPTION },
        },
        handler: ({ rowKey, input }) =>
          saveUser(
            () => manager.setUserLevel(identityOf(rowKey), input.level),
            t('userLevelSet', { who: rowKey, level: input.level }),
          ),
      },
      addUser: {
        label: t('addUser'),
        effect: 'write',
        input: {
          ...IDENTITY_INPUT,
          level: { type: 'number', label: t('level'), integer: true, required: true, description: LEVEL_DESCRIPTION },
        },
        handler: ({ input }) =>
          saveUser(
            () => manager.setUserLevel({ platform: input.platform, userId: input.userId }, input.level),
            t('userLevelSet', { who: `${input.platform}:${input.userId}`, level: input.level }),
          ),
      },
      setUserGroups: {
        label: t('setUserGroups'),
        effect: 'write',
        row: true,
        input: {
          groups: {
            type: 'multiselect',
            label: t('userGroups'),
            dynamicOptions: 'authority-groups',
            description: t('userGroupsHint'),
          },
        },
        handler({ rowKey, input }) {
          const target = identityOf(rowKey);
          const groups = input.groups ?? [];
          return saveUser(() => manager.setUserGroups(target, groups), groupsReceipt(rowKey, groups));
        },
      },
      deleteUser: {
        label: t('deleteUser'),
        effect: 'destructive',
        confirm: t('deleteUserConfirm'),
        row: true,
        handler({ rowKey }) {
          const { platform, userId } = identityOf(rowKey);
          return saveUser(() => manager.removeUser(platform, userId), t('userDeleted', { who: rowKey }));
        },
      },
      createGroup: {
        label: t('createGroup'),
        effect: 'write',
        input: {
          name: { type: 'string', label: t('groupName'), required: true, description: t('groupNameHint') },
          ...GRANTS,
        },
        handler({ input }) {
          const name = input.name.trim();
          if (!isGroupName(name)) {
            throw new TextError(t(isUnsafeConfigKey(name) ? 'reservedGroupName' : 'badGroupName', { name }));
          }
          if (manager.definedGroups().has(name)) throw new TextError(t('groupExists', { name }));
          return setGroup(name, input.entries, t('groupCreated', { name }));
        },
      },
      editGroup: {
        label: t('editGroup'),
        effect: 'write',
        row: true,
        input: GRANTS,
        handler({ rowKey, input }) {
          if (!manager.definedGroups().has(rowKey)) throw new TextError(t('noSuchGroup', { name: rowKey }));
          return setGroup(rowKey, input.entries, t('groupEdited', { name: rowKey }));
        },
      },
      deleteGroup: {
        label: t('deleteGroup'),
        effect: 'destructive',
        confirm: t('deleteGroupConfirm'),
        row: true,
        handler({ rowKey }) {
          if (!manager.definedGroups().has(rowKey)) throw new TextError(t('noSuchGroup', { name: rowKey }));
          // 不级联：成员记录里的组名保留，没定义的组不放行；之后建同名组即恢复
          const next = Object.fromEntries(
            Object.entries(config.get('authorityGroups') ?? {}).filter(([name]) => name !== rowKey),
          );
          return saveConfig(() => config.set('authorityGroups', next), t('groupDeleted', { name: rowKey }));
        },
      },
      addOwner: {
        label: t('addOwner'),
        effect: 'write',
        input: IDENTITY_INPUT,
        handler({ input }) {
          const owner = { platform: input.platform, userId: input.userId };
          const who = `${input.platform}:${input.userId}`;
          if (owners().some(o => sameIdentity(o, owner))) throw new TextError(t('alreadyOwner', { who }));
          return saveConfig(() => config.set('owners', [...owners(), owner]), t('ownerAdded', { who }));
        },
      },
      removeOwner: {
        label: t('remove'),
        effect: 'destructive',
        confirm: t('removeOwnerConfirm'),
        row: true,
        handler({ rowKey }) {
          const owner = identityOf(rowKey);
          if (!owners().some(o => sameIdentity(o, owner))) throw new TextError(t('notOwner', { who: rowKey }));
          return saveConfig(
            () =>
              config.set(
                'owners',
                owners().filter(o => !sameIdentity(o, owner)),
              ),
            t('ownerRemoved', { who: rowKey }),
          );
        },
      },
      setGroupLevel: {
        label: t('setGroupLevel'),
        effect: 'write',
        row: true,
        input: THRESHOLD,
        handler({ rowKey, input }) {
          const group = operations().filter(op => op.pluginName === rowKey);
          if (group.length === 0) throw new TextError(t('noOperations', { plugin: rowKey }));
          const counts = { plugin: rowKey, count: group.length };
          return setOverrides(
            group.map(op => op.capability),
            input.level,
            input.level === undefined
              ? t('groupLevelReset', counts)
              : t('groupLevelSet', { ...counts, level: input.level }),
          );
        },
      },
      setOperationLevel: {
        label: t('setOperationLevel'),
        effect: 'write',
        row: true,
        input: THRESHOLD,
        handler({ rowKey, input }) {
          if (!operations().some(op => op.capability === rowKey)) {
            throw new TextError(t('noOperation', { capability: rowKey }));
          }
          return setOverrides(
            [rowKey],
            input.level,
            input.level === undefined
              ? t('operationLevelReset', { capability: rowKey })
              : t('operationLevelSet', { capability: rowKey, level: input.level }),
          );
        },
      },
      denyCapability: {
        label: t('deny'),
        effect: 'write',
        input: RULE_INPUT,
        handler: ({ input }) => addRule('deny', input.pattern),
      },
      waiveConfirm: {
        label: t('waive'),
        effect: 'write',
        input: { pattern: { ...RULE_INPUT.pattern, description: t('waivePattern') } },
        handler: ({ input }) => addRule('waive', input.pattern),
      },
      removeRule: {
        label: t('remove'),
        effect: 'write',
        row: true,
        handler({ rowKey }) {
          const sep = rowKey.indexOf(':');
          const kind = rowKey.slice(0, sep) as RuleKind;
          const rule = rowKey.slice(sep + 1);
          const current = RULE_KINDS.includes(kind) ? rules(kind) : [];
          if (!current.includes(rule)) throw new TextError(t('noRule', { key: rowKey }));
          return setRules(
            kind,
            current.filter(r => r !== rule),
            t('ruleRemoved', { rule, kind }),
          );
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'users',
          title: t('usersTab'),
          content: [
            {
              type: 'table',
              id: 'users',
              rowKey: 'identity',
              description: t('usersDescription', { level: DEFAULT_AUTHORITY }),
              empty: t('usersEmpty', { level: DEFAULT_AUTHORITY }),
              columns: [
                { key: 'identity', label: t('identity'), primary: true },
                { key: 'level', label: t('level'), primary: true },
                { key: 'memberOf', label: t('userGroups') },
                { key: 'note', label: t('note') },
              ],
              rowActions: [{ action: 'setUserLevel' }, { action: 'setUserGroups' }, { action: 'deleteUser' }],
              data: () =>
                manager
                  .listUsers()
                  .filter(u => !u.isOwner)
                  .map(u => ({
                    identity: `${u.platform}:${u.userId}`,
                    level: u.level,
                    memberOf: u.groups.length > 0 ? t('groupList', { groups: memberGroups(manager, u.groups) }) : '',
                    // 不显示，与「设权限组」的输入项同名，表单按它预填
                    groups: u.groups,
                    note: u.note ?? '',
                  })),
            },
            { type: 'actions', actions: ['addUser'] },
          ],
        },
        {
          key: 'permissionGroups',
          title: t('groupsTab'),
          content: [
            {
              type: 'table',
              id: 'permissionGroups',
              rowKey: 'name',
              description: t('groupsTable'),
              empty: t('groupsEmpty'),
              columns: [
                { key: 'name', label: t('groupName'), primary: true },
                { key: 'entries', label: t('groupGrants'), kind: 'code', primary: true },
                { key: 'members', label: t('groupMembers') },
              ],
              rowActions: [{ action: 'editGroup' }, { action: 'deleteGroup' }],
              data() {
                const users = manager.listUsers();
                return [...manager.definedGroups()].map(([name, entries]) => ({
                  name,
                  // 与「改条目」的输入项同名，表单按它预填
                  entries,
                  members: users.filter(u => u.groups.includes(name)).length,
                }));
              },
            },
            { type: 'actions', actions: ['createGroup'] },
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
              description: t('ownersDescription'),
              empty: t('ownersEmpty'),
              columns: [{ key: 'identity', label: t('identity'), primary: true }],
              rowActions: [{ action: 'removeOwner' }],
              data: () => owners().map(o => ({ identity: `${o.platform}:${o.userId}` })),
            },
            { type: 'actions', actions: ['addOwner'] },
          ],
        },
        {
          key: 'operations',
          title: t('operationsTab'),
          content: [
            {
              type: 'table',
              id: 'groups',
              rowKey: 'plugin',
              description: t('operationsDescription'),
              empty: t('operationsEmpty'),
              columns: [
                { key: 'plugin', label: t('plugin'), primary: true },
                { key: 'count', label: t('operationCount'), primary: true },
                { key: 'overridden', label: t('overridden') },
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
                    { key: 'display', label: t('operation'), primary: true },
                    { key: 'kind', label: t('kind') },
                    { key: 'defaultLevel', label: t('defaultLevel') },
                    { key: 'effectiveLevel', label: t('effectiveLevel'), primary: true },
                    { key: 'confirm', label: t('confirm') },
                  ],
                  rowActions: [{ action: 'setOperationLevel' }],
                  data({ rowKey }) {
                    const set = overrides();
                    return operations()
                      .filter(op => op.pluginName === rowKey)
                      .map(op => ({
                        capability: op.capability,
                        display: op.display,
                        kind: KIND_TEXT[op.type],
                        defaultLevel: levelText(op.minLevel),
                        effectiveLevel: levelText(set[op.capability] ?? op.minLevel),
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
          title: t('rulesTab'),
          content: [
            {
              type: 'table',
              id: 'rules',
              rowKey: 'key',
              description: t('rulesDescription'),
              empty: t('rulesEmpty'),
              columns: [
                { key: 'rule', label: t('capability'), kind: 'code', primary: true },
                { key: 'kind', label: t('rule'), primary: true },
              ],
              rowActions: [{ action: 'removeRule' }],
              data: () =>
                RULE_KINDS.flatMap(kind =>
                  rules(kind).map(rule => ({ key: `${kind}:${rule}`, rule, kind: t('ruleKind', { kind }) })),
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
