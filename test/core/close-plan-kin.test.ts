import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
} from '../../packages/core/src/index.js';

// 父子 / 祖孙互用：父 drain 时子树仍活着；子用父由归属树保证。不得再打 optional 成环 debug。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

interface Store {
  save(data: string): void;
}
interface Sink {
  push(data: string): void;
}

function world() {
  const log: string[] = [];
  const saved: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    debug: (...a: unknown[]) => void warnings.push(`debug:${a.map(String).join(' ')}`),
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(`error:${a.map(String).join(' ')}`),
    child: () => logger,
  };
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return { app, log, saved, warnings };
}

const cycleDebug = (warnings: string[]) => warnings.filter(x => x.startsWith('debug:') && x.includes('成环'));
const cycleWarns = (warnings: string[]) => warnings.filter(x => !x.startsWith('debug:') && x.includes('成环'));

describe('关停编排：父子互用', () => {
  it('父 optional 用子：父 onDrain 写得到子，子 onDispose 晚于父 onDrain，不成环', async () => {
    const w = world();
    const store = defineService<Store>('ck-opt-store');
    const child = definePlugin({
      name: 'box',
      uses: { provide, lifecycle },
      provides: [store],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(store, {
          save(data) {
            if (closed) throw new Error('box 已关闭');
            w.saved.push(`box:${data}`);
          },
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('child-close');
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'host',
        uses: { store: optional(store), lifecycle },
        async apply({ store, lifecycle }) {
          await lifecycle.module(child);
          lifecycle.onDrain(() => {
            store.require().save('host:last');
            w.log.push('parent-drain');
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('host')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved).toEqual(['box:host:last']);
    expect(w.log.indexOf('parent-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('child-close')).toBeGreaterThan(w.log.indexOf('parent-drain'));
  });

  it('父 required 用子：父 onDrain 写得到子，子 onDispose 晚于父 onDrain，不成环', async () => {
    // 顶层 required 会在子模块 provide 之前卡住激活。先挂低优先级种子让父通过激活闸，
    // 子模块以更高优先级胜出，关停边落在父子树上。
    const w = world();
    const store = defineService<Store>('ck-req-store');
    await w.app.plugin(
      definePlugin({
        name: 'seed',
        uses: { provide },
        apply({ provide }) {
          provide(store, {
            save() {
              throw new Error('seed 不应接到交接');
            },
          });
        },
      }),
    );
    const child = definePlugin({
      name: 'box',
      uses: { provide, lifecycle },
      provides: [store],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(
          store,
          {
            save(data) {
              if (closed) throw new Error('box 已关闭');
              w.saved.push(`box:${data}`);
            },
          },
          { priority: 10 },
        );
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('child-close');
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'host',
        uses: { store, lifecycle },
        async apply({ store, lifecycle }) {
          await lifecycle.module(child);
          lifecycle.onDrain(() => {
            store.require().save('host:last');
            w.log.push('parent-drain');
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('host')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved).toEqual(['box:host:last']);
    expect(w.log.indexOf('parent-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('child-close')).toBeGreaterThan(w.log.indexOf('parent-drain'));
  });

  it('父 optional 用子且子 required 用父：两笔 onDrain 都写到，子 onDispose 晚于父 onDrain，不成环', async () => {
    const w = world();
    const store = defineService<Store>('ck-pair-store');
    const sink = defineService<Sink>('ck-pair-sink');
    const child = definePlugin({
      name: 'kid',
      uses: { sink, provide, lifecycle },
      provides: [store],
      apply({ sink, provide, lifecycle }) {
        let closed = false;
        provide(store, {
          save(data) {
            if (closed) throw new Error('kid 已关闭');
            w.saved.push(`kid:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          sink.require().push('kid:last');
          w.log.push('child-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('child-close');
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'dad',
        uses: { store: optional(store), provide, lifecycle },
        provides: [sink],
        async apply({ store, provide, lifecycle }) {
          provide(sink, {
            push(data) {
              w.saved.push(`sink:${data}`);
            },
          });
          await lifecycle.module(child);
          lifecycle.onDrain(() => {
            store.require().save('dad:last');
            w.log.push('parent-drain');
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('dad')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved.sort(), `log=${w.log.join('>')}`).toEqual(['kid:dad:last', 'sink:kid:last']);
    expect(w.log.indexOf('parent-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('child-close')).toBeGreaterThan(w.log.indexOf('parent-drain'));
  });

  it('optional 互用：两笔 onDrain 都写到，子 onDispose 晚于父 onDrain，不成环', async () => {
    const w = world();
    const store = defineService<Store>('ck-mut-store');
    const sink = defineService<Sink>('ck-mut-sink');
    const child = definePlugin({
      name: 'leaf',
      uses: { sink: optional(sink), provide, lifecycle },
      provides: [store],
      apply({ sink, provide, lifecycle }) {
        let closed = false;
        provide(store, {
          save(data) {
            if (closed) throw new Error('leaf 已关闭');
            w.saved.push(`leaf:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          sink.require().push('leaf:last');
          w.log.push('child-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('child-close');
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'rootp',
        uses: { store: optional(store), provide, lifecycle },
        provides: [sink],
        async apply({ store, provide, lifecycle }) {
          provide(sink, {
            push(data) {
              w.saved.push(`sink:${data}`);
            },
          });
          await lifecycle.module(child);
          lifecycle.onDrain(() => {
            store.require().save('rootp:last');
            w.log.push('parent-drain');
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('rootp')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved.sort(), `log=${w.log.join('>')}`).toEqual(['leaf:rootp:last', 'sink:leaf:last']);
    expect(w.log.indexOf('parent-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('child-close')).toBeGreaterThan(w.log.indexOf('parent-drain'));
  });

  it('祖孙互用：两笔交接都在，孙 onDispose 晚于祖 onDrain，不成环', async () => {
    const w = world();
    const psvc = defineService<Store>('ck-xl-p');
    const gsvc = defineService<Store>('ck-xl-g');
    const g = definePlugin({
      name: 'g',
      uses: { provide, lifecycle },
      provides: [gsvc],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(gsvc, {
          save(data) {
            if (closed) throw new Error('g 已关闭');
            w.saved.push(`g:${data}`);
          },
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('g-close');
        });
      },
    });
    const mid = definePlugin({
      name: 'mid',
      uses: { psvc, lifecycle },
      async apply({ psvc, lifecycle }) {
        await lifecycle.module(g);
        lifecycle.onDrain(() => {
          psvc.require().save('mid:last');
          w.log.push('mid-drain');
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'top',
        uses: { gsvc: optional(gsvc), provide, lifecycle },
        async apply({ gsvc, provide, lifecycle }) {
          let closed = false;
          provide(psvc, {
            save(data) {
              if (closed) throw new Error('top 已关闭');
              w.saved.push(`top:${data}`);
            },
          });
          await lifecycle.module(mid);
          lifecycle.onDrain(() => {
            gsvc.require().save('top:last');
            w.log.push('top-drain');
          });
          lifecycle.onDispose(() => {
            closed = true;
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('top')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved.sort(), `log=${w.log.join('>')}`).toEqual(['g:top:last', 'top:mid:last']);
    expect(w.log.indexOf('top-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('g-close')).toBeGreaterThan(w.log.indexOf('top-drain'));
  });
});
