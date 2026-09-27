import { describe, expect, it } from 'vitest';
import { type SessionConfig, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// create_subtask 复制父会话的生效配置建子会话：房间专属键（白纸开关、白纸名、远端类型、三项上限）
// 只经继承链实时解析，不能随复制冻结进子会话——否则子任务回合里照样能开远端任务。
// 召回范围相反：子会话必须带上更窄的范围，否则经子任务绕过收窄。
// ════════════════════════════════════════════════════════════

/** 与 ROOM_ONLY_CONFIG_KEYS 同一份清单，这里单写一遍防它被悄悄缩短 */
const ROOM_ONLY = [
  'paperEnabled',
  'paperName',
  'remoteAgentTypes',
  'remoteAgentUserDailyCents',
  'remoteAgentUserDailyTasks',
  'remoteAgentRoomDailyCents',
] as const;

type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

async function setup(pluginConfig: Record<string, unknown> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide });
  const handlers = new Map<string, Handler>();
  host.provide(tools, {
    register(tool: { definition: { function: { name: string } }; handler: Handler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  const parentResolved: SessionConfig = {
    persona: 'from-parent',
    paperEnabled: true,
    paperName: '<试点白纸名>',
    remoteAgentTypes: ['<远端代理实例 id>'],
    remoteAgentUserDailyCents: 100,
    remoteAgentUserDailyTasks: 3,
    remoteAgentRoomDailyCents: 500,
    memoryRecallScope: 'session',
  };
  const created: SessionConfig[] = [];
  host.provide(sessionManager, {
    getSession: () => undefined,
    resolveConfig: () => ({ ...parentResolved }),
    createChildSession: async (_parentId: string, opts: { config: SessionConfig }) => {
      created.push(opts.config);
      return { id: 'child-session-1' };
    },
    updateSession: async () => {},
  } as never);
  await app.plugins.register(subtask, pluginConfig);
  await app.plugins.idle();
  const handler = handlers.get('create_subtask');
  if (!handler) throw new Error('create_subtask 未注册');
  return { app, handler, created };
}

const callCtx = { sessionId: 'onebot:bot:group:g1', platform: 'onebot', userId: 'user-a' };

describe('create_subtask 不冻结房间专属键', () => {
  it('继承父会话配置：不含房间专属键，含 memoryRecallScope', async () => {
    const { app, handler, created } = await setup();
    await handler({ task: '做一件事' }, callCtx);
    expect(created).toHaveLength(1);
    for (const key of ROOM_ONLY) expect(created[0], `子会话不应冻结 ${key}`).not.toHaveProperty(key);
    expect(created[0].memoryRecallScope).toBe('session');
    expect(created[0].persona, '其余键照常复制').toBe('from-parent');
    await app.stop();
  });

  it('指定子任务模型时同样不冻结', async () => {
    const { app, handler, created } = await setup();
    await handler({ task: '做一件事', provider: '<LLM 提供者实例>', model: '<模型 id>' }, callCtx);
    expect(created).toHaveLength(1);
    for (const key of ROOM_ONLY) expect(created[0]).not.toHaveProperty(key);
    expect(created[0].memoryRecallScope).toBe('session');
    expect(created[0].llm).toEqual({ provider: '<LLM 提供者实例>', model: '<模型 id>' });
    await app.stop();
  });
});
