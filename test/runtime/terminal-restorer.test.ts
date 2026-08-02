import { describe, expect, it } from 'vitest';
import { disarmTerminalStateRestorer, installTerminalStateRestorer } from '../../packages/runtime/src/terminal.js';

/**
 * respawn 的成功分支：父进程等子进程回报 ready 才退出，而子进程的 ready 发生在
 * `await app.start()` 之后——plugin-cli 在 `app:started` 里已经 `\x1b[?1049h` 进了备用屏。
 * 若父进程退出时仍挂着复原钩子，它写出的 `\x1b[?1049l` 会把新实例的 TUI 踢出备用屏。
 *
 * 端到端时序（真起两个进程 + 真 TTY）离线验不了，但「钩子有没有被摘掉」这一半可以，
 * 而那正是回归最容易发生的地方——有人给成功分支加一行、顺手把 disarm 挪走。
 */
describe('runtime 终端复原钩子', () => {
  const listeners = () => process.listeners('exit').length;

  it('install 挂上、disarm 摘掉，且都幂等', () => {
    const base = listeners();
    installTerminalStateRestorer();
    expect(listeners(), 'install 后应多一个 exit 监听').toBe(base + 1);
    installTerminalStateRestorer();
    expect(listeners(), '重复 install 不得重复挂').toBe(base + 1);

    disarmTerminalStateRestorer();
    expect(listeners(), 'disarm 后应回到基线——父进程把终端交给子进程后不得再写它').toBe(base);
    disarmTerminalStateRestorer();
    expect(listeners(), '重复 disarm 不得误摘别人的监听').toBe(base);
  });

  it('disarm 后可以重新 install（不是一次性开关）', () => {
    const base = listeners();
    installTerminalStateRestorer();
    disarmTerminalStateRestorer();
    installTerminalStateRestorer();
    expect(listeners()).toBe(base + 1);
    disarmTerminalStateRestorer();
    expect(listeners()).toBe(base);
  });
});
