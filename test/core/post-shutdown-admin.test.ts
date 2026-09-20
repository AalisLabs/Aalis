import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin } from '../../packages/core/src/index.js';

// app.stop() 之后管理动作的守卫：不抛、按现口径返回、注册表无 activating 残留、idle 落定。
// 停机后 recompute 对非 shutdown 请求早退；去掉那道早退会让新 register 试图 fork 已关闭的根激活。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function silentApp(): App {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  apps.push(app);
  return app;
}

async function idleSettles(app: App): Promise<void> {
  const settled = await Promise.race([
    app.plugins.idle().then(() => true),
    new Promise<boolean>(r => setTimeout(() => r(false), 200)),
  ]);
  expect(settled, 'idle() 必须落定').toBe(true);
}

function noActivating(app: App): void {
  expect(
    app.plugins
      .getStatus()
      .filter(s => s.state === 'activating')
      .map(s => s.instanceId),
    '注册表不得残留 activating',
  ).toEqual([]);
}

async function stoppedWithDisposed(name: string): Promise<App> {
  const app = silentApp();
  await app.plugin(definePlugin({ name, apply() {} }));
  await app.plugins.idle();
  expect(app.plugins.getPlugin(name)?.state).toBe('active');
  await app.stop();
  expect(app.plugins.getPlugin(name)?.state).toBe('disposed');
  return app;
}

describe('停机后管理动作', () => {
  it('register 新定义：不抛、落账为 pending、apply 不执行', async () => {
    const app = await stoppedWithDisposed('p');
    const log: string[] = [];
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.register(
        definePlugin({
          name: 'after-stop',
          apply() {
            log.push('after-stop.apply');
          },
        }),
      );
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, apply: log, state: app.plugins.getPlugin('after-stop')?.state }).toEqual({
      ok: true,
      threw: false,
      apply: [],
      state: 'pending',
    });
  });

  it('enable 已 disposed：不抛、返回 false，仍为 disposed', async () => {
    const app = await stoppedWithDisposed('x');
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.enable('x');
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, state: app.plugins.getPlugin('x')?.state }).toEqual({
      ok: false,
      threw: false,
      state: 'disposed',
    });
  });

  it('updateConfig 已 disposed：不抛、返回 false，仍为 disposed', async () => {
    const app = await stoppedWithDisposed('x');
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.updateConfig('x', { v: 1 });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, state: app.plugins.getPlugin('x')?.state }).toEqual({
      ok: false,
      threw: false,
      state: 'disposed',
    });
  });

  it('bounce 已 disposed：不抛、返回 false，仍为 disposed', async () => {
    const app = await stoppedWithDisposed('x');
    let threw: string | false = false;
    let ok: boolean | undefined;
    try {
      ok = await app.plugins.bounce('x');
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    await idleSettles(app);
    noActivating(app);
    expect({ ok, threw, state: app.plugins.getPlugin('x')?.state }).toEqual({
      ok: false,
      threw: false,
      state: 'disposed',
    });
  });
});
