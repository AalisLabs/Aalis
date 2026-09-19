import { describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../packages/core/src/index.js';
// DisposableChain 不从包根导出（内部实现细节）；直接从源文件导入测试。
import { type CleanupReporter, DisposableChain } from '../../packages/core/src/kernel/disposable-chain.js';

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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const chain = new DisposableChain(logger);
    chain.push(() => order.push(1));
    chain.push(() => {
      throw new Error('boom');
    });
    chain.push(() => order.push(3));
    chain.dispose();
    expect(order).toEqual([3, 1]);
    // 清理抛错记 warn 级：泄漏头号成因不许静音（默认 logLevel=info 下 debug 不可见）
    expect(warnSpy).toHaveBeenCalled();
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

describe('DisposableChain 分段', () => {
  it('排空快照内撤回段先、清理段后，各段内部逆序（dispose 与 disposeAsync 同序）', async () => {
    const run = async (mode: 'sync' | 'async') => {
      const order: string[] = [];
      const chain = new DisposableChain(new DefaultLogger('test'));
      chain.push(() => order.push('c1'));
      chain.push(() => order.push('w1'), 'w1', 'withdraw');
      chain.push(() => order.push('c2'), 'c2', 'cleanup');
      chain.push(() => order.push('w2'), 'w2', 'withdraw');
      if (mode === 'sync') chain.dispose();
      else await chain.disposeAsync();
      return order;
    };
    expect(await run('sync')).toEqual(['w2', 'w1', 'c2', 'c1']);
    expect(await run('async')).toEqual(['w2', 'w1', 'c2', 'c1']);
  });

  it('排空期间的迟到登记仍立即执行，不受段约束（撤回段回调里登记的清理段项插在剩余撤回之前）', () => {
    const order: string[] = [];
    const chain = new DisposableChain(new DefaultLogger('test'));
    chain.push(() => order.push('c1'));
    chain.push(() => order.push('w1'), 'w1', 'withdraw');
    chain.push(
      () => {
        order.push('w2');
        chain.push(() => order.push('late'), 'late', 'cleanup');
      },
      'w2',
      'withdraw',
    );
    chain.dispose();
    expect(order).toEqual(['w2', 'late', 'w1', 'c1']);
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
    // 同时钉住序号兜底：全仓 78 处 onDispose 不传 label，[#i] 是它们唯一能拿到的标识
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('超过 30ms'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[#'));
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

describe('DisposableChain reporter 自身失败不中断清理', () => {
  const brokenSink = {
    warn: () => {
      throw new Error('sink broken');
    },
  };

  it('reporter 抛错：剩余清理项照跑，dispose 不抛', () => {
    const chain = new DisposableChain(brokenSink);
    const order: number[] = [];
    chain.push(() => {
      order.push(1);
    });
    chain.push(() => {
      throw new Error('boom');
    });
    chain.push(() => {
      order.push(3);
    });
    expect(() => chain.dispose()).not.toThrow();
    expect(order, '抛错项之后（逆序即更早登记）的清理必须仍执行').toEqual([3, 1]);
  });

  it('reporter 抛错：disposeAsync 下拒绝项之后的清理照跑，promise 正常 resolve', async () => {
    const chain = new DisposableChain(brokenSink);
    const order: number[] = [];
    chain.push(() => {
      order.push(1);
    });
    chain.push(async () => {
      throw new Error('boom');
    });
    chain.push(() => {
      order.push(3);
    });
    await expect(chain.disposeAsync()).resolves.toBeUndefined();
    expect(order).toEqual([3, 1]);
  });

  it('reporter 返回拒绝的 promise：不逃逸成 unhandledRejection', async () => {
    const asyncBrokenSink: CleanupReporter = { warn: () => Promise.reject(new Error('async sink broken')) };
    const chain = new DisposableChain(asyncBrokenSink);
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => {
      escaped.push(err);
    };
    process.on('unhandledRejection', onEscape);
    try {
      chain.push(() => {
        throw new Error('boom');
      });
      chain.dispose();
      await new Promise(r => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped).toEqual([]);
  });

  it('reporter 抛错：同步 dispose 下异步拒绝项的上报不逃逸', async () => {
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => {
      escaped.push(err);
    };
    process.on('unhandledRejection', onEscape);
    try {
      const chain = new DisposableChain(brokenSink);
      chain.push(async () => {
        throw new Error('boom');
      });
      chain.dispose();
      await new Promise(r => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped).toEqual([]);
  });

  it('reporter 抛错：关闭后迟到登记的执行失败不抛给登记方', () => {
    const chain = new DisposableChain(brokenSink);
    chain.dispose();
    expect(() =>
      chain.push(() => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});
