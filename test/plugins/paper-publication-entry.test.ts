import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import {
  emptyLedger,
  human,
  LEDGER_URI,
  PAPER,
  PILOT_CONFIG,
  PILOT_ROOM,
  ROOM,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';

afterEach(stopPaperHubs);

describe('白纸自动发布入口与交付边界', () => {
  it('省略 publish 默认申请发布并落盘，不要求发布提供者已在线；显式 false 只创作', async () => {
    const hub = await startPaperHub();
    const result = await hub.call('paper_task', { name: '猫站', text: '做网页' });
    expect(result.ok).toBe(true);
    expect(result.publication).toMatchObject({ target: 'works', state: 'pending' });
    expect(hub.ledger().tasks[String(result.taskId)].publication).toMatchObject({
      target: 'works',
      state: 'pending',
      title: '猫站',
    });
    const plain = await hub.call('paper_task', { name: '私有稿', text: '只做草稿', publish: false });
    expect(plain.ok).toBe(true);
    expect(hub.ledger().tasks[String(plain.taskId)].publication).toBeUndefined();
    const explicit = await hub.call('paper_task', { name: '显式上线', text: '制作作品', publish: true });
    expect(hub.ledger().tasks[String(explicit.taskId)].publication?.target).toBe('works');
    const selected = await hub.call('paper_task', { name: '指定目标', text: '制作作品', target: 'works' });
    expect(selected.ok).toBe(true);
    expect(hub.ledger().tasks[String(selected.taskId)].publication?.target).toBe('works');
  });

  it('目标不明确、越权或错误参数在花费之前拒绝', async () => {
    const hub = await startPaperHub({ config: { ...PILOT_CONFIG, defaults: { publishTargets: 'works, gallery' } } });
    for (const args of [
      {},
      { publish: true },
      { target: 'foreign' },
      { publish: 'true' },
      { publish: false, target: 'works' },
    ]) {
      expect(await hub.call('paper_task', { name: '猫站', text: '做网页', ...args })).toMatchObject({ ok: false });
    }
    expect(hub.outbound).toHaveLength(0);
    expect(hub.ledger()?.tasks ?? {}).toEqual({});
    expect(await hub.call('paper_task', { name: '猫站', text: '做网页', target: 'gallery' })).toMatchObject({
      ok: true,
    });
  });

  it('没有获准发布目标时默认申请被拒，显式 false 仍能只创作', async () => {
    const hub = await startPaperHub({
      config: { ...PILOT_CONFIG, papers: [{ ...PILOT_CONFIG.papers[0], publishTargets: '' }] },
    });
    expect(await hub.call('paper_task', { name: '猫站', text: '做网页' })).toMatchObject({ ok: false });
    expect(hub.ledger()?.tasks ?? {}).toEqual({});
    const privateTask = await hub.call('paper_task', { name: '私稿', text: '做文件', publish: false });
    expect(privateTask.ok).toBe(true);
    expect(hub.ledger().tasks[String(privateTask.taskId)].publication).toBeUndefined();
  });

  it('有明确默认目标时省略 publish 和 target 仍按配置选目标', async () => {
    const hub = await startPaperHub({
      config: { ...PILOT_CONFIG, defaults: { publishTargets: 'works, gallery', defaultPublishTarget: 'gallery' } },
    });
    const result = await hub.call('paper_task', { name: '猫站', text: '做作品' });
    expect(hub.ledger().tasks[String(result.taskId)].publication?.target).toBe('gallery');
  });

  it('默认发布仍受真人身份、房间开关和预算限制', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentRoomDailyCents: 1 } } });
    const args = { name: '猫站', text: '做网页' };
    expect(await hub.call('paper_task', args, { ...human(), inbound: undefined })).toMatchObject({ ok: false });
    expect(await hub.call('paper_task', args, { ...human(), inbound: { source: 'system' } })).toMatchObject({
      ok: false,
    });
    expect(await hub.call('paper_task', args)).toMatchObject({ ok: false });
    expect(hub.ledger()?.tasks ?? {}).toEqual({});
    const closed = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, paperEnabled: false } } });
    expect(await closed.call('paper_task', args)).toMatchObject({ ok: false });
    expect(closed.ledger()?.tasks ?? {}).toEqual({});
  });

  it.each([
    'pending',
    'submitted',
    'live',
  ] as const)('发布任务 %s 不提前通知、不泄露远端说明、不经 paper_send 旁路交付', async state => {
    const ledger = emptyLedger();
    const task: TaskRecord = {
      id: 't-12345678',
      paperId: `n:${PAPER}`,
      room: ROOM,
      platform: 'onebot',
      initiator: { platform: 'onebot', userId: '30001' },
      name: '猫站',
      text: '做网页并上线',
      state: 'done',
      createdAt: Date.now(),
      endedAt: Date.now(),
      delivered: false,
      resultText: 'RAW-UNREVIEWED-SENTINEL',
      artifacts: [{ id: 'a-12345678', rel: 'index.html', type: 'html', sizeBytes: 30 }],
      publication: { target: 'works', title: '猫站', summary: '', state },
    };
    ledger.tasks[task.id] = task;
    const hub = await startPaperHub({ files: new Map([[LEDGER_URI, JSON.stringify(ledger)]]) });
    const status = await hub.raw('paper_status', { task_id: task.id });
    expect(status).not.toContain('RAW-UNREVIEWED-SENTINEL');
    expect(status).not.toContain('a-12345678');
    expect(JSON.parse(status).tasks[0].publication.state).toBe(state);
    expect(hub.injected).toHaveLength(0);
    expect(await hub.call('paper_send', { artifact_id: 'a-12345678' })).toMatchObject({ ok: false });
    expect(hub.outbound).toHaveLength(0);
    expect(await hub.action('listTasks')).toContainEqual(
      expect.objectContaining({ id: task.id, publication: expect.stringContaining('works') }),
    );
  });
});
