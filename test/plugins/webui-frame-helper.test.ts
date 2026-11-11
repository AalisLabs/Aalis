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
import { type CatalogEntry, fingerprint } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 插件前端的助手（api-webui 的 frame/frame.ts，托管为 /frames/_base/frame.js）：向父窗口发 hello，只认来自父窗口、
// 带端口的第一个 init，收到 init 时同步写上主题令牌、登记这个插件的字典并设 <html lang>，t() 按 init 给的语言链、语言包的
// 补充（形状不对的条目丢掉）与时区渲染，连接上带时区与选中的语言，请求按 id 配对、失败抛出带 code 的错误，推送交给监听者，
// pagehide 时经端口发 leaving；不改地址。
// 宿主一侧由用例扮演：init 是派发到窗口上的消息，端口记下框架发出的消息。
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
  languages: [],
  timeZone: 'UTC',
  texts: null,
  packs: {},
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
  document.documentElement.removeAttribute('lang');
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

  it('init 里没有带 tokens 的主题时报错，不会一直未决', async () => {
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

/** 插件的字典：原文 zh-CN；目录随测试进程存在，每个用例用自己的 ns */
const dictionary = (ns: string, locales: CatalogEntry['locales'] = {}): CatalogEntry => ({
  v: 1,
  ns,
  language: 'zh-CN',
  source: { hi: '你好，{name}', at: '{t, time, short}', only: '只有原文' },
  locales,
});
const ENGLISH = { hi: 'Hello, {name}', at: '{t, time, short}' };

describe('助手的文字', () => {
  it('英文界面：t 按这个插件的字典渲染成英文，没有译文的句子用原文；<html lang> 与主题令牌同一拍写成 en', async () => {
    const { connect } = await load();
    const port = new FakePort();
    const client = connect();
    post(init({ languages: ['en'], texts: dictionary('zz-frame-en', { en: ENGLISH }) }), { port });
    expect(document.documentElement.lang).toBe('en');
    const frame = await client;
    expect(frame.t('hi', { name: 'Ann' })).toBe('Hello, Ann');
    expect(frame.t('only')).toBe('只有原文');
  });

  it('字典没有读者能用的译文时用原文，<html lang> 写原文的语言；语言链为空（i18n 不在）时同样，字典带了译文也用原文', async () => {
    const cases = [
      [['en'], {}],
      [[], {}],
      [[], { en: ENGLISH }],
    ] as const;
    for (const [index, [languages, locales]] of cases.entries()) {
      vi.resetModules();
      const { client } = await connected({
        languages: [...languages],
        texts: dictionary(`zz-frame-source-${index}`, locales),
      });
      expect(client.t('hi', { name: 'Ann' }), String(index)).toBe('你好，Ann');
      expect(document.documentElement.lang, String(index)).toBe('zh-CN');
    }
  });

  it('字典与语言包里的语言标签按规范写法：<html lang> 与连接上的语言不照抄宿主给的写法', async () => {
    const { client } = await connected({
      languages: ['en'],
      texts: { ...dictionary('zz-frame-tag'), language: 'zh-cn', locales: { EN: ENGLISH } },
    });
    expect([document.documentElement.lang, client.language, client.t('hi', { name: 'Ann' })]).toEqual([
      'en',
      'en',
      'Hello, Ann',
    ]);
  });

  it('语言包的补充：原文指纹相符的才用，过时的不用', async () => {
    const pack = (from: string) => ({ hi: [{ language: 'ja', text: 'こんにちは、{name}', from }] });
    const { client } = await connected({
      languages: ['ja'],
      texts: dictionary('zz-frame-pack', { en: ENGLISH }),
      packs: pack(fingerprint('你好，{name}')),
    });
    expect(client.t('hi', { name: 'Ann' })).toBe('こんにちは、Ann');
    expect(document.documentElement.lang).toBe('ja');

    vi.resetModules();
    const stale = await connected({
      languages: ['ja'],
      texts: dictionary('zz-frame-stale', { en: ENGLISH }),
      packs: pack('deadbeef'),
    });
    expect(stale.client.t('hi', { name: 'Ann' })).toBe('Hello, Ann');
    expect(document.documentElement.lang).toBe('en');
  });

  it('时间按 init 给的服务进程时区', async () => {
    const { client } = await connected({
      languages: ['en'],
      timeZone: 'Asia/Tokyo',
      texts: dictionary('zz-frame-zone', { en: ENGLISH }),
    });
    expect(client.t('at', { t: 0 })).toBe(
      new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: 'Asia/Tokyo' }).format(0),
    );
  });

  it('语言包的补充形状不对（宿主不按协议）：connect() 照样落定，形状不对的条目丢掉、合格的照用', async () => {
    const good = { language: 'ja', text: 'こんにちは、{name}', from: fingerprint('你好，{name}') };
    const cases = [
      [{ hi: 5 }, '你好，Ann', 'zh-CN'],
      [{ hi: [null] }, '你好，Ann', 'zh-CN'],
      [{ hi: [null, 'x', { ...good, text: 5 }, good] }, 'こんにちは、Ann', 'ja'],
    ] as const;
    for (const [index, [packs, hi, lang]] of cases.entries()) {
      vi.resetModules();
      const { connect } = await load();
      const client = connect();
      const texts = dictionary(`zz-frame-bad-pack-${index}`);
      post(init({ languages: ['ja'], texts, packs: packs as never }), { port: new FakePort() });
      expect(await settled(client), JSON.stringify(packs)).toBe(true);
      expect((await client).t('hi', { name: 'Ann' }), JSON.stringify(packs)).toBe(hi);
      expect(document.documentElement.lang, JSON.stringify(packs)).toBe(lang);
    }
  });

  it('宿主给的时区认不出（不按协议）：连接上的时区为 undefined，t 照样渲染、不抛错', async () => {
    const { client } = await connected({
      languages: ['en'],
      timeZone: 'Mars/Base',
      texts: dictionary('zz-frame-bad-zone', { en: ENGLISH }),
    });
    expect(client.timeZone).toBeUndefined();
    expect(client.t('hi', { name: 'Ann' })).toBe('Hello, Ann');
  });

  it('连接上有 init 给的服务进程时区与助手设进 <html lang> 的语言；插件没有字典时语言为 undefined', async () => {
    const texts = dictionary('zz-frame-client', { en: ENGLISH });
    const { client } = await connected({ languages: ['en'], timeZone: 'Asia/Tokyo', texts });
    expect([client.timeZone, client.language]).toEqual(['Asia/Tokyo', 'en']);

    vi.resetModules();
    const bare = await connected({ languages: ['en'], timeZone: 'Asia/Tokyo' });
    expect([bare.client.timeZone, bare.client.language]).toEqual(['Asia/Tokyo', undefined]);
  });

  it('插件没有字典（含次版本更早的宿主不给这几项）：t 回键名，<html lang> 不动', async () => {
    document.documentElement.lang = 'zz';
    const { client } = await connected();
    expect(client.t('hi', { name: 'Ann' })).toBe('hi');
    expect(document.documentElement.lang).toBe('zz');

    vi.resetModules();
    const { languages: _l, timeZone: _z, texts: _t, packs: _p, ...older } = init();
    const { connect } = await load();
    const pending = connect();
    post(older, { port: new FakePort() });
    expect((await pending).t('only')).toBe('only');
    expect(document.documentElement.lang).toBe('zz');
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
