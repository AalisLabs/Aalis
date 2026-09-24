import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  App,
  appService,
  defineService,
  events,
  hostConfig,
  lifecycle,
  pluginsService,
  provide,
} from '../../packages/core/src/index.js';
import { tempConfig } from '../fixtures/app.js';

/**
 * App 生命周期与配置集成测试
 */

/** 隔离探针：只由 appA 发布，appB 绑同一描述符，用来看两个容器是否串台 */
const shared = defineService<{ v: number }>('shared');

describe('App 生命周期', () => {
  it('createApp 仅靠最小配置可构造', () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    expect(app.plugins).toBeDefined();
    // 根激活可装配能力，宿主管理面（整份配置的读写口）在场
    expect(app.bind({ hostConfig }).hostConfig.current).toBeDefined();
  });

  it('config get 读取顶层字段', () => {
    const app = new App({ config: { name: 'MyApp', logLevel: 'warn', plugins: {} } });
    const host = app.bind({ hostConfig });
    expect(host.hostConfig.require().get('name')).toBe('MyApp');
    expect(host.hostConfig.require().get('logLevel')).toBe('warn');
  });

  it('app.stop 触发 app:stopping 事件并关闭根激活（onDispose 随之触发）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const host = app.bind({ events, lifecycle });
    const seen: string[] = [];
    host.events.on('app:stopping', () => {
      seen.push('stopping');
    });
    host.lifecycle.onDispose(() => {
      seen.push('dispose');
    });
    await app.stop();
    expect(seen).toEqual(['stopping', 'dispose']);
    expect(host.lifecycle.closed).toBe(true);
  });

  it('两个并存 App 实例互不干扰（service 隔离）', () => {
    const appA = new App({ config: { name: 'A', logLevel: 'error', plugins: {} } });
    const appB = new App({ config: { name: 'B', logLevel: 'error', plugins: {} } });
    const hostA = appA.bind({ provide, shared, hostConfig });
    const hostB = appB.bind({ shared, hostConfig });
    hostA.provide(shared, { v: 1 });
    expect(hostA.shared.current).toBeDefined();
    expect(hostB.shared.current).toBeUndefined();
    expect(hostA.hostConfig.require().get('name')).toBe('A');
    expect(hostB.hostConfig.require().get('name')).toBe('B');
  });

  it('hostConfig.setPluginConfig + app.saveConfig 把更改写回 yaml', async () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const app = new App({
        config: cfg.config,
        configProvider: cfg.provider,
      });
      const host = app.bind({ hostConfig, appService });
      host.hostConfig.require().setPluginConfig('@aalis/plugin-test', { foo: 'bar', n: 42 });
      await host.appService.require().saveConfig();
      const yaml = readFileSync(cfg.path, 'utf-8');
      expect(yaml).toContain('@aalis/plugin-test');
      expect(yaml).toContain('foo');
      expect(yaml).toContain('bar');
    } finally {
      cfg.cleanup();
    }
  });

  it('内置 app / plugins 服务经描述符可取', () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const host = app.bind({ appService, pluginsService });
    expect(host.appService.current).toBeDefined();
    expect(host.pluginsService.current).toBeDefined();
    expect(host.pluginsService.current?.getStatus()).toEqual(app.plugins.getStatus());
  });
});
