import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webuiClient } from '../../packages/api-webui/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的文档级安全：HTML 响应带文档级 CSP（只许同源脚本，样式放开内联给 Mermaid），webui-server 自己直出的页面
// （登录页、前端切换页）不带内联脚本；SPA 兜底对 /assets/ 下缺失的文件回 404，不回 index.html；
// 改状态的请求按来源校验。真 HTTP，前端是一个临时目录。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-document-security-token-placeholder';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const INDEX = '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head></html>';

describe('WebUI 的文档级安全', () => {
  let base: string;
  let app: App;
  let port: number;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-document-security-'));
    const dist = join(base, 'client');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), INDEX);
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    port = await freePort();
    app = new App({ name: 'document security test', logLevel: 'error' });
    provideHostPaths(app, base);
    app.bind({ provide }).provide.use(webuiClient, { getClientDir: () => dist });
    await app.pluginAll([
      { definition: storageLocalPlugin, config: {} },
      {
        definition: webuiServerPlugin,
        config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
      },
    ]);
    await app.start();
    await waitListening(port);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const authed = { cookie: `aalis_webui_token=${TOKEN}` };

  it('前端的 HTML（首页与任意地址上的刷新）带文档级 CSP', async () => {
    for (const path of ['/', '/s/session-1', '/rooms?instance=x']) {
      const res = await fetch(url(path), { headers: authed });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX);
      expect(res.headers.get('content-security-policy'), path).toBe(CSP);
    }
  });

  it('/assets/ 下的文件照常提供；缺失的回 404，不回 index.html', async () => {
    const hit = await fetch(url('/assets/app.js'), { headers: authed });
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe('console.log(1)');
    const miss = await fetch(url('/assets/gone-1234.js'), { headers: authed });
    expect(miss.status).toBe(404);
    expect(await miss.text()).not.toContain('<!doctype html>');
  });

  it('登录页与前端切换页带同样的 CSP，脚本是同源的外部文件；登录页的脚本不登录也取得到', async () => {
    const login = await fetch(url('/'));
    expect(login.status).toBe(401);
    expect(login.headers.get('content-security-policy')).toBe(CSP);
    const loginHtml = await login.text();
    expect(loginHtml).not.toMatch(/<script>/);
    const loginScript = await fetch(url('/api/auth/login.js'));
    expect(loginScript.status).toBe(200);
    expect(loginScript.headers.get('content-type')).toContain('javascript');

    const clients = await fetch(url('/__clients'), { headers: authed });
    expect(clients.headers.get('content-security-policy')).toBe(CSP);
    expect(await clients.text()).not.toMatch(/<script>/);
    const clientsScript = await fetch(url('/__clients.js'), { headers: authed });
    expect(clientsScript.status).toBe(200);
    expect(clientsScript.headers.get('content-type')).toContain('javascript');
    expect(await clientsScript.text()).toContain('/api/services');
  });

  it('改状态的请求：Origin 不同源回 403；同源的与没有 Origin 的照常处理', async () => {
    const prefer = (origin?: string) =>
      fetch(url('/api/services/webui-client/prefer'), {
        method: 'DELETE',
        headers: { ...authed, ...(origin && { origin }) },
      });
    expect((await prefer('http://127.0.0.1:1')).status).toBe(403);
    expect((await prefer(`http://127.0.0.1:${port}`)).status).not.toBe(403);
    expect((await prefer()).status).not.toBe(403);
  });
});
