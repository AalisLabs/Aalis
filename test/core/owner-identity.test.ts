import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 评估 C3（core-evaluation-20260915/composition-contracts）：两个 fork 用同一字符串 id，销毁左侧
// 会移除仍未 disposed 的右侧服务/钩子/贡献/监听。根因：四个注册表按 contextId 字符串归属清理。
// 刀 4 给每次激活一个新鲜的 owner（symbol），清理按它；contextId 保留为逻辑身份（路由 / 显示 /
// 贡献键 / 偏好 / 前缀查询）。本文件把评估探针从「断言现状缺口」翻成「断言目标行为」。
// ════════════════════════════════════════════════════════════

const HOOK = '__t:owner-hook' as never;
const POINT = '__t:owner-point' as never;

const mkApp = () => new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });

describe('清理身份与逻辑身份分离', () => {
  it('同名 fork：拆左不清右（服务）', () => {
    const app = mkApp();
    const left = app.ctx.fork('dup');
    const right = app.ctx.fork('dup');
    left.provide('svc', { who: 'L' });
    right.provide('svc', { who: 'R' });
    left.dispose();
    expect(app.ctx.getAllServices('svc')).toHaveLength(1);
    expect(app.ctx.getService<{ who: string }>('svc')?.who).toBe('R');
  });

  it('同名 fork：拆左不清右（监听 / 中间件 / 贡献）', async () => {
    const app = mkApp();
    const left = app.ctx.fork('dup');
    const right = app.ctx.fork('dup');
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

    await app.ctx.emit('plugin:loaded', 'x');
    await app.ctx.runHook(HOOK, {} as never);
    expect(seen).toEqual(['R-evt', 'R-mw']);
    // 全局键码元序 'dup/shared' < 'dup/y'
    expect(app.ctx.collect(POINT).map(h => h.spec)).toEqual([rShared, { id: 'y' }]);
  });

  it('迟到清理不碰同名新激活：旧 ctx 拆卸在飞时新 ctx 的注册完好', async () => {
    const app = mkApp();
    const old = app.ctx.fork('again');
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

    const fresh = app.ctx.fork('again');
    fresh.provide('svc', { gen: 2 });

    release();
    await closing;
    expect(
      app.ctx.getService<{ gen: number }>('svc')?.gen,
      '旧 ctx 迟到的清理按 contextId 扫会把新激活的一并删掉',
    ).toBe(2);
  });

  it('经门面 provide 带 entryId 的 per-entry 子条目也盖 owner，随 dispose 一起清', () => {
    const app = mkApp();
    const p = app.ctx.fork('prov');
    p.provide('llm', { m: 'a' } as never, { entryId: 'prov/a' });
    p.provide('llm', { m: 'b' } as never, { entryId: 'prov/b' });
    expect(app.ctx.getAllServices('llm')).toHaveLength(2);
    p.dispose();
    expect(app.ctx.getAllServices('llm')).toHaveLength(0);
  });
});

describe('监听登记按次计身份：同一函数对象不因共享而互相误清', () => {
  it('两个 Context 用同一函数订阅同一事件：拆左不清右，左的手动退订也不清右', async () => {
    const app = mkApp();
    const calls: string[] = [];
    function shared() {
      calls.push('hit');
    }
    const left = app.ctx.fork('l');
    const right = app.ctx.fork('r');
    const offLeft = left.on('plugin:loaded', shared);
    left.on('plugin:loaded', shared); // 左的第二条只随拆卸清，让下面的拆卸断言有鉴别力
    right.on('plugin:loaded', shared);

    offLeft();
    await app.ctx.emit('plugin:loaded', 'p');
    expect(calls, '退订只移除自己那条').toEqual(['hit', 'hit']);

    left.dispose();
    await app.ctx.emit('plugin:loaded', 'p');
    expect(calls, '左拆卸后右的登记仍在').toEqual(['hit', 'hit', 'hit']);

    right.dispose();
    await app.ctx.emit('plugin:loaded', 'p');
    expect(calls, '右拆卸后才真正没人听').toEqual(['hit', 'hit', 'hit']);
  });
});
