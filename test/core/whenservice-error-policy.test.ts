import { describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// whenService 统一错误政策：cb 抛错 = warn + 订阅保持，两条到达路径同一策略。
//
// 修前的双政策：首挂（注册时服务已在场，sync 同步调用）抛错会逃逸出
// whenService 调用——复合 disposer 未入链未返回，留下「订阅活着、无人
// 持有退订」的半注册态；重挂（服务事件路径）抛错则被 EventBus 按
// per-handler 隔离吞掉。同一原语两套下场。
// ════════════════════════════════════════════════════════════

function makeWorld() {
  const lines: string[] = [];
  const logger = {
    warn: (m: unknown, e?: unknown) => {
      lines.push(`warn|${String(m)} ${e instanceof Error ? e.message : ''}`);
    },
    debug: () => {},
    info: () => {},
    error: () => {},
    child: () => logger,
  } as never;
  const deps = {
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger,
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  };
  const make = (id: string) => new Context({ id, ...deps });
  return { make, lines };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('whenService 统一错误政策', () => {
  it('首挂抛错：不逃逸出注册调用、返回可用 disposer、warn 点名、订阅保持', async () => {
    const { make, lines } = makeWorld();
    const provider = make('provider');
    provider.provide('svc', { v: 1 });
    const watcher = make('watcher');

    let calls = 0;
    let off!: () => void;
    expect(() => {
      off = watcher.whenService('svc', () => {
        calls++;
        if (calls === 1) throw new Error('首挂爆炸');
      });
    }).not.toThrow();
    expect(off).toBeTypeOf('function');
    expect(lines.find(l => l.includes("whenService('svc') 回调抛错"))).toMatch(/^warn\|/);

    // 订阅保持：胜者变更后 cb 再次被调用（半注册态下这里永远不会发生）
    provider.dispose();
    const provider2 = make('provider2');
    provider2.provide('svc', { v: 2 });
    await flush();
    expect(calls).toBe(2);

    expect(() => off()).not.toThrow();
    watcher.dispose();
    provider2.dispose();
  });

  it('重挂抛错：与首挂同一条 warn 文案，订阅保持', async () => {
    const { make, lines } = makeWorld();
    const watcher = make('watcher');
    let calls = 0;
    watcher.whenService('late-svc', () => {
      calls++;
      throw new Error('重挂爆炸');
    });
    expect(calls).toBe(0);

    const provider = make('provider');
    provider.provide('late-svc', { v: 1 });
    await flush();
    expect(calls).toBe(1);
    expect(lines.filter(l => l.includes("whenService('late-svc') 回调抛错"))).toHaveLength(1);
    watcher.dispose();
    provider.dispose();
  });

  it('成功路径回归：cleanup 在胜者变更与 dispose 时照常执行', async () => {
    const { make } = makeWorld();
    const provider = make('provider');
    provider.provide('ok-svc', { v: 1 });
    const watcher = make('watcher');
    const seen: string[] = [];
    watcher.whenService('ok-svc', svc => {
      seen.push(`attach:${(svc as { v: number }).v}`);
      return () => {
        seen.push('cleanup');
      };
    });
    expect(seen).toEqual(['attach:1']);
    watcher.dispose();
    expect(seen).toEqual(['attach:1', 'cleanup']);
    provider.dispose();
  });
});
