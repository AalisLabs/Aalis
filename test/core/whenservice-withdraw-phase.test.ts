// 探针事件经真实的 declaration merging 登记，不用 as never 绕过类型面。
declare module '@aalis/core' {
  interface AalisEvents {
    '__t:probe': [];
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  EventBus,
  HookRegistry,
  type Logger,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// whenService 的 cleanup 是「对外绑定的撤回」，拆卸时走清理链的撤回段：
// 先于全部 onDispose 执行，且此时四原语登记已切断。这让「半拆状态不外露」对经枢纽服务
// 登记的条目同样成立——用户清理跑的时候，枢纽已经不会再把活派给这个 ctx。
// 契约只约束排空快照内的次序；排空期间的迟到登记仍立即执行（链的既有语义，不被分段改变）。
// ════════════════════════════════════════════════════════════

/** 最小枢纽服务：登记本在服务自己手里，退订按条目引用（与 tools / webui 页面同形） */
interface Hub {
  register(item: string, contextId: string): () => void;
  list(): string[];
}

function makeHub(): Hub {
  const items = new Map<string, string>();
  return {
    register(item, contextId) {
      items.set(item, contextId);
      return () => {
        if (items.get(item) === contextId) items.delete(item);
      };
    },
    list: () => [...items.keys()],
  };
}

const roots: Context[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose();
});

function makeRoot(): Context {
  const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => logger };
  const root = new Context({
    id: 'root',
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger,
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
  roots.push(root);
  return root;
}

describe('whenService cleanup 走撤回段', () => {
  it('cleanup 先于 onDispose 执行，与登记先后无关（close 在 flush 之前）', async () => {
    const root = makeRoot();
    root.provide('db', {});
    const order: string[] = [];
    const ctx = root.fork('p');
    ctx.onDispose(() => {
      order.push('flush:early');
    });
    ctx.whenService('db', () => () => {
      order.push('close');
    });
    ctx.onDispose(() => {
      order.push('flush:late');
    });
    await ctx.disposeAsync();
    expect(order).toEqual(['close', 'flush:late', 'flush:early']);
  });

  it('用户 onDispose 执行时，经 whenService 交出的枢纽登记与 ctx.on 的监听同为已撤回', async () => {
    const root = makeRoot();
    const hub = makeHub();
    root.provide('hub', hub);
    const ctx = root.fork('p');
    ctx.whenService<Hub>('hub', svc => svc.register('my-item', ctx.id));
    let eventCalls = 0;
    ctx.on('__t:probe', () => {
      eventCalls++;
    });
    const snapshots: string[][] = [];
    ctx.onDispose(async () => {
      await root.emit('__t:probe');
      snapshots.push(hub.list());
    });
    ctx.onDispose(async () => {
      snapshots.push(hub.list());
    });
    expect(hub.list(), '前置：登记已进枢纽').toEqual(['my-item']);
    await ctx.disposeAsync();
    expect(eventCalls, '监听已在 beforeCleanup 切断').toBe(0);
    expect(snapshots, '两个 onDispose 看到的都是已撤回的枢纽').toEqual([[], []]);
  });

  it('撤回段回调里迟到登记的 onDispose 仍立即执行（链的既有语义不被分段改变）', () => {
    const root = makeRoot();
    root.provide('svc', {});
    const ctx = root.fork('p');
    const order: string[] = [];
    ctx.onDispose(() => {
      order.push('cleanup:early');
    });
    ctx.whenService('svc', () => () => {
      order.push('withdraw:A');
    });
    ctx.whenService('svc', () => () => {
      order.push('withdraw:B');
      ctx.onDispose(() => {
        order.push('late');
      });
    });
    ctx.dispose();
    expect(order).toEqual(['withdraw:B', 'late', 'withdraw:A', 'cleanup:early']);
  });

  it('手动退订仍从链上自移除，撤回段不滞留闭包', () => {
    const root = makeRoot();
    root.provide('svc', {});
    const ctx = root.fork('p');
    const base = ctx.disposableCount;
    const off = ctx.whenService('svc', () => () => {});
    expect(ctx.disposableCount).toBeGreaterThan(base);
    off();
    expect(ctx.disposableCount).toBe(base);
  });
});
