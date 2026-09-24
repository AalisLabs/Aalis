import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  appService,
  defineService,
  events,
  lifecycle,
  pluginsService,
  provide,
} from '../../packages/core/src/index.js';
import { hostedApp, tempConfig } from '../fixtures/app.js';

/**
 * App 生命周期与配置文档集成测试（文档经 runtime 的 installHostConfig 接上）
 */

/** 隔离探针：只由 appA 发布，appB 绑同一描述符，用来看两个容器是否串台 */
const shared = defineService<{ v: number }>('shared');

describe('App 生命周期', () => {
  it('App 仅靠最小选项可构造；配置文档由宿主接上，裸 core 上没有', () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    expect(app.plugins).toBeDefined();
    expect(app.bind({ hostConfig }).hostConfig.current).toBeUndefined();
    expect(hostedApp().app.bind({ hostConfig }).hostConfig.current).toBeDefined();
  });

  it('host-config get 读取文档顶层字段', () => {
    const { app } = hostedApp({ name: 'MyApp', logLevel: 'warn' });
    const host = app.bind({ hostConfig });
    expect(host.hostConfig.require().get('name')).toBe('MyApp');
    expect(host.hostConfig.require().get('logLevel')).toBe('warn');
  });

  it('app.stop 触发 app:stopping 事件并关闭根激活（onDispose 随之触发）', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
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

  it('两个并存 App 实例互不干扰（service 与配置文档都隔离）', () => {
    const appA = hostedApp({ name: 'A' }).app;
    const appB = hostedApp({ name: 'B' }).app;
    const hostA = appA.bind({ provide, shared, hostConfig });
    const hostB = appB.bind({ shared, hostConfig });
    hostA.provide(shared, { v: 1 });
    expect(hostA.shared.current).toBeDefined();
    expect(hostB.shared.current).toBeUndefined();
    expect(hostA.hostConfig.require().get('name')).toBe('A');
    expect(hostB.hostConfig.require().get('name')).toBe('B');
  });

  it('hostConfig.setPluginConfig + save() 把更改写回 yaml', async () => {
    const cfg = tempConfig('name: T\nlogLevel: error\nplugins: {}\n');
    try {
      const { app } = hostedApp(cfg.config, { provider: cfg.provider });
      const host = app.bind({ hostConfig });
      host.hostConfig.require().setPluginConfig('@aalis/plugin-test', { foo: 'bar', n: 42 });
      await host.hostConfig.require().save();
      const yaml = readFileSync(cfg.path, 'utf-8');
      expect(yaml).toContain('@aalis/plugin-test');
      expect(yaml).toContain('foo');
      expect(yaml).toContain('bar');
    } finally {
      cfg.cleanup();
    }
  });

  it('内置 app / plugins 服务经描述符可取', () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ appService, pluginsService });
    expect(host.appService.current).toBeDefined();
    expect(host.pluginsService.current).toBeDefined();
    expect(host.pluginsService.current?.getStatus()).toEqual(app.plugins.getStatus());
  });
});
