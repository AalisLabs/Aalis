import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigManager, ScopedConfigManager } from '../../packages/core/src/index.js';

describe('ConfigManager', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-cfg-'));
    path = join(dir, 'aalis.config.yaml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('未存在配置文件时返回默认值', () => {
    const cfg = new ConfigManager(path);
    expect(cfg.get('name')).toBe('Aalis');
    expect(cfg.get('logLevel')).toBe('info');
    expect(cfg.get('plugins')).toEqual({});
  });

  it('从 YAML 加载并支持环境变量插值', () => {
    process.env.TEST_KEY_X = 'value-from-env';
    writeFileSync(path, `name: MyApp\nlogLevel: debug\nplugins:\n  myplug:\n    apikey: \${TEST_KEY_X}\n`);
    const cfg = new ConfigManager(path);
    expect(cfg.get('name')).toBe('MyApp');
    expect(cfg.getPluginConfig('myplug').apikey).toBe('value-from-env');
    delete process.env.TEST_KEY_X;
  });

  it('setPluginConfig / removePluginConfig', () => {
    const cfg = new ConfigManager(path);
    cfg.setPluginConfig('a', { x: 1 });
    expect(cfg.getPluginConfig('a').x).toBe(1);
    cfg.removePluginConfig('a');
    expect(cfg.getPluginConfig('a')).toEqual({});
  });

  it('isPluginDisabled / setPluginEnabled toggle', () => {
    const cfg = new ConfigManager(path);
    expect(cfg.isPluginDisabled('p')).toBe(false);
    cfg.setPluginEnabled('p', false);
    expect(cfg.isPluginDisabled('p')).toBe(true);
    cfg.setPluginEnabled('p', true);
    expect(cfg.isPluginDisabled('p')).toBe(false);
  });

  it('save() 写入 YAML 并恢复环境变量占位符', () => {
    process.env.TEST_KEY_Y = 'secret';
    writeFileSync(path, `name: X\nlogLevel: info\nplugins:\n  myplug:\n    token: \${TEST_KEY_Y}\n`);
    const cfg = new ConfigManager(path);
    cfg.set('name', 'Y');
    cfg.save();
    const written = readFileSync(path, 'utf-8');
    expect(written).toMatch(/name: Y/);
    expect(written).toContain('${TEST_KEY_Y}'); // 占位符保留
    delete process.env.TEST_KEY_Y;
  });

  it('servicePreferences 增删', () => {
    const cfg = new ConfigManager(path);
    cfg.setServicePreference('llm', 'plugin-openai');
    expect(cfg.getServicePreferences().llm).toBe('plugin-openai');
    cfg.removeServicePreference('llm');
    expect(cfg.getServicePreferences().llm).toBeUndefined();
  });

  it('reload 重新读取磁盘', () => {
    writeFileSync(path, `name: One\nlogLevel: info\nplugins: {}\n`);
    const cfg = new ConfigManager(path);
    expect(cfg.get('name')).toBe('One');
    writeFileSync(path, `name: Two\nlogLevel: info\nplugins: {}\n`);
    cfg.reload();
    expect(cfg.get('name')).toBe('Two');
  });
});

describe('ScopedConfigManager (沙盒)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-scfg-'));
    path = join(dir, 'aalis.config.yaml');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('读 fallback 到父级，写仅作用于本作用域', () => {
    const parent = new ConfigManager(path);
    parent.set('name', 'Parent');
    parent.setPluginConfig('llm', { temperature: 0.7 });

    const scope = new ScopedConfigManager(parent);
    expect(scope.get('name')).toBe('Parent');
    expect(scope.getPluginConfig('llm').temperature).toBe(0.7);

    scope.set('name', 'Sandbox');
    scope.setPluginConfig('llm', { temperature: 0.1 });

    expect(scope.get('name')).toBe('Sandbox');
    expect(scope.getPluginConfig('llm').temperature).toBe(0.1);
    // 父级不变
    expect(parent.get('name')).toBe('Parent');
    expect(parent.getPluginConfig('llm').temperature).toBe(0.7);
  });

  it('save() 抛错，保护磁盘不被沙盒污染', () => {
    const parent = new ConfigManager(path);
    const scope = new ScopedConfigManager(parent);
    expect(() => scope.save()).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
