import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../packages/core/src/index.js';
import { startSubtaskHub } from '../fixtures/subtask.js';

// ════════════════════════════════════════════════════════════
// 除 create_subtask 外按 id 操作的五个工具只认调用所在会话的直接子任务：别的会话的子任务、根会话与不存在的 id 回同一句
// 「子任务不存在」，不确认存在与否，不带状态、任务与结果；wait_subtasks 不等它们，send_to_subtask、delete_subtask、
// set_subtask_setting 不执行。自己的子任务照常。用真的会话管理，子任务的归属取自会话记录的 parentId。
// ════════════════════════════════════════════════════════════

const NOT_FOUND = '子任务不存在';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const hub = await startSubtaskHub();
  apps.push(hub.app);
  const { sm } = hub;
  const other = await sm.createSession({ name: '<别的会话>' });
  const othersChild = await sm.createChildSession(other.id, { inputContext: '<别的会话的任务>' });
  const mine = await sm.createSession({ name: '<调用所在会话>' });
  const myChild = await sm.createChildSession(mine.id, { inputContext: '<任务>' });
  /** 在调用所在会话里调工具，回工具结果的原文 */
  const call = (tool: string, args: Record<string, unknown>) =>
    hub.raw(tool, args, { sessionId: mine.id, platform: 'webui', userId: 'console' });
  return { sm, other, othersChild, mine, myChild, call };
}

describe('子任务工具只认直接子任务', () => {
  it('check_subtask：别的会话的子任务与根会话按不存在回，不带状态、任务与结果；自己的子任务照常', async () => {
    const { sm, other, othersChild, myChild, call } = await setup();
    await sm.completeSession(othersChild.id, '<别的会话的结果>');

    const raw = await call('check_subtask', { subtask_ids: [othersChild.id, other.id, myChild.id] });
    expect(raw).not.toContain('<别的会话');
    const checked = JSON.parse(raw);
    expect(checked.subtasks).toEqual([
      { id: othersChild.id, error: NOT_FOUND },
      { id: other.id, error: NOT_FOUND },
      expect.objectContaining({ id: myChild.id, status: 'active', inputContext: '<任务>' }),
    ]);
    expect(checked.summary).toEqual({ total: 3, active: 1, completed: 0, errored: 0, stopped: 0 });
  });

  it('wait_subtasks：别的会话还在跑的子任务不等，不算超时、按不存在回；自己的子任务照常回结果', async () => {
    const { sm, othersChild, myChild, call } = await setup();
    await sm.completeSession(myChild.id, '<结果>');

    const raw = await call('wait_subtasks', { subtask_ids: [othersChild.id, myChild.id], timeout_seconds: 1 });
    expect(raw).not.toContain('<别的会话');
    expect(JSON.parse(raw)).toEqual({
      allCompleted: false,
      timedOut: false,
      subtasks: [
        { id: othersChild.id, error: NOT_FOUND },
        expect.objectContaining({ id: myChild.id, status: 'completed', result: '<结果>', completed: true }),
      ],
    });
  });

  it('五个工具对别的会话的根会话、子任务与不存在的 id 回同一句，不带会话 id；send、delete、改设置不执行', async () => {
    const { sm, other, othersChild, mine, myChild, call } = await setup();
    const argsOf: Record<string, (id: string) => Record<string, unknown>> = {
      check_subtask: id => ({ subtask_ids: [id] }),
      wait_subtasks: id => ({ subtask_ids: [id], timeout_seconds: 1 }),
      send_to_subtask: id => ({ subtask_id: id, message: '<追问>' }),
      delete_subtask: id => ({ subtask_id: id }),
      set_subtask_setting: id => ({ subtask_id: id, key: 'persona', value: '<人设>' }),
    };
    for (const [tool, args] of Object.entries(argsOf)) {
      /** 回复里调用方自己给的 id 换成占位符，其余逐字比较 */
      const reply = async (id: string) => (await call(tool, args(id))).replaceAll(id, '<id>');
      const missing = await reply('<不存在的 id>');
      expect(missing, tool).toContain(NOT_FOUND);
      expect(await reply(other.id), tool).toBe(missing);
      expect(await reply(othersChild.id), tool).toBe(missing);
      expect(missing, tool).not.toContain(mine.id);
    }
    expect(sm.getSession(othersChild.id)).toMatchObject({ status: 'active', parentId: other.id });

    expect(JSON.parse(await call('delete_subtask', { subtask_id: myChild.id }))).toMatchObject({ deleted: true });
    expect(sm.getSession(myChild.id)).toBeUndefined();
  });
});
