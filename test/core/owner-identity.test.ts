import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { rootActivation } from '../../packages/core/src/orchestration/app.js';

// ════════════════════════════════════════════════════════════
// 两个 fork 可以用同一字符串 id：id 是逻辑身份（路由 / 显示 / 贡献键 / 偏好 / 前缀查询），
// 清理按每次激活新鲜的 owner（symbol）。拆左侧不得清右侧；拆卸在飞时同名新激活的注册
// 也不得被迟到的清理误删。公开入口不会造出同 id 的两次激活，本文件经 rootActivation.fork
// 钉内部结构。
// ════════════════════════════════════════════════════════════

const HOOK = '__t:owner-hook' as never;
const POINT = '__t:owner-point' as never;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
const mkApp = () => {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  apps.push(app);
  return app;
};

describe('清理身份与逻辑身份分离', () => {
  it('同名 fork：拆左不清右（服务）', () => {
    const app = mkApp();
    const root = rootActivation(app);
    const left = root.fork('dup');
    const right = root.fork('dup');
    left.provide('svc', { who: 'L' });
    right.provide('svc', { who: 'R' });
    left.dispose();
    expect(root.getAllServices('svc')).toHaveLength(1);
    expect(root.getService<{ who: string }>('svc')?.who).toBe('R');
  });

  it('同名 fork：拆左不清右（监听 / 中间件 / 贡献）', async () => {
    const app = mkApp();
    const root = rootActivation(app);
    const left = root.fork('dup');
    const right = root.fork('dup');
    const seen: string[] = [];
    // 事件用真名（同 events-context-cut 的先例）：自造名会让 emit 的 rest 参数推成 never
    left.on('plugin:loaded', () => {
      seen.push('L-evt');
    });
    right.on('plugin:loaded', () => {
      seen.push('R-evt');
    });
    left.middleware(HOOK, async (_d, next) => {
      seen.push('L-mw');
      await next();
    });
    right.middleware(HOOK, async (_d, next) => {
      seen.push('R-mw');
      await next();
    });
    left.contribute(POINT, { id: 'x' } as never);
    right.contribute(POINT, { id: 'y' } as never);
    // 同键替换：同名兄弟贡献同一 id，后注册者顶替先注册者；左侧的迟到清理不得删掉右侧的新占位
    left.contribute(POINT, { id: 'shared', who: 'L' } as never);
    const rShared = { id: 'shared', who: 'R' };
    right.contribute(POINT, rShared as never);

    left.dispose();

    await root.emit('plugin:loaded', 'x');
    await root.runHook(HOOK, {} as never);
    expect(seen).toEqual(['R-evt', 'R-mw']);
    // 全局键码元序 'dup/shared' < 'dup/y'
    expect(root.collect(POINT).map(h => h.spec)).toEqual([rShared, { id: 'y' }]);
  });

  it('迟到清理不碰同名新激活：旧 ctx 拆卸在飞时新 ctx 的注册完好', async () => {
    const app = mkApp();
    const root = rootActivation(app);
    const old = root.fork('again');
    old.provide('svc', { gen: 1 });
    // 用子 ctx 的慢清理把旧 ctx 的撤注册段推到 await 之后——否则 beforeCleanup 在
    // disposeAsync() 返回前就同步跑完，新旧实现都绿，用例没有鉴别力。
    let release!: () => void;
    old.fork('again-kid').onDispose(
      () =>
        new Promise<void>(r => {
          release = r;
        }),
    );
    const closing = old.disposeAsync();

    const fresh = root.fork('again');
    fresh.provide('svc', { gen: 2 });

    release();
    await closing;
    expect(root.getService<{ gen: number }>('svc')?.gen, '旧 ctx 迟到的清理按 contextId 扫会把新激活的一并删掉').toBe(
      2,
    );
  });

  it('经门面 provide 带 entryId 的 per-entry 子条目也盖 owner，随 dispose 一起清', () => {
    const app = mkApp();
    const root = rootActivation(app);
    const p = root.fork('prov');
    p.provide('llm', { m: 'a' } as never, { entryId: 'prov/a' });
    p.provide('llm', { m: 'b' } as never, { entryId: 'prov/b' });
    expect(root.getAllServices('llm')).toHaveLength(2);
    p.dispose();
    expect(root.getAllServices('llm')).toHaveLength(0);
  });
});

describe('监听登记按次计身份：同一函数对象不因共享而互相误清', () => {
  it('两个 Context 用同一函数订阅同一事件：拆左不清右，左的手动退订也不清右', async () => {
    const app = mkApp();
    const root = rootActivation(app);
    const calls: string[] = [];
    function shared() {
      calls.push('hit');
    }
    const left = root.fork('l');
    const right = root.fork('r');
    const offLeft = left.on('plugin:loaded', shared);
    left.on('plugin:loaded', shared); // 左的第二条只随拆卸清，让下面的拆卸断言有鉴别力
    right.on('plugin:loaded', shared);

    offLeft();
    await root.emit('plugin:loaded', 'p');
    expect(calls, '退订只移除自己那条').toEqual(['hit', 'hit']);

    left.dispose();
    await root.emit('plugin:loaded', 'p');
    expect(calls, '左拆卸后右的登记仍在').toEqual(['hit', 'hit', 'hit']);

    right.dispose();
    await root.emit('plugin:loaded', 'p');
    expect(calls, '右拆卸后才真正没人听').toEqual(['hit', 'hit', 'hit']);
  });
});
