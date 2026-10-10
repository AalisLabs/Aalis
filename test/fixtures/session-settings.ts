import { authority } from '../../packages/api-authority/src/index.js';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform, type SessionTypeDecl } from '../../packages/api-platform/src/index.js';
import { type SessionSetting, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { definePlugin, events, type Logger, provide, services } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from './app.js';
import { registerHubs } from './hubs.js';
import { fakeMemory } from './session-memory.js';

// 会话设置项的测试件：几项定义、只登记设置项的插件（代替拥有这些功能的插件），以及带宿主配置文档的会话管理。

const ALL = ['owner', 'room', 'task'] as const;

export const PERSONA: SessionSetting = {
  key: 'persona',
  field: { type: 'string', label: '人设' },
  appliesTo: ALL,
  prominence: 'common',
};

/** 外来字段类型：schema-config 不校验它的取值，取值的形状由 validate 核 */
export const MODEL: SessionSetting = {
  key: 'llm',
  field: { type: 'llm-ref', label: '模型' },
  appliesTo: ALL,
  prominence: 'composer',
  validate: value => {
    const ref = value as { provider?: unknown; model?: unknown } | null;
    return typeof ref?.provider === 'string' && typeof ref.model === 'string' ? undefined : '要是 { provider, model }';
  },
};

export const THINK: SessionSetting = {
  key: 'think',
  field: {
    type: 'select',
    label: '深度思考',
    options: [
      { label: '关', value: 'off' },
      { label: '高', value: 'high' },
    ],
  },
  appliesTo: ALL,
  prominence: 'common',
};

export const TOOL_GROUPS: SessionSetting = {
  key: 'enabledToolGroups',
  field: { type: 'multiselect', label: '工具分组', allowCustom: true },
  appliesTo: ALL,
  prominence: 'common',
};

export const ITERATIONS: SessionSetting = {
  key: 'maxToolIterations',
  field: { type: 'number', label: '最大工具迭代', integer: true, min: 1 },
  appliesTo: ALL,
  prominence: 'advanced',
};

/** 只对房间、不随建子会话复制 */
export const PAPER_NAME: SessionSetting = {
  key: 'paperName',
  field: { type: 'string', label: '白纸名' },
  appliesTo: ['room'],
  prominence: 'advanced',
  liveOnly: true,
};

/** 写坏了要按拒绝处理的金额：不合字段的原值原样交给登记它的插件 */
export const ROOM_CENTS: SessionSetting = {
  key: 'remoteAgentRoomDailyCents',
  field: { type: 'number', label: '每房间每天金额上限', min: 0, onInvalid: 'error' },
  appliesTo: ['room'],
  prominence: 'advanced',
};

/** 只登记这些设置项的插件 */
export function settingsPlugin(name: string, settings: SessionSetting[]) {
  return definePlugin({
    name,
    uses: { sessionManager },
    apply({ sessionManager }) {
      for (const setting of settings) sessionManager.use.registerSetting(setting as never);
    },
  });
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
  { name: 'group', multiParty: true },
  { name: 'private', multiParty: false },
  { name: 'channel', multiParty: true },
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

/**
 * 起一个会话管理：layers 是宿主配置文档里的 sessionConfig，settings 由一个测试插件登记；adapters 各由一个插件提供，
 * 插件名为 zz-adapter-<平台>-<序号>；stored 与 places 预置会话表与场所记录；owners 给出时由一个替身 authority 认定这些身份是
 * owner；models 是 llm 服务的模型（[provider, model]，各由一个插件提供）；save 接宿主配置的落盘。warns 收集告警。
 * 调用方负责停掉返回的 app
 */
export async function startSessionManager({
  layers,
  settings,
  stored = {},
  places = {},
  adapters = [],
  owners,
  models = [],
  save,
}: {
  layers?: AalisConfig['sessionConfig'];
  settings: SessionSetting[];
  stored?: Record<string, Record<string, unknown>>;
  places?: Record<string, Record<string, unknown>>;
  adapters?: Partial<PlatformAdapter>[];
  owners?: Array<{ platform: string; userId: string }>;
  models?: Array<[provider: string, model: string]>;
  save?: (config: AalisConfig) => Promise<void>;
}) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const { app } = hostedApp(layers ? { sessionConfig: layers } : {}, { logger, provider: save ? { save } : undefined });
  await registerHubs(app);
  const host = app.bind({ provide, events, services, hostConfig, sessionManager });
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
  const plugins = [
    ...adapters.map((adapter, i) => adapterPlugin(`zz-adapter-${adapter.platform}-${i}`, adapter)),
    ...[...providers].map(([provider, ids]) => modelPlugin(provider, ids)),
    sessionManagerPlugin,
    settingsPlugin('test-settings', settings),
  ];
  for (const plugin of plugins) await app.plugin(plugin);
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') {
      await app.stop();
      throw new Error(`${name} 未激活（state=${state}）`);
    }
  }
  const inbound = (msg: Omit<IncomingMessage, 'content'>) =>
    host.events.use.emit('inbound:message', { content: '<占位>', ...msg });
  return { app, host, sm: host.sessionManager.use, mem, warns, inbound };
}
