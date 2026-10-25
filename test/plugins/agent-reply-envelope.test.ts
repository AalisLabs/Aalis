import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { type Message, type OutgoingMessage, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// agent 定稿、外发与落库（真 fs 角色卡 + mock LLM + 真 persona 钩子）：
//   1. 上游吐空流：persona 判不合格请求重试，agent 曾因「原始输出为空」直接不进重试循环，
//      回合静默、被 @ 也不回。现在空输出同样重试，只是不回放空的 assistant 消息。
//   2. 落库口径：content 存整串 JSON 信封（存档原文），解码后的可见正文另写进
//      assistant 消息 metadata 的 VisibleContent 键；客户端渲染模式下外发的是整串 JSON，
//      可见正文照样是回复字段。没有信封时不写这个键。交给模型的历史里她的回复取可见正文，
//      不论这一轮的人设有没有结构化输出；token:request 的快照与真实回合同一个读法。
//   3. 外发与落库的分工：外发的回复只带正文与这条回复的模型和 token，思考与时间线只落库
//      （客户端经会话协议拿思考，IM 适配器只发正文）。
//   4. 同一会话连着两轮回同一句话，两句都外发、都落库。
//   5. 回复的正文只剥漏出的协议标记：表格分隔行不改写，落库的时间线与正文同一份净化。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  memoryTokenBudget: 1024,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

const RAW_JSON = '{\n  "mood": "平静",\n  "message": "你好呀"\n}';
const SESSION = 'test:envelope';
/** 一条历史回复：落库的是信封，可见正文另记在元数据里 */
const ENVELOPE_REPLY: Message = {
  role: 'assistant',
  content: JSON.stringify({ mood: '平静', message: '你好呀' }),
  timestamp: 1000,
  metadata: { [WellKnownMetadataKeys.VisibleContent]: '你好呀' },
};
/** 去掉系统消息之后的角色与正文 */
const dialogue = (messages: readonly Message[]) =>
  messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
const FW = '｜';

const fmtCard = (clientSide: boolean): string =>
  [
    'name: zz-fmt',
    'description: 结构化输出人设',
    'prompt: 按 JSON 输出。',
    `clientSideJsonRendering: ${clientSide}`,
    'outputFormat:',
    '  mood:',
    '    description: 心情',
    '  message:',
    '    description: 回复正文',
    '    reply: true',
    '',
  ].join('\n');

const plainCard = 'name: zz-plain\ndescription: 纯文本人设\nprompt: 正常说话。\n';

/** 各用例用的卡：boot 把选中的那张写成主卡 default.yaml */
const CARDS: Record<string, string> = {
  'zz-fmt': fmtCard(false),
  'zz-client': fmtCard(true).replace('name: zz-fmt', 'name: zz-client'),
  'zz-plain': plainCard,
};

describe('agent 定稿：空流重试与可见正文落库（outputFormat 人设）', () => {
  let base: string;
  let app: App;

  const boot = async (card: string, responses: ChatResponse[]) => {
    writeFileSync(join(base, 'self', 'personas', 'default.yaml'), CARDS[card]);
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {});
    const recorder: ChatModelRequest[] = [];
    await app.plugin(createMockLLMPlugin({ responses, recorder }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(personaPlugin, { personasDir: 'personas:/' });
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugins.idle();
    // 依赖没凑齐的插件停在 pending 而不报错，会让「钩子根本没跑」伪装成绿
    for (const id of [storageLocalPlugin.name, personaPlugin.name, agentPlugin.name, messageArchivePlugin.name]) {
      const state = app.plugins.getPlugin(id)?.state;
      if (state !== 'active') throw new Error(`插件 ${id} 未激活（state=${state}）`);
    }
    const host = app.bind({ events, agent: agentService, memory, hooks });
    const sent: OutgoingMessage[] = [];
    const archived: Message[] = [];
    host.events.use.on('outbound:message', msg => {
      sent.push(msg);
    });
    host.events.use.on('assistant:message:archived', ({ message }) => {
      archived.push(message);
    });
    const say = () =>
      host.agent.use.handleMessage({
        content: '你好',
        sessionId: SESSION,
        platform: 'test',
        userId: 'u1',
        sessionType: 'private',
      });
    /** token:request 的快照交给 agent:llm:before 的消息 */
    const snapshot = async (): Promise<Message[]> => {
      let seen: Message[] = [];
      const off = host.hooks.use.middleware('agent:llm:before', async (data, next) => {
        if (data.dryRun) seen = [...data.messages];
        await next();
      });
      await host.events.use.emit('token:request', { sessionId: SESSION });
      off();
      return seen;
    };
    return { host, recorder, sent, archived, say, snapshot };
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-reply-envelope-'));
    mkdirSync(join(base, 'self', 'personas'), { recursive: true });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('上游吐空流：按 persona 的要求重试一次，第二次合格即外发', async () => {
    const { recorder, sent, say } = await boot('zz-fmt', [{ content: '' }, { content: RAW_JSON }]);
    await say();

    expect(recorder.length, '空流后应再请求一次').toBe(2);
    expect(sent.map(m => m.content)).toEqual(['你好呀']);
    // 重试请求末尾是系统反馈；没有可回放的失败输出，不追加空的 assistant 消息（首轮无历史，故一条 assistant 都不该有）
    const retry = recorder[1].messages;
    const feedback = retry[retry.length - 1];
    expect(feedback.role).toBe('system');
    expect(String(feedback.content)).toContain('JSON');
    expect(retry.filter(m => m.role === 'assistant')).toEqual([]);
  });

  it('服务端解码：content 落整串 JSON，metadata 带解码后的可见正文', async () => {
    const { archived, say } = await boot('zz-fmt', [{ content: RAW_JSON }]);
    await say();

    expect(archived.length).toBe(1);
    expect(archived[0].content).toBe(JSON.stringify({ mood: '平静', message: '你好呀' }));
    expect(archived[0].metadata?.[WellKnownMetadataKeys.VisibleContent]).toBe('你好呀');
  });

  it('客户端渲染：外发整串 JSON，落库 metadata 的可见正文仍是回复字段', async () => {
    const { sent, archived, say } = await boot('zz-client', [{ content: RAW_JSON }]);
    await say();

    expect(sent[0].content).toContain('"message"');
    expect(archived.length).toBe(1);
    expect(archived[0].metadata?.[WellKnownMetadataKeys.VisibleContent]).toBe('你好呀');
  });

  it('没有信封（纯文本人设）：不写可见正文键', async () => {
    const { archived, say } = await boot('zz-plain', [{ content: '普通回复' }]);
    await say();

    expect(archived.length).toBe(1);
    expect(archived[0].content).toBe('普通回复');
    expect(archived[0].metadata && WellKnownMetadataKeys.VisibleContent in archived[0].metadata).toBe(false);
  });

  it('同一会话连着两轮回同一句话：两句都外发、都落库', async () => {
    const { sent, archived, say } = await boot('zz-plain', [{ content: '好' }]);
    await say();
    await say();

    expect(sent.map(m => m.content)).toEqual(['好', '好']);
    expect(archived.map(m => m.content)).toEqual(['好', '好']);
  });

  it('外发的回复只带正文与这条回复的模型和 token；思考与时间线留在存档里', async () => {
    const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
    const { sent, archived, say } = await boot('zz-plain', [
      { content: '普通回复', reasoningContent: '想一想', usage },
    ]);
    await say();

    const modelInfo = {
      provider: '@aalis/test-fixture-mock-llm',
      model: 'mock-model',
      promptTokens: 12,
      completionTokens: 3,
    };
    expect(sent.map(m => m.content)).toEqual(['普通回复']);
    // 删掉的字段与存档 Message 上保留的同名，grep 分不开，用编译期用例钉住
    // @ts-expect-error 出站消息不带思考
    expect(sent[0].reasoningContent).toBeUndefined();
    // @ts-expect-error 出站消息不带时间线
    expect(sent[0].segments).toBeUndefined();
    expect(sent[0].modelInfo).toStrictEqual(modelInfo);
    // @ts-expect-error modelInfo 没有总数：总数是两项之和
    expect(sent[0].modelInfo?.totalTokens).toBeUndefined();
    // @ts-expect-error modelInfo 没有用时：要用时由时间线条目的时刻算出
    expect(sent[0].modelInfo?.elapsedMs).toBeUndefined();

    expect(archived).toHaveLength(1);
    expect(archived[0].reasoningContent).toBe('想一想');
    expect(archived[0].segments).toEqual([
      { type: 'reasoning_text', content: '想一想' },
      { type: 'text', content: '普通回复' },
    ]);
    expect(archived[0].metadata?.modelInfo).toStrictEqual(modelInfo);
  });

  it.each(['zz-plain', 'zz-fmt'])('%s：交给模型的历史里她的回复是可见正文，快照里同样；存着的消息不动', async card => {
    const { host, recorder, say, snapshot } = await boot(card, [{ content: RAW_JSON }]);
    // 每例存新对象：内存记忆交出的就是存着的对象，交给模型时改在原对象上会改坏存档
    await host.memory.use.saveMessage(SESSION, { role: 'user', content: '早', timestamp: 999 });
    await host.memory.use.saveMessage(SESSION, { ...ENVELOPE_REPLY });

    const snapped = await snapshot();
    await say();

    const pastReply = (messages: readonly Message[]) => messages.find(m => m.timestamp === ENVELOPE_REPLY.timestamp);
    expect(pastReply(recorder[0].messages)?.content).toBe('你好呀');
    expect(pastReply(snapped)?.content).toBe('你好呀');
    const stored = await host.memory.use.getHistory(SESSION, Infinity);
    expect(
      stored.slice(0, 2).map(m => m.content),
      '时间标注与可见正文应换在副本上',
    ).toEqual(['早', ENVELOPE_REPLY.content]);
  });

  it('快照与真实回合同一个读法：用户历史带时间标注，断掉的工具调用不交', async () => {
    const { host, recorder, say, snapshot } = await boot('zz-plain', [{ content: '好' }]);
    // 同年的标注是「月/日 时:分」
    const at = new Date(new Date().getFullYear(), 0, 2, 3, 4).getTime();
    await host.memory.use.saveMessage(SESSION, { role: 'user', content: '早', timestamp: at });
    await host.memory.use.saveMessage(SESSION, {
      role: 'assistant',
      content: '',
      timestamp: at + 1,
      toolCalls: [{ id: 'zz-broken', type: 'function', function: { name: 'zz_probe', arguments: '{}' } }],
    });

    const snapped = await snapshot();
    await say();

    const past = [{ role: 'user', content: '(1/2 03:04) 早' }];
    expect(dialogue(snapped)).toEqual(past);
    expect(dialogue(recorder[0].messages).slice(0, -1)).toEqual(past);
  });

  it('表格分隔行不改写：外发与落库都是模型的原文', async () => {
    const raw = 'A | B\n---\n正文';
    const { sent, archived, say } = await boot('zz-plain', [{ content: raw }]);
    await say();

    expect(sent[0].content).toBe(raw);
    expect(archived[0].content).toBe(raw);
  });

  it('流里漏出的协议标记：落库的正文与时间线都剥掉', async () => {
    const leak = `<${FW}${FW}DSML${FW}${FW}tool_calls><${FW}${FW}DSML${FW}${FW}invoke name="zz">x</${FW}${FW}DSML${FW}${FW}invoke></${FW}${FW}DSML${FW}${FW}tool_calls>`;
    const { archived, say } = await boot('zz-plain', [{ content: `前文${leak}` }]);
    await say();

    expect(archived[0].content).toBe('前文');
    expect(archived[0].segments).toEqual([{ type: 'text', content: '前文' }]);
  });
});
