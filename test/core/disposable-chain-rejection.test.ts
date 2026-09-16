import { describe, expect, it } from 'vitest';
import { DisposableChain } from '../../packages/core/src/disposable-chain.js';

// ════════════════════════════════════════════════════════════
// 内核必须自足：宿主可以不经 Context 直接使用清理链。同步 dispose() 与 post-dispose 的 push
// 都不等待异步返回值，此前拒绝无人接——裸用时逃逸成宿主进程的 unhandledRejection。
// Context.onDispose 曾自带一层包装接住它，现已删除：兜底归内核，Context 不再跨层重复守卫。
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
  it('同步 dispose：清理函数返回的拒绝被接住并按 label 点名，不逃逸', async () => {
    const r = reporter();
    const chain = new DisposableChain(r);
    const boom = new Error('boom');
    chain.push(async () => {
      throw boom;
    }, 'x');
    chain.dispose();
    await tick();
    const hit = r.warns.find(w => w.err === boom);
    expect(hit, '拒绝必须交给 reporter').toBeDefined();
    expect(hit?.message).toContain('[x]');
  });

  it('post-dispose 追加：就地执行的异步拒绝同样被接住', async () => {
    const r = reporter();
    const chain = new DisposableChain(r);
    chain.dispose();
    const late = new Error('late');
    chain.push(async () => {
      throw late;
    }, 'y');
    await tick();
    const hit = r.warns.find(w => w.err === late);
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('[y]');
  });
});
