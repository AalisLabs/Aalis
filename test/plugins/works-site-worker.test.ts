import { describe, expect, it, vi } from 'vitest';
import { buildWorker } from '../../packages/plugin-works-site/src/site/worker.js';

const id = 'abcdefgabc';
const source = buildWorker({
  nonce: 'nonce123',
  mainOrigin: 'https://aalis.pages.dev',
  frameAncestors: ['https://aalis.pages.dev'],
  works: { [id]: [`/${id}/`, `/${id}/app.js`, `/${id}/style.css`, `/${id}/shape.svg`, `/${id}/x.png`] },
});
const load = async () =>
  (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default as {
    fetch(request: Request, env: { ASSETS: { fetch: (request: Request) => Promise<Response> } }): Promise<Response>;
  };

describe('works site worker', () => {
  it('HEAD 部署标记保留表示类型，作品响应保留资产已有的 Vary', async () => {
    const worker = await load();
    const env = {
      ASSETS: {
        fetch: async (_request: Request) =>
          new Response('asset', {
            status: 206,
            headers: { Vary: 'Accept-Encoding', 'Content-Range': 'bytes 0-4/10' },
          }),
      },
    };
    const marker = await worker.fetch(
      new Request('https://p-test.aalis.pages.dev/v/nonce123.txt', { method: 'HEAD' }),
      env,
    );
    expect(marker.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await marker.text()).toBe('');
    const response = await worker.fetch(new Request(`https://p-test.aalis.pages.dev/${id}/x.png`), env);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-4/10');
    expect(
      response.headers
        .get('vary')
        ?.split(',')
        .map(x => x.trim()),
    ).toEqual(['Accept-Encoding', 'Sec-Fetch-Dest']);
  });

  it('is a single import-free module and filters before fetching assets', async () => {
    expect(source).not.toMatch(/\bimport\s/);
    const worker = await load();
    const fetch = vi.fn(async (_request: Request) => new Response('asset', { status: 200 }));
    const run = (path: string, dest?: string, method = 'GET') =>
      worker.fetch(
        new Request(`https://p-test.aalis.pages.dev${path}`, {
          method,
          headers: dest ? { 'Sec-Fetch-Dest': dest } : {},
        }),
        { ASSETS: { fetch } },
      );
    expect((await run(`/${id}/`, 'iframe')).status).toBe(200);
    const top = await run(`/${id}/`, 'document');
    expect(top.status).toBe(302);
    expect(top.headers.get('location')).toBe(`https://aalis.pages.dev/w/${id}/`);
    const missing = await run(`/${id}/`);
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain('较新的浏览器');
    expect((await run(`/${id}/shape.svg`)).status).toBe(200);
    expect((await run(`/${id}/style.css`)).status).toBe(200);
    expect((await run(`/${id}/x.png`)).status).toBe(200);
    for (const path of [
      `/%61bcdefgabc/`,
      `//${id}/`,
      `/${id.toUpperCase()}/`,
      `/${id}`,
      `/${id}/index.html`,
      `/${id}/app.js;`,
      `/${id}/%00`,
      '/bbbbbbbbbb/',
      '/v/other.txt',
    ]) {
      const count = fetch.mock.calls.length;
      const response = await run(path, 'iframe');
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-security-policy'), path).toContain('sandbox allow-scripts');
      expect(fetch).toHaveBeenCalledTimes(count);
    }
    expect((await run(`/${id}/`, 'iframe', 'POST')).status).toBe(405);
    expect((await run('/v/nonce123.txt')).status).toBe(200);
    const tail = await worker.fetch(
      new Request(`https://p-test.aalis.pages.dev./${id}/`, { headers: { 'Sec-Fetch-Dest': 'iframe' } }),
      { ASSETS: { fetch } },
    );
    expect(tail.headers.get('content-security-policy')).toContain(`https://p-test.aalis.pages.dev./${id}/`);
    const failed = await worker.fetch(
      new Request(`https://p-test.aalis.pages.dev/${id}/app.js`, { headers: { 'Sec-Fetch-Dest': 'iframe' } }),
      { ASSETS: { fetch: async () => new Response(null, { status: 500 }) } },
    );
    expect(failed.status).toBe(404);
  });

  it('rebuilds the asset request from the validated URL path and preserves query', async () => {
    const worker = await load();
    const fetch = vi.fn(async (_request: Request) => new Response('asset', { status: 200 }));
    const request = new Request(`https://p-test.aalis.pages.dev/${id}/x/../app.js?q=1`, {
      headers: { 'Sec-Fetch-Dest': 'iframe' },
    });
    const response = await worker.fetch(request, { ASSETS: { fetch } });
    expect(response.status).toBe(200);
    expect(fetch.mock.calls[0][0].url).toBe(`https://p-test.aalis.pages.dev/${id}/app.js?q=1`);
    expect(response.headers.get('vary')).toBe('Sec-Fetch-Dest');
    const csp = response.headers.get('content-security-policy') ?? '';
    const scope = `https://p-test.aalis.pages.dev/${id}/`;
    expect(csp).not.toContain('scope.invalid');
    for (const directive of ['script-src', 'style-src', 'img-src', 'media-src', 'font-src']) {
      expect(csp.split('; ').find(part => part.startsWith(`${directive} `))).toContain(scope);
    }
  });

  it('returns actual uppercase JS and image bytes without Sec-Fetch-Dest, while SVG remains a notice', async () => {
    const uppercaseSource = buildWorker({
      nonce: 'nonce123',
      mainOrigin: 'https://aalis.pages.dev',
      frameAncestors: ['https://aalis.pages.dev'],
      works: { [id]: [`/${id}/`, `/${id}/APP.JS`, `/${id}/IMAGE.PNG`, `/${id}/ART.SVG`] },
    });
    const worker = (await import(`data:text/javascript,${encodeURIComponent(uppercaseSource)}`)).default as Awaited<
      ReturnType<typeof load>
    >;
    const assetBytes = new Uint8Array([0, 255, 19]);
    const fetch = vi.fn(async (_request: Request) => new Response(assetBytes));
    for (const path of [`/${id}/APP.JS`, `/${id}/IMAGE.PNG`]) {
      const response = await worker.fetch(new Request(`https://p-test.aalis.pages.dev${path}`), { ASSETS: { fetch } });
      expect(new Uint8Array(await response.arrayBuffer()), path).toEqual(assetBytes);
      expect(fetch.mock.lastCall?.[0].url).toBe(`https://p-test.aalis.pages.dev${path}`);
    }
    const before = fetch.mock.calls.length;
    const svg = await worker.fetch(new Request(`https://p-test.aalis.pages.dev/${id}/ART.SVG`), { ASSETS: { fetch } });
    expect(await svg.text()).toContain('较新的浏览器');
    expect(fetch).toHaveBeenCalledTimes(before);
  });
});
