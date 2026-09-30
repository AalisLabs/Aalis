import { describe, expect, it, vi } from 'vitest';
import { type PublishSurface, publicWorkUrl } from '../../packages/api-publish/src/index.js';
import { configSchema } from '../../packages/plugin-publish-review/src/config.js';
import { PublishReviewService } from '../../packages/plugin-publish-review/src/service.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { memoryStorage } from '../fixtures/paper.js';

async function world() {
  const storage = memoryStorage(new Map());
  const store = new ReviewStore(storage);
  await store.load();
  const notice = vi.fn();
  const service = new PublishReviewService({
    storage,
    store,
    notice,
    config: parseConfig(configSchema, {}),
    pipeline: { run: async input => ({ verdict: { verdict: 'allow', reasons: [] }, files: [...input.files] }) },
  });
  const submit = async () => {
    const result = await service.nominate({
      origin: { producer: 'paper', ref: 'one', label: '试用', notify: { sessionId: 'room', platform: 'onebot' } },
      group: 'paper',
      groupLabel: '试用',
      surfaces: ['draw'],
      title: '作品',
      summary: '',
      files: [{ path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><html>作品</html>') }],
    });
    if (!('id' in result)) throw new Error(result.refused);
    await service.processNext();
    return result.id;
  };
  return { service, store, notice, submit };
}

const surface = (baseUrl = 'https://works.invalid/draw/'): PublishSurface => ({
  name: 'draw',
  label: '绘画站',
  baseUrl,
  urlFor: id => publicWorkUrl(baseUrl, id),
  health: () => ({ ok: true }),
});

describe('发布目标目录与回执', () => {
  it('目录目标上线后发出含前缀的网址，重复确认只通知一次', async () => {
    const h = await world();
    const binding = h.service.attachSurface(surface());
    const id = await h.submit();
    expect(h.notice).not.toHaveBeenCalled();
    binding.live([id]);
    await vi.waitFor(() => expect(h.notice).toHaveBeenCalledOnce());
    expect(h.notice.mock.calls[0][1]).toContain(`https://works.invalid/draw/w/${id}/`);
    binding.live([id]);
    await h.store.exclusive(async () => {});
    expect(h.notice).toHaveBeenCalledOnce();
  });

  it.each([
    'https://other.invalid/draw/',
    'https://111.works.invalid/draw/',
    'https://works.invalid/draw-other/',
    'https://works.invalid/',
  ])('拒绝登记范围外的上线网址 %s', async outside => {
    const h = await world();
    const binding = h.service.attachSurface({ ...surface(), urlFor: id => `${outside}w/${id}/` });
    const id = await h.submit();
    binding.live([id]);
    await h.store.exclusive(async () => {});
    expect(h.notice).not.toHaveBeenCalled();
    expect(h.store.data.ledger[id].notice).toBe('pending');
  });

  it('列出不带句柄的独立快照，健康异常逐项隔离，撤回立即消失', async () => {
    const h = await world();
    const off = h.service.attachSurface(surface());
    h.service.attachSurface({
      ...surface('https://other.invalid/'),
      name: 'other',
      health: () => {
        throw new Error('private');
      },
    });
    const entries = h.service.listSurfaces();
    expect(entries[0]).toEqual({
      name: 'draw',
      label: '绘画站',
      baseUrl: 'https://works.invalid/draw/',
      available: true,
    });
    expect(entries[1]).toMatchObject({ name: 'other', available: false });
    expect(JSON.stringify(entries)).not.toContain('private');
    entries[0].baseUrl = 'https://changed.invalid/';
    expect(h.service.listSurfaces()[0].baseUrl).toBe('https://works.invalid/draw/');
    off.detach();
    expect(h.service.listSurfaces().map(x => x.name)).toEqual(['other']);
  });

  it.each([
    'http://works.invalid/draw/',
    'https://user:pass@works.invalid/draw/',
    'https://works.invalid/draw/?x=1',
    'https://works.invalid/draw/#x',
    'https://works.invalid/draw/?',
    'https://works.invalid/draw/#',
    'https://works.invalid/draw/../',
    'https://works.invalid/%2e%2e/',
    'https://works.invalid/draw%2fother/',
    'https://works.invalid//draw/',
    'https://works.invalid/draw',
    'https://works.invalid/draw/\n',
  ])('拒绝非规范目录 %s 且不覆盖已有登记', async baseUrl => {
    const h = await world();
    h.service.attachSurface(surface());
    expect(() => h.service.attachSurface(surface(baseUrl))).toThrow();
    expect(h.service.listSurfaces()[0].baseUrl).toBe('https://works.invalid/draw/');
  });

  it('精确根地址与指定目录均可构造，不能以作品编号越界', () => {
    expect(publicWorkUrl('https://works.invalid/', 'abcdefghij')).toBe('https://works.invalid/w/abcdefghij/');
    expect(publicWorkUrl('https://works.invalid/draw/', 'abcdefghij')).toBe('https://works.invalid/draw/w/abcdefghij/');
    expect(() => publicWorkUrl('https://works.invalid/', '../evil')).toThrow();
  });
});
