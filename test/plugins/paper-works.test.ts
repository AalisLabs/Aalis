import { provide } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NominateInput, type PublishService, publish } from '../../packages/api-publish/src/index.js';
import { artifactUri } from '../../packages/plugin-paper/src/artifacts.js';
import type { PaperLedger, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import {
  emptyLedger,
  human,
  LEDGER_URI,
  PAPER,
  PILOT_CONFIG,
  PILOT_ROOM,
  ROOM,
  ROOM2,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';

afterEach(stopPaperHubs);

const paperId = `n:${PAPER}`;
const taskId = 't-00000001';
const artifact = (id: string, rel: string, type: TaskRecord['artifacts'][number]['type']) => ({
  id,
  rel,
  type,
  sizeBytes: 3,
});
const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: taskId,
  paperId,
  room: ROOM,
  platform: 'onebot',
  initiator: { platform: 'onebot', userId: '30001' },
  name: '小猫',
  text: '做网页',
  state: 'done',
  createdAt: Date.now() - 1000,
  artifacts: [artifact('a-00000001', 'site/index.html', 'html'), artifact('a-00000002', 'site/cat.png', 'png')],
  delivered: false,
  ...over,
});

async function setup(
  tasks: TaskRecord[] = [task()],
  options: {
    paperEnabled?: boolean;
    withPublish?: boolean;
    children?: Record<string, string>;
    paperConfig?: Record<string, unknown>;
    surfaces?: Array<{ name: string; label?: string; baseUrl?: string; available: boolean; reason?: string }>;
  } = {},
) {
  const ledger: PaperLedger = emptyLedger();
  ledger.papers[paperId] = { lastClearedAt: Date.now() };
  const files = new Map<string, string | Uint8Array>([[LEDGER_URI, JSON.stringify(ledger)]]);
  for (const t of tasks) {
    ledger.tasks[t.id] = t;
    for (const a of t.artifacts) files.set(artifactUri(t.paperId, t.id, a), new Uint8Array([1, 2, 3]));
  }
  files.set(LEDGER_URI, JSON.stringify(ledger));
  const hub = await startPaperHub({
    files,
    config: { ...PILOT_CONFIG, ...options.paperConfig },
    rooms: { [ROOM]: { ...PILOT_ROOM, paperEnabled: options.paperEnabled ?? true }, [ROOM2]: PILOT_ROOM },
    children: options.children,
  });
  const nominate = vi.fn(async (_input: NominateInput) => ({ id: 'abcdefghij' }));
  const get = vi.fn(() => ({
    state: 'published',
    origin: { notify: { sessionId: ROOM, platform: 'onebot' } },
    title: '小猫',
  }));
  const withdraw = vi.fn(async (): Promise<{ ok: true; degraded?: string } | { refused: string }> => ({ ok: true }));
  const listSurfaces = vi.fn(
    () =>
      options.surfaces ?? [{ name: 'works', label: '作品站', baseUrl: 'https://one.example.test', available: true }],
  );
  if (options.withPublish !== false) {
    hub.app.bind({ provide }).provide(publish, { nominate, get, withdraw, listSurfaces } as unknown as PublishService);
  }
  return { hub, nominate, get, withdraw, listSurfaces };
}

describe('白纸作品工具', () => {
  it('同一白纸只能选择白名单中已登记的单个目标；查询只显示获准目标与目录地址', async () => {
    const { hub, nominate, listSurfaces } = await setup(undefined, {
      paperConfig: { papers: [{ name: PAPER, publishTargets: 'one, two' }] },
      surfaces: [
        { name: 'one', label: '一站', baseUrl: 'https://aalis1.example.test', available: true },
        { name: 'two', label: '画板', baseUrl: 'https://aalis2.example.test/draw', available: true },
        { name: 'secret', label: '别纸站', baseUrl: 'https://secret.example.test', available: true },
      ],
    });
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫', summary: '' };
    expect(await hub.call('works_nominate', args)).toMatchObject({ ok: false });
    expect(await hub.call('works_nominate', { ...args, target: 'secret' })).toMatchObject({ ok: false });
    expect(await hub.call('works_nominate', { ...args, target: 'https://aalis1.example.test' })).toMatchObject({
      ok: false,
    });
    expect(nominate).not.toHaveBeenCalled();
    const targets = await hub.call('works_targets', {});
    expect(targets).toMatchObject({
      ok: true,
      targets: [
        { name: 'one', baseUrl: 'https://aalis1.example.test' },
        { name: 'two', baseUrl: 'https://aalis2.example.test/draw' },
      ],
    });
    expect(JSON.stringify(targets)).not.toContain('secret.example.test');
    expect(await hub.call('works_nominate', { ...args, target: 'two' })).toMatchObject({ ok: true });
    expect(nominate.mock.calls[0][0].surfaces).toEqual(['two']);
    listSurfaces.mockReturnValue([{ name: 'one', available: true }] as never);
    expect(await hub.call('works_nominate', { ...args, target: 'two' })).toMatchObject({ ok: false });
    expect((await hub.call('works_targets', {})).targets).toEqual([{ name: 'one', available: true }]);
    listSurfaces.mockReturnValue([{ name: 'two', available: false, reason: '暂停' }] as never);
    expect(await hub.call('works_nominate', { ...args, target: 'two' })).toMatchObject({ ok: false });
  });

  it('显式空白名单禁发布；默认目标不在名单时不会代选；单目标延续旧 works', async () => {
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫', summary: '' };
    const empty = await setup(undefined, { paperConfig: { papers: [{ name: PAPER, publishTargets: '' }] } });
    expect(await empty.hub.call('works_nominate', args)).toMatchObject({ ok: false });
    expect(await empty.hub.call('works_targets', {})).toMatchObject({ ok: true, targets: [] });
    expect(empty.nominate).not.toHaveBeenCalled();
    const invalidDefault = await setup(undefined, {
      paperConfig: { papers: [{ name: PAPER, publishTargets: 'one, two', defaultPublishTarget: 'works' }] },
      surfaces: [
        { name: 'one', available: true },
        { name: 'two', available: true },
      ],
    });
    expect(await invalidDefault.hub.call('works_nominate', args)).toMatchObject({ ok: false });
    const legacy = await setup();
    expect(await legacy.hub.call('works_nominate', args)).toMatchObject({ ok: true });
    expect(legacy.nominate.mock.calls[0][0].surfaces).toEqual(['works']);
    const defaulted = await setup(undefined, {
      paperConfig: { papers: [{ name: PAPER, publishTargets: 'one, two', defaultPublishTarget: 'two' }] },
      surfaces: [
        { name: 'one', available: true },
        { name: 'two', available: true },
      ],
    });
    expect(await defaulted.hub.call('works_nominate', args)).toMatchObject({ ok: true });
    expect(defaulted.nominate.mock.calls[0][0].surfaces).toEqual(['two']);
  });

  it('目标查询沿用白纸发起守卫，停开的房间和内部来源看不到站点目录', async () => {
    const { hub } = await setup();
    expect(await hub.call('works_targets', {}, { ...human(), inbound: { source: 'notice' } })).toMatchObject({
      ok: false,
    });
    expect(await hub.call('works_targets', {}, { ...human(), inbound: undefined })).toMatchObject({ ok: false });
    const disabled = await setup(undefined, { paperEnabled: false });
    expect(await disabled.hub.call('works_targets', {})).toMatchObject({ ok: false });
    const child = await setup(undefined, { children: { [ROOM]: 'parent' } });
    expect(await child.hub.call('works_targets', {})).toMatchObject({ ok: false });
  });

  it('发布来源记录真实插件实例，停用后撤掉工具且旧句柄不能再提交', async () => {
    const instanceId = '@aalis/plugin-paper';
    const { hub, nominate } = await setup();
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫站', summary: '' };
    const old = hub.tools.get('works_nominate');
    if (!old) throw new Error('工具未登记');
    await hub.call('works_nominate', args);
    expect(nominate.mock.calls[0][0].origin.producer).toBe(instanceId);
    await hub.app.plugins.disable(instanceId);
    expect(hub.tools.has('works_nominate')).toBe(false);
    expect(hub.tools.has('works_takedown')).toBe(false);
    expect(hub.tools.has('works_targets')).toBe(false);
    nominate.mockClear();
    expect(JSON.parse((await old.handler(args, human())) as string)).toMatchObject({ ok: false });
    expect(nominate).not.toHaveBeenCalled();
  });

  it('登记三个零风险 works 工具；成品以字节快照和去共同目录的路径提名', async () => {
    const { hub, nominate } = await setup();
    expect(hub.groups).toContainEqual(expect.objectContaining({ name: 'works' }));
    for (const name of ['works_targets', 'works_nominate', 'works_takedown']) {
      expect(hub.tools.get(name)?.groups).toEqual(['works']);
      expect(hub.tools.get(name)?.risk).toBeUndefined();
    }
    const result = await hub.call('works_nominate', {
      task_id: taskId,
      artifact_ids: ['a-00000001', 'a-00000002'],
      title: '猫站',
      summary: '小猫网页',
    });
    expect(result).toMatchObject({ ok: true, workId: 'abcdefghij' });
    expect(nominate).toHaveBeenCalledWith(
      expect.objectContaining({
        group: paperId,
        title: '猫站',
        surfaces: ['works'],
        files: [
          { path: 'index.html', bytes: new Uint8Array([1, 2, 3]) },
          { path: 'cat.png', bytes: new Uint8Array([1, 2, 3]) },
        ],
      }),
    );
    expect(Object.hasOwn(nominate.mock.calls[0][0], 'requireOwner')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('site/');
  });

  it('只允许真人提名自己在本房间完成的任务，撤下只认本房间来源', async () => {
    const { hub, nominate, get, withdraw } = await setup();
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫站', summary: '' };
    expect(await hub.call('works_nominate', args, human('30002'))).toMatchObject({
      ok: false,
      error: '只能提名自己发起的任务',
    });
    expect(await hub.call('works_nominate', args, { ...human(), inbound: { source: 'system' } })).toMatchObject({
      ok: false,
    });
    expect(await hub.call('works_nominate', args, human('30001', ROOM2))).toMatchObject({ ok: false });
    expect(nominate).not.toHaveBeenCalled();
    get.mockReturnValue({
      state: 'published',
      origin: { notify: { sessionId: ROOM2, platform: 'onebot' } },
      title: '小猫',
    });
    expect(await hub.call('works_takedown', { work: 'abcdefghij' })).toMatchObject({
      ok: false,
      error: '本房间没有这件作品',
    });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('从作品网址识别编号并撤下，内部通知回合也能撤下', async () => {
    const { hub, withdraw } = await setup();
    const result = await hub.call(
      'works_takedown',
      { work: 'https://example.test/w/abcdefghij/' },
      { ...human(), inbound: { source: 'notice' } },
    );
    expect(result).toMatchObject({ ok: true });
    expect(withdraw).toHaveBeenCalledWith('abcdefghij', expect.objectContaining({ kind: 'origin' }), '来源房间撤下');
  });

  it('发布服务缺席时工具仍登记，调用时清楚拒绝', async () => {
    const ledger = emptyLedger();
    ledger.papers[paperId] = { lastClearedAt: Date.now() };
    ledger.tasks[taskId] = task();
    const hub = await startPaperHub({
      files: new Map([[LEDGER_URI, JSON.stringify(ledger)]]),
    });
    expect(hub.tools.has('works_nominate')).toBe(true);
    expect(
      await hub.call('works_nominate', { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫', summary: '' }),
    ).toMatchObject({
      ok: false,
      error: '作品发布服务不可用',
    });
    expect(await hub.call('works_takedown', { work: 'abcdefghij' })).toMatchObject({
      ok: false,
      error: '作品发布服务不可用',
    });
  });

  it('拒绝未完成、清空、越界成品与封面；服务未被调用', async () => {
    const { hub, nominate } = await setup([task({ state: 'running' })]);
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫', summary: '' };
    expect(await hub.call('works_nominate', args)).toMatchObject({ ok: false, error: '这件任务还没有完成' });
    const second = await setup([task({ id: 't-00000002', artifactsCleared: true })]);
    expect(await second.hub.call('works_nominate', { ...args, task_id: 't-00000002' })).toMatchObject({ ok: false });
    const third = await setup();
    expect(await third.hub.call('works_nominate', { ...args, artifact_ids: ['a-ffffffff'] })).toMatchObject({
      ok: false,
    });
    expect(await third.hub.call('works_nominate', { ...args, cover_artifact_id: 'a-ffffffff' })).toMatchObject({
      ok: false,
    });
    expect(nominate).not.toHaveBeenCalled();
    expect(third.nominate).not.toHaveBeenCalled();
  });

  it('单件媒体使用固定公开名，封面另读快照；拒绝索引只映射成品编号', async () => {
    const media = task({
      artifacts: [
        artifact('a-00000001', 'secret/photo.png', 'png'),
        artifact('a-00000002', 'secret/cover.webp', 'webp'),
      ],
    });
    const { hub, nominate } = await setup([media]);
    const args = {
      task_id: taskId,
      artifact_ids: ['a-00000001'],
      cover_artifact_id: 'a-00000002',
      title: '猫',
      summary: '',
    };
    expect(await hub.call('works_nominate', args)).toMatchObject({ ok: true });
    expect(nominate).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ path: 'work.png', bytes: new Uint8Array([1, 2, 3]) }],
        cover: new Uint8Array([1, 2, 3]),
      }),
    );
    nominate.mockResolvedValueOnce({ refused: '不安全文件', fileIndex: 0 } as never);
    const denied = await hub.call('works_nominate', args);
    expect(denied).toMatchObject({ ok: false, error: '成品 a-00000001：不安全文件' });
    expect(JSON.stringify(denied)).not.toContain('secret/');
    nominate.mockResolvedValueOnce({ refused: '不安全文件 secret/photo.png', fileIndex: 0 } as never);
    const privatePath = await hub.call('works_nominate', args);
    expect(privatePath).toMatchObject({ ok: false, error: '成品 a-00000001：作品文件未通过检查' });
    expect(JSON.stringify(privatePath)).not.toContain('secret/');
  });

  it('撤下回执区分部署退化与服务拒绝，不回显作品来源房间', async () => {
    const { hub, withdraw } = await setup();
    withdraw.mockResolvedValueOnce({ ok: true, degraded: '站点暂停' });
    const degraded = await hub.call('works_takedown', { work: 'abcdefghij' });
    expect(String(degraded.message)).toContain('站点上可能还打得开');
    expect(JSON.stringify(degraded)).not.toContain(ROOM);
    withdraw.mockResolvedValueOnce({ refused: '作品账本读取失败，等 owner 处理' } as never);
    expect(await hub.call('works_takedown', { work: 'abcdefghij' })).toMatchObject({
      ok: false,
      error: '作品账本读取失败，等 owner 处理',
    });
  });

  it('撤下不要求房间仍开启白纸；成品读取失败不泄漏存储路径', async () => {
    const { hub, nominate } = await setup();
    hub.files.delete(artifactUri(paperId, taskId, task().artifacts[0]));
    const denied = await hub.call('works_nominate', {
      task_id: taskId,
      artifact_ids: ['a-00000001'],
      title: '猫',
      summary: '',
    });
    expect(denied).toMatchObject({ ok: false });
    expect(JSON.stringify(denied)).not.toContain('paper:/');
    expect(nominate).not.toHaveBeenCalled();
    const disabled = await setup(undefined, { paperEnabled: false });
    // 停开白纸只影响提名；撤下从来源房间与入站回合判定。
    expect(await disabled.hub.call('works_takedown', { work: 'abcdefghij' })).toMatchObject({ ok: true });
    expect(disabled.withdraw).toHaveBeenCalledOnce();
  });

  it('单个网页固定为 index.html，多文件没有共同目录时保留各自相对路径', async () => {
    const source = task({
      artifacts: [
        artifact('a-00000001', 'private/site.html', 'html'),
        artifact('a-00000002', 'assets/logo.png', 'png'),
      ],
    });
    const { hub, nominate } = await setup([source]);
    const base = { task_id: taskId, title: '猫', summary: '' };
    expect(await hub.call('works_nominate', { ...base, artifact_ids: ['a-00000001'] })).toMatchObject({ ok: true });
    expect(nominate.mock.calls[0][0].files).toEqual([{ path: 'index.html', bytes: new Uint8Array([1, 2, 3]) }]);
    expect(await hub.call('works_nominate', { ...base, artifact_ids: ['a-00000001', 'a-00000002'] })).toMatchObject({
      ok: true,
    });
    expect(nominate.mock.calls[1][0].files.map(file => file.path)).toEqual(['private/site.html', 'assets/logo.png']);
  });

  it('资格逐项拒绝无入站、内部来源、无发起身份和子会话；不读成品也不提名', async () => {
    const { hub, nominate } = await setup();
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫', summary: '' };
    for (const ctx of [
      { ...human(), inbound: undefined },
      { ...human(), inbound: { source: 'scheduler' } },
      human(''),
    ]) {
      expect(await hub.call('works_nominate', args, ctx)).toMatchObject({ ok: false });
    }
    const child = await setup(undefined, { children: { [ROOM]: 'parent' } });
    expect(await child.hub.call('works_nominate', args)).toMatchObject({ ok: false });
    expect(await child.hub.call('works_takedown', { work: 'abcdefghij' })).toMatchObject({ ok: false });
    expect(nominate).not.toHaveBeenCalled();
    expect(child.nominate).not.toHaveBeenCalled();
    expect(child.withdraw).not.toHaveBeenCalled();
  });

  it('发布服务晚到时同一工具恢复可用，封面拒绝映射为封面且不回显相对路径', async () => {
    const { hub, nominate, get, withdraw, listSurfaces } = await setup(undefined, { withPublish: false });
    const args = { task_id: taskId, artifact_ids: ['a-00000001'], title: '猫', summary: '' };
    expect(await hub.call('works_nominate', args)).toMatchObject({ ok: false, error: '作品发布服务不可用' });
    hub.app.bind({ provide }).provide(publish, { nominate, get, withdraw, listSurfaces } as unknown as PublishService);
    expect(await hub.call('works_nominate', args)).toMatchObject({ ok: true });
    nominate.mockResolvedValueOnce({ refused: '封面不合格', fileIndex: -1 } as never);
    const denied = await hub.call('works_nominate', args);
    expect(denied).toMatchObject({ ok: false, error: '封面：封面不合格' });
    expect(JSON.stringify(denied)).not.toContain('site/');
  });
});
