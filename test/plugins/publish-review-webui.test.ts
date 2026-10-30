import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { t } from '../../packages/plugin-publish-review/src/texts.js';
import { registerReviewPage } from '../../packages/plugin-publish-review/src/webui.js';
import { type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { boundStorage } from '../fixtures/own-storage.js';
import { type PageHost, pageHost, replyOf } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 作品审核页：经 webui-server 的真实登记表登记（质量门槛）、取数与调动作（闸门）。
// 渲染图与图像件交存储地址，宿主换成 /api/media；审核文件只列名字。待裁决数与记录故障发提示，记录变了页面重取。
// ════════════════════════════════════════════════════════════

const id = 'abcdefgabc';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const html = Buffer.from('<!doctype html><title>reviewed</title>');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ITEM = `pluginData:/publish-review/items/${id}`;
const media = (uri: string) => `/api/media?${new URLSearchParams({ uri })}`;
/** 历史的结论：从旧到新，最后一个是表外的值 */
const EVENTS = [
  'nominated',
  'awaiting-owner',
  'approved',
  'published',
  'rejected',
  'expired',
  'failed',
  'withdrawn',
  'integrity-failed',
  'live',
  'notice-delayed',
  'notice-abandoned',
  'notice-retry',
  'zz-event',
];
const PREVIEW_NOTE = {
  en: 'Opens only in a browser on the machine running Aalis; on a remote WebUI, 127.0.0.1 points to your own device. Closes automatically after the decision. Scripts in the work run in the preview and may leak this machine’s public address through WebRTC/STUN.',
  'zh-CN':
    '只在 Aalis 所在机器的本机浏览器能打开；远程 WebUI 的 127.0.0.1 指向你的设备。裁决后自动关闭。作品里的脚本在预览里会运行，并可能通过 WebRTC/STUN 泄露这台机器的出口地址。',
};

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

async function fixture(opts: { failure?: TextRef; reviewEnabled?: boolean } = {}) {
  const files = new Map<string, string | Buffer>();
  const storage = {
    readFile: async (uri: string) => {
      const file = files.get(uri);
      if (file === undefined) throw new Error('missing');
      return file;
    },
    writeFile: async (uri: string, data: string | Buffer) => void files.set(uri, data),
  };
  const store = new ReviewStore(boundStorage(storage as never, 'publish-review'));
  store.failure = opts.failure;
  store.data.queue[id] = {
    id,
    state: 'awaiting-owner',
    origin: { producer: 'paper', ref: 'task', label: '群友点子' },
    group: 'room',
    groupLabel: 'room',
    surfaces: ['works'],
    title: '作品',
    summary: '',
    kind: 'html',
    files: [{ path: 'index.html', size: html.length, contentType: 'text/html; charset=utf-8' }],
    hasCover: false,
    nominatedAt: 100,
    awaitingSince: 200,
    awaitingReason: 'fallback',
    outHashes: { 'index.html': sha(html) },
    thumbnailHash: sha(png),
    review: {
      flags: ['外链'],
      reasons: ['暴力血腥', '其他', '需人工'],
      images: ['frame-1.png'],
      hasRender: true,
      classification: '拿不准',
    },
  };
  const preview = {
    active: [] as Array<{ id: string; url: string }>,
    open: vi.fn(async () => 'http://127.0.0.1:1234/token/'),
    revoke: vi.fn(),
  };
  const service = {
    approve: vi.fn(async () => true),
    reject: vi.fn(async () => true),
    abandonedNotices: () => [],
    retryNotice: vi.fn(async (): Promise<TextRef | undefined> => t('noticeNotAbandoned')),
  };
  const app = new App({ name: 'T', logLevel: 'error' });
  const pages = pageHost();
  running.push({ app, pages });
  app.bind({ provide }).provide.use(webuiServer, pages.service);
  await app.plugin(
    definePlugin({
      name: 'zz-review-page',
      uses: { webui: webuiServer },
      apply: ({ webui }) =>
        registerReviewPage({
          webui: webui.use,
          service: service as never,
          store,
          preview: preview as never,
          ownerTimeoutHours: 12,
          reviewEnabled: opts.reviewEnabled ?? true,
          now: () => 1000,
        }),
    }),
  );
  await app.plugins.idle();
  return { store, pages, preview, service };
}

describe('作品审核页', () => {
  it('过登记门槛：四个标签；待裁决行的渲染图交存储地址，宿主换成 /api/media', async () => {
    const h = await fixture();
    expect(h.pages.logs).toEqual([]);
    const view = toSource(h.pages.view('publish-review'));
    expect(view).toMatchObject({ title: '作品审核', placement: 'plugin', icon: 'shield-check' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual([
      '待裁决',
      '审核中',
      '没发出的通知',
      '历史',
    ]);
    expect(toSource(await h.pages.data('publish-review', 'pending'))).toEqual([
      {
        id,
        render: media(`${ITEM}/review/render.png`),
        title: '作品',
        kind: '网页',
        html: true,
        source: '群友点子',
        awaitingReason: '自动审核未通过，需人工裁决',
        deadline: 200 + 12 * 3_600_000,
      },
    ]);
  });

  it('没有渲染图时用审核后的缩略图；配置要求人工审核的写明原因', async () => {
    const h = await fixture();
    const item = h.store.data.queue[id];
    item.review = { ...item.review!, hasRender: false };
    item.awaitingReason = 'required';
    expect(toSource(await h.pages.data('publish-review', 'pending'))).toMatchObject([
      { render: media(`${ITEM}/out/_thumb.png`), awaitingReason: '配置要求人工审核' },
    ]);
  });

  it('详情：图像件（/api/media 地址）与文件（只列名字）；不是待裁决的作品回错误', async () => {
    const h = await fixture();
    expect(await h.pages.data('publish-review', 'images', { rowKey: id })).toEqual([
      { name: 'frame-1.png', image: media(`${ITEM}/review/frame-1.png`) },
    ]);
    expect(await h.pages.data('publish-review', 'files', { rowKey: id })).toEqual([
      { path: 'index.html', contentType: 'text/html; charset=utf-8', size: html.length },
    ]);
    await expect(h.pages.data('publish-review', 'files', { rowKey: 'zzzzzzzzzz' })).rejects.toThrow(
      '没有这件待裁决作品',
    );
  });

  it('批准与拒绝：交给发布服务并关掉预览；隔离预览回地址并让预览区重取，媒体作品不能预览', async () => {
    const h = await fixture();
    expect(await h.pages.act('publish-review', 'openPreview', { rowKey: id })).toMatchObject({ status: 200 });
    expect(h.pages.invalidations).toContainEqual({
      instance: 'zz-review-page',
      pageKey: 'publish-review',
      componentId: 'previews',
    });
    expect(await h.pages.act('publish-review', 'approveWork', { rowKey: id })).toMatchObject({ status: 200 });
    expect(h.service.approve).toHaveBeenCalledWith(id);
    expect(h.preview.revoke).toHaveBeenCalledWith(id);
    expect(await h.pages.act('publish-review', 'rejectWork', { rowKey: id })).toMatchObject({ status: 200 });
    expect(h.service.reject).toHaveBeenCalledWith(id);

    h.store.data.queue[id].kind = 'media';
    expect(await h.pages.act('publish-review', 'openPreview', { rowKey: id })).toMatchObject({ status: 500 });
    h.service.approve.mockResolvedValueOnce(false);
    expect(await h.pages.act('publish-review', 'approveWork', { rowKey: id })).toMatchObject({ status: 500 });
  });

  it('重发没发出的通知：发布服务拒绝时回它的原因', async () => {
    const h = await fixture();
    expect(toSource(await h.pages.act('publish-review', 'retryNotice', { rowKey: 'n1' }))).toEqual({
      status: 500,
      body: { error: '没有这条已放弃的通知' },
    });
    expect(h.service.retryNotice).toHaveBeenCalledWith('n1');
  });

  it('待裁决数发提示，标题写数量、跳到审核页；记录变了页面重取，清空后撤回', async () => {
    const h = await fixture();
    expect(toSource(h.pages.notices())).toEqual([
      {
        instance: 'zz-review-page',
        id: 'pending',
        level: 'action',
        title: '1 件作品待裁决',
        open: { page: 'publish-review' },
      },
    ]);
    const before = h.pages.invalidations.length;
    const next = h.store.copy();
    delete next.queue[id];
    await h.store.save(next);
    expect(h.pages.invalidations.slice(before)).toContainEqual({
      instance: 'zz-review-page',
      pageKey: 'publish-review',
    });
    expect(h.pages.notices()).toEqual([]);
  });

  it('记录读取失败：发「出错」提示，裁决与预览一律回错误', async () => {
    const h = await fixture({ failure: t('ledgerUnreadable') });
    expect(toSource(h.pages.notices())).toContainEqual(
      expect.objectContaining({ id: 'ledger', level: 'error', title: '作品记录读取失败' }),
    );
    for (const action of ['approveWork', 'rejectWork', 'openPreview']) {
      expect(toSource(await h.pages.act('publish-review', action, { rowKey: id }))).toEqual({
        status: 500,
        body: { error: '作品记录读取失败，等 owner 处理' },
      });
    }
    expect(h.service.approve).not.toHaveBeenCalled();
    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it.each([
    [
      'en',
      {
        counts: [
          { label: 'Awaiting decision', value: 1 },
          { label: 'In review', value: 2 },
          { label: 'Nominated today', value: 0 },
          { label: 'Published', value: 0 },
          { label: 'Content review', value: 'On' },
        ],
        pending: [['Web page', 'Automatic review did not pass; needs a manual decision']],
        verdict: [
          { label: 'Classification', value: '拿不准' },
          { label: 'Flags', value: 'Active content, External links, zz-flag' },
          { label: 'Reasons', value: 'Violence or gore, Other, 需人工' },
        ],
        steps: ['Queued', 'Processing'],
        events: [
          'Nominated',
          'Awaiting decision',
          'Approved',
          'Published',
          'Rejected',
          'Expired',
          'Failed',
          'Withdrawn',
          'Integrity check failed',
          'Live',
          'Going live delayed',
          'Notice abandoned',
          'Notice resent',
          'zz-event',
        ],
        noPreviews: 'No previews are open.',
        notices: ['1 work awaiting decision', '2 works awaiting decision'],
        replies: [
          'Isolated preview opened: http://127.0.0.1:1234/token/',
          'Approved 作品',
          'Rejected 作品',
          'Queued for resending',
          'The isolated preview could not start, or the review files changed',
          'The work changed or publishing failed',
          'The work changed and cannot be rejected',
          'No such work awaiting decision',
          'Only web page works can be previewed in isolation',
        ],
      },
    ],
    [
      'zh-CN',
      {
        counts: [
          { label: '待裁决', value: 1 },
          { label: '审核中', value: 2 },
          { label: '今天提名', value: 0 },
          { label: '已发布', value: 0 },
          { label: '内容审核', value: '开启' },
        ],
        pending: [['网页', '自动审核未通过，需人工裁决']],
        verdict: [
          { label: '分类结论', value: '拿不准' },
          { label: '标记', value: '活动内容、外链、zz-flag' },
          { label: '理由', value: '暴力血腥、其他、需人工' },
        ],
        steps: ['排队中', '处理中'],
        events: [
          '已提名',
          '待裁决',
          '已批准',
          '已发布',
          '已拒绝',
          '已过期',
          '失败',
          '已撤下',
          '完整性核对失败',
          '已上线',
          '上线延迟',
          '通知已放弃',
          '通知重发',
          'zz-event',
        ],
        noPreviews: '目前没有打开的预览。',
        notices: ['1 件作品待裁决', '2 件作品待裁决'],
        replies: [
          '隔离预览已打开：http://127.0.0.1:1234/token/',
          '已批准 作品',
          '已拒绝 作品',
          '已重新排队发送',
          '隔离预览无法启动或审核文件已变更',
          '作品已变更或发布失败',
          '作品已变更，无法拒绝',
          '没有这件待裁决作品',
          '只有网页作品能隔离预览',
        ],
      },
    ],
  ] as const)('%s：概况、待裁决、自动审核、审核中的步骤、历史的结论、隔离预览、提示与动作的回执和报错（不在表里的标记与结论显示原值）', async (language, expected) => {
    const h = await fixture();
    const item = h.store.data.queue[id];
    item.review = { ...item.review!, flags: ['活动内容', '外链', 'zz-flag'] };
    for (const [key, state] of [
      ['bcdefgabcd', 'queued'],
      ['cdefgabcde', 'checking'],
    ] as const)
      h.store.data.queue[key] = { ...item, id: key, state, title: key };
    h.store.data.history = EVENTS.map((event, i) => ({ at: i, id, event, detail: '' }));
    const data = async (component: string, query?: Record<string, unknown>) =>
      renderIn(await h.pages.data<Array<Record<string, unknown>>>('publish-review', component, query), language);
    expect(await data('counts')).toEqual(expected.counts);
    expect((await data('pending')).map(row => [row.kind, row.awaitingReason])).toEqual(expected.pending);
    expect(await data('verdict', { rowKey: id })).toEqual(expected.verdict);
    expect((await data('checking')).map(row => row.state)).toEqual(expected.steps);
    expect((await data('history')).map(row => row.event)).toEqual([...expected.events].reverse());

    expect(renderIn(await h.pages.data('publish-review', 'previews'), language)).toBe(
      `${expected.noPreviews}\n\n${PREVIEW_NOTE[language]}`,
    );
    h.preview.active.push(
      { id, url: 'http://127.0.0.1:1234/a/' },
      { id: 'bcdefgabcd', url: 'http://127.0.0.1:1234/b/' },
    );
    expect(renderIn(await h.pages.data('publish-review', 'previews'), language)).toBe(
      `- [${id}](http://127.0.0.1:1234/a/)\n- [bcdefgabcd](http://127.0.0.1:1234/b/)\n\n${PREVIEW_NOTE[language]}`,
    );

    const titles = [h.pages.notices()[0].title];
    const next = h.store.copy();
    next.queue.defgabcdef = { ...item, id: 'defgabcdef' };
    await h.store.save(next);
    titles.push(h.pages.notices()[0].title);
    expect(renderIn(titles, language)).toEqual(expected.notices);

    const act = (action: string, rowKey: string) => h.pages.act('publish-review', action, { rowKey });
    h.service.retryNotice.mockResolvedValueOnce(undefined as never);
    const replies = [
      await act('openPreview', id),
      await act('approveWork', id),
      await act('rejectWork', id),
      await act('retryNotice', 'n1'),
    ];
    h.preview.open.mockRejectedValueOnce(new Error('x'));
    h.service.approve.mockResolvedValueOnce(false);
    h.service.reject.mockResolvedValueOnce(false);
    replies.push(await act('openPreview', id), await act('approveWork', id), await act('rejectWork', id));
    replies.push(await act('approveWork', 'zzzzzzzzzz'));
    h.store.data.queue[id].kind = 'media';
    replies.push(await act('openPreview', id));
    expect(renderIn(replies.map(replyOf), language)).toEqual(expected.replies);
  });

  it('历史一行只发显示的几栏：撤下时另存的撤下的一方与理由不发到前端', async () => {
    const h = await fixture();
    h.store.data.history = [
      {
        at: 1,
        id,
        event: 'withdrawn',
        detail: t('withdrawnByOwner'),
        withdrawn: { by: 'owner', reason: 'owner 在作品页撤下' },
      },
    ];
    expect(toSource(await h.pages.data('publish-review', 'history'))).toEqual([
      { key: '0', at: 1, id, event: '已撤下', detail: 'owner 撤下' },
    ]);
  });

  it('内容审核关闭时概况写明自动发布', async () => {
    const h = await fixture({ reviewEnabled: false });
    expect(toSource(await h.pages.data('publish-review', 'counts'))).toContainEqual({
      label: '内容审核',
      value: '已关闭：作品通过文件处理后自动发布，不运行模型或人工内容审核',
    });
  });
});
