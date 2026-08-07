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

  // 环境变量插值（`${VAR}`）与 save() 的占位符保护已随 `.env` 机制一并删除：
  // 那一层承载的东西与 aalis.config.yaml 完全重合，唯一区别是「哪个文件进 git」，
  // 而脚手架现在把 config 本身 gitignore 掉了（密钥直接写在里面），于是它纯属多余。
  // 顺带记一笔：被删的第二条用例（save() 保留 ${VAR} 占位符）在插值实现删掉之后**仍然
  // 通过**——因为没有插值，写回的本来就是原字符串。它一直是条假绿。

  it('从 YAML 加载配置树', () => {
    cfg = tempConfig('name: MyApp\nlogLevel: debug\nplugins:\n  myplug:\n    apikey: literal-secret\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
    expect(mgr.get('name')).toBe('MyApp');
    expect(mgr.getPluginConfig('myplug').apikey, '值原样加载，不做任何替换').toBe('literal-secret');
  });

  it('save() 原样写回字符串值（密钥直接住在 config 里，不得被改写）', () => {
    cfg = tempConfig('name: X\nlogLevel: info\nplugins:\n  myplug:\n    token: sk-literal\n');
    const mgr = new ConfigManager(cfg.config, { provider: cfg.provider, dataDir: cfg.dataDir });
    mgr.set('name', 'Y');
    mgr.save();
    const written = readFileSync(cfg.path, 'utf-8');
    expect(written).toMatch(/name: Y/);
    expect(written).toContain('sk-literal');
  });
});

// 注：配置同步政策（schema 派生默认值回填 / schema 裁剪）的测试在
// test/runtime/config-sync.test.ts——政策属宿主层,core 只持有配置快照机制。
