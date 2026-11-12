import { afterEach, describe, expect, it } from 'vitest';
import { type App, defineService } from '../../packages/core/src/index.js';
import { bindActivationFixture } from '../helpers/activation.js';
import { HubRegistry, hub } from '../helpers/hub.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 两个 fork 可以用同一字符串 id：id 是逻辑身份（路由 / 显示 / 贡献键 / 偏好 / 前缀查询），
// 清理按每次激活新鲜的 owner（symbol）。拆左侧不得清右侧；拆卸在飞时同名新激活的注册
// 也不得被迟到的清理误删。公开入口不会造出同 id 的两次激活，本文件经 ActivationHost.create
// 钉内部结构。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
const mkApp = () => {
  const app = createInspectableApp({ name: 'T', logLevel: 'error' });
  apps.push(app);
  return app;
};

describe('清理身份与逻辑身份分离', () => {
  it('同名 fork：拆左不清右（服务）', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const left = bindActivationFixture(root.host, root.host.create('dup'));
    const right = bindActivationFixture(root.host, root.host.create('dup'));
    left.caps.provide.use(defineService('svc'), { who: 'L' });
    right.caps.provide.use(defineService('svc'), { who: 'R' });
    await left.activation.disposeAsync();
    expect(root.caps.services.use.all('svc')).toHaveLength(1);
    expect(root.caps.services.use.get(defineService<{ who: string }>('svc'))?.who).toBe('R');
  });

  it('同名 fork：拆左不清右（归属表登记）', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const registry = new HubRegistry();
    root.caps.provide.use(hub, registry);
    const left = bindActivationFixture(root.host, root.host.create('dup'));
    const right = bindActivationFixture(root.host, root.host.create('dup'));
    const leftHub = root.host.bind(left.activation, { hub }).hub;
    const rightHub = root.host.bind(right.activation, { hub }).hub;
    leftHub.use.add('x', 'L');
    rightHub.use.add('y', 'R');
    // 同键替换：同名兄弟登记同一局部键（全局键同为 dup/shared），后登记者顶替先登记者；左侧的迟到撤回不得删掉右侧的新占位
    leftHub.use.add('shared', 'L');
    rightHub.use.add('shared', 'R');

    await left.activation.disposeAsync();

    expect(registry.list()).toEqual(['dup/y=R', 'dup/shared=R']);
  });

  it('迟到清理不碰同名新激活：旧 ctx 拆卸在飞时新 ctx 的注册完好', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const old = bindActivationFixture(root.host, root.host.create('again'));
    old.caps.provide.use(defineService('svc'), { gen: 1 });
    // 关闭一律异步：撤注册段在 disposeAsync() 返回之后才跑，新激活赶在它之前登记
    const closing = old.activation.disposeAsync();

    const fresh = bindActivationFixture(root.host, root.host.create('again'));
    fresh.caps.provide.use(defineService('svc'), { gen: 2 });

    await closing;
    expect(
      root.caps.services.use.get(defineService<{ gen: number }>('svc'))?.gen,
      '旧 ctx 迟到的清理按 contextId 扫会把新激活的一并删掉',
    ).toBe(2);
  });

  it('经门面 provide 带 entryId 的 per-entry 子条目也盖 owner，随 dispose 一起清', async () => {
    const app = mkApp();
    const host = activationHost(app);
    const root = bindActivationFixture(host, host.root);
    const p = bindActivationFixture(root.host, root.host.create('prov'));
    p.caps.provide.use(defineService('llm'), { m: 'a' } as never, { entryId: 'prov/a' });
    p.caps.provide.use(defineService('llm'), { m: 'b' } as never, { entryId: 'prov/b' });
    expect(root.caps.services.use.all('llm')).toHaveLength(2);
    await p.activation.disposeAsync();
    expect(root.caps.services.use.all('llm')).toHaveLength(0);
  });
});
