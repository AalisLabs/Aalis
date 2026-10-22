import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSessionFields,
  isSessionSettingsError,
  resolveFields,
  type SessionSettingsService,
  sessionFields,
  sessionSettings,
} from '../../packages/api-session-settings/src/index.js';
import { App } from '../../packages/core/src/index.js';
import type { ConfigSchema } from '../../packages/schema-config/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { ALL, fieldsPlugin, SCHEMA, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 读取器：插件在 apply 里调 fields() 拿到它，按会话读自己的带标记字段。全局值取宿主文档里本实例那一段的原样值（没有宿主文档
// 时取 caps.config），会话设置缺席时只取全局层，插件配置里的值照常生效；提供者在场时另取全局之上的各层。fields() 校验声明，
// 不合格的插件激活失败。读取器只写本实例、本会话层。两个门面同一个服务名，各自只交出声明过的成员。
// ════════════════════════════════════════════════════════════

const WEBUI = 'session-webui';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(options: Parameters<typeof startSettings>[0]) {
  const started = await startSettings(options);
  apps.push(started.app);
  return started;
}

/** 某个插件（日志作用域以它的实例 id 结尾）记下的告警 */
const warnsOf = (warns: string[], scope: string) => warns.filter(w => w.slice(1, w.indexOf(']')).endsWith(scope));

describe('全局层', () => {
  it('会话设置缺席：取宿主文档里本实例那一段，没写的取作者默认；运行态配置里没有这些键', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const { app } = await setup({
      settings: false,
      doc: { plugins: { 'zz-a': { note: '<改过的备注>', iterations: 50, persona: '<人设>' } } },
      fields: [A.definition],
    });
    expect(A.reader().get(WEBUI, { platform: 'webui' })).toEqual({
      persona: '<人设>',
      groups: [],
      iterations: 50,
      mode: 'card',
      plain: false,
      language: ['en'],
      paperName: '',
      scope: 'all',
    });
    expect(app.plugins.getPlugin('zz-a')?.config).toEqual({ note: '<改过的备注>' });
  });

  it('没有宿主文档：取 caps.config 里的同名键', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(A.definition, { iterations: 7 });
    await app.plugins.idle();
    expect(A.reader().get().iterations).toBe(7);
    expect(A.reader().get().persona).toBe('default');
  });

  it('非严格字段在插件配置里写坏了：行的 value 是原样值、effective 是作者默认、来源 default；读取器反复读只告警一次', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const { admin, warns } = await setup({ doc: { plugins: { 'zz-a': { iterations: 0 } } }, fields: [A.definition] });
    const row = admin.rows({ layer: { scope: 'global' } }).find(r => r.plugin === 'zz-a' && r.key === 'iterations');
    expect(row).toMatchObject({ value: 0, effective: 30, source: 'default' });
    for (let i = 0; i < 3; i++) expect(A.reader().get(WEBUI).iterations).toBe(30);
    expect(warnsOf(warns, 'zz-a').filter(w => w.includes('iterations'))).toHaveLength(1);
  });

  it('配置段里手写了全局层在服务偏好里的键：读取器不读它，告警一次', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const { warns } = await setup({
      doc: { plugins: { 'zz-a': { llm: { provider: 'zz-llm', model: 'm1' } } } },
      fields: [A.definition],
    });
    for (let i = 0; i < 3; i++) expect(A.reader().get(WEBUI).llm).toBeUndefined();
    expect(warnsOf(warns, 'zz-a').filter(w => w.includes('plugins.zz-a.llm'))).toHaveLength(1);
  });

  it('提供者在场但还没收到这个实例的登记：交出的各层照样完整', async () => {
    const { host } = await setup({
      doc: { plugins: {}, sessionConfig: { platforms: { webui: { 'zz-later': { persona: '<平台档人设>' } } } } },
    });
    const provider = host.services.use.get(sessionSettings) as SessionSettingsService;
    const chain = provider.chain('zz-later', WEBUI, { platform: 'webui' });
    expect(chain.parts).toEqual([expect.objectContaining({ layer: 'platform', values: { persona: '<平台档人设>' } })]);
    expect(resolveFields(SCHEMA, {}, chain, () => {}).values.persona).toBe('<平台档人设>');
  });
});

describe('fields() 校验声明', () => {
  const field = { type: 'string', label: '<项>', default: '' } as const;
  const spec = { appliesTo: ALL, prominence: 'common' } as const;
  it.each<[string, ConfigSchema]>([
    ['分组里的字段', { g: { fields: { x: { ...field, session: spec } } } }],
    ['数组元素里的字段', { a: { type: 'array', label: '<数组>', items: { x: { ...field, session: spec } } } }],
    ['带 secret', { x: { ...field, secret: true, session: spec } }],
    ['带 required', { x: { ...field, required: true, session: spec } }],
    ['外来类型没有 validate', { x: { type: 'llm-ref', label: '<项>', session: { ...spec, unset: '<没设>' } } }],
    ['没有 default 也没有 unset', { x: { type: 'string', label: '<项>', session: spec } }],
    ['unset 是空串', { x: { type: 'string', label: '<项>', session: { ...spec, unset: '' } } }],
    ['dependsOn 指向自己', { x: { ...field, dynamicOptions: 'zz', session: { ...spec, dependsOn: 'x' } } }],
    [
      'dependsOn 指向不带标记的字段',
      { y: field, x: { ...field, dynamicOptions: 'zz', session: { ...spec, dependsOn: 'y' } } },
    ],
    [
      'dependsOn 而没有 dynamicOptions',
      { y: { ...field, session: spec }, x: { ...field, session: { ...spec, dependsOn: 'y' } } },
    ],
    ['appliesTo 为空', { x: { ...field, session: { ...spec, appliesTo: [] } } }],
    ['appliesTo 有不认识的种类', { x: { ...field, session: { ...spec, appliesTo: ['guest' as never] } } }],
    ['prominence 不认识', { x: { ...field, session: { ...spec, prominence: 'loud' as never } } }],
    ['narrowest 不是 place', { x: { ...field, session: { ...spec, narrowest: 'session' as never } } }],
    ['minLevel 不是 1 或 2', { x: { ...field, session: { ...spec, minLevel: 3 as never } } }],
    [
      'preference 字段带 default',
      { x: { ...field, fromText: String, toText: String, session: { ...spec, preference: 'llm' } } },
    ],
    [
      'preference 字段没有 toText 与 fromText',
      { x: { type: 'string', label: '<项>', session: { ...spec, preference: 'llm', unset: '<没设>' } } },
    ],
  ])('%s：抛错点名字段', (_name, schema) => {
    expect(() => assertSessionFields(schema)).toThrow(TypeError);
  });

  it('合格的声明不抛；不合格的插件激活失败', async () => {
    expect(() => assertSessionFields(SCHEMA)).not.toThrow();
    const bad = fieldsPlugin('zz-bad', {
      x: { type: 'string', label: '<项>', session: { appliesTo: ALL, prominence: 'common' } },
    });
    const { app } = await setup({});
    await app.plugin(bad.definition);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('zz-bad')?.state).toBe('error');
  });
});

describe('读取器的 set', () => {
  it('只写本实例、本会话层：别的实例的同名项不变；校验同 update；null 恢复继承', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const B = fieldsPlugin('zz-b', SCHEMA);
    const { sm } = await setup({ fields: [A.definition, B.definition] });
    const { id } = await sm.createSession({}, { createdFrom: 'webui' });
    await A.reader().set(id, 'iterations', 5);
    expect(sm.getSession(id)?.metadata?.['session-settings']).toEqual({
      values: [{ plugin: 'zz-a', key: 'iterations', value: 5 }],
    });
    expect(A.reader().trace(id).values.iterations).toBe(5);
    expect(A.reader().trace(id).sources.iterations).toBe('session');
    expect(B.reader().get(id).iterations).toBe(30);

    const rejected = A.reader().set(id, 'iterations', 0);
    await expect(rejected).rejects.toThrow();
    await rejected.catch(err => expect(isSessionSettingsError(err)).toBe(true));

    await A.reader().set(id, 'iterations', null);
    expect(A.reader().trace(id).sources.iterations).toBe('default');
  });

  it('会话设置缺席时抛错', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    await setup({ settings: false, fields: [A.definition] });
    const rejected = A.reader().set(WEBUI, 'iterations', 5);
    await expect(rejected).rejects.toThrow();
    await rejected.catch(err => expect(isSessionSettingsError(err)).toBe(true));
  });
});

describe('两个门面', () => {
  it('管理面只交出声明的八个成员，读取门面只有 fields 与 getAll，原型链上够不到提供者', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const { app, admin } = await setup({ fields: [A.definition] });
    expect(Object.keys(admin).sort()).toEqual([
      'childMetadata',
      'fields',
      'getAll',
      'layers',
      'placements',
      'rows',
      'setAs',
      'update',
    ]);
    expect(Object.getPrototypeOf(admin)).toBe(Object.prototype);
    const reading = app.bind({ sessionFields }).sessionFields.use;
    expect(Object.keys(reading).sort()).toEqual(['fields', 'getAll']);
    expect(Object.getPrototypeOf(reading)).toBe(Object.prototype);
    expect('register' in reading || 'chain' in reading || 'update' in reading).toBe(false);
  });

  it('getAll 列出已登记的各项（实例 id、键、称呼、门槛），不含值；实例撤回登记后不再列', async () => {
    const A = fieldsPlugin('zz-a', SCHEMA);
    const { app, admin } = await setup({ doc: { plugins: { 'zz-a': { persona: '<人设>' } } }, fields: [A.definition] });
    expect(admin.getAll().filter(e => e.plugin === 'zz-a')).toEqual([
      { plugin: 'zz-a', key: 'llm', label: '模型', minLevel: 1 },
      { plugin: 'zz-a', key: 'think', label: '深度思考', minLevel: 1 },
      { plugin: 'zz-a', key: 'persona', label: '人设', minLevel: 1 },
      { plugin: 'zz-a', key: 'groups', label: '工具分组' },
      { plugin: 'zz-a', key: 'iterations', label: '最大工具迭代' },
      { plugin: 'zz-a', key: 'mode', label: '渲染' },
      { plugin: 'zz-a', key: 'plain', label: '纯文字' },
      { plugin: 'zz-a', key: 'language', label: '语言', minLevel: 1 },
      { plugin: 'zz-a', key: 'paperName', label: '白纸名' },
      { plugin: 'zz-a', key: 'scope', label: '范围' },
    ]);
    await app.plugins.disable('zz-a');
    expect(admin.getAll().filter(e => e.plugin === 'zz-a')).toEqual([]);
  });
});
