import { afterEach, describe, expect, it } from 'vitest';
import { App, config, definePlugin, type Logger } from '../../packages/core/src/index.js';

// 管理动作只返回布尔：配置拷贝失败（环状引用、getter 或 Proxy 抛错）时本条返回 false、记 warn，
// 不让 register / registerAll / bounce / updateConfig 整个拒绝，也不留下停在 pending 的前序条目。只用公开 API。

type Rec = { level: string; message: string };
function recording(): Logger & { records: Rec[] } {
  const records: Rec[] = [];
  // 错误作附加参数交来：连同参数记下，拒因才看得到
  const at =
    (level: string) =>
    (message: string, ...args: unknown[]) =>
      void records.push({
        level,
        message: [message, ...args.map(a => (a instanceof Error ? a.message : String(a)))].join(' '),
      });
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

  it('updateConfig 带环状 config：应返回 false、保留旧配置、实例不受影响', async () => {
    const { app } = await mk();
    let applies = 0;
    await app.plugin(definePlugin({ name: 'p', apply: () => void applies++ }), { v: 1 });
    await app.plugins.idle();
    const viaUpdate = await outcome(app.plugins.updateConfig('p', cyclic()));
    await app.plugins.idle();
    expect({
      viaUpdate,
      state: app.plugins.getPlugin('p')?.state,
      config: app.plugins.getPlugin('p')?.config,
      applies,
    }).toEqual({
      viaUpdate: 'resolved:false',
      state: 'active',
      config: { v: 1 },
      applies: 1,
    });
  });

  it('共享但无环的引用（同一对象出现两次）照常拷贝成两份', async () => {
    const { app } = await mk();
    const shared = { k: 1 };
    const row = [1, 2];
    const ok = await app.plugin(definePlugin({ name: 'dag', apply() {} }), { x: shared, y: shared, rows: [row, row] });
    await app.plugins.idle();
    const cfg = app.plugins.getPlugin('dag')?.config as { x: unknown; y: unknown; rows: unknown[] };
    expect(ok).toBe(true);
    expect(cfg.x).toEqual({ k: 1 });
    expect(cfg.x).not.toBe(cfg.y);
    expect(cfg.rows).toEqual([row, row]);
    expect(cfg.rows[0]).not.toBe(cfg.rows[1]);
  });

  it('数组里的环同样拒收；拒因写明是环状引用，不靠调用栈溢出', async () => {
    const { app, log } = await mk();
    const loop: unknown[] = [];
    loop.push(loop);
    const viaArray = await app.plugin(definePlugin({ name: 'arr', apply() {} }), { loop });
    const viaObject = await app.plugin(definePlugin({ name: 'obj', apply() {} }), cyclic());
    expect({ viaArray, viaObject }).toEqual({ viaArray: false, viaObject: false });
    expect(log.records.filter(r => r.message.includes('环状引用'))).toHaveLength(2);
    expect(log.records.some(r => r.message.includes('call stack'))).toBe(false);
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

describe('配置不是纯对象：register 与 updateConfig 一样拒收', () => {
  // 「没给配置」在接口上只有不传一种写法（即 {}）。null 多半是上游出错，当 {} 会让插件按默认值悄悄启动；
  // 数组、原始值、类实例会被拷成 {"0": …} 之类改了形的对象。都拒收，本条返回 false 并记一笔
  class Cfg {
    a = 1;
  }
  const shapes: Array<[string, unknown]> = [
    ['null', null],
    ['空数组', []],
    ['数组', [1, 2]],
    ['字符串', 'ab'],
    ['数字', 5],
    ['类实例', new Cfg()],
  ];

  it.each(shapes)('%s：register 返回 false、不登记，error 点名插件', async (_, config) => {
    const { app, log } = await mk();
    const ok = await app.plugin(definePlugin({ name: 'shape', apply() {} }), config as Record<string, unknown>);
    expect({ ok, registered: app.plugins.getPlugin('shape') !== undefined }).toEqual({ ok: false, registered: false });
    expect(
      log.records.some(r => r.level === 'error' && r.message.includes('"shape"') && r.message.includes('纯对象')),
    ).toBe(true);
  });

  it.each(shapes)('%s：updateConfig 返回 false、保留旧配置，warn 点名插件', async (_, config) => {
    const { app, log } = await mk();
    await app.plugin(definePlugin({ name: 'shape', apply() {} }), { v: 1 });
    await app.plugins.idle();
    const ok = await app.plugins.updateConfig('shape', config as Record<string, unknown>);
    expect({ ok, config: app.plugins.getPlugin('shape')?.config }).toEqual({ ok: false, config: { v: 1 } });
    expect(
      log.records.some(r => r.level === 'warn' && r.message.includes('"shape"') && r.message.includes('纯对象')),
    ).toBe(true);
  });

  it('不传配置即 {}', async () => {
    const { app } = await mk();
    expect(await app.plugin(definePlugin({ name: 'none', apply() {} }))).toBe(true);
    expect(app.plugins.getPlugin('none')?.config).toEqual({});
  });
});

describe('登记收下的是拷贝', () => {
  it('登记后调用方改它的配置对象：重启后的 config.use 与 getPlugin 仍是登记时的值', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const seen: unknown[] = [];
    const cfg = { a: 1, nested: { list: [[1]] } };
    await app.plugin(
      definePlugin({
        name: 'cfg-owner',
        uses: { config },
        apply: ({ config }) => void seen.push(structuredClone(config.use)),
      }),
      cfg,
    );
    await app.plugins.idle();
    cfg.a = 2;
    cfg.nested.list[0].push(9);
    await app.plugins.bounce('cfg-owner');
    await app.plugins.idle();
    const registered = { a: 1, nested: { list: [[1]] } };
    expect(seen).toEqual([registered, registered]);
    expect(app.plugins.getPlugin('cfg-owner')?.config).toEqual(registered);
  });
});
