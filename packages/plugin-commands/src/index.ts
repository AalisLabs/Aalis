import { authority } from '@aalis/api-authority';
import { type CommandArgv, commands as commandsService } from '@aalis/api-commands';
import { gateway, INBOUND_PHASE } from '@aalis/api-gateway';
import { memory } from '@aalis/api-memory';
import { createStorageGateway, type StorageService, storage } from '@aalis/api-storage';
import type { ToolService } from '@aalis/api-tools';
import {
  appService,
  type BoundOf,
  config,
  definePlugin,
  events,
  hooks,
  logger,
  optional,
  provide,
  services,
} from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { CommandRegistry } from './commands.js';
import { renderDetail, renderOverview } from './help.js';

const configSchema: ConfigSchema = {
  commandPrefix: {
    type: 'string',
    label: '指令前缀',
    default: '/',
    description: '指令触发前缀，设为空字符串可使用纯关键词触发',
  },
};

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
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|不存在/i.test(msg)) return -1;
    throw err;
  }
}

export const CLEAR_TYPES = [
  { id: 'context', label: '消息历史与会话上下文' },
  { id: 'summary', label: '会话摘要' },
  { id: 'vector', label: '向量记忆' },
  { id: 'image', label: '图片缓存' },
  { id: 'video', label: '视频缓存' },
  { id: 'audio', label: '语音缓存' },
  { id: 'file', label: '文件缓存' },
  { id: 'persona', label: '会话角色状态' },
  { id: 'checkpoint', label: '检查点（对话回滚存档）' },
  { id: 'user-profile', label: '用户档案（仅全局清理）' },
  { id: 'user-relation', label: '用户关系图谱（仅全局清理）' },
] as const;

/**
 * 附件缓存种类 → `data:/` 目录 + 中文标签。
 * 目录名与 @aalis/plugin-adapter-onebot 的 attachment-cache `KIND_DIR` 对齐
 * （image→images / video→videos / audio→audios / file→files），落盘路径为
 * `data:/{dir}/{safeSessionId}/{hash}.{ext}`。改这里即同步 /clear 覆盖面。
 */
export const ATTACHMENT_KINDS = [
  { type: 'image', dir: 'images', label: '图片' },
  { type: 'video', dir: 'videos', label: '视频' },
  { type: 'audio', dir: 'audios', label: '语音' },
  { type: 'file', dir: 'files', label: '文件' },
] as const;

const CLEAR_TYPE_ALIASES: Record<string, string> = {
  history: 'context',
  messages: 'context',
  profile: 'user-profile',
  profiles: 'user-profile',
};

function normalizeClearTypes(raw: unknown): string[] | undefined {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const types = values
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => CLEAR_TYPE_ALIASES[v] ?? v);
  if (types.length === 0 || types.includes('all')) return undefined;
  const known = new Set(CLEAR_TYPES.map(t => t.id));
  const unknown = types.find(t => !known.has(t as (typeof CLEAR_TYPES)[number]['id']));
  if (unknown) throw new Error(`未知清理类型: ${unknown}。可用类型: all, ${CLEAR_TYPES.map(t => t.id).join(', ')}`);
  return [...new Set(types)];
}

function renderClearTypeList(): string {
  return [
    '**可清理类型：**',
    '',
    ...CLEAR_TYPES.map(type => `- ${type.id}: ${type.label}`),
    '',
    '示例：',
    '- /clear --type context,summary',
    '- /clear -t vector -t image',
    '- /clear all --type all',
  ].join('\n');
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
  app: optional(appService),
  events,
  hooks,
  logger,
  config,
  provide,
  services,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-commands',
  displayName: '内置指令',
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
  app,
  events,
  hooks,
  logger,
  config,
  provide,
  services,
}: Caps): void {
  // 创建指令注册表并注册为服务
  const registry = new CommandRegistry(logger);
  const storageGateway = createStorageGateway(storage);

  // 可见性的运行时覆盖（authorityOverrides）现归 authority 配置，不在指令注册表加载。

  // 配置指令系统
  registry.prefix = (config.commandPrefix as string) ?? '/';

  // 注册服务
  provide(commandsService, registry);

  // ===== 统一 memory:clear 中间件：附件缓存清理（图片/视频/语音/文件）=====
  //
  // 附件按 data:/{images|videos|audios|files}/{safeSessionId} 落盘（与 onebot
  // attachment-cache 的 KIND_DIR 对齐）。独立 middleware 使 /clear 与 deleteSession
  // 走同一清理路径——deleteSession 触发的 memory:clear 也清附件，杜绝文件泄漏
  // （四类必须齐清，漏掉任一类即留下残留文件）。
  //
  // types 语义：未指定=清全部附件；指定则只清命中的种类（如 /clear -t video）。
  hooks.middleware(
    'memory:clear',
    async (
      data: {
        scope: 'session' | 'all';
        types?: string[];
        sessionId?: string;
        results: Array<{ source: string; success: boolean; message: string }>;
      },
      next,
    ) => {
      const safeSessionId = data.sessionId?.replace(/[:/\\]/g, '_');
      for (const k of ATTACHMENT_KINDS) {
        if (data.types && !data.types.includes(k.type)) continue;
        try {
          if (data.scope === 'all') {
            const removed = await removeDirCounted(storageGateway, `data:/${k.dir}`);
            data.results.push({
              source: `${k.type}-cache`,
              success: true,
              message:
                removed >= 0
                  ? `所有${k.label}缓存已清空（${removed} 个会话目录）`
                  : `${k.label}缓存目录不存在，无需清空`,
            });
          } else if (safeSessionId) {
            const removed = await removeDirCounted(storageGateway, `data:/${k.dir}/${safeSessionId}`);
            data.results.push({
              source: `${k.type}-cache`,
              success: true,
              message: removed >= 0 ? `当前会话${k.label}缓存已清空（${removed} 个）` : `当前会话无${k.label}缓存`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          data.results.push({ source: `${k.type}-cache`, success: false, message: `${k.label}缓存清空失败: ${msg}` });
        }
      }
      await next();
    },
  );

  // ===== inbound:command 相位：命令命中则执行并中断后续相位 =====
  //
  // 命令拦截只在 inbound:command 命名相位做，适配器不内联拦截，
  // 所有平台共享同一套命令解析路径。
  // plugin-gateway 的 INBOUND_PHASE_ORDER 把本相位放在 flow / trigger 之前。
  //
  // 受信任系统源：scheduler 等内部触发器写入 message.source。
  // 这些来源的权限身份来自创建时固化的 message.actor（scheduler 在 setJob / addJob /
  // 静态配置载入这三条建任务路径上各自 snapshot 创建者身份），守卫按 actor 的真实等级
  // 评估——与普通用户走同一闸门，不存在 bypassGuard 式的全绕过。
  // **actor 缺省即匿名**：创建者匿名时不得回填 owner，否则受信来源就成了提权通道
  // （在触发路径把空 actor 补成 `webui:console` 之类，等于开了一条 owner 快速通道）。
  // skipConfirm 仍然需要：cron 上下文无人可点受限二次确认弹窗（authorize 仍生效）。
  // 同时这些 source 通常指向 internal 虚拟 session（无适配器接收），
  // 因此结果不走 outbound 而是写日志，避免发到虚空。
  // 受信系统源 = 免交互确认（skipConfirm）+ 结果写日志而非回发。仅 scheduler：
  // 它建任务的入口是 dangerous + confirm:'always'（L2 且每次真人确认），拿到受信特权
  // 的成本与特权本身相称。
  // 刻意排除的两项（2026-08-28 对抗审计定，勿再"修死项"重开）：
  //   'system' —— 只出现在出站消息，无入站生产者，纯死值，删。
  //   'workflow:*' —— 曾想按前缀纳入，但 workflow_define/workflow_run 只是 sensitive(L1)、
  //     零确认，一旦受信，L1 就能定义 send-message 节点向任意会话静默投递 /clear 这类
  //     0 级 + confirm:'session' 命令、且无回显——confirm 闸（防注入误清）被绕过。
  //     故 workflow 派发**不受信**：它经 COMMAND 相位的命令照常走 confirm，虚拟会话无人
  //     应答即超时拒（fail-closed）。要让 workflow 自动化免确认，须先把 define/run 抬到
  //     与 scheduler 相称的档位，那是单独的决定。
  const TRUSTED_SOURCE_EXACT = new Set(['scheduler']);
  const isTrustedSystemSource = (source: string | undefined): boolean => !!source && TRUSTED_SOURCE_EXACT.has(source);

  hooks.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    const { message } = data;
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
      const result = await registry.execute(parsed.name, {
        sessionId: message.sessionId,
        platform: message.actor?.platform ?? message.platform,
        userId: message.actor?.userId ?? message.userId,
        sessionType: message.sessionType,
        args: parsed.args,
        raw: parsed.raw,
        skipConfirm: isSystemTrigger,
      });
      if (result) {
        if (isSystemTrigger) {
          // 系统触发器（scheduler/workflow）的 sessionId 通常是 internal 虚拟 session，
          // 走 outbound 也无人接收；直接写日志便于排查。
          const preview = result.length > 500 ? `${result.slice(0, 500)}…` : result;
          logger.info(`[${message.source}] ${parsed.raw} → session=${message.sessionId} 结果:\n${preview}`);
        } else {
          // required 依赖在调度收敛前可能短暂缺席，故保留事件兜底
          const gatewayService = gateway.current;
          const reply = {
            content: result,
            sessionId: message.sessionId,
            platform: message.platform,
            source: 'command' as const,
          };
          if (gatewayService) {
            await gatewayService.dispatchOutbound(reply);
          } else {
            await events.emit('outbound:message', reply);
          }
        }
      }
    } catch (err) {
      logger.warn(`指令执行失败: ${err}`);
    }
    // 命令命中：不调用 next() —— 整个入站管道立即停止（不再进入 flow/trigger/dispatch）
  });

  // ===== 内置指令 =====

  commands.command('help [name:text]', '显示指令列表；带指令名看用法详情').action(async (_argv, name) => {
    const all = registry.getAll();
    // 无参 → 概览（只列顶层，子指令折成计数）
    if (!name) {
      const childCount = (top: string): number =>
        all.filter(c => c.name.startsWith(`${top}.`) && !c.name.slice(top.length + 1).includes('.')).length;
      return renderOverview(all, registry.prefix, childCount);
    }
    // 有参 → 详情。接受空格与点两种写法：`help session set` ≡ `help session.set`
    const path = String(name)
      .trim()
      .split(/[\s.]+/)
      .filter(Boolean);
    const cmd = registry.getNode(path);
    if (!cmd) return `没有指令 ${path.join(' ')}。敲 ${registry.prefix}help 看可用指令。`;
    const prefixDot = `${cmd.name}.`;
    const children = all.filter(c => c.name.startsWith(prefixDot) && !c.name.slice(prefixDot.length).includes('.'));
    return renderDetail(cmd, children, registry.prefix);
  });

  commands.command('status', '显示系统状态').action(async () => {
    const lines = ['**系统状态：**', ''];
    // 按名枚举：这张表回答的只是"在不在"，其中大半个子系统本插件并不依赖，
    // 按名动态查不产生依赖边，也就不会把它们拖进本插件的激活闸与关停顺序。
    const checks = [
      ['WebUI Server', services.getByName('webui-server') !== undefined],
      ['CLI', services.getByName('cli') !== undefined],
      ['LLM 服务', services.getByName('llm') !== undefined],
      ['Agent', services.getByName('agent') !== undefined],
      ['记忆服务', services.getByName('memory') !== undefined],
      ['人格服务', services.getByName('persona') !== undefined],
      ['Embedding', services.getByName('embedding') !== undefined],
      ['向量库', services.getByName('vectorstore') !== undefined],
    ] as const;
    for (const [label, ok] of checks) {
      lines.push(`- ${label}: ${ok ? '✅ 可用' : '❌ 不可用'}`);
    }
    const toolService = services.getByName('tools') as ToolService | undefined;
    lines.push(`- 已注册工具: ${toolService ? toolService.getAll().length : 0} 个`);
    lines.push(`- 已注册指令: ${registry.getAll().length} 个`);
    return lines.join('\n');
  });

  commands.command('shutdown', '关闭应用', { visibility: 'restricted' }).action(async () => {
    const host = app.current;
    if (!host) return '无法访问应用服务';
    setTimeout(async () => {
      await host.stop();
      process.exit(0);
    }, 500);
    return '正在关闭应用…';
  });

  commands.command('restart', '重启应用', { visibility: 'restricted' }).action(async () => {
    const host = app.current;
    if (!host) return '无法访问应用服务';
    host.restart();
    return '正在重启应用…';
  });

  // ===== /clear —— 清空记忆 =====
  // 默认清当前会话；全局清理通过显式危险子指令 /clear all 进入，避免把高危语义藏在普通选项里。
  type ClearScope = 'session' | 'all';
  async function runClear(
    cmdCtx: { sessionId: string },
    scope: ClearScope,
    types: string[] | undefined,
  ): Promise<string> {
    const isGlobal = scope === 'all';
    const clearData = {
      scope,
      types,
      sessionId: cmdCtx.sessionId,
      results: [] as Array<{ source: string; success: boolean; message: string }>,
    };

    await hooks.run('memory:clear', clearData, async () => {
      const memoryService = memory.current;
      if (!memoryService) {
        clearData.results.push({ source: 'memory', success: false, message: '记忆服务不可用' });
        return;
      }

      if (!types || types.includes('context')) {
        try {
          if (isGlobal && memoryService.clearAll) {
            await memoryService.clearAll();
            clearData.results.push({ source: 'memory', success: true, message: '所有消息历史和归档已清空' });
          } else {
            await memoryService.clearSession(cmdCtx.sessionId);
            clearData.results.push({ source: 'memory', success: true, message: '当前会话消息历史已清空' });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          clearData.results.push({ source: 'memory', success: false, message: `清空失败: ${msg}` });
        }
      }

      // 图片缓存与 vectorstore/persona/user-profile 等子系统的清理
      // 统一由各自的 memory:clear middleware 处理（见上面的附件缓存 middleware）。
      // runClear 仅负责调度 hook 与处理 memory 主体。
    });

    if (clearData.results.length === 0) return '无可清除的记忆模块。';
    return clearData.results.map(r => `${r.success ? '✅' : '⚠'} ${r.message}`).join('\n');
  }

  /**
   * 清空共享会话（群/频道）所需的最低等级。私聊会话归用户本人，不受此限——
   * 清自己的记忆是自助行为；群会话一人清掉会毁掉所有人的上下文，故要求同
   * `visibility:'restricted'` 的等级 2。
   */
  const CLEAR_SHARED_MIN_LEVEL = 2;

  async function runClearFromOptions(argv: CommandArgv, scope: ClearScope): Promise<string> {
    let types: string[] | undefined;
    try {
      types = normalizeClearTypes(argv.options.type);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    // 共享会话设防：静态声明只能给出与会话归属无关的策略，这一档必须在运行期判。
    if (argv.session.sessionType && argv.session.sessionType !== 'private') {
      const auth = authority.current;
      const isOwner = auth?.isOwner(argv.session.platform, argv.session.userId) ?? false;
      const level =
        auth?.listUsers().find(u => u.platform === argv.session.platform && u.userId === argv.session.userId)?.level ??
        0;
      if (!isOwner && level < CLEAR_SHARED_MIN_LEVEL) {
        return `清空共享会话需要等级 ${CLEAR_SHARED_MIN_LEVEL}（当前 ${level}）。私聊里可以随时清理自己的会话。`;
      }
    }
    return runClear({ sessionId: argv.session.sessionId }, scope, types);
  }

  const clearTypeOptDesc = `清理类型，可重复或用逗号分隔。可用: all, ${CLEAR_TYPES.map(t => t.id).join(', ')}`;

  commands
    // 清空**当前会话**的记忆。风险随会话归属而变，静态声明取「最松的安全默认」：
    // confirm:'session' 但不抬等级——私聊里会话是用户自己的，清自己的记忆属自助行为，
    // 要 2 级等于剥夺；确认则挡住提示词注入触发的误清（需真人点一下）。
    // 群聊会话是共享的，一人清掉毁掉所有人的上下文——那一档在 action 里按
    // sessionType 另行设防（与 /bind 等私聊敏感指令同一模式）。
    .command('clear', '清空当前会话记忆；用 --type 选择消息、摘要、向量、图片等清理类型', {
      confirm: 'session',
    })
    .option('type', '-t <type:string[]>', { description: clearTypeOptDesc })
    .example('/clear')
    .example('/clear --type context,summary')
    .example('/clear -t vector -t image')
    .example('/clear all --type all')
    .action(async argv => runClearFromOptions(argv, 'session'));

  commands.command('clear.list', '列出可清理类型').action(async () => renderClearTypeList());

  commands
    // 全局清空，比 /clear 更重：同样 dangerous（等级 2 + 二次确认）。
    // 原先只写 visibility:'restricted' 拿到了等级 2 但漏了 confirm。
    .command('clear.all', '【危险】按 --type 清空全部会话；未指定类型时清空全部类型', {
      risk: 'dangerous',
    })
    .option('type', '-t <type:string[]>', { description: clearTypeOptDesc })
    .action(async argv => runClearFromOptions(argv, 'all'));
}
