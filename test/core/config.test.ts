import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../../packages/core/src/index.js';
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
    cfg.setServicePreference('llm', 'plugin-llm-openai');
    expect(cfg.getServicePreferences().llm).toBe('plugin-llm-openai');
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

// 注：配置同步政策（defaultConfig 回填 / schema 裁剪）的测试在
// test/runtime/config-sync.test.ts——政策属宿主层,core 只持有配置快照机制。
