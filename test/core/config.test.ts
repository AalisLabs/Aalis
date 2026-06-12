import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager, ScopedConfigManager } from '../../packages/core/src/index.js';
import { type TempConfigHandle, tempConfig } from '../fixtures/app.js';

describe('ConfigManager (内存快照模式)', () => {
  it('未传入字段时使用默认值', () => {
    const cfg = new ConfigManager({ name: 'Aalis', logLevel: 'info', plugins: {} });
    expect(cfg.get('name')).toBe('Aalis');
    expect(cfg.get('logLevel')).toBe('info');
    expect(cfg.get('plugins')).toEqual({});
  });

  it('setPluginConfig / removePluginConfig', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    cfg.setPluginConfig('a', { x: 1 });
    expect(cfg.getPluginConfig('a').x).toBe(1);
    cfg.removePluginConfig('a');
    expect(cfg.getPluginConfig('a')).toEqual({});
  });

  it('isPluginDisabled / setPluginEnabled toggle', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    expect(cfg.isPluginDisabled('p')).toBe(false);
    cfg.setPluginEnabled('p', false);
    expect(cfg.isPluginDisabled('p')).toBe(true);
    cfg.setPluginEnabled('p', true);
    expect(cfg.isPluginDisabled('p')).toBe(false);
  });

  it('servicePreferences 增删', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    cfg.setServicePreference('llm', 'plugin-openai');
    expect(cfg.getServicePreferences().llm).toBe('plugin-openai');
    cfg.removeServicePreference('llm');
    expect(cfg.getServicePreferences().llm).toBeUndefined();
  });

  it('reloadFrom 用新的快照替换当前状态', () => {
    const cfg = new ConfigManager({ name: 'One', logLevel: 'info', plugins: {} });
    expect(cfg.get('name')).toBe('One');
    cfg.reloadFrom({ name: 'Two', logLevel: 'info', plugins: {} });
    expect(cfg.get('name')).toBe('Two');
  });

  it('getConfigDir 返回 host 注入的 dataDir', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }, { dataDir: '/tmp/foo' });
    expect(cfg.getConfigDir()).toBe('/tmp/foo');
  });

  it('未注入 provider 时 save() 是 no-op', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    // 不抛错即可——纯内存模式 save 没有持久化目标
    expect(() => cfg.save()).not.toThrow();
  });
});

describe('FsYamlConfigProvider (集成)', () => {
  let cfg: TempConfigHandle;
  afterEach(() => cfg?.cleanup());

  it('从 YAML 加载并支持环境变量插值', () => {
    process.env.TEST_KEY_X = 'value-from-env';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: YAML 变量占位符，重点验证 ConfigManager 插值能力
    cfg = tempConfig('name: MyApp\nlogLevel: debug\nplugins:\n  myplug:\n    apikey: ${TEST_KEY_X}\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
    expect(mgr.get('name')).toBe('MyApp');
    expect(mgr.getPluginConfig('myplug').apikey).toBe('value-from-env');
    delete process.env.TEST_KEY_X;
  });

  it('save() 写入 YAML 并恢复环境变量占位符', () => {
    process.env.TEST_KEY_Y = 'secret';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: YAML 变量占位符，重点验证保存时占位符被保留
    cfg = tempConfig('name: X\nlogLevel: info\nplugins:\n  myplug:\n    token: ${TEST_KEY_Y}\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
    mgr.set('name', 'Y');
    mgr.save();
    const written = readFileSync(cfg.path, 'utf-8');
    expect(written).toMatch(/name: Y/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: YAML 变量占位符原型字符串
    expect(written).toContain('${TEST_KEY_Y}');
    delete process.env.TEST_KEY_Y;
  });
});

describe('ScopedConfigManager (沙盒)', () => {
  it('读 fallback 到父级，写仅作用于本作用域', () => {
    const parent = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    parent.set('name', 'Parent');
    parent.setPluginConfig('llm', { temperature: 0.7 });

    const scope = new ScopedConfigManager(parent);
    expect(scope.get('name')).toBe('Parent');
    expect(scope.getPluginConfig('llm').temperature).toBe(0.7);

    scope.set('name', 'Sandbox');
    scope.setPluginConfig('llm', { temperature: 0.1 });

    expect(scope.get('name')).toBe('Sandbox');
    expect(scope.getPluginConfig('llm').temperature).toBe(0.1);
    expect(parent.get('name')).toBe('Parent');
    expect(parent.getPluginConfig('llm').temperature).toBe(0.7);
  });

  it('save() 是内存模式 no-op：不抛错、不触发父级持久化', () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const parent = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
      const scope = new ScopedConfigManager(parent);
      scope.set('name', 'Sandbox');
      // 通用插件代码（如 ensureServiceProvider）在 scope 内调 save() 不应被炸
      expect(() => scope.save()).not.toThrow();
      // 父级也未触发 save：磁盘内容保持原样
      expect(existsSync(cfg.path)).toBe(true);
      const text = readFileSync(cfg.path, 'utf-8');
      expect(text).toContain('name: T');
      expect(text).not.toContain('Sandbox');
    } finally {
      cfg.cleanup();
    }
  });

  it('setPluginEnabled / setServicePreference 不写穿父配置（#8.5 写穿透回归）', () => {
    const parent = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
    parent.setPluginEnabled('shared', false);
    parent.setServicePreference('llm', 'plugin-a');

    const scope = new ScopedConfigManager(parent);
    // scope 内启用父级禁用的插件、改偏好、再禁一个新插件
    scope.setPluginEnabled('shared', true);
    scope.setPluginEnabled('scope-only', false);
    scope.setServicePreference('llm', 'plugin-b');
    scope.removeServicePreference('llm-vision');

    // scope 视角生效
    expect(scope.isPluginDisabled('shared')).toBe(false);
    expect(scope.isPluginDisabled('scope-only')).toBe(true);
    expect(scope.getServicePreferences().llm).toBe('plugin-b');

    // 父级不受影响
    expect(parent.isPluginDisabled('shared')).toBe(true);
    expect(parent.isPluginDisabled('scope-only')).toBe(false);
    expect(parent.getServicePreferences().llm).toBe('plugin-a');
  });

  it('syncPluginDefaults 在 scope 上合并进 overlay 且不炸（#8.5 回归）', () => {
    const parent = new ConfigManager({ name: 'T', logLevel: 'error', plugins: { p1: { a: 1 } } });
    const scope = new ScopedConfigManager(parent);
    const changed = scope.syncPluginDefaults([{ instanceId: 'p1', defaultConfig: { a: 0, b: 2 } }]);
    expect(changed).toEqual(['p1']);
    expect(scope.getPluginConfig('p1')).toEqual({ a: 1, b: 2 });
    // 父级插件配置未被改写
    expect(parent.getPluginConfig('p1')).toEqual({ a: 1 });
  });

  it('覆写了 ConfigManager 全部公开方法（防漂移：新增基类方法必须显式委托）', () => {
    const baseMethods = Object.getOwnPropertyNames(ConfigManager.prototype).filter(n => n !== 'constructor');
    const scopedOwn = Object.getOwnPropertyNames(ScopedConfigManager.prototype);
    for (const m of baseMethods) {
      expect(scopedOwn, `ScopedConfigManager 未显式覆写基类方法 "${m}"（继承实现会读写无效的基类快照）`).toContain(m);
    }
  });
});

describe('configSync.trimUnknownFields 政策（#4 政策注入）', () => {
  it('默认（true）：syncPluginDefaults 按 schema 裁剪未知字段', () => {
    const cfg = new ConfigManager({ name: 'T', logLevel: 'error', plugins: { p1: { known: 1, unknown: 'x' } } });
    cfg.syncPluginDefaults([
      { instanceId: 'p1', defaultConfig: { known: 0 }, configSchema: { known: { type: 'number', label: 'K' } } },
    ]);
    expect(cfg.getPluginConfig('p1')).toEqual({ known: 1 });
  });

  it('ScopedConfigManager 继承父配置的 trimUnknownFields 政策（评审修复回归）', () => {
    const parent = new ConfigManager(
      { name: 'T', logLevel: 'error', plugins: { p1: { known: 1, unknown: 'x' } } },
      { trimUnknownFields: false },
    );
    const scope = new ScopedConfigManager(parent);
    scope.syncPluginDefaults([
      { instanceId: 'p1', defaultConfig: { known: 0 }, configSchema: { known: { type: 'number', label: 'K' } } },
    ]);
    // 父政策为"保留"，scope 不得用缺省 true 裁掉 unknown
    expect(scope.getPluginConfig('p1')).toEqual({ known: 1, unknown: 'x' });
  });

  it('trimUnknownFields=false：保留 schema 外字段', () => {
    const cfg = new ConfigManager(
      { name: 'T', logLevel: 'error', plugins: { p1: { known: 1, unknown: 'x' } } },
      { trimUnknownFields: false },
    );
    cfg.syncPluginDefaults([
      { instanceId: 'p1', defaultConfig: { known: 0 }, configSchema: { known: { type: 'number', label: 'K' } } },
    ]);
    expect(cfg.getPluginConfig('p1')).toEqual({ known: 1, unknown: 'x' });
  });
});
