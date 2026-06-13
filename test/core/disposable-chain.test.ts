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
});
