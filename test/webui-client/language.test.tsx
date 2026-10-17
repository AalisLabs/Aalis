// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tr } from '../../packages/plugin-webui-client/src/language.js';
import { fingerprint } from '../../packages/schema-i18n/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { deferred } from '../helpers/deferred.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  type FakeRest,
  type Harness,
  installDialog,
  language,
  pluginRow,
  renderApp,
  restCalls,
  server,
} from './harness.js';

// ════════════════════════════════════════════════════════════
// 界面的语言：外壳的文字与随前端打包的库字典（子系统组名）按全局默认层的语言链渲染，语言包补自带字典没有的语言，
// i18n 不在（链为空）时按原文；<html lang> 是实际用的语言。首帧按服务端写进页面的语言块画，没有这一块时先按原文画再取。
// 全局语言与语言包在别处改了：收到 session/config/changed 后重取语言与补充，链或补上的译文变了就换语言——外壳换成新的
// 语言、缓存的数据重取、会话连接重连；都没变时什么都不动。取不到时按退避再取，补充没取到不挡换语言
// ════════════════════════════════════════════════════════════

const NS = '@aalis/plugin-webui-client';

let app: Harness | undefined;
let restoreDialog: () => void;

beforeAll(() => {
  restoreDialog = installDialog();
});
afterAll(() => restoreDialog());

beforeEach(() => {
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  stubViewport(1440);
});

afterEach(() => {
  app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 插件区：左栏的「市场」是外壳的字，组名「记忆」取 api-webui 的字典 */
function plugins(rest: FakeRest): FakeRest {
  return {
    '/api/plugins': { plugins: [pluginRow('zz-mongo', { displayName: '文档库', subsystem: 'memory' })] },
    ...rest,
  };
}

const heading = (name: string) => screen.findByRole('heading', { level: 3, name });
const gets = (path: string) => restCalls().filter(call => call.method === 'GET' && call.path.split('?')[0] === path);
const sessionSockets = () => FakeWebSocket.sockets.filter(socket => new URL(socket.url).pathname === '/session');

describe('界面的语言', () => {
  it('按全局默认层的语言链：英文链时外壳与库字典都是英文，<html lang> 是 en', async () => {
    app = await renderApp('/plugins', {}, plugins(language(['en'])));
    expect(await screen.findByRole('link', { name: 'Market' })).toBeTruthy();
    expect(await heading('Memory')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('语言包补自带字典没有的语言（按全局默认层的链取前端带着的各个字典的补充），没补的按链落到 en', async () => {
    const packs = {
      [NS]: {
        market: [{ language: 'ja', text: 'マーケット', from: fingerprint('市场') }],
        pageLanguage: [{ language: 'ja', text: 'ja', from: fingerprint('zh-CN') }],
      },
    };
    app = await renderApp('/plugins', {}, plugins(language(['ja'], { packs })));
    expect(await screen.findByRole('link', { name: 'マーケット' })).toBeTruthy();
    expect(await heading('Memory')).toBeTruthy();
    expect(document.documentElement.lang).toBe('ja');
    const ns = new URL(gets('/api/i18n/messages')[0].path, location.origin).searchParams.get('ns')?.split(',');
    expect(ns).toEqual(expect.arrayContaining([NS, '@aalis/api-webui', '@aalis/api-approval', '@aalis/schema-i18n']));
  });

  it('i18n 不在（链为空）：按原文，不取语言包的补充', async () => {
    app = await renderApp('/plugins', {}, plugins(language([])));
    expect(await screen.findByRole('link', { name: '市场' })).toBeTruthy();
    expect(await heading('记忆')).toBeTruthy();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(gets('/api/i18n/messages')).toEqual([]);
  });

  it('用例之间不串：close() 把界面的语言复原成原文，<html lang> 清掉', async () => {
    app = await renderApp('/plugins', {}, plugins(language(['en'])));
    expect(await screen.findByRole('link', { name: 'Market' })).toBeTruthy();
    app.close();
    app = undefined;
    expect([tr('retry'), document.documentElement.lang]).toEqual(['重试', '']);
  });

  it('收到 session/config/changed 后重取：链从 zh-CN 变成 en 时外壳换成英文、缓存的数据重取、会话连接重连；链没变时不动', async () => {
    let chain = ['zh-CN'];
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    app = await renderApp(
      '/plugins',
      {},
      plugins({ '/api/i18n/languages': () => ({ languages: [], chain, timeZone }) }),
    );
    expect(await screen.findByRole('link', { name: '市场' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('zh-CN');
    const fetched = gets('/api/plugins').length;

    chain = ['en'];
    await act(async () => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(sessionSockets()).toHaveLength(2));
    await app.reconnect();
    expect(await screen.findByRole('link', { name: 'Market' })).toBeTruthy();
    expect(await heading('Memory')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(gets('/api/plugins').length).toBeGreaterThan(fetched);

    const settled = { fetched: gets('/api/plugins').length, checks: gets('/api/i18n/languages').length };
    await act(async () => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(gets('/api/i18n/languages').length).toBe(settled.checks + 1));
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(sessionSockets()).toHaveLength(2);
    expect(gets('/api/plugins')).toHaveLength(settled.fetched);
    expect(screen.getByRole('link', { name: 'Market' })).toBeTruthy();
  });
});

describe('首帧、语言包的补充与取不到时', () => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const english = { languages: [], chain: ['en'], timeZone };
  /** 回 500 的回应 */
  const failing = () => Response.json({ error: '出错了' }, { status: 500 });
  /** 日语包给「市场」的译文 */
  const japanese = {
    entries: { [NS]: { market: [{ language: 'ja', text: 'マーケット', from: fingerprint('市场') }] } },
  };

  it('首帧按服务端写进页面的语言块画：块里的链是 en 时首帧就是英文，不等 /api/i18n/languages 与补充', async () => {
    const hanging = () => new Promise(() => {});
    app = await renderApp('/plugins', {}, plugins({ '/api/i18n/languages': hanging, '/api/i18n/messages': hanging }), {
      page: { chain: ['en'], timeZone },
    });
    expect(screen.getByRole('link', { name: 'Market' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('页面里没有语言块（直接打开 /index.html、开发模式）：取到之前按原文画，取到后换上', async () => {
    const languages = deferred<object>();
    app = await renderApp('/plugins', {}, plugins({ '/api/i18n/languages': () => languages.promise }), {
      page: false,
    });
    expect(screen.getByRole('link', { name: '市场' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('zh-CN');
    languages.resolve(english);
    expect(await screen.findByRole('link', { name: 'Market' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('语言包的补充取失败不挡换语言：链照常换上（补充先空着），之后按退避再取，取到就补上', async () => {
    let chain = ['zh-CN'];
    let fails = false;
    app = await renderApp(
      '/plugins',
      {},
      plugins({
        '/api/i18n/languages': () => ({ languages: [], chain, timeZone }),
        '/api/i18n/messages': () => (fails ? failing() : japanese),
      }),
    );
    expect(screen.getByRole('link', { name: '市场' })).toBeTruthy();
    chain = ['ja'];
    fails = true;
    await act(async () => server().notify('session/config/changed', {}));
    // 日语没有字典也没取到补充：按链落到 en
    expect(await screen.findByRole('link', { name: 'Market' })).toBeTruthy();
    fails = false;
    expect(await screen.findByRole('link', { name: 'マーケット' }, { timeout: 5_000 })).toBeTruthy();
  });

  it('/api/i18n/languages 取失败时按退避再取，不等设置变了或重新握手', async () => {
    let calls = 0;
    app = await renderApp(
      '/plugins',
      {},
      plugins({ '/api/i18n/languages': () => (++calls <= 2 ? failing() : english) }),
      { page: false },
    );
    // 起始与握手后各取一次，都失败
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole('link', { name: '市场' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Market' }, { timeout: 5_000 })).toBeTruthy();
  });

  it('语言链不变、新装或更新了语言包：收到 session/config/changed 照样重取补充，变了才换上；没变时什么都不动', async () => {
    let messages: object = { entries: {} };
    app = await renderApp('/plugins', {}, plugins({ ...language(['ja']), '/api/i18n/messages': () => messages }));
    expect(screen.getByRole('link', { name: 'Market' })).toBeTruthy();
    messages = japanese;
    await act(async () => server().notify('session/config/changed', {}));
    expect(await screen.findByRole('link', { name: 'マーケット' })).toBeTruthy();

    await app.reconnect();
    const settled = { fetched: gets('/api/plugins').length, packs: gets('/api/i18n/messages').length };
    await act(async () => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(gets('/api/i18n/messages').length).toBe(settled.packs + 1));
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(sessionSockets()).toHaveLength(2);
    expect(gets('/api/plugins')).toHaveLength(settled.fetched);
  });
});
