import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewPreviewServer } from '../../packages/plugin-publish-review/src/preview.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';

const id = 'abcdefgabc';
const html = Buffer.from('<!doctype html><script>document.body.textContent="works"</script>');
const css = Buffer.from('body{color:red}');
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const instances: ReviewPreviewServer[] = [];

function fixture() {
  const files = new Map([
    [`pluginData:/publish-review/items/${id}/out/index.html`, html],
    [`pluginData:/publish-review/items/${id}/out/STYLE.CSS`, css],
  ]);
  const storage = {
    readFile: async (uri: string) => {
      const value = files.get(uri);
      if (!value) throw new Error('missing');
      return value;
    },
  };
  const store = new ReviewStore(storage as never);
  store.data.queue[id] = {
    id,
    state: 'awaiting-owner',
    origin: { producer: 'paper', ref: 'task', label: '群友' },
    group: 'room',
    groupLabel: 'room',
    surfaces: ['works'],
    title: '<x>',
    summary: '',
    kind: 'html',
    files: [
      { path: 'index.html', size: html.length, contentType: 'text/html; charset=utf-8' },
      { path: 'STYLE.CSS', size: css.length, contentType: 'text/css; charset=utf-8' },
    ],
    hasCover: false,
    nominatedAt: 1,
    awaitingSince: 2,
    outHashes: { 'index.html': sha(html), 'STYLE.CSS': sha(css) },
  };
  const preview = new ReviewPreviewServer({ store, storage: storage as never });
  instances.push(preview);
  return { preview, store, files };
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.close();
});

describe('publish review local preview', () => {
  it('binds loopback, uses a random in-memory token and serves wrapper plus normal CSS', async () => {
    const { preview } = fixture();
    const url = await preview.open(id);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
    const wrapper = await fetch(url);
    expect(wrapper.status).toBe(200);
    expect(wrapper.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const body = await wrapper.text();
    expect(body).toContain('sandbox="allow-scripts"');
    expect(body).not.toContain('<x>');
    const cssResponse = await fetch(`${url}w/STYLE.CSS`);
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(cssResponse.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(cssResponse.headers.get('vary')).toBe('Sec-Fetch-Dest');
    expect(await cssResponse.text()).toBe('body{color:red}');
  });

  it('rejects wrong Host, token and method; document redirects while absent dest gets a notice', async () => {
    const { preview } = fixture();
    const url = await preview.open(id);
    const wrongHost = await new Promise<{ status: number; csp: string | undefined }>((resolve, reject) => {
      const req = httpRequest(url, { headers: { Host: 'evil.example' } }, res => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            csp: Array.isArray(res.headers['content-security-policy'])
              ? res.headers['content-security-policy'][0]
              : res.headers['content-security-policy'],
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
    expect(wrongHost.status).toBe(421);
    const wrongToken = await fetch(url.replace(/\/[0-9a-f]{32}\/$/, `/${'f'.repeat(32)}/`));
    expect(wrongToken.status).toBe(404);
    const post = await fetch(url, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(wrongHost.csp).toContain('sandbox allow-scripts');
    for (const response of [wrongToken, post]) {
      expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    }
    const top = await fetch(`${url}w/`, { headers: { 'Sec-Fetch-Dest': 'document' }, redirect: 'manual' });
    expect(top.status).toBe(302);
    expect(top.headers.get('location')).toBe(url);
    const notice = await fetch(`${url}w/`);
    expect(notice.status).toBe(200);
    expect(await notice.text()).toContain('较新的浏览器');
    const iframe = await fetch(`${url}w/`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    expect(await iframe.text()).toContain('document.body.textContent');
  });

  it('preserves HEAD metadata and revokes after decision or state failure', async () => {
    const { preview, store } = fixture();
    const first = await preview.open(id);
    const second = await preview.open(id);
    const head = await fetch(`${second}w/STYLE.CSS`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(css.length));
    expect(head.headers.get('content-type')).toBe('text/css; charset=utf-8');
    preview.revoke(id);
    expect(preview.active).toEqual([]);
    await expect(fetch(first)).rejects.toThrow();
    const again = await preview.open(id);
    store.failure = '作品账本读取失败';
    preview.prune();
    expect(preview.active).toEqual([]);
    await expect(fetch(again)).rejects.toThrow();
  });

  it('never creates a token for corrupted reviewed bytes', async () => {
    const { preview, files } = fixture();
    files.set(`pluginData:/publish-review/items/${id}/out/index.html`, Buffer.from('tampered'));
    await expect(preview.open(id)).rejects.toThrow(/完整性/);
    expect(preview.active).toEqual([]);
  });
});
