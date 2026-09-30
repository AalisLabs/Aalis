import { createServer, request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublishedItem } from '../../packages/api-publish/src/index.js';
import { buildBranch, buildGallery } from '../../packages/plugin-works-site/src/site/build.js';
import { type FakePages, startFakePages } from '../fixtures/fake-pages.js';

let fake: FakePages;
let nextKey = 0;
const text = new TextEncoder();

function asset(content: string, contentType = 'text/html; charset=utf-8'): string {
  const key = (++nextKey).toString(16).padStart(32, '0');
  fake.assets.set(key, { bytes: text.encode(content), contentType });
  return key;
}

function url(path: string, host = 'aalis'): string {
  return `http://${host === 'aalis' ? 'aalis' : `${host}.aalis`}.localhost:${fake.port}${path}`;
}

async function get(path: string, host = 'aalis', opts?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: fake.port,
        path,
        method: opts?.method ?? 'GET',
        headers: { host: new URL(url('', host)).host },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as HeadersInit })),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  fake = await startFakePages();
});
afterAll(async () => {
  await fake.close();
});

describe('fake Pages site', () => {
  it('routes hosts, normalizes paths, decodes percent escapes and applies wildcard header removal', async () => {
    const branch = fake.seedDeployment({
      branch: 'p-test',
      manifest: {
        '/x/index.html': asset('inside'),
        '/space name.css': asset('css', 'text/css'),
        '/404.html': asset('missing'),
      },
      headers: '/*\n  X-Test: yes\n  Access-Control-Allow-Origin: *\n  ! Access-Control-Allow-Origin\n',
    });
    const alias = fake.aliasLabel(branch.branch);
    expect(alias).toBeTruthy();
    expect(fake.hostSuffix).toBe(`.aalis.localhost:${fake.port}`);
    const first = await get('/x/', alias);
    expect(fake.requests.at(-1)?.headers.host).toBe(`${alias}.aalis.localhost:${fake.port}`);
    expect(await first.text()).toBe('inside');
    expect((await get('/x', alias)).headers.get('location')).toBe('/x/');
    expect((await get('/x/index.html', alias)).status).toBe(308);
    const css = await get('/space%20name.css', alias);
    expect(await css.text()).toBe('css');
    expect(css.headers.get('x-test')).toBe('yes');
    expect(css.headers.get('access-control-allow-origin')).toBeNull();
    const missing = await get('/absent', alias);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('missing');
    expect(await (await get('/x/', branch.shortId)).text()).toBe('inside');
    expect((await get('/x/', 'wrong')).status).toBe(404);
  });

  it('returns empty 404 without a deployed fallback and runs a bundled worker against its manifest', async () => {
    const branch = fake.seedDeployment({
      branch: 'p-worker',
      manifest: { '/ok.txt': asset('manifest bytes', 'text/plain') },
      worker:
        'export default { async fetch(request, env) { return env.ASSETS.fetch(new Request(new URL("/ok.txt", request.url))); } };',
    });
    const alias = fake.aliasLabel(branch.branch);
    expect(await (await get('/anything', alias)).text()).toBe('manifest bytes');
    fake.seedDeployment({ branch: 'main' });
    const empty = await get('/no-file', 'aalis');
    expect(empty.status).toBe(404);
    expect(await empty.text()).toBe('');
  });

  it('models retained removed content, changed-content lag and exhausted worker quota separately', async () => {
    const original = asset('old', 'text/plain');
    fake.seedDeployment({ branch: 'p-switch', manifest: { '/one.txt': original } });
    const alias = fake.aliasLabel('p-switch');
    expect(await (await get('/one.txt', alias)).text()).toBe('old');
    fake.edgeCache = true;
    fake.seedDeployment({ branch: 'p-switch', manifest: {} });
    expect(await (await get('/one.txt', alias)).text()).toBe('old');
    fake.edgeCache = false;
    expect((await get('/one.txt', alias)).status).toBe(404);

    fake.seedDeployment({ branch: 'p-switch', manifest: { '/one.txt': original } });
    expect(await (await get('/one.txt', alias)).text()).toBe('old');
    fake.contentLagMs = 60_000;
    fake.seedDeployment({ branch: 'p-switch', manifest: { '/one.txt': asset('new', 'text/plain') } });
    expect(await (await get('/one.txt', alias)).text()).toBe('old');
    expect(await (await get('/one.txt?fresh=1', alias)).text()).toBe('new');
    fake.contentLagMs = 0;

    fake.seedDeployment({
      branch: 'p-quota',
      manifest: { '/doc.html': asset('static') },
      headers: '/*\n  X-Static: applied\n',
      worker: 'export default { fetch() { return new Response("worker"); } };',
    });
    const quotaAlias = fake.aliasLabel('p-quota');
    expect(await (await get('/doc.html', quotaAlias)).text()).toBe('worker');
    fake.workerQuotaExhausted = true;
    const fallback = await get('/doc.html', quotaAlias);
    expect(await fallback.text()).toBe('static');
    expect(fallback.headers.get('x-static')).toBe('applied');
    fake.workerQuotaExhausted = false;
  });
});

describe('Chromium work iframe', () => {
  it('runs own-directory resources while blocking outbound APIs, opener, storage and top navigation', async () => {
    const targetRequests: string[] = [];
    let targetConnections = 0;
    const target = createServer((req, res) => {
      targetRequests.push(req.url ?? '/');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/frame' ? `<iframe src="${url('/abcdefgabc/', 'p-browser')}"></iframe>` : 'external');
    });
    target.on('connection', () => targetConnections++);
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetOrigin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    const id = 'abcdefgabc';
    const branchName = 'p-browser';
    const alias = `${branchName}.aalis.localhost:${fake.port}`;
    const mainOrigin = url('');
    const branchOrigin = `http://${alias}`;
    const results = `
      const failures = {};
      const target = ${JSON.stringify(targetOrigin)};
      try { document.cookie = 'stolen=yes'; failures.cookie = document.cookie; } catch { failures.cookie = 'blocked'; }
      try { localStorage.setItem('stolen', 'yes'); failures.storage = localStorage.getItem('stolen'); } catch { failures.storage = 'blocked'; }
      try { fetch(target + '/fetch').catch(() => {}); failures.fetch = 'attempted'; } catch { failures.fetch = 'blocked'; }
      try { fetch(${JSON.stringify(mainOrigin)} + '/fetch-main').catch(() => {}); } catch {}
      try { const xhr = new XMLHttpRequest(); xhr.open('GET', target + '/xhr'); xhr.send(); } catch {}
      try { new WebSocket('ws://127.0.0.1:${(target.address() as { port: number }).port}/ws'); } catch {}
      try { navigator.sendBeacon(target + '/beacon', 'x'); } catch {}
      try { new EventSource(target + '/events'); } catch {}
      try { const image = new Image(); image.src = target + '/image'; document.body.append(image); } catch {}
      try { window.open(target + '/popup'); } catch {}
      try { top.location.href = target + '/top'; } catch {}
      try { const form = document.createElement('form'); form.action = target + '/form'; form.method = 'POST'; document.body.append(form); form.submit(); } catch {}
      document.body.dataset.ready = 'yes';
      window.__workResults = failures;
    `;
    const html =
      '<!doctype html><link rel="stylesheet" href="style.css"><img src="pic.png"><script src="classic.js"></script><script type="module" src="module.mjs"></script><script src="attempts.js"></script>';
    const payload = new Map([
      ['index.html', text.encode(html)],
      ['style.css', text.encode('body{background-color:rgb(1,2,3)}')],
      [
        'pic.png',
        Uint8Array.from(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/D4kAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      ],
      ['classic.js', text.encode('document.body.dataset.classic="yes"')],
      ['module.mjs', text.encode('document.body.dataset.module="yes"')],
      ['attempts.js', text.encode(results)],
      ['pic.svg', text.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ]);
    const types: Record<string, string> = {
      'index.html': 'text/html; charset=utf-8',
      'style.css': 'text/css; charset=utf-8',
      'pic.png': 'image/png',
      'classic.js': 'text/javascript; charset=utf-8',
      'module.mjs': 'text/javascript; charset=utf-8',
      'attempts.js': 'text/javascript; charset=utf-8',
      'pic.svg': 'image/svg+xml; charset=utf-8',
    };
    const item: PublishedItem = {
      id,
      group: 'room',
      groupLabel: 'room',
      surfaces: ['works'],
      kind: 'html',
      title: 'browser',
      summary: '',
      publishedAt: Date.now(),
      files: [...payload].map(([path, bytes]) => ({ path, size: bytes.byteLength, contentType: types[path] })),
      hasThumbnail: false,
    };
    const common = {
      items: [item],
      tombstones: [],
      nonce: 'browser123',
      now: Date.now(),
      readFile: async (_id: string, path: string) => payload.get(path) ?? new Uint8Array(),
      readThumbnail: async () => new Uint8Array(),
    };
    const branch = await buildBranch({ ...common, group: 'room', mainOrigin, frameAncestors: [mainOrigin] });
    const gallery = await buildGallery({
      ...common,
      siteTitle: 'Works',
      siteIntro: '',
      aliases: { room: branchOrigin },
    });
    function deploy(
      files: readonly { path: string; bytes: Uint8Array; contentType: string }[],
      branchName: string,
      headers?: string,
      worker?: string,
    ): void {
      const manifest: Record<string, string> = {};
      for (const file of files) {
        const key = (++nextKey).toString(16).padStart(32, '0');
        fake.assets.set(key, { bytes: file.bytes, contentType: file.contentType });
        manifest[file.path] = key;
      }
      fake.seedDeployment({ branch: branchName, manifest, headers, worker });
    }
    deploy(branch?.files ?? [], branchName, branch?.headers, branch?.worker);
    deploy(gallery.files, 'main', gallery.headers);

    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--host-resolver-rules=MAP *.aalis.localhost 127.0.0.1, MAP aalis.localhost 127.0.0.1, EXCLUDE 127.0.0.1',
      ],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${mainOrigin}/w/${id}/`, { waitUntil: 'load' });
      const frame = await page.waitForFrame(
        (frame: { url(): string }) => frame.url().startsWith(`${branchOrigin}/${id}/`),
        {
          timeout: 10_000,
        },
      );
      await frame.waitForSelector('body[data-ready="yes"]', { timeout: 10_000 });
      await new Promise(resolve => setTimeout(resolve, 300));
      const observed = await frame.evaluate(() => ({
        classic: document.body.dataset.classic,
        module: document.body.dataset.module,
        background: getComputedStyle(document.body).backgroundColor,
        image: (document.querySelector('img') as HTMLImageElement).naturalWidth,
        results: (window as typeof window & { __workResults?: Record<string, string> }).__workResults,
      }));
      expect(observed.classic).toBe('yes');
      expect(observed.background).toBe('rgb(1, 2, 3)');
      expect(observed.image).toBe(1);
      expect(observed.results?.cookie).not.toBe('stolen=yes');
      expect(observed.results?.storage).toBe('blocked');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(targetRequests).toEqual([]);
      expect(fake.requests.filter(r => r.path === '/fetch-main')).toHaveLength(0);
      expect(page.url()).toBe(`${mainOrigin}/w/${id}/`);
      expect(observed.module).toBe('yes');
      const documentRequest = fake.requests.find(r => r.path === `/${id}/` && r.headers.host === alias);
      expect(documentRequest?.headers['sec-fetch-dest']).toBe('iframe');
      expect(fake.requests.some(r => r.path === `/${id}/module.mjs` && r.headers['sec-fetch-dest'] === 'script')).toBe(
        true,
      );

      // Observed in Chrome: CSP/X-DNS-Prefetch-Control do not stop a preconnect TCP handshake.
      // An IP literal has no DNS lookup, so this only measures preconnect; there is no HTTP request.
      const beforeHints = targetConnections;
      await frame.evaluate((targetUrl: string) => {
        for (const rel of ['dns-prefetch', 'preconnect']) {
          const link = document.createElement('link');
          link.rel = rel;
          link.href = targetUrl;
          document.head.append(link);
        }
      }, targetOrigin);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(targetConnections).toBeGreaterThan(beforeHints);
      expect(targetRequests).toEqual([]);

      const other = fake.seedDeployment({ branch: 'p-other', manifest: { [`/${id}/index.html`]: asset('other') } });
      const forbiddenNavigations = [
        `${targetOrigin}/navigate`,
        url(`/${id}/`, fake.aliasLabel(other.branch)),
        'data:text/html,escaped',
      ];
      for (const destination of forbiddenNavigations) {
        await page.goto(`${mainOrigin}/w/${id}/`, { waitUntil: 'load' });
        const current = await page.waitForFrame((f: { url(): string }) => f.url().startsWith(branchOrigin), {
          timeout: 10_000,
        });
        await current.evaluate((href: string) => {
          location.href = href;
        }, destination);
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(
          page.frames().some((f: { url(): string }) => f.url().startsWith(destination)),
          destination,
        ).toBe(false);
        expect(page.url()).toBe(`${mainOrigin}/w/${id}/`);
      }
      expect(targetRequests).toEqual([]);

      const top = await browser.newPage();
      await top.goto(`${branchOrigin}/${id}/`, { waitUntil: 'load' });
      expect(top.url()).toBe(`${mainOrigin}/w/${id}/`);
      await top.goto(`${branchOrigin}/${id}/pic.svg`, { waitUntil: 'load' });
      expect(top.url()).toBe(`${mainOrigin}/w/${id}/`);

      const foreign = await browser.newPage();
      await foreign.goto(`${targetOrigin}/frame`, { waitUntil: 'load' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(foreign.frames().some((f: { url(): string }) => f.url().startsWith(branchOrigin))).toBe(false);
    } finally {
      await browser.close();
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  }, 30_000);
});
