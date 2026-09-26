import type { AppService, PluginManagerService, ServiceRef } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { ConfigSaveRefusedError, type HostConfig } from '../../packages/api-host-config/src/index.js';
import { registerPluginRoutes, saveAfterApply } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// PUT /api/config 只应用 CORE_CONFIG_SCHEMA 的键（name / logLevel）。其余顶层键一律不应用，但真有改动的
// 要在响应里点名——不能静默丢弃却回复「已保存」（文档曾把 commandPrefix 记成顶层字段，用户照抄后 API 回 ok
// 但什么都没发生）。也不能按键报 400：内置前端会把整份配置连同可能过期的 plugins 快照一起回传。
// 路由注册器只调用 app.<method>(path, ...handlers)，这里用记录处理器的假 app 直接调用，不起端口。

/** 进程里另一份 @aalis/api-host-config 的拒写类：类身份不同，名字相同 */
class ForeignCopyRefusedError extends Error {
  override name = 'ConfigSaveRefusedError';
}

/** 最小 ServiceRef 桩：路由只经 current / require 取提供者 */
function ref<T>(instance: unknown): ServiceRef<T> {
  return { current: instance as T, require: () => instance as T, all: () => [], follow: () => () => {} };
}

function setup(opts: { save?: () => Promise<void> } = {}) {
  const store: Record<string, unknown> = {
    name: 'Aalis',
    logLevel: 'info',
    plugins: { '@aalis/plugin-x': { a: 1 } },
    disabledPlugins: [],
  };
  const calls: string[] = [];
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
      app: ref<AppService>({ restart: () => calls.push('restart') }),
      source: { current: undefined },
      plugins: ref<PluginManagerService>({}),
      hostConfig: ref<HostConfig>(hostConfig),
      tools: { current: undefined },
      commands: { current: undefined },
      webui: () => undefined,
    },
    () => ({ platform: 'webui', userId: 'console' }),
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    () => undefined,
  );
  const put = (body: unknown) => invoke('PUT /api/config', { body, headers: {} });
  const saveToDisk = () => invoke('POST /api/config/save', { body: {}, headers: {} });
  return { store, calls, put, saveToDisk };
}

describe('PUT /api/config 顶层键白名单', () => {
  it('不可改的键 → 不写入，但在响应里点名', async () => {
    const { store, calls, put } = setup();
    const r = await put({ commandPrefix: '!' });
    expect(r.status).toBe(200);
    expect((r.body as { ignored: string[] }).ignored).toEqual(['commandPrefix']);
    expect((r.body as { message: string }).message).toMatch(/已忽略.*commandPrefix/);
    expect(store.commandPrefix).toBeUndefined();
    expect(calls).toEqual(['save']); // 仅保存，不重启
  });

  it('已知键 → 写入、保存并重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ logLevel: 'debug' });
    expect(r.status).toBe(200);
    expect(store.logLevel).toBe('debug');
    expect(calls).toEqual(['save', 'restart']);
  });

  it('内置前端的真实请求体：整份回显 GET 的配置 + _schema，只改了 logLevel → 放行', async () => {
    const { store, calls, put } = setup();
    const r = await put({ ...structuredClone(store), _schema: { name: {}, logLevel: {} }, logLevel: 'warn' });
    expect(r.status).toBe(200);
    expect(store.logLevel).toBe('warn');
    expect(calls).toEqual(['save', 'restart']);
  });

  it('整份回显且什么都没改 → 保存但不重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ ...structuredClone(store), _schema: {} });
    expect(r.status).toBe(200);
    expect(calls).toEqual(['save']);
  });

  it('可改键与改动了的不可改键混在一起 → 只应用可改键，另一个点名忽略', async () => {
    const { store, calls, put } = setup();
    const r = await put({ logLevel: 'debug', disabledPlugins: ['@aalis/plugin-x'] });
    expect(r.status).toBe(200);
    expect(store.logLevel).toBe('debug');
    expect(store.disabledPlugins).toEqual([]);
    expect((r.body as { ignored: string[] }).ignored).toEqual(['disabledPlugins']);
    expect(calls).toEqual(['save', 'restart']);
  });

  it('过期快照回显（插件配置页保存后未刷新全局 config）不该失败', async () => {
    const { store, calls, put } = setup();
    const stale = {
      ...structuredClone(store),
      plugins: { '@aalis/plugin-x': { a: 0 } },
      _schema: {},
      logLevel: 'warn',
    };
    const r = await put(stale);
    expect(r.status).toBe(200);
    expect(store.logLevel).toBe('warn');
    expect(store.plugins).toEqual({ '@aalis/plugin-x': { a: 1 } }); // 服务端当前值不被过期快照覆盖
    expect((r.body as { ignored: string[] }).ignored).toEqual(['plugins']);
    expect(calls).toEqual(['save', 'restart']);
  });
});

describe('PUT /api/config 何时重启', () => {
  // logLevel 只在启动时读取；name 由 /api/status 每次实时读文档（装有人设时显示人设名），不值得整进程重启
  it('只改 name → 保存即生效，不重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ name: 'Bot' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: '全局配置已更新并保存', ignored: [] });
    expect(store.name).toBe('Bot');
    expect(calls).toEqual(['save']);
  });

  it('name 与 logLevel 一起改 → 保存并重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ name: 'Bot', logLevel: 'debug' });
    expect(r.status).toBe(200);
    expect((r.body as { restart?: boolean }).restart).toBe(true);
    expect(store).toMatchObject({ name: 'Bot', logLevel: 'debug' });
    expect(calls).toEqual(['save', 'restart']);
  });
});

describe('PUT /api/config 值校验', () => {
  it('select 取值不在范围（logLevel: nope）→ 400，不落盘、不重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ logLevel: 'nope' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/logLevel/);
    expect(store.logLevel).toBe('info');
    expect(calls).toEqual([]);
  });

  it('类型不符 → 400，不落盘、不重启', async () => {
    const { store, calls, put } = setup();
    const r = await put({ name: 5 });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/name/);
    expect(store.name).toBe('Aalis');
    expect(calls).toEqual([]);
  });
  it('宿主拒写 → 409、撤回文档里的改动且不重启（返回时已落盘的契约在消费侧兑现）', async () => {
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

  it('写入失败（非拒写）→ 500，同样撤回文档里的改动且不重启', async () => {
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

describe('拒写与写入失败的区分：POST /api/config/save 与其它落盘路由同一口径', () => {
  it('落盘成功 → 200', async () => {
    const { calls, saveToDisk } = setup();
    const r = await saveToDisk();
    expect(r).toEqual({ status: 200, body: { ok: true, message: '配置已保存到磁盘' } });
    expect(calls).toEqual(['save']);
  });

  it.each([
    ['本包的拒写类', ConfigSaveRefusedError],
    ['另一份 api-host-config 的同名类', ForeignCopyRefusedError],
  ] as const)('宿主拒写（%s）→ 409', async (_label, Refused) => {
    const { saveToDisk } = setup({
      save: async () => {
        throw new Refused('配置文件有尚未生效的外部修改');
      },
    });
    expect(await saveToDisk()).toEqual({ status: 409, body: { error: '配置文件有尚未生效的外部修改' } });
  });

  it('写入失败（非拒写）→ 500', async () => {
    const { saveToDisk } = setup({
      save: async () => {
        throw new Error('disk full');
      },
    });
    expect(await saveToDisk()).toEqual({ status: 500, body: { error: 'disk full' } });
  });

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
        error: '已在运行态生效，但未写入配置文件（配置文件有尚未生效的外部修改）；修好配置文件后会按文件内容重载',
        applied: true,
      },
    });
  });
});
