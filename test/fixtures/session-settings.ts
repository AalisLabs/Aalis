import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { type SessionSetting, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { definePlugin, type Logger, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
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
  field: { type: 'boolean', label: '深度思考' },
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
      for (const setting of settings) sessionManager.registerSetting(setting as never);
    },
  });
}

/**
 * 起一个会话管理：layers 是宿主配置文档里的 sessionConfig，settings 由一个测试插件登记；adapters 以根上的提供者给出。
 * warns 收集告警。调用方负责停掉返回的 app
 */
export async function startSessionManager({
  layers,
  settings,
  stored = {},
  adapters = [],
}: {
  layers?: AalisConfig['sessionConfig'];
  settings: SessionSetting[];
  stored?: Record<string, Record<string, unknown>>;
  adapters?: Partial<PlatformAdapter>[];
}) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const { app } = hostedApp(layers ? { sessionConfig: layers } : {}, { logger });
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager });
  // memory 是会话管理的 required 依赖：不先摆上，插件会停在 pending
  host.provide(memory, fakeMemory(stored) as never);
  for (const adapter of adapters) host.provide(platform, adapter as never);
  const settingsOwner = settingsPlugin('test-settings', settings);
  await app.plugin(sessionManagerPlugin);
  await app.plugin(settingsOwner);
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  for (const name of [sessionManagerPlugin.name, settingsOwner.name]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') {
      await app.stop();
      throw new Error(`${name} 未激活（state=${state}）`);
    }
  }
  return { app, sm: host.sessionManager.require(), warns };
}
