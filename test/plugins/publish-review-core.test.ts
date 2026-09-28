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
  credit: '来自群友的点子',
  files: [{ path: 'work.png', bytes: image }],
});

const config = (manualReview = false): ReviewConfig => ({
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
    expect(await h.service.nominate(input())).toMatchObject({ refused: expect.stringContaining('待审') });
    const id = Object.keys(h.store.data.queue)[0];
    expect(await h.service.withdraw(id, { kind: 'origin' }, '撤回')).toEqual({ ok: true });
    expect(await h.service.nominate(input())).toHaveProperty('id');
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
