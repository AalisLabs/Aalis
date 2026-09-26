import { describe, expect, it } from 'vitest';
import { DisposableChain } from '../../packages/core/src/kernel/disposable-chain.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 内核必须自足：链取走后的 push 就地执行、不等待异步返回值，登记方也拿不到它——
// 拒绝若无人接，会逃逸成宿主进程的 unhandledRejection。兜底归内核，上层不跨层重复守卫。
// 同步抛出的隔离已由 disposable-chain.test.ts 覆盖，这里只钉异步拒绝。
// ════════════════════════════════════════════════════════════

const tick = () => new Promise(r => setTimeout(r, 0));

function reporter() {
  const warns: { message: string; err: unknown }[] = [];
  return {
    warns,
    warn: (message: string, ...args: unknown[]) => {
      warns.push({ message, err: args[0] });
    },
  };
}

describe('DisposableChain 异步拒绝兜底（内核自足）', () => {
  it('post-dispose 追加：就地执行的异步拒绝被接住并按 label 点名', async () => {
    const r = reporter();
    const chain = new DisposableChain(r);
    chain.seal();
    const late = new Error('late');
    chain.push(async () => {
      throw late;
    }, 'y');
    await tick();
    const hit = r.warns.find(w => w.err === late);
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('[y]');
  });

  it('逐项超时之后才到的拒绝：仍按 label 点名上报，不被放弃等待吞掉', async () => {
    const r = reporter();
    const chain = new DisposableChain(r);
    const pending = deferred();
    const late = new Error('ECONNRESET');
    chain.push(() => pending.promise, 'db');
    await chain.disposeAsync(5);
    expect(r.warns.map(w => w.message)).toEqual(['DisposableChain: 异步清理 [db] 超过 5ms，放弃等待，继续后续清理']);
    pending.reject(late);
    await tick();
    expect(r.warns.at(-1)).toEqual({ message: 'DisposableChain: dispose 抛出，已忽略 [db]:', err: late });
  });
});
