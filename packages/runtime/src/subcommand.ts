import type { CommandService } from '@aalis/api-commands';
import type { App } from '@aalis/core';

/**
 * 把 argv 当作命令调用：`aalis <name> [args...]` ↔ chat 中的 `/<name> args`。
 *
 * 返回进程 exit code：命中则执行并返回 0；commands 服务不存在或命令名未注册则经 `err`
 * 报错并返回 2。**不存在「未命中就放行」的分支**——argv 非空即子命令模式，调用方据此退出、
 * 不进守护进程：打错的命令名若照常起守护，就是与运行中实例并存的第二个实例。
 *
 * 不直接绑定任何具体命令；所有命令由插件向 commands 服务注册。
 *
 * 抽离到独立模块以便单测（src/index.ts 有顶层副作用，直接 import 会触发）。
 */
export async function tryDispatchSubcommand(
  app: App,
  argv: string[],
  out: (msg: string) => void = msg => console.log(msg),
  err: (msg: string) => void = msg => console.error(msg),
): Promise<number> {
  const [cmdName = '', ...rest] = argv;
  const commands = app.ctx.getService<CommandService>('commands');
  if (!commands) {
    err(`无法执行子命令「${cmdName}」：commands 服务不可用（未安装 @aalis/plugin-commands？）`);
    return 2;
  }
  if (!cmdName || !commands.has(cmdName)) {
    err(`未知子命令「${cmdName}」。子命令等价于聊天里的 /${cmdName}；不带参数启动才进守护进程。`);
    return 2;
  }
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
