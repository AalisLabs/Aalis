import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { registerReviewPage } from '../../packages/plugin-publish-review/src/webui.js';

const id = 'abcdefgabc';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const html = Buffer.from('<!doctype html><title>reviewed</title>');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function fixture() {
  const files = new Map([
    [`pluginData:/publish-review/items/${id}/out/index.html`, html],
    [`pluginData:/publish-review/items/${id}/out/_thumb.png`, png],
    [`pluginData:/publish-review/items/${id}/review/render.png`, png],
    [`pluginData:/publish-review/items/${id}/review/frame-1.png`, png],
  ]);
  const storage = {
    readFile: async (uri: string) => {
      const file = files.get(uri);
      if (!file) throw new Error('missing');
      return file;
    },
  };
  const store = new ReviewStore(storage as never);
  store.data.queue[id] = {
    id,
    state: 'awaiting-owner',
    origin: { producer: 'paper', ref: 'task', label: '群友点子' },
    group: 'room',
    groupLabel: 'room',
    surfaces: ['works'],
    title: '作品',
    summary: '',
    credit: '群友',
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
  const pages: unknown[] = [];
  const actions = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const webui = {
    registerPage(page: unknown) {
      pages.push(page);
      return () => {};
    },
    registerAction(name: string, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      actions.set(name, handler);
      return () => {};
    },
  };
  const preview = { active: [], open: vi.fn(async () => 'http://127.0.0.1:1234/token/'), revoke: vi.fn() };
  const service = {
    approve: vi.fn(async () => {
      delete store.data.queue[id];
      return true;
    }),
    reject: vi.fn(async () => {
      delete store.data.queue[id];
      return true;
    }),
  };
  registerReviewPage({
    webui: webui as never,
    service: service as never,
    store,
    storage: storage as never,
    preview: preview as never,
    ownerTimeoutHours: 12,
    now: () => 1000,
  });
  const call = (name: string, args: Record<string, unknown> = {}) => actions.get(name)!(args);
  return { store, files, pages, actions, preview, service, call };
}

describe('publish review WebUI', () => {
  it('exposes the five tabs, safe image columns, review evidence and local-preview action', async () => {
    const h = fixture();
    const page = h.pages[0] as {
      key: string;
      refresh?: number;
      content: Array<{ type: string; items?: Array<{ key: string; content: unknown[] }> }>;
    };
    expect(page.key).toBe('publish-review');
    const tabs = page.content.find(component => component.type === 'tabs')?.items ?? [];
    expect(tabs.map(tab => tab.key)).toEqual(['pending', 'images', 'files', 'checking', 'history']);
    const pendingTable = tabs[0].content[0] as { refresh: number; columns: Array<{ key: string; render?: string }> };
    expect(page.refresh).toBe(30);
    expect(pendingTable.refresh).toBeUndefined();
    expect(pendingTable.columns.find(column => column.key === 'render')?.render).toBe('image');
    const pending = (await h.call('reviewPending')) as Array<Record<string, unknown>>;
    expect(pendingTable.columns.some(column => column.key === 'awaitingReason')).toBe(true);
    expect(pending[0]).toMatchObject({
      id,
      render: `${id}/render.png`,
      flags: '外链',
      classification: '拿不准',
      awaitingReason: '自动审核未通过，需人工裁决',
    });
    expect(await h.call('reviewImages')).toEqual([{ id, title: '作品', image: 'frame-1.png' }]);
    expect(((await h.call('reviewReadRender', { id })) as { mime: string }).mime).toBe('image/png');
    expect(((await h.call('reviewReadImage', { id, image: 'frame-1.png' })) as { mime: string }).mime).toBe(
      'image/png',
    );
    expect(await h.call('reviewReadImage', { id, image: '../index.html' })).toMatchObject({ ok: false });
    expect(((await h.call('reviewFileAdvice')) as { content: string }).content).toContain(
      '不要在本机直接打开下载的网页文件',
    );
    const preview = await h.call('reviewOpenPreview', { id });
    expect(preview).toEqual({ ok: true, message: 'http://127.0.0.1:1234/token/' });
  });

  it('serves HTML only as octet-stream and refuses corrupted or unknown files', async () => {
    const h = fixture();
    const out = (await h.call('reviewReadFile', { id, filePath: 'index.html' })) as { mime: string; base64: string };
    expect(out.mime).toBe('application/octet-stream');
    expect(Buffer.from(out.base64, 'base64').toString()).toContain('reviewed');
    expect(await h.call('reviewReadFile', { id, filePath: '../../state.json' })).toMatchObject({ ok: false });
    h.files.set(`pluginData:/publish-review/items/${id}/out/index.html`, Buffer.from('tampered'));
    expect(await h.call('reviewReadFile', { id, filePath: 'index.html' })).toMatchObject({ ok: false });
  });

  it('allows manual fallback decisions and preview with manualReview false, while blocking read-only state', async () => {
    const approve = fixture();
    expect(await approve.call('reviewOpenPreview', { id })).toMatchObject({ ok: true });
    expect(await approve.call('reviewApprove', { id })).toMatchObject({ ok: true });
    expect(approve.service.approve).toHaveBeenCalledWith(id);
    expect(approve.preview.revoke).toHaveBeenCalledWith(id);
    const reject = fixture();
    expect(await reject.call('reviewReject', { id })).toMatchObject({ ok: true });
    expect(reject.service.reject).toHaveBeenCalledWith(id);
    expect(reject.preview.revoke).toHaveBeenCalledWith(id);
    const broken = fixture();
    broken.store.failure = '作品账本读取失败';
    expect(await broken.call('reviewApprove', { id })).toMatchObject({ ok: false });
    expect(await broken.call('reviewOpenPreview', { id })).toMatchObject({ ok: false });
    expect(broken.preview.open).not.toHaveBeenCalled();
    const required = fixture();
    required.store.data.queue[id]!.awaitingReason = 'required';
    expect(await required.call('reviewPending')).toMatchObject([{ awaitingReason: '配置要求人工审核' }]);
  });
});
