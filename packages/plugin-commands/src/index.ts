import { authority } from '@aalis/api-authority';
import { type CommandArgv, commands as commandsService } from '@aalis/api-commands';
import { contributions } from '@aalis/api-contributions';
import { gateway, INBOUND_PHASE, type InboundPhaseData } from '@aalis/api-gateway';
import { type HookContextMap, hooks } from '@aalis/api-hooks';
import { i18n } from '@aalis/api-i18n';
import { type ClearTypeContribution, memory } from '@aalis/api-memory';
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
  pluginsService,
  provide,
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

/** 按登记表核对 -t 的取值：不给或含 all 时清全部类型（undefined），有不认识的抛给人看的错 */
function normalizeClearTypes(
  raw: unknown,
  known: readonly ClearTypeContribution[],
  prefix: string,
): string[] | undefined {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const types = values
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean);
  if (types.length === 0 || types.includes('all')) return undefined;
  const unknown = types.find(type => !known.some(k => k.id === type));
  if (unknown) {
    const ids = ['all', ...known.map(k => k.id)].join(', ');
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
  memory: optional(memory),
  authority: optional(authority),
  /** /status 写已登记的工具数 */
  tools: optional(tools),
  /** /status 写插件在跑与出错的个数；缺席时不写这一行 */
  plugins: optional(pluginsService),
  /** /clear 的类型按 memory:clear-type 的登记表取；缺席时只认 all */
  contributions: optional(contributions),
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
  memory,
  authority,
  tools,
  plugins,
  contributions,
  i18n,
  app,
  events,
  hooks,
  lifecycle,
  logger,
  config,
  provide,
}: Caps): void {
  const cfg = parseConfig(configSchema, config.use, logger.use);
  // 创建指令注册表并注册为服务
  const registry = new CommandRegistry(logger.use, authority, i18n);

  // 可见性的运行时覆盖（authorityOverrides）现归 authority 配置，不在指令注册表加载。

  // 配置指令系统
  registry.prefix = cfg.commandPrefix;

  // 注册服务
  provide.use(commandsService, registry);

  // ===== inbound:command 相位：命令命中则执行并中断后续相位 =====
  //
  // 命令拦截只在 inbound:command 命名相位做，适配器不内联拦截，
  // 所有平台共享同一套命令解析路径。
  // plugin-gateway 的 INBOUND_PHASE_ORDER 把本相位放在 trigger / flow 之前。
  //
  // 只有人亲手写的文字才执行指令。真人入站（平台适配器、WebUI、终端）不带 source，照常解析；带 source 的注入不论
  // source 叫什么，都不过指令解析、当普通消息往下走，只有声明了 ownerApproved 的照常解析：文字在建立时经 owner 过目过原文。
  // 带声明的注入：
  // - 权限身份取创建时固化的 message.actor，守卫按它的真实等级评估，与普通用户走同一闸门。**actor 缺省即匿名**：
  //   创建者匿名时不得回填 owner（在触发路径把空 actor 补成 `webui:console` 之类，等于开了一条 owner 快速通道）；
  // - 没人可问，免 session 档的确认（skipConfirm；authorize 仍生效，always 档照常要确认、无从确认即拒）；
  //   免确认只对创建者是 owner 的注入生效（执行守卫按授权身份判），别人建的任务里需要确认的指令照旧直接拒；
  // - 通常指向没有适配器接收的 internal 虚拟会话，结果写日志而不回发，避免发到虚空。

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
    const injected = message.source !== undefined;
    const settle = injected ? undefined : intents.get(intentKey(message));
    if (settle) {
      settle(YES.test(message.content ?? ''));
      return;
    }
    // 带 source 又没声明 ownerApproved 的注入不是人亲手写的，与没有文字的消息一样不参与命令解析
    if (!message.content || (injected && !message.ownerApproved)) return next();

    const parsed = registry.parseCommand(message.content);
    if (!parsed) return next();

    // 解析到 "<prefix>foo" 但没有任何插件注册过该指令 → 当作普通消息处理
    // （归档、trigger、agent 等下游相位继续工作），避免对错字/打字噪音回显"未知指令"。
    if (!registry.hasMatch(parsed.name, parsed.args)) return next();

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
        // 走到这里的注入都声明了 ownerApproved
        skipConfirm: injected,
        // 人亲手输入的消息才问得到发出者
        confirmIntent: !injected && message.userId !== undefined ? askIntent(message, parsed.raw) : undefined,
      });
      if (result) {
        if (injected) {
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

  // 只给计数：逐项的检查（哪个插件为什么没起来、缺什么服务）交给 /doctor，末尾指过去
  commands.use.command('status', t('statusDescription')).action(async () => {
    const status = plugins.present ? plugins.use.getStatus() : undefined;
    const count = (state: string) => status?.filter(p => p.state === state).length ?? 0;
    return textLines([
      t('statusTitle'),
      '',
      ...(status ? [t('statusPlugins', { active: count('active'), error: count('error') })] : []),
      t('statusTools', { count: tools.present ? tools.use.getAll().length : 0 }),
      t('statusCommands', { count: registry.getAll().length }),
      '',
      t('statusDoctor', { prefix: registry.prefix }),
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
  // 类型由处理它的插件登记（本插件登记它清的消息历史 context），-t 的可选项按登记表现取，同一类型只列一次。
  contributions.use.contribute('memory:clear-type', { id: 'context', label: t('typeContext') });

  /** 登记的清理类型，按收集次序去重：同一类型几家登记时取第一家的显示名 */
  function clearTypes(): ClearTypeContribution[] {
    if (!contributions.present) return [];
    const byId = new Map<string, ClearTypeContribution>();
    for (const { spec } of contributions.use.collect('memory:clear-type'))
      if (!byId.has(spec.id)) byId.set(spec.id, spec);
    return [...byId.values()];
  }

  type ClearScope = 'session' | 'all';
  async function runClear(
    cmdCtx: { sessionId: string },
    scope: ClearScope,
    types: string[] | undefined,
    known: readonly ClearTypeContribution[],
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

      // 附件、向量、人设、用户档案等子系统的清理由各自的 memory:clear 中间件处理（附件归写入它的插件）。
      // runClear 仅负责调度 hook 与处理 memory 主体。
    });

    const lines: (string | TextRef)[] = clearData.results.map(r =>
      t(r.success ? 'cleared' : 'notCleared', { message: r.message }),
    );
    // 显式要求的类型逐个核对：没有任何一行标注该类型，就是没有已启用的插件处理它，照实说明
    for (const { id, label } of known) {
      if (!types?.includes(id) || clearData.results.some(r => r.type === id)) continue;
      lines.push(t('unhandledType', { type: label }));
    }
    return lines.length === 0 ? t('nothingCleared') : textLines(lines);
  }

  async function runClearFromOptions(argv: CommandArgv, scope: ClearScope): Promise<string | TextRef> {
    const known = clearTypes();
    let types: string[] | undefined;
    try {
      types = normalizeClearTypes(argv.options.type, known, registry.prefix);
    } catch (err) {
      return textOf(err);
    }
    return runClear({ sessionId: argv.session.sessionId }, scope, types, known);
  }

  const clearTypeOption = {
    description: t('clearTypeDescription'),
    choices: () => [
      { value: 'all', description: t('clearTypeAll') },
      ...clearTypes().map(({ id, label }) => ({ value: id, description: label })),
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
