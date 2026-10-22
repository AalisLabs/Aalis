import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ServiceView } from '@aalis/core';
import { App, services } from '@aalis/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthorityService } from '../../packages/api-authority/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { DescribeInput, MediaProcessor } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import type { SessionInfo, SessionManagerService } from '../../packages/api-session-manager/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved, MediaServiceCaps } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage, Message } from '../../packages/schema-message/src/index.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

/** analyze_image 直通分支的远端下载桩：只替换 safeDownloadToTemp，其余走原实现 */
const download = vi.hoisted(() => ({
  next: null as { path: string; uri: string; cleanup: () => Promise<void> } | null,
  seen: [] as Array<{ url: string; imageOnly: boolean | undefined }>,
}));
vi.mock(import('../../packages/plugin-media/src/safe-fetch.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeDownloadToTemp: async (url: string, opts?: { imageOnly?: boolean }) => {
    download.seen.push({ url, imageOnly: opts?.imageOnly });
    return download.next;
  },
}));

// ════════════════════════════════════════════════════════════
// 图片处理重定位（2026-09）：识别模型 + 两个正交开关
//   recognizeOnArrival：接触到图立即识别落描述（关 = 档案只留指针）
//   delivery：主模型需要看图时怎么给——auto 按本会话生效主模型的 vision 能力；
//             当轮附件（agent:llm:before 出口）与 analyze_image 走同一判定
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';
/** 每个工具用例一张不同的图：描述缓存是模块级的，同一 data URI 会命中缓存而不再调识别模型 */
const toolUri = (n: number) => `data:image/png;base64,iVBORw0KGgoAAAANSUhEUg${'A'.repeat(n)}==`;

function cfgWith(vision: Partial<MediaConfigResolved['vision']>): MediaConfigResolved {
  return {
    vision: { recognizeOnArrival: true, delivery: 'auto', maxTokens: 300, think: false, ...vision },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
  } as unknown as MediaConfigResolved;
}

/** MediaServiceImpl 的能力桩：可挂若干 LLM entry（带 capabilities） */
function makeCaps(entries: Array<{ contextId: string; caps: string[] }>): MediaServiceCaps {
  const models: ServiceView<LLMModel>[] = entries.map(e => ({
    contextId: e.contextId,
    instance: { id: e.contextId.split('/')[1], capabilities: e.caps } as unknown as LLMModel,
    priority: 0,
  }));
  return { logger: fixedRef(logger), llm: ref(models), asr: ref(), memory: ref() };
}

/** 两个模型：列表首个能看图，另一个不能 */
const VISION_FIRST = [
  { contextId: 'p/vision-model', caps: ['chat', 'vision'] },
  { contextId: 'p/text-model', caps: ['chat'] },
];

describe('resolveDelivery：auto 按这次调用的对话模型的 vision 能力', () => {
  it('调用方没给模型时按 llm 的默认条目：有 vision → passthrough；无 vision → describe；没有模型 → describe', () => {
    expect(
      new MediaServiceImpl(makeCaps([{ contextId: 'p/m', caps: ['chat', 'vision'] }]), cfgWith({})).resolveDelivery(),
    ).toBe('passthrough');
    expect(new MediaServiceImpl(makeCaps([{ contextId: 'p/m', caps: ['chat'] }]), cfgWith({})).resolveDelivery()).toBe(
      'describe',
    );
    expect(new MediaServiceImpl(makeCaps([]), cfgWith({})).resolveDelivery()).toBe('describe');
  });

  it('给了模型时按那个模型判，而不是按列表首个', () => {
    const svc = new MediaServiceImpl(makeCaps(VISION_FIRST), cfgWith({}));
    expect(svc.resolveDelivery({ provider: 'p', model: 'text-model' })).toBe('describe');
    expect(svc.resolveDelivery({ provider: 'p', model: 'vision-model' })).toBe('passthrough');
  });

  it('显式 passthrough / describe 不看模型能力', () => {
    const noLLM = makeCaps([]);
    expect(new MediaServiceImpl(noLLM, cfgWith({ delivery: 'passthrough' })).resolveDelivery()).toBe('passthrough');
    const vision = makeCaps([{ contextId: 'p/m', caps: ['chat', 'vision'] }]);
    expect(
      new MediaServiceImpl(vision, cfgWith({ delivery: 'describe' })).resolveDelivery({ provider: 'p', model: 'm' }),
    ).toBe('describe');
  });
});

function withFakeVision(svc: MediaServiceImpl): DescribeInput[] {
  const calls: DescribeInput[] = [];
  const proc: MediaProcessor = {
    name: 'fake-vision',
    capabilities: ['vision'],
    priority: 10,
    describe: async req => {
      calls.push(req);
      return { descriptions: ['一只猫'] };
    },
  };
  svc.registerProcessor(proc);
  return calls;
}

describe('recognizeOnArrival：到达即识别 vs 只留指针', () => {
  const msg = (): IncomingMessage =>
    ({
      sessionId: 's',
      platform: 'test',
      content: '[图片 | ref:x]',
      attachments: [{ kind: 'image', data: DATA_URI, mimeType: 'image/png' }],
    }) as unknown as IncomingMessage;

  it('开：识别模型被调，描述写进 _attachmentDescriptions', async () => {
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({ recognizeOnArrival: true }));
    const calls = withFakeVision(svc);
    const m = msg();
    const report = await svc.processMessage(m);
    expect(calls).toHaveLength(1);
    expect(report.successCount).toBe(1);
    expect(m._attachmentDescriptions?.[0]).toContain('一只猫');
  });

  it('关：不调识别模型；OneBot 的图（data 是落盘后的相对路径、正文已有 ref）描述位留空', async () => {
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({ recognizeOnArrival: false }));
    const calls = withFakeVision(svc);
    const m: IncomingMessage = {
      ...msg(),
      attachments: [{ kind: 'image', data: 'data/images/s/x.png', mimeType: 'image/png' }],
    };
    const report = await svc.processMessage(m);
    expect(calls).toHaveLength(0);
    expect(report.successCount).toBe(0);
    expect(m._attachmentDescriptions).toEqual([undefined]);
  });

  it('关 + WebUI 上传（base64、正文无 ref）：自己落盘并写指针，档案不留零痕迹', async () => {
    const written: string[] = [];
    setMediaRuntime({
      proc: {} as never,
      storage: { writeFile: async (uri: string) => void written.push(uri) } as never,
    });
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({ recognizeOnArrival: false }));
    withFakeVision(svc);
    const m = { ...msg(), content: '' } as IncomingMessage;
    await svc.processMessage(m);
    expect(written).toHaveLength(1);
    expect(m._attachmentDescriptions?.[0]).toMatch(/^\[图片 \| ref:data\/images\/s\/[0-9a-f]{16}\.png\]$/);
  });
});

describe('analyze_image：按交付形态返回图片或文字', () => {
  async function withTool(
    vision: Partial<MediaConfigResolved['vision']>,
    acceptsImages: boolean,
    uri: string,
    extraArgs: Record<string, unknown> = {},
    model?: ToolCallContext['model'],
  ) {
    const app = new App({ name: 'T', logLevel: 'error' });
    // 工具经宿主根激活的绑定门面登记，落进 plugin-tools 的真实注册表
    const host = app.bind({ services, tools, memory });
    await app.plugin(toolsPlugin);
    await app.plugins.idle();
    const svc = new MediaServiceImpl(makeCaps(VISION_FIRST), cfgWith(vision));
    const calls = withFakeVision(svc);
    registerMediaTools({ ...host, sessionManager: ref(), authority: ref() }, svc);
    const registry = host.services.use.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const result = await registry.execute(
      'analyze_image',
      { image: uri, ...extraArgs },
      {
        sessionId: 's',
        platform: 'test',
        ...(acceptsImages ? { acceptsImages: true } : {}),
        ...(model ? { model } : {}),
      },
    );
    await app.stop();
    return { result, calls };
  }

  it('passthrough + 非图片的 data URI：在工具层返回错误，不交给主请求（否则整轮 400）', async () => {
    const { result, calls } = await withTool(
      { delivery: 'passthrough' },
      true,
      `data:text/plain;base64,${Buffer.from('not an image').toString('base64')}`,
    );
    expect(JSON.parse(result.content).error).toMatch(/不是图片/);
    expect(result.images).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('passthrough + 远端 http 图片：工具层先下载并校验是图片，再以 file:// 交给物化链，图片随结果交出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aalis-analyze-'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', 'base64');
    const path = join(dir, 'download.png');
    await writeFile(path, png);
    let cleaned = false;
    download.next = {
      path,
      uri: 'tmp:/media-dl/download.png',
      cleanup: async () => {
        cleaned = true;
      },
    };
    // 物化链对 file:// 走 proc.readExternalFile 读盘
    setMediaRuntime({ proc: { readExternalFile: (p: string) => readFile(p) } as never, storage: {} as never });
    try {
      const url = 'https://example.invalid/pic';
      const { result, calls } = await withTool({ delivery: 'passthrough' }, true, url);
      expect(download.seen.at(-1)).toEqual({ url, imageOnly: true });
      expect(calls).toHaveLength(0);
      expect(result.images).toEqual([`data:image/png;base64,${png.toString('base64')}`]);
      expect(JSON.parse(result.content)).toMatchObject({ ok: true, image: url });
      expect(cleaned, '临时下载文件在交付后清理').toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passthrough + 远端下载失败或不是图片：工具层返回错误，不交给主请求', async () => {
    download.next = null;
    const { result, calls } = await withTool({ delivery: 'passthrough' }, true, 'https://example.invalid/404');
    expect(JSON.parse(result.content).error).toMatch(/无法下载/);
    expect(result.images).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('passthrough + 调用方接图（agent 循环）：图片随结果交给主模型，识别模型一次不调；content 对后续回合也成立', async () => {
    const { result, calls } = await withTool({ delivery: 'passthrough' }, true, toolUri(1));
    expect(calls).toHaveLength(0);
    expect(result.images).toEqual([toolUri(1)]);
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(true);
    expect(body.image).toBe(toolUri(1)); // 落库后可按此引用重新查看
  });

  it('passthrough 但调用方不接图（mcp-server / workflow 只读 content）：退回识别模型出文字，不给空壳', async () => {
    const { result, calls } = await withTool({ delivery: 'passthrough' }, false, toolUri(2));
    expect(calls).toHaveLength(1);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content).description).toBe('一只猫');
  });

  it('task 与 prompt 同传：两者都进 hint（工具描述用一整段教模型写 prompt，不能被静默丢弃）', async () => {
    const { result, calls } = await withTool({ delivery: 'describe' }, false, toolUri(4), {
      task: '看看这题',
      prompt: '请用 LaTeX 抄录所有公式',
      context: '这是第 3 页',
    });
    expect(JSON.parse(result.content).description).toBe('一只猫');
    expect(calls).toHaveLength(1);
    expect(calls[0].hint).toContain('用户需求: 看看这题');
    expect(calls[0].hint).toContain('分析提示词: 请用 LaTeX 抄录所有公式');
    expect(calls[0].hint).toContain('补充上下文: 这是第 3 页');
  });

  it('auto：按这次调用的模型判（工具上下文的 model），能看图的直通、不能的交识别模型', async () => {
    const text = await withTool({ delivery: 'auto' }, true, toolUri(5), {}, { provider: 'p', model: 'text-model' });
    expect(text.calls).toHaveLength(1);
    expect(text.result.images).toBeUndefined();
    const vision = await withTool({ delivery: 'auto' }, true, toolUri(6), {}, { provider: 'p', model: 'vision-model' });
    expect(vision.calls).toHaveLength(0);
    expect(vision.result.images).toEqual([toolUri(6)]);
  });

  it('describe：识别模型出文字，不带 images；识别按调用工具的会话记账', async () => {
    const { result, calls } = await withTool({ delivery: 'describe' }, true, toolUri(3));
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('s');
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content).description).toBe('一只猫');
  });
});

/** 一张最小的 PNG 与几样不是图片的内容（占位符） */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const YAML = new TextEncoder().encode('token: PLACEHOLDER\n');
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]);

const GROUP = 'onebot:10000:group:20001';
const GROUP_DIR = 'onebot_10000_group_20001';

describe('analyze_image：存储里的图按受众判、读一次、核文件头', () => {
  async function analyze(
    files: Record<string, Uint8Array>,
    image: string,
    opts: { delivery: 'passthrough' | 'describe'; call?: ToolCallContext; sessions?: SessionInfo[] },
  ) {
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ services, tools, memory });
    await app.plugin(toolsPlugin);
    await app.plugins.idle();
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({ delivery: opts.delivery }));
    const calls = withFakeVision(svc);
    const reads: string[] = [];
    const storageStub = {
      listRoots: () => [{ name: 'data', kind: 'data' }],
      readFile: async (uri: string) => {
        reads.push(uri);
        const data = files[uri];
        if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
        return data;
      },
      readFileRange: async () => {
        throw new Error('只整读一次，不另读文件头');
      },
    } as unknown as StorageService;
    // 读存储与裸相对路径按存储根路由，都取自媒体运行时
    setMediaRuntime({ proc: {} as never, storage: storageStub });
    const sessions = new Map((opts.sessions ?? []).map(info => [info.id, info]));
    registerMediaTools(
      {
        ...host,
        sessionManager: fixedRef({ getSession: (id: string) => sessions.get(id) } as unknown as SessionManagerService),
        authority: fixedRef({ isOwner: () => false } as unknown as AuthorityService),
      },
      svc,
    );
    const registry = host.services.use.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const result = await registry.execute(
      'analyze_image',
      { image },
      opts.call ?? { sessionId: 's', platform: 'test', acceptsImages: true },
    );
    await app.stop();
    return { result, calls, reads };
  }

  it('直通 + data:/images/… 存储地址：按存储读取交出图片，只读一次', async () => {
    const { result, calls, reads } = await analyze({ 'data:/images/s/cat.png': PNG }, 'data:/images/s/cat.png', {
      delivery: 'passthrough',
    });
    expect(JSON.parse(result.content).error).toBeUndefined();
    expect(result.images).toEqual([`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`]);
    expect(calls).toHaveLength(0);
    expect(reads).toEqual(['data:/images/s/cat.png']);
  });

  it.each([
    ['文本', YAML],
    ['音频', MP3],
  ])('扩展名是 .png、内容是%s：用本工具的话拒，不交给识别模型', async (_label, content) => {
    const { result, calls } = await analyze({ 'data:/images/s/fake.png': content }, 'data/images/s/fake.png', {
      delivery: 'describe',
    });
    expect(JSON.parse(result.content).error).toBe('目标不是图片（文件内容不是受支持的图片格式）');
    expect(calls).toHaveLength(0);
  });

  it('房间里看别的会话的图：拒，不读文件', async () => {
    const { result, calls, reads } = await analyze(
      { 'data:/images/onebot_10000_group_20002/x.png': PNG, [`data:/images/${GROUP_DIR}/y.png`]: PNG },
      'data:/images/onebot_10000_group_20002/x.png',
      {
        delivery: 'describe',
        call: { sessionId: GROUP, platform: 'onebot', userId: '90002' },
        sessions: [storedRoom(GROUP) as unknown as SessionInfo],
      },
    );
    expect(JSON.parse(result.content).error).toBe('这个会话里只能看本会话收到或产生的图片');
    expect(calls).toHaveLength(0);
    expect(reads).toEqual([]);
  });
});

describe('update_image_description：只改调用所在会话', () => {
  it('传 session_id 被参数校验拒；不传时改调用所在会话', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    const updates: Array<[string, string, string]> = [];
    const history: Message[] = [{ role: 'user', content: '[图片 | ref:data/images/s/a.png]', timestamp: 1 }];
    const memoryStub = {
      getHistory: async () => history,
      updateMessageContent: async (sessionId: string, oldText: string, newText: string) => {
        updates.push([sessionId, oldText, newText]);
        return 1;
      },
    } as unknown as MemoryService;
    const host = app.bind({ services, tools });
    await app.plugin(toolsPlugin);
    await app.plugins.idle();
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({}));
    registerMediaTools({ ...host, memory: fixedRef(memoryStub), sessionManager: ref(), authority: ref() }, svc);
    const registry = host.services.use.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const call = { sessionId: 's', platform: 'test' };
    const refused = await registry.execute(
      'update_image_description',
      { image_ref: 'data/images/s/a.png', description: '一只猫', session_id: 'other' },
      call,
    );
    expect(JSON.parse(refused.content).error).toContain('包含未知参数 "session_id"');
    expect(updates).toEqual([]);
    await registry.execute(
      'update_image_description',
      { image_ref: 'data/images/s/a.png', description: '一只猫' },
      call,
    );
    await app.stop();
    expect(updates).toEqual([['s', '[图片 | ref:data/images/s/a.png]', '[图片: 一只猫 | ref:data/images/s/a.png]']]);
  });
});
