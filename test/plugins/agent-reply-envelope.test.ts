import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { type Message, type OutgoingMessage, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// outputFormat 人设下 agent 定稿与落库的两件事（真 fs 角色卡 + mock LLM + 真 persona 钩子）：
//   1. 上游吐空流：persona 判不合格请求重试，agent 曾因「原始输出为空」直接不进重试循环，
//      回合静默、被 @ 也不回。现在空输出同样重试，只是不回放空的 assistant 消息。
//   2. 落库口径：content 存整串 JSON 信封（保持 few-shot 格式），解码后的可见正文另写进
//      assistant 消息 metadata 的 VisibleContent 键；客户端渲染模式下外发的是整串 JSON，
//      可见正文照样是回复字段。没有信封时不写这个键。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  historyLimit: 50,
  memoryTokenBudget: 1024,
  maxToolIterations: 5,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

const RAW_JSON = '{\n  "mood": "平静",\n  "message": "你好呀"\n}';

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

describe('agent 定稿：空流重试与可见正文落库（outputFormat 人设）', () => {
  let base: string;
  let app: App;

  const boot = async (personaName: string, responses: ChatResponse[]) => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(storageLocalPlugin, {
      roots: [
        {
          name: 'data',
          path: base,
          label: 'data',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    const recorder: ChatModelRequest[] = [];
    await app.plugin(createMockLLMPlugin({ responses, recorder }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(personaPlugin, { persona: personaName, personasDir: 'data/personas' });
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugins.idle();
    // 依赖没凑齐的插件停在 pending 而不报错，会让「钩子根本没跑」伪装成绿
    for (const id of [storageLocalPlugin.name, personaPlugin.name, agentPlugin.name, messageArchivePlugin.name]) {
      const state = app.plugins.getPlugin(id)?.state;
      if (state !== 'active') throw new Error(`插件 ${id} 未激活（state=${state}）`);
    }
    const host = app.bind({ events, agent: agentService });
    const sent: OutgoingMessage[] = [];
    const archived: Message[] = [];
    host.events.on('outbound:message', msg => {
      sent.push(msg);
    });
    host.events.on('assistant:message:archived', ({ message }) => {
      archived.push(message);
    });
    const say = () =>
      host.agent.require().handleMessage({
        content: '你好',
        sessionId: 'test:envelope',
        platform: 'test',
        userId: 'u1',
        sessionType: 'private',
      });
    return { recorder, sent, archived, say };
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-reply-envelope-'));
    mkdirSync(join(base, 'personas'), { recursive: true });
    writeFileSync(join(base, 'personas', 'zz-fmt.yaml'), fmtCard(false));
    writeFileSync(join(base, 'personas', 'zz-client.yaml'), fmtCard(true).replace('name: zz-fmt', 'name: zz-client'));
    writeFileSync(join(base, 'personas', 'zz-plain.yaml'), plainCard);
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
});
