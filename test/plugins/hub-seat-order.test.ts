import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Events, events } from '../../packages/api-events/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { App, definePlugin, defineService, provide } from '../../packages/core/src/index.js';
import { Bus } from '../../packages/plugin-events/src/index.js';
import { Registry } from '../../packages/plugin-hooks/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 钩子链与事件监听跨插件按登记方的位次排，与同优先级的服务提供者同一条规则：宿主的根最前，插件按实例 id 的码元序，
// 同一登记方的几条按登记先后。不看登记发生的时刻：插件重启、插件加进应用的先后都不改变次序。
// 事件名 'zz:plain' 经 declaration merging 登记在 test/fixtures/zz-events.ts。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const HOOK = 'zz:seat';

/** 在钩子与事件上各登记 tags 里的每一条：执行时往 trail 记自己的名字 */
function member(name: string, trail: string[], tags: string[] = [name]) {
  return definePlugin({
    name,
    reusable: true,
    uses: { hooks, events },
    apply({ hooks, events }) {
      for (const tag of tags) {
        hooks.use.middleware(
          HOOK as never,
          (async (_data: unknown, next: () => Promise<void>) => {
            trail.push(tag);
            await next();
          }) as never,
        );
        events.use.on('zz:plain', () => void trail.push(tag));
      }
    },
  });
}

async function world() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ hooks, events });
  const trail: string[] = [];
  const ran = async (kind: 'hooks' | 'events'): Promise<string[]> => {
    trail.length = 0;
    if (kind === 'hooks') await host.hooks.use.run(HOOK as never, {} as never);
    else await host.events.use.emit('zz:plain');
    return [...trail];
  };
  return { app, host, trail, ran };
}

describe.each(['hooks', 'events'] as const)('%s：跨插件按登记方的位次排', kind => {
  /** 经一个根绑定的业务句柄登记一条：执行时往 trail 记 tag */
  const mark = (use: Hooks | Events, trail: string[], tag: string) =>
    kind === 'hooks'
      ? (use as Hooks).middleware(
          HOOK as never,
          (async (_data: unknown, next: () => Promise<void>) => {
            trail.push(tag);
            await next();
          }) as never,
        )
      : (use as Events).on('zz:plain', () => void trail.push(tag));

  it('插件重启之后，它的登记仍在原来的位置', async () => {
    const { app, trail, ran } = await world();
    await app.pluginAll([{ definition: member('a', trail) }, { definition: member('b', trail) }]);
    await app.plugins.idle();
    expect(await ran(kind)).toEqual(['a', 'b']);
    await app.plugins.bounce('a');
    await app.plugins.idle();
    expect(await ran(kind)).toEqual(['a', 'b']);
  });

  it('不看加进应用的先后：后登记的插件 id 在前，它的登记就在前', async () => {
    const { app, trail, ran } = await world();
    await app.plugin(member('b', trail));
    await app.plugin(member('a', trail));
    await app.plugins.idle();
    expect(await ran(kind)).toEqual(['a', 'b']);
  });

  it('宿主的根登记的排在所有插件之前，哪怕登记得更晚', async () => {
    const { app, host, trail, ran } = await world();
    await app.plugin(member('a', trail));
    await app.plugins.idle();
    mark(host[kind].use, trail, 'host');
    expect(await ran(kind)).toEqual(['host', 'a']);
  });

  it('同一个登记方经两份契约包登记：仍按登记先后（登记序全进程共用一个计数器）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-api-copy-'));
    try {
      // 第二个模块实例：同一份源码换个路径导入，与第一份共用同一份 core
      copyFileSync(join(import.meta.dirname, `../../packages/api-${kind}/src/index.ts`), join(dir, 'index.ts'));
      const second = (await import(join(dir, 'index.ts'))) as { hooks: typeof hooks; events: typeof events };
      expect(second[kind]).not.toBe({ hooks, events }[kind]);

      const { app, host, trail, ran } = await world();
      const other = app.bind({ hub: second[kind] as typeof hooks | typeof events });
      for (const tag of ['a1', 'a2', 'a3']) mark(host[kind].use, trail, tag);
      mark(other.hub.use, trail, 'b1');
      mark(host[kind].use, trail, 'a4');
      expect(await ran(kind)).toEqual(['a1', 'a2', 'a3', 'b1', 'a4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一个插件的几条按登记先后；后缀实例按完整的实例 id 排', async () => {
    const { app, trail, ran } = await world();
    await app.plugin(member('p', trail, ['p2-x', 'p2-a']), {}, 'p:2');
    await app.plugin(member('p', trail, ['main']));
    await app.plugin(member('k', trail, ['k-z', 'k-b']));
    await app.plugins.idle();
    expect(await ran(kind)).toEqual(['k-z', 'k-b', 'main', 'p2-x', 'p2-a']);
  });
});

describe('提供者按（位次，登记序）排', () => {
  it('Registry：位次先于登记序；位次按码元序比，不看语言环境', async () => {
    const registry = new Registry();
    const trail: string[] = [];
    const mw = (tag: string) => async (_data: unknown, next: () => Promise<void>) => {
      trail.push(tag);
      await next();
    };
    registry.register(HOOK, mw('b#1'), 'b', 1, 'b');
    registry.register(HOOK, mw('a#3'), 'a', 3, 'a');
    registry.register(HOOK, mw('B#4'), 'B', 4, 'B');
    registry.register(HOOK, mw('a#2'), 'a', 2, 'a');
    registry.register(HOOK, mw('root#9'), 'root', 9, '');
    await registry.run(HOOK, {});
    expect(trail).toEqual(['root#9', 'B#4', 'a#2', 'a#3', 'b#1']);
  });

  it('Bus：同上', async () => {
    const bus = new Bus();
    const trail: string[] = [];
    bus.on('zz', () => void trail.push('b#1'), 'b', 1, 'b');
    bus.on('zz', () => void trail.push('a#3'), 'a', 3, 'a');
    bus.on('zz', () => void trail.push('B#4'), 'B', 4, 'B');
    bus.on('zz', () => void trail.push('a#2'), 'a', 2, 'a');
    bus.on('zz', () => void trail.push('root#9'), 'root', 9, '');
    await bus.emit('zz');
    expect(trail).toEqual(['root#9', 'B#4', 'a#2', 'a#3', 'b#1']);
  });
});

describe('绑定口的 seat', () => {
  it('根激活是空串，插件激活是它的实例 id', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const seats = defineService<object, { seat: string }>('zz-seat-probe', port => ({ seat: port.seat }));
    const host = app.bind({ provide, seats });
    host.provide.use(seats, {});
    expect(host.seats.use.seat).toBe('');
    const seen: string[] = [];
    const probe = definePlugin({
      name: 'zz-probe',
      reusable: true,
      uses: { seats },
      apply: ({ seats }) => void seen.push(seats.use.seat),
    });
    await app.plugin(probe);
    await app.plugin(probe, {}, 'zz-probe:2');
    await app.plugins.idle();
    expect(seen).toEqual(['zz-probe', 'zz-probe:2']);
  });
});
