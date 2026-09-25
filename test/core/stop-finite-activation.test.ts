import { describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  provide,
  services,
} from '../../packages/core/src/index.js';
import type { PluginRecord } from '../../packages/core/src/orchestration/plugin-activation.js';
import { deferred } from '../helpers/deferred.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('有限 apply 与停机接管', () => {
  it.each([
    'resolve',
    'reject',
  ] as const)('apply %s 后让位给停机计划，资源清理完成且后续 pending 不再启动', async result => {
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
    const app = new App({ name: 'T', logLevel: 'error', logger, disposeTimeoutMs: 0 });
    const gate = deferred();
    const entered = deferred();
    const owned = defineService<{ live: Set<string> }>('finite-activation-owned');
    const live = new Set<string>();
    let cleanups = 0;
    let stopCompleted = false;
    let pendingRan = false;
    const registering = app.plugin(
      definePlugin({
        name: 'finite',
        uses: { provide, lifecycle },
        provides: [owned],
        async apply({ provide, lifecycle }) {
          live.add('resource');
          provide(owned, { live });
          lifecycle.onDispose(async () => {
            await Promise.resolve();
            cleanups++;
            live.clear();
          });
          entered.resolve();
          await gate.promise;
        },
      }),
    );
    await entered.promise;
    await app.plugin(
      definePlugin({
        name: 'next',
        apply() {
          pendingRan = true;
        },
      }),
    );
    expect(app.plugins.getPlugin('finite')?.state).toBe('activating');
    expect(app.plugins.getPlugin('next')?.state).toBe('pending');
    const lookup = app.bind({ services }).services;
    expect(lookup.get(owned.name)).toBeDefined();
    const stopping = app.stop().then(() => {
      stopCompleted = true;
    });
    try {
      await tick();
      expect(stopCompleted).toBe(false);
      if (result === 'resolve') gate.resolve();
      else gate.reject(new Error('finite apply rejected'));
      // apply 与 cleanup 的剩余工作都只是微任务；一个事件循环回合后必须已经收敛。
      await tick();
      expect(stopCompleted, 'apply 已落定，停机不得与激活失败清理互等').toBe(true);
      await stopping;
      await registering;
      expect(cleanups).toBe(1);
      expect([...live]).toEqual([]);
      expect(lookup.get(owned.name)).toBeUndefined();
      expect(pendingRan).toBe(false);
      const entry = app.plugins.getPlugin('finite') as PluginRecord;
      expect(entry.state).toBe('disposed');
      expect(entry.activation).toBeUndefined();
      expect((app.plugins.getPlugin('next') as PluginRecord).activation).toBeUndefined();
    } finally {
      gate.resolve();
      // 负向实现会自等已冻结的计划。仅在反例失败时释放测试持有的完成信号，
      // 让正常 stop 编排继续清资源；测试本身不能留下悬置 flight 或借超时假绿。
      if (!stopCompleted) {
        const manager = app.plugins as unknown as { shutdownSettle?: Map<unknown, () => void> };
        for (const settle of manager.shutdownSettle?.values() ?? []) settle();
      }
      await Promise.allSettled([registering, stopping]);
    }
  });
});
