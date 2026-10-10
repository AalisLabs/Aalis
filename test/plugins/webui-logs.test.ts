import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogFilter, WebuiAdminClientMessage, WebuiAdminEvent } from '../../packages/api-webui/src/index.js';
import {
  App,
  DefaultLogger,
  definePlugin,
  type LogEntry,
  LogHub,
  type LogLevel,
} from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { formatLogLine } from '../../packages/schema-log/src/index.js';
import { provideHostLogs } from '../fixtures/host-logs.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 日志的筛选：级别（这一级及以上）、插件实例与文字。历史（GET /api/logs/tail、/api/logs/range）与 /admin 上的实时推送
// 按同一份筛选在服务端筛。日志作用域是根作用域、实例 id、插件分出的子作用域依次用「:」接起来：按插件筛时认实例与
// 它的子作用域，后缀实例（name:suffix）与主实例的子作用域同形，按登记着的最长的实例 id 认；卸掉的插件照样能按名字筛
// ════════════════════════════════════════════════════════════

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const TOKEN = 'webui-logs-test-token-000000000000';
const COOKIE = `aalis_webui_token=${TOKEN}`;

const apps: App[] = [];
const sockets: WebSocket[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const probe = definePlugin({ name: 'zz-log-a', reusable: true, apply() {} });
const other = definePlugin({ name: 'zz-log-b', apply() {} });

const line = (seq: number, level: LogLevel, scope: string, message: string): LogEntry => ({
  seq,
  timestamp: `2026-10-04T10:00:0${seq}.000+08:00`,
  level,
  scope,
  message,
});

/** 写进 logs/latest.log 的历史：两个实例与它们的子作用域、另一个插件、宿主、卸掉的插件与根作用域 */
const HISTORY = [
  line(1, 'info', 'aalis:zz-log-a', 'A 启动'),
  line(2, 'debug', 'aalis:zz-log-a:worker', 'A 的子作用域'),
  line(3, 'warn', 'aalis:zz-log-a:2', '第二个实例告警'),
  line(4, 'error', 'aalis:zz-log-a:2:worker', '第二个实例的子作用域出错'),
  line(5, 'error', 'aalis:zz-log-b', 'B 出错：Timeout'),
  line(6, 'info', 'aalis:runtime', '宿主的日志'),
  line(7, 'info', 'aalis:zz-log-gone', '卸掉的插件'),
  line(8, 'info', 'aalis', '根作用域'),
];

/**
 * 起 webui-server：host-logs 的历史读临时家目录的 logs/latest.log，实时接进程级的默认中枢；装着 zz-log-a、它的实例 2 与
 * zz-log-b。应用自己的日志进 hub（只收告警及以上），不进推给页面的默认中枢
 */
async function start(hub = new LogHub()) {
  const home = mkdtempSync(join(tmpdir(), 'aalis-webui-logs-'));
  homes.push(home);
  mkdirSync(join(home, 'logs'));
  const file = join(home, 'logs', 'latest.log');
  writeFileSync(file, HISTORY.map(formatLogLine).join(''));
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  provideHostPaths(app, home);
  provideHostLogs(app, { file });
  const port = await freePort();
  await app.plugin(storageLocal, {});
  await app.plugin(probe);
  await app.plugin(probe, {}, 'zz-log-a:2');
  await app.plugin(other);
  await app.plugin(webuiServerPlugin, {
    host: '127.0.0.1',
    port,
    autoOpen: false,
    tokenMode: 'fixed',
    fixedToken: TOKEN,
  });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  return port;
}

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: COOKIE } });
  return { status: res.status, body: (await res.json()) as unknown };
}

/** 回来的日志的序号 */
const seqs = async (port: number, path: string) => {
  const { status, body } = await get(port, path);
  expect(status, path).toBe(200);
  return (body as LogEntry[]).map(entry => entry.seq);
};

describe('日志的历史', () => {
  it('按级别、插件、文字筛，三项可以一起用；limit 取最后几条符合的，range 往前翻同样筛', async () => {
    const port = await start();
    expect(await seqs(port, '/api/logs/tail')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await seqs(port, '/api/logs/tail?level=warn')).toEqual([3, 4, 5]);
    expect(await seqs(port, '/api/logs/tail?level=info')).toEqual([1, 3, 4, 5, 6, 7, 8]);
    // 实例认它的子作用域；实例 2 登记着，它的日志不算主实例的
    expect(await seqs(port, '/api/logs/tail?plugin=zz-log-a')).toEqual([1, 2]);
    expect(await seqs(port, `/api/logs/tail?plugin=${encodeURIComponent('zz-log-a:2')}`)).toEqual([3, 4]);
    // 卸掉了的插件不在登记表里，照样按名字认
    expect(await seqs(port, '/api/logs/tail?plugin=zz-log-gone')).toEqual([7]);
    // 根作用域后面没有实例
    expect(await seqs(port, '/api/logs/tail?plugin=aalis')).toEqual([]);
    expect(await seqs(port, '/api/logs/tail?text=timeout')).toEqual([5]);
    expect(await seqs(port, `/api/logs/tail?text=${encodeURIComponent('实例')}`)).toEqual([3, 4]);
    expect(await seqs(port, `/api/logs/tail?level=error&plugin=${encodeURIComponent('zz-log-a:2')}`)).toEqual([4]);
    // 空的筛选项当没给
    expect(await seqs(port, '/api/logs/tail?level=&plugin=&text=')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    expect(await seqs(port, '/api/logs/tail?plugin=zz-log-a&limit=1')).toEqual([2]);
    expect(await seqs(port, '/api/logs/range?plugin=zz-log-a&before=2')).toEqual([1]);
    expect(await seqs(port, '/api/logs/range?level=error&before=5&limit=1')).toEqual([4]);
  });

  it('筛选写法不对回 400：级别不是四种之一，或同一项给了几次', async () => {
    const port = await start();
    for (const path of [
      '/api/logs/tail?level=fatal',
      '/api/logs/tail?plugin=a&plugin=b',
      '/api/logs/range?before=5&text=a&text=b',
    ]) {
      const { status, body } = await get(port, path);
      expect(status, path).toBe(400);
      expect(body, path).toEqual({ error: expect.any(String) });
    }
  });
});

/** 一条 /admin 连接：收到的日志按到达顺序留存 */
async function openAdmin(port: number) {
  const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/admin`, {
    headers: { cookie: COOKIE },
  });
  sockets.push(ws);
  const logs: string[] = [];
  ws.onmessage = event => {
    const e = JSON.parse(String(event.data)) as WebuiAdminEvent;
    if (e.type === 'log') logs.push(e.entry.message);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连不上 /admin'));
  });
  const send = (message: WebuiAdminClientMessage | Record<string, unknown>) => ws.send(JSON.stringify(message));
  return { send, logs };
}

describe('实时日志', () => {
  it('订阅时带上筛选只推符合的；再订阅换掉筛选，不带筛选推全部；筛选写法不对的订阅告警后忽略，之前的订阅照旧', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'warn' && entry.message.startsWith('WebUI /admin')) warns.push(entry.message);
    });
    const port = await start(hub);
    // 推给页面的日志取 host-logs，它接进程级的默认中枢；探针往那里写，作用域与插件的一样
    const a = new DefaultLogger('aalis:zz-log-a', 'debug');
    const a2 = new DefaultLogger('aalis:zz-log-a:2', 'debug');
    const b = new DefaultLogger('aalis:zz-log-b', 'debug');
    const conn = await openAdmin(port);
    /** 等这条连接上之前的消息都生效：垫一条认不出的消息，它的告警出来时前面的都处理过了 */
    const settled = async () => {
      const before = warns.length;
      conn.send({ type: 'nope' });
      await vi.waitFor(() => expect(warns.length).toBe(before + 1));
    };
    const subscribe = async (filter?: LogFilter | Record<string, unknown>) => {
      conn.send(filter === undefined ? { type: 'log.subscribe' } : { type: 'log.subscribe', filter });
      await settled();
    };

    await subscribe({ plugin: 'zz-log-a', level: 'info' });
    a.debug('A 调试');
    a.info('A 信息');
    a2.error('A2 出错');
    b.error('B 出错');
    a.child('worker').warn('A 子作用域告警');
    await vi.waitFor(() => expect(conn.logs).toEqual(['A 信息', 'A 子作用域告警']));

    await subscribe({ text: 'TIMEOUT' });
    b.info('B 等待 timeout');
    a.info('A 无关');
    await vi.waitFor(() => expect(conn.logs.slice(2)).toEqual(['B 等待 timeout']));

    // 写法不对：只告警，之前按文字筛的订阅照旧
    const before = warns.length;
    conn.send({ type: 'log.subscribe', filter: { level: 'fatal' } });
    await vi.waitFor(() => expect(warns.length).toBe(before + 1));
    b.info('又一次 timeout');
    a.info('仍然无关');
    await vi.waitFor(() => expect(conn.logs.slice(3)).toEqual(['又一次 timeout']));

    await subscribe();
    a.debug('全部都推');
    await vi.waitFor(() => expect(conn.logs.slice(4)).toEqual(['全部都推']));
  });
});
