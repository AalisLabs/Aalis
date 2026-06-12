import type { AppService, ConfigSchema, Context } from '@aalis/core';
import type { SafetyLevel } from '@aalis/plugin-authority-api';
import type { CommandArgv } from '@aalis/plugin-commands-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import { useDoctorService } from '@aalis/plugin-doctor-api';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import { CommandRegistry } from './commands.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-commands';
export const displayName = '内置指令';
export const subsystem = 'core';
export const provides = ['commands'];
export const inject = {
  required: ['gateway'],
  optional: ['doctor'],
};

export const configSchema: ConfigSchema = {
  commandPrefix: {
    type: 'string',
    label: '指令前缀',
    default: '/',
    description: '指令触发前缀，设为空字符串可使用纯关键词触发',
  },
};

export const defaultConfig = {
  commandPrefix: '/',
};

// ===== 插件入口 =====

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

const CLEAR_TYPES = [
  { id: 'context', label: '消息历史与会话上下文' },
  { id: 'summary', label: '会话摘要' },
  { id: 'vector', label: '向量记忆' },
  { id: 'image', label: '图片缓存' },
  { id: 'persona', label: '会话角色状态' },
  { id: 'user-profile', label: '用户档案（仅全局清理）' },
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

export function apply(ctx: Context, config: Record<string, unknown>): void {
  // 创建指令注册表并注册为服务
  const commands = new CommandRegistry(ctx.logger);
  const storage = createStorageGateway(ctx);

  // 加载指令覆盖配置
  const cmdOverrides = ctx.config.get('commandOverrides');
  if (cmdOverrides)
    commands.loadOverrides(cmdOverrides as Record<string, { authority?: number; safety?: SafetyLevel }>);

  // 配置指令系统
  commands.prefix = (config.commandPrefix as string) ?? '/';

  // 注册服务
  ctx.provide('commands', commands);

  // ===== 统一 memory:clear 中间件：图片缓存清理 =====
  //
  // 之前图片缓存清理只内联在 /clear 的 runClear 路径里，导致 deleteSession
  // 触发的 memory:clear 不会清图片，文件泄漏。改为独立 middleware 后，
  // /clear 与 deleteSession 走同一处理路径。
  ctx.middleware(
    'memory:clear',
    async (
      data: {
        scope: 'session' | 'all';
        types?: string[];
        sessionId?: string;
        results: Array<{ source: string; success: boolean; message: string }>;
        rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
      },
      next,
    ) => {
      if (data.types && !data.types.includes('image')) {
        await next();
        return;
      }
      try {
        if (data.scope === 'all') {
          const removed = await removeDirCounted(storage, 'data:/images');
          data.results.push({
            source: 'image-cache',
            success: true,
            message: removed >= 0 ? `所有图片缓存已清空（${removed} 个会话目录）` : '图片缓存目录不存在，无需清空',
          });
        } else if (data.sessionId) {
          const safeSessionId = data.sessionId.replace(/[:/\\]/g, '_');
          const removed = await removeDirCounted(storage, `data:/images/${safeSessionId}`);
          data.results.push({
            source: 'image-cache',
            success: true,
            message: removed >= 0 ? `当前会话图片缓存已清空（${removed} 张）` : '当前会话无图片缓存',
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        data.results.push({ source: 'image-cache', success: false, message: `图片缓存清空失败: ${msg}` });
      }
      await next();
    },
  );

  // ===== inbound:command 相位：命令命中则执行并中断后续相位 =====
  //
  // 历史上 OneBot 适配器内联拦截命令；现已迁移到 inbound:command 命名相位，
  // 所有平台共享同一套命令解析路径。
  // plugin-gateway 的 INBOUND_PHASE_ORDER 把本相位放在 flow / trigger 之前。
  //
  // 受信任系统源：scheduler 等内部触发器写入 message.source。
  // 这些来源的权限身份来自创建时固化的 message.actor（如 scheduler 在 setJob 时
  // snapshot 创建者身份），守卫按 actor 的真实等级评估——与普通用户走同一闸门，
  // 不再有任何绕过路径（历史上的 bypassGuard 全绕过已废除）。
  // skipSafetyCheck 仍然需要：cron 上下文无人可点 dangerous 确认弹窗。
  // 同时这些 source 通常指向 internal 虚拟 session（无适配器接收），
  // 因此结果不走 outbound 而是写日志，避免发到虚空。
  const TRUSTED_SYSTEM_SOURCES = new Set(['scheduler', 'workflow', 'system']);

  ctx.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    const { message } = data;
    // 内部触发（idle-trigger 等无 userId）不参与命令解析
    if (!message.content) return next();

    const parsed = commands.parseCommand(message.content);
    if (!parsed) return next();

    // 解析到 "<prefix>foo" 但没有任何插件注册过该指令 → 当作普通消息处理
    // （归档、trigger、agent 等下游相位继续工作），避免对错字/打字噪音回显"未知指令"。
    if (!commands.hasMatch(parsed.name, parsed.args)) return next();

    const isSystemTrigger = !!message.source && TRUSTED_SYSTEM_SOURCES.has(message.source);

    try {
      // 优先用 actor（系统触发器注入的代理身份），fallback 到消息原始身份。
      // 与 agent 工具调用路径（plugin-agent resolveToolCallContext）同语义。
      const result = await commands.execute(parsed.name, {
        sessionId: message.sessionId,
        platform: message.actor?.platform ?? message.platform,
        userId: message.actor?.userId ?? message.userId,
        sessionType: message.sessionType,
        args: parsed.args,
        raw: parsed.raw,
        skipSafetyCheck: isSystemTrigger,
      });
      if (result) {
        if (isSystemTrigger) {
          // 系统触发器（scheduler/workflow）的 sessionId 通常是 internal 虚拟 session，
          // 走 outbound 也无人接收；直接写日志便于排查。
          const preview = result.length > 500 ? `${result.slice(0, 500)}…` : result;
          ctx.logger.info(`[${message.source}] ${parsed.raw} → session=${message.sessionId} 结果:\n${preview}`);
        } else {
          const gateway = ctx.getService<GatewayService>('gateway');
          const reply = {
            content: result,
            sessionId: message.sessionId,
            platform: message.platform,
            source: 'command' as const,
          };
          if (gateway) {
            await gateway.dispatchOutbound(reply);
          } else {
            await ctx.emit('outbound:message', reply);
          }
        }
      }
    } catch (err) {
      ctx.logger.warn(`指令执行失败: ${err}`);
    }
    // 命令命中：不调用 next() —— 整个入站管道立即停止（不再进入 flow/trigger/dispatch）
  });

  // ===== 内置指令 =====

  useCommandService(ctx)
    .command('help', '显示可用指令列表')
    .action(async () => {
      const nodes = commands.getAll();
      const lines = ['**可用指令：**', ''];
      for (const n of nodes) {
        const depth = n.name.split('.').length - 1;
        const indent = '  '.repeat(depth);
        const display = depth === 0 ? `\`${commands.prefix}${n.name}\`` : `\`${n.name.split('.').pop()}\``;
        const tag = n.isGroup ? '（分组）' : '';
        lines.push(`${indent}- ${display} — ${n.description}${tag}`);
      }
      return lines.join('\n');
    });

  useCommandService(ctx)
    .command('status', '显示系统状态')
    .action(async () => {
      const lines = ['**系统状态：**', ''];
      const checks = [
        ['WebUI Server', ctx.hasService('webui-server')],
        ['CLI', ctx.hasService('cli')],
        ['LLM 服务', ctx.hasService('llm')],
        ['Agent', ctx.hasService('agent')],
        ['记忆服务', ctx.hasService('memory')],
        ['人格服务', ctx.hasService('persona')],
        ['Embedding', ctx.hasService('embedding')],
        ['向量库', ctx.hasService('vectorstore')],
      ] as const;
      for (const [label, ok] of checks) {
        lines.push(`- ${label}: ${ok ? '✅ 可用' : '❌ 不可用'}`);
      }
      const tools = ctx.getService<ToolService>('tools');
      lines.push(`- 已注册工具: ${tools ? tools.getAll().length : 0} 个`);
      lines.push(`- 已注册指令: ${commands.getAll().length} 个`);
      return lines.join('\n');
    });

  useCommandService(ctx)
    .command('shutdown', '关闭应用', { authority: 5, safety: 'dangerous' })
    .action(async () => {
      const app = ctx.getService<AppService>('app');
      if (!app) return '无法访问应用服务';
      setTimeout(async () => {
        await app.stop();
        process.exit(0);
      }, 500);
      return '正在关闭应用…';
    });

  useCommandService(ctx)
    .command('restart', '重启应用', { authority: 5, safety: 'dangerous' })
    .action(async () => {
      const app = ctx.getService<AppService>('app');
      if (!app) return '无法访问应用服务';
      app.restart();
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
      rollbacks: [] as Array<{ source: string; fn: () => Promise<void> }>,
    };

    await ctx.hooks.run('memory:clear', clearData, async () => {
      const memory = ctx.getService<MemoryService>('memory');
      if (!memory) {
        clearData.results.push({ source: 'memory', success: false, message: '记忆服务不可用' });
        return;
      }

      if (!types || types.includes('context')) {
        try {
          if (isGlobal && memory.clearAll) {
            await memory.clearAll();
            clearData.results.push({ source: 'memory', success: true, message: '所有消息历史和归档已清空' });
          } else {
            await memory.clearSession(cmdCtx.sessionId);
            clearData.results.push({ source: 'memory', success: true, message: '当前会话消息历史已清空' });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          clearData.results.push({ source: 'memory', success: false, message: `清空失败: ${msg}` });
        }
      }

      // 图片缓存与 vectorstore/persona/user-profile 等子系统的清理
      // 现在统一由各自的 memory:clear middleware 处理（见 apply() 末尾的
      // image-cache middleware）。runClear 仅负责调度 hook 与处理 memory 主体。
    });

    const hasFailure = clearData.results.some(r => !r.success);
    if (hasFailure && clearData.rollbacks.length > 0) {
      const rollbackResults: string[] = [];
      for (const rb of clearData.rollbacks) {
        try {
          await rb.fn();
          rollbackResults.push(`↩ ${rb.source}: 已回滚`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          rollbackResults.push(`↩ ${rb.source}: 回滚失败 - ${msg}`);
        }
      }
      return [
        ...clearData.results.map(r => `${r.success ? '✅' : '❌'} ${r.message}`),
        '',
        '**部分清除失败，已执行回滚：**',
        ...rollbackResults,
      ].join('\n');
    }

    if (clearData.results.length === 0) return '无可清除的记忆模块。';
    return clearData.results.map(r => `${r.success ? '✅' : '⚠'} ${r.message}`).join('\n');
  }

  async function runClearFromOptions(argv: CommandArgv, scope: ClearScope): Promise<string> {
    let types: string[] | undefined;
    try {
      types = normalizeClearTypes(argv.options.type);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return runClear({ sessionId: argv.session.sessionId }, scope, types);
  }

  const clearTypeOptDesc = `清理类型，可重复或用逗号分隔。可用: all, ${CLEAR_TYPES.map(t => t.id).join(', ')}`;

  useCommandService(ctx)
    .command('clear', '清空当前会话记忆；用 --type 选择消息、摘要、向量、图片等清理类型')
    .option('type', '-t <type:string[]>', { description: clearTypeOptDesc })
    .example('/clear')
    .example('/clear --type context,summary')
    .example('/clear -t vector -t image')
    .example('/clear all --type all')
    .action(async argv => runClearFromOptions(argv, 'session'));

  useCommandService(ctx)
    .command('clear.list', '列出可清理类型')
    .action(async () => renderClearTypeList());

  useCommandService(ctx)
    .command('clear.all', '【危险】按 --type 清空全部会话；未指定类型时清空全部类型', {
      authority: 3,
      safety: 'dangerous',
    })
    .option('type', '-t <type:string[]>', { description: clearTypeOptDesc })
    .action(async argv => runClearFromOptions(argv, 'all'));

  // 诊断检查项：检测 commandOverrides 配置中是否存在已不存在的指令名（孤立键）。
  // 历史上由 plugin-doctor 内置；现迁回 commands 自身——commands 才知道自己注册了哪些指令，
  // 也最有资格判定 override 是否「孤立」。
  useDoctorService(ctx).registerCheck({
    id: 'commands.overrides',
    category: 'config',
    pluginName: name,
    run() {
      const overrides = commands.getOverrides();
      const known = new Set(commands.getAll().map(c => c.name));
      const orphan = Object.keys(overrides).filter(k => !known.has(k));
      return {
        id: 'commands.overrides',
        category: 'config',
        level: orphan.length === 0 ? 'ok' : 'warn',
        message:
          orphan.length === 0
            ? `已注册指令 ${known.size} 个；覆盖配置 ${Object.keys(overrides).length} 条全部命中`
            : `commandOverrides 含 ${orphan.length} 条孤立键（无对应指令）`,
        detail: orphan.length > 0 ? orphan.join(', ') : undefined,
      };
    },
  });
}
