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

interface Provider {
  id: string;
}

const roots: Context[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose();
});

function makeWorld() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: message => warnings.push(message),
    error: () => {},
    child: () => logger,
  };
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
  for (const id of ['a', 'b', 'c']) root.fork(id).provide('svc', { id });
  const watcher = root.fork('watcher');
  const trace: string[] = [];
  const live = new Set<string>();
  const released: string[] = [];
  let serial = 0;
  const attach = (provider: Provider) => {
    const key = `${provider.id}:${++serial}`;
    trace.push(`attach:${key}`);
    live.add(key);
    return () => {
      trace.push(`cleanup:${key}`);
      released.push(key);
      live.delete(key);
    };
  };
  return { root, watcher, trace, live, released, attach, warnings };
}

describe('whenService 重入时的资源归属', () => {
  it('挂载 A 时切到 B：先释放 A，再保留 B 的清理句柄', () => {
    const { root, watcher, trace, live, released, attach } = makeWorld();
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      if (provider.id === 'a') root.preferService('svc', 'b');
      return cleanup;
    });

    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:b:2']);
    expect([...live]).toEqual(['b:2']);
    off();
    off();
    expect([...live]).toEqual([]);
    expect(released).toEqual(['a:1', 'b:2']);
    expect(watcher.disposableCount).toBe(0);
  });

  it('A → B → A：同一个 provider 的不同挂载不能相互覆盖清理句柄', () => {
    const { root, watcher, trace, live, released, attach } = makeWorld();
    let transitions = 0;
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      if (transitions++ < 2) root.preferService('svc', provider.id === 'a' ? 'b' : 'a');
      return cleanup;
    });

    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:b:2', 'cleanup:b:2', 'attach:a:3']);
    expect([...live]).toEqual(['a:3']);
    off();
    expect(released).toEqual(['a:1', 'b:2', 'a:3']);
    expect([...live]).toEqual([]);
  });

  it.each(['a', 'c'])('cleanup 将胜者从 B 改为 %s：只清一次并重读最终胜者', target => {
    const { root, watcher, trace, live, released, attach } = makeWorld();
    let redirected = false;
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      return () => {
        cleanup();
        if (provider.id === 'a' && !redirected) {
          redirected = true;
          root.preferService('svc', target);
        }
      };
    });

    root.preferService('svc', 'b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', `attach:${target}:2`]);
    expect([...live]).toEqual([`${target}:2`]);
    off();
    expect(released).toEqual(['a:1', `${target}:2`]);
    expect([...live]).toEqual([]);
  });

  it('首挂回调同步销毁 Context：停止跟随，并立即清理回调随后返回的资源', () => {
    const { root, watcher, trace, live, released, attach } = makeWorld();
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      watcher.dispose();
      root.preferService('svc', 'b');
      return cleanup;
    });

    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1']);
    expect([...live]).toEqual([]);
    expect(watcher.disposableCount).toBe(0);
    off();
    root.preferService('svc', 'c');
    expect(released).toEqual(['a:1']);
  });

  it('重挂回调退订：本次回调的 cleanup 不会遗失，也不会再挂后续胜者', () => {
    const { root, watcher, trace, live, released, attach } = makeWorld();
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      if (provider.id === 'b') {
        off();
        root.preferService('svc', 'c');
      }
      return cleanup;
    });

    root.preferService('svc', 'b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:b:2', 'cleanup:b:2']);
    expect([...live]).toEqual([]);
    expect(released).toEqual(['a:1', 'b:2']);
    expect(watcher.disposableCount).toBe(0);
  });

  it('cleanup 内退订：不会重入旧 cleanup，也不会继续挂载', () => {
    const { root, watcher, trace, live, released, attach } = makeWorld();
    let stopped = false;
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      return () => {
        cleanup();
        if (!stopped) {
          stopped = true;
          off();
          root.preferService('svc', 'c');
        }
      };
    });

    root.preferService('svc', 'b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1']);
    expect(released).toEqual(['a:1']);
    expect([...live]).toEqual([]);
    expect(watcher.disposableCount).toBe(0);
  });

  it('回调切换胜者后抛错：仍能对齐新胜者，错误只警告一次', () => {
    const { root, watcher, live, attach, warnings } = makeWorld();
    const off = watcher.whenService<Provider>('svc', provider => {
      if (provider.id === 'a') {
        root.preferService('svc', 'b');
        throw new Error('failed setup');
      }
      return attach(provider);
    });

    expect([...live]).toEqual(['b:1']);
    expect(warnings.filter(message => message.includes('回调抛错'))).toHaveLength(1);
    root.preferService('svc', 'c');
    expect([...live]).toEqual(['c:2']);
    off();
    expect([...live]).toEqual([]);
  });

  it('cleanup 切换胜者后抛错：错误不阻止挂载最终胜者', () => {
    const { root, watcher, trace, live, attach, warnings } = makeWorld();
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      return () => {
        cleanup();
        if (provider.id === 'a') {
          root.preferService('svc', 'c');
          throw new Error('failed cleanup');
        }
      };
    });

    root.preferService('svc', 'b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:c:2']);
    expect([...live]).toEqual(['c:2']);
    expect(warnings.filter(message => message.includes('cleanup 抛错'))).toHaveLength(1);
    off();
    expect([...live]).toEqual([]);
  });

  it('挂载时发生无关服务或败者的变化：不重复挂载当前胜者', () => {
    const { root, watcher, trace, live, attach } = makeWorld();
    const off = watcher.whenService<Provider>('svc', provider => {
      const cleanup = attach(provider);
      const other = root.fork('other');
      other.provide('unrelated', {});
      const removeLoser = other.provide('svc', { id: 'loser' }, { priority: -1 });
      removeLoser();
      return cleanup;
    });

    expect(trace).toEqual(['attach:a:1']);
    expect([...live]).toEqual(['a:1']);
    off();
    expect([...live]).toEqual([]);
  });

  it('有限长切换链不递归调用挂载回调，每次释放后才进入下一次挂载', () => {
    const { root, watcher, live, released, attach } = makeWorld();
    let remaining = 200;
    let depth = 0;
    let maxDepth = 0;
    const off = watcher.whenService<Provider>('svc', provider => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      const cleanup = attach(provider);
      if (remaining-- > 0) root.preferService('svc', provider.id === 'a' ? 'b' : 'a');
      depth--;
      return cleanup;
    });

    expect(maxDepth).toBe(1);
    expect([...live]).toEqual(['a:201']);
    off();
    expect(released).toHaveLength(201);
    expect(new Set(released).size).toBe(201);
    expect([...live]).toEqual([]);
  });
});
