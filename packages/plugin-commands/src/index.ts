import { rm, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  Context,
  ConfigSchema,
  AppService,
  MemoryService,
  ToolService,
} from '@aalis/core';
import { CommandRegistry } from './commands.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-commands';
export const displayName = '内置指令';
export const provides = ['commands'];
export const inject = {};

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
async function removeDirCounted(dirAbs: string): Promise<number> {
  try {
    const st = await stat(dirAbs);
    if (!st.isDirectory()) return -1;
    const entries = await readdir(dirAbs);
    await rm(dirAbs, { recursive: true, force: true });
    return entries.length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return -1;
    throw err;
  }
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  // 创建指令注册表并注册为服务
  const commands = new CommandRegistry(ctx.logger);

  // 加载指令覆盖配置
  const cmdOverrides = ctx.config.get('commandOverrides');
  if (cmdOverrides) commands.loadOverrides(cmdOverrides as Record<string, { authority?: number; safety?: string }>);

  // 配置指令系统
  commands.prefix = (config.commandPrefix as string) ?? '/';

  // 注册服务
  ctx.provide('commands', commands);

  // ===== 内置指令 =====

  ctx.command('help', '显示可用指令列表', async () => {
    const nodes = commands.getAllNodes();
    const lines = ['**可用指令：**', ''];
    for (const n of nodes) {
      const indent = '  '.repeat(n.depth);
      const display = n.depth === 0
        ? `\`${commands.prefix}${n.name}\``
        : `\`${n.name}\``;
      const tag = n.hasSubcommands && !n.hasAction ? '（分组）' : '';
      lines.push(`${indent}- ${display} — ${n.description}${tag}`);
    }
    return lines.join('\n');
  });

  ctx.command('status', '显示系统状态', async () => {
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

  ctx.command('shutdown', '关闭应用', async () => {
    const app = ctx.getService<AppService>('app');
    if (!app) return '无法访问应用服务';
    setTimeout(async () => {
      await app.stop();
      process.exit(0);
    }, 500);
    return '正在关闭应用…';
  }, { authority: 5, safety: 'dangerous' });

  ctx.command('restart', '重启应用', async () => {
    const app = ctx.getService<AppService>('app');
    if (!app) return '无法访问应用服务';
    app.restart();
    return '正在重启应用…';
  }, { authority: 5, safety: 'dangerous' });

  // ===== /clear —— 清空记忆 =====
  // 子指令树：
  //   /clear           ← 等价 all：清空当前会话所有类型
  //   /clear context   ← 仅消息历史
  //   /clear summary   ← 仅摘要
  //   /clear vector    ← 仅向量
  //   /clear image     ← 仅图片缓存
  //   /clear nuke      ← 全局所有会话所有类型（authority=3, dangerous）
  //
  // scope='all' 表示全局，'session' 表示当前会话；types=undefined 表示全部类型。
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

      // 图片缓存清除：与 plugin-adapter-onebot 的目录约定保持一致 data/images/{safeSessionId}/
      if (!types || types.includes('image')) {
        try {
          if (isGlobal) {
            const dirAbs = resolve(process.cwd(), 'data/images');
            const removed = await removeDirCounted(dirAbs);
            clearData.results.push({
              source: 'image-cache',
              success: true,
              message: removed >= 0 ? `所有图片缓存已清空（${removed} 个会话目录）` : '图片缓存目录不存在，无需清空',
            });
          } else {
            const safeSessionId = cmdCtx.sessionId.replace(/[:/\\]/g, '_');
            const dirAbs = resolve(process.cwd(), 'data/images', safeSessionId);
            const removed = await removeDirCounted(dirAbs);
            clearData.results.push({
              source: 'image-cache',
              success: true,
              message: removed >= 0 ? `当前会话图片缓存已清空（${removed} 张）` : '当前会话无图片缓存',
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          clearData.results.push({ source: 'image-cache', success: false, message: `图片缓存清空失败: ${msg}` });
        }
      }
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

  ctx.command(
    'clear',
    '清空当前会话的全部记忆（消息/摘要/向量/图片）。子指令可只清单一类型',
    async (cmdCtx) => runClear(cmdCtx, 'session', undefined),
    {
      subcommands: [
        { name: 'context', description: '仅清当前会话的消息历史', action: async (c) => runClear(c, 'session', ['context']) },
        { name: 'summary', description: '仅清当前会话的摘要', action: async (c) => runClear(c, 'session', ['summary']) },
        { name: 'vector', description: '仅清当前会话的向量记忆', action: async (c) => runClear(c, 'session', ['vector']) },
        { name: 'image', description: '仅清当前会话的图片缓存', action: async (c) => runClear(c, 'session', ['image']) },
        {
          name: 'nuke',
          description: '【危险】清空全部会话的所有类型记忆与图片',
          authority: 3,
          safety: 'dangerous',
          action: async (c) => runClear(c, 'all', undefined),
        },
      ],
    },
  );
}
