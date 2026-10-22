import { authority } from '../../packages/api-authority/src/index.js';
import { type AalisConfig, hostConfig, ownHostConfig } from '../../packages/api-host-config/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform, type SessionTypeDecl } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  type ActualValue,
  type SessionAt,
  type SessionFieldReader,
  type SessionSettingsAdmin,
  sessionFields,
  sessionSettings,
} from '../../packages/api-session-settings/src/index.js';
import {
  config,
  definePlugin,
  events,
  type Logger,
  lifecycle,
  optional,
  type PluginDefinition,
  provide,
  services,
} from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { type ConfigSchema, defineConfig } from '../../packages/schema-config/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp, registerFromDoc } from './app.js';
import { registerHubs } from './hubs.js';
import { fakeMemory } from './session-memory.js';

// 会话设置的测试件：几份带标记字段的 schema、只声明这些字段并交出读取器的插件（代替拥有这些功能的插件），以及装好会话管理
// 与会话设置的宿主。

export const ALL = ['owner', 'room', 'task'] as const;

/** 模型引用：`<提供者>/<模型>`，按第一个斜杠拆（测试里的提供者名不带斜杠） */
const MODEL_REF = {
  validate: (value: unknown) => {
    const ref = value as { provider?: unknown; model?: unknown } | null;
    return typeof ref?.provider === 'string' && typeof ref.model === 'string' ? undefined : '要是 { provider, model }';
  },
  fromText: (text: string) => {
    const cut = text.indexOf('/');
    return cut > 0 ? { provider: text.slice(0, cut), model: text.slice(cut + 1) } : undefined;
  },
  toText: (value: unknown) => {
    const ref = value as { provider: string; model: string };
    return `${ref.provider}/${ref.model}`;
  },
};

/** 一份覆盖各种声明的 schema；note 是不带标记的普通配置项 */
export const SCHEMA = defineConfig({
  note: { type: 'string', label: '备注', default: '<备注>' },
  llm: {
    type: 'llm-ref',
    label: '模型',
    ...MODEL_REF,
    session: { appliesTo: ALL, prominence: 'composer', preference: 'llm', unset: '跟随服务偏好', minLevel: 1 },
  },
  think: {
    type: 'select',
    label: '深度思考',
    dynamicOptions: 'llm-thinking',
    session: { appliesTo: ALL, prominence: 'common', dependsOn: 'llm', unset: '按模型的默认档', minLevel: 1 },
  },
  persona: {
    type: 'string',
    label: '人设',
    default: 'default',
    session: { appliesTo: ALL, prominence: 'common', order: 10, minLevel: 1 },
  },
  groups: {
    type: 'multiselect',
    label: '工具分组',
    allowCustom: true,
    default: [],
    session: { appliesTo: ALL, prominence: 'common', order: 30 },
  },
  iterations: {
    type: 'number',
    label: '最大工具迭代',
    integer: true,
    min: 1,
    default: 30,
    session: { appliesTo: ALL, prominence: 'advanced' },
  },
  mode: {
    type: 'select',
    label: '渲染',
    options: [
      { label: '按角色卡', value: 'card' },
      { label: '开', value: 'on' },
      { label: '关', value: 'off' },
    ],
    default: 'card',
    session: { appliesTo: ALL, prominence: 'advanced' },
  },
  plain: { type: 'boolean', label: '纯文字', default: false, session: { appliesTo: ALL, prominence: 'advanced' } },
  /** 只适用于房间 */
  language: {
    type: 'multiselect',
    label: '语言',
    allowCustom: true,
    default: ['en'],
    session: { appliesTo: ['room'], prominence: 'common', minLevel: 1 },
  },
  /** 只能设到场所为止 */
  paperName: {
    type: 'string',
    label: '白纸名',
    default: '',
    session: { appliesTo: ['room'], prominence: 'advanced', narrowest: 'place' },
  },
  /** 严格字段：写坏了原样交出 */
  scope: {
    type: 'select',
    label: '范围',
    options: [
      { label: '仅本会话', value: 'session' },
      { label: '全部', value: 'all' },
    ],
    default: 'all',
    onInvalid: 'error',
    session: { appliesTo: ALL, prominence: 'advanced' },
  },
});

/** 另一个插件的 schema：与 SCHEMA 有同名的项（scope），另有一项只适用于 owner 的会话 */
export const OTHER_SCHEMA = defineConfig({
  scope: {
    type: 'select',
    label: '读取范围',
    options: [
      { label: '当前', value: 'current' },
      { label: '同平台', value: 'platform' },
    ],
    default: 'platform',
    session: { appliesTo: ALL, prominence: 'advanced' },
  },
  ownerOnly: {
    type: 'string',
    label: '只给 owner 会话',
    default: '<默认>',
    session: { appliesTo: ['owner'], prominence: 'advanced' },
  },
});

/**
 * 只声明一份 schema、交出读取器的插件：每个实例的读取器按实例 id 存（同一模块的几个实例各一份），actual 原样交给 fields()
 */
export function fieldsPlugin<const S extends ConfigSchema>(
  name: string,
  schema: S,
  actual?: Readonly<Record<string, ActualValue>>,
) {
  const readers = new Map<string, SessionFieldReader<S>>();
  const definition = definePlugin({
    name,
    configSchema: schema,
    reusable: true,
    uses: { sessionFields: optional(sessionFields), document: optional(ownHostConfig), config, lifecycle },
    apply(caps) {
      readers.set(caps.lifecycle.use.id, caps.sessionFields.use.fields(schema, caps, actual as never));
    },
  });
  return {
    definition,
    /** 这个实例的读取器：默认实例 id 就是插件名 */
    reader(id = name): SessionFieldReader<S> {
      const reader = readers.get(id);
      if (!reader) throw new Error(`${id} 没有激活`);
      return reader;
    },
  };
}

/**
 * 会话设置的替身：只交各会话的本会话层，会话 id → 这一层的值（不分实例，读取器只取自己 schema 里的键）；没有种类，不按
 * appliesTo 筛。改 values 之后下一次读取即生效。验写入、门槛与层表的用例装真的会话设置插件（{@link startSettings}）
 */
export function sessionValuesPlugin(values: Record<string, Record<string, unknown>>) {
  return definePlugin({
    name: 'zz-session-values',
    provides: [sessionSettings],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(sessionSettings, {
        register: () => () => {},
        chain: (_plugin: string, sessionId: string) => ({
          parts: values[sessionId] ? [{ layer: 'session', where: '本会话', values: { ...values[sessionId] } }] : [],
        }),
      } as never);
    },
  });
}

/**
 * 一个实例在一个会话里适用的各项的生效值与来源：读管理面的会话行，与协议、界面同一读法（不适用的、只能设到场所的项不列）
 */
export function traceOf(admin: SessionSettingsAdmin, plugin: string, sessionId: string, at?: SessionAt) {
  const rows = admin.rows({ sessionId, at }).filter(row => row.plugin === plugin);
  return {
    values: Object.fromEntries(rows.flatMap(row => (row.effective === undefined ? [] : [[row.key, row.effective]]))),
    sources: Object.fromEntries(rows.flatMap(row => (row.source === undefined ? [] : [[row.key, row.source]]))),
  };
}

/** 以插件实例提供一个平台适配器：同一平台可以装几个 */
export const adapterPlugin = (name: string, adapter: Partial<PlatformAdapter>) =>
  definePlugin({
    name,
    provides: [platform],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(platform, {
        adapterName: name,
        getConnections: () => [],
        sendMessage: async () => {},
        ...adapter,
      } as never);
    },
  });

/** 与 OneBot 适配器相同的类型声明 */
export const ONEBOT_TYPES: SessionTypeDecl[] = [
  { name: 'group', label: '群', multiParty: true },
  { name: 'private', label: '私聊', multiParty: false },
  { name: 'channel', label: '频道', multiParty: true },
];

/** llm 服务的一个替身提供者：插件名就是提供者，每个模型一个条目，条目 id 为 `<provider>/<model>` */
export function modelPlugin(provider: string, models: string[]) {
  return definePlugin({
    name: provider,
    provides: [llm],
    uses: { provide },
    apply: ({ provide }) => {
      for (const model of models) {
        const instance = {
          id: model,
          providerId: provider,
          capabilities: ['chat'],
          chat: async () => ({ content: '' }),
        };
        provide.use(llm, instance as never, { entryId: `${provider}/${model}` });
      }
    },
  });
}

/** 记下每条告警的日志：`[作用域] 原文`，读取器（字段所在的插件）与提供者的告警按作用域分得出 */
export function recordingLogger(warns: string[], scope = ''): Logger {
  return {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(`[${scope}] ${args.map(String).join(' ')}`),
    error() {},
    child: name => recordingLogger(warns, scope ? `${scope}/${name}` : name),
  };
}

/**
 * 起一个装好会话管理与会话设置的宿主，插件一律按文档登记（配置与禁用标记取自文档）：doc 是宿主配置文档；adapters 各由一个
 * 插件提供，插件名为 zz-adapter-<平台>-<序号>；stored 与 places 预置会话表与场所记录；owners 给出时由一个替身 authority
 * 认定这些身份是 owner；models 是 llm 服务的模型（[provider, model]）；save 接宿主配置的落盘；settings 为 false 时不装会话设置；
 * first 在会话管理之前登记，plugins 在会话设置之后、fields 之前登记。warns 收集告警。调用方负责停掉返回的 app
 */
export async function startSettings({
  doc = {},
  fields = [],
  first = [],
  plugins = [],
  stored = {},
  places = {},
  adapters = [],
  owners,
  models = [],
  save,
  settings = true,
}: {
  doc?: Partial<AalisConfig>;
  fields?: PluginDefinition[];
  first?: PluginDefinition[];
  plugins?: PluginDefinition[];
  stored?: Record<string, Record<string, unknown>>;
  places?: Record<string, Record<string, unknown>>;
  adapters?: Partial<PlatformAdapter>[];
  owners?: Array<{ platform: string; userId: string }>;
  models?: Array<[provider: string, model: string]>;
  save?: (config: AalisConfig) => Promise<void>;
  settings?: boolean;
}) {
  const warns: string[] = [];
  const { app, store } = hostedApp(doc, { logger: recordingLogger(warns), provider: save ? { save } : undefined });
  await registerHubs(app);
  const host = app.bind({ provide, events, services, hostConfig, sessionManager, sessionSettings });
  const mem = fakeMemory(stored, places);
  // memory 是会话管理的 required 依赖：不先摆上，插件会停在 pending
  host.provide.use(memory, mem as never);
  if (owners) {
    const isOwner = (platform: string, userId?: string) =>
      owners.some(owner => owner.platform === platform && owner.userId === userId);
    host.provide.use(authority, { isOwner } as never);
  }
  const providers = new Map<string, string[]>();
  for (const [provider, model] of models) providers.set(provider, [...(providers.get(provider) ?? []), model]);
  const definitions = [
    ...adapters.map((adapter, i) => adapterPlugin(`zz-adapter-${adapter.platform}-${i}`, adapter)),
    ...[...providers].map(([provider, ids]) => modelPlugin(provider, ids)),
    ...first,
    sessionManagerPlugin,
    ...(settings ? [sessionSettingsPlugin] : []),
    ...plugins,
    ...fields,
  ];
  for (const definition of definitions) await registerFromDoc(app, store, definition);
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  for (const { name } of definitions) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active' && !store.isPluginDisabled(name)) {
      await app.stop();
      throw new Error(`${name} 未激活（state=${state}）`);
    }
  }
  const inbound = (msg: Omit<IncomingMessage, 'content'>) =>
    host.events.use.emit('inbound:message', { content: '<占位>', ...msg });
  return {
    app,
    store,
    host,
    sm: host.sessionManager.use,
    admin: host.sessionSettings.use,
    doc: host.hostConfig.use,
    mem,
    warns,
    inbound,
  };
}
