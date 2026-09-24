import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// media 缺席时的图片兜底（agent 侧）：
//   出口形态规范化本由 media 的 agent:llm:before 中间件负责（describe 剥离 /
//   passthrough 物化）。media 缺席时 OneBot 落盘的历史相对路径若原样进入
//   message.images，provider 会把它当 base64 校验并拒收整轮请求（400 illegal
//   base64 data，见 test/plugins/media-model-images.test.ts 抬头事故）。
// 契约：
//   - media 在场 → agent 原样透传（media 的缓存键/动图提示按原串命中，不得改形态）
//   - media 缺席 → 仅裸相对路径（已知必炸形态）经 storage 物化为 data URI，
//     译不出的丢弃该图；**其余一切形态原样透传**（维持 media 出现之前的既有行为，
//     改写范围只覆盖已知必炸的那一种）
// ════════════════════════════════════════════════════════════

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;
const REL_REF = 'data/images/onebot_t_group_1/0123456789abcdef.png';
const HTTP_URL = 'https://example.invalid/pic.jpg';

async function loadStack(recorder: ChatModelRequest[], opts: { media?: boolean; storage?: boolean } = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, agent: agentService });
  await app.plugin(createMockLLMPlugin({ responses: [{ content: 'ok' }], recorder }));
  if (opts.storage !== false) {
    const fakeStorage = {
      readFile: async (uri: string) => {
        if (uri !== 'data:/images/onebot_t_group_1/0123456789abcdef.png') throw new Error(`unexpected uri: ${uri}`);
        return PNG_BYTES;
      },
    } as unknown as StorageService;
    host.provide(storage, fakeStorage);
  }
  if (opts.media) {
    host.provide(media, {} as never);
  }
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, {
    systemPrompt: 'test bot',
    historyLimit: 10,
    memoryTokenBudget: 1024,
    maxToolIterations: 3,
    preferredModel: '',
  });
  await app.plugins.idle();
  return { app, agent: host.agent.require() };
}

function incomingWith(images: string[]): IncomingMessage {
  return {
    content: '看图',
    sessionId: 's1',
    platform: 'test',
    userId: 'u1',
    sessionType: 'private',
    attachments: images.map(data => ({ kind: 'image' as const, data })),
  };
}

function lastUserImages(recorder: ChatModelRequest[]): string[] | undefined {
  const req = recorder[recorder.length - 1];
  const userMsgs = req.messages.filter(m => m.role === 'user');
  return userMsgs[userMsgs.length - 1]?.images;
}

describe('media 缺席时的 images 兜底', () => {
  it('media 缺席：相对路径经 storage 物化为 data URI', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder);
    await agent.handleMessage(incomingWith([REL_REF]));
    expect(lastUserImages(recorder), '相对路径应物化为 data URI').toEqual([PNG_DATA_URI]);
  });

  it('media 缺席：data URI 与 http(s) 原样放行，混入的相对路径照常物化', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder);
    await agent.handleMessage(incomingWith([PNG_DATA_URI, HTTP_URL, REL_REF]));
    expect(lastUserImages(recorder)).toEqual([PNG_DATA_URI, HTTP_URL, PNG_DATA_URI]);
  });

  it('media 缺席且 storage 也缺席：相对路径译不出 → 不入 images（绝不透传裸路径）', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder, { storage: false });
    await agent.handleMessage(incomingWith([REL_REF]));
    expect(lastUserImages(recorder), '译不出的串不得进入 images').toBeUndefined();
  });

  it('media 缺席：非相对路径的其它形态原样透传（不做更宽判别，维持既有行为）', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder);
    await agent.handleMessage(incomingWith(['file:///tmp/x.png', REL_REF]));
    expect(lastUserImages(recorder)).toEqual(['file:///tmp/x.png', PNG_DATA_URI]);
  });

  it('media 在场：原样透传，不做任何形态转换（缓存键/动图提示按原串命中）', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder, { media: true });
    await agent.handleMessage(incomingWith([REL_REF]));
    expect(lastUserImages(recorder), 'media 在场时 agent 不得改写 images 形态').toEqual([REL_REF]);
  });
});
