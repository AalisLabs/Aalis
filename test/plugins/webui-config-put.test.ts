import type { AppService, Logger, PluginManagerService, ServiceRef } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { ConfigSaveRefusedError, type HostConfig } from '../../packages/api-host-config/src/index.js';
import { registerPluginRoutes, saveAfterApply } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { CORE_CONFIG_SCHEMA } from '../../packages/schema-config/src/index.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// 宿主配置：GET /api/config 给出文档里写了的核心键、它们的 schema、要重启才生效的键与家目录。
// PUT /api/config 只收 CORE_CONFIG_SCHEMA 的键（name / logLevel / slowThresholdMs）。别的顶层键回 400 并点名，什么都不写——
// 不能静默丢弃却回复「已保存」（文档曾把 commandPrefix 记成顶层字段，用户照抄后 API 回 ok 但什么都没发生）。
// PUT 只保存、不重启，改了要重启的键时回执写明，由前端出「重启以生效」；重启走 POST /api/restart。
// 路由注册器只调用 app.<method>(path, ...handlers)，这里用记录处理器的假 app 直接调用，不起端口。

/** 进程里另一份 @aalis/api-host-config 的拒写类：类身份不同，名字相同 */
class ForeignCopyRefusedError extends Error {
  override name = 'ConfigSaveRefusedError';
}

/** 最小 ServiceRef 桩：路由只经 current / require 取提供者 */
function ref<T>(instance: unknown): ServiceRef<T> {
  return { current: instance as T, require: () => instance as T, all: () => [], follow: () => () => {} };
}

function setup(opts: { save?: () => Promise<void>; restart?: () => void } = {}) {
  const store: Record<string, unknown> = {
    name: 'Aalis',
    logLevel: 'info',
    plugins: { '@aalis/plugin-x': { a: 1 } },
    disabledPlugins: [],
  };
  const calls: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error: (msg: string) => void errors.push(msg),
    child: () => logger,
  };
  const { expressApp, invoke } = captureRoutes();
  const hostConfig = {
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
    getAll: () => ({ ...store }),
    save:
      opts.save ??
      (() => {
        calls.push('save');
        return Promise.resolve();
      }),
  };
  registerPluginRoutes(
    expressApp,
    {
      app: ref<AppService>({ restart: opts.restart ?? (() => calls.push('restart')) }),
      source: { current: undefined },
      plugins: ref<PluginManagerService>({}),
      hostConfig: ref<HostConfig>(hostConfig),
      tools: { current: undefined },
      commands: { current: undefined },
      services: { inspect: () => [] },
      self: 'zz-webui',
      home: '/home/zz/.aalis',
      versions: () => () => undefined,
      logger,
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  const get = () => invoke('GET /api/config', { headers: {} });
  const put = (body: unknown) => invoke('PUT /api/config', { body, headers: {} });
  const restart = () => invoke('POST /api/restart', { body: {}, headers: {} });
  return { store, calls, errors, get, put, restart };
}

describe('GET /api/config', () => {
  it('给出文档里写了的核心键（不带插件配置等其余部分）、核心键的 schema、要重启才生效的键与家目录', async () => {
    const { get } = setup();
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      config: { name: 'Aalis', logLevel: 'info' },
      schema: CORE_CONFIG_SCHEMA,
      restartKeys: ['logLevel', 'slowThresholdMs'],
      home: '/home/zz/.aalis',
    });
  });
});

describe('PUT /api/config 只收核心键', () => {
  it.each([
    ['写错了位置的插件配置', { commandPrefix: '!' }],
    ['与核心键混在一起', { logLevel: 'debug', disabledPlugins: ['@aalis/plugin-x'] }],
    ['整份配置文档', { name: 'Bot', logLevel: 'warn', plugins: { '@aalis/plugin-x': { a: 0 } }, disabledPlugins: [] }],
  ])('别的顶层键（%s）→ 400 点名，什么都不写、不落盘', async (_label, body) => {
    const { store, calls, put } = setup();
    const before = structuredClone(store);
    const r = await put(body);
    expect(r.status).toBe(400);
    const foreign = Object.keys(body).filter(key => !Object.hasOwn(CORE_CONFIG_SCHEMA, key));
    expect(r.body).toEqual({ error: `只能改核心键（name、logLevel、slowThresholdMs），不收：${foreign.join('、')}` });
    expect(store).toEqual(before);
    expect(calls).toEqual([]);
  });

  it('已知键 → 写入并保存，不自己重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ logLevel: 'debug' });
    expect(r.status).toBe(200);
    expect(store.logLevel).toBe('debug');
    expect(calls).toEqual(['save']);
  });
});

describe('PUT /api/config 要不要重启', () => {
  // logLevel 与 slowThresholdMs 只在启动时读取；name 只是显示用的应用名称，保存即生效
  it('只改 name → 保存即生效，回执写明不用重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ name: 'Bot' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: '全局配置已更新并保存', restartNeeded: false });
    expect(store.name).toBe('Bot');
    expect(calls).toEqual(['save']);
  });

  it('改 slowThresholdMs → 写入并保存，回执写明重启后生效，不自己重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ slowThresholdMs: 30000 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: '全局配置已保存，重启后生效', restartNeeded: true });
    expect(store.slowThresholdMs).toBe(30000);
    expect(calls).toEqual(['save']);
  });

  it('清空 slowThresholdMs（提交 null）→ 从文档删掉这个键、回到默认值，重启后生效', async () => {
    const { store, put } = setup();
    store.slowThresholdMs = 30000;
    const r = await put({ name: 'Aalis', logLevel: 'info', slowThresholdMs: null });
    expect(r.status).toBe(200);
    expect((r.body as { restartNeeded: boolean }).restartNeeded).toBe(true);
    expect(store.slowThresholdMs).toBeUndefined();
  });

  it('文档里本来就没有 slowThresholdMs 时提交 null：不算改动，不用重启', async () => {
    const { store, put } = setup();
    const r = await put({ name: 'Aalis', logLevel: 'info', slowThresholdMs: null });
    expect(r.status).toBe(200);
    expect((r.body as { restartNeeded: boolean }).restartNeeded).toBe(false);
    expect('slowThresholdMs' in store).toBe(false);
  });

  it('把文档里缺省的 slowThresholdMs 按默认值回传：不算改动，不写进文档、不用重启', async () => {
    const { store, put } = setup();
    const r = await put({ name: 'Bot', logLevel: 'info', slowThresholdMs: 60000 });
    expect(r.status).toBe(200);
    expect(store.name).toBe('Bot');
    expect('slowThresholdMs' in store).toBe(false);
    expect((r.body as { restartNeeded: boolean }).restartNeeded).toBe(false);
  });

  it('name 与 logLevel 一起改 → 重启后生效', async () => {
    const { store, put } = setup();
    const r = await put({ name: 'Bot', logLevel: 'debug' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: '全局配置已保存，重启后生效', restartNeeded: true });
    expect(store).toMatchObject({ name: 'Bot', logLevel: 'debug' });
  });
});

describe('POST /api/restart', () => {
  it('发起重启后回复', async () => {
    const { calls, restart } = setup();
    expect(await restart()).toEqual({ status: 200, body: { ok: true, message: '正在重启应用' } });
    expect(calls).toEqual(['restart']);
  });

  it('宿主没注入重启策略 → 500 写明原因，记一笔 error', async () => {
    const { errors, restart } = setup({
      restart: () => {
        throw new Error('App.restart() 不可用：未注入 restartStrategy。');
      },
    });
    expect(await restart()).toEqual({
      status: 500,
      body: { error: '重启失败（App.restart() 不可用：未注入 restartStrategy。），改动在下次启动时生效' },
    });
    expect(errors).toEqual(['重启失败（App.restart() 不可用：未注入 restartStrategy。），改动在下次启动时生效']);
  });
});

describe('PUT /api/config 值校验', () => {
  it.each(['abc', -1, ' '])('slowThresholdMs 不是不小于 0 的数字（%j）→ 400，不落盘', async value => {
    const { store, calls, put } = setup();
    const r = await put({ slowThresholdMs: value });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/slowThresholdMs/);
    expect('slowThresholdMs' in store).toBe(false);
    expect(calls).toEqual([]);
  });

  it('select 取值不在范围（logLevel: nope）→ 400，不落盘', async () => {
    const { store, calls, put } = setup();
    const r = await put({ logLevel: 'nope' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/logLevel/);
    expect(store.logLevel).toBe('info');
    expect(calls).toEqual([]);
  });

  it('类型不符 → 400，不落盘', async () => {
    const { store, calls, put } = setup();
    const r = await put({ name: true });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/name/);
    expect(store.name).toBe('Aalis');
    expect(calls).toEqual([]);
  });

  it('加了引号的数字与写成数字的名称照收，文档里存换算后的值（启动时直接读这几个键）', async () => {
    const { store, calls, put } = setup();
    const r = await put({ slowThresholdMs: ' 30000 ', name: 5 });
    expect(r.status).toBe(200);
    expect(store.slowThresholdMs).toBe(30000);
    expect(store.name).toBe('5');
    expect(calls).toEqual(['save']);
  });
  it('宿主拒写 → 409、撤回文档里的改动（返回时已落盘的契约在消费侧兑现）', async () => {
    const { store, calls, put } = setup({
      save: async () => {
        throw new ConfigSaveRefusedError('配置文件有尚未生效的外部修改');
      },
    });
    const out = await put({ logLevel: 'debug' });
    expect(out.status).toBe(409);
    expect((out.body as { error: string }).error).toBe(
      '未写入配置文件（配置文件有尚未生效的外部修改），本次修改已撤回',
    );
    expect(store.logLevel).toBe('info');
    expect(calls).not.toContain('restart');
  });

  it('写入失败（非拒写）→ 500，同样撤回文档里的改动', async () => {
    const { store, calls, put } = setup({
      save: async () => {
        throw new Error('disk full');
      },
    });
    const out = await put({ name: 'Bot', logLevel: 'debug' });
    expect(out.status).toBe(500);
    expect((out.body as { error: string }).error).toBe('未写入配置文件（disk full），本次修改已撤回');
    expect(store).toMatchObject({ name: 'Aalis', logLevel: 'info' });
    expect(calls).not.toContain('restart');
  });
});

describe('另一份 api-host-config 抛出的拒写与本包的同样认', () => {
  it('另一份 api-host-config 抛出的拒写：PUT /api/config 同样回 409，不当成写入失败', async () => {
    const { put } = setup({
      save: async () => {
        throw new ForeignCopyRefusedError('配置文件有尚未生效的外部修改');
      },
    });
    expect((await put({ logLevel: 'debug' })).status).toBe(409);
  });

  it('另一份 api-host-config 抛出的拒写：管理动作的落盘（saveAfterApply）同样回 409 并按文件对账', async () => {
    const out: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(payload: unknown) {
        out.body = payload;
        return res;
      },
    };
    const doc = {
      save: async () => {
        throw new ForeignCopyRefusedError('配置文件有尚未生效的外部修改');
      },
    };
    expect(await saveAfterApply(doc, res as never, 'reload')).toBe(false);
    expect(out).toEqual({
      status: 409,
      body: {
        error: '已在运行态生效，但未写入配置文件（配置文件有尚未生效的外部修改）；修好该文件后会按文件内容重载',
        applied: true,
      },
    });
  });
});
