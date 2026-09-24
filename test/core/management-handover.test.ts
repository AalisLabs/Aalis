import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, lifecycle, optional, provide } from '../../packages/core/src/index.js';

// 关停顺序覆盖管理动作：unload / disable / bounce 提供者时，正在用它的 required 依赖方先收尾再关，
// 提供者之后；判据是依赖方此刻解析到的胜者属于要走的激活，所以空档里不切到后备。
// 下线通知在提供者清理之前发出，跟随者交接落定后提供者才关。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const app = new App({ config: { name: 't', logLevel: 'error', plugins: {} }, devMode: false });
  apps.push(app);
  return app;
}

const M = defineService<{ gen: string }>('t:handover:mem');

function memPlugin(log: string[], name: string, priority = 0) {
  return definePlugin({
    name,
    provides: [M],
    uses: { provide, lifecycle },
    apply({ provide, lifecycle }) {
      provide(M, { gen: name }, { priority });
      lifecycle.onDrain(() => void log.push(`${name} drain`));
      lifecycle.onDispose(() => void log.push(`${name} dispose`));
    },
  });
}

describe('管理动作下依赖方先收尾、提供者后关', () => {
  async function scenario(action: 'bounce' | 'unload' | 'disable', target: string, twoProviders = false) {
    const app = world();
    const log: string[] = [];
    await app.plugin(memPlugin(log, 'mem', 10));
    if (twoProviders) await app.plugin(memPlugin(log, 'mem2'));
    let applies = 0;
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { m: M, lifecycle },
        apply({ m, lifecycle }) {
          applies++;
          seen.push(m.require().gen);
          lifecycle.onDrain(() => void log.push(`consumer drain sees ${m.current?.gen ?? 'NONE'}`));
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins[action](target);
    await app.plugins.idle();
    return { log, applies, seen, state: app.plugins.getPlugin('consumer')?.state };
  }

  for (const action of ['bounce', 'unload', 'disable'] as const) {
    it(`${action}(提供者)：依赖方先收尾且还能用到它`, async () => {
      const { log, applies, state } = await scenario(action, 'mem');
      expect(log.slice(0, 3)).toEqual(['consumer drain sees mem', 'mem drain', 'mem dispose']);
      if (action === 'bounce') {
        expect(state).toBe('active');
        expect(applies).toBe(2);
      } else {
        expect(state).toBe('pending');
      }
    });
  }

  it('bounce 首选提供者：有后备时依赖方也随首选走，空档里不切到后备，重启后回到首选', async () => {
    const { log, applies, seen, state } = await scenario('bounce', 'mem', true);
    expect(log.slice(0, 2)).toEqual(['consumer drain sees mem', 'mem drain']);
    expect(state).toBe('active');
    expect(applies).toBe(2);
    expect(seen).toEqual(['mem', 'mem']);
  });

  it('要走的不是依赖方正在用的提供者：依赖方不动', async () => {
    const { log, applies, state } = await scenario('unload', 'mem2', true);
    expect(log).toEqual(['mem2 drain', 'mem2 dispose']);
    expect(state).toBe('active');
    expect(applies).toBe(1);
  });

  it('多级 required 下游同批先收尾：每一级收尾时自己的依赖仍在；bounce 时整条链各重启一次', async () => {
    const names = ['storage', 'memory', 'session-manager', 'agent'] as const;
    const svc = Object.fromEntries(names.map(n => [n, defineService<{ name: string }>(`t:handover:${n}`)])) as Record<
      (typeof names)[number],
      ReturnType<typeof defineService<{ name: string }>>
    >;
    // 链头 storage 依赖根提供的服务：根不会离开，只为让四个定义同形
    const ROOT = defineService<{ name: string }>('t:handover:root');
    const applies: Record<string, number> = {};
    const drains: string[] = [];
    const mk = (name: (typeof names)[number], dep: typeof ROOT) =>
      definePlugin({
        name,
        provides: [svc[name]],
        uses: { provide, lifecycle, dep },
        apply({ provide, lifecycle, dep }) {
          applies[name]++;
          provide(svc[name], { name });
          lifecycle.onDrain(() => void drains.push(`${name} sees ${dep.current?.name ?? 'NONE'}`));
        },
      });
    const run = async (action: 'unload' | 'bounce') => {
      const app = world();
      app.bind({ provide }).provide(ROOT, { name: 'root' });
      for (const n of names) applies[n] = 0;
      drains.length = 0;
      for (const d of [
        mk('agent', svc['session-manager']),
        mk('memory', svc.storage),
        mk('session-manager', svc.memory),
        mk('storage', ROOT),
      ])
        await app.plugin(d);
      await app.plugins.idle();
      for (const n of names) applies[n] = 0;
      await app.plugins[action]('storage');
      await app.plugins.idle();
      return app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`);
    };
    const expectedDrains = [
      'agent sees session-manager',
      'session-manager sees memory',
      'memory sees storage',
      'storage sees root',
    ];

    const states = await run('unload');
    expect(drains).toEqual(expectedDrains);
    expect(states.sort()).toEqual(['agent:pending', 'memory:pending', 'session-manager:pending']);

    await run('bounce');
    expect(drains).toEqual(expectedDrains);
    expect(applies).toEqual({ storage: 1, memory: 1, 'session-manager': 1, agent: 1 });
  });
});

describe('下线通知在提供者清理之前，跟随者交接落定后提供者才关', () => {
  it('optional 跟随者的异步清理在提供者 onDispose 之前完成，清理期间提供者仍活着', async () => {
    const app = world();
    const S = defineService<{ alive: boolean }>('t:handover:s');
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        provides: [S],
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          const instance = { alive: true };
          provide(S, instance);
          lifecycle.onDispose(() => {
            instance.alive = false;
            log.push('p dispose');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'follower',
        uses: { s: optional(S) },
        apply({ s }) {
          s.follow(instance => () => {
            log.push(`cleanup start alive=${instance.alive}`);
            return new Promise<void>(r => setTimeout(r, 10)).then(
              () => void log.push(`cleanup end alive=${instance.alive}`),
            );
          });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('p');
    expect(log).toEqual(['cleanup start alive=true', 'cleanup end alive=true', 'p dispose']);
    expect(app.plugins.getPlugin('follower')?.state).toBe('active');
  });
});
