import { afterEach, expect, it } from 'vitest';
import type { RunProgress } from '../../packages/api-remote-agent/src/index.js';
import type { WebuiFilePayload } from '../../packages/api-webui/src/index.js';
import { human, PILOT_CONFIG, REMOTE, ROOM, startPaperHub, stopPaperHubs } from '../fixtures/paper.js';
import { ScriptedRemote } from '../fixtures/paper-remote.js';

afterEach(stopPaperHubs);

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('任务日志未到达预期状态');
}

it('具体操作显示在管理端，完整工具记录独立下载，不泄漏到 paper_status 或聊天', async () => {
  const remote = new ScriptedRemote();
  const hub = await startPaperHub({ config: PILOT_CONFIG, remotes: { [REMOTE]: remote } });
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
  await until(async () => JSON.stringify(await hub.action('listTasks')).includes('/agent/gomoku/index.html'));
  const rows = (await hub.action('listTasks')) as Array<Record<string, unknown>>;
  expect(rows[0].progress).toContain('+200 / -3 行');
  const file = (await hub.action('readTaskLog', { id: taskId })) as WebuiFilePayload;
  expect(file.mime).toBe('application/octet-stream');
  const log = Buffer.from(file.base64, 'base64').toString();
  const entries = log
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(entries.some(row => row.entry.record?.output?.content === 'PRIVATE-FULL-CREATION-CONTENT\nsecond line')).toBe(
    true,
  );
  expect(file.name).toBe(`${taskId}.jsonl`);
  const status = await hub.call('paper_status', { task_id: taskId }, human('30001', ROOM));
  expect(JSON.stringify(status)).not.toContain('PRIVATE-FULL-CREATION-CONTENT');
  expect(JSON.stringify(status)).not.toContain('/agent/gomoku');
  expect(hub.outbound).toHaveLength(0);
  expect(await hub.action('clearTaskLog', { taskId })).toMatchObject({ ok: false });
  remote.finish(runId);
  await until(() => hub.ledger().tasks[taskId]?.state === 'done');
  await until(async () => ((await hub.action('listTaskLogs')) as unknown[]).length > 0);
  expect(await hub.action('clearTaskLog', { taskId })).toMatchObject({ ok: true });
  expect(await hub.action('listTaskLogs')).toEqual([]);
});

it('日志下载和清理按任务 ID 验证，不允许路径穿越', async () => {
  const hub = await startPaperHub();
  for (const taskId of ['../ledger.json', 't-12345678/../../config', '__proto__', '']) {
    expect(await hub.action('readTaskLog', { taskId })).toMatchObject({ ok: false });
    expect(await hub.action('clearTaskLog', { taskId })).toMatchObject({ ok: false });
  }
});
