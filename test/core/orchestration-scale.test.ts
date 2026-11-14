import { describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../packages/core/src/index.js';
import { quietLogger } from '../../packages/core/src/infrastructure/logger.js';
import { Activation } from '../../packages/core/src/orchestration/activation.js';
import { ActivationHost } from '../../packages/core/src/orchestration/activation-host.js';
import { closeActivations } from '../../packages/core/src/orchestration/close-plan.js';
import { heapPop } from '../../packages/core/src/orchestration/min-heap.js';
import type { PluginRecord } from '../../packages/core/src/orchestration/plugin-activation.js';
import { topoSortByDeps } from '../../packages/core/src/orchestration/plugin-topology.js';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

// ════════════════════════════════════════════════════════════
// 互不依赖的插件变多时，编排里量的几项次数不按平方涨。每条用例量一项，量的是同步执行期间的次数，不量耗时：
// 结果不随机器负载变。没有用例量的不在这里下结论：依赖成环时每卡住一次仍把剩余阶段整体找一遍环。
// ════════════════════════════════════════════════════════════

// 小顶堆照原样执行，只多记调用次数
vi.mock('../../packages/core/src/orchestration/min-heap.js', { spy: true });

const log = quietLogger(new DefaultLogger('test', 'error'));

/** fn 同步执行期间的 Map 查表次数 */
function mapLookups(fn: () => void): number {
  const get = Map.prototype.get;
  let count = 0;
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    count++;
    return get.call(this, key);
  };
  try {
    fn();
  } finally {
    Map.prototype.get = get;
  }
  return count;
}

/** count 个互不依赖的登记 */
function leaves(count: number): PluginRecord[] {
  return Array.from(
    { length: count },
    (_, i) => ({ instanceId: `p${i}`, spec: { required: [] } }) as unknown as PluginRecord,
  );
}

/** 根激活名下挂 count 个互不依赖的插件激活 */
function hostWith(count: number): ActivationHost {
  const host = new ActivationHost(new ServiceContainer(), log);
  for (let i = 0; i < count; i++) host.create(`p${i}`);
  return host;
}

describe('互不依赖的插件变多时，编排里量的几项次数不按平方涨', () => {
  it('互不依赖的登记数翻两番，排激活次序的查表次数不到八倍', () => {
    const lookups = (count: number): number => mapLookups(() => void topoSortByDeps(leaves(count), log));
    expect(lookups(800) / lookups(200)).toBeLessThan(8);
  });

  it('排激活次序时，就绪的登记各经小顶堆取出一次', () => {
    vi.mocked(heapPop).mockClear();
    topoSortByDeps(leaves(300), log);
    expect(heapPop).toHaveBeenCalledTimes(300);
  });

  it('互不依赖的激活数翻两番，排关闭计划的查表次数不到八倍', async () => {
    // 排计划在 closeActivations 的同步段里：第一个 await 之前
    const lookups = async (count: number): Promise<number> => {
      const host = hostWith(count);
      let closing!: Promise<void>;
      const total = mapLookups(() => {
        closing = closeActivations([host.root], undefined, log);
      });
      await closing;
      return total;
    };
    expect((await lookups(400)) / (await lookups(100))).toBeLessThan(8);
  });

  it('排关闭计划时，每个激活的收尾与关闭两个阶段各经小顶堆取出一次', async () => {
    const host = hostWith(100);
    vi.mocked(heapPop).mockClear();
    const closing = closeActivations([host.root], undefined, log);
    const pops = vi.mocked(heapPop).mock.calls.length;
    await closing;
    expect(pops).toBe(2 * 101);
  });

  it('排关闭计划时每个激活的依赖至多算两遍：成员各一遍，找等着关的消费者时全体各一遍', async () => {
    const host = hostWith(60);
    const providers = vi.spyOn(Activation.prototype, 'providers');
    const closing = closeActivations([host.root], undefined, log);
    const calls = providers.mock.calls.length;
    providers.mockRestore();
    await closing;
    expect(calls).toBeLessThanOrEqual(2 * 61);
  });
});
