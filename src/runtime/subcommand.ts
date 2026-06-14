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
    // userId 'console'：本地终端 = 运维者本人，命中 authority 的 cli:console owner 快速通道。
    // 一次性子命令模式无人可点交互确认，故 skipConfirm（authorize 仍生效，owner 直接放行）。
    userId: 'console',
    args: rest,
    raw: `/${cmdName}${rest.length ? ` ${rest.join(' ')}` : ''}`,
    skipConfirm: true,
  });
  if (result) out(result);
  return 0;
}
