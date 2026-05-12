import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, LogHub } from '../../packages/core/src/index.js';

/**
 * App 生命周期与配置集成测试
 */

function tempConfig(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-app-'));
  const path = join(dir, 'aalis.config.yaml');
  writeFileSync(path, yaml);
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('App 生命周期', () => {
  beforeEach(() => {
    LogHub.default.setConsoleSinkEnabled(false);
  });
  afterEach(() => {
    LogHub.default.setConsoleSinkEnabled(true);
  });

  it('createApp 仅靠最小配置可构造', () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({ configPath: cfg.path });
      expect(app.ctx).toBeDefined();
      expect(app.plugins).toBeDefined();
      expect(app.ctx.config).toBeDefined();
      expect(app.events).toBeDefined();
      expect(app.services).toBeDefined();
      expect(app.hooks).toBeDefined();
    } finally {
      cfg.cleanup();
    }
  });

  it('config get 读取顶层字段', () => {
    const cfg = tempConfig('name: MyApp\nlogLevel: warn\nplugins: {}\n');
    try {
      const app = new App({ configPath: cfg.path });
      expect(app.ctx.config.get('name')).toBe('MyApp');
      expect(app.ctx.config.get('logLevel')).toBe('warn');
    } finally {
      cfg.cleanup();
    }
  });

  it('app.stop 触发 dispose 事件并清理 ctx', async () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({ configPath: cfg.path });
      const ctx = app.ctx;
      const events: string[] = [];
      ctx.on('app:stopping', () => {
        events.push('stopping');
      });
      ctx.on('dispose', () => {
        events.push('dispose');
      });
      await app.stop();
      expect(events).toEqual(['stopping', 'dispose']);
      expect(ctx.disposed).toBe(true);
    } finally {
      cfg.cleanup();
    }
  });

  it('两个并存 App 实例互不干扰（service 隔离）', () => {
    const a = tempConfig('name: A\nlogLevel: error\nplugins: {}\n');
    const b = tempConfig('name: B\nlogLevel: error\nplugins: {}\n');
    try {
      const appA = new App({ configPath: a.path });
      const appB = new App({ configPath: b.path });
      expect(appA.services).not.toBe(appB.services);
      appA.ctx.provide('shared', { v: 1 });
      expect(appA.ctx.getService('shared')).toBeDefined();
      expect(appB.ctx.getService('shared')).toBeUndefined();
      // 配置也独立
      expect(appA.ctx.config.get('name')).toBe('A');
      expect(appB.ctx.config.get('name')).toBe('B');
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('config.setPluginConfig + save 把更改写回 yaml', () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({ configPath: cfg.path });
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
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({ configPath: cfg.path });
      expect(app.requiredServices).toEqual([]);
    } finally {
      cfg.cleanup();
    }
  });

  it('内置 app / plugins 服务在 ctx 中可见', () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({ configPath: cfg.path });
      expect(app.ctx.getService('app')).toBe(app);
      expect(app.ctx.getService('plugins')).toBe(app.plugins);
    } finally {
      cfg.cleanup();
    }
  });
});
