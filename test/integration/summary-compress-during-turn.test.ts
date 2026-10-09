import { afterEach, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 全量压缩期间她照常回了一轮：这一轮在切分点之后，落定后仍是活跃历史；下一轮的上下文是摘要，
// 接着压缩期间的这一轮与新的提问，压掉的提问不再出现。
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-ctx-session';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

it('压缩期间到达的一轮落定后仍是活跃的，下一轮的上下文里接在摘要后面', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const recorder: ChatModelRequest[] = [];
  let replies = 0;
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(
    createMockLLMPlugin({
      contextLength: 100_000,
      recorder,
      responses: request => ({ content: request.purpose === '摘要' ? 'SUMMARY-OF-OLD' : `回答${++replies}` }),
      hold: request => (request.purpose === '摘要' ? gate : undefined),
    }),
  );
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test bot' });
  await app.plugin(memorySummary);
  await app.plugins.idle();
  for (const plugin of [agentPlugin, memorySummary]) expect(app.plugins.getPlugin(plugin.name)?.state).toBe('active');
  const host = app.bind({ agent, compression, memory });
  const ask = (content: string) =>
    host.agent
      .require()
      .handleMessage({ content, sessionId: SESSION, platform: 'test', userId: 'u1', sessionType: 'private' });

  await ask('压缩之前的提问');
  const compressing = host.compression.require().compress(SESSION, { reason: 'manual' });
  await vi.waitFor(() => expect(recorder.some(r => r.purpose === '摘要')).toBe(true));
  await ask('压缩期间的提问');
  release();
  await compressing;

  const active = (await host.memory.require().getHistory(SESSION, Infinity)).map(m => String(m.content));
  expect(active.some(text => text.includes('压缩期间的提问'))).toBe(true);
  expect(active).toContain('回答2');
  expect(active).toContain('对话已压缩');
  expect(active.some(text => text.includes('压缩之前的提问'))).toBe(false);

  await ask('压缩之后的提问');
  const texts = (recorder.at(-1)?.messages ?? []).map(m => String(m.content ?? ''));
  const at = (pick: (text: string) => boolean) => texts.findIndex(pick);
  const order = [
    at(text => text.includes('SUMMARY-OF-OLD')),
    at(text => text.includes('压缩期间的提问')),
    at(text => text === '回答2'),
    at(text => text.includes('压缩之后的提问')),
  ];
  expect(
    order.every(index => index >= 0),
    texts.join(' | '),
  ).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(texts.some(text => text.includes('压缩之前的提问'))).toBe(false);
});
