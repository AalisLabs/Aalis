import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  type App,
  config,
  definePlugin,
  defineService,
  type Logger,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { createConfigStore } from '../../packages/runtime/src/config-store.js';
import { hostedApp, registerFromDoc, type TempConfigHandle, tempConfig } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// 宿主配置文档（runtime/config-store）：内存态、危险键闸、落盘委托、外部变更监听，
// 以及 installHostConfig 交给插件的 host-config（save 契约、启动偏好）。
// core 只持运行态；这些从 core 的 ConfigManager 原样迁来，语义不变。
// ════════════════════════════════════════════════════════════

const UNSAFE_IDS = ['__proto__', 'constructor', 'prototype'] as const;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function track<T extends { app: App }>(world: T): T {
  apps.push(world.app);
  return world;
}

function emptyStore() {
  return createConfigStore({ name: 'T', logLevel: 'error', plugins: {} });
}

/** JSON / YAML 把 `__proto__` 解成自有键，对象字面量做不到。 */
function poisonedSnapshot(): AalisConfig {
  return JSON.parse('{"name":"T","logLevel":"error","plugins":{},"__proto__":{"pollutedA6v":"yes"}}') as AalisConfig;
}

function expectUnpoisoned(snap: object): void {
  expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
  expect(Object.hasOwn(snap, '__proto__')).toBe(false);
  expect((snap as { pollutedA6v?: unknown }).pollutedA6v).toBeUndefined();
  expect(({} as { pollutedA6v?: unknown }).pollutedA6v).toBeUndefined();
}

function expectIllegalPluginId(run: () => unknown, id: string): void {
  expect(run).toThrow(new Error(`插件 id 不合法: ${id}`));
}

/** provider 经 watch 推送新快照的接线 */
function watched(initial: AalisConfig) {
  let push!: (next: AalisConfig) => void;
  const store = createConfigStore(initial, {
    watch(onChange) {
      push = onChange;
      return () => {};
    },
  });
  store.watch(() => {});
  return { store, push: (next: AalisConfig) => push(next) };
}

describe('配置文档（内存态）', () => {
  it('未传入字段时使用默认值', () => {
    const store = createConfigStore({});
    expect(store.get('name')).toBe('Aalis');
    expect(store.get('logLevel')).toBe('info');
    expect(store.get('plugins')).toEqual({});
    expect(store.get('disabledPlugins')).toEqual([]);
  });

  it('setPluginConfig / removePluginConfig', () => {
    const store = emptyStore();
    store.setPluginConfig('a', { x: 1 });
    expect(store.getPluginConfig('a').x).toBe(1);
    store.removePluginConfig('a');
    expect(store.getPluginConfig('a')).toEqual({});
  });

  it('isPluginDisabled / setPluginEnabled toggle', () => {
    const store = emptyStore();
    expect(store.isPluginDisabled('p')).toBe(false);
    store.setPluginEnabled('p', false);
    expect(store.isPluginDisabled('p')).toBe(true);
    store.setPluginEnabled('p', true);
    expect(store.isPluginDisabled('p')).toBe(false);
  });

  it('servicePreferences 增删', () => {
    const store = emptyStore();
    store.setServicePreference('llm', 'plugin-llm-openai');
    expect(store.getServicePreferences().llm).toBe('plugin-llm-openai');
    store.removeServicePreference('llm');
    expect(store.getServicePreferences().llm).toBeUndefined();
  });

  it('provider 推送新快照即替换当前状态', () => {
    const { store, push } = watched({ name: 'One', logLevel: 'info', plugins: {} });
    expect(store.get('name')).toBe('One');
    push({ name: 'Two', logLevel: 'info', plugins: {} });
    expect(store.get('name')).toBe('Two');
  });

  it('推送的 JSON 带 __proto__ 不得改快照原型', () => {
    const { store, push } = watched({ name: 'T', logLevel: 'error', plugins: {} });
    push(poisonedSnapshot());
    expectUnpoisoned(store.getAll());
    expect(store.get('pollutedA6v' as never)).toBeUndefined();
  });

  it('构造期外来 JSON 的 __proto__ 不得改快照原型', () => {
    expectUnpoisoned(createConfigStore(poisonedSnapshot()).getAll());
  });

  it('constructor / prototype 与 __proto__ 同一闸，不写入快照', () => {
    const input = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{},"constructor":{"prototype":{"polluted":"yes"}},"prototype":{"x":1}}',
    ) as AalisConfig;
    const snap = createConfigStore(input).getAll();
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(Object.hasOwn(snap, 'constructor')).toBe(false);
    expect(Object.hasOwn(snap, 'prototype')).toBe(false);
    expect(snap.constructor).toBe(Object);
  });

  it('未注入 provider 时 persist() 立即完成', async () => {
    await expect(emptyStore().persist()).resolves.toBeUndefined();
  });
});

describe('FsYamlConfigProvider（集成）', () => {
  let cfg: TempConfigHandle;
  afterEach(() => cfg?.cleanup());

  it('从 YAML 加载配置树', () => {
    cfg = tempConfig('name: MyApp\nlogLevel: debug\nplugins:\n  myplug:\n    apikey: literal-secret\n');
    const store = createConfigStore(cfg.config, cfg.provider);
    expect(store.get('name')).toBe('MyApp');
    expect(store.getPluginConfig('myplug').apikey, '值原样加载，不做任何替换').toBe('literal-secret');
  });

  it('persist() 原样写回字符串值（密钥直接住在 config 里，不得被改写）', async () => {
    cfg = tempConfig('name: X\nlogLevel: info\nplugins:\n  myplug:\n    token: sk-literal\n');
    const store = createConfigStore(cfg.config, cfg.provider);
    store.set('name', 'Y');
    await store.persist();
    const written = readFileSync(cfg.path, 'utf-8');
    expect(written).toMatch(/name: Y/);
    expect(written).toContain('sk-literal');
  });

  it('YAML 解析出的 __proto__ 自有键进文档时不得改原型', () => {
    cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n__proto__:\n  pollutedA6v: yes\n');
    expect(
      Object.getOwnPropertyNames(cfg.config).includes('__proto__'),
      '本用例前提：YAML 把 __proto__ 解成自有键，与 JSON.parse 同类',
    ).toBe(true);
    const store = createConfigStore(cfg.config);
    expectUnpoisoned(store.getAll());
    expect(store.get('pollutedA6v' as never)).toBeUndefined();
  });
});

describe('插件 id 走危险键闸', () => {
  it('D1 getPluginConfig("__proto__") 抛可定位错误，不得返回 Object.prototype', () => {
    const store = emptyStore();
    try {
      expectIllegalPluginId(() => store.getPluginConfig('__proto__'), '__proto__');
      expect(({} as { pollutedS5?: string }).pollutedS5).toBeUndefined();
    } finally {
      delete (Object.prototype as { pollutedS5?: string }).pollutedS5;
    }
  });

  it('D2 setPluginConfig("__proto__") 抛错且不得改 plugins 原型', () => {
    const store = emptyStore();
    expectIllegalPluginId(() => store.setPluginConfig('__proto__', { injected: 1 }), '__proto__');
    expect(Object.getPrototypeOf(store.getAll().plugins)).toBe(Object.prototype);
    expect((store.getAll().plugins as { injected?: number }).injected).toBeUndefined();
  });

  it('D3 getPluginConfig("constructor") 抛错，不得返回 Object', () => {
    expectIllegalPluginId(() => emptyStore().getPluginConfig('constructor'), 'constructor');
  });

  it('D13 三危险键在按插件 id 取放的全部方法上都抛同一文案', () => {
    const store = emptyStore();
    for (const id of UNSAFE_IDS) {
      expectIllegalPluginId(() => store.getPluginConfig(id), id);
      expectIllegalPluginId(() => store.setPluginConfig(id, { x: 1 }), id);
      expectIllegalPluginId(() => store.removePluginConfig(id), id);
      expectIllegalPluginId(() => store.isPluginDisabled(id), id);
      expectIllegalPluginId(() => store.setPluginEnabled(id, false), id);
    }
  });
});

describe('plugins 子树套闸并拷贝', () => {
  it('D4 plugins 子树 JSON __proto__ 不得作为自有键留下，Object.assign 不得改目标原型', () => {
    const poisoned = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{"p":{"ok":1,"__proto__":{"pollutedS5p":"yes"}}}}',
    );
    const pc = createConfigStore(poisoned).getPluginConfig('p');
    expect(Object.hasOwn(pc, '__proto__')).toBe(false);
    expect(pc.ok).toBe(1);
    const target: Record<string, unknown> = { keep: true };
    Object.assign(target, pc);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((Object.getPrototypeOf(target) as { pollutedS5p?: string }).pollutedS5p).toBeUndefined();
  });

  it('plugins 子树是拷贝：改传入快照不得写穿文档', () => {
    const input = JSON.parse('{"name":"T","logLevel":"error","plugins":{"p":{"ok":1,"nested":{"k":1}}}}') as {
      name: string;
      logLevel: string;
      plugins: { p: { ok: number; nested: { k: number } } };
    };
    const store = createConfigStore(input);
    input.plugins.p.ok = 9;
    input.plugins.p.nested.k = 9;
    expect(store.getPluginConfig('p')).toEqual({ ok: 1, nested: { k: 1 } });
  });

  it('plugins 字典上的危险键本身也被剥掉', () => {
    const poisoned = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{"keep":{"ok":1},"__proto__":{"injected":1},"constructor":{"x":1}}}',
    );
    const snap = createConfigStore(poisoned).getAll().plugins;
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(Object.hasOwn(snap, '__proto__')).toBe(false);
    expect(Object.hasOwn(snap, 'constructor')).toBe(false);
    expect(snap.keep).toEqual({ ok: 1 });
  });
});

describe('字典读写不落原型链', () => {
  it('getPluginConfig 对不存在的 id 返回空对象拷贝，不返回原型链值', () => {
    const store = emptyStore();
    const got = store.getPluginConfig('toString') as { leaked?: boolean };
    expect(got).toEqual({});
    expect(typeof got).not.toBe('function');
    got.leaked = true;
    expect(store.getPluginConfig('toString')).toEqual({});
  });

  it('servicePreferences 的 JSON 危险键与 set 危险键都不落账', () => {
    const poisoned = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{},"servicePreferences":{"llm":"a","__proto__":{"pollutedPref":"yes"},"constructor":"x"}}',
    );
    const store = createConfigStore(poisoned);
    const prefs = store.getServicePreferences();
    expect(Object.hasOwn(prefs, '__proto__')).toBe(false);
    expect(Object.hasOwn(prefs, 'constructor')).toBe(false);
    expect(prefs.llm).toBe('a');
    expect(Object.getPrototypeOf(prefs)).toBe(Object.prototype);

    store.setServicePreference('constructor', 'injected');
    store.setServicePreference('prototype', 'injected');
    store.setServicePreference('llm', 'plugin-llm');
    expect(Object.hasOwn(store.getServicePreferences(), 'constructor')).toBe(false);
    expect(store.getServicePreferences().llm).toBe('plugin-llm');
  });
});

describe('watch', () => {
  it('返回退订闭包；退订后 provider 侧也停表，可再次订阅', () => {
    const base = { name: 'T', logLevel: 'error', plugins: {} };
    let stopped = 0;
    let push!: (next: AalisConfig) => void;
    const store = createConfigStore(base, {
      watch: onChange => {
        push = onChange;
        return () => {
          stopped++;
        };
      },
    });
    const seen: number[] = [];
    const off = store.watch(() => seen.push(1));
    push({ ...base, name: 'T2' });
    expect(seen).toHaveLength(1);
    expect(store.get('name')).toBe('T2');
    off();
    expect(stopped).toBe(1);
    expect(() => store.watch(() => {})).not.toThrow();
  });

  it('单订阅者：已有订阅时再 watch 抛错，不静默顶替', () => {
    const store = emptyStore();
    store.watch(() => {});
    expect(() => store.watch(() => {})).toThrow('配置变更只支持一个订阅者');
  });
});

describe('host-config 的 save 契约（installHostConfig 交给插件的那一份）', () => {
  function capture() {
    const errors: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (...args: unknown[]) => void errors.push(args),
      child: () => logger,
    };
    return { errors, logger };
  }
  const docOf = (app: App) => app.bind({ hostConfig }).hostConfig.require();

  it('异步 provider：等到真正落盘才返回', async () => {
    let persisted = false;
    const { app } = track(
      hostedApp(
        {},
        {
          provider: {
            save: async () => {
              await new Promise(r => setTimeout(r, 20));
              persisted = true;
            },
          },
        },
      ),
    );
    await docOf(app).save();
    expect(persisted, '返回时持久化必须已完成').toBe(true);
  });

  it('provider 拒绝 → save 拒绝，不静默吞掉', async () => {
    const { app } = track(
      hostedApp(
        {},
        {
          provider: {
            save: async () => {
              throw new Error('disk full');
            },
          },
        },
      ),
    );
    await expect(docOf(app).save()).rejects.toThrow('disk full');
  });

  it('无 provider（内存模式）→ 立即完成', async () => {
    const { app } = track(hostedApp());
    await expect(docOf(app).save()).resolves.toBeUndefined();
  });

  it('不 await 也不 catch 的调用：同步 provider 抛错只记 error，不产生未处理拒绝', async () => {
    const { errors, logger } = capture();
    const { app } = track(
      hostedApp(
        {},
        {
          logger,
          provider: {
            save: () => {
              throw new Error('EACCES');
            },
          },
        },
      ),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      void docOf(app).save();
      // unhandledRejection 在微任务排空后的下一轮才触发，等两轮宏任务
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled, '裸调的失败不得逃成未处理拒绝').toEqual([]);
    expect(
      errors.map(args => `${String(args[0])} ${String(args[1])}`),
      '失败必须出声',
    ).toEqual(['配置保存失败: Error: EACCES']);
  });

  it('上报器自身抛错也不产生未处理拒绝；await 的调用方仍拿到原始拒绝', async () => {
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: () => {
        throw new Error('sink broken');
      },
      child: () => logger,
    };
    const { app } = track(hostedApp({}, { logger, provider: { save: () => Promise.reject(new Error('disk full')) } }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(docOf(app).save()).rejects.toThrow('disk full');
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('交给插件的只有文档读写与 save：宿主的 persist / watch / unwatch 不外露', () => {
    const { app } = track(hostedApp());
    const doc = docOf(app) as unknown as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(
      [
        'get',
        'getAll',
        'set',
        'getPluginConfig',
        'setPluginConfig',
        'removePluginConfig',
        'isPluginDisabled',
        'setPluginEnabled',
        'getServicePreferences',
        'setServicePreference',
        'removeServicePreference',
        'save',
      ].sort(),
    );
    expect(app.bind({ services }).services.inspect('host-config')).toMatchObject([
      { contextId: 'root', exclusive: true },
    ]);
  });
});

describe('启动偏好与文档的边界', () => {
  it('文档里的服务偏好在任何提供者上线前生效：后登记的低优先级提供者按偏好胜出', async () => {
    const svc = defineService<{ id: string }>('cs-pref');
    const { app } = track(hostedApp({ servicePreferences: { 'cs-pref': 'low' } }));
    const seen: string[] = [];
    await app.pluginAll(
      [
        definePlugin({
          name: 'high',
          uses: { provide },
          apply: ({ provide }) => void provide(svc, { id: 'high' }, { priority: 10 }),
        }),
        definePlugin({ name: 'low', uses: { provide }, apply: ({ provide }) => void provide(svc, { id: 'low' }) }),
        definePlugin({ name: 'consumer', uses: { svc }, apply: ({ svc }) => void seen.push(svc.require().id) }),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    expect(seen).toEqual(['low']);
  });

  it('管理动作只改运行态：disable / enable / updateConfig 之后文档与落盘次数都不变', async () => {
    let saves = 0;
    const { app, store } = track(
      hostedApp(
        { plugins: { p: { v: 1 } } },
        {
          provider: {
            save: () => {
              saves++;
            },
          },
        },
      ),
    );
    await registerFromDoc(app, store, definePlugin({ name: 'p', uses: { config }, apply() {} }));
    await app.plugins.idle();
    const before = structuredClone(store.getAll());

    expect(await app.plugins.disable('p')).toBe(true);
    expect(app.plugins.getPlugin('p')?.state).toBe('disabled');
    expect(await app.plugins.enable('p')).toBe(true);
    await app.plugins.idle();
    expect(await app.plugins.updateConfig('p', { v: 2 })).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.config).toEqual({ v: 2 });

    expect(store.getAll()).toEqual(before);
    expect(saves).toBe(0);
  });

  it('按文档登记时文档与实例配置互不别名：apply 就地改、事后改 entry.config 都不写进文档', async () => {
    const { app, store } = track(hostedApp({ plugins: { 'probe-pkg:work': { tag: 'work', nested: { k: 1 } } } }));
    const def = definePlugin({
      name: 'probe-pkg',
      reusable: true,
      uses: { config },
      apply({ config: pluginConfig }) {
        (pluginConfig as Record<string, unknown>).mutatedByApply = true;
      },
    });
    expect(await registerFromDoc(app, store, def, 'probe-pkg:work')).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('probe-pkg:work')?.state).toBe('active');
    expect(
      (store.getPluginConfig('probe-pkg:work') as { mutatedByApply?: boolean }).mutatedByApply,
      'apply 就地改不得写进文档',
    ).toBeUndefined();
    const live = app.plugins.getPlugin('probe-pkg:work')?.config as Record<string, unknown>;
    live.nested = { k: 999 };
    expect(
      (store.getPluginConfig('probe-pkg:work') as { nested?: { k: number } }).nested?.k,
      '返回后改 entry.config 不得改文档',
    ).toBe(1);
  });
});
