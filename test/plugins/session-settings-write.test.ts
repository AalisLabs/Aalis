import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HostConfig, hostConfig, ownHostConfig } from '../../packages/api-host-config/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  isSessionSettingsError,
  sessionFields,
  sessionSettings,
} from '../../packages/api-session-settings/src/index.js';
import { App, config, definePlugin, optional, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { fieldsPlugin, ONEBOT_TYPES, SCHEMA, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 写入：全部校验在提供者的 update 里，不判门槛。全局层的普通字段在最新文档上只改这一个键再落盘，不经 updateConfig 与
// applyPluginConfig，插件不重载；写了 preference 的字段改声明它的插件的本插件偏好（运行态与文档），没有提供者的 contextId
// 拒收。平台档、平台类型档改宿主文档的 sessionConfig。写宿主文档的几层落盘失败不撤回，带回 saveError。
// 场所与本会话写进会话管理的记录，写完发 session-settings:changed；宿主文档的变化只由宿主发 host-config:changed。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(options: Parameters<typeof startSettings>[0] = {}) {
  const started = await startSettings({ adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }], ...options });
  apps.push(started.app);
  return started;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const rejectedWith = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isSessionSettingsError(err), String(err)).toBe(true);
};

describe('全局层', () => {
  it('普通字段：在最新文档上只改这一个键并落盘，不调 updateConfig 与 applyPluginConfig，插件不重载；插件详情读到同一个值', async () => {
    let applies = 0;
    const plugin = definePlugin({
      name: 'zz-a',
      configSchema: SCHEMA,
      uses: { sessionFields: optional(sessionFields), document: optional(ownHostConfig), config },
      apply(caps) {
        applies++;
        caps.sessionFields.use.fields(SCHEMA, caps);
      },
    });
    const saves: unknown[] = [];
    const { app, admin, doc, host } = await setup({
      doc: { plugins: { 'zz-a': { note: '<备注>', persona: '<人设>' } } },
      fields: [plugin],
      save: async config => void saves.push(structuredClone(config.plugins['zz-a'])),
    });
    const provider = host.services.use.get(hostConfig) as HostConfig;
    const update = vi.spyOn(app.plugins, 'updateConfig');
    const apply = vi.spyOn(provider, 'applyPluginConfig');

    const result = await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-a', key: 'iterations', value: 50 });
    expect(result).toEqual({});
    expect(doc.getPluginConfig('zz-a')).toEqual({ note: '<备注>', persona: '<人设>', iterations: 50 });
    expect(saves.at(-1)).toEqual({ note: '<备注>', persona: '<人设>', iterations: 50 });
    // null 即恢复默认：有 default 的写回 default
    await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-a', key: 'persona', value: null });
    expect(doc.getPluginConfig('zz-a').persona).toBe('default');
    expect(update).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(applies).toBe(1);
  });

  it('bounce 进行中写同一实例的带标记字段：不调 updateConfig 与 applyPluginConfig，写下的值留在文档里', async () => {
    let hold: Promise<void> | undefined;
    const entered = deferred();
    const plugin = definePlugin({
      name: 'zz-a',
      configSchema: SCHEMA,
      uses: { sessionFields: optional(sessionFields), document: optional(ownHostConfig), config },
      async apply(caps) {
        caps.sessionFields.use.fields(SCHEMA, caps);
        if (!hold) return;
        entered.resolve();
        await hold;
      },
    });
    const { app, admin, doc, host } = await setup({ fields: [plugin] });
    const update = vi.spyOn(app.plugins, 'updateConfig');
    const apply = vi.spyOn(host.services.use.get(hostConfig) as HostConfig, 'applyPluginConfig');
    const release = deferred();
    hold = release.promise;
    const bouncing = app.plugins.bounce('zz-a');
    await entered.promise;
    await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-a', key: 'iterations', value: 40 });
    release.resolve();
    await bouncing;
    await app.plugins.idle();
    expect(update).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(doc.getPluginConfig('zz-a').iterations).toBe(40);
    expect(app.plugins.getPlugin('zz-a')?.state).toBe('active');
  });

  it('落盘失败不撤回：内存里的文档已改，带回 saveError', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const failure = new Error('<写不进去>');
    const { admin, doc } = await setup({
      fields: [a.definition],
      save: async () => {
        throw failure;
      },
    });
    const result = await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-a', key: 'iterations', value: 9 });
    expect(result.saveError).toBe(failure);
    expect(doc.getPluginConfig('zz-a').iterations).toBe(9);
    expect(a.reader().get().iterations).toBe(9);
  });

  it('写了 preference 的字段：改声明它的插件的本插件偏好（运行态与文档），null 取消；没有提供者的 contextId 拒收', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const { admin, doc, host } = await setup({ fields: [a.definition], models: [['zz-llm', 'm1']] });
    const llm = { provider: 'zz-llm', model: 'm1' };
    await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-a', key: 'llm', value: llm });
    expect(host.services.use.preferred('llm', { for: 'zz-a' })).toBe('zz-llm/m1');
    expect(doc.getServicePreferences({ for: 'zz-a' })).toEqual({ llm: 'zz-llm/m1' });
    expect(host.services.use.preferred('llm'), '全局偏好不动').toBeUndefined();
    const row = admin.rows({ layer: { scope: 'global' } }).find(r => r.plugin === 'zz-a' && r.key === 'llm');
    expect(row).toMatchObject({ value: llm, effective: llm, source: 'global' });
    expect(doc.getPluginConfig('zz-a').llm, '不写进插件配置').toBeUndefined();

    await rejectedWith(
      admin.update(
        { layer: { scope: 'global' } },
        { plugin: 'zz-a', key: 'llm', value: { provider: 'zz-llm', model: '<没有>' } },
      ),
    );
    expect(host.services.use.preferred('llm', { for: 'zz-a' })).toBe('zz-llm/m1');

    await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-a', key: 'llm', value: null });
    expect(host.services.use.preferred('llm', { for: 'zz-a' })).toBeUndefined();
    expect(doc.getServicePreferences({ for: 'zz-a' })).toEqual({});
  });
});

describe('宿主文档里的两层', () => {
  it('平台档与平台类型档按实例嵌套写进 sessionConfig，没有类型档；空了的段删掉；落盘失败不撤回、带回 saveError', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    let fail = false;
    const { admin, doc } = await setup({
      fields: [a.definition],
      save: async () => {
        if (fail) throw new Error('<写不进去>');
      },
    });
    const item = (key: string, value: unknown) => ({ plugin: 'zz-a', key, value });
    await admin.update({ layer: { scope: 'platform', platform: 'onebot' } }, item('iterations', 5));
    await admin.update(
      { layer: { scope: 'platformType', platform: 'onebot', type: 'group' } },
      item('persona', '<群>'),
    );
    await admin.update({ layer: { scope: 'platformType', platform: 'onebot', type: 'private' } }, item('plain', true));
    await rejectedWith(admin.update({ layer: { scope: 'type', type: 'group' } as never }, item('persona', '<类型>')));
    expect(doc.get('sessionConfig')).toEqual({
      platforms: { onebot: { 'zz-a': { iterations: 5 } } },
      platformTypes: { onebot: { group: { 'zz-a': { persona: '<群>' } }, private: { 'zz-a': { plain: true } } } },
    });
    await admin.update({ layer: { scope: 'platformType', platform: 'onebot', type: 'group' } }, item('persona', null));
    expect(doc.get('sessionConfig')).toEqual({
      platforms: { onebot: { 'zz-a': { iterations: 5 } } },
      platformTypes: { onebot: { private: { 'zz-a': { plain: true } } } },
    });

    fail = true;
    for (const layer of [
      { scope: 'platform', platform: 'onebot' },
      { scope: 'platformType', platform: 'onebot', type: 'group' },
    ] as const) {
      const result = await admin.update({ layer }, item('mode', 'off'));
      expect(result.saveError, layer.scope).toBeInstanceOf(Error);
    }
    expect(doc.get('sessionConfig')?.platformTypes?.onebot?.group).toEqual({ 'zz-a': { mode: 'off' } });
  });
});

describe('宿主文档里读不懂的部分', () => {
  it('写平台档、平台类型档只改这一层的这一项：不认识的段、名字不合写法的条目、不是对象的值与别的实例原样留着，告警照旧', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const unreadable = {
      types: { group: { 'zz-a': { persona: '<types 段>' } } },
      platfroms: { onebot: { 'zz-a': { persona: '<拼错的段>' } } },
      platforms: {
        'a:b': { 'zz-a': { persona: '<名字不合写法>' } },
        onebot: { 'zz-a': { mode: 'off' }, 'zz-gone': { persona: '<没装>' }, 'zz-bad': '<不是对象>' },
      },
      platformTypes: { onebot: { group: '<不是对象>', private: { 'zz-a': { plain: true } } } },
    };
    const { admin, doc, warns } = await setup({ doc: { sessionConfig: unreadable as never }, fields: [a.definition] });
    await admin.update(
      { layer: { scope: 'platform', platform: 'onebot' } },
      { plugin: 'zz-a', key: 'iterations', value: 5 },
    );
    await admin.update(
      { layer: { scope: 'platformType', platform: 'onebot', type: 'private' } },
      { plugin: 'zz-a', key: 'plain', value: null },
    );
    await admin.update(
      { layer: { scope: 'platformType', platform: 'zz-new', type: 'group' } },
      { plugin: 'zz-a', key: 'persona', value: '<新的>' },
    );
    expect(doc.get('sessionConfig')).toEqual({
      ...unreadable,
      platforms: {
        ...unreadable.platforms,
        onebot: { ...unreadable.platforms.onebot, 'zz-a': { mode: 'off', iterations: 5 } },
      },
      platformTypes: { onebot: { group: '<不是对象>' }, 'zz-new': { group: { 'zz-a': { persona: '<新的>' } } } },
    });
    // 读的时候照旧告警（写入不读整理后的文档）
    admin.layers();
    for (const part of ['sessionConfig.types', 'sessionConfig.platfroms', 'a:b', 'zz-gone', 'zz-bad']) {
      expect(
        warns.filter(w => w.includes(part)),
        part,
      ).toHaveLength(1);
    }
  });

  it('要写的那一处在文档里不是对象：拒收、文档不动', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const sessionConfig = { platformTypes: { onebot: { group: '<不是对象>' } } };
    const { admin, doc } = await setup({ doc: { sessionConfig: sessionConfig as never }, fields: [a.definition] });
    await rejectedWith(
      admin.update(
        { layer: { scope: 'platformType', platform: 'onebot', type: 'group' } },
        { plugin: 'zz-a', key: 'persona', value: '<群>' },
      ),
    );
    expect(doc.get('sessionConfig')).toEqual(sessionConfig);
  });

  it('留空的段（配置文件里只剩键名，读出来是 null）与没有同样处理：读的时候不告警，照写', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    for (const sessionConfig of [
      null,
      { platforms: null, platformTypes: { onebot: { group: null } } },
      { platforms: { onebot: { 'zz-a': null } }, platformTypes: null },
    ]) {
      const label = JSON.stringify(sessionConfig);
      const { admin, doc, warns } = await setup({
        doc: { sessionConfig: sessionConfig as never },
        fields: [a.definition],
      });
      admin.layers();
      expect(
        warns.filter(w => w.includes('sessionConfig')),
        label,
      ).toEqual([]);
      await admin.update(
        { layer: { scope: 'platform', platform: 'onebot' } },
        { plugin: 'zz-a', key: 'iterations', value: 5 },
      );
      await admin.update(
        { layer: { scope: 'platformType', platform: 'onebot', type: 'group' } },
        { plugin: 'zz-a', key: 'persona', value: '<群>' },
      );
      expect(doc.get('sessionConfig'), label).toEqual({
        platforms: { onebot: { 'zz-a': { iterations: 5 } } },
        platformTypes: { onebot: { group: { 'zz-a': { persona: '<群>' } } } },
      });
    }
  });
});

describe('校验', () => {
  it('没登记的实例、不带标记的字段、不合字段的值、不合法的层标识、不存在的会话与场所、不适用的目标都拒收', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const { admin, sm, inbound } = await setup({ fields: [a.definition] });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', userId: '30002' });
    const webui = await sm.createSession({}, { createdFrom: 'webui' });
    const item = (key: string, value: unknown, plugin = 'zz-a') => ({ plugin, key, value });
    const global = { layer: { scope: 'global' } } as const;
    await rejectedWith(admin.update(global, item('persona', 'x', 'zz-none')));
    await rejectedWith(admin.update(global, item('note', 'x')));
    await rejectedWith(admin.update(global, item('iterations', 0)));
    await rejectedWith(admin.update({ layer: { scope: 'platform', platform: 'a:b' } }, item('persona', 'x')));
    await rejectedWith(
      admin.update({ layer: { scope: 'platformType', platform: 'onebot', type: '*' } }, item('persona', 'x')),
    );
    await rejectedWith(admin.update({ layer: { scope: 'place', key: 'workspace:<没有>' } }, item('persona', 'x')));
    await rejectedWith(admin.update({ sessionId: '<没有的会话>' }, item('persona', 'x')));
    // 只能设到场所为止的项不收会话；只给房间的项不收 owner 会话与工作区场所
    await rejectedWith(admin.update({ sessionId: GROUP }, item('paperName', '<白纸>')));
    await rejectedWith(admin.update({ sessionId: webui.id }, item('language', ['zh-CN'])));
    await rejectedWith(
      admin.update({ layer: { scope: 'place', key: 'workspace:default' } }, item('language', ['zh-CN'])),
    );
    // 照收的
    await admin.update({ layer: { scope: 'place', key: WINDOW } }, item('paperName', '<白纸>'));
    await admin.update({ sessionId: GROUP }, item('language', ['zh-CN']));
    expect(a.reader().get(GROUP, { platform: 'onebot' })).toMatchObject({ paperName: '<白纸>', language: ['zh-CN'] });
  });
});

describe('事件', () => {
  it('写场所与本会话、字段登记与撤回、会话增删发 session-settings:changed；写宿主文档的几层与偏好不发，host-config:changed 只一次', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const { app, admin, sm, host, inbound } = await setup({ fields: [a.definition], models: [['zz-llm', 'm1']] });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', userId: '30002' });
    const webui = await sm.createSession({}, { createdFrom: 'webui' });
    let settings = 0;
    const hostChanges: unknown[] = [];
    host.events.use.on('session-settings:changed', () => void settings++);
    host.events.use.on('host-config:changed', change => void hostChanges.push(change));
    const item = (key: string, value: unknown) => ({ plugin: 'zz-a', key, value });

    await admin.update({ layer: { scope: 'global' } }, item('iterations', 3));
    await admin.update({ layer: { scope: 'platform', platform: 'onebot' } }, item('iterations', 4));
    await admin.update({ layer: { scope: 'global' } }, item('llm', { provider: 'zz-llm', model: 'm1' }));
    expect(settings).toBe(0);
    expect(hostChanges).toEqual([{ instanceId: 'zz-a' }, { document: true }, { document: true }]);

    await admin.update({ layer: { scope: 'place', key: WINDOW } }, item('persona', '<场所>'));
    expect(settings).toBe(1);
    await admin.update({ sessionId: webui.id }, item('persona', '<会话>'));
    expect(settings).toBe(2);
    await app.plugins.disable('zz-a');
    expect(settings).toBe(3);
    await app.plugins.enable('zz-a');
    expect(settings).toBe(4);
    const created = await sm.createSession({}, { createdFrom: 'webui' });
    expect(settings).toBe(5);
    await sm.deleteSession(created.id);
    expect(settings).toBe(6);
  });
});

describe('存放', () => {
  it('场所与本会话写进会话管理的记录、随它落盘，不进宿主文档', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const { admin, sm, doc, mem, inbound } = await setup({ fields: [a.definition] });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', userId: '30002' });
    await admin.update({ layer: { scope: 'place', key: WINDOW } }, { plugin: 'zz-a', key: 'persona', value: '<场所>' });
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-a', key: 'persona', value: '<会话>' });
    const entries = (value: string) => ({
      'session-settings': { values: [{ plugin: 'zz-a', key: 'persona', value }] },
    });
    expect(sm.getPlace(WINDOW)?.metadata).toEqual(entries('<场所>'));
    await expect.poll(() => mem.places.get(WINDOW)?.metadata).toEqual(entries('<场所>'));
    await expect.poll(() => mem.meta.get(GROUP)?.metadata).toEqual(entries('<会话>'));
    expect(doc.get('sessionConfig')).toBeUndefined();
  });

  it('宿主没有提供配置文档：平台档与平台类型档为空，写全局层与这两层被拒，场所与本会话照写', async () => {
    const a = fieldsPlugin('zz-a', SCHEMA);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager, sessionSettings });
    host.provide.use(memory, fakeMemory() as never);
    await app.plugin(sessionManagerPlugin);
    await app.plugin(sessionSettingsPlugin);
    await app.plugin(a.definition, { persona: '<插件配置>' });
    await app.plugins.idle();
    const admin = host.sessionSettings.use;
    const { id } = await host.sessionManager.use.createSession({}, { createdFrom: 'webui' });
    const item = { plugin: 'zz-a', key: 'persona', value: '<值>' };
    await rejectedWith(admin.update({ layer: { scope: 'global' } }, item));
    await rejectedWith(admin.update({ layer: { scope: 'platform', platform: 'webui' } }, item));
    await rejectedWith(admin.update({ layer: { scope: 'platformType', platform: 'onebot', type: 'group' } }, item));
    expect(a.reader().get(id, { platform: 'webui' }).persona).toBe('<插件配置>');
    await admin.update({ sessionId: id }, item);
    expect(a.reader().get(id, { platform: 'webui' }).persona).toBe('<值>');
  });
});
