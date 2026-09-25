import { hooks } from '../../packages/api-hooks/src/index.js';
import { LLMCapabilities, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import { registerHubs } from './hubs.js';

/** 假 LLM：摘要路径只需它能返回一段文本；传了 sink 就记下最后一次摘要请求的正文 */
export function fakeSummaryLLM(sink?: { text: string }): LLMModel {
  return {
    id: 'fake',
    providerId: 'fake',
    contextLength: 8192,
    capabilities: [LLMCapabilities.Chat],
    async chat(req) {
      if (sink) sink.text = req.messages.map(m => String(m.content ?? '')).join('\n');
      return { content: 'SUMMARY-TEXT' };
    },
  };
}

/** 装好 memory-inmemory 与 memory-summary、挂上桩 LLM，返回这次 App 的 memory 与宿主门面 */
export async function setupSummary(config: Record<string, unknown>, model: LLMModel = fakeSummaryLLM()) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, services, hooks, events });
  await app.plugin(memoryInMemory);
  host.provide(llm, model);
  await app.plugin(memorySummary, config);
  await app.plugins.idle();
  // 激活闸：required 依赖（memory / llm）缺席时插件停在 pending 且不报错，
  // 后面的断言会红在无关的细节上、掩盖真实原因，故在此显式点名。
  if (app.plugins.getPlugin('@aalis/plugin-memory-summary')?.state !== 'active')
    throw new Error('plugin-memory-summary 未激活');
  const store = host.services.get(memory);
  if (!store) throw new Error('memory 服务未就绪');
  return { app, host, memory: store };
}
