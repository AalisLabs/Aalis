import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { recordRoom } from '../fixtures/rooms.js';
import { traceOf } from '../fixtures/session-settings.js';
import { startSubtaskHub } from '../fixtures/subtask.js';

// ════════════════════════════════════════════════════════════
// create_subtask 建的子会话在自己那一层写下父会话此刻适用于子会话的每一项：只适用于房间的项与只能设到场所为止的项不写；
// 取别的会话的范围这类权限项适用于子会话，必须写下父会话此刻更窄的值，否则经子任务就绕过了收窄。取别的会话的范围用会话管理
// 的真实字段声明：声明里的适用范围被改掉时这里会挂。
// ════════════════════════════════════════════════════════════

const SM = sessionManagerPlugin.name;

/** zz-agent 里只适用于房间的项（language）与只能设到场所为止的项（roomNote），设在房间所在的窗口上 */
const ROOM_ONLY = { language: ['zh-CN'], roomNote: '<群备注>' };

const ROOM = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const hub = await startSubtaskHub();
  apps.push(hub.app);
  await recordRoom(hub.host.events.use, ROOM, '群');
  for (const [key, value] of Object.entries(ROOM_ONLY)) {
    await hub.admin.update({ layer: { scope: 'place', key: WINDOW } }, { plugin: 'zz-agent', key, value });
  }
  await hub.admin.update({ sessionId: ROOM }, { plugin: SM, key: 'takeScope', value: 'session' });
  await hub.admin.update({ sessionId: ROOM }, { plugin: 'zz-agent', key: 'persona', value: 'from-parent' });
  /** 子会话自己那一层写下的条目：实例 id/键 → 值 */
  const own = (childId: string) => {
    const values = (
      hub.sm.getSession(childId)?.metadata?.['session-settings'] as { values: Array<Record<string, unknown>> }
    ).values;
    return Object.fromEntries(values.map(entry => [`${entry.plugin}/${entry.key}`, entry.value]));
  };
  /** 取别的会话的范围在这个会话的生效值 */
  const scopeOf = (sessionId: string) => traceOf(hub.admin, SM, sessionId).values.takeScope;
  return { hub, own, scopeOf };
}

describe('create_subtask 写下父会话的设置', () => {
  it('只适用于房间与只能设到场所的项不写，子会话里取默认；取别的会话的范围写下父会话此刻的本会话；其余适用的项照常写下', async () => {
    const { hub, own, scopeOf } = await setup();
    const { subtaskId } = await hub.call('create_subtask', { task: '<任务>' }, { sessionId: ROOM, platform: 'onebot' });
    const written = own(subtaskId);
    for (const key of Object.keys(ROOM_ONLY)) {
      expect(written, `子会话不应写下 ${key}`).not.toHaveProperty(`zz-agent/${key}`);
    }
    expect(hub.agentFields.reader().get(subtaskId)).toMatchObject({ language: ['en'], roomNote: '' });
    expect(written[`${SM}/takeScope`]).toBe('session');
    expect(scopeOf(subtaskId)).toBe('session');
    expect(written['zz-agent/persona']).toBe('from-parent');
  });

  it('之后父会话放宽了，已建的子会话不变', async () => {
    const { hub, scopeOf } = await setup();
    const { subtaskId } = await hub.call('create_subtask', { task: '<任务>' }, { sessionId: ROOM, platform: 'onebot' });
    await hub.admin.update({ sessionId: ROOM }, { plugin: SM, key: 'takeScope', value: null });
    expect(scopeOf(ROOM)).toBe('platform');
    expect(scopeOf(subtaskId)).toBe('session');
  });
});
