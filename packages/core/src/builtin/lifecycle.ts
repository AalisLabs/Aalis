import type { Context } from '../context.js';
import type { PluginModule } from '../plugin.js';
import type { ToolRegistry } from '../tools.js';
import type { AppService, VectorStoreService } from '../types.js';

/**
 * 内置插件：生命周期指令
 *
 * 提供 /help, /status, /shutdown, /restart, /grant, /authority 等核心指令。
 * 从 App 中拆出，使 App 类更精简，同时遵循"一切皆插件"的架构原则。
 */
const builtinLifecycle: PluginModule = {
  name: '@aalis/builtin-lifecycle',
  core: true,
  inject: { required: ['commands', 'authority'] },

  apply(ctx: Context) {
    // /help — 动态列出所有已注册指令
    ctx.command('help', '显示可用指令列表', async () => {
      const all = ctx.commands.getAll();
      const prefix = ctx.commands.prefix;
      const lines = ['**可用指令：**', ''];
      for (const cmd of all) {
        lines.push(`- \`${prefix}${cmd.name}\` — ${cmd.description}`);
      }
      return lines.join('\n');
    });

    // /status — 显示系统状态
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
      const tools = ctx.getService<ToolRegistry>('tools');
      lines.push(`- 已注册工具: ${tools ? tools.getDefinitions().length : 0} 个`);
      const cmds = ctx.commands.getAll();
      lines.push(`- 已注册指令: ${cmds.length} 个`);
      return lines.join('\n');
    });

    // /shutdown — 关闭应用
    ctx.command('shutdown', '关闭应用', async () => {
      const app = ctx.getService<AppService>('app');
      if (!app) return '无法访问应用服务';
      setTimeout(async () => {
        await app.stop();
        process.exit(0);
      }, 500);
      return '正在关闭应用…';
    }, { authority: 5, safety: 'dangerous' });

    // /restart — 重启应用
    ctx.command('restart', '重启应用', async () => {
      const app = ctx.getService<AppService>('app');
      if (!app) return '无法访问应用服务';
      app.restart();
      return '正在重启应用…';
    }, { authority: 5, safety: 'dangerous' });

    // /grant — 设置用户权限等级
    ctx.command('grant', '设置用户权限 (用法: grant <platform:userId> <level>)', async (cmdCtx) => {
      if (cmdCtx.args.length < 2) {
        const prefix = ctx.commands.prefix;
        return `用法: ${prefix}grant <platform:userId> <level>`;
      }
      const [target, levelStr] = cmdCtx.args;
      const level = parseInt(levelStr, 10);
      if (isNaN(level) || level < 0) {
        return '权限等级必须是非负整数。';
      }
      const callerAuth = ctx.authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
      if (level >= callerAuth) {
        return `不能将权限设置为 >= 您自身的等级 (${callerAuth})。`;
      }
      const sep = target.indexOf(':');
      if (sep < 1) {
        return '目标格式: <platform:userId>，例如 onebot:12345';
      }
      const platform = target.slice(0, sep);
      const userId = target.slice(sep + 1);
      ctx.authority.setAuthority(platform, userId, level);
      ctx.authority.save();
      return `已将 ${target} 的权限等级设置为 ${level}。`;
    }, { authority: 2 });

    // /authority — 查看当前用户权限等级
    ctx.command('authority', '查看自己或指定用户的权限等级', async (cmdCtx) => {
      const authority = ctx.authority;
      if (cmdCtx.args.length > 0) {
        const target = cmdCtx.args[0];
        const sep = target.indexOf(':');
        if (sep < 1) return '目标格式: <platform:userId>';
        const level = authority.getAuthority(target.slice(0, sep), target.slice(sep + 1));
        return `${target} 的权限等级: ${level}`;
      }
      const level = authority.getAuthority(cmdCtx.platform, cmdCtx.userId);
      const isOwner = authority.isOwner(cmdCtx.platform, cmdCtx.userId);
      return `您的权限等级: ${level}${isOwner ? ' (owner)' : ''}`;
    });

    // /clear — 清空会话历史及长期记忆（memory fallback 和真实 memory 均可用）
    ctx.command('clear', '清空当前会话历史及长期记忆', async (cmdCtx) => {
      const memory = ctx.getService<{ clearSession(id: string): Promise<void> }>('memory');
      if (!memory) return '记忆服务不可用。';
      await memory.clearSession(cmdCtx.sessionId);
      const vectorstore = ctx.getService<VectorStoreService>('vectorstore');
      if (vectorstore) {
        await vectorstore.clear();
      }
      return '会话历史与长期记忆已清空。';
    });
  },
};

export default builtinLifecycle;
