import { describe, expect, it } from 'vitest';
import type { AgentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { MessageArchiveService } from '../../packages/api-message-archive/src/index.js';
import type { ToolCallContext } from '../../packages/api-tools/src/index.js';
import { useToolService } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as agentModule from '../../packages/plugin-agent/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 工具结果携图（analyze_image 直通分支的原语）在 agent 工具循环里的三条接线：
//   1. images 随本回合的 tool 消息送进下一次 LLM 请求（出口编码由 prepareLLMMessages 负责，
//      mock provider 不走它，故这里看到的是原始 tool 消息）；上一轮工具的图在下一轮前剥掉，不累积；
//   2. agent:tool:after 与工具时间线只看到文本 content（hook/事件契约不变）；
//   3. 落库的 tool 消息不带 images——在 archive.saveMessage 的实参处断言（两个内置后端都白名单
//      落字段，只查 getHistory 会恒真）；
//   4. 调用方声明 acceptsImages: true（能出图的工具据此决定交图还是出文字）。
// ════════════════════════════════════════════════════════════

const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const SESSION = 'test:tool-images';

async function runTurn() {
  const app = new App({ config: { name: 'E2E', logLevel: 'error', plugins: {} } });
  const recorder: ChatModelRequest[] = [];
  const toolCall = (id: string): ChatResponse => ({
    content: null,
    toolCalls: [{ id, type: 'function', function: { name: 'probe_img', arguments: '{}' } }],
  });
  await app.ctx.useModule(
    createMockLLMPlugin({ responses: [toolCall('call-1'), toolCall('call-2'), { content: 'done' }], recorder }),
  );
  await app.ctx.useModule(toolsModule as never, {});
  await app.ctx.useModule(memoryInMemoryModule as never);
  await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
  await app.ctx.useModule(agentModule as never, {
    systemPrompt: 'test',
    historyLimit: 50,
    memoryTokenBudget: 1024,
    maxToolIterations: 5,
    toolResultMaxRatio: 0.15,
    trimThresholdRatio: 1.0,
    preferredModel: '',
  });
  let seenCtx: ToolCallContext | undefined;
  useToolService(app.ctx).register({
    definition: {
      type: 'function',
      function: { name: 'probe_img', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async (_args, callCtx) => {
      seenCtx = callCtx;
      return { content: '{"ok":true}', images: [IMG] };
    },
  });
  const saved: Message[] = [];
  const archive = app.ctx.getService<MessageArchiveService>('message-archive');
  if (!archive) throw new Error('message-archive 未注册');
  const origSave = archive.saveMessage.bind(archive);
  archive.saveMessage = async (sid, msg) => {
    saved.push(msg);
    return origSave(sid, msg);
  };
  let hookResult: string | undefined;
  app.ctx.middleware('agent:tool:after', async (data, next) => {
    hookResult = data.result;
    return next();
  });

  await app.ctx.getService<AgentService>('agent')!.handleMessage({
    content: '看图',
    sessionId: SESSION,
    platform: 'test',
    userId: 'u1',
    sessionType: 'private',
  });
  const memory = app.ctx.getService<MemoryService>('memory');
  const history = memory ? await memory.getHistory(SESSION, 50) : [];
  await app.stop();
  return { recorder, hookResult, history, saved, seenCtx };
}

describe('工具结果携图：agent 工具循环接线', () => {
  it('images 随 tool 消息进入下一次请求且不跨轮累积；hook 只见文本；落库实参不带 images；acceptsImages 已声明', async () => {
    const { recorder, hookResult, history, saved, seenCtx } = await runTurn();
    expect(recorder.length, 'mock LLM 应被调三次：两轮工具调用 + 收尾').toBeGreaterThanOrEqual(3);
    // 第二次请求：call-1 的 tool 消息带图
    const r1 = recorder[1].messages.find(m => m.role === 'tool' && m.toolCallId === 'call-1');
    expect(r1?.content).toBe('{"ok":true}');
    expect(r1?.images).toEqual([IMG]);
    // 第三次请求：上一轮（call-1）的图已剥掉，只有本轮（call-2）带图
    const r2a = recorder[2].messages.find(m => m.role === 'tool' && m.toolCallId === 'call-1');
    const r2b = recorder[2].messages.find(m => m.role === 'tool' && m.toolCallId === 'call-2');
    expect(r2a?.images).toBeUndefined();
    expect(r2b?.images).toEqual([IMG]);

    expect(hookResult).toBe('{"ok":true}');
    expect(seenCtx?.acceptsImages).toBe(true);

    const savedTools = saved.filter(m => m.role === 'tool');
    expect(savedTools.length, 'tool 消息应经 archive.saveMessage 落库').toBeGreaterThanOrEqual(2);
    expect(savedTools.every(m => !('images' in m))).toBe(true);
    expect(history.filter(m => m.role === 'tool').every(m => m.images === undefined)).toBe(true);
  });
});
