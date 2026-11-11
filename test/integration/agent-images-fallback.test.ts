import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// media 缺席时的图片兜底（agent 侧）：
//   出口形态规范化本由 media 的 agent:llm:before 中间件负责（describe 剥离 /
//   passthrough 物化）。media 缺席时适配器落盘的存储地址若原样进入 message.images，
//   provider 会把它当 base64 或网址处置，整轮请求被拒（见 test/plugins/media-model-images.test.ts 抬头事故）。
// 契约：
//   - media 在场 → agent 原样透传（media 的缓存键/动图提示按原串命中，不得改形态）
//   - media 缺席 → 存储地址经 storage 读成 data URI，读不出的丢弃该图；**其余一切形态原样透传**
//     （维持 media 出现之前的既有行为）；主模型不能看图（acceptsImages 为 false）时当轮的图一张都不交，正文照旧
// ════════════════════════════════════════════════════════════

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;
const STORED = 'data:/images/onebot_t_group_1/onebot/0123456789abcdef.png';
const HTTP_URL = 'https://example.invalid/pic.jpg';

/**
 * `storageRoots` 给出目录时改用真实 storage-local，以它为数据目录：用户根只配 workspace（排第一），data 是内部根（映射到 state/）；
 * 否则按 `storage` 决定是否提供单根假 storage。主模型缺省登记视觉能力，`vision: false` 时不登记
 */
async function loadStack(
  recorder: ChatModelRequest[],
  opts: { media?: boolean; storage?: boolean; storageRoots?: string; vision?: boolean } = {},
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, agent: agentService });
  await app.plugin(createMockLLMPlugin({ responses: [{ content: 'ok' }], recorder, vision: opts.vision ?? true }));
  if (opts.storageRoots !== undefined) {
    const base = opts.storageRoots;
    const root = (name: string) => ({
      name,
      path: join(base, name),
      label: name,
      kind: name,
      browsable: false,
      readable: true,
      writable: true,
      deletable: true,
    });
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, { roots: [root('workspace')] });
  } else if (opts.storage !== false) {
    const fakeStorage = {
      // agent 按根读取，假 storage 须声明自己服务 data 根
      listRoots: () => [
        { name: 'data', kind: 'data', browsable: false, readable: true, writable: false, deletable: false },
      ],
      readFile: async (uri: string) => {
        if (uri !== STORED) throw new Error(`unexpected uri: ${uri}`);
        return PNG_BYTES;
      },
    } as unknown as StorageService;
    host.provide.use(storage, fakeStorage);
  }
  if (opts.media) {
    host.provide.use(media, {} as never);
  }
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, {
    systemPrompt: 'test bot',
    memoryTokenBudget: 1024,
    preferredModel: '',
  });
  await app.plugins.idle();
  return { app, agent: host.agent.use };
}

function incomingWith(images: string[], content = '看图'): IncomingMessage {
  return {
    content,
    sessionId: 's1',
    platform: 'test',
    userId: 'u1',
    sessionType: 'private',
    attachments: images.map(data => ({ kind: 'image' as const, data })),
  };
}

function lastUser(recorder: ChatModelRequest[]) {
  const req = recorder[recorder.length - 1];
  const userMsgs = req.messages.filter(m => m.role === 'user');
  return userMsgs[userMsgs.length - 1];
}

function lastUserImages(recorder: ChatModelRequest[]): string[] | undefined {
  return lastUser(recorder)?.images;
}

describe('media 缺席时的 images 兜底', () => {
  it('media 缺席：存储地址经 storage 读成 data URI', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder);
    await agent.handleMessage(incomingWith([STORED]));
    expect(lastUserImages(recorder), '存储地址应读成 data URI').toEqual([PNG_DATA_URI]);
  });

  it('media 缺席：data URI 与 http(s) 原样放行，混入的存储地址照常读成 data URI', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder);
    await agent.handleMessage(incomingWith([PNG_DATA_URI, HTTP_URL, STORED]));
    expect(lastUserImages(recorder)).toEqual([PNG_DATA_URI, HTTP_URL, PNG_DATA_URI]);
  });

  it('media 缺席且 storage 也缺席：存储地址读不出 → 不入 images（绝不透传存储地址）', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder, { storage: false });
    await agent.handleMessage(incomingWith([STORED]));
    expect(lastUserImages(recorder), '译不出的串不得进入 images').toBeUndefined();
  });

  it('media 缺席：存储地址以外的形态原样透传（维持既有行为）', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder);
    await agent.handleMessage(incomingWith(['file:///tmp/x.png', STORED]));
    expect(lastUserImages(recorder)).toEqual(['file:///tmp/x.png', PNG_DATA_URI]);
  });

  it('media 缺席、主模型不能看图：当轮的图一张都不交，正文里的占位照旧', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder, { vision: false });
    const placeholder = `[图片 | ref:${STORED}]`;
    await agent.handleMessage(incomingWith([STORED, PNG_DATA_URI, HTTP_URL], `看图 ${placeholder}`));
    expect(lastUserImages(recorder)).toBeUndefined();
    expect(lastUser(recorder)?.content).toContain(placeholder);
  });

  it('media 在场：原样透传，不做任何形态转换（缓存键/动图提示按原串命中）', async () => {
    const recorder: ChatModelRequest[] = [];
    const { agent } = await loadStack(recorder, { media: true });
    await agent.handleMessage(incomingWith([STORED]));
    expect(lastUserImages(recorder), 'media 在场时 agent 不得改写 images 形态').toEqual([STORED]);
  });
});

describe('media 缺席时的 images 兜底（真实 storage-local 多根）', () => {
  let base: string;
  let app: App | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-agent-img-roots-'));
    const dir = join(base, 'state', 'images', 'onebot_t_group_1', 'onebot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0123456789abcdef.png'), PNG_BYTES);
  });

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  it('workspace 排第一：存储地址按根路由读 data 根，不丢图', async () => {
    const recorder: ChatModelRequest[] = [];
    const stack = await loadStack(recorder, { storageRoots: base });
    app = stack.app;
    // 前提锚：storage 只有一家，workspace 排第一、data 也由它在内部路由
    const roots = app
      .bind({ storage })
      .storage.use.listRoots()
      .map(r => r.name);
    expect(roots[0]).toBe('workspace');
    expect(roots).toContain('data');
    await stack.agent.handleMessage(incomingWith([STORED]));
    expect(lastUserImages(recorder), 'data 根里的落盘图应物化为 data URI').toEqual([PNG_DATA_URI]);
  });
});
