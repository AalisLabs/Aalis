import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_RECALL_SCOPE_SETTING } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import { ROOM_SETTINGS } from '../../packages/plugin-paper/src/rooms.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import { recordRoom } from '../fixtures/rooms.js';
import { MODEL, PERSONA, startSessionManager } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// create_subtask 复制父会话的生效配置建子会话：白纸登记的房间设置项（白纸开关、白纸名、远端类型、三项上限）
// 设在窗口的场所上、只经继承链实时解析，不能随复制冻结进子会话——否则子任务回合里照样能开远端任务。
// 召回范围相反：子会话必须带上更窄的范围，否则经子任务绕过收窄。
// 用真的会话管理与白纸、记忆契约登记的定义：定义里的 liveOnly 与只能设到场所为止都被改掉时这里会挂。
// ════════════════════════════════════════════════════════════

/** 白纸登记的六项，这里单写一遍防它被悄悄缩短 */
const ROOM_ONLY = [
  'paperEnabled',
  'paperName',
  'remoteAgentTypes',
  'remoteAgentUserDailyCents',
  'remoteAgentUserDailyTasks',
  'remoteAgentRoomDailyCents',
] as const;

const ROOM = 'onebot:bot:group:g1';

type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const { app, host, sm } = await startSessionManager({
    settings: [PERSONA, MODEL, MEMORY_RECALL_SCOPE_SETTING, ...ROOM_SETTINGS],
  });
  apps.push(app);
  await recordRoom(host.events.use, ROOM);
  await sm.updateLayer(
    { scope: 'place', key: 'onebot:group:g1' },
    {
      paperEnabled: true,
      paperName: '<试点白纸名>',
      remoteAgentTypes: ['<远端代理实例 id>'],
      remoteAgentUserDailyCents: 100,
      remoteAgentUserDailyTasks: 3,
      remoteAgentRoomDailyCents: 500,
    },
  );
  await sm.updateSession(ROOM, { config: { persona: 'from-parent', memoryRecallScope: 'session' } });
  const handlers = new Map<string, Handler>();
  app.bind({ provide }).provide.use(tools, {
    register(tool: { definition: { function: { name: string } }; handler: Handler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(subtask, {});
  await app.plugins.idle();
  const handler = handlers.get('create_subtask');
  if (!handler) throw new Error('create_subtask 未注册');
  /** 建一个子任务，回子会话自己的配置 */
  const create = async (args: Record<string, unknown>) => {
    const reply = JSON.parse(await handler(args, { sessionId: ROOM, platform: 'onebot', userId: 'user-a' }));
    if (!reply.subtaskId) throw new Error(`建子任务失败：${reply.error}`);
    return sm.getSession(reply.subtaskId)?.config;
  };
  return { create };
}

describe('create_subtask 不冻结房间专属键', () => {
  it('继承父会话配置：不含房间专属键，含 memoryRecallScope', async () => {
    const { create } = await setup();
    const config = await create({ task: '做一件事' });
    for (const key of ROOM_ONLY) expect(config, `子会话不应冻结 ${key}`).not.toHaveProperty(key);
    expect(config?.memoryRecallScope).toBe('session');
    expect(config?.persona, '其余键照常复制').toBe('from-parent');
  });

  it('指定子任务模型时同样不冻结', async () => {
    const { create } = await setup();
    const config = await create({ task: '做一件事', provider: '<LLM 提供者实例>', model: '<模型 id>' });
    for (const key of ROOM_ONLY) expect(config).not.toHaveProperty(key);
    expect(config?.memoryRecallScope).toBe('session');
    expect(config?.llm).toEqual({ provider: '<LLM 提供者实例>', model: '<模型 id>' });
  });
});
