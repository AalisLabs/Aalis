import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
  type ServiceRef,
  services,
} from '../../packages/core/src/index.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

interface Provider {
  id: string;
}

const svc = defineService<Provider>('__t:ws-re');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeWorld() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, extra) => warnings.push(extra instanceof Error ? `${message} ${extra.message}` : String(message)),
    error: () => {},
    child: () => logger,
  };
  const app = createInspectableApp({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  const host = app.bind({ provide, services });
  for (const id of ['a', 'b', 'c']) host.provide(svc, { id }, { entryId: `root/${id}` });
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
  return { app, host, trace, live, released, attach, warnings };
}

async function watch(app: App, follow: (ref: ServiceRef<Provider>) => void) {
  await app.plugin(
    definePlugin({
      name: 'watcher',
      uses: { x: optional(svc) },
      apply({ x }) {
        follow(x);
      },
    }),
  );
  await app.plugins.idle();
  expect(app.plugins.getPlugin('watcher')?.state).toBe('active');
}

describe('follow 重入时的资源归属', () => {
  it('挂载 A 时切到 B：先释放 A，再保留 B 的清理句柄', async () => {
    const { app, host, trace, live, released, attach } = makeWorld();
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        if (provider.id === 'a') host.services.prefer(svc, 'root/b');
        return cleanup;
      });
    });

    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:b:2']);
    expect([...live]).toEqual(['b:2']);
    off();
    off();
    expect([...live]).toEqual([]);
    expect(released).toEqual(['a:1', 'b:2']);
  });

  it('A → B → A：同一个 provider 的不同挂载不能相互覆盖清理句柄', async () => {
    const { app, host, trace, live, released, attach } = makeWorld();
    let transitions = 0;
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        if (transitions++ < 2) host.services.prefer(svc, provider.id === 'a' ? 'root/b' : 'root/a');
        return cleanup;
      });
    });

    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:b:2', 'cleanup:b:2', 'attach:a:3']);
    expect([...live]).toEqual(['a:3']);
    off();
    expect(released).toEqual(['a:1', 'b:2', 'a:3']);
    expect([...live]).toEqual([]);
  });

  it.each(['a', 'c'])('cleanup 将胜者从 B 改为 %s：只清一次并重读最终胜者', async target => {
    const { app, host, trace, live, released, attach } = makeWorld();
    let redirected = false;
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        return () => {
          cleanup();
          if (provider.id === 'a' && !redirected) {
            redirected = true;
            host.services.prefer(svc, `root/${target}`);
          }
        };
      });
    });

    host.services.prefer(svc, 'root/b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', `attach:${target}:2`]);
    expect([...live]).toEqual([`${target}:2`]);
    off();
    expect(released).toEqual(['a:1', `${target}:2`]);
    expect([...live]).toEqual([]);
  });

  it('首挂回调同栈关闭激活：停止跟随，并立即清理回调随后返回的资源', async () => {
    const { app, host, trace, live, released, attach } = makeWorld();
    // 公开的 lifecycle 没有关闭入口：要在 attach 同栈发起关闭，只能拿内部激活记录。
    // disposeAsync 同栈置关闭位并发起清理，以下同步断言即落在关闭发起之后、完成之前
    const activation = activationHost(app).create(rootActivation(app), 'watcher');
    const ref = activationHost(app).bind(activation, { x: optional(svc) }).x;
    let closing!: Promise<void>;
    const off = ref.follow(provider => {
      const cleanup = attach(provider);
      closing = activation.disposeAsync();
      host.services.prefer(svc, 'root/b');
      return cleanup;
    });

    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1']);
    expect([...live]).toEqual([]);
    expect(activation.resources.lifecycle.disposables.size).toBe(0);
    off();
    host.services.prefer(svc, 'root/c');
    expect(released).toEqual(['a:1']);
    await closing;
  });

  it('重挂回调退订：本次回调的 cleanup 不会遗失，也不会再挂后续胜者', async () => {
    const { app, host, trace, live, released, attach } = makeWorld();
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        if (provider.id === 'b') {
          off();
          host.services.prefer(svc, 'root/c');
        }
        return cleanup;
      });
    });

    host.services.prefer(svc, 'root/b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:b:2', 'cleanup:b:2']);
    expect([...live]).toEqual([]);
    expect(released).toEqual(['a:1', 'b:2']);
  });

  it('cleanup 内退订：不会重入旧 cleanup，也不会继续挂载', async () => {
    const { app, host, trace, live, released, attach } = makeWorld();
    let stopped = false;
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        return () => {
          cleanup();
          if (!stopped) {
            stopped = true;
            off();
            host.services.prefer(svc, 'root/c');
          }
        };
      });
    });

    host.services.prefer(svc, 'root/b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1']);
    expect(released).toEqual(['a:1']);
    expect([...live]).toEqual([]);
  });

  it('回调切换胜者后抛错：仍能对齐新胜者，错误只警告一次', async () => {
    const { app, host, live, attach, warnings } = makeWorld();
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        if (provider.id === 'a') {
          host.services.prefer(svc, 'root/b');
          throw new Error('failed setup');
        }
        return attach(provider);
      });
    });

    expect([...live]).toEqual(['b:1']);
    expect(warnings.filter(message => message.includes('跟随回调抛错'))).toHaveLength(1);
    host.services.prefer(svc, 'root/c');
    expect([...live]).toEqual(['c:2']);
    off();
    expect([...live]).toEqual([]);
  });

  it('cleanup 切换胜者后抛错：错误不阻止挂载最终胜者', async () => {
    const { app, host, trace, live, attach, warnings } = makeWorld();
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        return () => {
          cleanup();
          if (provider.id === 'a') {
            host.services.prefer(svc, 'root/c');
            throw new Error('failed cleanup');
          }
        };
      });
    });

    host.services.prefer(svc, 'root/b');
    expect(trace).toEqual(['attach:a:1', 'cleanup:a:1', 'attach:c:2']);
    expect([...live]).toEqual(['c:2']);
    expect(warnings.filter(message => message.includes('撤回抛错'))).toHaveLength(1);
    off();
    expect([...live]).toEqual([]);
  });

  it('挂载时发生无关服务或败者的变化：不重复挂载当前胜者', async () => {
    const { app, host, trace, live, attach } = makeWorld();
    const unrelated = defineService('__t:ws-re-unrelated');
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        const cleanup = attach(provider);
        host.provide(unrelated, {});
        const removeLoser = host.provide(svc, { id: 'loser' }, { priority: -1, entryId: 'root/loser' });
        removeLoser();
        return cleanup;
      });
    });

    expect(trace).toEqual(['attach:a:1']);
    expect([...live]).toEqual(['a:1']);
    off();
    expect([...live]).toEqual([]);
  });

  it('有限长切换链不递归调用挂载回调，每次释放后才进入下一次挂载', async () => {
    const { app, host, live, released, attach } = makeWorld();
    let remaining = 200;
    let depth = 0;
    let maxDepth = 0;
    let off!: () => void;
    await watch(app, x => {
      off = x.follow(provider => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        const cleanup = attach(provider);
        if (remaining-- > 0) host.services.prefer(svc, provider.id === 'a' ? 'root/b' : 'root/a');
        depth--;
        return cleanup;
      });
    });

    expect(maxDepth).toBe(1);
    expect([...live]).toEqual(['a:201']);
    off();
    expect(released).toHaveLength(201);
    expect(new Set(released).size).toBe(201);
    expect([...live]).toEqual([]);
  });
});
