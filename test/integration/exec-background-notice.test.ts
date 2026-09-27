import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import processLocalPlugin from '../../packages/plugin-process-local/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolSystemPlugin from '../../packages/plugin-tool-system/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage, Message, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 后台命令结束通知进入真实的 agent：真实 plugin-gateway、plugin-agent、plugin-tools、plugin-tool-system、
// plugin-process-local、plugin-storage-local（临时目录）与 message-archive（内存 memory）；LLM 是按请求内容作答的替身，
// 执行守卫放行并记下每次调用的身份。
//   - 进程结束后注入通知、开一轮回复，不中止同会话进行中的回合；
//   - 通知回合交给模型的请求里，除 tool 角色外没有消息含进程输出或命令，输出只经 process_read 进来；
//   - 被 process_kill 终止的进程不发通知；
//   - 通知回合的执行守卫看到的授权身份与起进程那一轮相同。
// 起真实进程，只在 POSIX 跑；不连任何真实服务。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';
const SESSION = 'zz-slice1-bg-webui';
const OUT = 'ZZ-OUT-SENTINEL-5c1e';
const HOLD = 'zz_hold';
const NOTICE_REPLY = 'NOTICE-REPLY 测试结束了';

const text = (m: Message) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));

/** 按请求内容作答的 LLM 替身：记下的是请求那一刻的快照（agent 的工具循环在同一个数组上接着改） */
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

const callTool = (name: string, args: Record<string, unknown>): ChatResponse => ({
  content: null,
  toolCalls: [
    {
      id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

/** 这次请求是不是宿主通知回合：最后一条宿主通知在最后一条 user 消息之后 */
function currentNotice(request: ChatModelRequest): string | undefined {
  const msgs = request.messages;
  const lastUser = msgs.findLastIndex(m => m.role === 'user');
  const lastNotice = msgs.findLastIndex(m => m.role === 'system' && text(m).startsWith('[宿主通知]'));
  return lastNotice > lastUser ? text(msgs[lastNotice]) : undefined;
}

const lastUserText = (request: ChatModelRequest) => {
  const user = request.messages.findLast(m => m.role === 'user');
  return user ? text(user) : '';
};

const probe = (target: number): string | undefined => {
  try {
    process.kill(target, 0);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
};

async function waitFor(pred: () => boolean, label: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`等不到：${label}`);
}

let base: string;
const apps: App[] = [];
const pids: number[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'zz-slice1-bgint-')));
  // storage-local 的内部根按 cwd 解析，指到临时目录，不在工作树里建目录
  vi.spyOn(process, 'cwd').mockReturnValue(base);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const pid of pids.splice(0)) {
    if (probe(-pid) !== undefined) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

interface GuardCall {
  name: string;
  platform: string;
  userId?: string;
  actor?: { platform: string; userId: string };
}

async function boot(decide: (request: ChatModelRequest) => ChatResponse) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const model = new ScriptedLLM(decide);
  const host = app.bind({ provide, events, hooks, gateway, tools });
  host.provide(sessionManager, {
    resolveConfig: () => ({ enabledToolGroups: ['system'] }),
    getSession: () => undefined,
  } as unknown as SessionManagerService);
  await app.plugin(
    definePlugin({
      name: model.providerId,
      provides: [llm],
      uses: { provide },
      apply: ({ provide }) => void provide(llm, model, { entryId: `${model.providerId}/${model.id}` }),
    }),
  );
  await app.plugin(storageLocalPlugin, {
    roots: [
      {
        name: 'workspace',
        path: base,
        kind: 'workspace',
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      },
    ],
  });
  await app.plugin(processLocalPlugin);
  await app.plugin(toolsPlugin, {});
  await app.plugin(toolSystemPlugin, {
    file: { enabled: false },
    system: { enabled: false },
    http: { enabled: false },
  });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin, {});
  await app.plugin(agentPlugin, { systemPrompt: 'test', maxToolIterations: 5 });
  await app.plugins.idle();
  for (const p of [
    storageLocalPlugin,
    processLocalPlugin,
    toolsPlugin,
    toolSystemPlugin,
    messageArchivePlugin,
    gatewayPlugin,
    agentPlugin,
  ]) {
    expect(app.plugins.getPlugin(p.name)?.state, `${p.name} 未激活`).toBe('active');
  }

  const guardCalls: GuardCall[] = [];
  const toolService = host.tools.require();
  toolService.setExecutionGuard(async req => {
    guardCalls.push({ name: req.name, platform: req.platform, userId: req.userId, actor: req.actor });
    return null;
  });

  // 会卡住的工具：用来让一个真人回合在进程结束时仍在进行
  const held: ToolCallContext[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  host.tools.register({
    definition: {
      type: 'function',
      function: { name: HOLD, description: '卡住', parameters: { type: 'object', properties: {} } },
    },
    handler: async (_args, ctx) => {
      held.push(ctx);
      await gate;
      return 'held';
    },
  });

  const turns: Array<{ source?: string; outcome: string }> = [];
  host.hooks.middleware('agent:turn:after', async (data, next) => {
    turns.push({ source: data.message.source, outcome: data.outcome });
    await next();
  });
  const notices: IncomingMessage[] = [];
  host.events.on('inbound:message', message => {
    if (message.hostNotice) notices.push(message);
  });
  host.events.on('tool:execute', info => {
    if (info.toolName !== 'exec_background' || info.phase !== 'end' || !info.result) return;
    const pid = (JSON.parse(info.result) as { pid?: number }).pid;
    if (typeof pid === 'number' && pid > 1) pids.push(pid);
  });
  const outbound: OutgoingMessage[] = [];
  host.events.on('outbound:message', message => void outbound.push(message));
  await app.start();

  return {
    model,
    guardCalls,
    held,
    release,
    turns,
    notices,
    outbound,
    say(content: string, extra: Partial<IncomingMessage> = {}): Promise<void> {
      return host.gateway.require().ingressMessage({
        content,
        sessionId: SESSION,
        platform: 'webui',
        userId: 'console',
        ...extra,
      });
    },
  };
}

const noticeTurns = (turns: Array<{ source?: string; outcome: string }>) =>
  turns.filter(t => t.source?.startsWith('exec-bg:'));

/** 起进程、卡住、读输出、收尾的通用脚本 */
function script(command: string) {
  return (request: ChatModelRequest): ChatResponse => {
    const last = request.messages.at(-1);
    const notice = currentNotice(request);
    if (notice) {
      if (last?.role === 'tool') return { content: NOTICE_REPLY };
      const id = notice.match(/proc_[0-9a-f]{6}_\d+/)?.[0];
      return callTool('process_read', { processId: id });
    }
    const said = lastUserText(request);
    if (last?.role === 'tool') return { content: `好（${said}）` };
    if (said.includes('start')) return callTool('exec_background', { command });
    if (said.includes('hold')) return callTool(HOLD, {});
    const kill = said.match(/kill (proc_[0-9a-f]{6}_\d+)/);
    if (kill) return callTool('process_kill', { processId: kill[1] });
    return { content: '好' };
  };
}

describe.skipIf(!posix)('后台命令结束通知进入 agent', () => {
  it('进程结束后注入通知、开一轮回复，不中止同会话进行中的回合；输出只经 process_read 以 tool 角色进来', async () => {
    const marker = join(base, 'zz-slice1-go');
    const command = `while [ ! -f '${marker}' ]; do sleep 0.05; done; echo ${OUT}; exit 3`;
    const h = await boot(script(command));

    await h.say('start');
    expect(h.guardCalls.map(c => c.name)).toContain('exec_background');

    // 第二个真人回合卡在工具上，此时放行进程
    const holding = h.say('hold');
    await waitFor(() => h.held.length === 1, '真人回合卡在工具上');
    writeFileSync(marker, '');
    await waitFor(() => noticeTurns(h.turns).length === 1, '通知回合结束');

    expect(noticeTurns(h.turns)).toEqual([{ source: expect.stringMatching(/^exec-bg:proc_/), outcome: 'replied' }]);
    expect(h.held[0].signal?.aborted, '通知不应中止进行中的真人回合').toBe(false);
    expect(h.outbound.some(m => m.sessionId === SESSION && m.content.includes(NOTICE_REPLY))).toBe(true);

    // 通知回合的请求：第一次只有宿主正文（含退出码），输出与命令都不在任何非 tool 消息里；输出出现在 process_read 的 tool 结果里
    const noticeRequests = h.model.requests.filter(r => currentNotice(r));
    expect(noticeRequests.length).toBe(2);
    expect(currentNotice(noticeRequests[0])).toContain('退出码 3');
    for (const request of noticeRequests) {
      for (const m of request.messages.filter(m => m.role !== 'tool')) {
        expect(text(m), `${m.role} 消息不应含进程输出`).not.toContain(OUT);
        if (m.role === 'system') expect(text(m), 'system 消息不应含命令').not.toContain(marker);
      }
    }
    const toolResults = noticeRequests[1].messages.filter(m => m.role === 'tool').map(text);
    expect(toolResults.some(t => t.includes(OUT))).toBe(true);

    h.release();
    await holding;
    expect(h.turns.filter(t => t.source === undefined).map(t => t.outcome)).toEqual(['replied', 'replied']);
  });

  it('通知回合的执行守卫看到的授权身份与起进程那一轮相同（owner 的 WebUI 回合、定时任务回合）', async () => {
    const h = await boot(script('exit 1'));
    await h.say('start');
    await waitFor(() => noticeTurns(h.turns).length === 1, '通知回合结束');
    await h.say('start', { source: 'scheduler', userId: undefined, actor: { platform: 'webui', userId: 'console' } });
    await waitFor(() => noticeTurns(h.turns).length === 2, '第二个通知回合结束');

    const effective = (c: GuardCall) => c.actor ?? { platform: c.platform, userId: c.userId };
    const starts = h.guardCalls.filter(c => c.name === 'exec_background');
    const reads = h.guardCalls.filter(c => c.name === 'process_read');
    expect(starts).toHaveLength(2);
    expect(reads).toHaveLength(2);
    // owner 的 WebUI 回合：确认由 console 应答，授权身份同为 webui/console
    expect(reads[0]).toMatchObject({ platform: 'webui', userId: 'console' });
    expect(effective(reads[0])).toEqual(effective(starts[0]));
    // 定时任务回合：没有 userId，授权身份是创建者
    expect(starts[1]).toMatchObject({ userId: undefined, actor: { platform: 'webui', userId: 'console' } });
    expect(reads[1]).toMatchObject({
      platform: 'webui',
      userId: undefined,
      actor: { platform: 'webui', userId: 'console' },
    });
    expect(h.notices.map(n => n.actor)).toEqual([
      { platform: 'webui', userId: 'console' },
      { platform: 'webui', userId: 'console' },
    ]);
  });

  it('被 process_kill 终止的进程不发通知', async () => {
    const h = await boot(script('sleep 30'));
    await h.say('start');
    await waitFor(() => pids.length === 1, '记下进程组');
    const listed = h.model.requests
      .flatMap(r => r.messages)
      .filter(m => m.role === 'tool')
      .map(text)
      .find(t => t.includes('processId'));
    const id = listed?.match(/proc_[0-9a-f]{6}_\d+/)?.[0];
    expect(id, '工具结果里应有进程 id').toBeDefined();
    await h.say(`kill ${id}`);
    expect(h.guardCalls.map(c => c.name)).toContain('process_kill');
    expect(probe(-pids[0])).toBe('ESRCH');
    await new Promise(r => setTimeout(r, 1000));
    expect(h.notices).toEqual([]);
    expect(noticeTurns(h.turns)).toEqual([]);
  });
});
