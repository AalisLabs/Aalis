const TERMINAL_RESTORE_SEQUENCE = '\x1b[?1006l\x1b[?1000l\x1b[?1007l\x1b[?25h\x1b[?1049l';

let installed = false;

export function restoreTerminalState(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {
    /* ignore */
  }
}

export function installTerminalStateRestorer(): void {
  if (installed) return;
  installed = true;
  process.once('exit', restoreTerminalState);
}

/**
 * 摘掉退出复原钩子。
 *
 * 用于「本进程把终端交给了别人」的场合——目前只有 respawn 的成功分支：父进程等到子进程
 * 回报 ready 才退出，而子进程的 ready 发生在 `await app.start()` **之后**（start 里串行
 * await 完 `app:started`，plugin-cli 正是在那里 `\x1b[?1049h` 进备用屏）。于是父进程的
 * exit 钩子写出的 `\x1b[?1049l` 落在子进程已接管终端之后，把新实例的 TUI 当场踢出备用屏。
 *
 * 摘掉是安全的：父进程停机时 plugin-cli 自己的 `stop()` 已经复原过一次
 * （经 `ctx.onDispose`），这个钩子在该路径上本就是第二次复原。
 * 失败分支（子进程夭折）不得摘——那条路没有别人接管终端。
 */
export function disarmTerminalStateRestorer(): void {
  if (!installed) return;
  installed = false;
  process.off('exit', restoreTerminalState);
}
