import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { LLMCapabilities, type LLMModel, llm, metered } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import { scanLLMProcessors } from '../../packages/plugin-media/src/llm-adapter.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummaryPlugin from '../../packages/plugin-memory-summary/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import usageStatsPlugin from '../../packages/plugin-usage-stats/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 对话、子任务、摘要与识图的模型调用都带上用途与会话，经服务商登记的 metered 模型发出 llm:usage，记进用量账本：
// agent 的调用在子会话里标为子任务，摘要由压缩服务、识图由媒体识别带上；调用方由 llm 的绑定接口填
// ════════════════════════════════════════════════════════════

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const USAGE = { promptTokens: 50, completionTokens: 5, totalTokens: 55 };
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 看得懂图的服务商：识图的回应带用量 */
const visionProvider = definePlugin({
  name: 'vision-llm',
  provides: [llm],
  uses: { provide, events },
  apply({ provide, events }) {
    const model: LLMModel = {
      id: 'eyes',
      providerId: 'vision-llm',
      contextLength: 8192,
      capabilities: [LLMCapabilities.Chat, LLMCapabilities.Vision],
      chat: async () => ({ content: '一个像素', usage: USAGE }),
    };
    provide(llm, metered(model, events), { entryId: 'vision-llm/eyes' });
  },
});

const MEDIA_CONFIG = {
  vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
  audio: { mode: 'disabled' },
  video: { mode: 'disabled' },
  animatedImage: { maxFrames: 4 },
  contextHistory: { enabled: false, maxMessages: 0 },
  senderContext: { enabled: false, profileMaxChars: 0 },
} as unknown as MediaConfigResolved;

describe('模型调用的用途与会话', () => {
  it('对话、子任务、摘要、识图都记进账本，带用途、会话与调用方', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aalis-usage-purposes-'));
    homes.push(home);
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    provideHostPaths(app, home);
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(sessionManagerPlugin);
    await app.plugin(createMockLLMPlugin({ responses: () => ({ content: '好的', usage: USAGE }) }));
    await app.plugin(visionProvider);
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugin(memorySummaryPlugin, { keepRecent: 1 });
    await app.plugin(usageStatsPlugin);
    await app.plugins.idle();
    for (const plugin of [agentPlugin, memorySummaryPlugin, usageStatsPlugin, sessionManagerPlugin]) {
      expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
    }
    const host = app.bind({ agent, sessionManager, compression, memory, llm });
    const sm = host.sessionManager.require();
    const owner = await sm.createSession({ name: '我的会话' });
    const child = await sm.createChildSession(owner.id, { name: '子任务', inputContext: '查一下' });
    const message = (sessionId: string): IncomingMessage => ({
      content: '在吗',
      sessionId,
      platform: 'webui',
      userId: 'owner',
      sessionType: 'private',
    });

    await host.agent.require().handleMessage(message(owner.id));
    await host.agent.require().handleMessage(message(child.id));
    for (const content of ['第一条', '第二条', '第三条']) {
      await host.memory.require().saveMessage(owner.id, { role: 'user', content });
    }
    await host.compression.require().compress(owner.id, 'manual');
    const media = new MediaServiceImpl(
      { logger: quiet, llm: host.llm, asr: ref(), sessionManager: ref(), memory: ref() },
      MEDIA_CONFIG,
    );
    for (const processor of scanLLMProcessors({ llm: host.llm, logger: quiet })) media.registerProcessor(processor);
    await media.processMessage({ ...message(owner.id), attachments: [{ kind: 'image', data: PNG_1PX }] });
    await app.stop();

    const lines = readFileSync(join(home, 'state', 'usage', 'llm-calls.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(line => line.purpose !== undefined)
      .map(({ purpose, sessionId, caller, model }) => ({ purpose, sessionId, caller, model }));
    expect(new Set(lines.map(line => JSON.stringify(line)))).toEqual(
      new Set(
        [
          { purpose: '对话', sessionId: owner.id, caller: agentPlugin.name, model: 'mock-model' },
          { purpose: '子任务', sessionId: child.id, caller: agentPlugin.name, model: 'mock-model' },
          { purpose: '摘要', sessionId: owner.id, caller: memorySummaryPlugin.name, model: 'mock-model' },
          { purpose: '识图', sessionId: owner.id, caller: 'root', model: 'eyes' },
        ].map(line => JSON.stringify(line)),
      ),
    );
  });
});
