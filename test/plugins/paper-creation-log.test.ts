import { afterEach, expect, it } from 'vitest';
import type { RunProgress } from '../../packages/api-remote-agent/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { human, PAPER, PILOT_CONFIG, REMOTE, ROOM, startPaperHub, stopPaperHubs } from '../fixtures/paper.js';
import { ScriptedRemote } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 创作日志：具体操作显示在白纸页（任务的最近动作与创作日志的详情），不泄漏到 paper_status 或聊天；
// 日志按任务 ID 校验后才读与删，不允许路径穿越。日志在插件数据里，界面不给下载，详情写明它的位置。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('任务日志未到达预期状态');
}

it('具体操作显示在白纸页，完整工具记录在创作日志的详情里，不泄漏到 paper_status 或聊天', async () => {
  const remote = new ScriptedRemote();
  const hub = await startPaperHub({ config: PILOT_CONFIG, remotes: { [REMOTE]: remote } });
  const tasks = () => hub.pages.data<Array<Record<string, unknown>>>('paper', 'paperTasks', { rowKey: `n:${PAPER}` });
  const logs = () => hub.pages.data<Array<Record<string, unknown>>>('paper', 'logs');
  const accepted = await hub.call('paper_task', { name: '五子棋', text: '制作五子棋', publish: false });
  const taskId = String(accepted.taskId);
  await until(() => hub.ledger().tasks[taskId]?.state === 'running');
  const runId = hub.ledger().tasks[taskId].runId!;
  const run = remote.runs.get(runId)!;
  const event = {
    kind: 'progress',
    eventId: 'event-1',
    activity: {
      action: 'writing',
      status: 'completed',
      tool: 'edit_file',
      target: '/agent/gomoku/index.html',
      summary: '+200 / -3 行',
    },
    record: {
      type: 'tool',
      callId: 'call-1',
      tool: 'edit_file',
      status: 'completed',
      input: { path: '/agent/gomoku/index.html' },
      output: { content: 'PRIVATE-FULL-CREATION-CONTENT\nsecond line' },
    },
  } as RunProgress;
  run.queue.push(event);
  run.wake?.();
  await until(async () => JSON.stringify(await tasks()).includes('/agent/gomoku/index.html'));
  expect(toSource((await tasks())[0].progress)).toContain('+200 / -3 行');
  const recent = await hub.pages.data<string>('paper', 'logRecent', { rowKey: taskId });
  expect(recent).toMatch(/^```json\n/);
  expect(recent).toContain('PRIVATE-FULL-CREATION-CONTENT\\nsecond line');
  const status = await hub.call('paper_status', { task_id: taskId }, human('30001', ROOM));
  expect(JSON.stringify(status)).not.toContain('PRIVATE-FULL-CREATION-CONTENT');
  expect(JSON.stringify(status)).not.toContain('/agent/gomoku');
  expect(hub.outbound).toHaveLength(0);

  expect((await logs()).find(row => row.taskId === taskId)).toMatchObject({ name: '五子棋', clearable: false });
  expect(toSource(await hub.pages.act('paper', 'clearTaskLog', { rowKey: taskId }))).toEqual({
    status: 500,
    body: { error: '任务仍在创作或发布中，不能删除日志' },
  });
  remote.finish(runId);
  await until(() => hub.ledger().tasks[taskId]?.state === 'done');
  expect((await logs()).find(row => row.taskId === taskId)).toMatchObject({ clearable: true });
  expect(toSource(await hub.pages.act('paper', 'clearTaskLog', { rowKey: taskId }))).toEqual({
    status: 200,
    body: { message: '已删除创作日志' },
  });
  expect(await logs()).toEqual([]);
  expect(hub.pages.invalidations).toContainEqual({
    instance: '@aalis/plugin-paper',
    pageKey: 'paper',
    componentId: 'logs',
  });
});

it('日志的读取和清理按任务 ID 验证，不允许路径穿越', async () => {
  const hub = await startPaperHub();
  for (const taskId of ['../ledger.json', 't-12345678/../../config', '__proto__']) {
    await expect(hub.pages.data('paper', 'logRecent', { rowKey: taskId }), taskId).rejects.toThrow('任务 ID 无效');
    expect(toSource(await hub.pages.act('paper', 'clearTaskLog', { rowKey: taskId })), taskId).toEqual({
      status: 500,
      body: { error: '任务 ID 无效' },
    });
  }
});

it.each([
  ['en', 'No creation log has been recorded yet; older tasks are not backfilled.', 'The full log is at'],
  ['zh-CN', '尚未记录创作日志；旧任务不会补录。', '完整记录在'],
])('%s：还没有创作日志的任务：详情写明没有记录与日志的位置（位置照原样作行内代码）', async (language, none, at) => {
  const hub = await startPaperHub();
  const taskId = 't-0000d001';
  const shown = async (id: string) => renderIn(await hub.pages.data('paper', id, { rowKey: taskId }), language);
  expect(await shown('logRecent')).toBe(none);
  const where = `\`pluginData:/paper/task-logs/${taskId}/\``;
  expect(await shown('logLocation')).toBe(language === 'en' ? `${at} ${where}.` : `${at} ${where}。`);
});
