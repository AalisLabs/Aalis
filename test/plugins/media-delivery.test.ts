import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ServiceRef, ServiceView } from '@aalis/core';
import { App, provide, services } from '@aalis/core';
import { describe, expect, it, vi } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { DescribeInput, MediaProcessor } from '../../packages/api-media/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import type { SessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import mediaPlugin, { legacyVisionMode } from '../../packages/plugin-media/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved, MediaServiceCaps } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

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

/** 按激活绑定的服务桩：当前胜者取首个 entry */
function ref<P>(entries: ServiceView<P>[] = []): ServiceRef<P> {
  return {
    current: entries[0]?.instance,
    require: () => {
      const provider = entries[0]?.instance;
      if (provider === undefined) throw new Error('无提供者');
      return provider;
    },
    all: () => entries,
    follow: () => () => {},
  };
}

/** MediaServiceImpl 的能力桩：可挂若干 LLM entry（带 capabilities）与一个 session-manager */
function makeCaps(
  entries: Array<{ contextId: string; caps: string[] }>,
  sessionLLM?: { provider: string; model: string },
): MediaServiceCaps {
  const models: ServiceView<LLMModel>[] = entries.map(e => ({
    contextId: e.contextId,
    instance: { id: e.contextId.split('/')[1], capabilities: e.caps } as unknown as LLMModel,
    priority: 0,
  }));
  const sessionManager: ServiceView<SessionManagerService>[] = sessionLLM
    ? [
        {
          contextId: 'session-manager',
          instance: { resolveConfig: () => ({ llm: sessionLLM }) } as unknown as SessionManagerService,
          priority: 0,
        },
      ]
    : [];
  return { logger, llm: ref(models), asr: ref(), sessionManager: ref(sessionManager), memory: ref() };
}

describe('resolveDelivery：auto 按本会话生效主模型的 vision 能力', () => {
  it('默认 entry 有 vision → passthrough；无 vision → describe', () => {
    expect(
      new MediaServiceImpl(makeCaps([{ contextId: 'p/m', caps: ['chat', 'vision'] }]), cfgWith({})).resolveDelivery(
        's',
      ),
    ).toBe('passthrough');
    expect(
      new MediaServiceImpl(makeCaps([{ contextId: 'p/m', caps: ['chat'] }]), cfgWith({})).resolveDelivery('s'),
    ).toBe('describe');
    expect(new MediaServiceImpl(makeCaps([]), cfgWith({})).resolveDelivery('s')).toBe('describe');
  });

  it('会话指定了模型时按该模型判（与 agent 的解析链同源），而不是按列表首个', () => {
    const entries = [
      { contextId: 'p/vision-model', caps: ['chat', 'vision'] },
      { contextId: 'p/text-model', caps: ['chat'] },
    ];
    const svc = new MediaServiceImpl(makeCaps(entries, { provider: 'p', model: 'text-model' }), cfgWith({}));
    expect(svc.resolveDelivery('s', 'onebot')).toBe('describe');
    const svc2 = new MediaServiceImpl(makeCaps(entries, { provider: 'p', model: 'vision-model' }), cfgWith({}));
    expect(svc2.resolveDelivery('s', 'onebot')).toBe('passthrough');
  });

  it('显式 passthrough / describe 不看模型能力', () => {
    const noLLM = makeCaps([]);
    expect(new MediaServiceImpl(noLLM, cfgWith({ delivery: 'passthrough' })).resolveDelivery('s')).toBe('passthrough');
    const vision = makeCaps([{ contextId: 'p/m', caps: ['chat', 'vision'] }]);
    expect(new MediaServiceImpl(vision, cfgWith({ delivery: 'describe' })).resolveDelivery('s')).toBe('describe');
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

  it('关：不调识别模型；无落盘运行时（OneBot 场景正文已有 ref）描述位留空', async () => {
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({ recognizeOnArrival: false }));
    const calls = withFakeVision(svc);
    const m = msg();
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

describe('legacy vision.mode 映射（config-sync 在 apply 前裁 schema 外键，故旧键保留一版）', () => {
  it('四档 → 新键；非法/缺省 → null', () => {
    expect(legacyVisionMode('describe')).toEqual({ recognizeOnArrival: true, delivery: 'describe' });
    expect(legacyVisionMode('passthrough')).toEqual({ recognizeOnArrival: false, delivery: 'passthrough' });
    expect(legacyVisionMode('passthrough-raw')).toEqual({ recognizeOnArrival: false, delivery: 'passthrough' });
    expect(legacyVisionMode('disabled')).toEqual({ recognizeOnArrival: false, delivery: 'describe' });
    expect(legacyVisionMode(undefined)).toBeNull();
    expect(legacyVisionMode('')).toBeNull();
  });

  /** 真实装配 media 插件，注册假 vision processor，喂一张独一无二的图（描述缓存是模块级的） */
  async function callsUnder(vision: Record<string, unknown>, uri: string): Promise<number> {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, services });
    host.provide(processService, {} as never);
    host.provide(storage, {} as never);
    await app.plugin(mediaPlugin, { vision });
    await app.plugins.idle();
    const service = host.services.get(media);
    if (!service) throw new Error('media 未注册');
    const calls: unknown[] = [];
    service.registerProcessor({
      name: 'fake-vision',
      capabilities: ['vision'],
      priority: 10,
      describe: async req => {
        calls.push(req);
        return { descriptions: ['一张图'] };
      },
    });
    const m = {
      sessionId: 's',
      platform: 'test',
      content: '',
      attachments: [{ kind: 'image', data: uri, mimeType: 'image/png' }],
    } as unknown as IncomingMessage;
    await service.processMessage(m);
    await app.stop();
    return calls.length;
  }

  it('旧值 disabled 覆盖新键：升级后图片不会开始被识别（隐私回归守卫）；对照 describe 旧值照常识别', async () => {
    // config-sync 会把新键默认值（recognizeOnArrival:true）填进来，旧键必须压过它
    expect(await callsUnder({ mode: 'disabled', recognizeOnArrival: true, delivery: 'auto' }, toolUri(10))).toBe(0);
    expect(await callsUnder({ mode: 'describe', recognizeOnArrival: false, delivery: 'auto' }, toolUri(11))).toBe(1);
  });
});

describe('analyze_image：按交付形态返回图片或文字', () => {
  async function withTool(
    vision: Partial<MediaConfigResolved['vision']>,
    acceptsImages: boolean,
    uri: string,
    extraArgs: Record<string, unknown> = {},
  ) {
    const app = new App({ name: 'T', logLevel: 'error' });
    // 工具经宿主根激活的绑定门面登记，落进 plugin-tools 的真实注册表
    const host = app.bind({ services, tools, memory });
    await app.plugin(toolsPlugin);
    await app.plugins.idle();
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith(vision));
    const calls = withFakeVision(svc);
    registerMediaTools(host, () => svc);
    const registry = host.services.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const result = await registry.execute(
      'analyze_image',
      { image: uri, ...extraArgs },
      { sessionId: 's', platform: 'test', ...(acceptsImages ? { acceptsImages: true } : {}) },
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

  it('describe：识别模型出文字，不带 images', async () => {
    const { result, calls } = await withTool({ delivery: 'describe' }, true, toolUri(3));
    expect(calls).toHaveLength(1);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content).description).toBe('一只猫');
  });
});
