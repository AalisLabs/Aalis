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

// 父子互用：父（根绑定）drain 时子插件仍活着；子用父由归属树保证。不得再打 optional 成环 debug。

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
  const app = new App({ name: 'T', logLevel: 'error', logger });
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
    const parent = w.app.bind({ store: optional(store), lifecycle });
    await w.app.plugin(child);
    parent.lifecycle.onDrain(() => {
      parent.store.require().save('host:last');
      w.log.push('parent-drain');
    });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('box')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved).toEqual(['box:host:last']);
    expect(w.log.indexOf('parent-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('child-close')).toBeGreaterThan(w.log.indexOf('parent-drain'));
  });

  it('父 required 用子：父 onDrain 写得到子，子 onDispose 晚于父 onDrain，不成环', async () => {
    const w = world();
    const store = defineService<Store>('ck-req-store');
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
    const parent = w.app.bind({ store, lifecycle });
    await w.app.plugin(child);
    parent.lifecycle.onDrain(() => {
      parent.store.require().save('host:last');
      w.log.push('parent-drain');
    });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('box')?.state).toBe('active');
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
    const parent = w.app.bind({ store: optional(store), provide, lifecycle });
    parent.provide(sink, {
      push(data) {
        w.saved.push(`sink:${data}`);
      },
    });
    await w.app.plugin(child);
    parent.lifecycle.onDrain(() => {
      parent.store.require().save('dad:last');
      w.log.push('parent-drain');
    });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('kid')?.state).toBe('active');
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
    const parent = w.app.bind({ store: optional(store), provide, lifecycle });
    parent.provide(sink, {
      push(data) {
        w.saved.push(`sink:${data}`);
      },
    });
    await w.app.plugin(child);
    parent.lifecycle.onDrain(() => {
      parent.store.require().save('rootp:last');
      w.log.push('parent-drain');
    });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('leaf')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(cycleDebug(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved.sort(), `log=${w.log.join('>')}`).toEqual(['leaf:rootp:last', 'sink:leaf:last']);
    expect(w.log.indexOf('parent-drain')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('child-close')).toBeGreaterThan(w.log.indexOf('parent-drain'));
  });
});

describe('关停编排：兄弟 / 根与兄弟混合（optional 环先全 drain 再 close）', () => {
  it('兄弟顶层 optional 互用：两笔 onDrain 都能 require 到对方', async () => {
    const w = world();
    const a = defineService<Store>('ck-sib-a');
    const b = defineService<Store>('ck-sib-b');
    await w.app.plugin(
      definePlugin({
        name: 'alpha',
        uses: { b: optional(b), provide, lifecycle },
        provides: [a],
        apply({ b, provide, lifecycle }) {
          let closed = false;
          provide(a, {
            save(data) {
              if (closed) throw new Error('alpha 已关闭');
              w.saved.push(`a:${data}`);
            },
          });
          lifecycle.onDrain(() => {
            b.require().save('alpha:last');
            w.log.push('alpha-drain');
          });
          lifecycle.onDispose(() => {
            closed = true;
          });
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'beta',
        uses: { a: optional(a), provide, lifecycle },
        provides: [b],
        apply({ a, provide, lifecycle }) {
          let closed = false;
          provide(b, {
            save(data) {
              if (closed) throw new Error('beta 已关闭');
              w.saved.push(`b:${data}`);
            },
          });
          lifecycle.onDrain(() => {
            a.require().save('beta:last');
            w.log.push('beta-drain');
          });
          lifecycle.onDispose(() => {
            closed = true;
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('alpha')?.state).toBe('active');
    expect(w.app.plugins.getPlugin('beta')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.log.sort(), `saved=${w.saved.join(',')}`).toEqual(['alpha-drain', 'beta-drain']);
    expect(w.saved.sort()).toEqual(['a:beta:last', 'b:alpha:last']);
  });

  it('根与兄弟混合：根用左、左用右兄弟、右用根，三笔 onDrain 都写到', async () => {
    const w = world();
    const g = defineService<Store>('ck-3-g');
    const l = defineService<Store>('ck-3-l');
    const r = defineService<Store>('ck-3-r');
    const left = definePlugin({
      name: 'left',
      uses: { r: optional(r), provide, lifecycle },
      provides: [l],
      apply({ r, provide, lifecycle }) {
        let closed = false;
        provide(l, {
          save(data) {
            if (closed) throw new Error('left 已关闭');
            w.saved.push(`L:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          r.require().save('left:last');
          w.log.push('left-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
        });
      },
    });
    const right = definePlugin({
      name: 'right',
      uses: { g, provide, lifecycle },
      provides: [r],
      apply({ g, provide, lifecycle }) {
        let closed = false;
        provide(r, {
          save(data) {
            if (closed) throw new Error('right 已关闭');
            w.saved.push(`R:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          g.require().save('right:last');
          w.log.push('right-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
        });
      },
    });
    const root = w.app.bind({ l: optional(l), provide, lifecycle });
    root.provide(g, {
      save(data) {
        w.saved.push(`G:${data}`);
      },
    });
    await w.app.plugin(left);
    await w.app.plugin(right);
    root.lifecycle.onDrain(() => {
      root.l.require().save('root:last');
      w.log.push('root-drain');
    });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('left')?.state).toBe('active');
    expect(w.app.plugins.getPlugin('right')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.log.filter(x => x.endsWith('-drain')).sort()).toEqual(['left-drain', 'right-drain', 'root-drain']);
    expect(w.saved.sort(), `log=${w.log.join('>')}`).toEqual(['G:right:last', 'L:root:last', 'R:left:last']);
  });
});
