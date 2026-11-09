import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, lifecycle, optional, provide } from '../../packages/core/src/index.js';
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
// 带回合 id 的出站记录与投递失败记录，经工具发出的照写方的写法同时带回合 id 与调用 id）。这一轮进行期间同一会话里别人的
// 消息（被触发判定或流控吞掉、影子归档的，不带回合 id）不记进这一轮，回滚时不删（以前按时间窗全删）。
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

describe('连对话回滚只删这一轮的消息', () => {
  it('这一轮的输入、工具调用组、回复与带它回合 id 的记录删掉；期间别人的消息留着', async () => {
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
        responses: request => (request.messages.some(m => m.role === 'tool') ? { content: '<A 的回复>' } : callProbe),
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
        // 这一轮进行期间，同一会话里别人的一句被触发判定吞掉、影子归档
        await archive.archiveIncoming(message('<B>', { userId: 'u2' }));
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
      '<发出的图>',
      '',
      'ok',
      '<A 的回复>',
    ]);

    const result = await host.checkpoint.use.rollbackWithChat(SESSION, turnA as string);
    expect(result.chatDeleted).toBe(true);
    expect(await contents()).toEqual([expect.stringContaining('<B>')]);
  });

  it('没有回复的一轮的回合记录（只带记录的事件标记）随这一轮一起删', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aalis-cp-turn-'));
    dirs.push(base);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {});
    await app.plugin(checkpointPlugin, { rootDir: 'data:/checkpoints', coverage: 'all', keepSessions: 0 });
    await app.plugin(createMockLLMPlugin({ responses: [{ content: '' }] }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    const host = app.bind({ agent: agentService, hooks, memory, checkpoint });
    let turnId: string | undefined;
    host.hooks.use.middleware('agent:turn:before', async (data, next) => {
      turnId = data.turnId;
      await next();
    });

    await host.agent.use.handleMessage({ content: '<不用回>', sessionId: SESSION, platform: 'test', userId: 'u1' });
    const records = async () =>
      (await host.memory.use.getHistory(SESSION, 50)).flatMap(m => {
        const record = m.metadata?.turnRecord;
        return record === undefined ? [] : [[m.kind, m.metadata?.[WellKnownMetadataKeys.TurnId], record]];
      });
    expect(await records()).toEqual([[WellKnownKinds.EventMarker, turnId, { outcome: 'silent' }]]);

    await host.checkpoint.use.rollbackWithChat(SESSION, turnId as string);
    expect(await host.memory.use.getHistory(SESSION, 50)).toEqual([]);
  });
});

describe('停机时还在跑的回合', () => {
  // memory 的提供者经 optional 依赖又用到 checkpoint 时两者成环，关停先放行环内的收尾，后登记的 memory 可能先关完、撤下服务，
  // 拆卸时提交这一轮就抓不到它的消息时间戳，连对话回滚删不掉这一轮的消息
  it('memory 提供者与 checkpoint 经 optional 依赖成环且先关：提交照样记下这一轮的消息时间戳', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aalis-cp-turn-'));
    dirs.push(base);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {});
    await app.plugin(checkpointPlugin, { rootDir: 'data:/checkpoints', coverage: 'all', keepSessions: 0 });
    const at = Date.now();
    await app.plugin(
      definePlugin({
        name: 'zz-memory-cycle',
        provides: [memory],
        uses: { provide, checkpoint: optional(checkpoint) },
        apply(caps) {
          caps.provide.use(memory, {
            getMessagesBySessionRange: async () => [
              { role: 'user', content: '<A>', timestamp: at, metadata: { [WellKnownMetadataKeys.TurnId]: 'zz-turn' } },
            ],
          } as never);
        },
      }),
    );
    await app.plugins.idle();
    const input = { message: { content: '<A>', sessionId: SESSION, platform: 'test' } };
    // 默认动作不落定：这一轮停机时还在跑
    void app
      .bind({ hooks })
      .hooks.use.run(
        'agent:turn:before',
        { turnId: 'zz-turn', sessionId: SESSION, inputs: [input] },
        () => new Promise<void>(() => {}),
      );
    await tick();

    await app.stop();
    const manifests = readdirSync(base, { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('manifest.json'));
    expect(manifests, '这一轮没有提交').toHaveLength(1);
    expect(JSON.parse(readFileSync(join(base, manifests[0]), 'utf8')).messageTimestamps).toEqual([at]);
  });

  it('收尾之后、撤回钩子之前才开始的一轮：清理时照样提交', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aalis-cp-turn-'));
    dirs.push(base);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {});
    await app.plugin(checkpointPlugin, { rootDir: 'data:/checkpoints', coverage: 'all', keepSessions: 0 });
    const at = Date.now();
    await app.plugin(
      definePlugin({
        name: 'zz-memory',
        provides: [memory],
        uses: { provide },
        apply(caps) {
          caps.provide.use(memory, {
            getMessagesBySessionRange: async () => [
              { role: 'user', content: '<A>', timestamp: at, metadata: { [WellKnownMetadataKeys.TurnId]: 'zz-late' } },
            ],
          } as never);
        },
      }),
    );
    const host = app.bind({ hooks });
    const input = { message: { content: '<A>', sessionId: SESSION, platform: 'test' } };
    // 与 checkpoint 经 optional 依赖成环且后登记：环内先都收尾，它再先关完，它的清理落在 checkpoint 收尾之后、关闭之前。
    // 清理里开一轮，等这一轮进了 checkpoint 再返回；默认动作不落定，这一轮停机时还在跑
    await app.plugin(
      definePlugin({
        name: 'zz-late-turn',
        provides: [authority],
        uses: { provide, lifecycle, checkpoint: optional(checkpoint) },
        apply(caps) {
          caps.provide.use(authority, {} as never);
          caps.lifecycle.use.onDispose(
            () =>
              new Promise<void>(entered => {
                void host.hooks.use.run(
                  'agent:turn:before',
                  { turnId: 'zz-late', sessionId: SESSION, inputs: [input] },
                  () => {
                    entered();
                    return new Promise<void>(() => {});
                  },
                );
              }),
          );
        },
      }),
    );
    await app.plugins.idle();

    await app.stop();
    const manifests = readdirSync(base, { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('manifest.json'));
    expect(manifests, '这一轮没有提交').toHaveLength(1);
    expect(JSON.parse(readFileSync(join(base, manifests[0]), 'utf8')).messageTimestamps).toEqual([at]);
  });
});
