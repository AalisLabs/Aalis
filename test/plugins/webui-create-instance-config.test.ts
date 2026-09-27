import type { Logger, ServiceRef } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type App, appService, config, definePlugin, pluginsService } from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { hostedApp } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// POST /api/plugins/:name/instances 的 config 与 PUT 插件配置同一套：按默认值深合并（只提交半块的分组不能把
// 默认子键整块顶掉）、按 schema 裁剪并告警、校验 invalid 拒绝。新实例没有存量配置，invalid 一律拦下。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function refStub<T>(instance: unknown): ServiceRef<T> {
  return { current: instance as T, require: () => instance as T, all: () => [], follow: () => () => {} };
}

const grouped = definePlugin({
  name: 'grouped',
  reusable: true,
  configSchema: {
    timeoutMs: { type: 'number', label: '超时', default: 30 },
    retry: {
      label: '重试',
      fields: {
        delayMs: { type: 'number', label: '间隔', default: 100 },
        maxTries: { type: 'number', label: '次数', default: 3 },
      },
    },
  },
  uses: { config },
  apply() {},
});

async function setup() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error() {},
    child: () => logger,
  };
  const saves: number[] = [];
  const { app, store } = hostedApp({}, { provider: { save: () => void saves.push(1) } });
  apps.push(app);
  await app.plugin(grouped);
  await app.plugins.idle();
  const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
  const { expressApp, invoke } = captureRoutes();
  registerPluginRoutes(
    expressApp,
    {
      app: refStub(bound.app.require()),
      source: { current: undefined },
      plugins: refStub(bound.plugins.require()),
      hostConfig: refStub(bound.hostConfig.require()),
      tools: { current: undefined },
      commands: { current: undefined },
      webui: () => undefined,
      logger,
    },
    () => ({ platform: 'webui', userId: 'console' }),
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    () => undefined,
  );
  const create = (body: unknown) =>
    invoke('POST /api/plugins/:name/instances', { params: { name: 'grouped' }, body, headers: {} });
  return { app, store, create, warnings, saves };
}

describe('POST /api/plugins/:name/instances 的配置与改配置同一套', () => {
  it('只提交半块分组：其余默认子键补齐；值为 null 的顶层键按默认值处理', async () => {
    const w = await setup();
    const reply = await w.create({ suffix: 'x', config: { retry: { maxTries: 5 }, timeoutMs: null } });
    expect(reply.body).toEqual({ ok: true, instanceId: 'grouped:x', message: '已创建实例 grouped:x', ignored: [] });
    const expected = { timeoutMs: 30, retry: { maxTries: 5, delayMs: 100 } };
    expect(w.store.getPluginConfig('grouped:x'), '顶层浅合并会把 retry.delayMs 整块顶掉').toEqual(expected);
    expect(w.app.plugins.getPlugin('grouped:x')?.config).toEqual(expected);
    expect(w.saves).toHaveLength(1);
  });

  it('未声明的字段裁掉：回执在 ignored 与 message 里点名，日志告警', async () => {
    const w = await setup();
    const reply = await w.create({ suffix: 'x', config: { timeoutMs: 60, typo: 1, retry: { extra: true } } });
    expect(reply.body).toEqual({
      ok: true,
      instanceId: 'grouped:x',
      message: '已创建实例 grouped:x（已忽略未声明的配置字段: typo, retry.extra）',
      ignored: ['typo', 'retry.extra'],
    });
    expect(w.store.getPluginConfig('grouped:x')).toEqual({ timeoutMs: 60, retry: { delayMs: 100, maxTries: 3 } });
    const hit = w.warnings.find(m => m.includes('裁掉 schema 外字段'));
    expect(hit).toContain('grouped:x');
    expect(hit).toContain('typo');
  });

  it('类型不符的值拒绝创建：400 点名，不登记、不写文档、不落盘', async () => {
    const w = await setup();
    const reply = await w.create({ suffix: 'x', config: { timeoutMs: 'slow', retry: { maxTries: '3' } } });
    expect(reply.status).toBe(400);
    expect((reply.body as { error: string }).error).toBe(
      '配置校验未通过：timeoutMs: 期望有限数值，得到 string；retry.maxTries: 期望有限数值，得到 string',
    );
    expect(w.app.plugins.getPlugin('grouped:x')).toBeUndefined();
    expect(Object.hasOwn(w.store.getAll().plugins, 'grouped:x')).toBe(false);
    expect(w.saves).toHaveLength(0);
  });

  it('config 不是对象（字符串、数组）：400，不登记；否则会被展开成逐个字符、逐个下标的键', async () => {
    const w = await setup();
    for (const config of ['timeoutMs=60', [{ timeoutMs: 5 }]]) {
      const reply = await w.create({ suffix: 'x', config });
      expect(reply).toEqual({ status: 400, body: { error: 'config 字段必须是对象' } });
    }
    expect(w.app.plugins.getPlugin('grouped:x')).toBeUndefined();
    expect(Object.hasOwn(w.store.getAll().plugins, 'grouped:x')).toBe(false);
  });
});
