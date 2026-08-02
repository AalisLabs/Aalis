import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // 哨兵：vitest worker 里 exit 监听基线是 0，`toBe(base)` 会退化成 `toBe(0)`——
    // 那样把 disarm 实现换成 `removeAllListeners('exit')` 也照样全绿，而断言文案恰恰是
    // 「不得误摘别人的监听」。挂个哨兵让基线非 0，计数断言才有鉴别力。
    const sentinel = () => undefined;
    process.on('exit', sentinel);
    try {
      runIdempotencyChecks();
    } finally {
      process.off('exit', sentinel);
    }
  });

  function runIdempotencyChecks() {
    const base = listeners();
    installTerminalStateRestorer();
    expect(listeners(), 'install 后应多一个 exit 监听').toBe(base + 1);
    installTerminalStateRestorer();
    expect(listeners(), '重复 install 不得重复挂').toBe(base + 1);

    disarmTerminalStateRestorer();
    expect(listeners(), 'disarm 后应回到基线——父进程把终端交给子进程后不得再写它').toBe(base);
    disarmTerminalStateRestorer();
    expect(listeners(), '重复 disarm 不得误摘别人的监听').toBe(base);
  }

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

/**
 * 光有 disarm 还不够——回归最可能发生在**调用点**被挪走。走真进程验时序离线做不到，
 * 但「成功分支里到底调没调」可以按源码断言（本仓已有先例：architecture 测试同样读源码
 * 断言 import 说明符）。
 */
describe('respawn 成功分支必须摘掉终端复原钩子', () => {
  it("providers.ts 的 outcome !== 'died' 分支里调了 disarmTerminalStateRestorer", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../packages/runtime/src/providers.ts'),
      'utf-8',
    );
    const branch = src.slice(src.indexOf("if (outcome !== 'died')"));
    const body = branch.slice(0, branch.indexOf('process.exit(0)'));
    expect(
      body.includes('disarmTerminalStateRestorer()'),
      '子进程已接管终端，父进程退出前必须摘钩子——否则复原序列把新实例的 TUI 踢出备用屏',
    ).toBe(true);
  });
});
