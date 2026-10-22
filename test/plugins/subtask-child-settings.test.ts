import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../packages/core/src/index.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import { configSchema as paperSchema } from '../../packages/plugin-paper/src/config.js';
import paperPlugin from '../../packages/plugin-paper/src/index.js';
import type { ConfigSchema } from '../../packages/schema-config/src/index.js';
import { recordRoom } from '../fixtures/rooms.js';
import { fieldsPlugin } from '../fixtures/session-settings.js';
import { startSubtaskHub } from '../fixtures/subtask.js';

// ════════════════════════════════════════════════════════════
// create_subtask 建的子会话在自己那一层写下父会话此刻适用于子会话的每一项：白纸的六项只适用于房间、只能设到场所为止，不写——
// 否则子任务回合里照样能开远端任务；跨会话历史范围这类权限项适用于子会话，必须写下父会话此刻更窄的值，否则经子任务就绕过了
// 收窄。用白纸与跨会话历史插件的真实字段声明：声明里的适用范围与只能设到场所为止被改掉时这里会挂。
// ════════════════════════════════════════════════════════════

/** 白纸的六项，这里单写一遍防它被悄悄缩短 */
const ROOM_ONLY = {
  paperEnabled: true,
  paperName: '<试点白纸名>',
  remoteAgentTypes: ['<远端代理实例 id>'],
  remoteAgentUserDailyCents: 100,
  remoteAgentUserDailyTasks: 3,
  remoteAgentRoomDailyCents: 500,
};

const ROOM = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';

/** 跨会话历史范围的生效值（这里按测试件的 ConfigSchema 读，字段类型不带出来） */
const scopeOf = (history: ReturnType<typeof fieldsPlugin>, sessionId: string) =>
  (history.reader().get(sessionId) as { scope?: unknown }).scope;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const paper = fieldsPlugin(paperPlugin.name, paperSchema);
  const history = fieldsPlugin(memoryHistory.name, memoryHistory.configSchema as ConfigSchema);
  const hub = await startSubtaskHub({ plugins: [paper.definition, history.definition] });
  apps.push(hub.app);
  await recordRoom(hub.host.events.use, ROOM, '群');
  for (const [key, value] of Object.entries(ROOM_ONLY)) {
    await hub.admin.update({ layer: { scope: 'place', key: WINDOW } }, { plugin: paperPlugin.name, key, value });
  }
  await hub.admin.update({ sessionId: ROOM }, { plugin: memoryHistory.name, key: 'scope', value: 'session' });
  await hub.admin.update({ sessionId: ROOM }, { plugin: 'zz-agent', key: 'persona', value: 'from-parent' });
  /** 子会话自己那一层写下的条目：实例 id/键 → 值 */
  const own = (childId: string) => {
    const values = (
      hub.sm.getSession(childId)?.metadata?.['session-settings'] as { values: Array<Record<string, unknown>> }
    ).values;
    return Object.fromEntries(values.map(entry => [`${entry.plugin}/${entry.key}`, entry.value]));
  };
  return { hub, paper, history, own };
}

describe('create_subtask 写下父会话的设置', () => {
  it('白纸的六项不写，子会话里白纸不开；跨会话历史范围写下父会话此刻的仅本会话；其余适用的项照常写下', async () => {
    const { hub, paper, history, own } = await setup();
    const { subtaskId } = await hub.call('create_subtask', { task: '<任务>' }, { sessionId: ROOM, platform: 'onebot' });
    const written = own(subtaskId);
    for (const key of Object.keys(ROOM_ONLY)) {
      expect(written, `子会话不应写下 ${key}`).not.toHaveProperty(`${paperPlugin.name}/${key}`);
    }
    expect(paper.reader().get(subtaskId).paperEnabled).toBe(false);
    expect(written[`${memoryHistory.name}/scope`]).toBe('session');
    expect(scopeOf(history, subtaskId)).toBe('session');
    expect(written['zz-agent/persona']).toBe('from-parent');
  });

  it('之后父会话放宽了，已建的子会话不变', async () => {
    const { hub, history } = await setup();
    const { subtaskId } = await hub.call('create_subtask', { task: '<任务>' }, { sessionId: ROOM, platform: 'onebot' });
    await hub.admin.update({ sessionId: ROOM }, { plugin: memoryHistory.name, key: 'scope', value: null });
    expect(scopeOf(history, ROOM)).toBe('same-platform');
    expect(scopeOf(history, subtaskId)).toBe('session');
  });
});
