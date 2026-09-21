/**
 * 插件 id 与 plugins 子树的危险键闸：id 不得当普通对象键落到原型链；
 * JSON 解出的 plugins 子树要过同一闸并拷贝；register 入参与 ConfigManager 不得别名。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { App, ConfigManager, config, definePlugin } from '../../packages/core/src/index.js';

const UNSAFE_IDS = ['__proto__', 'constructor', 'prototype'] as const;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function emptyCfg(): ConfigManager {
  return new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
}

function expectIllegalPluginId(run: () => unknown, id: string): void {
  expect(run).toThrow(new Error(`插件 id 不合法: ${id}`));
}

describe('ConfigManager：插件 id 走危险键闸', () => {
  it('D1 getPluginConfig("__proto__") 抛可定位错误，不得返回 Object.prototype', () => {
    const cfg = emptyCfg();
    try {
      expectIllegalPluginId(() => cfg.getPluginConfig('__proto__'), '__proto__');
      expect(({} as { pollutedS5?: string }).pollutedS5).toBeUndefined();
    } finally {
      delete (Object.prototype as { pollutedS5?: string }).pollutedS5;
    }
  });

  it('D2 setPluginConfig("__proto__") 抛错且不得改 plugins 原型', () => {
    const cfg = emptyCfg();
    expectIllegalPluginId(() => cfg.setPluginConfig('__proto__', { injected: 1 }), '__proto__');
    expect(Object.getPrototypeOf(cfg.getAll().plugins)).toBe(Object.prototype);
    expect((cfg.getAll().plugins as { injected?: number }).injected).toBeUndefined();
  });

  it('D3 getPluginConfig("constructor") 抛错，不得返回 Object', () => {
    const cfg = emptyCfg();
    expectIllegalPluginId(() => cfg.getPluginConfig('constructor'), 'constructor');
  });

  it('D13 三危险键在按插件 id 取放的全部方法上都抛同一文案', () => {
    const cfg = emptyCfg();
    for (const id of UNSAFE_IDS) {
      expectIllegalPluginId(() => cfg.getPluginConfig(id), id);
      expectIllegalPluginId(() => cfg.setPluginConfig(id, { x: 1 }), id);
      expectIllegalPluginId(() => cfg.removePluginConfig(id), id);
      expectIllegalPluginId(() => cfg.isPluginDisabled(id), id);
      expectIllegalPluginId(() => cfg.setPluginEnabled(id, false), id);
    }
  });

  it('app.plugin 以 __proto__ 为 name 时不得改 plugins 原型', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    await expect(app.plugin(definePlugin({ name: '__proto__', apply() {} }))).rejects.toThrow(
      new Error('插件 id 不合法: __proto__'),
    );
    expect(Object.getPrototypeOf(app.config.getAll().plugins)).toBe(Object.prototype);
  });
});

describe('mergeDefaultsConfig：plugins 子树套闸并拷贝', () => {
  it('D4 plugins 子树 JSON __proto__ 不得作为自有键留下，Object.assign 不得改目标原型', () => {
    const poisoned = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{"p":{"ok":1,"__proto__":{"pollutedS5p":"yes"}}}}',
    );
    const pc = new ConfigManager(poisoned).getPluginConfig('p');
    expect(Object.hasOwn(pc, '__proto__')).toBe(false);
    expect(pc.ok).toBe(1);
    const target: Record<string, unknown> = { keep: true };
    Object.assign(target, pc);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((Object.getPrototypeOf(target) as { pollutedS5p?: string }).pollutedS5p).toBeUndefined();
  });

  it('plugins 子树是拷贝：改传入快照不得写穿 ConfigManager', () => {
    const input = JSON.parse('{"name":"T","logLevel":"error","plugins":{"p":{"ok":1,"nested":{"k":1}}}}') as {
      name: string;
      logLevel: string;
      plugins: { p: { ok: number; nested: { k: number } } };
    };
    const cfg = new ConfigManager(input);
    input.plugins.p.ok = 9;
    input.plugins.p.nested.k = 9;
    expect(cfg.getPluginConfig('p')).toEqual({ ok: 1, nested: { k: 1 } });
  });

  it('plugins 字典上的危险键本身也被剥掉', () => {
    const poisoned = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{"keep":{"ok":1},"__proto__":{"injected":1},"constructor":{"x":1}}}',
    );
    const snap = new ConfigManager(poisoned).getAll().plugins;
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(Object.hasOwn(snap, '__proto__')).toBe(false);
    expect(Object.hasOwn(snap, 'constructor')).toBe(false);
    expect(snap.keep).toEqual({ ok: 1 });
  });
});

describe('字典读写不落原型链', () => {
  it('getPluginConfig 对不存在的 id 返回空对象拷贝，不返回原型链值', () => {
    const cfg = emptyCfg();
    const got = cfg.getPluginConfig('toString') as { leaked?: boolean };
    expect(got).toEqual({});
    expect(typeof got).not.toBe('function');
    got.leaked = true;
    expect(cfg.getPluginConfig('toString')).toEqual({});
  });

  it('servicePreferences 的 JSON 危险键与 set 危险键都不落账', () => {
    const poisoned = JSON.parse(
      '{"name":"T","logLevel":"error","plugins":{},"servicePreferences":{"llm":"a","__proto__":{"pollutedPref":"yes"},"constructor":"x"}}',
    );
    const cfg = new ConfigManager(poisoned);
    const prefs = cfg.getServicePreferences();
    expect(Object.hasOwn(prefs, '__proto__')).toBe(false);
    expect(Object.hasOwn(prefs, 'constructor')).toBe(false);
    expect(prefs.llm).toBe('a');
    expect(Object.getPrototypeOf(prefs)).toBe(Object.prototype);

    cfg.setServicePreference('constructor', 'injected');
    cfg.setServicePreference('prototype', 'injected');
    cfg.setServicePreference('llm', 'plugin-llm');
    expect(Object.hasOwn(cfg.getServicePreferences(), 'constructor')).toBe(false);
    expect(cfg.getServicePreferences().llm).toBe('plugin-llm');
  });
});

describe('register 入参拷贝（F-config 漏场景）', () => {
  it('setPluginConfig 与 register 共享同一对象时，apply 就地改不得写进 ConfigManager', async () => {
    const payload = { tag: 'work', nested: { k: 1 } };
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    const def = definePlugin({
      name: 'probe-pkg',
      reusable: true,
      uses: { config },
      apply({ config: pluginConfig }) {
        (pluginConfig as Record<string, unknown>).mutatedByApply = true;
      },
    });
    app.config.setPluginConfig('probe-pkg:work', payload);
    expect(await app.plugins.register(def, payload, 'probe-pkg:work')).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('probe-pkg:work')?.state).toBe('active');
    expect(
      (app.config.getPluginConfig('probe-pkg:work') as { mutatedByApply?: boolean }).mutatedByApply,
      'apply 就地改不得写进 ConfigManager 快照',
    ).toBeUndefined();
    const live = app.plugins.getPlugin('probe-pkg:work')?.config as Record<string, unknown>;
    live.nested = { k: 999 };
    expect(
      (app.config.getPluginConfig('probe-pkg:work') as { nested?: { k: number } }).nested?.k,
      '返回后改 entry.config 不得改 ConfigManager',
    ).toBe(1);
  });
});
