// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_PROTOCOL_VERSION,
  type FrameHostMessage,
  type FrameInit,
  type FrameTheme,
  THEME_TOKENS,
  type ThemeToken,
} from '../../packages/api-webui/src/index.js';

// ════════════════════════════════════════════════════════════
// 插件前端的助手（api-webui 的 frame/frame.ts，托管为 /frames/_base/frame.js）：向父窗口发 hello，只认来自父窗口、
// 带端口的第一个 init，收到 init 时同步写上主题令牌，请求按 id 配对、失败抛出带 code 的错误，推送交给监听者，
// pagehide 时经端口发 leaving；不改地址。宿主一侧由用例扮演：init 是派发到窗口上的消息，端口记下框架发出的消息。
// 另核样式基线 frame.css 的颜色只引用主题令牌
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const NONCE = 'zz-nonce-0001';
const URL_IN_FRAME = `http://127.0.0.1:3000/frames/zz-token/index.html#${NONCE}`;

/** 假端口：记下框架发出的消息；deliver 是宿主经端口发给框架 */
class FakePort {
  readonly sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: unknown): void {
    this.sent.push(structuredClone(message));
  }

  deliver(message: FrameHostMessage): void {
    this.onmessage?.({ data: structuredClone(message) });
  }
}

declare const jsdom: { reconfigure(options: { url: string }): void };

/** 每个用例重新加载助手：connect 在模块里只握手一次 */
const load = () => import('../../packages/api-webui/frame/frame.js');

const theme = (kind: FrameTheme['kind'], shade: string): FrameTheme => ({
  kind,
  tokens: Object.fromEntries(THEME_TOKENS.map(token => [token, `#${shade}`])) as Record<ThemeToken, string>,
});

const init = (extra: Partial<FrameInit> = {}): FrameInit => ({
  type: 'init',
  protocol: FRAME_PROTOCOL_VERSION,
  experimental: true,
  theme: theme('light', 'fbfbfa'),
  ...extra,
});

/** 发到框架窗口上的消息：缺省来自父窗口、不带端口 */
function post(data: unknown, from: { source?: MessageEventSource | null; port?: FakePort } = {}): void {
  const source = from.source === undefined ? window.parent : from.source;
  window.dispatchEvent(new MessageEvent('message', { data, source, ports: from.port ? [from.port as never] : [] }));
}

/** 这个 promise 此刻落定了没有 */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  return done;
}

async function connected(extra: Partial<FrameInit> = {}) {
  const { connect } = await load();
  const port = new FakePort();
  const client = connect();
  post(init(extra), { port });
  return { client: await client, port };
}

beforeEach(() => {
  jsdom.reconfigure({ url: URL_IN_FRAME });
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

describe('助手的握手', () => {
  it('向父窗口发 hello，带协议版本与地址片段里的随机数；connect 调两次是同一个连接，只发一次 hello', async () => {
    const posted = vi.spyOn(window.parent, 'postMessage');
    const { connect } = await load();
    const first = connect();
    expect(connect()).toBe(first);
    expect(posted.mock.calls).toEqual([[{ type: 'hello', protocol: FRAME_PROTOCOL_VERSION, nonce: NONCE }, '*']]);
  });

  it('只认来自父窗口、带端口的第一个 init：别的窗口发来的、不带端口的、不是 init 的都不认，之后的 init 不再理会', async () => {
    const { connect } = await load();
    const client = connect();
    const other = document.body.appendChild(document.createElement('iframe')).contentWindow as Window;
    post(init({ sessionId: 'zz-other' }), { source: other, port: new FakePort() });
    post(init({ sessionId: 'zz-null' }), { source: null, port: new FakePort() });
    post(init({ sessionId: 'zz-no-port' }));
    post({ type: 'theme', ...theme('dark', '000000') }, { port: new FakePort() });
    expect(await settled(client)).toBe(false);

    const port = new FakePort();
    post(init({ sessionId: 'zz-session' }), { port });
    const later = new FakePort();
    post(init({ sessionId: 'zz-later', theme: theme('dark', '000000') }), { port: later });
    const connection = await client;
    expect(connection.sessionId).toBe('zz-session');
    expect(document.documentElement.dataset.theme).toBe('light');
    void connection.data('cards');
    expect(port.sent).toEqual([{ type: 'data', id: 1, source: 'cards' }]);
    expect(later.sent).toEqual([]);
  });

  it('init 里没有带 tokens 的主题时报错，不挂着', async () => {
    for (const theme of [undefined, { kind: 'light' }, { kind: 'light', tokens: null }]) {
      vi.resetModules();
      const { connect } = await load();
      const client = connect();
      post({ ...init(), theme }, { port: new FakePort() });
      expect(await settled(client), JSON.stringify(theme)).toBe(true);
      await expect(client).rejects.toThrow('宿主的 init 不合格：theme 要是带 tokens 的对象');
    }
  });

  it('等不到 init 时报错', async () => {
    vi.useFakeTimers();
    const { connect } = await load();
    const client = connect();
    const failed = expect(client).rejects.toThrow('宿主没有回应握手');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
  });
});

describe('助手的主题', () => {
  it('收到 init 时同步写上主题令牌、data-theme 与 color-scheme，收到 theme 时更新', async () => {
    const { connect } = await load();
    const port = new FakePort();
    void connect();
    post(init(), { port });
    const root = document.documentElement;
    expect(THEME_TOKENS.map(token => root.style.getPropertyValue(token))).toEqual(THEME_TOKENS.map(() => '#fbfbfa'));
    expect([root.dataset.theme, root.style.colorScheme]).toEqual(['light', 'light']);

    port.deliver({ type: 'theme', ...theme('dark', '1d1d20') });
    expect(THEME_TOKENS.map(token => root.style.getPropertyValue(token))).toEqual(THEME_TOKENS.map(() => '#1d1d20'));
    expect([root.dataset.theme, root.style.colorScheme]).toEqual(['dark', 'dark']);
  });
});

describe('助手的请求与推送', () => {
  it('请求带 id、按 id 配对：结果先后错开也各归各；失败时抛出带 code 的错误', async () => {
    const { client, port } = await connected();
    const results = Promise.all([
      client.data('card', { id: 'c1' }),
      client.action('archive', { id: 'c1' }),
      client.open({ url: 'https://example.invalid/a' }),
      client.listSessions({ parentId: 'zz-parent', limit: 5 }),
      client.abortTurn({ sessionId: 'zz-session', turnId: 'zz-turn' }),
      client.open({ session: 'zz-session' }),
    ]);
    const denied = client.action('drop');
    expect(port.sent).toEqual([
      { type: 'data', id: 1, source: 'card', input: { id: 'c1' } },
      { type: 'action', id: 2, action: 'archive', input: { id: 'c1' } },
      { type: 'open', id: 3, target: { url: 'https://example.invalid/a' } },
      { type: 'sessions.list', id: 4, parentId: 'zz-parent', limit: 5 },
      { type: 'turn.abort', id: 5, sessionId: 'zz-session', turnId: 'zz-turn' },
      { type: 'open', id: 6, target: { session: 'zz-session' } },
      { type: 'action', id: 7, action: 'drop' },
    ]);
    port.deliver({ type: 'result', id: 7, ok: false, error: { code: 'denied', message: '没有申请' } });
    for (const [id, value] of [
      [6, null],
      [5, null],
      [4, { sessions: [] }],
      [3, null],
      [2, '已归档 c1'],
      [1, { id: 'c1' }],
    ] as const) {
      port.deliver({ type: 'result', id, ok: true, value });
    }
    expect(await results).toEqual([{ id: 'c1' }, '已归档 c1', undefined, { sessions: [] }, undefined, undefined]);
    await expect(denied).rejects.toMatchObject({ code: 'denied', message: '没有申请' });
  });

  it('invalidate 交给 onInvalidate 的监听者，sessions.changed 交给 onSessionsChanged 的；退订后不再收', async () => {
    const { client, port } = await connected();
    const invalidated: Array<string | undefined> = [];
    const changes: unknown[] = [];
    const offInvalidate = client.onInvalidate(source => invalidated.push(source));
    const offChanged = client.onSessionsChanged(change => changes.push(change));
    port.deliver({ type: 'invalidate', source: 'cards' });
    port.deliver({ type: 'invalidate' });
    port.deliver({ type: 'sessions.changed', upserts: [], removes: ['zz-gone'] });
    offInvalidate();
    offChanged();
    port.deliver({ type: 'invalidate', source: 'cards' });
    port.deliver({ type: 'sessions.changed', upserts: [], removes: ['zz-again'] });
    expect(invalidated).toEqual(['cards', undefined]);
    expect(changes).toEqual([{ upserts: [], removes: ['zz-gone'] }]);
  });

  it('pagehide 时经端口发 leaving', async () => {
    const { port } = await connected();
    window.dispatchEvent(new Event('pagehide'));
    expect(port.sent).toEqual([{ type: 'leaving' }]);
  });

  it('不改地址：握手、主题与请求前后，地址（含片段）与会话历史都不变', async () => {
    const before = [location.href, history.length];
    const { client, port } = await connected({ sessionId: 'zz-session' });
    port.deliver({ type: 'theme', ...theme('dark', '1d1d20') });
    void client.data('cards');
    port.deliver({ type: 'result', id: 1, ok: true, value: [] });
    expect([location.href, history.length]).toEqual(before);
  });
});

describe('样式基线', () => {
  it('颜色只引用主题令牌：没有颜色字面量，引用的颜色变量都在令牌表里', () => {
    const css = readFileSync(join(ROOT, 'packages/api-webui/frame/frame.css'), 'utf-8');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i);
    expect(css).not.toMatch(/:\s*[^;{}]*\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink)\b/i);
    const used = [...css.matchAll(/var\((--color-[\w-]+)\)/g)].map(match => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(name => !(THEME_TOKENS as readonly string[]).includes(name))).toEqual([]);
  });
});
