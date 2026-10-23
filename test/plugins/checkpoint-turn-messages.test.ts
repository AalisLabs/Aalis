import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import {
  type IncomingMessage,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 连对话回滚按回合认消息：一轮提交时只记时间窗里属于这一轮的消息，即元数据的回合 id 是这一轮的（输入、工具调用组、回复、
// 带回合 id 的出站记录与投递失败记录，经工具发出的照写方的写法同时带回合 id 与调用 id）。这一轮进行期间同一会话另一来源
// 的输入与它那一轮的回复不记进这一轮，回滚时不删（以前按时间窗全删）。
// ════════════════════════════════════════════════════════════

const PROBE = 'zz_probe';
const SESSION = 'test:checkpoint-turn';
const callProbe: ChatResponse = {
  content: null,
  toolCalls: [{ id: 'call-1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
};

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 让相邻两次落库的时间戳不同：回滚按时间戳删，同一毫秒的会一起删 */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

const lastUser = (request: ChatModelRequest) => [...request.messages].reverse().find(m => m.role === 'user')?.content;

describe('连对话回滚只删这一轮的消息', () => {
  it('这一轮的输入、工具调用组、回复与带它回合 id 的记录删掉；期间另一来源的输入与它那一轮留着', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aalis-cp-turn-'));
    dirs.push(base);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {});
    await app.plugin(checkpointPlugin, { rootDir: 'data:/checkpoints', coverage: 'all', keepSessions: 0 });
    await app.plugin(
      createMockLLMPlugin({
        responses: request =>
          request.messages.some(m => m.role === 'tool')
            ? { content: '<A 的回复>' }
            : String(lastUser(request)).includes('<A>')
              ? callProbe
              : { content: '<B 的回复>' },
      }),
    );
    await app.plugin(toolsPlugin, {});
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    for (const name of [checkpointPlugin.name, agentPlugin.name, toolsPlugin.name]) {
      expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
    }
    const host = app.bind({ agent: agentService, tools, hooks, memory, messageArchive, checkpoint });
    const message = (content: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
      content,
      sessionId: SESSION,
      platform: 'test',
      userId: 'u1',
      ...extra,
    });

    let turnA: string | undefined;
    host.tools.use.register({
      definition: {
        type: 'function',
        function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async (_args, ctx: ToolCallContext) => {
        turnA = ctx.turnId;
        const archive = host.messageArchive.use;
        await tick();
        // 经工具发出的附件没送达：平台适配器记一条投递失败记录，带出站消息的回合 id 与调用 id
        await archive.saveMessage(SESSION, {
          role: 'system',
          kind: WellKnownKinds.OutboundDeliveryFailed,
          content: '<投递失败>',
          timestamp: Date.now(),
          metadata: { [WellKnownMetadataKeys.TurnId]: ctx.turnId, [WellKnownMetadataKeys.CallId]: ctx.callId },
        });
        await tick();
        // 这一轮进行期间，同一会话另一来源的输入开了自己的一轮
        await host.agent.use.handleMessage(message('<B>', { source: 'scheduler', userId: undefined }));
        await tick();
        // 带这一轮回合 id 的出站记录
        await archive.saveMessage(SESSION, {
          role: 'assistant',
          kind: 'outbound-image',
          content: '<发出的图>',
          timestamp: Date.now(),
          metadata: { [WellKnownMetadataKeys.TurnId]: ctx.turnId },
        });
        await tick();
        return 'ok';
      },
    });

    await host.agent.use.handleMessage(message('<A>'));
    const contents = async () => (await host.memory.use.getHistory(SESSION, 50)).map(m => m.content);
    expect(await contents()).toEqual([
      expect.stringContaining('<A>'),
      '<投递失败>',
      expect.stringContaining('<B>'),
      '<B 的回复>',
      '<发出的图>',
      '',
      'ok',
      '<A 的回复>',
    ]);

    const result = await host.checkpoint.use.rollbackWithChat(SESSION, turnA as string);
    expect(result.chatDeleted).toBe(true);
    expect(await contents()).toEqual([expect.stringContaining('<B>'), '<B 的回复>']);
  });
});
