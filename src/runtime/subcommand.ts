import type { App } from '@aalis/core';
import type { CommandService } from '@aalis/plugin-commands-api';

/**
 * 尝试把 argv 当作命令调用：`aalis <name> [args...]` ↔ chat 中的 `/<name> args`。
 *
 * - 返回 number 时表示命中并需要按该 exit code 结束进程；
 * - 返回 null 表示未命中（commands 服务不存在或命令名未注册），调用方应继续守护进程模式。
 *
 * 不直接绑定任何具体命令；所有命令由插件向 commands 服务注册。
 *
 * 抽离到独立模块以便单测（src/index.ts 有顶层副作用，直接 import 会触发）。
 */
export async function tryDispatchSubcommand(
  app: App,
  argv: string[],
  out: (msg: string) => void = msg => console.log(msg),
): Promise<number | null> {
  const commands = app.ctx.getService<CommandService>('commands');
  if (!commands) return null;
  const [cmdName, ...rest] = argv;
  if (!cmdName || !commands.has(cmdName)) return null;
  const result = await commands.execute(cmdName, {
    sessionId: 'cli',
    platform: 'cli',
    userId: 'cli',
    args: rest,
    raw: `/${cmdName}${rest.length ? ` ${rest.join(' ')}` : ''}`,
    skipSafetyCheck: true,
  });
  if (result) out(result);
  return 0;
}
