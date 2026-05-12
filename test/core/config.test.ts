import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    cfg = tempConfig('name: MyApp\nlogLevel: debug\nplugins:\n  myplug:\n    apikey: ${TEST_KEY_X}\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
    expect(mgr.get('name')).toBe('MyApp');
    expect(mgr.getPluginConfig('myplug').apikey).toBe('value-from-env');
    delete process.env.TEST_KEY_X;
  });

  it('save() 写入 YAML 并恢复环境变量占位符', () => {
    process.env.TEST_KEY_Y = 'secret';
    cfg = tempConfig('name: X\nlogLevel: info\nplugins:\n  myplug:\n    token: ${TEST_KEY_Y}\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
    mgr.set('name', 'Y');
    mgr.save();
    const written = readFileSync(cfg.path, 'utf-8');
    expect(written).toMatch(/name: Y/);
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

  it('save() 抛错，保护父级不被沙盒污染', () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const parent = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
      const scope = new ScopedConfigManager(parent);
      expect(() => scope.save()).toThrow();
      // 父级也未触发 save：磁盘内容保持原样
      expect(existsSync(cfg.path)).toBe(true);
      const text = readFileSync(cfg.path, 'utf-8');
      expect(text).toContain('name: T');
    } finally {
      cfg.cleanup();
    }
  });
});
