import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { tempConfig } from '../fixtures/app.js';

/**
 * App 生命周期与配置集成测试
 */

describe('App 生命周期', () => {
  it('createApp 仅靠最小配置可构造', () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    expect(app.ctx).toBeDefined();
    expect(app.plugins).toBeDefined();
    expect(app.ctx.config).toBeDefined();
    expect(app.events).toBeDefined();
    expect(app.services).toBeDefined();
    expect(app.hooks).toBeDefined();
  });

  it('config get 读取顶层字段', () => {
    const app = new App({ config: { name: 'MyApp', logLevel: 'warn', plugins: {} } });
    expect(app.ctx.config.get('name')).toBe('MyApp');
    expect(app.ctx.config.get('logLevel')).toBe('warn');
  });

  it('app.stop 触发 app:stopping 事件并清理 ctx（ctx.onDispose 随 ctx.dispose() 触发）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const ctx = app.ctx;
    const events: string[] = [];
    ctx.on('app:stopping', () => {
      events.push('stopping');
    });
    ctx.onDispose(() => {
      events.push('dispose');
    });
    await app.stop();
    expect(events).toEqual(['stopping', 'dispose']);
    expect(ctx.disposed).toBe(true);
  });

  it('两个并存 App 实例互不干扰（service 隔离）', () => {
    const appA = new App({ config: { name: 'A', logLevel: 'error', plugins: {} } });
    const appB = new App({ config: { name: 'B', logLevel: 'error', plugins: {} } });
    expect(appA.services).not.toBe(appB.services);
    appA.ctx.provide('shared', { v: 1 });
    expect(appA.ctx.getService('shared')).toBeDefined();
    expect(appB.ctx.getService('shared')).toBeUndefined();
    expect(appA.ctx.config.get('name')).toBe('A');
    expect(appB.ctx.config.get('name')).toBe('B');
  });

  it('config.setPluginConfig + save 把更改写回 yaml', () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({
        config: cfg.config,
        configProvider: cfg.provider,
        dataDir: cfg.dataDir,
      });
      app.ctx.config.setPluginConfig('@aalis/plugin-test', { foo: 'bar', n: 42 });
      app.ctx.config.save();
      const yaml = readFileSync(cfg.path, 'utf-8');
      expect(yaml).toContain('@aalis/plugin-test');
      expect(yaml).toContain('foo');
      expect(yaml).toContain('bar');
    } finally {
      cfg.cleanup();
    }
  });

  it('AppOptions.requiredServices 默认空', () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    expect(app.requiredServices).toEqual([]);
  });

  it('内置 app / plugins 服务在 ctx 中可见', () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const appSvc = app.ctx.getService<App>('app');
    const pluginsSvc = app.ctx.getService('plugins');
    expect(appSvc).toBeDefined();
    expect(pluginsSvc).toBeDefined();
    expect(appSvc?.requiredServices).toEqual(app.requiredServices);
    expect(pluginsSvc).toEqual(app.plugins);
  });
});
