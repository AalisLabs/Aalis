import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import {
  type ChatModelRequest,
  type ChatResponse,
  type ChatStreamChunk,
  LLMCapabilities,
  type LLMModel,
  llm,
} from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { remoteAgent } from '../../packages/api-remote-agent/src/index.js';
import {
  type SessionConfig,
  type SessionInfo,
  type SessionManagerService,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import paperPlugin from '../../packages/plugin-paper/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage, Message, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { LEDGER_URI, memoryStorage, type PaperFiles, sessionInfoOf } from '../fixtures/paper.js';
import { PNG, ScriptedRemote } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 白纸完成通知进入真实的 agent（U10c 集成）：真实 plugin-gateway、plugin-agent、plugin-tools、
// message-archive（内存 memory）、plugin-paper；远端是 ScriptedRemote，LLM 是按请求内容作答的替身。
//
// - 每件任务的通知用各自的 source，各占一条 lane：第二条通知进来时，第一条通知那一轮（卡在 paper_send
//   的发送上）不被中止，两轮都完成各自的 paper_send；
// - 通知回合调 paper_task 被拒（source 非空）；远端说明只在通知那一轮出现，之后的真人回合看不到；
// - 禁言吞掉通知之后，下一个真人回合仍看得到待交付提示，paper_send 之后提示消失；
// - 通知不进向量库。
// 不连任何真实服务。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const PAPER = 'zz-paper';
const PAPER_ID = `n:${PAPER}`;
const REMOTE = 'zz-remote-a';
const NOTE_SENTINEL = 'REMOTE-NOTE-SENTINEL-4d2b';
const HINT_MARK = '还没发回本群';

const ROOM_CONFIG: SessionConfig = {
  paperEnabled: true,
  paperName: PAPER,
  remoteAgentTypes: [REMOTE],
  remoteAgentRoomDailyCents: 100_000,
  enabledToolGroups: ['paper'],
};
const PAPER_CONFIG = {
  globalDailyCents: 100_000,
  papers: [{ name: PAPER, remoteAgentType: REMOTE, remoteAgentEgress: 'allowlist' }],
};

const text = (m: Message) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));

/**
 * 按请求内容作答的 LLM 替身：decide 看这次请求的消息决定回文字还是调工具。记下的是请求那一刻的快照：
 * agent 的工具循环在同一个消息数组上接着改（追加工具结果、摘掉上一次的提示），直接留引用会看到之后的状态
 */
class ScriptedLLM implements LLMModel {
  readonly id = 'scripted-model';
  readonly providerId = '@aalis/test-fixture-scripted-llm';
  readonly contextLength = 32_768;
  readonly maxOutputTokens = 1024;
  readonly capabilities = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling, LLMCapabilities.Streaming];
  readonly requests: ChatModelRequest[] = [];

  constructor(private readonly decide: (request: ChatModelRequest) => ChatResponse) {}

  async chat(request: ChatModelRequest): Promise<ChatResponse> {
    return this.decide(this.#record(request));
  }

  async *chatStream(request: ChatModelRequest): AsyncIterable<ChatStreamChunk> {
    const response = this.decide(this.#record(request));
    if (response.content) yield { contentDelta: response.content };
    yield { done: true, ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}) };
  }

  #record(request: ChatModelRequest): ChatModelRequest {
    const snapshot = { ...request, messages: structuredClone(request.messages) };
    this.requests.push(snapshot);
    return snapshot;
  }
}

const callTool = (name: string, args: Record<string, unknown>, id = `call-${name}`): ChatResponse => ({
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

/** 这次请求是不是宿主通知回合：最后一条宿主通知在最后一条 user 消息之后 */
function currentNotice(request: ChatModelRequest): string | undefined {
  const msgs = request.messages;
  const lastUser = msgs.findLastIndex(m => m.role === 'user');
  const lastNotice = msgs.findLastIndex(m => m.role === 'system' && text(m).startsWith('[宿主通知]'));
  return lastNotice > lastUser ? text(msgs[lastNotice]) : undefined;
}

const artifactIn = (s: string | undefined) => s?.match(/a-[0-9a-f]{8}/)?.[0];

interface Turn {
  source?: string;
  outcome: string;
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function waitFor(pred: () => boolean, label: string, steps = 600): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (pred()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等不到：${label}`);
}

async function boot(
  decide: (request: ChatModelRequest) => ChatResponse,
  opts: { flow?: boolean; vector?: boolean } = {},
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const files: PaperFiles = new Map();
  const remote = new ScriptedRemote();
  const model = new ScriptedLLM(decide);
  const host = app.bind({ provide, events, hooks, agent, memory, gateway, flowControl, tools });

  host.provide(sessionManager, {
    resolveConfig: (sessionId: string) => (sessionId === ROOM ? { ...ROOM_CONFIG } : {}),
    getSession: (id: string): SessionInfo => sessionInfoOf(id),
  } as unknown as SessionManagerService);
  host.provide(storage, memoryStorage(files));
  const indexed: Array<Record<string, unknown>> = [];
  if (opts.vector) {
    host.provide(embedding, { embed: async () => [0.1, 0.2, 0.3] });
    host.provide(vectorstore, {
      async add(_v: number[], metadata: Record<string, unknown>) {
        indexed.push(metadata);
      },
      search: async () => [],
      size: async () => indexed.length,
      clear: async () => {},
      save: async () => {},
    });
  }

  await app.plugin(
    definePlugin({
      name: REMOTE,
      provides: [remoteAgent],
      uses: { provide },
      apply: ({ provide }) => void provide(remoteAgent, remote),
    }),
  );
  await app.plugin(
    definePlugin({
      name: model.providerId,
      provides: [llm],
      uses: { provide },
      apply: ({ provide }) => void provide(llm, model, { entryId: `${model.providerId}/${model.id}` }),
    }),
  );
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin, {});
  if (opts.flow) await app.plugin(flowControlPlugin, {});
  if (opts.vector) {
    await app.plugin(memoryVector, {
      search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
      indexing: { concurrency: 1, maxQueueSize: 50 },
      crossSessionMode: 'all',
      recallRoles: 'all',
    });
  }
  await app.plugin(agentPlugin, { systemPrompt: 'persona', maxToolIterations: 5 });
  await app.plugin(paperPlugin, PAPER_CONFIG);
  await app.plugins.idle();
  const names = [agentPlugin, gatewayPlugin, toolsPlugin, messageArchivePlugin, paperPlugin].map(p => p.name);
  if (opts.flow) names.push(flowControlPlugin.name);
  if (opts.vector) names.push(memoryVector.name);
  for (const name of names) expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');

  const turns: Turn[] = [];
  host.hooks.middleware('agent:turn:after', async (data, next) => {
    turns.push({ source: data.message.source, outcome: data.outcome });
    await next();
  });
  const outbound: OutgoingMessage[] = [];
  host.events.on('outbound:message', message => void outbound.push(message));
  await app.start();

  const ledger = () => JSON.parse(String(files.get(LEDGER_URI) ?? 'null')) as PaperLedger;
  return {
    app,
    host,
    remote,
    model,
    turns,
    outbound,
    indexed,
    ledger,
    /** 真人在房间里当面交一件任务（直接调工具，与她在真人回合里调用同一判据） */
    async accept(name: string): Promise<string> {
      const res = await host.tools
        .require()
        .execute(
          'paper_task',
          { text: `${name}的原文`, name },
          { sessionId: ROOM, platform: 'onebot', userId: '30001', inbound: {}, enabledGroups: ['paper'] },
        );
      const parsed = JSON.parse(res.content) as { ok: boolean; taskId?: string; error?: string };
      if (!parsed.ok) throw new Error(`paper_task 未受理：${parsed.error}`);
      return String(parsed.taskId);
    },
    async running(taskId: string): Promise<string> {
      await waitFor(() => ledger()?.tasks[taskId]?.state === 'running', `${taskId} 开轮`);
      return ledger().tasks[taskId].runId ?? '';
    },
    /** 真人在房间里说一句（走网关，等这一轮结束） */
    say(content: string): Promise<void> {
      const message: IncomingMessage = {
        content,
        sessionId: ROOM,
        platform: 'onebot',
        sessionType: 'group',
        userId: '30001',
        nickname: '群友',
        triggerType: 'immediate',
      };
      return host.gateway.require().ingressMessage(message);
    },
  };
}

const noticeTurns = (turns: Turn[]) => turns.filter(t => t.source?.startsWith('paper:'));

describe('白纸通知进入 agent', () => {
  it('每件任务的通知各占一条 lane：第二条通知进来时，第一轮（卡在 paper_send）不被中止，两轮都发出各自的成品', async () => {
    const h = await boot(request => {
      if (request.messages.at(-1)?.role === 'tool') return { content: '发好了' };
      const artifact = artifactIn(currentNotice(request));
      if (artifact) return callTool('paper_send', { artifact_id: artifact }, `call-${artifact}`);
      return { content: '好' };
    });
    // 带附件的出站卡住，直到两条都卡上再一起放行：第一轮的 paper_send 因此在第二条通知进来时仍未返回
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let held = 0;
    h.host.hooks.middleware('outbound:dispatch', async (data, next) => {
      if (data.message.attachments?.length) {
        held++;
        await gate;
      }
      await next();
    });

    const t1 = await h.accept('任务一');
    const t2 = await h.accept('任务二');
    h.remote.outputs.set(t1, [{ rel: 'one.png', data: PNG }]);
    h.remote.outputs.set(t2, [{ rel: 'two.png', data: PNG }]);
    h.remote.finish(await h.running(t1));
    await waitFor(() => held === 1, '第一轮卡在 paper_send');
    h.remote.finish(await h.running(t2));
    await waitFor(() => held === 2, '第二轮卡在 paper_send');
    release();
    await waitFor(() => noticeTurns(h.turns).length === 2, '两轮通知回合结束');

    expect(noticeTurns(h.turns)).toEqual([
      { source: `paper:${PAPER_ID}:${t1}`, outcome: 'replied' },
      { source: `paper:${PAPER_ID}:${t2}`, outcome: 'replied' },
    ]);
    const sent = h.outbound.flatMap(m => m.attachments ?? []).map(a => a.data);
    expect(sent).toHaveLength(2);
    expect(sent.some(d => d.includes(`/tasks/${t1}/out/`))).toBe(true);
    expect(sent.some(d => d.includes(`/tasks/${t2}/out/`))).toBe(true);
    await waitFor(() => h.ledger().tasks[t2].delivered, '第二件标为已交付');
    expect(h.ledger().tasks[t1].delivered).toBe(true);
  });

  it('通知回合里调 paper_task 被拒；之后的真人回合看得到通知正文，看不到远端说明', async () => {
    const results: string[] = [];
    const h = await boot(request => {
      const last = request.messages.at(-1);
      if (last?.role === 'tool') {
        results.push(text(last));
        return { content: '收到' };
      }
      if (currentNotice(request)) return callTool('paper_task', { text: '再做一个', name: '再来' });
      return { content: '好' };
    });
    const t1 = await h.accept('任务一');
    h.remote.finish(await h.running(t1), 'finished', `${NOTE_SENTINEL} 做好了`);
    await waitFor(() => noticeTurns(h.turns).length === 1, '通知回合结束');

    // 通知那一轮看得到远端说明（不可信框内）
    const noticeRequest = h.model.requests[0];
    expect(currentNotice(noticeRequest)).toContain(NOTE_SENTINEL);
    expect(results).toHaveLength(1);
    const refused = JSON.parse(results[0]) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`paper:${PAPER_ID}:${t1}`);
    expect(Object.keys(h.ledger().tasks)).toEqual([t1]);

    await h.say('做好了吗');
    const next = JSON.stringify(h.model.requests.at(-1)?.messages);
    expect(next).toContain(t1);
    expect(next).not.toContain(NOTE_SENTINEL);
  });

  it('禁言吞掉通知之后，下一个真人回合仍看得到待交付提示；paper_send 之后提示消失', async () => {
    const h = await boot(
      request => {
        if (request.messages.at(-1)?.role === 'tool') return { content: '发好了' };
        const hint = request.messages.find(m => m.role === 'system' && text(m).includes(HINT_MARK));
        const artifact = artifactIn(hint && text(hint));
        if (artifact) return callTool('paper_send', { artifact_id: artifact });
        return { content: '好' };
      },
      { flow: true },
    );
    const flow = h.host.flowControl.require();
    const t1 = await h.accept('任务一');
    h.remote.outputs.set(t1, [{ rel: 'one.png', data: PNG }]);
    flow.setMuted(ROOM, 600, 'onebot');
    h.remote.finish(await h.running(t1));
    await waitFor(() => h.ledger().tasks[t1].notice !== undefined, '通知已注入');
    const history = async () => (await h.host.memory.require().getHistory(ROOM, 50)) as Message[];
    const archivedNotice = async () => (await history()).some(m => m.kind === 'host-notice');
    for (let i = 0; i < 200 && !(await archivedNotice()); i++) await new Promise(r => setTimeout(r, 5));
    expect(await archivedNotice(), '禁言期的通知影子归档为 notice').toBe(true);
    expect(h.model.requests).toEqual([]);

    flow.setMuted(ROOM, 0);
    await h.say('做好了吗');
    const [first, second] = h.model.requests;
    const hint = first.messages.find(m => m.role === 'system' && text(m).includes(HINT_MARK));
    expect(hint, '真人回合里有待交付提示').toBeDefined();
    expect(first.messages.indexOf(hint as Message)).toBeGreaterThan(0);
    expect(text(hint as Message)).toContain(t1);
    expect(second.messages.at(-1)?.role).toBe('tool');
    expect(JSON.stringify(second.messages)).not.toContain(HINT_MARK);
    expect(h.outbound.flatMap(m => m.attachments ?? [])).toHaveLength(1);
    expect(h.ledger().tasks[t1].delivered).toBe(true);

    await h.say('谢谢');
    expect(JSON.stringify(h.model.requests.at(-1)?.messages)).not.toContain(HINT_MARK);
  });

  it('回归：通知不进向量库', async () => {
    const h = await boot(() => ({ content: '好' }), { vector: true });
    const t1 = await h.accept('任务一');
    h.remote.finish(await h.running(t1), 'finished', NOTE_SENTINEL);
    await waitFor(() => noticeTurns(h.turns).length === 1, '通知回合结束');
    await h.say('VECTOR-PROBE 做好了吗');
    await waitFor(() => h.indexed.some(m => String(m.content).includes('VECTOR-PROBE')), '真人消息入向量库');
    const contents = h.indexed.map(m => String(m.content));
    expect(contents.some(c => c.includes('[白纸]') || c.includes(t1))).toBe(false);
    expect(contents.some(c => c.includes(NOTE_SENTINEL))).toBe(false);
  });
});
