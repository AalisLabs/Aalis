import { describe, expect, it, vi } from 'vitest';
// DisposableChain 不从包根导出（内部实现细节）；直接从源文件导入测试。
import { DisposableChain } from '../../packages/core/src/disposable-chain.js';
import { DefaultLogger } from '../../packages/core/src/index.js';

describe('DisposableChain', () => {
  it('逆序执行清理函数', () => {
    const order: number[] = [];
    const chain = new DisposableChain(new DefaultLogger('test'));
    chain.push(() => order.push(1));
    chain.push(() => order.push(2));
    chain.push(() => order.push(3));
    chain.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it('单个清理函数异常不中断其他（被 swallow）', () => {
    const order: number[] = [];
    const logger = new DefaultLogger('test');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const chain = new DisposableChain(logger);
    chain.push(() => order.push(1));
    chain.push(() => {
      throw new Error('boom');
    });
    chain.push(() => order.push(3));
    chain.dispose();
    expect(order).toEqual([3, 1]);
    expect(debugSpy).toHaveBeenCalled();
  });

  it('dispose 后再 push 立即执行', () => {
    const chain = new DisposableChain();
    chain.dispose();
    let ran = false;
    chain.push(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('重复 dispose 无副作用', () => {
    const order: number[] = [];
    const chain = new DisposableChain();
    chain.push(() => order.push(1));
    chain.dispose();
    chain.dispose();
    expect(order).toEqual([1]);
  });

  it('remove 精确移除登记项不执行', () => {
    const order: number[] = [];
    const chain = new DisposableChain();
    const fn = () => order.push(99);
    chain.push(() => order.push(1));
    chain.push(fn);
    expect(chain.remove(fn)).toBe(true);
    chain.dispose();
    expect(order).toEqual([1]);
  });

  it('回归：dispose 期间 disposer 移除同链其他项不破坏迭代（旧实现抛 _items[i] is not a function）', () => {
    // 复现真实场景：ctx.dispose → 链上 provide/whenService 的 disposer 执行时会
    // remove(自身/兄弟)。旧实现在迭代中 splice 活动数组 → 索引错位 → _items[i]
    // 取到 undefined 抛错（被 debug swallow，每个插件停机时刷屏）。
    const order: number[] = [];
    const logger = new DefaultLogger('test');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const chain = new DisposableChain(logger);
    const a = () => order.push(1);
    const b = () => order.push(2);
    chain.push(a);
    chain.push(b);
    // 最后入链 → 最先执行；执行时移除两个更低索引、尚未执行的兄弟
    chain.push(() => {
      order.push(3);
      chain.remove(a);
      chain.remove(b);
    });
    expect(() => chain.dispose()).not.toThrow();
    // 快照语义：所有已登记项各执行一次（逆序），dispose 期间的 remove 为安全 no-op
    expect(order).toEqual([3, 2, 1]);
    // 不再有 "is not a function" 被吞进 debug
    expect(debugSpy).not.toHaveBeenCalled();
  });
});

describe('DisposableChain.disposeAsync', () => {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  it('异步项按逆序串行完成（后一项等前一项 settle）', async () => {
    const order: string[] = [];
    const chain = new DisposableChain(new DefaultLogger('test'));
    chain.push(async () => {
      order.push('a:start');
      await sleep(20);
      order.push('a:end');
    });
    chain.push(async () => {
      order.push('b:start');
      await sleep(5);
      order.push('b:end');
    });
    await chain.disposeAsync();
    // 逆序：b 先跑且完整结束后 a 才开始——串行而非并发
    expect(order).toEqual(['b:start', 'b:end', 'a:start', 'a:end']);
  });

  it('单项拒绝不中断后续清理', async () => {
    const order: number[] = [];
    const logger = new DefaultLogger('test');
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const chain = new DisposableChain(logger);
    chain.push(() => order.push(1));
    chain.push(async () => {
      throw new Error('async boom');
    });
    chain.push(() => order.push(3));
    await chain.disposeAsync();
    expect(order).toEqual([3, 1]);
  });

  it('逐项超时：卡住的项被放弃，后续项照跑，且不悬挂进程', async () => {
    const order: string[] = [];
    const logger = new DefaultLogger('test');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const chain = new DisposableChain(logger);
    chain.push(() => order.push('early'));
    chain.push(
      () =>
        new Promise<void>(() => {
          order.push('stuck:start'); // 永不 resolve
        }),
    );
    chain.push(() => order.push('late'));
    await chain.disposeAsync(30);
    expect(order).toEqual(['late', 'stuck:start', 'early']); // 卡住项之后（逆序意义上）的 early 仍执行
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('超过 30ms'));
  });

  it('同步 dispose() 不等待异步返回值（既有语义不变）', async () => {
    let settled = false;
    const chain = new DisposableChain(new DefaultLogger('test'));
    chain.push(async () => {
      await sleep(10);
      settled = true;
    });
    chain.dispose();
    expect(settled).toBe(false); // 返回即未等待
    await sleep(20); // 别让迟到 promise 影响后续测试
  });
});
