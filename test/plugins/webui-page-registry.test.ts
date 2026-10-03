import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import {
  type BoundWebui,
  type Notice,
  type PageDefinition,
  type WebUIService,
  type WebuiAdminEvent,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import { App, definePlugin, type Logger, optional, provide } from '../../packages/core/src/index.js';
import {
  APPLIES_TIMEOUT_MS,
  createPageRegistry,
  INVALIDATE_WINDOW_MS,
} from '../../packages/plugin-webui-server/src/pages.js';

// ════════════════════════════════════════════════════════════
// 页面登记表本身：invalidate 的合并、提示的替换与撤回、按条目身份撤回、会话面板 applies 的超时。
// 只测登记表，不起端口；经真实 HTTP 的闸门见 webui-pages.test.ts。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function registry(sessions: Record<string, SessionInfo['kind']> = {}) {
  const sent: WebuiAdminEvent[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    ...silent,
    warn: (...args: unknown[]) => void logs.push(`warn ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => void logs.push(`error ${args.map(String).join(' ')}`),
  };
  const pages = createPageRegistry({
    logger,
    send: event => void sent.push(event),
    sessions: () => ({
      getSession: id => (sessions[id] ? ({ id, kind: sessions[id] } as SessionInfo) : undefined),
    }),
    signFile: () => undefined,
  });
  return { pages, sent, logs, invalidations: () => sent.filter(e => e.type === 'page.invalidate') };
}

const page = (key: string, extra: Partial<PageDefinition> = {}): PageDefinition => ({
  key,
  title: key,
  content: [{ type: 'markdown', id: 'm', data: () => key }],
  ...extra,
});

afterEach(() => vi.useRealTimers());

describe('invalidate 的合并', () => {
  it('同一实例、页面、组件与会话：第一次立即推，窗口里再来的并成窗口结束时的一次，之后安静', async () => {
    vi.useFakeTimers();
    const { pages, invalidations } = registry();
    for (let i = 0; i < 5; i++) pages.invalidate('p', 'jobs', 'list');
    expect(invalidations()).toEqual([{ type: 'page.invalidate', instance: 'p', pageKey: 'jobs', componentId: 'list' }]);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS);
    expect(invalidations()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS * 3);
    expect(invalidations(), '窗口里没有新的就不再推').toHaveLength(2);
    pages.invalidate('p', 'jobs', 'list');
    expect(invalidations(), '窗口过了，下一次照常立即推').toHaveLength(3);
    pages.dispose();
  });

  it('四项里任一项不同就分开推；带 sessionId 的事件写明会话', () => {
    vi.useFakeTimers();
    const { pages, invalidations } = registry();
    pages.invalidate('p', 'jobs');
    pages.invalidate('p', 'jobs', 'list');
    pages.invalidate('p', 'jobs', 'list', 'webui:a');
    pages.invalidate('p', 'jobs', 'list', 'webui:b');
    pages.invalidate('q', 'jobs', 'list', 'webui:a');
    pages.invalidate('p', 'other', 'list', 'webui:a');
    expect(JSON.parse(JSON.stringify(invalidations()))).toEqual([
      { type: 'page.invalidate', instance: 'p', pageKey: 'jobs' },
      { type: 'page.invalidate', instance: 'p', pageKey: 'jobs', componentId: 'list' },
      { type: 'page.invalidate', instance: 'p', pageKey: 'jobs', componentId: 'list', sessionId: 'webui:a' },
      { type: 'page.invalidate', instance: 'p', pageKey: 'jobs', componentId: 'list', sessionId: 'webui:b' },
      { type: 'page.invalidate', instance: 'q', pageKey: 'jobs', componentId: 'list', sessionId: 'webui:a' },
      { type: 'page.invalidate', instance: 'p', pageKey: 'other', componentId: 'list', sessionId: 'webui:a' },
    ]);
    pages.dispose();
  });

  it('停用时清掉窗口：之后不再推', async () => {
    vi.useFakeTimers();
    const { pages, invalidations } = registry();
    pages.invalidate('p', 'jobs');
    pages.invalidate('p', 'jobs');
    pages.dispose();
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS * 2);
    expect(invalidations()).toHaveLength(1);
  });
});

describe('页面与提示按条目身份撤回', () => {
  it('同一实例同一 key 再登记就是替换，旧的撤回不摘掉新的', () => {
    const { pages, sent } = registry();
    const oldOff = pages.addPage(page('k', { title: '旧' }), 'p');
    const newOff = pages.addPage(page('k', { title: '新' }), 'p');
    expect(pages.views().map(v => v.title)).toEqual(['新']);
    oldOff();
    expect(
      pages.views().map(v => v.title),
      '旧的撤回对已被替换的登记无动作',
    ).toEqual(['新']);
    newOff();
    expect(pages.views()).toEqual([]);
    expect(
      sent.filter(e => e.type === 'plugins.changed'),
      '登记两次、撤回一次',
    ).toHaveLength(3);
  });

  it('登记时推一次这一页的整页 invalidate：插件重载（撤回后马上重新登记）后，打开着的页面换成新一次激活的数据', async () => {
    vi.useFakeTimers();
    const { pages, invalidations } = registry();
    const off = pages.addPage(page('k'), 'p');
    expect(invalidations()).toEqual([{ type: 'page.invalidate', instance: 'p', pageKey: 'k' }]);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS);
    off();
    pages.addPage(page('k'), 'p');
    expect(invalidations()).toHaveLength(2);
    pages.dispose();
  });

  it('不同实例的同名页面各是各的', () => {
    const { pages } = registry();
    pages.addPage(page('works'), '@aalis/plugin-works-site');
    pages.addPage(page('works'), '@aalis/plugin-works-site:draw');
    expect(pages.views().map(v => [v.instance, v.key, v.placement])).toEqual([
      ['@aalis/plugin-works-site', 'works', 'plugin'],
      ['@aalis/plugin-works-site:draw', 'works', 'plugin'],
    ]);
  });

  it('提示：同一个 id 替换，旧的撤回不摘掉新的；open 要指向本实例已登记的页面', () => {
    const { pages, logs } = registry();
    pages.addPage(page('works'), 'p');
    const notice = (title: string): Notice => ({ id: 'pending', level: 'action', title, open: { page: 'works' } });
    const first = pages.addNotice(notice('1 件作品待裁决'), 'p');
    const second = pages.addNotice(notice('2 件作品待裁决'), 'p');
    expect(pages.notices()).toEqual([
      { instance: 'p', id: 'pending', level: 'action', title: '2 件作品待裁决', open: { page: 'works' } },
    ]);
    first();
    expect(pages.notices()).toHaveLength(1);
    second();
    expect(pages.notices()).toEqual([]);

    pages.addPage(page('other'), 'q');
    pages.addNotice({ id: 'x', level: 'error', title: '跳到别的插件', open: { page: 'other' } }, 'p');
    expect(pages.notices(), '别的插件的页面不认').toEqual([]);
    expect(logs).toEqual([
      'error 提示 x（p）没过登记校验，未登记：open：只收 config，或本插件已登记、位置为 plugin 或 settings 的页面 { page }',
    ]);
  });
});

describe('会话面板的 applies', () => {
  it('不写适用于全部会话；回 true 的适用；回 false、抛错、超时或不是布尔值的不适用，后三种记告警', async () => {
    vi.useFakeTimers();
    const { pages, logs } = registry({ 'qq:group:1': 'room' });
    const panel = (key: string, applies?: PageDefinition['applies']) =>
      pages.addPage(page(key, { placement: 'session', applies }), 'p');
    const seen: unknown[] = [];
    panel('always');
    panel('yes', session => {
      seen.push(session);
      return session.kind === 'room';
    });
    panel('no', () => false);
    panel('throws', () => {
      throw new Error('账本读不出来');
    });
    panel('hangs', () => new Promise<boolean>(() => {}));
    panel('odd', () => 'yes' as unknown as boolean);
    pages.addPage(page('elsewhere'), 'p');

    const reply = pages.panelPages('qq:group:1');
    await vi.advanceTimersByTimeAsync(APPLIES_TIMEOUT_MS);
    expect(await reply).toEqual({
      status: 200,
      body: {
        pages: [
          { instance: 'p', pageKey: 'always' },
          { instance: 'p', pageKey: 'yes' },
        ],
      },
    });
    expect(seen).toEqual([{ sessionId: 'qq:group:1', kind: 'room' }]);
    // 各页面的 applies 并行地问，告警的先后不定
    expect([...logs].sort()).toEqual(
      [
        'warn 会话面板页面 throws（p）的 applies 出错，按不适用处理: 账本读不出来',
        `warn 会话面板页面 hangs（p）的 applies 出错，按不适用处理: 超过 ${APPLIES_TIMEOUT_MS} 毫秒没有答复`,
        'warn 会话面板页面 odd（p）的 applies 出错，按不适用处理: 没有回布尔值',
      ].sort(),
    );
  });

  it('会话不存在回 404，缺会话 id 回 400', async () => {
    const { pages } = registry();
    expect(await pages.panelPages('webui:gone')).toEqual({ status: 404, body: { error: '会话 webui:gone 不存在' } });
    expect(await pages.panelPages(undefined)).toEqual({ status: 400, body: { error: 'sessionId 要是非空字符串' } });
  });
});

describe('绑定门面', () => {
  it('definePage 与 notify 归属这次激活：停用时撤回，invalidate 带上实例与页面；提示的 clear 撤回自己那条', async () => {
    const calls: string[] = [];
    const service: WebUIService = {
      getPort: () => 0,
      getHost: () => '',
      addPage(definition, instance) {
        calls.push(`page+ ${instance} ${definition.key}`);
        return () => calls.push(`page- ${instance} ${definition.key}`);
      },
      invalidate: (instance, pageKey, componentId, sessionId) =>
        void calls.push(`invalidate ${instance} ${pageKey} ${componentId} ${sessionId}`),
      addNotice(notice, instance) {
        calls.push(`notice+ ${instance} ${notice.id} ${notice.title}`);
        return () => calls.push(`notice- ${instance} ${notice.id} ${notice.title}`);
      },
    };
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    app.bind({ provide }).provide(webuiServer, service);
    let webui: BoundWebui | undefined;
    const owner = definePlugin({
      name: 'page-owner',
      uses: { webui: optional(webuiServer) },
      apply: caps => {
        webui = caps.webui;
      },
    });
    try {
      await app.plugin(owner);
      const handle = webui!.definePage({
        key: 'jobs',
        title: '任务',
        content: [{ type: 'markdown', id: 'm', data: () => '' }],
      });
      handle.invalidate('m', 'webui:a');
      const first = webui!.notify({ id: 'n', level: 'action', title: '一' });
      webui!.notify({ id: 'n', level: 'action', title: '二' });
      first.clear();
      await app.plugins.disable('page-owner');
      expect(calls).toEqual([
        'page+ page-owner jobs',
        'invalidate page-owner jobs m webui:a',
        'notice+ page-owner n 一',
        'notice- page-owner n 一',
        'notice+ page-owner n 二',
        'page- page-owner jobs',
        'notice- page-owner n 二',
      ]);
    } finally {
      await app.stop();
    }
  });
});
