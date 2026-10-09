// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  CHAT_MODEL,
  type FakeRest,
  type Harness,
  installDialog,
  lists,
  pluginRow as plugin,
  renderApp,
  restCalls,
} from './harness.js';

// ════════════════════════════════════════════════════════════
// 「开始使用」：模型列表（GET /api/models/llm）里没有一个能对话（带 chat 能力）的模型时，首页「需要处理」摘要上方出现
// 「选一个对话模型」：列已装的、提供 llm 服务的插件与它为什么不能用（待配置去配置、停用一键启用、失败去处理、在运行但
// 没有能对话的模型照实写），再列市场里提供 llm、还没装的包，「安装」走市场同一个确认框。市场取不到时写原因，已装的照常列。
// 有了能对话的模型就消失；插件列表或「需要处理」变了重取。手机上在第一层顶部
// ════════════════════════════════════════════════════════════

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

const PLUGINS = [
  plugin('zz-openai', {
    displayName: 'OpenAI 对话',
    provides: ['llm'],
    state: 'error',
    error: '缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效',
    unconfigured: ['apiKey'],
  }),
  plugin('zz-local', { displayName: '本地模型', provides: ['llm'], state: 'disabled' }),
  plugin('zz-ollama', { displayName: 'Ollama 对话', provides: ['llm'] }),
  plugin('zz-notes', { displayName: '笔记' }),
];

/** 市场里的包：一个提供 llm 没装的、一个已装的、一个不提供 llm 的 */
const pkg = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  version: '1.0.0',
  description: '',
  installed: false,
  updatable: false,
  official: true,
  category: 'plugin',
  provides: [],
  ...fields,
});
const MARKET = {
  packages: [
    pkg('@aalis/plugin-zz-deepseek', { description: 'DeepSeek 对话模型', provides: ['llm'] }),
    pkg('zz-openai', { installed: true, resolved: '1.0.0', provides: ['llm'] }),
    pkg('@aalis/plugin-zz-notes', { description: '记笔记' }),
  ],
};

/** 只有识图模型，没有能对话的 */
const NO_CHAT = {
  providers: [{ model: 'zz-eye', provider: 'Ollama 对话', contextId: 'zz-ollama', capabilities: ['vision'] }],
};

function rest(extra: FakeRest = {}): FakeRest {
  return {
    '/api/plugins': { plugins: PLUGINS, secretRefCounts: {} },
    '/api/models/llm': NO_CHAT,
    '/api/marketplace?q=': MARKET,
    ...extra,
  };
}

const noSessions = { 'sessions/list': lists(() => []) };
const card = () => screen.findByRole('region', { name: '开始使用' });

/** 卡片里的行：文字与操作 */
function rows(region: HTMLElement) {
  return within(region)
    .getAllByRole('listitem')
    .map(row => ({
      text: row.querySelector('.attention-text')?.textContent,
      action: within(row).queryByRole('link')?.textContent ?? within(row).queryByRole('button')?.textContent,
    }));
}

describe('开始使用', () => {
  it('没有能对话的模型：列已装的 llm 提供者与它为什么不能用，再列市场里没装的；在「需要处理」摘要上方', async () => {
    app = await renderApp('/', noSessions, {
      ...rest(),
      '/api/attention': {
        items: [
          {
            kind: 'plugin',
            instance: 'zz-openai',
            state: 'error',
            error: '缺少配置项 apiKey',
            lacking: [],
            waiting: [],
            unconfigured: ['apiKey'],
          },
        ],
      },
    });
    const region = await card();
    expect(within(region).getByRole('heading').textContent).toBe('开始使用');
    expect(within(region).getByText('选一个对话模型', { exact: false })).toBeTruthy();
    await vi.waitFor(() =>
      expect(rows(region)).toEqual([
        { text: 'OpenAI 对话待配置：apiKey', action: '去配置' },
        { text: '本地模型已停用', action: '启用' },
        { text: 'Ollama 对话在运行，但没有能对话的模型', action: '去处理' },
        { text: '@aalis/plugin-zz-deepseekDeepSeek 对话模型', action: '安装' },
      ]),
    );
    expect(within(region).getByRole('link', { name: '去配置' }).getAttribute('href')).toBe('/plugins/zz-openai#config');
    const attention = screen.getByRole('region', { name: '需要处理' });
    expect(region.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('有能对话的模型：不出现，也不去取市场', async () => {
    app = await renderApp('/', noSessions, rest({ '/api/models/llm': { providers: [CHAT_MODEL] } }));
    await screen.findByRole('heading', { name: '新会话' });
    await vi.waitFor(() => expect(restCalls().some(call => call.path === '/api/models/llm')).toBe(true));
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    expect(screen.queryByRole('region', { name: '开始使用' })).toBeNull();
    expect(restCalls().some(call => call.path.startsWith('/api/marketplace'))).toBe(false);
  });

  it('「启用」直接启用这个提供者；「安装」走市场同一个确认框，装上插件后跳到它详情的配置区', async () => {
    app = await renderApp(
      '/',
      noSessions,
      rest({
        '/api/plugins/zz-local/enable': { ok: true, message: '插件 zz-local 已启用' },
        '/api/marketplace/depgraph?name=%40aalis%2Fplugin-zz-deepseek': {
          upstream: { name: '@aalis/plugin-zz-deepseek', present: false, children: [] },
          downstream: { name: '@aalis/plugin-zz-deepseek', present: false, children: [] },
          services: { required: [], provides: ['llm'] },
          serviceDependents: [],
        },
        '/api/marketplace/install': {
          ok: true,
          message: '已安装并加载: @aalis/plugin-zz-deepseek',
          plugin: '@aalis/plugin-zz-deepseek',
        },
      }),
    );
    const region = await card();
    fireEvent.click(await within(region).findByRole('button', { name: '启用' }));
    await vi.waitFor(() =>
      expect(
        restCalls()
          .filter(call => call.method === 'POST')
          .map(call => call.path),
      ).toEqual(['/api/plugins/zz-local/enable']),
    );
    // 动作做完（重取插件列表之后）才能做下一个
    const install = within(region).getByRole('button', { name: '安装' }) as HTMLButtonElement;
    await vi.waitFor(() => expect(install.disabled).toBe(false));
    fireEvent.click(install);
    const dialog = within(screen.getByRole('dialog', { name: '安装「@aalis/plugin-zz-deepseek」？' }));
    expect(await dialog.findByText('llm')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: '安装' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/plugins/%40aalis%2Fplugin-zz-deepseek#config'));
  });

  it('启用没成：Toast 写启用的是谁，「查看日志」去被启用的插件', async () => {
    app = await renderApp(
      '/',
      noSessions,
      rest({ '/api/plugins/zz-local/enable': () => Response.json({ error: '正在停机' }, { status: 409 }) }),
    );
    fireEvent.click(await within(await card()).findByRole('button', { name: '启用' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('启用 本地模型失败：正在停机');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-local',
    );
  });

  it('市场只在出现时与装完之后取：插件列表或「需要处理」变了只重取模型；在别处装上的提供者不再列为可装', async () => {
    let plugins = PLUGINS;
    app = await renderApp('/', noSessions, rest({ '/api/plugins': () => ({ plugins, secretRefCounts: {} }) }));
    const region = await card();
    await within(region).findByText('@aalis/plugin-zz-deepseek');
    const calls = (path: string) => restCalls().filter(call => call.path === path).length;
    const models = calls('/api/models/llm');
    plugins = [...PLUGINS, plugin('@aalis/plugin-zz-deepseek', { displayName: 'DeepSeek 对话', provides: ['llm'] })];
    act(() => FakeWebSocket.at('/admin').push({ type: 'plugins.changed' }));
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    await vi.waitFor(() => expect(calls('/api/models/llm')).toBeGreaterThanOrEqual(models + 2));
    await vi.waitFor(() => expect(within(region).queryByText('@aalis/plugin-zz-deepseek')).toBeNull());
    expect(within(region).getByText('DeepSeek 对话')).toBeTruthy();
    expect(calls('/api/marketplace?q=')).toBe(1);
  });

  it('市场取不到时写原因，已装的照常列', async () => {
    app = await renderApp(
      '/',
      noSessions,
      rest({ '/api/marketplace?q=': () => Response.json({ error: '检索源连不上' }, { status: 502 }) }),
    );
    const region = await card();
    expect(await within(region).findByText('市场没取到：检索源连不上', { exact: false })).toBeTruthy();
    expect(rows(region).map(row => row.text)).toEqual([
      'OpenAI 对话待配置：apiKey',
      '本地模型已停用',
      'Ollama 对话在运行，但没有能对话的模型',
    ]);
  });

  it('旧版服务端回的包没有 provides：按没有声明提供服务处理，不列为可装；包名不是文字时整张不认，写原因', async () => {
    const { provides: _provides, ...deepseek } = MARKET.packages[0];
    app = await renderApp('/', noSessions, rest({ '/api/marketplace?q=': { packages: [deepseek] } }));
    let region = await card();
    await vi.waitFor(() => expect(restCalls().some(call => call.path === '/api/marketplace?q=')).toBe(true));
    expect(rows(region).map(row => row.text)).toEqual([
      'OpenAI 对话待配置：apiKey',
      '本地模型已停用',
      'Ollama 对话在运行，但没有能对话的模型',
    ]);
    app.close();

    app = await renderApp('/', noSessions, rest({ '/api/marketplace?q=': { packages: [{ ...deepseek, name: 42 }] } }));
    region = await card();
    expect(await within(region).findByText('市场没取到：市场的回应不是预期的形状', { exact: false })).toBeTruthy();
  });

  it('市场离线降级时写服务端的说明', async () => {
    app = await renderApp(
      '/',
      noSessions,
      rest({ '/api/marketplace?q=': { packages: [], warning: '检索源不可用，只列出本地已装的包' } }),
    );
    const region = await card();
    expect(await within(region).findByText('检索源不可用，只列出本地已装的包')).toBeTruthy();
  });

  it('插件列表或「需要处理」变了重取：有了能对话的模型就消失', async () => {
    let models: unknown = NO_CHAT;
    app = await renderApp('/', noSessions, rest({ '/api/models/llm': () => models }));
    await card();
    models = { providers: [CHAT_MODEL] };
    act(() => FakeWebSocket.at('/admin').push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: '开始使用' })).toBeNull());

    models = NO_CHAT;
    act(() => FakeWebSocket.at('/admin').push({ type: 'attention.changed' }));
    expect(await card()).toBeTruthy();
  });

  it('模型列表没取到：原地写明原因，可以重试', async () => {
    let fail = true;
    app = await renderApp(
      '/',
      noSessions,
      rest({
        '/api/models/llm': () => (fail ? Response.json({ error: '模型服务出错' }, { status: 500 }) : NO_CHAT),
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('对话模型列表没取到：模型服务出错');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await card()).toBeTruthy();
  });

  it('手机上在第一层顶部，「需要处理」摘要上方', async () => {
    stubViewport(390);
    app = await renderApp('/', noSessions, {
      ...rest(),
      '/api/attention': {
        items: [
          {
            kind: 'plugin',
            instance: 'zz-openai',
            state: 'error',
            error: '缺少配置项 apiKey',
            lacking: [],
            waiting: [],
            unconfigured: ['apiKey'],
          },
        ],
      },
    });
    const left = within(screen.getByRole('navigation', { name: '会话' }));
    const region = await left.findByRole('region', { name: '开始使用' });
    const attention = await left.findByRole('region', { name: '需要处理' });
    const entries = left.getByRole('list', { name: '入口' });
    expect(region.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attention.compareDocumentPosition(entries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('region', { name: '开始使用' })).toHaveLength(1);
  });
});
