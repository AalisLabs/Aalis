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

describe('关停编排：兄弟 / 堂表亲 / 三层（optional 环先全 drain 再 close）', () => {
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

  it('同一父下两个子模块 optional 互用：两笔 onDrain 都写到', async () => {
    const w = world();
    const left = defineService<Store>('ck-ch-l');
    const right = defineService<Store>('ck-ch-r');
    const childL = definePlugin({
      name: 'left',
      uses: { right: optional(right), provide, lifecycle },
      provides: [left],
      apply({ right, provide, lifecycle }) {
        let closed = false;
        provide(left, {
          save(data) {
            if (closed) throw new Error('left 已关闭');
            w.saved.push(`L:${data}`);
          },
        });
        lifecycle.onDrain(() => right.require().save('left:last'));
        lifecycle.onDispose(() => {
          closed = true;
        });
      },
    });
    const childR = definePlugin({
      name: 'right',
      uses: { left: optional(left), provide, lifecycle },
      provides: [right],
      apply({ left, provide, lifecycle }) {
        let closed = false;
        provide(right, {
          save(data) {
            if (closed) throw new Error('right 已关闭');
            w.saved.push(`R:${data}`);
          },
        });
        lifecycle.onDrain(() => left.require().save('right:last'));
        lifecycle.onDispose(() => {
          closed = true;
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'parent',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(childL);
          await lifecycle.module(childR);
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('parent')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.saved.sort()).toEqual(['L:right:last', 'R:left:last']);
  });

  it('堂表亲单向：子模块用兄弟的子模块，onDrain 写得到', async () => {
    const w = world();
    const store = defineService<Store>('ck-cousin-store');
    const provider = definePlugin({
      name: 'box',
      uses: { provide, lifecycle },
      provides: [store],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(store, {
          save(data) {
            if (closed) throw new Error('box 已关闭');
            w.saved.push(data);
          },
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('box-close');
        });
      },
    });
    const consumer = definePlugin({
      name: 'writer',
      uses: { store, lifecycle },
      apply({ store, lifecycle }) {
        lifecycle.onDrain(() => {
          store.require().save('cousin:last');
          w.log.push('writer-drain');
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'left',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(provider);
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'right',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(consumer);
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.saved).toEqual(['cousin:last']);
    expect(w.log.indexOf('writer-drain')).toBeLessThan(w.log.indexOf('box-close'));
  });

  it('堂表亲 optional 互用：两笔 onDrain 都能 require 到对方', async () => {
    const w = world();
    const a = defineService<Store>('ck-cuz-a');
    const b = defineService<Store>('ck-cuz-b');
    const childA = definePlugin({
      name: 'gc-a',
      uses: { provide, lifecycle, b: optional(b) },
      provides: [a],
      apply({ provide, lifecycle, b }) {
        let closed = false;
        provide(a, {
          save(data) {
            if (closed) throw new Error('a 已关闭');
            w.saved.push(`a:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          b.require().save('from-a');
          w.log.push('a-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
        });
      },
    });
    const childB = definePlugin({
      name: 'gc-b',
      uses: { provide, lifecycle, a: optional(a) },
      provides: [b],
      apply({ provide, lifecycle, a }) {
        let closed = false;
        provide(b, {
          save(data) {
            if (closed) throw new Error('b 已关闭');
            w.saved.push(`b:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          a.require().save('from-b');
          w.log.push('b-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
        });
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'uncle',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(childA);
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'aunt',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(childB);
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.log.sort(), `saved=${w.saved.join(',')}`).toEqual(['a-drain', 'b-drain']);
    expect(w.saved.sort()).toEqual(['a:from-b', 'b:from-a']);
  });

  it('三层混合：祖用左子、左用右兄弟、右用祖，三笔 onDrain 都写到', async () => {
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
    await w.app.plugin(
      definePlugin({
        name: 'gp',
        uses: { l: optional(l), provide, lifecycle },
        provides: [g],
        async apply({ l, provide, lifecycle }) {
          provide(g, {
            save(data) {
              w.saved.push(`G:${data}`);
            },
          });
          await lifecycle.module(left);
          await lifecycle.module(right);
          lifecycle.onDrain(() => {
            l.require().save('gp:last');
            w.log.push('gp-drain');
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('gp')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.log.filter(x => x.endsWith('-drain')).sort()).toEqual(['gp-drain', 'left-drain', 'right-drain']);
    expect(w.saved.sort(), `log=${w.log.join('>')}`).toEqual(['G:right:last', 'L:gp:last', 'R:left:last']);
  });

  it('三层混合：祖用孙 + 子用祖 + 孙用叔叔，三笔 onDrain 都写到', async () => {
    const w = world();
    const leaf = defineService<Store>('ck-leaf');
    const uncleSvc = defineService<Store>('ck-uncle');
    const grandpaSvc = defineService<Store>('ck-gp');
    const grandchild = definePlugin({
      name: 'gc',
      uses: { provide, lifecycle, uncle: optional(uncleSvc), grandpa: optional(grandpaSvc) },
      provides: [leaf],
      apply({ provide, lifecycle, uncle, grandpa }) {
        let closed = false;
        provide(leaf, {
          save(data) {
            if (closed) throw new Error('gc 已关闭');
            w.saved.push(`gc:${data}`);
          },
        });
        lifecycle.onDrain(() => {
          uncle.require().save('from-gc');
          grandpa.require().save('from-gc');
          w.log.push('gc-drain');
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('gc-close');
        });
      },
    });
    const child = definePlugin({
      name: 'child',
      uses: { lifecycle, grandpa: grandpaSvc },
      async apply({ lifecycle, grandpa }) {
        await lifecycle.module(grandchild);
        lifecycle.onDrain(() => {
          grandpa.require().save('from-child');
          w.log.push('child-drain');
        });
      },
    });
    const uncle = definePlugin({
      name: 'uncle',
      uses: { provide, lifecycle },
      provides: [uncleSvc],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(uncleSvc, {
          save(data) {
            if (closed) throw new Error('uncle 已关闭');
            w.saved.push(`uncle:${data}`);
          },
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('uncle-close');
        });
      },
    });
    await w.app.plugin(uncle);
    await w.app.plugin(
      definePlugin({
        name: 'grandpa',
        uses: { provide, lifecycle, leaf: optional(leaf) },
        provides: [grandpaSvc],
        async apply({ provide, lifecycle, leaf }) {
          let closed = false;
          provide(grandpaSvc, {
            save(data) {
              if (closed) throw new Error('grandpa 已关闭');
              w.saved.push(`gp:${data}`);
            },
          });
          await lifecycle.module(child);
          lifecycle.onDrain(() => {
            leaf.require().save('from-grandpa');
            w.log.push('gp-drain');
          });
          lifecycle.onDispose(() => {
            closed = true;
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('grandpa')?.state).toBe('active');
    await w.app.stop();
    expect(cycleWarns(w.warnings), w.warnings.join(' | ')).toEqual([]);
    expect(w.log.filter(x => x.endsWith('-drain')).sort()).toEqual(['child-drain', 'gc-drain', 'gp-drain']);
    expect(w.log.indexOf('gp-drain')).toBeLessThan(w.log.indexOf('gc-close'));
    expect(w.log.indexOf('gc-drain')).toBeLessThan(w.log.indexOf('uncle-close'));
  });
});
