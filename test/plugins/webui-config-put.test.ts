import type { AppService, PluginManagerService, ServiceRef } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { HostConfig } from '../../packages/api-host-config/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';

// PUT /api/config 只应用 CORE_CONFIG_SCHEMA 的键（name / logLevel）。其余顶层键一律不应用，但真有改动的
// 要在响应里点名——不能静默丢弃却回复「已保存」（文档曾把 commandPrefix 记成顶层字段，用户照抄后 API 回 ok
// 但什么都没发生）。也不能按键报 400：内置前端会把整份配置连同可能过期的 plugins 快照一起回传。
// 路由注册器只调用 app.<method>(path, ...handlers)，这里用记录处理器的假 app 直接调用，不起端口。

type Handler = (req: unknown, res: unknown, next: () => Promise<void>) => unknown;

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
  const routes = new Map<string, Handler[]>();
  const app = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (path: string, ...handlers: Handler[]) => {
          routes.set(`${method.toUpperCase()} ${path}`, handlers);
        },
    },
  );
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
    app as never,
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
  const put = async (body: unknown) => {
    const handlers = routes.get('PUT /api/config');
    if (!handlers) throw new Error('PUT /api/config 未注册');
    const out: { status: number; body?: unknown } = { status: 200 };
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
    let i = 0;
    const next = async (): Promise<void> => {
      const h = handlers[i++];
      if (h) await h({ body, headers: {} }, res, next);
    };
    await next();
    return out;
  };
  return { store, calls, put };
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
    const stale = { ...structuredClone(store), plugins: { '@aalis/plugin-x': { a: 0 } }, _schema: {}, name: 'Bot' };
    const r = await put(stale);
    expect(r.status).toBe(200);
    expect(store.name).toBe('Bot');
    expect(store.plugins).toEqual({ '@aalis/plugin-x': { a: 1 } }); // 服务端当前值不被过期快照覆盖
    expect((r.body as { ignored: string[] }).ignored).toEqual(['plugins']);
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
  it('save 拒绝 → 500 且不重启（返回时已落盘的契约在消费侧兑现）', async () => {
    const { calls, put } = setup({
      save: async () => {
        throw new Error('disk full');
      },
    });
    const out = await put({ logLevel: 'debug' });
    expect(out.status).toBe(500);
    expect(calls).not.toContain('restart');
  });
});
