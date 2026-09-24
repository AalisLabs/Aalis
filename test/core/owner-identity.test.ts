import { afterEach, describe, expect, it } from 'vitest';
import { type App, defineService } from '../../packages/core/src/index.js';
import { bindActivationFixture } from '../helpers/activation.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 两个 fork 可以用同一字符串 id：id 是逻辑身份（路由 / 显示 / 贡献键 / 偏好 / 前缀查询），
// 清理按每次激活新鲜的 owner（symbol）。拆左侧不得清右侧；拆卸在飞时同名新激活的注册
// 也不得被迟到的清理误删。公开入口不会造出同 id 的两次激活，本文件经 ActivationHost.create
// 钉内部结构。
// ════════════════════════════════════════════════════════════

const HOOK = '__t:owner-hook' as never;
const POINT = '__t:owner-point' as never;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
const mkApp = () => {
  const app = createInspectableApp({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  apps.push(app);
  return app;
};

describe('清理身份与逻辑身份分离', () => {
  it('同名 fork：拆左不清右（服务）', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const left = bindActivationFixture(root.host, root.host.create(root.activation, 'dup'));
    const right = bindActivationFixture(root.host, root.host.create(root.activation, 'dup'));
    left.caps.provide(defineService('svc'), { who: 'L' });
    right.caps.provide(defineService('svc'), { who: 'R' });
    await left.activation.disposeAsync();
    expect(root.caps.services.all('svc')).toHaveLength(1);
    expect(root.caps.services.get(defineService<{ who: string }>('svc'))?.who).toBe('R');
  });

  it('同名 fork：拆左不清右（监听 / 中间件 / 贡献）', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const left = bindActivationFixture(root.host, root.host.create(root.activation, 'dup'));
    const right = bindActivationFixture(root.host, root.host.create(root.activation, 'dup'));
    const seen: string[] = [];
    // 事件用真名（同 events-context-cut 的先例）：自造名会让 emit 的 rest 参数推成 never
    left.caps.events.on('plugin:loaded', () => {
      seen.push('L-evt');
    });
    right.caps.events.on('plugin:loaded', () => {
      seen.push('R-evt');
    });
    left.caps.hooks.middleware(HOOK, async (_d, next) => {
      seen.push('L-mw');
      await next();
    });
    right.caps.hooks.middleware(HOOK, async (_d, next) => {
      seen.push('R-mw');
      await next();
    });
    left.caps.contributions.contribute(POINT, { id: 'x' } as never);
    right.caps.contributions.contribute(POINT, { id: 'y' } as never);
    // 同键替换：同名兄弟贡献同一 id，后注册者顶替先注册者；左侧的迟到清理不得删掉右侧的新占位
    left.caps.contributions.contribute(POINT, { id: 'shared', who: 'L' } as never);
    const rShared = { id: 'shared', who: 'R' };
    right.caps.contributions.contribute(POINT, rShared as never);

    await left.activation.disposeAsync();

    await root.caps.events.emit('plugin:loaded', 'x');
    await root.caps.hooks.run(HOOK, {} as never);
    expect(seen).toEqual(['R-evt', 'R-mw']);
    // 全局键码元序 'dup/shared' < 'dup/y'
    expect(root.caps.contributions.collect(POINT).map(h => h.spec)).toEqual([rShared, { id: 'y' }]);
  });

  it('迟到清理不碰同名新激活：旧 ctx 拆卸在飞时新 ctx 的注册完好', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const old = bindActivationFixture(root.host, root.host.create(root.activation, 'again'));
    old.caps.provide(defineService('svc'), { gen: 1 });
    // 用子 ctx 的慢清理把旧 ctx 的撤注册段推到 await 之后——否则 beforeCleanup 在
    // disposeAsync() 返回前就同步跑完，新旧实现都绿，用例没有鉴别力。
    let release!: () => void;
    bindActivationFixture(old.host, old.host.create(old.activation, 'again-kid')).caps.lifecycle.onDispose(
      () =>
        new Promise<void>(r => {
          release = r;
        }),
    );
    const closing = old.activation.disposeAsync();

    const fresh = bindActivationFixture(root.host, root.host.create(root.activation, 'again'));
    fresh.caps.provide(defineService('svc'), { gen: 2 });

    release();
    await closing;
    expect(
      root.caps.services.get(defineService<{ gen: number }>('svc'))?.gen,
      '旧 ctx 迟到的清理按 contextId 扫会把新激活的一并删掉',
    ).toBe(2);
  });

  it('经门面 provide 带 entryId 的 per-entry 子条目也盖 owner，随 dispose 一起清', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const p = bindActivationFixture(root.host, root.host.create(root.activation, 'prov'));
    p.caps.provide(defineService('llm'), { m: 'a' } as never, { entryId: 'prov/a' });
    p.caps.provide(defineService('llm'), { m: 'b' } as never, { entryId: 'prov/b' });
    expect(root.caps.services.all('llm')).toHaveLength(2);
    await p.activation.disposeAsync();
    expect(root.caps.services.all('llm')).toHaveLength(0);
  });
});

describe('监听登记按次计身份：同一函数对象不因共享而互相误清', () => {
  it('两个激活用同一函数订阅同一事件：拆左不清右，左的手动退订也不清右', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const calls: string[] = [];
    function shared() {
      calls.push('hit');
    }
    const left = bindActivationFixture(root.host, root.host.create(root.activation, 'l'));
    const right = bindActivationFixture(root.host, root.host.create(root.activation, 'r'));
    const offLeft = left.caps.events.on('plugin:loaded', shared);
    left.caps.events.on('plugin:loaded', shared); // 左的第二条只随拆卸清，让下面的拆卸断言有鉴别力
    right.caps.events.on('plugin:loaded', shared);

    offLeft();
    await root.caps.events.emit('plugin:loaded', 'p');
    expect(calls, '退订只移除自己那条').toEqual(['hit', 'hit']);

    await left.activation.disposeAsync();
    await root.caps.events.emit('plugin:loaded', 'p');
    expect(calls, '左拆卸后右的登记仍在').toEqual(['hit', 'hit', 'hit']);

    await right.activation.disposeAsync();
    await root.caps.events.emit('plugin:loaded', 'p');
    expect(calls, '右拆卸后才真正没人听').toEqual(['hit', 'hit', 'hit']);
  });
});
