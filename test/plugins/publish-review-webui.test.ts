import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { registerReviewPage } from '../../packages/plugin-publish-review/src/webui.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 作品审核页：经 webui-server 的真实登记表登记（质量门槛）、取数与调动作（闸门）。
// 渲染图与图像件交存储地址，宿主换成 /api/media；审核文件只列名字。待裁决数与账本故障发提示，账本变了页面重取。
// ════════════════════════════════════════════════════════════

const id = 'abcdefgabc';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const html = Buffer.from('<!doctype html><title>reviewed</title>');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ITEM = `pluginData:/publish-review/items/${id}`;
const media = (uri: string) => `/api/media?${new URLSearchParams({ uri })}`;

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

async function fixture(opts: { failure?: string; reviewEnabled?: boolean } = {}) {
  const files = new Map<string, string | Buffer>();
  const storage = {
    readFile: async (uri: string) => {
      const file = files.get(uri);
      if (file === undefined) throw new Error('missing');
      return file;
    },
    writeFile: async (uri: string, data: string | Buffer) => void files.set(uri, data),
  };
  const store = new ReviewStore(storage as never);
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
      reasons: ['需人工'],
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
    retryNotice: vi.fn(async () => '这条通知已经发出'),
  };
  const app = new App({ name: 'T', logLevel: 'error' });
  const pages = pageHost();
  running.push({ app, pages });
  app.bind({ provide }).provide(webuiServer, pages.service);
  await app.plugin(
    definePlugin({
      name: 'zz-review-page',
      uses: { webui: webuiServer },
      apply: ({ webui }) =>
        registerReviewPage({
          webui,
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
    const view = h.pages.view('publish-review');
    expect(view).toMatchObject({ title: '作品审核', placement: 'plugin', icon: 'shield-check' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual([
      '待裁决',
      '审核中',
      '没发出的通知',
      '历史',
    ]);
    expect(await h.pages.data('publish-review', 'pending')).toEqual([
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
    expect(await h.pages.data('publish-review', 'counts')).toEqual([
      { label: '待裁决', value: 1 },
      { label: '审核中', value: 0 },
      { label: '今天提名', value: 0 },
      { label: '已发布', value: 0 },
      { label: '内容审核', value: '开启' },
    ]);
  });

  it('没有渲染图时用审核后的缩略图；配置要求人工审核的写明原因', async () => {
    const h = await fixture();
    const item = h.store.data.queue[id];
    item.review = { ...item.review!, hasRender: false };
    item.awaitingReason = 'required';
    expect(await h.pages.data('publish-review', 'pending')).toMatchObject([
      { render: media(`${ITEM}/out/_thumb.png`), awaitingReason: '配置要求人工审核' },
    ]);
  });

  it('详情：自动审核的结论、图像件（/api/media 地址）与文件（只列名字）；不是待裁决的作品回错误', async () => {
    const h = await fixture();
    expect(await h.pages.data('publish-review', 'verdict', { rowKey: id })).toEqual([
      { label: '分类结论', value: '拿不准' },
      { label: '标记', value: '外链' },
      { label: '理由', value: '需人工' },
    ]);
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
    expect(await h.pages.act('publish-review', 'openPreview', { rowKey: id })).toEqual({
      status: 200,
      body: { message: '隔离预览已打开：http://127.0.0.1:1234/token/' },
    });
    expect(h.pages.invalidations).toContainEqual({
      instance: 'zz-review-page',
      pageKey: 'publish-review',
      componentId: 'previews',
    });
    expect(await h.pages.act('publish-review', 'approveWork', { rowKey: id })).toEqual({
      status: 200,
      body: { message: '已批准 作品' },
    });
    expect(h.service.approve).toHaveBeenCalledWith(id);
    expect(h.preview.revoke).toHaveBeenCalledWith(id);
    expect(await h.pages.act('publish-review', 'rejectWork', { rowKey: id })).toEqual({
      status: 200,
      body: { message: '已拒绝 作品' },
    });
    expect(h.service.reject).toHaveBeenCalledWith(id);

    h.store.data.queue[id].kind = 'media';
    expect(await h.pages.act('publish-review', 'openPreview', { rowKey: id })).toEqual({
      status: 500,
      body: { error: '只有网页作品能隔离预览' },
    });
    h.service.approve.mockResolvedValueOnce(false);
    expect(await h.pages.act('publish-review', 'approveWork', { rowKey: id })).toEqual({
      status: 500,
      body: { error: '作品已变更或发布失败' },
    });
  });

  it('重发没发出的通知：发布服务拒绝时回它的原因', async () => {
    const h = await fixture();
    expect(await h.pages.act('publish-review', 'retryNotice', { rowKey: 'n1' })).toEqual({
      status: 500,
      body: { error: '这条通知已经发出' },
    });
    expect(h.service.retryNotice).toHaveBeenCalledWith('n1');
  });

  it('待裁决数发提示，标题写数量、跳到审核页；账本变了页面重取，清空后撤回', async () => {
    const h = await fixture();
    expect(h.pages.notices()).toEqual([
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

  it('账本读取失败：发「出错」提示，裁决与预览一律回错误', async () => {
    const h = await fixture({ failure: '作品账本读取失败，等 owner 处理' });
    expect(h.pages.notices()).toContainEqual(
      expect.objectContaining({ id: 'ledger', level: 'error', title: '作品账本读取失败' }),
    );
    for (const action of ['approveWork', 'rejectWork', 'openPreview']) {
      expect(await h.pages.act('publish-review', action, { rowKey: id })).toEqual({
        status: 500,
        body: { error: '作品账本读取失败，等 owner 处理' },
      });
    }
    expect(h.service.approve).not.toHaveBeenCalled();
    expect(h.preview.open).not.toHaveBeenCalled();
  });

  it('内容审核关闭时概况写明自动发布', async () => {
    const h = await fixture({ reviewEnabled: false });
    expect(await h.pages.data('publish-review', 'counts')).toContainEqual({
      label: '内容审核',
      value: '已关闭：作品通过文件处理后自动发布，不运行模型或人工内容审核',
    });
  });
});
