import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  type BoundOf,
  definePlugin,
  defineService,
  type Logger,
  provide,
  type ServiceSelection,
} from '../../packages/core/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 本插件偏好的管理面：POST / DELETE /api/plugins/:instanceId/services/:name/prefer 与全局偏好的路由同一套校验，
// 改运行态（只对那个插件）并写进配置文档落盘；插件列表的每项带它的本插件偏好
// ════════════════════════════════════════════════════════════

const TOKEN = 'plugin-prefer-test-token-00000000';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

interface Who {
  who(): string;
}
const svc = defineService<Who>('zz-svc');
const providers = [
  ['zz-a', 10],
  ['zz-b', 0],
].map(([name, priority]) =>
  definePlugin({
    name: name as string,
    provides: [svc],
    uses: { provide },
    apply({ provide }) {
      provide.use(svc, { who: () => name as string }, { priority: priority as number });
    },
  }),
);

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function start() {
  const saved: unknown[] = [];
  const { app, store } = hostedApp({}, { logger: silent, provider: { save: doc => void saved.push(doc) } });
  apps.push(app);
  for (const definition of providers) await app.plugin(definition);
  const selections: Record<string, ServiceSelection<Who>> = {};
  for (const name of ['zz-picky', 'zz-plain']) {
    const uses = { svc };
    await app.plugin(
      definePlugin({
        name,
        uses,
        apply(caps: BoundOf<typeof uses>) {
          selections[name] = caps.svc;
        },
      }),
    );
  }
  const port = await freePort();
  await app.plugin(webuiServerPlugin, {
    host: '127.0.0.1',
    port,
    autoOpen: false,
    tokenMode: 'fixed',
    fixedToken: TOKEN,
  });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { cookie: `aalis_webui_token=${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const chosen = (name: string) => selections[name].list().find(p => p.selected)?.id;
  /** 插件列表里这个插件的本插件偏好（或给的另一项） */
  const listed = async (name: string, field = 'servicePreferences') =>
    ((await call('GET', '/api/plugins')).body.plugins as Array<Record<string, unknown>>).find(
      p => p.instanceId === name,
    )?.[field];
  return { store, saved, call, chosen, listed };
}

describe('本插件偏好的 REST', () => {
  it('设：只对那个插件生效，写进文档并落盘，插件列表里看得到；清：回到全局的选择', async () => {
    const { store, saved, call, chosen, listed } = await start();
    const path = '/api/plugins/zz-picky/services/zz-svc/prefer';

    expect(await call('POST', path, { contextId: 'zz-b' })).toEqual({ status: 200, body: { ok: true } });
    expect([chosen('zz-picky'), chosen('zz-plain')]).toEqual(['zz-b', 'zz-a']);
    expect(store.getServicePreferences({ for: 'zz-picky' })).toEqual({ 'zz-svc': 'zz-b' });
    expect(store.getServicePreferences()).toEqual({});
    expect(saved).toHaveLength(1);
    expect(await listed('zz-picky')).toEqual({ 'zz-svc': 'zz-b' });
    expect(await listed('zz-plain')).toEqual({});

    expect(await call('DELETE', path)).toEqual({ status: 200, body: { ok: true } });
    expect(chosen('zz-picky')).toBe('zz-a');
    expect(store.getServicePreferences({ for: 'zz-picky' })).toEqual({});
    expect(saved).toHaveLength(2);
    expect(await listed('zz-picky')).toEqual({});
  });

  it('插件列表的每项带它声明的服务此刻落到的那一家与依据', async () => {
    const { call, listed } = await start();
    await call('POST', '/api/plugins/zz-picky/services/zz-svc/prefer', { contextId: 'zz-b' });
    expect(await listed('zz-picky', 'serviceSelections')).toEqual({ 'zz-svc': { contextId: 'zz-b', basis: 'plugin' } });
    expect(await listed('zz-plain', 'serviceSelections')).toEqual({ 'zz-svc': { contextId: 'zz-a', basis: 'rank' } });
  });

  it('没给 contextId 回 400；插件或提供者不在回 404，运行态与文档都不动', async () => {
    const { store, call, chosen } = await start();
    expect((await call('POST', '/api/plugins/zz-picky/services/zz-svc/prefer', {})).status).toBe(400);
    expect((await call('POST', '/api/plugins/zz-gone/services/zz-svc/prefer', { contextId: 'zz-b' })).status).toBe(404);
    expect((await call('POST', '/api/plugins/zz-picky/services/zz-svc/prefer', { contextId: 'zz-c' })).status).toBe(
      404,
    );
    expect(chosen('zz-picky')).toBe('zz-a');
    expect(store.getAll().pluginServicePreferences).toBeUndefined();
  });
});
