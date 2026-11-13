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

/** 提供者的实现：清理之后 alive 为 false，跟随方的清理据此看自己打到的是不是还活着的提供者 */
interface Impl {
  alive: boolean;
}
const upstream = defineService<Impl>('follow-order-upstream');
const peer = defineService<Impl>('follow-order-peer');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const apps: App[] = [];
function world() {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ logLevel: 'error', logger });
  apps.push(app);
  return app;
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 提供 upstream 的插件：onDispose 里把实现标成已清理 */
function provider(trace: string[]) {
  return definePlugin({
    name: 'p',
    uses: { provide, lifecycle },
    provides: [upstream],
    apply({ provide, lifecycle }) {
      const impl: Impl = { alive: true };
      provide.use(upstream, impl);
      lifecycle.use.onDispose(() => {
        impl.alive = false;
        trace.push('p 清理');
      });
    },
  });
}

/** 以 optional 依赖跟随 upstream 的下游：跟随的清理记下那一刻提供者的实现是否还活着 */
function follower(trace: string[], drain?: () => Promise<void>) {
  return definePlugin({
    name: 'c',
    uses: { upstream: optional(upstream), lifecycle },
    apply({ upstream, lifecycle }) {
      upstream.follow(impl => () => void trace.push(`c 的跟随清理（提供者${impl.alive ? '还在' : '已清理'}）`));
      if (drain) lifecycle.use.onDrain(drain);
    },
  });
}

describe('跟随的清理先于提供者自己的清理', () => {
  it('同一拍里先卸提供者、再卸跟随它的下游', async () => {
    const app = world();
    const trace: string[] = [];
    await app.plugin(provider(trace));
    await app.plugin(follower(trace));
    await Promise.all([app.plugins.unload('p'), app.plugins.unload('c')]);
    expect(trace).toEqual(['c 的跟随清理（提供者还在）', 'p 清理']);
  });

  it('同上，下游的收尾还要跨一圈事件循环', async () => {
    const app = world();
    const trace: string[] = [];
    await app.plugin(provider(trace));
    await app.plugin(follower(trace, tick));
    await Promise.all([app.plugins.unload('p'), app.plugins.unload('c')]);
    expect(trace).toEqual(['c 的跟随清理（提供者还在）', 'p 清理']);
  });

  it('先卸下游、再卸提供者：次序照旧', async () => {
    const app = world();
    const trace: string[] = [];
    await app.plugin(provider(trace));
    await app.plugin(follower(trace, tick));
    await Promise.all([app.plugins.unload('c'), app.plugins.unload('p')]);
    expect(trace).toEqual(['c 的跟随清理（提供者还在）', 'p 清理']);
  });

  it('互相跟随的两个插件一起停机：两边跟随的清理都赶在对方清理之前', async () => {
    const app = world();
    const trace: string[] = [];
    const mutual = (name: string, mine: typeof upstream, theirs: typeof upstream) =>
      definePlugin({
        name,
        uses: { provide, lifecycle, other: optional(theirs) },
        provides: [mine],
        apply({ provide, lifecycle, other }) {
          const impl: Impl = { alive: true };
          provide.use(mine, impl);
          other.follow(
            theirImpl => () => void trace.push(`${name} 的跟随清理（对方${theirImpl.alive ? '还在' : '已清理'}）`),
          );
          lifecycle.use.onDispose(() => {
            impl.alive = false;
          });
        },
      });
    await app.plugin(mutual('a', upstream, peer));
    await app.plugin(mutual('b', peer, upstream));
    await app.plugins.idle();
    await app.stop();
    expect([...trace].sort()).toEqual(['a 的跟随清理（对方还在）', 'b 的跟随清理（对方还在）']);
  });
});
