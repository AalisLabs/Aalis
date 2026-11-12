import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { type AalisConfig, type HostConfigChange, hostConfig } from '../../packages/api-host-config/src/index.js';
import { type App, config, definePlugin, defineService, LogHub, lifecycle } from '../../packages/core/src/index.js';
import type { ConfigProvider } from '../../packages/runtime/src/config-store.js';
import {
  handleConfigChanged,
  installConfigHotReload,
  withPluginConfigSync,
} from '../../packages/runtime/src/config-sync.js';
import { createPluginDiscovery, type PluginLoader } from '../../packages/runtime/src/plugin-discovery.js';
import type { ConfigSchema, SchemaField } from '../../packages/schema-config/src/index.js';
import { hostedApp, registerFromDoc, type TempConfigHandle, tempConfig } from '../fixtures/app.js';
import { provideEvents } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';
import { settle, waitFor } from '../helpers/fs-watch.js';

// ════════════════════════════════════════════════════════════
// 宿主配置与可按会话覆盖的字段（runtime 的 config-store、config-sync）
//
// 顶层带 session 的字段不进运行态：resolvePluginConfig 剥掉它们，登记、热重载与 applyPluginConfig 拿到的都是剥掉之后的配置，
// 只改这类字段时实例不重载。宿主文档在内存里确实变了时发 host-config:changed：改一个实例的配置段带 instanceId，其余带 document。
// ════════════════════════════════════════════════════════════

const field = (extra: Record<string, unknown>) => ({ label: 'F', ...extra }) as SchemaField;

/** 一个普通字段加一个可按会话覆盖的字段 */
const SCHEMA: ConfigSchema = {
  known: field({ type: 'number', default: 0 }),
  mood: field({ type: 'string', default: 'calm', session: {} }),
};

const NO_PLUGINS: PluginLoader = { discover: async () => [], load: async () => null };

const apps: App[] = [];
const temps: TempConfigHandle[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const temp of temps.splice(0)) temp.cleanup();
  vi.restoreAllMocks();
});

function world(doc: Partial<AalisConfig>, provider?: ConfigProvider) {
  const w = hostedApp(doc, { provider });
  provideEvents(w.app);
  apps.push(w.app);
  const changes: HostConfigChange[] = [];
  w.app.bind({ events }).events.use.on('host-config:changed', change => void changes.push(change));
  const host = w.app.bind({ hostConfig }).hostConfig.use;
  return { ...w, changes, host };
}

/** 读 schema 的插件：数 apply 次数，记下每次拿到的配置 */
function probe(name: string, apply?: () => void | Promise<void>) {
  const seen: Record<string, unknown>[] = [];
  const definition = definePlugin({
    name,
    configSchema: SCHEMA,
    uses: { config },
    async apply({ config: value }) {
      seen.push(structuredClone(value.use));
      await apply?.();
    },
  });
  return { definition, seen };
}

describe('运行态不含带标记的字段', () => {
  it('登记之后 entry.config 与插件拿到的配置里没有带标记的键，文档里照旧有', async () => {
    const w = world({ plugins: { p: { known: 1, mood: 'sunny' } } });
    const p = probe('p');
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('p')?.config).toEqual({ known: 1 });
    expect(p.seen).toEqual([{ known: 1 }]);
    expect(w.store.getPluginConfig('p')).toEqual({ known: 1, mood: 'sunny' });
  });
});

describe('applyPluginConfig：只改带标记字段时不重载', () => {
  it.each([
    'active',
    'pending',
    'activating',
  ] as const)('%s 态：回 reloaded: false、不调 updateConfig，文档照写', async state => {
    const w = world({ plugins: { p: { known: 1, mood: 'sunny' } } });
    const hold = deferred();
    const entered = deferred();
    const definition =
      state === 'pending'
        ? definePlugin({
            name: 'p',
            configSchema: SCHEMA,
            uses: { missing: defineService<object>('hcs-missing') },
            apply() {},
          })
        : probe('p', async () => {
            if (state !== 'activating') return;
            entered.resolve();
            await hold.promise;
          }).definition;
    const registering = registerFromDoc(w.app, w.store, definition);
    if (state === 'activating') await entered.promise;
    else await registering;
    expect(w.app.plugins.getPlugin('p')?.state, '前提').toBe(state);
    const update = vi.spyOn(w.app.plugins, 'updateConfig');

    const result = await w.host.applyPluginConfig('p', { known: 1, mood: 'stormy' });
    expect(result).toEqual({ status: 'applied', reloaded: false });
    expect(update).not.toHaveBeenCalled();
    expect(w.store.getPluginConfig('p')).toEqual({ known: 1, mood: 'stormy' });
    expect(w.app.plugins.getPlugin('p')?.config).toEqual({ known: 1 });
    hold.resolve();
    await registering;
  });

  it('error 态照旧走 updateConfig 重试激活', async () => {
    const w = world({ plugins: { p: { known: 1, mood: 'sunny' } } });
    let fail = true;
    const p = probe('p', () => {
      if (fail) throw new Error('zz-boom');
    });
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('p')?.state, '前提').toBe('error');
    const update = vi.spyOn(w.app.plugins, 'updateConfig');
    fail = false;

    const result = await w.host.applyPluginConfig('p', { known: 1, mood: 'stormy' });
    await w.app.plugins.idle();
    expect(result).toEqual({ status: 'applied', reloaded: true });
    expect(update).toHaveBeenCalledWith('p', { known: 1 });
    expect(w.app.plugins.getPlugin('p')?.state).toBe('active');
  });

  it('正在卸载（disposed）时回 refused：文档不改、不发', async () => {
    const w = world({ plugins: { p: { known: 1, mood: 'sunny' } } });
    const draining = deferred();
    const release = deferred();
    await registerFromDoc(
      w.app,
      w.store,
      definePlugin({
        name: 'p',
        configSchema: SCHEMA,
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onDrain(() => {
            draining.resolve();
            return release.promise;
          });
        },
      }),
    );
    await w.app.plugins.idle();
    const unloading = w.app.plugins.unload('p');
    await draining.promise;
    expect(w.app.plugins.getPlugin('p')?.state, '前提').toBe('disposed');

    expect(await w.host.applyPluginConfig('p', { known: 1, mood: 'stormy' })).toEqual({ status: 'refused' });
    expect(w.store.getPluginConfig('p')).toEqual({ known: 1, mood: 'sunny' });
    expect(w.changes).toEqual([]);
    release.resolve();
    await unloading;
  });
});

describe('host-config:changed', () => {
  it('五个写方法改了文档各发一次：改一个实例的配置段带 instanceId，其余带 document', () => {
    const w = world({ plugins: { p: { known: 1 } } });
    w.host.set('zz-key', { v: 1 });
    w.host.setPluginConfig('p', { known: 2 });
    w.host.setServicePreference('zz-svc', 'a');
    w.host.setServicePreference('zz-svc', 'b', { for: 'p' });
    w.host.removeServicePreference('zz-svc');
    w.host.removeServicePreference('zz-svc', { for: 'p' });
    w.host.removePluginConfig('p');
    expect(w.changes).toEqual([
      { document: true },
      { instanceId: 'p' },
      { document: true },
      { document: true },
      { document: true },
      { document: true },
      { instanceId: 'p' },
    ]);
  });

  it('写入与原值相同时不发；删掉不存在的配置段或偏好不发；setPluginEnabled 不发', () => {
    const w = world({
      plugins: { p: { known: 1 } },
      servicePreferences: { 'zz-svc': 'a' },
      pluginServicePreferences: { p: { 'zz-svc': 'b' } },
      'zz-key': { v: 1 },
    });
    w.host.set('zz-key', { v: 1 });
    w.host.set('name', 'T');
    w.host.setPluginConfig('p', { known: 1 });
    w.host.removePluginConfig('zz-absent');
    w.host.setServicePreference('zz-svc', 'a');
    w.host.setServicePreference('zz-svc', 'b', { for: 'p' });
    w.host.removeServicePreference('zz-absent');
    w.host.removeServicePreference('zz-absent', { for: 'p' });
    w.host.setPluginEnabled('p', false);
    w.host.setPluginEnabled('p', true);
    expect(w.changes).toEqual([]);
  });

  it('读出来就地改、再写回：照常发，文档换上改后的值', () => {
    const w = world({ plugins: { p: { known: 1 } }, 'zz-key': { v: 1 } });
    const value = w.host.get('zz-key') as { v: number };
    value.v = 2;
    w.host.set('zz-key', value);
    const section = w.host.getPluginConfig('p');
    section.known = 2;
    w.host.setPluginConfig('p', section);
    expect(w.changes).toEqual([{ document: true }, { instanceId: 'p' }]);
    expect(w.store.get('zz-key')).toEqual({ v: 2 });
    expect(w.store.getPluginConfig('p')).toEqual({ known: 2 });
  });

  it('set 存的是复制品：写完再改入参不动文档，再写回照常发', () => {
    const w = world({});
    const value = { v: 1 };
    w.host.set('zz-key', value);
    value.v = 2;
    expect(w.store.get('zz-key')).toEqual({ v: 1 });
    w.host.set('zz-key', value);
    expect(w.changes).toEqual([{ document: true }, { document: true }]);
    expect(w.store.get('zz-key')).toEqual({ v: 2 });
  });

  it('set 复制不了的值（函数）在写入方抛错：文档不动、不发，别的插件的读法不受连累', () => {
    const w = world({ 'zz-key': { v: 1 } });
    expect(() => w.host.set('zz-key', { fn: () => {} })).toThrow();
    expect(w.store.get('zz-key')).toEqual({ v: 1 });
    expect(w.changes).toEqual([]);
  });

  it('两个写入口同一个口径：外来对象里 JSON 解出的 __proto__ 等键不进文档，函数在写入方抛', () => {
    const w = world({ plugins: { p: { v: 1 } } });
    const polluted = JSON.parse('{"a":{"__proto__":{"x":1},"b":[{"constructor":2,"c":3}]}}') as Record<string, unknown>;
    w.host.set('zz-key', polluted);
    w.host.setPluginConfig('p', polluted);
    for (const doc of [w.store.get('zz-key'), w.store.getPluginConfig('p')]) {
      expect(JSON.stringify(doc)).toBe('{"a":{"b":[{"c":3}]}}');
    }
    expect(() => w.host.setPluginConfig('p', { fn: () => {} })).toThrow();
    expect(w.store.getPluginConfig('p')).toEqual({ a: { b: [{ c: 3 }] } });
  });

  it('applyPluginConfig 受理且文档变了时发一次，落盘失败也发；文档没变、refused 都不发', async () => {
    let failSave = false;
    const w = world(
      { plugins: { p: { known: 1, mood: 'sunny' } } },
      {
        save: () => {
          if (failSave) throw new Error('zz-disk-full');
        },
      },
    );
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();

    expect((await w.host.applyPluginConfig('p', { known: 2, mood: 'sunny' })).status).toBe('applied');
    expect(w.changes).toEqual([{ instanceId: 'p' }]);
    expect(await w.host.applyPluginConfig('p', { known: 2, mood: 'sunny' })).toEqual({
      status: 'applied',
      reloaded: false,
    });
    expect(w.changes, '文档没变').toHaveLength(1);

    failSave = true;
    const unsaved = await w.host.applyPluginConfig('p', { known: 2, mood: 'stormy' });
    expect(unsaved).toMatchObject({ status: 'applied', saveError: expect.any(Error) });
    expect(w.changes).toEqual([{ instanceId: 'p' }, { instanceId: 'p' }]);
    failSave = false;

    vi.spyOn(w.app.plugins, 'updateConfig').mockResolvedValue(false);
    expect(await w.host.applyPluginConfig('p', { known: 3, mood: 'stormy' })).toEqual({ status: 'refused' });
    expect(w.changes, '已登记的实例 refused').toHaveLength(2);
  });

  it('新建后缀实例：受理发一次；登记被拒、文档撤回时不发', async () => {
    const w = world({ plugins: { p: {} } });
    await registerFromDoc(
      w.app,
      w.store,
      definePlugin({ name: 'p', reusable: true, configSchema: SCHEMA, apply() {} }),
    );
    await w.app.plugins.idle();

    expect((await w.host.applyPluginConfig('p:a', { known: 1 })).status).toBe('applied');
    expect(w.changes).toEqual([{ instanceId: 'p:a' }]);
    vi.spyOn(w.app.plugins, 'register').mockResolvedValue(false);
    expect(await w.host.applyPluginConfig('p:b', { known: 1 })).toEqual({ status: 'refused' });
    expect(w.changes).toHaveLength(1);
  });

  it('加载插件时补写配置段（首批与之后的热加载都算）各发一次（带 instanceId）；配置段已齐时不发', async () => {
    const w = world({ plugins: { q: { known: 0, mood: 'calm' } } });
    const sync = withPluginConfigSync(w.app, w.store);
    sync.prepare([probe('p').definition, probe('q').definition]);
    sync.prepare([probe('r').definition]);
    expect(w.store.getPluginConfig('r')).toEqual({ known: 0, mood: 'calm' });
    expect(w.changes).toEqual([{ instanceId: 'p' }, { instanceId: 'r' }]);
  });
});

describe('热重载', () => {
  function watchedWorld(initial: Partial<AalisConfig>) {
    let push!: (next: AalisConfig) => void;
    const w = world(initial, {
      watch(onChange) {
        push = onChange;
        return () => {};
      },
    });
    const discovery = createPluginDiscovery(w.app, NO_PLUGINS, w.store);
    let reloading: Promise<void> = Promise.resolve();
    w.store.watch(previous => {
      reloading = handleConfigChanged(w.app, w.store, discovery, undefined, previous);
    });
    const reload = async (next: Partial<AalisConfig>) => {
      push({ name: 'T', logLevel: 'error', plugins: {}, ...next } as AalisConfig);
      await reloading;
      await w.app.plugins.idle();
    };
    return { ...w, reload };
  }

  it('换下文档之后发一次（带 document）；换进来的文档与原来相同时不发', async () => {
    const w = watchedWorld({ plugins: { p: { known: 1, mood: 'sunny' } } });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();

    await w.reload({ plugins: { p: { known: 1, mood: 'sunny' } } });
    expect(w.changes, '文档没变').toEqual([]);
    await w.reload({ plugins: { p: { known: 2, mood: 'sunny' } } });
    expect(w.changes).toEqual([{ document: true }]);
  });

  it('手改配置文件只动带标记字段：实例不重启，文档换上新值并通知', async () => {
    const w = watchedWorld({ plugins: { p: { known: 1, mood: 'sunny' } } });
    const p = probe('p');
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();
    const update = vi.spyOn(w.app.plugins, 'updateConfig');

    await w.reload({ plugins: { p: { known: 1, mood: 'stormy' } } });
    expect(update).not.toHaveBeenCalled();
    expect(p.seen).toHaveLength(1);
    expect(w.store.getPluginConfig('p')).toEqual({ known: 1, mood: 'stormy' });
    expect(w.changes).toEqual([{ document: true }]);
  });

  // 独有的是 installConfigHotReload 接上真实文件监听这一段；解析失败不投递本身由 config-provider-parse-guard 守着
  it('经文件监听：配置文件解析失败、文档没换时不发；改对之后发', async () => {
    const temp = tempConfig('name: T\nlogLevel: error\nplugins:\n  p: { known: 1 }\n');
    temps.push(temp);
    const w = world(temp.config, temp.provider);
    installConfigHotReload(w.app, w.store, createPluginDiscovery(w.app, NO_PLUGINS, w.store));
    const warns: string[] = [];
    const off = LogHub.default.onEntry(e => {
      if (e.level === 'warn' && e.scope === 'aalis:config') warns.push(e.message);
    });
    await settle();

    try {
      writeFileSync(temp.path, 'name: T\nplugins: [unclosed\n');
      // 坏内容确实被监听到、处理过（告警之后这次变更不再投递），再断言没发
      expect(await waitFor(() => warns.some(m => m.includes('解析失败')))).toBe(true);
      expect(w.changes).toEqual([]);
    } finally {
      off();
    }
    writeFileSync(temp.path, 'name: T\nlogLevel: error\nplugins:\n  p: { known: 2 }\n');
    expect(await waitFor(() => w.changes.length > 0)).toBe(true);
    expect(w.changes).toEqual([{ document: true }]);
  });
});

it('回归钉：bounce 进行中经 setPluginConfig 写同一实例的带标记字段，不调 updateConfig，运行态不变', async () => {
  const w = world({ plugins: { p: { known: 1, mood: 'sunny' } } });
  let hold: Promise<void> | undefined;
  const entered = deferred();
  const p = probe('p', async () => {
    if (!hold) return;
    entered.resolve();
    await hold;
  });
  await registerFromDoc(w.app, w.store, p.definition);
  await w.app.plugins.idle();
  const before = structuredClone(w.app.plugins.getPlugin('p')?.config);
  const update = vi.spyOn(w.app.plugins, 'updateConfig');

  const release = deferred();
  hold = release.promise;
  const bouncing = w.app.plugins.bounce('p');
  await entered.promise;
  w.host.setPluginConfig('p', { known: 1, mood: 'stormy' });
  release.resolve();
  await bouncing;
  await w.app.plugins.idle();

  expect(update).not.toHaveBeenCalled();
  expect(w.app.plugins.getPlugin('p')?.config).toEqual(before);
  expect(w.app.plugins.getPlugin('p')?.state).toBe('active');
});
