import type { HTTPRequest, Page } from 'puppeteer';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { backgroundTasks } from '../../packages/api-tools/src/index.js';
import type { PageListResponse } from '../../packages/api-webui/src/index.js';
import { LogHub, type PluginDefinition } from '../../packages/core/src/index.js';
import {
  defaultPicks,
  MINIMAL_BASE,
  pluginSet,
  pluginSettings,
  renderConfig,
} from '../../packages/create-aalis/src/cli.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import {
  aria,
  attentionRows,
  onViewport,
  openWebui,
  sessionIdOf,
  TOKEN,
  text,
  toastSays,
  useWebuiE2E,
  VIEWPORTS,
  webuiStack,
} from '../fixtures/webui-e2e.js';
import { deferred } from '../helpers/deferred.js';
import { waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// standard 档的端到端：照脚手架 standard 档的默认集组装——它算出的插件集（选了语义记忆，没有 Ollama 时 embedding 用
// OpenAI）与它写的配置文档（owner 的平台档给全部工具分组）。外部服务换成替身：对话模型是假模型，记忆后端用内存实现（不依赖
// 原生模块），OpenAI Embedding 不填 apiKey（照常起不来，向量记忆因此缺服务，两个都进「需要处理」），MCP 不配服务器。
// 桌面与手机两种宽度走主流程：发消息与流式回复，模型经工具搜索找到工具再调用（工具卡与审批），回滚撤回写的文件，计划，
// 压缩线，转后台的命令在「后台」里停掉，会话设置与会话默认，插件区与详情，运行状况与「需要处理」，各页面打开不空；
// 页面里没有没处理的报错，服务端除了 OpenAI Embedding 起不来的那一行没有告警与错误
// ════════════════════════════════════════════════════════════

const EMBEDDING = '@aalis/plugin-embedding-openai';
const VECTOR = '@aalis/plugin-memory-vector';
const REPORT = 'workspace:/周报.md';
const STEP = '整理周报';
const COMMAND = 'sleep 30';
const GREETING = '你好，我在。这是一段慢慢流出来的回复，用来看流式显示。';

/** 用户的话里有这几个词时，这一轮先用工具搜索找工具、再调用它，工具返回后说收尾的那句 */
const FLOWS: Record<string, { tool: string; args: Record<string, unknown>; reply: string }> = {
  写周报: { tool: 'file_write', args: { path: REPORT, content: '# 周报\n' }, reply: '周报写好了。' },
  排计划: {
    tool: 'manage_todo_list',
    args: { todoList: [{ id: 1, title: STEP, status: 'in-progress' }] },
    reply: '计划排好了。',
  },
  后台跑: { tool: 'exec', args: { command: COMMAND, runInBackground: true }, reply: '转到后台了。' },
};

/** 假模型：不带工具定义的辅助调用（标题、摘要、档案与关系的抽取）回一句标题；照 FLOWS 走工具，别的话回 GREETING */
function script(request: ChatModelRequest): ChatResponse {
  if (!request.tools) return { content: '标准档会话' };
  const said = request.messages.findLast(message => message.role === 'user')?.content;
  const flow = Object.entries(FLOWS).find(([words]) => typeof said === 'string' && said.includes(words))?.[1];
  if (!flow) return { content: GREETING };
  const last = request.messages.at(-1);
  const call = (name: string, args: Record<string, unknown>): ChatResponse => ({
    content: null,
    toolCalls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  if (last?.role === 'user') return call('search_tools', { query: flow.tool });
  if (String(last?.content).startsWith('{"found"')) return call(flow.tool, flow.args);
  return { content: flow.reply };
}

const e2e = useWebuiE2E();
const { cleanups } = e2e;

/**
 * 起运行时：脚手架 standard 档的插件集与配置文档；对话模型、记忆后端与前端包由共用组合换成替身（假模型的上下文与对话模型
 * 相当，回 GREETING 的那次流出第一块后停住，等 resume 放行），两个起不来的插件在 start 之前另登记。logged 是从登记起
 * 服务端记下的告警与错误
 */
async function start() {
  const logged: string[] = [];
  const greeting = deferred();
  const off = LogHub.default.onEntry(entry => {
    if (entry.level === 'warn' || entry.level === 'error') logged.push(entry.message);
  });
  cleanups.push(async () => off());
  const picks = {
    ...defaultPicks('standard', false),
    semantic: { embedding: EMBEDDING, vectorstore: '@aalis/plugin-vectorstore-flat' },
  };
  const set = pluginSet({ tier: 'standard', picks }, true);
  const doc = parse(renderConfig(pluginSettings(set, {}))) as Partial<AalisConfig>;
  const replaced = new Set([
    ...MINIMAL_BASE,
    picks.chat,
    picks.memory,
    '@aalis/plugin-webui-server',
    '@aalis/plugin-webui-client',
  ]);
  const load = async (name: string) => ((await import(name)) as { default: PluginDefinition }).default;
  const names = [...set].filter(name => !replaced.has(name));
  const unstartable = [EMBEDDING, VECTOR];
  const { app, port } = await webuiStack({
    clientDir: e2e.clientDir,
    model: createMockLLMPlugin({
      responses: script,
      latencyMs: 20,
      contextLength: 65_536,
      hold: request => (script(request).content === GREETING ? greeting.promise : undefined),
    }),
    extra: await Promise.all(names.filter(name => !unstartable.includes(name)).map(load)),
    cleanups,
    doc,
  });
  for (const name of unstartable) await app.plugin(await load(name), {});
  await app.start();
  await waitListening(port);
  return { app, origin: `http://127.0.0.1:${port}`, logged, resume: greeting.resolve };
}

/** 服务端只记了 OpenAI Embedding 缺 apiKey 起不来的那一行 */
const ONLY_UNCONFIGURED = [expect.stringContaining(`"${EMBEDDING}" 激活失败`)];

/** 页面停 ms 毫秒期间发出的 HTTP 请求与 WebSocket 帧：推送替代轮询，空闲时应为空 */
async function idle(page: Page, ms: number): Promise<string[]> {
  const sent: string[] = [];
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', ({ response }) => void sent.push(`帧 ${response.payloadData}`));
  const onRequest = (request: HTTPRequest) => void sent.push(`请求 ${request.url()}`);
  page.on('request', onRequest);
  await new Promise(resolve => setTimeout(resolve, ms));
  page.off('request', onRequest);
  await cdp.detach();
  return sent;
}

const ATTENTION = [
  ['OpenAI Embedding', '待配置：apiKey', '去配置'],
  ['向量记忆', '缺服务：OpenAI Embedding（待配置：apiKey）', '去配置 OpenAI Embedding'],
];

describe.each(Object.entries(VIEWPORTS))('%s', (width, viewport) => {
  const phone = width === 'phone';
  const { newSession, send, openPanel, openBackground } = onViewport(phone);

  it('会话：流式回复；模型经工具搜索找到工具再调用，写文件要批准，回滚撤回写的文件；计划标签；压缩线；转后台的命令在「后台」里停掉；会话设置就地改', async () => {
    const stack = await start();
    const { page, problems } = await openWebui(e2e.browser, stack.origin, viewport, cleanups);
    await newSession(page);
    await send(page, '你好');
    const sessionId = await sessionIdOf(page);
    // 流式：回复流出第一块后停住，时间线上已是这一块、还没有整句，头部写着回合正在运行；放行后流完，回合结束
    await page.waitForSelector(`.message[data-from="agent"] ${text(GREETING.slice(0, 4))}`);
    expect(await page.$$(text(GREETING))).toHaveLength(0);
    await page.waitForSelector('::-p-aria(正在运行)');
    stack.resume();
    await page.waitForSelector(text(GREETING));
    await page.waitForSelector('::-p-aria(正在运行)', { hidden: true });
    await page.waitForSelector('::-p-aria(正在输出)', { hidden: true });

    // 工具卡与审批：先用工具搜索找到写文件的工具，写文件等 owner 批准，卡上是路径与要写的内容
    await send(page, '写周报');
    const card = await page.waitForSelector(aria('审批', 'region'));
    expect(await card?.evaluate(element => element.textContent)).toContain(REPORT);
    const lines = () => page.$$eval('.tool-line-text', cells => cells.map(cell => cell.textContent));
    expect(await lines()).toEqual(['调用 search_tools', `写入 ${REPORT}`]);
    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('周报写好了。'));
    const files = stack.app.bind({ storage }).storage.require();
    expect(await files.readFile(REPORT, 'utf-8')).toBe('# 周报\n');

    // 回滚：检查点记下了这一轮写的文件（平时藏着，悬停在这一轮上才出现，触屏上常显），回滚后文件没了
    const turn = (await page.$$('.turn:has(.turn-rewind)')).at(-1);
    if (!phone) await turn?.hover();
    await (await turn?.$(aria('回滚这一轮', 'button')))?.click();
    await page.locator(aria('回滚文件改动', 'menuitem')).click();
    await page.locator(`${aria('回滚这一轮的文件改动？', 'dialog')} ${aria('回滚', 'button')}`).click();
    await toastSays(page, '已回滚：删除 1 个文件');
    await expect(files.stat(REPORT)).rejects.toThrow();

    // 压缩线：用量取会话设置项「自动压缩线」，各层都没设时为默认 0.8
    const meter = await page.waitForSelector('[aria-label^="上下文已用"]');
    expect(await meter?.evaluate(element => element.getAttribute('title'))).toMatch(
      /^上下文已用 \d+%，到 80% 自动压缩$/,
    );

    // 计划：待办插件的工具写入计划，面板里出现计划标签
    await send(page, '排计划');
    await page.waitForSelector(text('计划排好了。'));
    await openPanel(page);
    await page.locator(aria('计划', 'tab')).click();
    await page.waitForSelector(`aside ${text(STEP)}`);

    // 会话设置：在面板的设置标签里就地改额外提示（多行，Ctrl+回车存），这一行出现「恢复继承」
    await page.locator(aria('设置', 'tab')).click();
    const extra = '.setting-row[aria-label="额外提示"]';
    await page.locator(`${extra} .setting-row-main`).click();
    await (await page.waitForSelector(`${extra} ${aria('额外提示', 'textbox')}`))?.type('回答简短');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForSelector(`${extra} ${aria('恢复继承', 'button')}`);
    const sessions = stack.app.bind({ sessionManager }).sessionManager.require();
    expect(sessions.getOwnConfig(sessionId).systemPromptExtra).toBe('回答简短');

    // 后台：命令要批准，批准后立即转到后台；在「后台」标签里停掉，进程随之结束
    await page.goto(`${stack.origin}/s/${encodeURIComponent(sessionId)}`);
    await send(page, '后台跑');
    await page.waitForSelector(aria('审批', 'region'));
    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('转到后台了。'));
    await openBackground(page, 1);
    const calls = `aside ${aria('工具调用 · 1', 'region')}`;
    await page.waitForSelector(`${calls} ${aria(`停止「${COMMAND}」`, 'button')}`);
    // 推送替代轮询：「后台」开着、命令在跑（每秒走的耗时在走），页面停着时不取数、会话连接上不发帧
    expect(await idle(page, 5_000)).toEqual([]);
    await page.locator(`${calls} ${aria(`停止「${COMMAND}」`, 'button')}`).click();
    await page.locator(`${calls} ${aria('已结束 · 1', 'button')}`).click();
    await page.waitForSelector(`${calls} ${aria('已结束的工具调用', 'list')} ${text('已停止')}`);
    const tasks = stack.app.bind({ backgroundTasks }).backgroundTasks.require();
    expect(tasks.list({ sessionId }).map(task => task.status)).toEqual(['stopped']);
    expect(problems).toEqual([]);
    expect(stack.logged).toEqual(ONLY_UNCONFIGURED);
  }, 90_000);

  it('管理：首页不出「开始使用」；首页与运行状况的「需要处理」列出 OpenAI Embedding 与向量记忆、链写到根，按钮去根的配置；平台连接；插件区的树正是装着的实例；会话默认的 webui 平台档给全部工具分组；各页面打开都有内容、没有报错', async () => {
    const stack = await start();
    const { page, problems } = await openWebui(e2e.browser, stack.origin, viewport, cleanups);
    const home = `${phone ? 'nav[aria-label="会话"]' : 'main'} ${aria('需要处理', 'region')}`;
    await page.waitForSelector(`${home} ${text('向量记忆')}`);
    expect(await attentionRows(page, home)).toEqual(ATTENTION);
    // 有能对话的（假）模型：模型列表取回之后首页不出「开始使用」
    await page.waitForNetworkIdle();
    expect(await page.$(`${phone ? 'nav[aria-label="会话"]' : 'main'} ${aria('开始使用', 'region')}`)).toBeNull();
    await page.locator(`${home} ${aria('去配置 OpenAI Embedding', 'link')}`).click();
    await page.waitForFunction(
      name => location.pathname === `/plugins/${encodeURIComponent(name)}` && location.hash === '#config',
      {},
      EMBEDDING,
    );
    await page.waitForSelector(`main ${aria('API Key', 'textbox')}`);

    await page.goto(`${stack.origin}/health`);
    const block = `main ${aria('需要处理', 'region')}`;
    await page.waitForSelector(`${block} ${text('向量记忆')}`);
    expect(await attentionRows(page, block)).toEqual(ATTENTION);
    const platforms = await page.waitForSelector(`main ${aria('平台连接', 'list')}`);
    await page.waitForFunction(list => list?.textContent?.includes('在线'), {}, platforms);
    expect(
      await platforms?.$$eval('li', items =>
        items.map(row => [
          row.querySelector('.list-item-title')?.textContent,
          row.querySelector('.list-item-meta')?.textContent,
          row.querySelector('[data-marker]')?.getAttribute('data-marker') ?? null,
        ]),
      ),
    ).toEqual([
      ['WebUI', '在线', null],
      ['CLI', '没有连接', null],
    ]);

    await page.goto(`${stack.origin}/plugins`);
    await page.waitForSelector(`nav[aria-label="插件"] a[href="/plugins/${encodeURIComponent(VECTOR)}"]`);
    const listed = await page.$$eval('nav[aria-label="插件"] a', links =>
      links
        .map(link => new URL((link as HTMLAnchorElement).href).pathname)
        .filter(path => path.startsWith('/plugins/'))
        .map(path => decodeURIComponent(path.slice('/plugins/'.length))),
    );
    expect(listed.sort()).toEqual(
      stack.app.plugins
        .getStatus()
        .map(plugin => plugin.instanceId)
        .sort(),
    );

    await page.goto(`${stack.origin}/settings/session-defaults`);
    await page.locator(`main ${aria('层', 'combobox')}`).click();
    await page.locator(aria('平台档：webui', 'option')).click();
    // 换层之后这一行原地换值，按文字找的选择器在这里等不到新值（实测），直接读这一行的文字
    await page.waitForFunction(() =>
      document.querySelector('main .setting-row[aria-label="工具分组"]')?.textContent?.includes('* （全部分组）'),
    );

    // 各页面：插件页与设置页打开后都有内容，没有取数失败；会话里的页面在会话面板里
    const pages = (await (
      await fetch(`${stack.origin}/api/pages`, { headers: { Cookie: `aalis_webui_token=${TOKEN}` } })
    ).json()) as PageListResponse;
    const opened: string[] = [];
    for (const { instance, key, title, placement } of pages.pages) {
      if (placement === 'session') continue;
      const ref = `${encodeURIComponent(instance)}/${encodeURIComponent(key)}`;
      await page.goto(`${stack.origin}${placement === 'settings' ? '/settings' : ''}/p/${ref}`);
      await page.waitForSelector(`main ${aria(title, 'heading')}`);
      await page.waitForNetworkIdle({ idleTime: 300 });
      expect(await page.$$('main .page-block'), title).not.toHaveLength(0);
      expect(await page.$$('main [role="alert"]'), title).toHaveLength(0);
      opened.push(title);
    }
    expect(opened.sort()).toEqual(
      ['人物关系图', '关系图原始数据', '权限', '技能', '用户档案', '系统诊断', '计划任务'].sort(),
    );
    expect(problems).toEqual([]);
    expect(stack.logged).toEqual(ONLY_UNCONFIGURED);
  }, 90_000);
});
