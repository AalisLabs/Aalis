import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, type Logger } from '../../packages/core/src/index.js';

// 管理动作只返回布尔：配置拷贝失败（环状引用、getter 或 Proxy 抛错）时本条返回 false、记 warn，
// 不让 register / registerAll / bounce / updateConfig 整个拒绝，也不留下停在 pending 的前序条目。只用公开 API。

type Rec = { level: string; message: string };
function recording(): Logger & { records: Rec[] } {
  const records: Rec[] = [];
  const at = (level: string) => (message: string) => void records.push({ level, message });
  const l = { records, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => l };
  return l;
}
const outcome = <T>(p: Promise<T>): Promise<string> =>
  p.then(
    v => `resolved:${JSON.stringify(v)}`,
    e => `rejected:${(e as Error).name}`,
  );
const cyclic = (): Record<string, unknown> => {
  const c: Record<string, unknown> = { a: 1 };
  c.self = c;
  return c;
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
async function mk(): Promise<{ app: App; log: ReturnType<typeof recording> }> {
  const log = recording();
  const app = new App({ name: 'S4', logger: log });
  apps.push(app);
  await app.plugins.idle();
  return { app, log };
}

describe('配置无法拷贝时管理动作返回 false', () => {
  it('register 一个 config.self = config 的插件：应返回 false、不抛、注册表不变', async () => {
    const { app } = await mk();
    const result = await outcome(app.plugin(definePlugin({ name: 'cyc', apply() {} }), cyclic()));
    expect({ result, registered: app.plugins.getPlugin('cyc') !== undefined }).toEqual({
      result: 'resolved:false',
      registered: false,
    });
  });

  it('registerAll 混入环状项：其余项应正常激活，返回逐项布尔', async () => {
    const { app } = await mk();
    const result = await outcome(
      app.pluginAll([
        { definition: definePlugin({ name: 'a', apply() {} }) },
        { definition: definePlugin({ name: 'cyc', apply() {} }), config: cyclic() },
        { definition: definePlugin({ name: 'b', apply() {} }) },
      ]),
    );
    await app.plugins.idle();
    expect({
      result,
      a: app.plugins.getPlugin('a')?.state,
      cyc: app.plugins.getPlugin('cyc')?.state,
      b: app.plugins.getPlugin('b')?.state,
    }).toEqual({ result: 'resolved:[true,false,true]', a: 'active', cyc: undefined, b: 'active' });
  });

  it('bounce / updateConfig 带环状 config：应返回 false、保留旧配置、实例不受影响', async () => {
    const { app } = await mk();
    let applies = 0;
    await app.plugin(definePlugin({ name: 'p', apply: () => void applies++ }), { v: 1 });
    await app.plugins.idle();
    const viaBounce = await outcome(app.plugins.bounce('p', { config: cyclic() }));
    const viaUpdate = await outcome(app.plugins.updateConfig('p', cyclic()));
    await app.plugins.idle();
    expect({
      viaBounce,
      viaUpdate,
      state: app.plugins.getPlugin('p')?.state,
      config: app.plugins.getPlugin('p')?.config,
      applies,
    }).toEqual({
      viaBounce: 'resolved:false',
      viaUpdate: 'resolved:false',
      state: 'active',
      config: { v: 1 },
      applies: 1,
    });
  });

  it('共享但无环的引用（同一对象出现两次）照常拷贝成两份', async () => {
    const { app } = await mk();
    const shared = { k: 1 };
    const ok = await app.plugin(definePlugin({ name: 'dag', apply() {} }), { x: shared, y: shared });
    await app.plugins.idle();
    const cfg = app.plugins.getPlugin('dag')?.config as { x: unknown; y: unknown };
    expect(ok).toBe(true);
    expect(cfg.x).toEqual({ k: 1 });
    expect(cfg.x).not.toBe(cfg.y);
  });

  it('getter 或 Proxy 抛错同样只让本条返回 false，旧配置不变', async () => {
    const { app } = await mk();
    const getterCfg: Record<string, unknown> = {};
    Object.defineProperty(getterCfg, 'k', {
      enumerable: true,
      get() {
        throw new Error('getter boom');
      },
    });
    const viaRegister = await outcome(app.plugin(definePlugin({ name: 'g', apply() {} }), getterCfg));
    await app.plugin(definePlugin({ name: 'h', apply() {} }), { ok: 1 });
    await app.plugins.idle();
    const proxyCfg = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys boom');
        },
      },
    ) as Record<string, unknown>;
    const viaUpdate = await outcome(app.plugins.updateConfig('h', proxyCfg));
    expect({
      viaRegister,
      gRegistered: app.plugins.getPlugin('g') !== undefined,
      viaUpdate,
      hConfig: app.plugins.getPlugin('h')?.config,
    }).toEqual({ viaRegister: 'resolved:false', gRegistered: false, viaUpdate: 'resolved:false', hConfig: { ok: 1 } });
  });
});
