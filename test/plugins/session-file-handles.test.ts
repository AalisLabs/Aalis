import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import type { MessageAttachment, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { client } from '../fixtures/session-client.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 会话条目里的文件句柄：她发到 WebUI 会话的文件（白纸成品等）在条目里给会话服务签发的句柄，不给存储地址；
// WebUI 按句柄下载（GET /api/session-file），一律当附件以 octet-stream 下发。
// 真 storage-local（data 根映射到家目录的 state/）、真会话服务、真 HTTP。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-session-file-token-placeholder';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const PAGE = '<!doctype html><title>zz-page</title>';

/** 告警按到达顺序留存，其余日志不出 */
const warns: string[] = [];
const quiet: Logger = {
  debug() {},
  info() {},
  warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
  error() {},
  child: () => quiet,
};

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  warns.length = 0;
});

/** 会话管理、消息归档、会话服务与 webui-server，存储是临时家目录上的 storage-local */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-file-'));
  homes.push(home);
  const port = await freePort();
  const app = new App({ name: 'T', logLevel: 'error', logger: quiet });
  apps.push(app);
  const paths = provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager, sessionProtocol });
  host.provide.use(authority, { isOwner: (p: string, u?: string) => p === 'webui' && u === 'console' } as never);
  await app.pluginAll([
    { definition: storageLocalPlugin, config: {} },
    { definition: memoryInMemoryPlugin },
    { definition: messageArchivePlugin, config: { debugLogs: false } },
    { definition: sessionManagerPlugin, config: {} },
    { definition: sessionServerPlugin, config: {} },
    {
      definition: webuiServer,
      config: { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
    },
  ]);
  await app.plugins.idle();
  await app.start();
  await waitListening(port);

  /** 存储根在家目录里的位置：paper 是白纸成品，data 是 state/，pluginData 是 state/plugins */
  const rootDirs: Record<string, string> = {
    paper: paths.stage.paper,
    data: paths.state,
    pluginData: join(paths.state, 'plugins'),
  };
  const fileOf = (uri: string) => {
    const [root, rest] = uri.split(':/');
    return join(rootDirs[root] as string, rest as string);
  };
  /** 按存储地址在磁盘上放一个文件 */
  const put = (uri: string, content: string) => {
    const file = fileOf(uri);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  /** 她往 WebUI 会话发一条只有附件的消息（白纸交付成品就是这样发的），等回执 */
  const send = async (sessionId: string, attachments: MessageAttachment[]) => {
    const out: OutgoingMessage = { sessionId, platform: 'webui', content: '', source: 'agent', attachments };
    await host.events.use.emit('outbound:message', out);
    expect(await out.delivery).toEqual({ ok: true });
  };

  const download = (sessionId: string, handle: string, cookie = true) =>
    fetch(
      `http://127.0.0.1:${port}/api/session-file?sessionId=${encodeURIComponent(sessionId)}&handle=${encodeURIComponent(handle)}`,
      { headers: cookie ? { cookie: COOKIE } : {} },
    );

  /** 订阅一个会话；items 是快照叠上之后的推送 */
  const watch = async (sessionId: string) => {
    const c = client(host.sessionProtocol.use);
    await c.init();
    const sub = await c.subscribe(sessionId);
    return { snapshot: sub.snapshot, items: () => c.timeline(sessionId, sub) };
  };

  return { app, sm: host.sessionManager.use, put, fileOf, send, download, watch };
}

/** 条目里唯一一个附件的句柄 */
function handleOf(item: SessionItem | undefined): string {
  if (item?.kind !== 'agent-message') throw new Error(`不是她发出的消息：${item?.kind}`);
  const src = item.attachments[0]?.src;
  if (src === undefined) throw new Error('附件没有句柄');
  return src;
}

describe('会话条目里的文件句柄', () => {
  it('她发到 WebUI 会话的文件：条目带句柄而不是存储地址；按句柄下载到原文件，以附件、octet-stream 下发；快照的历史给出同一个句柄；没给名字的取存储地址的最后一段', async () => {
    const { sm, put, send, download, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('paper:/n-a/tasks/t-1/out/a-1.html', PAGE);
    put('paper:/n-a/tasks/t-1/out/a-2.txt', 'zz-unnamed');
    const live = await watch(s.id);

    await send(s.id, [
      { kind: 'file', data: 'paper:/n-a/tasks/t-1/out/a-1.html', name: '主页.html' },
      { kind: 'file', data: 'paper:/n-a/tasks/t-1/out/a-2.txt' },
    ]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(2));
    const [item, unnamed] = live.items();
    expect(item).toMatchObject({
      kind: 'agent-message',
      text: '',
      attachments: [{ kind: 'file', name: '主页.html', src: expect.any(String) }],
    });
    const handle = handleOf(item);
    expect(handle).not.toContain('paper:/');

    const res = await download(s.id, handle);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="??.html"; filename*=UTF-8''${encodeURIComponent('主页.html')}`,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(PAGE);

    expect(unnamed).toMatchObject({ attachments: [{ kind: 'file', name: 'a-2.txt' }] });
    const other = await download(s.id, handleOf(unnamed));
    expect(other.headers.get('content-disposition')).toBe('attachment; filename="a-2.txt"');
    expect(await other.text()).toBe('zz-unnamed');

    const fresh = await watch(s.id);
    expect(fresh.snapshot.items, '实时推送与快照里的历史是同一条，句柄相同').toEqual(live.items());
    expect((await download(s.id, handle, false)).status, '没登录').toBe(401);
  });

  it('伪造、改动过、别的会话的句柄回 403，不给文件内容；原会话照常能取', async () => {
    const { sm, put, send, download, watch } = await setup();
    const a = await sm.createSession({ name: 'A' });
    const b = await sm.createSession({ name: 'B' });
    put('paper:/p/a.html', PAGE);
    put('paper:/p/other.html', 'zz-other-file');
    const live = await watch(a.id);
    await send(a.id, [{ kind: 'file', data: 'paper:/p/a.html', name: 'a.html' }]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(1));
    const handle = handleOf(live.items()[0]);

    const [payload, signature] = handle.split('.') as [string, string];
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const attempts: Record<string, string> = {
      乱写的: 'zz-not-a-handle',
      自己编的签名: `${encode(['paper:/p/other.html', 'other.html'])}.AAAA`,
      载荷换成别的文件: `${encode(['paper:/p/other.html', 'other.html'])}.${signature}`,
      载荷换成状态目录里的文件: `${encode(['data:/webui/access.txt', 'access.txt'])}.${signature}`,
      签名改了一位: `${payload}.${flipped}`,
    };
    for (const [what, forged] of Object.entries(attempts)) {
      const res = await download(a.id, forged);
      expect(res.status, what).toBe(403);
      const body = await res.text();
      expect(body, what).not.toMatch(/zz-other-file|zz-page/);
      expect(body, what).not.toContain(TOKEN);
    }
    const cross = await download(b.id, handle);
    expect(cross.status, '别的会话').toBe(403);
    expect(await cross.text()).not.toContain('zz-page');

    expect((await download(a.id, handle)).status, '原会话').toBe(200);
  });

  it('插件状态的根（data 即 state/、pluginData）里的文件、不认识的根、不是存储地址的，都不签发：附件只有名字', async () => {
    const { sm, put, send, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('pluginData:/file-reader/x/a.txt', 'zz-plugin-data');
    put('paper:/p/ok.html', PAGE);
    const live = await watch(s.id);

    await send(s.id, [
      { kind: 'file', data: 'data:/webui/access.txt', name: 'access.txt' },
      { kind: 'file', data: 'pluginData:/file-reader/x/a.txt', name: 'a.txt' },
      { kind: 'file', data: 'gone:/a.txt', name: 'gone.txt' },
      { kind: 'file', data: 'paper:/p/ok.html', name: 'ok.html' },
    ]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(4));
    const attachments = live.items().flatMap(item => (item.kind === 'agent-message' ? item.attachments : []));
    expect(attachments).toEqual([
      { kind: 'file', name: 'access.txt' },
      { kind: 'file', name: 'a.txt' },
      { kind: 'file', name: 'gone.txt' },
      { kind: 'file', name: 'ok.html', src: expect.any(String) },
    ]);
    const fresh = await watch(s.id);
    expect(fresh.snapshot.items, '历史里一样').toEqual(live.items());
  });

  it('不是存储地址的文件（网址、data URL）：存档只记名字，历史里是「[文件] 名称」的通知，没有它的内容', async () => {
    const { sm, send, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    await send(s.id, [
      { kind: 'file', data: 'data:application/pdf;base64,enotaW5saW5lLWJ5dGVz', name: '报告.pdf' },
      { kind: 'file', data: 'https://example.invalid/a/b.pdf' },
    ]);
    const { snapshot } = await watch(s.id);
    expect(snapshot.items.map(item => [item.kind, item.kind === 'notice' && item.text])).toEqual([
      ['notice', '[文件] 报告.pdf'],
      ['notice', '[文件] b.pdf'],
    ]);
    expect(JSON.stringify(snapshot.items)).not.toContain('enotaW5saW5lLWJ5dGVz');
  });

  it('存储地址与文件名里带「]」：条目里的名字与下载到的文件都和原来一样', async () => {
    const { sm, put, send, download, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('paper:/p/报告[终稿].html', PAGE);
    const live = await watch(s.id);
    await send(s.id, [{ kind: 'file', data: 'paper:/p/报告[终稿].html', name: '报告[终稿].html' }]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(1));
    expect(live.items()[0]).toMatchObject({ attachments: [{ kind: 'file', name: '报告[终稿].html' }] });
    const res = await download(s.id, handleOf(live.items()[0]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('报告[终稿].html')}`,
    );
    const fresh = await watch(s.id);
    expect(fresh.snapshot.items, '历史里一样').toEqual(live.items());
  });

  it('文件名带撇号、括号与星号：filename* 里按 RFC 8187 编码，另有 ASCII 的 filename= 退路', async () => {
    const { sm, put, send, download, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('paper:/p/draft.html', PAGE);
    const live = await watch(s.id);
    await send(s.id, [{ kind: 'file', data: 'paper:/p/draft.html', name: "Aalis's (草稿)*.html" }]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(1));
    const res = await download(s.id, handleOf(live.items()[0]));
    const header = res.headers.get('content-disposition') ?? '';
    expect(header).toBe(
      `attachment; filename="Aalis's (??)*.html"; filename*=UTF-8''Aalis%27s%20%28%E8%8D%89%E7%A8%BF%29%2A.html`,
    );
    // RFC 8187 的 ext-value 只许 attr-char 与百分号编码
    expect(header.split("filename*=UTF-8''")[1]).toMatch(/^[A-Za-z0-9!#$&+.^_`|~%-]+$/);
  });

  it('文件读不出（不是不存在：同一个位置换成了目录）：回 500 并记告警，不说成文件不在', async () => {
    const { sm, put, fileOf, send, download, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('paper:/p/a.html', PAGE);
    const live = await watch(s.id);
    await send(s.id, [{ kind: 'file', data: 'paper:/p/a.html', name: 'a.html' }]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(1));
    const handle = handleOf(live.items()[0]);

    rmSync(fileOf('paper:/p/a.html'));
    mkdirSync(fileOf('paper:/p/a.html'));
    const res = await download(s.id, handle);
    expect(res.status).toBe(500);
    expect(warns.filter(w => w.includes('读取会话文件 paper:/p/a.html 失败'))).toHaveLength(1);
  });

  it('文件删掉之后，原来的句柄回 404', async () => {
    const { sm, put, fileOf, send, download, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('paper:/p/a.html', PAGE);
    const live = await watch(s.id);
    await send(s.id, [{ kind: 'file', data: 'paper:/p/a.html', name: 'a.html' }]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(1));
    const handle = handleOf(live.items()[0]);
    expect((await download(s.id, handle)).status).toBe(200);

    rmSync(fileOf('paper:/p/a.html'));
    const res = await download(s.id, handle);
    expect(res.status).toBe(404);
  });

  it('会话服务重启之后旧句柄回 403；重新订阅拿到的新句柄能取', async () => {
    const { app, sm, put, send, download, watch } = await setup();
    const s = await sm.createSession({ name: 'S' });
    put('paper:/p/a.html', PAGE);
    const live = await watch(s.id);
    await send(s.id, [{ kind: 'file', data: 'paper:/p/a.html', name: 'a.html' }]);
    await vi.waitFor(() => expect(live.items()).toHaveLength(1));
    const before = handleOf(live.items()[0]);

    await app.plugins.bounce(sessionServerPlugin.name);
    await app.plugins.idle();
    expect((await download(s.id, before)).status).toBe(403);

    const fresh = await watch(s.id);
    const after = handleOf(fresh.snapshot.items[0]);
    expect(after).not.toBe(before);
    const res = await download(s.id, after);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
  });
});
