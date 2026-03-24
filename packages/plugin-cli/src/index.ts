import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { Context, PersonaService, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-cli';
export const inject = {
  optional: [{ service: 'llm', capabilities: ['chat'] }],
};
export const provides = ['platform'];

export const configSchema: ConfigSchema = {
  prompt: { type: 'string', label: '提示符', default: 'You' },
};

export const defaultConfig = {
  prompt: 'You',
  sessionId: 'cli-default',
};

// ===== 配置 =====

interface CLIConfig {
  prompt?: string;
  sessionId?: string;
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cliConfig: CLIConfig = {
    prompt: (config.prompt as string) ?? 'You',
    sessionId: (config.sessionId as string) ?? 'cli-default',
  };

  const sessionId = cliConfig.sessionId!;

  // 注册为平台服务
  ctx.provide('platform', { name: 'cli' }, { capabilities: ['text'] });

  // 监听 AI 回复
  ctx.on('message:send', (msg) => {
    if (msg.sessionId !== sessionId) return;
    console.log(`\n${chalk.green('Aalis')}${chalk.gray('>')} ${msg.content}\n`);
  });

  // 启动 REPL（在 ready 事件后）
  ctx.on('ready', () => {
    startREPL(ctx, cliConfig, sessionId);
  });
}

async function startREPL(ctx: Context, config: CLIConfig, sessionId: string): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const promptStr = `${chalk.blue(config.prompt!)}${chalk.gray('>')} `;

  // 显示欢迎信息
  const persona = ctx.getService<PersonaService>('persona');
  const assistantName = persona?.getPersonaName() ?? 'Aalis';
  console.log(`\n${chalk.bold(`欢迎使用 ${assistantName}!`)} 输入 /help 查看命令列表。\n`);

  // readline 关闭（Ctrl+C 或 /quit）时退出进程
  rl.on('close', () => {
    process.kill(process.pid, 'SIGINT');
  });

  // 清理
  ctx.on('dispose', () => {
    rl.close();
  });

  const askLoop = async () => {
    while (!ctx.disposed) {
      let line: string;
      try {
        line = await rl.question(promptStr);
      } catch {
        break; // EOF or closed
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      // 斜杠指令处理 —— 通过指令注册表
      if (trimmed.startsWith('/')) {
        const parts = trimmed.slice(1).split(/\s+/);
        const cmdName = parts[0];
        const args = parts.slice(1);

        const result = await ctx.commands.execute(cmdName, {
          sessionId,
          platform: 'cli',
          args,
          raw: trimmed,
        });

        if (result) {
          console.log(`\n${result}\n`);
        }

        // /shutdown 后退出循环
        if (cmdName === 'shutdown' || cmdName === 'restart') break;

        continue;
      }

      // 发送消息给 Agent
      await ctx.emit('message:received', {
        content: trimmed,
        sessionId,
        platform: 'cli',
      });
    }
  };

  askLoop().catch(() => {});
}
