import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { Context, PersonaService, MemoryService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = 'aalis-plugin-cli';
export const inject = {
  optional: [{ service: 'llm', capabilities: ['chat'] }],
};
export const provides = ['platform'];

// ===== 配置 =====

interface CLIConfig {
  prompt?: string;
  sessionId?: string;
}

// ===== 内置命令 =====

const COMMANDS: Record<string, string> = {
  '/help': '显示帮助信息',
  '/clear': '清空当前会话历史',
  '/status': '显示系统状态',
  '/quit': '退出程序',
};

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

      // 内置命令处理
      if (trimmed.startsWith('/')) {
        const handled = await handleCommand(ctx, trimmed, sessionId);
        if (handled === 'quit') break;
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

async function handleCommand(
  ctx: Context,
  command: string,
  sessionId: string,
): Promise<string | void> {
  switch (command) {
    case '/help':
      console.log(chalk.bold('\n可用命令:'));
      for (const [cmd, desc] of Object.entries(COMMANDS)) {
        console.log(`  ${chalk.cyan(cmd.padEnd(12))} ${desc}`);
      }
      console.log();
      return;

    case '/clear': {
      const memory = ctx.getService<MemoryService>('memory');
      if (memory) {
        await memory.clearSession(sessionId);
        console.log(chalk.yellow('会话历史已清空。\n'));
      } else {
        console.log(chalk.yellow('记忆服务未启用。\n'));
      }
      return;
    }

    case '/status': {
      console.log(chalk.bold('\n系统状态:'));
      const hasLLM = ctx.hasService('llm');
      const hasMemory = ctx.hasService('memory');
      const hasPersona = ctx.hasService('persona');
      console.log(`  LLM 服务:    ${hasLLM ? chalk.green('可用') : chalk.red('不可用')}`);
      console.log(`  记忆服务:    ${hasMemory ? chalk.green('可用') : chalk.red('不可用')}`);
      console.log(`  人格服务:    ${hasPersona ? chalk.green('可用') : chalk.red('不可用')}`);
      const tools = ctx.tools.getDefinitions();
      console.log(`  已注册工具:  ${tools.length} 个`);
      console.log();
      return;
    }

    case '/quit':
      console.log(chalk.gray('再见！'));
      return 'quit';

    default:
      console.log(chalk.red(`未知命令: ${command}。输入 /help 查看帮助。\n`));
      return;
  }
}
