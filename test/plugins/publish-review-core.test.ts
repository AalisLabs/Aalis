import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NominateInput } from '../../packages/api-publish/src/index.js';
import { isIntegrityError } from '../../packages/api-publish/src/index.js';
import type { ReviewConfig } from '../../packages/plugin-publish-review/src/config.js';
import type { ReviewPipeline } from '../../packages/plugin-publish-review/src/pipeline.js';
import { PublishReviewService } from '../../packages/plugin-publish-review/src/service.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { memoryStorage } from '../fixtures/paper.js';

const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 72, 68, 82]);
const input = (): NominateInput => ({
  origin: { producer: 'paper', ref: 'task-1', label: '测试房间', notify: { sessionId: 'room-1', platform: 'onebot' } },
  group: 'private-group',
  groupLabel: '测试',
  surfaces: ['works'],
  title: '测试作品',
  summary: '',
  files: [{ path: 'work.png', bytes: image }],
});

const config = (manualReview = false): ReviewConfig => ({
  reviewEnabled: true,
  manualReview,
  ownerTimeoutHours: 12,
  ffmpegPath: 'ffmpeg',
  chrome: { headless: true, executablePath: '' },
  limits: {
    maxFileMB: 25,
    maxWorkFiles: 50,
    maxWorkMB: 50,
    maxPending: 20,
    maxPendingPerOrigin: 3,
    maxDailyPerOrigin: 10,
  },
});

async function setup(
  pipeline: ReviewPipeline,
  manualReview = false,
  seed = new Map<string, string | Uint8Array>(),
  clock = { now: 1000 },
) {
  const storage = memoryStorage(seed);
  const store = new ReviewStore(storage);
  await store.load();
  const notices: string[] = [];
  const service = new PublishReviewService({
    storage,
    store,
    config: config(manualReview),
    pipeline,
    now: () => clock.now,
    notice: (_origin, text) => notices.push(text),
  });
  service.attachSurface({
    name: 'works',
    urlFor: id => `https://works.invalid/w/${id}/`,
    health: () => ({ ok: true }),
  });
  return { service, store, storage, seed, notices };
}

describe('作品审核核心', () => {
  it('旧待发通知没有独立标题字段仍可读取', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup({ run: vi.fn() }, false, seed);
    const old = h.store.copy();
    old.notices.legacy = { id: 'abcdefghij', origin: input().origin, content: '作品已上线：旧链接', live: false };
    await h.store.save(old);
    const reloaded = new ReviewStore(memoryStorage(seed));
    await reloaded.load();
    expect(reloaded.failure).toBeUndefined();
    expect(reloaded.data.notices.legacy).toMatchObject({ content: '作品已上线：旧链接' });
    expect(reloaded.data.notices.legacy).not.toHaveProperty('title');
  });

  it('旧账本多余署名可读，相同提交键按旧指纹重试且新公开契约不返回署名', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      seed,
    );
    const keyed = { ...input(), submissionKey: 'paper:legacy' };
    const result = await h.service.nominate(keyed);
    if (!('id' in result)) throw new Error(result.refused);
    expect(h.store.data.queue[result.id]).not.toHaveProperty('credit');
    const legacy = h.store.copy();
    const legacyCredit = '旧版作者';
    Object.assign(legacy.queue[result.id], { credit: legacyCredit });
    const fileHash = createHash('sha256').update(image).digest('hex');
    const payload = {
      origin: { ...keyed.origin, actorKey: null },
      group: keyed.group,
      groupLabel: keyed.groupLabel,
      surfaces: keyed.surfaces,
      title: keyed.title,
      summary: keyed.summary,
      credit: legacyCredit,
      files: [['work.png', fileHash]],
      cover: null,
    };
    const slot = JSON.stringify([keyed.origin.producer, keyed.submissionKey]);
    legacy.submissions[slot].fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await h.store.save(legacy);
    const resumed = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      seed,
    );
    expect(await resumed.service.nominate(keyed)).toEqual({ id: result.id });
    expect(await resumed.service.nominate({ ...keyed, title: '改过的标题' })).toEqual({
      refused: '提交键对应的作品内容已变更',
    });
    expect(resumed.store.data.queue[result.id]).toHaveProperty('credit', legacyCredit);
    await resumed.service.processNext();
    expect(resumed.store.data.ledger[result.id]).toHaveProperty('credit', legacyCredit);
    expect(resumed.service.listPublished('works')[0]).not.toHaveProperty('credit');
    expect(await resumed.service.nominate(keyed)).toEqual({ id: result.id });
  });

  it('同一提交键并发及重启只收一次，变更来源或字节会拒绝，普通提名仍可重复', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup({ run: vi.fn() }, false, seed);
    const keyed = { ...input(), submissionKey: 'paper:task-1' };
    const results = await Promise.all(Array.from({ length: 12 }, () => h.service.nominate(keyed)));
    expect(results.every(result => 'id' in result && result.id === (results[0] as { id: string }).id)).toBe(true);
    expect(h.store.data.nominations).toHaveLength(1);
    expect(Object.keys(h.store.data.queue)).toHaveLength(1);
    const id = (results[0] as { id: string }).id;
    const resumed = await setup({ run: vi.fn() }, false, seed);
    expect(await resumed.service.nominate(keyed)).toEqual({ id });
    expect(resumed.store.data.nominations).toHaveLength(1);
    expect(await resumed.service.nominate({ ...keyed, origin: { ...keyed.origin, ref: 'task-2' } })).toEqual({
      refused: '提交键对应的作品内容已变更',
    });
    expect(
      await resumed.service.nominate({ ...keyed, files: [{ path: 'work.png', bytes: new Uint8Array([...image, 1]) }] }),
    ).toHaveProperty('refused');
    const independent = await resumed.service.nominate({ ...keyed, origin: { ...keyed.origin, producer: 'other' } });
    expect(independent).toHaveProperty('id');
    expect(independent).not.toEqual({ id });
    const plain = await resumed.service.nominate(input());
    expect(plain).toHaveProperty('id');
    expect(plain).not.toEqual({ id });
  });

  it('带提交键的拒绝终态可追踪且不能复活；上线只在展示面回执后为真', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      true,
      seed,
    );
    const keyed = { ...input(), submissionKey: 'paper:task-1' };
    const nominated = await h.service.nominate(keyed);
    if (!('id' in nominated)) throw new Error(nominated.refused);
    expect(h.service.get(nominated.id)?.live).not.toBe(true);
    await h.service.processNext();
    expect(await h.service.reject(nominated.id)).toBe(true);
    expect(h.service.get(nominated.id)?.state).toBe('rejected');
    const resumed = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      true,
      seed,
    );
    expect(await resumed.service.nominate(keyed)).toEqual({ id: nominated.id });
    expect(resumed.service.get(nominated.id)?.state).toBe('rejected');
    expect(resumed.store.data.nominations).toHaveLength(1);

    const next = await resumed.service.nominate({ ...keyed, submissionKey: 'paper:task-2' });
    if (!('id' in next)) throw new Error(next.refused);
    await resumed.service.processNext();
    expect(resumed.service.get(next.id)?.state).toBe('awaiting-owner');
    expect(resumed.service.get(next.id)?.live).not.toBe(true);
    expect(await resumed.service.approve(next.id)).toBe(true);
    expect(resumed.service.get(next.id)).toMatchObject({ state: 'published' });
    expect(resumed.service.get(next.id)?.live).not.toBe(true);
    resumed.service
      .attachSurface({ name: 'works', urlFor: id => `https://works.invalid/w/${id}/`, health: () => ({ ok: true }) })
      .live([next.id]);
    await vi.waitFor(() => expect(resumed.service.get(next.id)?.live).toBe(true));
    await vi.waitFor(() => expect(resumed.notices.some(text => text.includes('已上线：'))).toBe(true));
    const notice = resumed.notices.find(text => text.includes('已上线：'))!;
    expect(notice).toContain('作品已上线：');
    expect(notice).not.toContain('测试作品');
    expect(notice).not.toContain(`作品 ${next.id}`);
    const liveResumed = await setup({ run: vi.fn() }, true, seed);
    expect(liveResumed.service.get(next.id)?.live).toBe(true);
  });

  it('超时、审核失败和待审撤回都保留带键终态', async () => {
    const clock = { now: 1000 };
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'unsure', reasons: [] }, files: input().files }) },
      false,
      seed,
      clock,
    );
    const first = { ...input(), submissionKey: 'paper:expire' };
    const expired = await h.service.nominate(first);
    if (!('id' in expired)) throw new Error(expired.refused);
    await h.service.processNext();
    clock.now += 12 * 3_600_000 + 1;
    await h.service.reconcile();
    expect(h.service.get(expired.id)?.state).toBe('expired');
    expect(await h.service.nominate(first)).toEqual({ id: expired.id });

    const second = { ...input(), submissionKey: 'paper:withdraw' };
    const withdrawn = await h.service.nominate(second);
    if (!('id' in withdrawn)) throw new Error(withdrawn.refused);
    expect(await h.service.withdraw(withdrawn.id, { kind: 'origin' }, '取消')).toMatchObject({ ok: true });
    expect(h.service.get(withdrawn.id)?.state).toBe('withdrawn');
    expect(await h.service.nominate(second)).toEqual({ id: withdrawn.id });

    const failSeed = new Map<string, string | Uint8Array>();
    const failedReview = await setup(
      {
        run: async () => {
          throw new Error('offline');
        },
      },
      false,
      failSeed,
    );
    const third = { ...input(), submissionKey: 'paper:fail' };
    const failed = await failedReview.service.nominate(third);
    if (!('id' in failed)) throw new Error(failed.refused);
    await failedReview.service.processNext();
    const restarted = await setup({ run: vi.fn() }, false, failSeed);
    expect(restarted.service.get(failed.id)?.state).toBe('failed');
    expect(await restarted.service.nominate(third)).toEqual({ id: failed.id });
  });

  it('没有通知房间也能记录展示面核验；撤回后不再显示在线', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      seed,
    );
    const draft = input();
    delete draft.origin.notify;
    draft.submissionKey = 'paper:no-notify';
    const result = await h.service.nominate(draft);
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    expect(h.service.get(result.id)).toMatchObject({ state: 'published' });
    expect(h.service.get(result.id)?.live).not.toBe(true);
    h.service
      .attachSurface({ name: 'works', urlFor: id => `https://works.invalid/w/${id}/`, health: () => ({ ok: true }) })
      .live([result.id]);
    await vi.waitFor(() => expect(h.service.get(result.id)?.live).toBe(true));
    expect(await h.service.withdraw(result.id, { kind: 'origin' }, '撤回')).toMatchObject({ ok: true });
    expect(h.service.get(result.id)).toMatchObject({ state: 'withdrawn', live: undefined });
  });

  it('多目标逐项持久核验，全部上线后才回报并一次通知完整地址；通知失败可重试', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      seed,
    );
    const first = h.service.attachSurface({
      name: 'works',
      urlFor: id => `https://works.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    h.service.attachSurface({
      name: 'draw',
      urlFor: id => `https://draw.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    const nominated = await h.service.nominate({ ...input(), surfaces: ['works', 'draw'] });
    if (!('id' in nominated)) throw new Error(nominated.refused);
    await h.service.processNext();
    first.live([nominated.id]);
    await h.store.exclusive(async () => {});
    expect(h.service.get(nominated.id)?.live).toBe(false);
    expect(h.store.data.ledger[nominated.id].liveSurfaces).toEqual({
      works: `https://works.invalid/w/${nominated.id}/`,
    });
    expect(h.notices).toEqual([]);

    const restarted = new ReviewStore(memoryStorage(seed));
    await restarted.load();
    const emit = vi.fn().mockRejectedValue(new Error('temporary'));
    const service = new PublishReviewService({
      storage: restarted.storage,
      store: restarted,
      config: config(),
      pipeline: { run: vi.fn() },
      notice: emit,
    });
    service.attachSurface({
      name: 'works',
      urlFor: id => `https://works.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    const draw = service.attachSurface({
      name: 'draw',
      urlFor: id => `https://draw.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    draw.live([nominated.id]);
    await restarted.exclusive(async () => {});
    await service.flushNotices();
    expect(service.get(nominated.id)?.live).toBe(true);
    expect(restarted.data.ledger[nominated.id].notice).toBe('pending');
    expect(restarted.data.notices[`${nominated.id}:live`]?.content).toContain(
      `https://works.invalid/w/${nominated.id}/、https://draw.invalid/w/${nominated.id}/`,
    );
    draw.live([nominated.id]);
    await restarted.exclusive(async () => {});
    expect(restarted.data.history.filter(entry => entry.event === 'live')).toHaveLength(2);
    const relocated = service.attachSurface({
      name: 'works',
      urlFor: id => `https://new-works.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    expect(service.get(nominated.id)?.live).toBe(false);
    await service.flushNotices();
    expect(restarted.data.notices[`${nominated.id}:live`]?.content).toContain('https://works.invalid/');
    relocated.live([nominated.id]);
    await restarted.exclusive(async () => {});
    expect(service.get(nominated.id)?.live).toBe(true);
    expect(restarted.data.notices[`${nominated.id}:live`]?.content).toContain('https://new-works.invalid/');
    expect(restarted.data.notices[`${nominated.id}:live`]?.content).not.toContain('https://works.invalid/');
    await service.close();

    const delivered = await setup({ run: vi.fn() }, false, seed);
    delivered.service.attachSurface({
      name: 'works',
      urlFor: id => `https://new-works.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    delivered.service.attachSurface({
      name: 'draw',
      urlFor: id => `https://draw.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    await delivered.service.flushNotices();
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(1));
    expect(delivered.notices[0]).toContain(`https://new-works.invalid/w/${nominated.id}/`);
    expect(delivered.notices[0]).toContain(`https://draw.invalid/w/${nominated.id}/`);
    expect(delivered.notices[0]).not.toContain('https://works.invalid/');
    expect(delivered.store.data.ledger[nominated.id].notice).toBe('sent');
    expect(delivered.store.data.notices[`${nominated.id}:live`]).toBeUndefined();
    expect(await delivered.service.withdraw(nominated.id, { kind: 'origin' }, '撤回')).toMatchObject({ ok: true });
    expect(delivered.store.data.ledger[nominated.id].liveSurfaces).toEqual({});
    expect(delivered.service.get(nominated.id)).toMatchObject({ state: 'withdrawn', live: undefined });
  });

  it('目标换址后旧回执不能与新目标回执拼成上线证明', async () => {
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
    );
    const oldA = h.service.attachSurface({
      name: 'works',
      urlFor: id => `https://old.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    const b = h.service.attachSurface({
      name: 'draw',
      urlFor: id => `https://draw.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    const nominated = await h.service.nominate({ ...input(), surfaces: ['works', 'draw'] });
    if (!('id' in nominated)) throw new Error(nominated.refused);
    await h.service.processNext();
    oldA.live([nominated.id]);
    await h.store.exclusive(async () => {});
    const newA = h.service.attachSurface({
      name: 'works',
      urlFor: id => `https://new.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    b.live([nominated.id]);
    await h.store.exclusive(async () => {});
    expect(h.service.get(nominated.id)?.live).toBe(false);
    expect(h.store.data.ledger[nominated.id].liveSurfaces).toEqual({
      draw: `https://draw.invalid/w/${nominated.id}/`,
    });
    expect(h.notices).toEqual([]);
    oldA.live([nominated.id]);
    await h.store.exclusive(async () => {});
    expect(h.service.get(nominated.id)?.live).toBe(false);
    newA.live([nominated.id]);
    await vi.waitFor(() => expect(h.service.get(nominated.id)?.live).toBe(true));
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain(`https://new.invalid/w/${nominated.id}/`);
    expect(h.notices[0]).toContain(`https://draw.invalid/w/${nominated.id}/`);
    expect(h.notices[0]).not.toContain('old.invalid');
  });
  it('坏状态文件失败关闭且原字节不被覆盖', async () => {
    const seed = new Map<string, string | Uint8Array>([['pluginData:/publish-review/state.json', '{bad-json']]);
    const h = await setup({ run: vi.fn() }, false, seed);
    expect(h.store.failure).toBeTruthy();
    expect(await h.service.nominate(input())).toMatchObject({ refused: expect.any(String) });
    expect(seed.get('pluginData:/publish-review/state.json')).toBe('{bad-json');
  });

  it('状态 JSON 形状坏也失败关闭，不能把坏队列当空队列', async () => {
    const source = JSON.stringify({
      version: 1,
      queue: { abcdefghij: { id: 'abcdefghij', state: 'queued', files: [] } },
      ledger: {},
      nominations: [],
    });
    const seed = new Map<string, string | Uint8Array>([['pluginData:/publish-review/state.json', source]]);
    const h = await setup({ run: vi.fn() }, false, seed);
    expect(h.store.failure).toBeTruthy();
    expect(await h.service.nominate(input())).toHaveProperty('refused');
    expect(seed.get('pluginData:/publish-review/state.json')).toBe(source);
  });

  it('人工审核默认关：自动拿不准转人工且不发布；开启后自动通过仍须人工批准', async () => {
    const unsure = await setup({
      run: async () => ({ verdict: { verdict: 'unsure', reasons: ['拿不准'] }, files: input().files }),
    });
    const a = await unsure.service.nominate(input());
    if (!('id' in a)) throw new Error(a.refused);
    await unsure.service.processNext();
    expect(unsure.service.get(a.id)?.state).toBe('awaiting-owner');
    expect(unsure.store.data.queue[a.id].awaitingReason).toBe('fallback');
    expect(unsure.service.listPublished('works')).toEqual([]);
    expect(unsure.seed.has(`public:/${a.id}/files/work.png`)).toBe(false);
    await vi.waitFor(() => expect(unsure.notices.join(' ')).toContain('owner'));

    const manual = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      true,
    );
    const b = await manual.service.nominate(input());
    if (!('id' in b)) throw new Error(b.refused);
    await manual.service.processNext();
    expect(manual.service.get(b.id)?.state).toBe('awaiting-owner');
    expect(manual.store.data.queue[b.id].awaitingReason).toBe('required');
    expect(manual.service.listPublished('works')).toEqual([]);
  });

  it.each(['reject', 'unsure'] as const)('默认设置下 %s 审核结果可由人工批准，且重启对账不重跑', async verdict => {
    const seed = new Map<string, string | Uint8Array>();
    const run = vi.fn(async () => ({
      verdict: { verdict, reasons: ['模型审核证据'] },
      files: input().files,
      evidence: {
        flags: ['需确认'],
        reasons: ['模型审核证据'],
        images: [{ name: 'image-1.png', bytes: new Uint8Array([1, 2]) }],
        classification: verdict,
      },
    }));
    const first = await setup({ run }, false, seed);
    const nomination = await first.service.nominate(input());
    if (!('id' in nomination)) throw new Error(nomination.refused);
    const { id } = nomination;
    await first.service.processNext();
    expect(first.store.data.queue[id]).toMatchObject({
      state: 'awaiting-owner',
      awaitingReason: 'fallback',
      review: { flags: ['需确认'], reasons: ['模型审核证据'], classification: verdict },
    });
    expect(seed.get(`pluginData:/publish-review/items/${id}/review/image-1.png`)).toEqual(new Uint8Array([1, 2]));
    expect(seed.has(`public:/${id}/files/work.png`)).toBe(false);
    expect(first.notices.join(' ')).not.toContain('https://works.invalid');

    const resumed = await setup({ run }, false, seed);
    await resumed.service.reconcile();
    await resumed.service.processNext();
    expect(run).toHaveBeenCalledOnce();
    expect(resumed.store.data.queue[id]).toMatchObject({
      state: 'awaiting-owner',
      awaitingReason: 'fallback',
      review: { reasons: ['模型审核证据'], classification: verdict },
    });
    expect(await resumed.service.approve(id)).toBe(true);
    expect(resumed.service.listPublished('works')).toHaveLength(1);
    expect(seed.get(`public:/${id}/files/work.png`)).toEqual(image);
    expect(await resumed.service.approve(id)).toBe(false);
    expect(await resumed.service.reject(id)).toBe(false);
  });

  it('自动审核拒绝转人工后可拒绝一次，释放待审槽但仍占每日提名额', async () => {
    const h = await setup({
      run: async () => ({ verdict: { verdict: 'reject', reasons: ['其他'] }, files: input().files }),
    });
    const nomination = await h.service.nominate(input());
    if (!('id' in nomination)) throw new Error(nomination.refused);
    await h.service.processNext();
    expect(h.store.data.queue[nomination.id]?.state).toBe('awaiting-owner');
    expect(await h.service.reject(nomination.id)).toBe(true);
    expect(await h.service.reject(nomination.id)).toBe(false);
    expect(await h.service.approve(nomination.id)).toBe(false);
    expect(h.store.data.queue[nomination.id]).toBeUndefined();
    expect(h.store.data.nominations).toHaveLength(1);
    expect(h.service.listPublished('works')).toEqual([]);
  });

  it('模型拒绝类别保留在待裁决详情，即使图像证据未提供原因', async () => {
    const h = await setup({
      run: async () => ({
        verdict: { verdict: 'reject', reasons: ['个人信息'] },
        files: input().files,
        evidence: { flags: [], reasons: [], images: [], classification: 'reject' },
      }),
    });
    const nomination = await h.service.nominate(input());
    if (!('id' in nomination)) throw new Error(nomination.refused);
    await h.service.processNext();
    expect(h.store.data.queue[nomination.id].review?.reasons).toContain('个人信息');
    expect(h.service.listPublished('works')).toEqual([]);
  });

  it('默认设置下自动审核不确定的待裁决项超时后不发布，也不能再批准', async () => {
    const clock = { now: 1000 };
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'unsure', reasons: ['模型不可用'] }, files: input().files }) },
      false,
      new Map(),
      clock,
    );
    const nomination = await h.service.nominate(input());
    if (!('id' in nomination)) throw new Error(nomination.refused);
    await h.service.processNext();
    expect(h.service.get(nomination.id)?.state).toBe('awaiting-owner');
    clock.now += 12 * 3_600_000 + 1;
    await h.service.reconcile();
    expect(h.service.get(nomination.id)).toBeUndefined();
    expect(await h.service.approve(nomination.id)).toBe(false);
    expect(h.service.listPublished('works')).toEqual([]);
    expect(h.seed.has(`public:/${nomination.id}/files/work.png`)).toBe(false);
    await vi.waitFor(() => expect(h.notices.join(' ')).toContain('超过 12 小时'));
  });

  it('处理失败和输出文件校验失败不可人工批准', async () => {
    const failed = await setup({
      run: async () => ({ verdict: { verdict: 'failed', reasons: ['文件处理失败'] }, files: input().files }),
    });
    const first = await failed.service.nominate(input());
    if (!('id' in first)) throw new Error(first.refused);
    await failed.service.processNext();
    expect(failed.service.get(first.id)).toBeUndefined();
    expect(await failed.service.approve(first.id)).toBe(false);

    const invalid = await setup({
      run: async () => ({ verdict: { verdict: 'reject', reasons: ['其他'] }, files: [] }),
    });
    const second = await invalid.service.nominate(input());
    if (!('id' in second)) throw new Error(second.refused);
    await invalid.service.processNext();
    expect(invalid.service.get(second.id)).toBeUndefined();
    expect(await invalid.service.approve(second.id)).toBe(false);
    expect(invalid.service.listPublished('works')).toEqual([]);
  });

  it('审核在途时撤回，晚到的 allow 不得发布', async () => {
    let finish!: (value: Awaited<ReturnType<ReviewPipeline['run']>>) => void;
    const pipeline: ReviewPipeline = {
      run: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    };
    const h = await setup(pipeline);
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    const processing = h.service.processNext();
    await vi.waitFor(() => expect(h.service.get(result.id)?.state).toBe('checking'));
    expect(await h.service.withdraw(result.id, { kind: 'origin' }, '撤回')).toEqual({ ok: true });
    finish({ verdict: { verdict: 'allow', reasons: [] }, files: input().files });
    await processing;
    expect(h.service.listPublished('works')).toEqual([]);
  });

  it('公开根文件篡改后 readFile 撤下并抛完整性错误', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    expect(h.service.listPublished('works')).toHaveLength(1);
    h.seed.set(`public:/${result.id}/files/work.png`, new Uint8Array([1, 2, 3]));
    await expect(h.service.readFile(result.id, 'work.png')).rejects.toSatisfy(isIntegrityError);
    expect(h.service.get(result.id)?.state).toBe('withdrawn');
  });

  it('人工批准之前 out 字节被改动时失败关闭', async () => {
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      true,
    );
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    h.seed.set(`pluginData:/publish-review/items/${result.id}/out/work.png`, new Uint8Array([1, 2, 3]));
    expect(await h.service.approve(result.id)).toBe(false);
    expect(h.service.listPublished('works')).toEqual([]);
  });

  it('网址通知须等展示面报 live，重复 live 不重发', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    expect(h.notices).toEqual([]);
    const binding = h.service.attachSurface({
      name: 'works',
      urlFor: id => `https://works.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    binding.live([result.id]);
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain(`https://works.invalid/w/${result.id}/`);
    binding.live([result.id]);
    await vi.waitFor(() => expect(h.store.data.ledger[result.id].notice).toBe('sent'));
    expect(h.notices).toHaveLength(1);
  });

  it('待审配额按来源限制，撤回后释放待审槽', async () => {
    const h = await setup({ run: vi.fn() });
    for (let i = 0; i < 3; i++) expect(await h.service.nominate(input())).toHaveProperty('id');
    expect(await h.service.nominate(input())).toEqual({
      refused: '这个来源待审作品已达上限',
      retryAfterMs: 30_000,
    });
    const id = Object.keys(h.store.data.queue)[0];
    expect(await h.service.withdraw(id, { kind: 'origin' }, '撤回')).toEqual({ ok: true });
    expect(await h.service.nominate(input())).toHaveProperty('id');
  });

  it('总待审限额是临时拒绝；滚动每日限额返回确切释放时间，静态错误不带重试标记', async () => {
    const clock = { now: 1000 };
    const global = await setup({ run: vi.fn() }, false, new Map(), clock);
    for (let index = 0; index < 20; index++) {
      const draft = input();
      draft.origin.notify!.sessionId = `room-${index}`;
      expect(await global.service.nominate(draft)).toHaveProperty('id');
    }
    const another = input();
    another.origin.notify!.sessionId = 'room-extra';
    expect(await global.service.nominate(another)).toEqual({ refused: '待审总数已达上限', retryAfterMs: 30_000 });

    const daily = await setup({ run: vi.fn() }, false, new Map(), clock);
    for (let index = 0; index < 10; index++) {
      const draft = input();
      draft.origin.ref = `task-${index}`;
      const accepted = await daily.service.nominate(draft);
      if (!('id' in accepted)) throw new Error(accepted.refused);
      await daily.service.withdraw(accepted.id, { kind: 'origin' }, 'test');
    }
    expect(await daily.service.nominate(input())).toEqual({
      refused: '这个来源今天提名数已达上限',
      retryAfterMs: 86_400_001,
    });
    clock.now += 86_400_000;
    expect(await daily.service.nominate(input())).toMatchObject({ retryAfterMs: 1 });
    clock.now++;
    expect(await daily.service.nominate(input())).toHaveProperty('id');
    expect(await daily.service.nominate({ ...input(), title: '' })).toEqual({ refused: '标题或简介不合规' });
  });

  it('服务停机和快照暂时写失败可重试，失败时不占提交键', async () => {
    const h = await setup({ run: vi.fn() });
    const original = h.storage.writeFile.bind(h.storage);
    h.storage.writeFile = async (uri, value) => {
      if (uri.includes('/items/')) throw new Error('temporary storage failure');
      return original(uri, value);
    };
    const keyed = { ...input(), submissionKey: 'retryable-write' };
    expect(await h.service.nominate(keyed)).toEqual({ refused: '提名快照无法保存', retryAfterMs: 30_000 });
    expect(h.store.data.submissions).toEqual({});
    expect(h.store.data.queue).toEqual({});
    h.storage.writeFile = original;
    expect(await h.service.nominate(keyed)).toHaveProperty('id');
    await h.service.close();
    expect(await h.service.nominate({ ...input(), submissionKey: 'after-stop' })).toEqual({
      refused: '作品审核已停止',
      retryAfterMs: 30_000,
    });
    expect(h.store.data.submissions).not.toHaveProperty(JSON.stringify(['paper', 'after-stop']));
  });

  it('拒绝与撤回仍计入每日配额；无房间来源按 producer 合并不同 ref', async () => {
    const h = await setup({
      run: async () => ({ verdict: { verdict: 'reject', reasons: ['其他'] }, files: input().files }),
    });
    const noRoom = (ref: string) => ({ ...input(), origin: { producer: 'paper', ref, label: '来源' } });
    for (let i = 0; i < 10; i++) {
      const result = await h.service.nominate(noRoom(`task-${i}`));
      if (!('id' in result)) throw new Error(result.refused);
      if (i % 2 === 0) await h.service.withdraw(result.id, { kind: 'origin' }, '撤回');
      else {
        await h.service.processNext();
        expect(await h.service.reject(result.id)).toBe(true);
      }
    }
    expect(await h.service.nominate(noRoom('task-11'))).toMatchObject({ refused: expect.stringContaining('今天') });
  });

  it('get 返回来源快照，不能经引用改写账本与通知归宿', async () => {
    const h = await setup({ run: vi.fn() });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    const view = h.service.get(result.id);
    if (!view) throw new Error('entry missing');
    view.origin.notify!.sessionId = 'forged-room';
    expect(h.service.get(result.id)?.origin.notify?.sessionId).toBe('room-1');
  });

  it('人工审核等待到期不发布；上线延迟通知一次，后来 live 再发网址', async () => {
    const clock = { now: 1000 };
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      true,
      new Map(),
      clock,
    );
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    clock.now += 12 * 3_600_000 + 1;
    await h.service.reconcile();
    expect(h.service.get(result.id)).toBeUndefined();
    await vi.waitFor(() => expect(h.notices.join(' ')).toContain('超过 12 小时'));

    const autoClock = { now: 1000 };
    const auto = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      new Map(),
      autoClock,
    );
    const b = await auto.service.nominate(input());
    if (!('id' in b)) throw new Error(b.refused);
    await auto.service.processNext();
    autoClock.now += 30 * 60_000 + 1;
    await auto.service.reconcile();
    await auto.service.reconcile();
    await vi.waitFor(() => expect(auto.notices).toHaveLength(1));
    expect(auto.notices[0]).toContain('暂时没能上线');
    auto.service
      .attachSurface({ name: 'works', urlFor: id => `https://works.invalid/w/${id}/`, health: () => ({ ok: true }) })
      .live([b.id]);
    await vi.waitFor(() => expect(auto.notices).toHaveLength(2));
    expect(auto.notices[1]).toContain(`https://works.invalid/w/${b.id}/`);
  });

  it('旧句柄不能拆新展示面；订阅者抛错不影响其他订阅者', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const old = h.service.attachSurface({
      name: 'works',
      urlFor: () => 'https://old.invalid/',
      health: () => ({ ok: true }),
    });
    h.service.attachSurface({ name: 'works', urlFor: () => 'https://new.invalid/', health: () => ({ ok: true }) });
    old.detach();
    let calls = 0;
    h.service.onChange(() => {
      throw new Error('listener failed');
    });
    h.service.onChange(() => {
      calls++;
    });
    const result = await h.service.nominate(input());
    expect(result).toHaveProperty('id');
    await h.service.processNext();
    expect(calls).toBe(1);
  });

  it('重启后清掉账外公开目录与已撤下残留，保留已发布作品', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      seed,
    );
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    seed.set('public:/abcdefghij/files/work.png', image);
    const restarted = await setup({ run: vi.fn() }, false, seed);
    await restarted.service.reconcile();
    expect(seed.has('public:/abcdefghij/files/work.png')).toBe(false);
    expect(seed.has(`public:/${result.id}/files/work.png`)).toBe(true);
  });

  it('重启对账发现同一 id 同时在队列和账本时清掉队列及私有临时目录', async () => {
    const seed = new Map<string, string | Uint8Array>();
    const h = await setup(
      { run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) },
      false,
      seed,
    );
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    const ledger = h.store.data.ledger[result.id];
    const duplicate = {
      ...ledger,
      state: 'queued',
      hasCover: false,
      files: ledger.files.map(({ path, size, contentType }) => ({ path, size, contentType })),
    };
    const state = JSON.parse(String(seed.get('pluginData:/publish-review/state.json')));
    state.queue[result.id] = duplicate;
    seed.set('pluginData:/publish-review/state.json', JSON.stringify(state));
    seed.set(`pluginData:/publish-review/items/${result.id}/src/work.png`, image);
    const restarted = await setup({ run: vi.fn() }, false, seed);
    await restarted.service.reconcile();
    expect(restarted.store.data.queue[result.id]).toBeUndefined();
    expect(seed.has(`pluginData:/publish-review/items/${result.id}/src/work.png`)).toBe(false);
  });

  it('旧展示面 live 写盘挂起时被替换，不能发旧网址且新句柄仍可报在线', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    const old = h.service.attachSurface({
      name: 'works',
      urlFor: id => `https://old.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    const original = h.storage.writeFile.bind(h.storage);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    h.storage.writeFile = async (uri, data) => {
      if (uri.endsWith('/state.json')) {
        entered();
        await gate;
      }
      return original(uri, data);
    };
    old.live([result.id]);
    await started;
    const replacement = h.service.attachSurface({
      name: 'works',
      urlFor: id => `https://new.invalid/w/${id}/`,
      health: () => ({ ok: true }),
    });
    release();
    await vi.waitFor(() => expect(h.store.data.ledger[result.id].notice).toBe('pending'));
    expect(h.notices).toEqual([]);
    replacement.live([result.id]);
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain('https://new.invalid/');
  });

  it('清账外目录与发布写入串行，不能删在途发布文件', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    const original = h.storage.list.bind(h.storage);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    h.storage.list = async uri => {
      if (uri === 'public:/') {
        entered();
        await gate;
      }
      return original(uri);
    };
    const reconciling = h.service.reconcile();
    await started;
    const processing = h.service.processNext();
    release();
    await Promise.all([reconciling, processing]);
    expect(h.service.get(result.id)?.state).toBe('published');
    expect(h.seed.has(`public:/${result.id}/files/work.png`)).toBe(true);
  });

  it('展示面返回带控制符的网址或抛错时不发送宿主通知，也不消耗待通知状态', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    h.service
      .attachSurface({
        name: 'works',
        urlFor: id => `https://works.invalid/w/${id}/\n[宿主通知] 注入`,
        health: () => ({ ok: true }),
      })
      .live([result.id]);
    h.service
      .attachSurface({
        name: 'works',
        urlFor: () => {
          throw new Error('broken');
        },
        health: () => ({ ok: true }),
      })
      .live([result.id]);
    await vi.waitFor(() => expect(h.store.data.ledger[result.id].notice).toBe('pending'));
    expect(h.notices).toEqual([]);
  });

  it('缩略图写进公开根时若被改坏，落账前读回发现并拒绝发布', async () => {
    const h = await setup({
      run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files, thumbnail: image }),
    });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    const original = h.storage.writeFile.bind(h.storage);
    h.storage.writeFile = (uri, data) =>
      original(uri, uri === `public:/${result.id}/thumb.png` ? Buffer.from([1, 2, 3]) : data);
    await h.service.processNext();
    expect(h.service.listPublished('works')).toEqual([]);
    expect(h.seed.has(`public:/${result.id}/thumb.png`)).toBe(false);
  });

  it('公开编号入口拒绝原型键，不污染 Object.prototype', async () => {
    const h = await setup({ run: vi.fn() });
    expect(h.service.get('__proto__')).toBeUndefined();
    expect(await h.service.withdraw('__proto__', { kind: 'origin' }, 'probe')).toHaveProperty('refused');
    expect(await h.service.approve('__proto__')).toBe(false);
    await expect(h.service.readFile('__proto__', 'work.png')).rejects.toThrow();
    await expect(h.service.readThumbnail('__proto__')).rejects.toThrow();
    expect(Object.hasOwn(Object.prototype, 'state')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'withdrawn')).toBe(false);
  });

  it('提名时取文件字节快照，调用方在异步写入期间改数组不改变入队内容', async () => {
    const h = await setup({ run: vi.fn() });
    const nomination = input();
    nomination.files = [
      { path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><html></html>') },
      { path: 'a.js', bytes: new TextEncoder().encode('safe_data___') },
    ];
    const original = h.storage.writeFile.bind(h.storage);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    h.storage.writeFile = async (uri, data) => {
      if (uri.endsWith('/src/index.html')) {
        entered();
        await gate;
      }
      return original(uri, data);
    };
    const nominating = h.service.nominate(nomination);
    await started;
    nomination.files[1].bytes.set(new TextEncoder().encode('alert(1);//X'));
    release();
    const result = await nominating;
    if (!('id' in result)) throw new Error(result.refused);
    expect(
      Buffer.from(h.seed.get(`pluginData:/publish-review/items/${result.id}/src/a.js`) as Uint8Array).toString(),
    ).toBe('safe_data___');
  });

  it('审核流水不能用重复路径替换另一文件，也不能输出超限字节', async () => {
    const two = input();
    two.files = [
      { path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><html></html>') },
      { path: 'a.js', bytes: new TextEncoder().encode('safe') },
    ];
    const duplicate = await setup({
      run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: [two.files[0], two.files[0]] }),
    });
    const first = await duplicate.service.nominate(two);
    if (!('id' in first)) throw new Error(first.refused);
    await duplicate.service.processNext();
    expect(duplicate.service.listPublished('works')).toEqual([]);

    const oversized = await setup({
      run: async () => ({
        verdict: { verdict: 'allow', reasons: [] },
        files: [{ path: 'work.png', bytes: new Uint8Array(25 * 1024 * 1024 + 1) }],
      }),
    });
    const second = await oversized.service.nominate(input());
    if (!('id' in second)) throw new Error(second.refused);
    await oversized.service.processNext();
    expect(oversized.service.listPublished('works')).toEqual([]);
  });

  it('展示面 health 抛错时撤下仍返回已成功且标 degraded', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    await h.service.processNext();
    h.service.attachSurface({
      name: 'works',
      urlFor: () => '',
      health: () => {
        throw new Error('unavailable');
      },
    });
    expect(await h.service.withdraw(result.id, { kind: 'owner' }, '撤下')).toEqual({
      ok: true,
      degraded: '展示面状态暂不可核对',
    });
    expect(h.service.get(result.id)?.state).toBe('withdrawn');
  });

  it('发布态账本瞬时写失败保留审核结果，不能误报文件完整性失败', async () => {
    const h = await setup({ run: async () => ({ verdict: { verdict: 'allow', reasons: [] }, files: input().files }) });
    const result = await h.service.nominate(input());
    if (!('id' in result)) throw new Error(result.refused);
    const original = h.storage.writeFile.bind(h.storage);
    let once = true;
    h.storage.writeFile = async (uri, data) => {
      if (once && uri.endsWith('/state.json') && typeof data === 'string' && data.includes('"state":"published"')) {
        once = false;
        throw new Error('transient storage write');
      }
      return original(uri, data);
    };
    await expect(h.service.processNext()).rejects.toThrow('transient storage write');
    expect(h.service.get(result.id)?.state).toBe('checking');
    expect(h.store.data.queue[result.id].outHashes).toBeDefined();
    expect(h.seed.has(`public:/${result.id}/files/work.png`)).toBe(true);
    expect(h.notices).toEqual([]);
  });
});
