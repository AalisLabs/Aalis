import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type ChatModelRequest, llm } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeSummaryLLM, setupSummary } from '../fixtures/memory-summary.js';
import { recordRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 结构化摘要：两套模板按房间类别选。场所是聊天窗口的根会话（多方窗口，或对端不是 owner 的一对一）用聊天模板，
// 其余（owner 自己的会话、内部会话与全部子会话）用工作模板。只看父会话与 api-session-manager 的房间类别，
// 不看平台类型名；一对一的对端是不是 owner 问权限服务，没有权限服务时按不是。
// ════════════════════════════════════════════════════════════

const OWNER_QQ = '<owner>';
const GROUP = 'onebot:10000:group:20001';
/** 类型名不叫 group 的多方窗口 */
const CHANNEL = 'onebot:10000:channel:20002';
const MEMBER_DM = 'onebot:10000:private:30001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ}`;

const CHAT = ['最近在聊什么', '谁有问题没回应', '关键原话要点'];
const WORK = ['目标', '做过的决定', '改过的文件', '未完成的事'];
type Template = '聊天' | '工作';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup({ withAuthority = true } = {}) {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const summaryLLM = fakeSummaryLLM();
  const host = app.bind({ provide, events, memory, compression, sessionManager });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  if (withAuthority)
    host.provide.use(authority, {
      isOwner: (platform: string, userId?: string) => platform === 'onebot' && userId === OWNER_QQ,
    } as never);
  host.provide.use(llm, summaryLLM.model);
  await app.plugin(memorySummary);
  await app.plugins.idle();
  if (app.plugins.getPlugin(memorySummary.name)?.state !== 'active') throw new Error('plugin-memory-summary 未激活');
  for (const id of [GROUP, CHANNEL, MEMBER_DM, OWNER_DM]) await recordRoom(host.events.use, id);
  const store = host.memory.use;
  const compressor = host.compression.use;
  /** 往会话里写一条消息再手动压缩，返回这次的摘要请求 */
  const summarize = async (sessionId: string): Promise<ChatModelRequest> => {
    await store.saveMessage(sessionId, { role: 'user', content: '[甲(30001)] 明天下午三点开会' });
    await compressor.compress(sessionId, { reason: 'manual' });
    const request = summaryLLM.requests.at(-1);
    if (request?.sessionId !== sessionId) throw new Error(`没有 ${sessionId} 的摘要请求`);
    return request;
  };
  return { sm: host.sessionManager.use, store, summarize };
}

const systemOf = (request: ChatModelRequest) => String(request.messages[0]?.content ?? '');

/** 系统提示含这套模板的全部小节标题，不含另一套的 */
function expectTemplate(request: ChatModelRequest, template: Template): void {
  const [own, other] = template === '聊天' ? [CHAT, WORK] : [WORK, CHAT];
  const system = systemOf(request);
  for (const title of own) expect(system, `应有小节「${title}」`).toContain(`【${title}】`);
  for (const title of other) expect(system, `不应有小节「${title}」`).not.toContain(`【${title}】`);
}

const rows: Array<[string, Template, (sm: SessionManagerService) => Promise<string>]> = [
  ['群（多方窗口）', '聊天', async () => GROUP],
  ['类型名不叫 group 的多方窗口', '聊天', async () => CHANNEL],
  ['别人的私聊', '聊天', async () => MEMBER_DM],
  ['owner 的 IM 私聊', '工作', async () => OWNER_DM],
  ['WebUI 的根会话', '工作', async sm => (await sm.createSession({ name: '本机会话' }, { createdFrom: 'webui' })).id],
  ['终端', '工作', async sm => (await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' })).id],
  ['mcp-server（内部会话）', '工作', async sm => (await sm.ensureSession('mcp-server')).id],
  ['群里派出的子会话', '工作', async sm => (await sm.createChildSession(GROUP, { name: '子任务' })).id],
];

describe('plugin-memory-summary: 按房间类别选摘要模板', () => {
  it.each(rows)('%s用%s模板', async (_label, template, open) => {
    const { sm, summarize } = await setup();
    expectTemplate(await summarize(await open(sm)), template);
  });

  it('没有会话管理服务时按工作模板', async () => {
    const summaryLLM = fakeSummaryLLM();
    const { app, memory, compression } = await setupSummary({}, summaryLLM.model);
    apps.push(app);
    await memory.saveMessage(GROUP, { role: 'user', content: '在吗' });
    await compression.compress(GROUP, { reason: 'manual' });
    expectTemplate(summaryLLM.requests[0], '工作');
  });

  it('没有权限服务时一对一窗口按别人的私聊：owner 的 IM 私聊也用聊天模板', async () => {
    const { summarize } = await setup({ withAuthority: false });
    expectTemplate(await summarize(OWNER_DM), '聊天');
  });
});

describe('plugin-memory-summary: 模板的共同规则', () => {
  it.each([
    ['聊天', GROUP, CHAT],
    ['工作', 'mcp-server', WORK],
  ])('%s模板：小节按顺序列出，没有内容写「无」，输出上限写进提示词', async (_label, sessionId, titles) => {
    const { summarize } = await setup();
    const request = await summarize(sessionId);
    const system = systemOf(request);
    const positions = titles.map(title => system.indexOf(`【${title}】`));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(system).toContain('写「无」');
    expect(system).toContain(`上限为 ${request.maxTokens} tokens`);
  });

  it('聊天模板要求发言人写成「昵称(ID)」', async () => {
    const { summarize } = await setup();
    expect(systemOf(await summarize(GROUP))).toContain('「昵称(ID)」');
  });

  it('有旧摘要时请求里带「在同名小节上合并」的要求与旧摘要，没有旧摘要时不带', async () => {
    const { summarize } = await setup();
    const first = String((await summarize(GROUP)).messages.at(-1)?.content);
    expect(first).not.toContain('同名小节');

    const second = String((await summarize(GROUP)).messages.at(-1)?.content);
    expect(second).toContain('以下是之前的对话摘要：\nSUMMARY-TEXT');
    expect(second).toContain('同名小节上合并');
  });

  it('旧摘要没有本模板的小节时（没有结构的旧摘要、换过模板），请求要求按意思归入对应小节、不保留模板之外的小节', async () => {
    const { store, summarize } = await setup();
    await store.saveMetadata('summary', GROUP, { summary: '旧的自由文本摘要\n【进行中的任务】整理文档' });
    const input = String((await summarize(GROUP)).messages.at(-1)?.content);
    expect(input).toContain('以下是之前的对话摘要：\n旧的自由文本摘要');
    expect(input).toContain(
      '之前的摘要没有这些小节、或小节与本模板不同时，把这些内容按意思归入对应小节，不保留模板之外的小节',
    );
  });
});

describe('plugin-memory-summary: 待办参数只交给工作模板', () => {
  it.each([
    ['工作模板的输入带上待办参数那一行', OWNER_DM, true],
    ['聊天模板的输入不带', GROUP, false],
  ])('%s', async (_label, sessionId, expected) => {
    const { store, summarize } = await setup();
    const call = {
      id: 't1',
      type: 'function' as const,
      function: { name: 'manage_todo_list', arguments: '{"todoList":[]}' },
    };
    await store.saveMessage(sessionId, { role: 'assistant', content: '', toolCalls: [call] });
    await store.saveMessage(sessionId, { role: 'tool', toolCallId: 't1', content: 'ok' });
    const input = String((await summarize(sessionId)).messages.at(-1)?.content);
    expect(input.includes('当前任务列表状态：\n{"todoList":[]}')).toBe(expected);
  });
});
