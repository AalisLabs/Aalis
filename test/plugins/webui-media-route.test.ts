import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// GET /api/media?uri=<存储地址>：聊天里的图片、视频、音频按存储地址取。只有 owner（cookie）能取；按文件头判定
// 类型，只放行图片、视频与浏览器能播的音频，HTML、SVG、JSON 等一律 415；响应带 nosniff 与 sandbox CSP。
// 真 storage-local，真 HTTP。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-media-route-token';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe('WebUI 媒体路由', () => {
  let base: string;
  let app: App;
  let port: number;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-media-route-'));
    mkdirSync(join(base, 'data', 'images'), { recursive: true });
    writeFileSync(join(base, 'data', 'images', 'cat.png'), PNG);
    writeFileSync(join(base, 'data', 'images', 'page.png'), '<!doctype html><script>alert(1)</script>');
    writeFileSync(join(base, 'data', 'ledger.json'), '{"secret":"zz-not-media"}');
    port = await freePort();
    app = new App({ name: 'media route test', logLevel: 'error' });
    await app.pluginAll([
      {
        definition: storageLocalPlugin,
        config: {
          roots: [
            {
              name: 'data',
              path: join(base, 'data'),
              label: 'data',
              kind: 'data',
              browsable: true,
              readable: true,
              writable: true,
              deletable: true,
            },
          ],
        },
      },
      {
        definition: webuiServerPlugin,
        config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
      },
    ]);
    await app.start();
    // app:started 之后才开始监听：等端口能连上
    for (let i = 0; ; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/media`);
        break;
      } catch (err) {
        if (i > 200) throw err;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  const get = (uri: string, cookie = true) =>
    fetch(`http://127.0.0.1:${port}/api/media?uri=${encodeURIComponent(uri)}`, {
      headers: cookie ? { cookie: `aalis_webui_token=${TOKEN}` } : {},
    });

  it('按文件头判定为图片的照原样提供，带 nosniff 与 sandbox CSP', async () => {
    const res = await get('data:/images/cat.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('安全：扩展名是 .png、内容是网页的不提供；JSON 账本也不提供', async () => {
    const html = await get('data:/images/page.png');
    expect(html.status).toBe(415);
    expect(await html.text()).not.toContain('<script>');
    const json = await get('data:/ledger.json');
    expect(json.status).toBe(415);
    expect(await json.text()).not.toContain('zz-not-media');
  });

  it('安全：没有登录拒绝；网址与不存在的文件不提供', async () => {
    expect((await get('data:/images/cat.png', false)).status).toBeGreaterThanOrEqual(401);
    expect((await get('https://example.invalid/cat.png')).status).toBe(400);
    expect((await get('data:/images/missing.png')).status).toBe(404);
    expect((await get('data:/../../etc/hosts')).status).not.toBe(200);
  });
});
