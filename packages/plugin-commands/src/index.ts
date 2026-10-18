import { authority } from '@aalis/api-authority';
import { type CommandArgv, commands as commandsService } from '@aalis/api-commands';
import { gateway, INBOUND_PHASE, type InboundPhaseData } from '@aalis/api-gateway';
import { type HookContextMap, hooks } from '@aalis/api-hooks';
import { i18n } from '@aalis/api-i18n';
import { memory } from '@aalis/api-memory';
import { isStorageNotFound, type StorageService, storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import {
  appService,
  type BoundOf,
  config,
  definePlugin,
  events,
  lifecycle,
  logger,
  optional,
  provide,
  services,
} from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { isTextRef, TextError, type TextRef, textLines, textOf, toSource } from '@aalis/schema-i18n';
import { CommandRegistry } from './commands.js';
import { t } from './texts.js';

type IncomingMessage = InboundPhaseData['message'];

const configSchema = defineConfig({
  commandPrefix: {
    type: 'string',
    label: t('prefixLabel'),
    default: '/',
    onInvalid: 'error',
    description: t('prefixDescription'),
  },
});

/**
 * 删除目录及内部所有内容，返回顶层子项数（用于"清了 N 张/N 个会话"提示）。
 * 目录不存在返回 -1。
 */
async function removeDirCounted(storage: StorageService, dirUri: string): Promise<number> {
  try {
    const st = await storage.stat(dirUri);
    if (!st.isDirectory) return -1;
    const list = await storage.list(dirUri);
    await storage.delete(dirUri);
    return list.entries.length;
  } catch (err) {
    if (isStorageNotFound(err)) return -1;
    throw err;
  }
}

/** 可清理类型。globalOnly：跨会话数据，只在 /clear all 时清理 */
export const CLEAR_TYPES: ReadonlyArray<{ id: string; label: TextRef; globalOnly?: boolean }> = [
  { id: 'context', label: t('typeContext') },
  { id: 'summary', label: t('typeSummary') },
  { id: 'vector', label: t('typeVector') },
  { id: 'image', label: t('typeImage') },
  { id: 'video', label: t('typeVideo') },
  { id: 'audio', label: t('typeAudio') },
  { id: 'file', label: t('typeFile') },
  { id: 'persona', label: t('typePersona') },
  { id: 'checkpoint', label: t('typeCheckpoint') },
  { id: 'user-profile', label: t('typeUserProfile'), globalOnly: true },
  { id: 'user-relation', label: t('typeUserRelation'), globalOnly: true },
];

/**
 * 附件缓存种类 → `data:/` 目录 + 显示名。
 * 目录名与 @aalis/plugin-adapter-onebot 的 attachment-cache `KIND_DIR` 对齐
 * （image→images / video→videos / audio→audios / file→files），落盘路径为
 * `data:/{dir}/{safeSessionId}/{hash}.{ext}`。改这里即同步 /clear 覆盖面。
 */
export const ATTACHMENT_KINDS = [
  { type: 'image', dir: 'images', label: t('kindImage') },
  { type: 'video', dir: 'videos', label: t('kindVideo') },
  { type: 'audio', dir: 'audios', label: t('kindAudio') },
  { type: 'file', dir: 'files', label: t('kindFile') },
] as const;

const CLEAR_TYPE_ALIASES: Record<string, string> = {
  history: 'context',
  messages: 'context',
  profile: 'user-profile',
  profiles: 'user-profile',
};

function normalizeClearTypes(raw: unknown, prefix: string): string[] | undefined {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const types = values
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => CLEAR_TYPE_ALIASES[v] ?? v);
  if (types.length === 0 || types.includes('all')) return undefined;
  const known = new Set(CLEAR_TYPES.map(type => type.id));
  const unknown = types.find(type => !known.has(type));
  if (unknown) {
    const ids = ['all', ...CLEAR_TYPES.map(type => type.id)].join(', ');
    throw new TextError(t('unknownClearType', { type: unknown, types: ids, prefix }));
  }
  return [...new Set(types)];
}

// ===== 插件入口 =====

const uses = {
  /**
   * commands 由本插件自己提供，只能声明成 optional：写 required 会把激活闸架在自己的
   * 产出上，永远等不到。绑定接口给的是「指令声明自动归属本次激活」的注册门面，
   * 指向容器里的当前胜者（别的插件提供了更高优先级的注册表时就是那一个）。
   */
  commands: optional(commandsService),
  gateway,
  storage: optional(storage),
  memory: optional(memory),
  authority: optional(authority),
  /** /status 列已登记的工具数 */
  tools: optional(tools),
  /** 回复与帮助按这条指令所在会话的语言渲染；缺席时按原文 */
  i18n: optional(i18n),
  app: appService,
  events,
  hooks,
  /** 停用时结算等待中的意图确认 */
  lifecycle,
  logger,
  config,
  provide,
  services,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-commands',
  displayName: t('displayName'),
  subsystem: 'core',
  configSchema,
  provides: [commandsService],
  uses,
  apply: registerCommands,
});

function registerCommands({
  commands,
  gateway,
  storage,
  memory,
  authority,
  tools,
  i18n,
  app,
  events,
  hooks,
  lifecycle,
  logger,
  config,
  provide,
  services,
}: Caps): void {
  const cfg = parseConfig(configSchema, config.use, logger.use);
  // 创建指令注册表并注册为服务
  const registry = new CommandRegistry(logger.use, authority, i18n);

  // 可见性的运行时覆盖（authorityOverrides）现归 authority 配置，不在指令注册表加载。

  // 配置指令系统
  registry.prefix = cfg.commandPrefix;

  // 注册服务
  provide.use(commandsService, registry);

  // ===== 统一 memory:clear 中间件：附件缓存清理（图片/视频/语音/文件）=====
  //
  // 附件按 data:/{images|videos|audios|files}/{safeSessionId} 落盘（与 onebot
  // attachment-cache 的 KIND_DIR 对齐）。独立 middleware 使 /clear 与 deleteSession
  // 走同一清理路径——deleteSession 触发的 memory:clear 也清附件，杜绝文件泄漏
  // （四类必须齐清，漏掉任一类即留下残留文件）。
  //
  // types 语义：未指定=清全部附件；指定则只清命中的种类（如 /clear -t video）。
  hooks.use.middleware('memory:clear', async (data, next) => {
    const safeSessionId = data.sessionId?.replace(/[:/\\]/g, '_');
    for (const k of ATTACHMENT_KINDS) {
      if (data.types && !data.types.includes(k.type)) continue;
      try {
        if (data.scope === 'all') {
          const removed = await removeDirCounted(storage.use, `data:/${k.dir}`);
          data.results.push({
            source: `${k.type}-cache`,
            type: k.type,
            success: true,
            message:
              removed >= 0
                ? t('cacheClearedAll', { kind: k.label, count: removed })
                : t('cacheMissingAll', { kind: k.label }),
          });
        } else if (safeSessionId) {
          const removed = await removeDirCounted(storage.use, `data:/${k.dir}/${safeSessionId}`);
          data.results.push({
            source: `${k.type}-cache`,
            type: k.type,
            success: true,
            message:
              removed >= 0
                ? t('cacheClearedSession', { kind: k.label, count: removed })
                : t('cacheMissingSession', { kind: k.label }),
          });
        }
      } catch (err) {
        data.results.push({
          source: `${k.type}-cache`,
          type: k.type,
          success: false,
          message: t('cacheFailed', { kind: k.label, error: textOf(err) }),
        });
      }
    }
    await next();
  });

  // ===== inbound:command 相位：命令命中则执行并中断后续相位 =====
  //
  // 命令拦截只在 inbound:command 命名相位做，适配器不内联拦截，
  // 所有平台共享同一套命令解析路径。
  // plugin-gateway 的 INBOUND_PHASE_ORDER 把本相位放在 trigger / flow 之前。
  //
  // 受信任系统源：scheduler 等内部触发器写入 message.source。
  // 这些来源的权限身份来自创建时固化的 message.actor（scheduler 在 setJob / addJob /
  // 静态配置载入这三条建任务路径上各自 snapshot 创建者身份），守卫按 actor 的真实等级
  // 评估——与普通用户走同一闸门，不存在 bypassGuard 式的全绕过。
  // **actor 缺省即匿名**：创建者匿名时不得回填 owner，否则受信来源就成了提权通道
  // （在触发路径把空 actor 补成 `webui:console` 之类，等于开了一条 owner 快速通道）。
  // skipConfirm 仍然需要：cron 上下文里没人可问（authorize 仍生效，always 档照常要确认、无从确认即拒）。
  // 同时这些 source 通常指向 internal 虚拟 session（无适配器接收），
  // 因此结果不走 outbound 而是写日志，避免发到虚空。
  // 受信系统源 = 免确认（skipConfirm）+ 结果写日志而非回发。仅 scheduler：
  // 它建任务的入口是 dangerous + confirm:'always'（L2 且每次 owner 批准），拿到受信特权
  // 的成本与特权本身相称。
  // 刻意排除的两项（2026-08-28 对抗审计定，勿再"修死项"重开）：
  //   'system' —— 只出现在出站消息，无入站生产者，纯死值，删。
  //   'workflow:*' —— 曾想按前缀纳入，但 workflow_define/workflow_run 只是 sensitive(L1)、
  //     零确认，一旦受信，L1 就能定义 send-message 节点向任意会话静默投递 /clear 这类
  //     1 级 + confirm:'session' 命令、且无回显——confirm 闸（防注入误清）被绕过。
  //     故 workflow 派发**不受信**：带 source 的注入问不到发出者，需要确认的指令直接拒（fail-closed）。
  //     要让 workflow 自动化免确认，须先把 define/run 抬到与 scheduler 相称的档位，那是单独的决定。
  const TRUSTED_SOURCE_EXACT = new Set(['scheduler']);
  const isTrustedSystemSource = (source: string | undefined): boolean => !!source && TRUSTED_SOURCE_EXACT.has(source);

  /**
   * 回到消息所在的会话。文字对象交给网关按这个会话的语言渲染，content 写原文。required 依赖在调度收敛前可能短暂缺席，
   * 故保留事件兜底（发出原文）
   */
  async function reply(message: IncomingMessage, result: string | TextRef): Promise<void> {
    const out = {
      ...(isTextRef(result) ? { content: toSource(result), text: result } : { content: result }),
      sessionId: message.sessionId,
      platform: message.platform,
      source: 'command' as const,
    };
    const gatewayService = gateway.present ? gateway.use : undefined;
    if (gatewayService) await gatewayService.dispatchOutbound(out);
    else await events.use.emit('outbound:message', out);
  }

  // ===== 意图确认：人亲手输入、声明了 confirm 的指令，在同一会话里问发出者本人 =====
  //
  // 只认这个人在这个会话里的下一条消息（带 source 的注入不认）：y 为确认，其余取消，这条回复吞掉、不往下走；
  // 时限内不回也取消。问的是「确定要这么做吗」，不是 owner 审批：非 owner 的发出者本人确认即可。
  const INTENT_TIMEOUT_MS = 60_000;
  const YES = /^\s*(?:y|yes)\s*$/i;
  /** 等回复的意图确认：键是会话与发出者，值是结算函数 */
  const intents = new Map<string, (confirmed: boolean) => void>();
  const intentKey = (m: IncomingMessage) => `${m.sessionId}\n${m.platform}\n${m.userId}`;

  function askIntent(message: IncomingMessage, raw: string): () => Promise<boolean> {
    return () =>
      new Promise<boolean>(resolve => {
        const key = intentKey(message);
        const settle = (confirmed: boolean) => {
          clearTimeout(timer);
          if (intents.get(key) === settle) intents.delete(key);
          resolve(confirmed);
        };
        const timer = setTimeout(() => settle(false), INTENT_TIMEOUT_MS);
        timer.unref?.();
        intents.set(key, settle);
        void reply(message, t('confirmIntent', { command: raw, seconds: INTENT_TIMEOUT_MS / 1000 }));
      });
  }

  // 停用（含重载）时等待中的确认按取消结算：新实例不认得它们，留到时限只会在拆卸之后才回「已取消」。
  // 在撤回登记之前结算，网关还在，取消的回复发得出去
  lifecycle.use.onDrain(() => {
    for (const settle of [...intents.values()]) settle(false);
  }, '取消等待中的意图确认');

  hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    const { message } = data;
    const settle = message.source === undefined ? intents.get(intentKey(message)) : undefined;
    if (settle) {
      settle(YES.test(message.content ?? ''));
      return;
    }
    // 内部触发（idle-trigger 等无 userId）不参与命令解析
    if (!message.content) return next();

    const parsed = registry.parseCommand(message.content);
    if (!parsed) return next();

    // 解析到 "<prefix>foo" 但没有任何插件注册过该指令 → 当作普通消息处理
    // （归档、trigger、agent 等下游相位继续工作），避免对错字/打字噪音回显"未知指令"。
    if (!registry.hasMatch(parsed.name, parsed.args)) return next();

    const isSystemTrigger = isTrustedSystemSource(message.source);

    try {
      // 优先用 actor（系统触发器注入的代理身份），fallback 到消息原始身份。
      // 与 agent 工具调用路径解析调用者身份同语义。
      const result = await registry.run(parsed.name, {
        sessionId: message.sessionId,
        platform: message.actor?.platform ?? message.platform,
        userId: message.actor?.userId ?? message.userId,
        sessionType: message.sessionType,
        args: parsed.args,
        raw: parsed.raw,
        skipConfirm: isSystemTrigger,
        // 人亲手输入的消息才问得到发出者
        confirmIntent:
          message.source === undefined && message.userId !== undefined ? askIntent(message, parsed.raw) : undefined,
      });
      if (result) {
        if (isSystemTrigger) {
          // 系统触发器（scheduler）的 sessionId 通常是 internal 虚拟 session，
          // 走 outbound 也无人接收；直接写日志便于排查。
          const text = toSource(result);
          const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
          logger.use.info(`[${message.source}] ${parsed.raw} → session=${message.sessionId} 结果:\n${preview}`);
        } else {
          await reply(message, result);
        }
      }
    } catch (err) {
      logger.use.warn(`指令执行失败: ${err}`);
    }
    // 命令命中：不调用 next() —— 整个入站管道立即停止（不再进入 trigger/flow/dispatch）
  });

  // ===== 内置指令 =====

  // 只列调用者能用的指令：用不了的在帮助里当作不存在
  commands.use
    .command('help [name:text]', t('helpDescription'))
    .argument('name', t('helpName'))
    .action(async (argv, name) => {
      const path = String(name ?? '')
        .split(/[\s.]+/)
        .filter(Boolean);
      return path.length > 0 ? registry.detail(path, argv.session) : registry.overview(argv.session);
    });

  commands.use.command('status', t('statusDescription')).action(async () => {
    // 按名枚举：这张表回答的只是"在不在"，其中大半个子系统本插件并不依赖，
    // 按名动态查不产生依赖边，也就不会把它们拖进本插件的激活闸与关停顺序。
    const checks = [
      ['WebUI Server', 'webui-server'],
      ['CLI', 'cli'],
      [t('serviceLLM'), 'llm'],
      ['Agent', 'agent'],
      [t('serviceMemory'), 'memory'],
      [t('servicePersona'), 'persona'],
      ['Embedding', 'embedding'],
      [t('serviceVectorstore'), 'vectorstore'],
    ] as const;
    return textLines([
      t('statusTitle'),
      '',
      ...checks.map(([service, name]) =>
        t(services.use.get(name) !== undefined ? 'statusUp' : 'statusDown', { service }),
      ),
      t('statusTools', { count: tools.present ? tools.use.getAll().length : 0 }),
      t('statusCommands', { count: registry.getAll().length }),
    ]);
  });

  commands.use.command('shutdown', t('shutdownDescription'), { visibility: 'restricted' }).action(async () => {
    const host = app.use;
    setTimeout(async () => {
      await host.stop();
      process.exit(0);
    }, 500);
    return t('shuttingDown');
  });

  commands.use.command('restart', t('restartDescription'), { visibility: 'restricted' }).action(async () => {
    app.use.restart();
    return t('restarting');
  });

  // ===== /clear —— 清空记忆 =====
  // 默认清当前会话；全局清理通过显式危险子指令 /clear all 进入，避免把高危语义藏在普通选项里。
  type ClearScope = 'session' | 'all';
  async function runClear(
    cmdCtx: { sessionId: string },
    scope: ClearScope,
    types: string[] | undefined,
  ): Promise<TextRef> {
    const isGlobal = scope === 'all';
    // 预检：消息历史清不了就整条不执行。各插件的 memory:clear 中间件先于消息清理运行，放行就会清掉摘要、待办、
    // 附件等，留下「消息还在、其余已清」的半截状态。预检只决定执行与否，清理时另取当时的记忆后端
    const clearsMessages = !types || types.includes('context');
    const memoryAtStart = memory.present ? memory.use : undefined;
    if (clearsMessages && !memoryAtStart) return t('noMemoryBackend');
    if (clearsMessages && isGlobal && !memoryAtStart?.clearAll) return t('noGlobalClear');
    const clearData: HookContextMap['memory:clear'] = {
      scope,
      types,
      sessionId: cmdCtx.sessionId,
      results: [],
    };

    await hooks.use.run('memory:clear', clearData, async () => {
      if (!clearsMessages) return;
      try {
        // 中间件链可能要等一阵（在途落库、向量清空与保存），期间 memory 胜者可能已更换：按此刻的胜者清理，
        // 不复用预检取到的实例，免得清到已下线的旧后端
        if (!memory.present) throw new TextError(t('memoryGone'));
        const memoryService = memory.use;
        if (isGlobal) {
          if (!memoryService.clearAll) throw new TextError(t('noGlobalClearMidway'));
          await memoryService.clearAll();
          clearData.results.push({
            source: 'memory',
            type: 'context',
            success: true,
            message: t('historyClearedAll'),
          });
        } else {
          await memoryService.clearSession(cmdCtx.sessionId);
          clearData.results.push({
            source: 'memory',
            type: 'context',
            success: true,
            message: t('historyClearedSession'),
          });
        }
      } catch (err) {
        clearData.results.push({
          source: 'memory',
          type: 'context',
          success: false,
          message: t('clearFailed', { error: textOf(err) }),
        });
      }

      // 图片缓存与 vectorstore/persona/user-profile 等子系统的清理
      // 统一由各自的 memory:clear middleware 处理（见上面的附件缓存 middleware）。
      // runClear 仅负责调度 hook 与处理 memory 主体。
    });

    const lines: (string | TextRef)[] = clearData.results.map(r =>
      t(r.success ? 'cleared' : 'notCleared', { message: r.message }),
    );
    // 显式要求的类型逐个核对：没有任何一行标注该类型，就是没有已启用的插件处理它，照实说明
    for (const { id, label, globalOnly } of CLEAR_TYPES) {
      if (!types?.includes(id) || clearData.results.some(r => r.type === id)) continue;
      lines.push(
        !isGlobal && globalOnly
          ? t('globalOnlySkipped', { type: label, prefix: registry.prefix })
          : t('unhandledType', { type: label }),
      );
    }
    return lines.length === 0 ? t('nothingCleared') : textLines(lines);
  }

  async function runClearFromOptions(argv: CommandArgv, scope: ClearScope): Promise<string | TextRef> {
    let types: string[] | undefined;
    try {
      types = normalizeClearTypes(argv.options.type, registry.prefix);
    } catch (err) {
      return textOf(err);
    }
    return runClear({ sessionId: argv.session.sessionId }, scope, types);
  }

  const clearTypeOption = {
    description: t('clearTypeDescription'),
    choices: [
      { value: 'all', description: t('clearTypeAll') },
      ...CLEAR_TYPES.map(({ id, label, globalOnly }) => ({
        value: id,
        description: globalOnly ? t('clearTypeGlobalOnly', { type: label }) : label,
      })),
    ],
  };

  commands.use
    // 清空**当前会话**的记忆；确认挡住提示词注入触发的误清（需真人回一句）。
    .command('clear', t('clearDescription'), {
      risk: 'sensitive',
      confirm: 'session',
    })
    .option('type', '-t <type:string[]>', clearTypeOption)
    .example('/clear')
    .example('/clear --type context,vector')
    .example('/clear -t vector -t image')
    .example('/clear all --type all')
    .action(async argv => runClearFromOptions(argv, 'session'));

  commands.use
    // 全局清空，比 /clear 更重：同样 dangerous（等级 2 + 二次确认）。
    // 原先只写 visibility:'restricted' 拿到了等级 2 但漏了 confirm。
    .command('clear.all', t('clearAllDescription'), {
      risk: 'dangerous',
    })
    .option('type', '-t <type:string[]>', clearTypeOption)
    .action(async argv => runClearFromOptions(argv, 'all'));
}
