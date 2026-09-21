// 探针事件经真实的 declaration merging 登记，不用 as never 绕过类型面。
declare module '@aalis/core' {
  interface AalisEvents {
    '__t:ws-withdraw-probe': [];
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// follow 的 cleanup 是对外绑定的撤回：拆卸时先于全部 onDispose 执行，
// 且此时四原语登记已切断。这让「半拆状态不外露」对经枢纽服务登记的条目同样成立——
// 用户清理跑的时候，枢纽已经不会再把活派给这次激活。
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

const hubDesc = defineService<Hub>('__t:ws-hub');
const ownDesc = defineService('__t:ws-own');
const depDesc = defineService<{ id: string }>('__t:ws-dep');
const svcDesc = defineService('__t:ws-wd-svc');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeApp() {
  const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => logger };
  const app = createInspectableApp({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return { app, host: app.bind({ provide, events }) };
}

describe('follow cleanup 走撤回段', () => {
  it('cleanup 先于 onDispose 执行，与登记先后无关', async () => {
    const { app, host } = makeApp();
    host.provide(svcDesc, {});
    const order: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { x: optional(svcDesc), lifecycle },
        apply({ x, lifecycle }) {
          lifecycle.onDispose(() => {
            order.push('flush:early');
          });
          x.follow(() => () => {
            order.push('close');
          });
          lifecycle.onDispose(() => {
            order.push('flush:late');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    await app.plugins.unload('p');
    expect(order).toEqual(['close', 'flush:late', 'flush:early']);
  });

  it('用户 onDispose 执行时，经 follow 交出的枢纽登记与 events.on 的监听同为已撤回', async () => {
    const { app, host } = makeApp();
    const hub = makeHub();
    host.provide(hubDesc, hub);
    let eventCalls = 0;
    const snapshots: string[][] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { hub: optional(hubDesc), events, lifecycle },
        apply({ hub: hubRef, events: ev, lifecycle }) {
          hubRef.follow(svc => svc.register('my-item', lifecycle.id));
          ev.on('__t:ws-withdraw-probe', () => {
            eventCalls++;
          });
          lifecycle.onDispose(async () => {
            await host.events.emit('__t:ws-withdraw-probe');
            snapshots.push(hub.list());
          });
          lifecycle.onDispose(async () => {
            snapshots.push(hub.list());
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    expect(hub.list(), '前置：登记已进枢纽').toEqual(['my-item']);
    await app.plugins.unload('p');
    expect(eventCalls, '监听已在 beforeCleanup 切断').toBe(0);
    expect(snapshots, '两个 onDispose 看到的都是已撤回的枢纽').toEqual([[], []]);
  });

  it('撤回段回调里迟到登记的 onDispose 仍立即执行（链的既有语义不被分段改变）', async () => {
    const { app, host } = makeApp();
    host.provide(svcDesc, {});
    const order: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { x: optional(svcDesc), lifecycle },
        apply({ x, lifecycle }) {
          lifecycle.onDispose(() => {
            order.push('cleanup:early');
          });
          x.follow(() => () => {
            order.push('withdraw');
            lifecycle.onDispose(() => {
              order.push('late');
            });
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    await app.plugins.unload('p');
    expect(order).toEqual(['withdraw', 'late', 'cleanup:early']);
  });

  it('拆卸窗口内的服务事件不引爆 cleanup：子级联摘掉提供者时，父的 cleanup 仍等到自己的撤回段', async () => {
    const { app } = makeApp();
    let ownVisibleAtCleanup: boolean | undefined;
    await app.plugin(
      definePlugin({
        name: 'parent',
        uses: { provide, lifecycle, dep: optional(depDesc), services },
        provides: [ownDesc],
        apply({ provide: pub, lifecycle, dep, services: svc }) {
          pub(ownDesc, {});
          void lifecycle.module(
            definePlugin({
              name: 'child',
              uses: { provide },
              provides: [depDesc],
              apply({ provide: childPub }) {
                childPub(depDesc, { id: 'child' });
              },
            }),
          );
          dep.follow(() => () => {
            // 撤回段跑在 beforeCleanup 之后：本激活自己 provide 的服务此刻应已下线
            ownVisibleAtCleanup = svc.get(ownDesc) !== undefined;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('parent')?.state).toBe('active');
    await app.plugins.unload('parent');
    expect(ownVisibleAtCleanup, 'cleanup 若在子级联期间被 service:unregistered 引爆，四原语尚未切断').toBe(false);
  });

  it('拆卸窗口内提供者重新上线：关闭中的激活不再挂新实例', async () => {
    const { app, host } = makeApp();
    const offDep = host.provide(depDesc, { id: 'old' });
    const attached: string[] = [];
    // 子定义必须在 apply 之外：apply 解构出的 lifecycle 会挡住描述符导入
    const child = definePlugin({
      name: 'child',
      uses: { lifecycle },
      apply({ lifecycle }) {
        lifecycle.onDispose(async () => {
          offDep();
          host.provide(depDesc, { id: 'new' });
          await new Promise(r => setTimeout(r, 10));
        });
      },
    });
    await app.plugin(
      definePlugin({
        name: 'parent',
        uses: { lifecycle, dep: optional(depDesc) },
        apply({ lifecycle, dep }) {
          dep.follow(svc => {
            attached.push(svc.id);
          });
          void lifecycle.module(child);
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('parent')?.state).toBe('active');
    await app.plugins.unload('parent');
    expect(attached).toEqual(['old']);
  });

  it('同一资源口复用一条撤回登记，手动退订的跟随者不再挂载', () => {
    const { app, host } = makeApp();
    host.provide(svcDesc, {});
    const activation = activationHost(app).create(rootActivation(app), 'p');
    const ref = activationHost(app).bind(activation, { x: optional(svcDesc) }).x;
    const base = activation.resources.lifecycle.disposables.size;
    let attached = 0;
    let cleaned = 0;
    const attach = () => {
      attached++;
      return () => {
        cleaned++;
      };
    };
    const off = ref.follow(attach);
    const afterFollow = activation.resources.lifecycle.disposables.size;
    expect(afterFollow).toBeGreaterThan(base);
    off();
    // 资源口的订阅仍在，但同步退订不得另留 follower 的链上条目
    expect(activation.resources.lifecycle.disposables.size).toBe(afterFollow);
    const off2 = ref.follow(attach);
    off2();
    expect(activation.resources.lifecycle.disposables.size, '同一口复用订阅，二次跟随不叠加条目').toBe(afterFollow);
    host.provide(svcDesc, {}, { priority: 9, entryId: 'root/new' });
    expect({ attached, cleaned }, '已退订的跟随者不得响应后续胜者变化').toEqual({ attached: 2, cleaned: 2 });
  });
});
