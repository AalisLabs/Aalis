import type { Logger, ServiceView } from '@aalis/core';
import { App, services } from '@aalis/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthorityService, OriginTurn } from '../../packages/api-authority/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { DescribeInput, MediaProcessor } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import {
  type SessionInfo,
  type SessionManagerService,
  TAKE_UNKNOWN,
} from '../../packages/api-session-manager/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { type ToolCallRequest, tools } from '../../packages/api-tools/src/index.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved, MediaServiceCaps } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage, Message } from '../../packages/schema-message/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fixedRef, liveLifecycle, ref } from '../fixtures/service-ref.js';
import { toolRequest } from '../fixtures/tool-call.js';

/** analyze_image 直通分支的远端下载桩：只替换 safeFetchBuffer，其余走原实现；seen 记下下载的网址，next 为空时按下载失败抛错 */
const download = vi.hoisted(() => ({
  next: null as Uint8Array | null,
  seen: [] as string[],
}));
vi.mock(import('../../packages/plugin-media/src/safe-fetch.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeFetchBuffer: async (url: string) => {
    download.seen.push(url);
    if (!download.next) throw new Error('上游返回 404');
    return Buffer.from(download.next);
  },
}));

// ════════════════════════════════════════════════════════════
// 图片处理重定位（2026-09）：识别模型 + 两个正交开关
//   recognizeOnArrival：接触到图立即识别落描述（关 = 档案只留指针）
//   delivery：主模型需要看图时怎么给——auto 按调用方交来的 acceptsImages（agent 按这一轮的模型登记的视觉能力填）；
//             当轮附件（agent:llm:before 出口）与 analyze_image 走同一判定
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';
/** PNG 的签名与 IHDR 块头：按文件头判是 PNG */
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** 每个工具用例一张不同的图：描述缓存是模块级的，同一 data URI 会命中缓存而不再调识别模型 */
const toolUri = (n: number) => `data:image/png;base64,${Buffer.concat([PNG_HEAD, Buffer.alloc(n)]).toString('base64')}`;

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
  return { logger: fixedRef(logger), llm: ref(models), asr: ref(), memory: ref(), lifecycle: liveLifecycle() };
}

const VISION_LLM = makeCaps([{ contextId: 'p/m', caps: ['chat', 'vision'] }]);

describe('resolveDelivery：auto 只按调用方交来的 acceptsImages', () => {
  it('能看图直通、不能看交描述，不查 media 自己取得到的模型', () => {
    expect(new MediaServiceImpl(VISION_LLM, cfgWith({})).resolveDelivery(false)).toBe('describe');
    expect(new MediaServiceImpl(makeCaps([]), cfgWith({})).resolveDelivery(true)).toBe('passthrough');
  });

  it('显式 passthrough / describe 不看 acceptsImages', () => {
    expect(new MediaServiceImpl(makeCaps([]), cfgWith({ delivery: 'passthrough' })).resolveDelivery(false)).toBe(
      'passthrough',
    );
    expect(new MediaServiceImpl(VISION_LLM, cfgWith({ delivery: 'describe' })).resolveDelivery(true)).toBe('describe');
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

  it('关：不调识别模型；OneBot 的图（data 是落盘后的存储地址、正文已有这个引用）描述位留空', async () => {
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({ recognizeOnArrival: false }));
    const calls = withFakeVision(svc);
    const landed = 'data:/images/s/onebot/0123456789abcdef.png';
    const m: IncomingMessage = {
      ...msg(),
      content: `[图片 | ref:${landed}]`,
      attachments: [{ kind: 'image', data: landed, mimeType: 'image/png' }],
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
    expect(m._attachmentDescriptions?.[0]).toMatch(/^\[图片 \| ref:data:\/images\/s\/media\/[0-9a-f]{16}\.png\]$/);
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
    provideEvents(app);
    // 工具经宿主根激活的绑定门面登记，落进 plugin-tools 的真实注册表
    const host = app.bind({ services, tools, memory, events });
    await app.plugin(toolsPlugin);
    await app.plugins.idle();
    // media 自己取不到对话模型：交付只看工具上下文的 acceptsImages
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith(vision));
    const calls = withFakeVision(svc);
    registerMediaTools({ ...host, sessionManager: ref(), authority: ref() }, svc);
    const registry = host.services.use.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const result = await registry.execute(
      'analyze_image',
      { image: uri, ...extraArgs },
      toolRequest({ sessionId: 's', platform: 'test', ...(acceptsImages ? { acceptsImages: true } : {}) }),
    );
    await app.stop();
    return { result, calls };
  }

  it.each([
    ['类型写成 text/plain', 'text/plain'],
    ['类型写成 image/png', 'image/png'],
  ])('passthrough + 内容不是图片的 data URI（%s）：按文件头判，在工具层返回错误，不交给主请求（否则整轮 400）', async (_label, mime) => {
    const { result, calls } = await withTool(
      { delivery: 'passthrough' },
      true,
      `data:${mime};base64,${Buffer.from('not an image').toString('base64')}`,
    );
    expect(JSON.parse(result.content).error).toMatch(/不是图片/);
    expect(result.images).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('passthrough + 类型写成 octet-stream 的真图：按文件头认，图片随结果交出、类型取判定结果', async () => {
    const png = Buffer.concat([PNG_HEAD, Buffer.alloc(8)]).toString('base64');
    const { result, calls } = await withTool(
      { delivery: 'passthrough' },
      true,
      `data:application/octet-stream;base64,${png}`,
    );
    expect(calls).toHaveLength(0);
    expect(result.images).toEqual([`data:image/png;base64,${png}`]);
  });

  it.each([
    'https://example.invalid/pic',
    'HTTPS://example.invalid/pic',
  ])('passthrough + 远端图片 %s：工具层先下载并按文件头认是图片，转成 data URL 随结果交出，不落临时文件', async url => {
    const png = Buffer.concat([PNG_HEAD, Buffer.alloc(8)]);
    download.next = png;
    // 不落临时文件：物化链与存储一样都碰不到
    setMediaRuntime({ proc: {} as never, storage: {} as never });
    const { result, calls } = await withTool({ delivery: 'passthrough' }, true, url);
    expect(download.seen.at(-1)).toBe(url);
    expect(calls).toHaveLength(0);
    expect(result.images).toEqual([`data:image/png;base64,${png.toString('base64')}`]);
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, image: url });
  });

  it.each([
    ['下载失败', null],
    ['下到的不是图片', Buffer.from('<!doctype html><p>placeholder</p>')],
  ])('passthrough + 远端%s：工具层返回错误，不交给主请求', async (_label, next) => {
    download.next = next;
    const { result, calls } = await withTool({ delivery: 'passthrough' }, true, 'https://example.invalid/404');
    expect(JSON.parse(result.content).error).toMatch(/无法下载/);
    expect(result.images).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('历史占位符里的引用是网址：按网址处理', async () => {
    download.next = null;
    const url = 'https://example.invalid/cat.png';
    const { result } = await withTool({ delivery: 'passthrough' }, true, `[图片 | ref:${url}]`);
    expect(download.seen.at(-1)).toBe(url);
    expect(JSON.parse(result.content).error).toMatch(/无法下载/);
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

  it('auto：按工具上下文的 acceptsImages 判，能看图的直通、不能看图的会话走识别模型', async () => {
    const blind = await withTool({ delivery: 'auto' }, false, toolUri(5));
    expect(blind.calls).toHaveLength(1);
    expect(blind.result.images).toBeUndefined();
    expect(JSON.parse(blind.result.content).description).toBe('一只猫');
    const sees = await withTool({ delivery: 'auto' }, true, toolUri(6));
    expect(sees.calls).toHaveLength(0);
    expect(sees.result.images).toEqual([toolUri(6)]);
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

describe('analyze_image：存储里的图先过媒体判据、读一次、核文件头', () => {
  async function analyze(
    files: Record<string, Uint8Array>,
    image: string,
    opts: { delivery: 'passthrough' | 'describe'; call?: ToolCallRequest; sessions?: SessionInfo[]; owner?: boolean },
  ) {
    const app = new App({ name: 'T', logLevel: 'error' });
    provideEvents(app);
    const host = app.bind({ services, tools, memory, events });
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
    // 读存储取自媒体运行时
    setMediaRuntime({ proc: {} as never, storage: storageStub });
    // 会话管理的取用规则是一律不放行的替身：取用规则本身由 session-take-rule 钉住
    const sessions = new Map((opts.sessions ?? []).map(info => [info.id, info]));
    const isOwner = () => opts.owner === true;
    registerMediaTools(
      {
        ...host,
        sessionManager: fixedRef({
          getSession: (id: string) => sessions.get(id),
          listSessions: () => [...sessions.values()],
          canTake: () => ({ ok: false, reason: TAKE_UNKNOWN }),
        } as unknown as SessionManagerService),
        authority: fixedRef({
          isOwner,
          principalOf: (turn: OriginTurn) => principalKind(turn, isOwner),
        } as unknown as AuthorityService),
      },
      svc,
    );
    const registry = host.services.use.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const result = await registry.execute(
      'analyze_image',
      { image },
      opts.call ?? toolRequest({ sessionId: 's', platform: 'test', acceptsImages: true }),
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

  it('历史里的占位符：取出其中的引用读', async () => {
    const { result, reads } = await analyze(
      { 'data:/images/s/cat.png': PNG },
      '[图片: 一只猫 | ref:data:/images/s/cat.png]',
      { delivery: 'passthrough' },
    );
    expect(result.images).toEqual([`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`]);
    expect(reads).toEqual(['data:/images/s/cat.png']);
  });

  it.each([
    ['文本', YAML],
    ['音频', MP3],
  ])('扩展名是 .png、内容是%s：用本工具的话拒，不交给识别模型', async (_label, content) => {
    const { result, calls } = await analyze({ 'data:/images/s/fake.png': content }, 'data:/images/s/fake.png', {
      delivery: 'describe',
    });
    expect(JSON.parse(result.content).error).toBe('目标不是图片（文件内容不是受支持的图片格式）');
    expect(calls).toHaveLength(0);
  });

  /** owner 在只有自己的会话里调用：本机文件能取，读不读、读哪个只看来源怎么规整 */
  const ownCall = toolRequest({ sessionId: 's', platform: 'test', userId: 'u1', acceptsImages: true });

  it.each([
    ['out.png', 'workspace:/out.png'],
    ['./pics/out.png', 'workspace:/pics/out.png'],
  ])('相对路径（%s）与 file_* 工具一致归到工作区：读 %s', async (image, uri) => {
    const { result, reads } = await analyze({ [uri]: PNG }, image, {
      delivery: 'passthrough',
      call: ownCall,
      owner: true,
    });
    expect(result.images).toEqual([`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`]);
    expect(reads).toEqual([uri]);
  });

  it('data/images/… 不按首段补成存储地址，当成工作区路径；找不到时回错误，提示存储地址的写法', async () => {
    const { result, calls, reads } = await analyze({ 'data:/images/s/cat.png': PNG }, 'data/images/s/cat.png', {
      delivery: 'describe',
      call: ownCall,
      owner: true,
    });
    expect(JSON.parse(result.content).error).toBe(
      '找不到 workspace:/data/images/s/cat.png：相对路径按工作区（workspace:/）找，别处的图要写带根名的存储地址，如 data:/images/…',
    );
    expect(calls).toHaveLength(0);
    expect(reads).toEqual(['workspace:/data/images/s/cat.png']);
  });

  it('房间里写成相对路径：判据不放行时同样提示存储地址的写法，不读文件', async () => {
    const image = `data/images/${GROUP_DIR}/onebot/0123456789abcdef.png`;
    const { result, reads } = await analyze({ [`data:/images/${GROUP_DIR}/onebot/0123456789abcdef.png`]: PNG }, image, {
      delivery: 'describe',
      call: toolRequest({ sessionId: GROUP, platform: 'onebot', userId: '90002' }),
      sessions: [storedRoom(GROUP) as unknown as SessionInfo],
    });
    expect(JSON.parse(result.content).error).toBe(
      `找不到 workspace:/${image}：相对路径按工作区（workspace:/）找，别处的图要写带根名的存储地址，如 data:/images/…`,
    );
    expect(reads).toEqual([]);
  });

  it.each(['/srv/pics/cat.png', 'C:\\pics\\cat.png'])('本机路径（%s）：回「不能写本机路径」，不读文件', async image => {
    const { result, reads } = await analyze({}, image, { delivery: 'describe', call: ownCall, owner: true });
    expect(JSON.parse(result.content).error).toBe('图片来源要写历史引用、存储地址或网址，不能写本机路径');
    expect(reads).toEqual([]);
  });

  it('房间里看别的会话的图，取用规则不放行：拒，不读文件', async () => {
    const { result, calls, reads } = await analyze(
      { 'data:/images/onebot_10000_group_20002/x.png': PNG, [`data:/images/${GROUP_DIR}/y.png`]: PNG },
      'data:/images/onebot_10000_group_20002/x.png',
      {
        delivery: 'describe',
        call: toolRequest({ sessionId: GROUP, platform: 'onebot', userId: '90002' }),
        sessions: [GROUP, 'onebot:10000:group:20002'].map(id => storedRoom(id) as unknown as SessionInfo),
      },
    );
    expect(JSON.parse(result.content).error).toBe(
      '这张图不在这一轮能看的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人',
    );
    expect(calls).toHaveLength(0);
    expect(reads).toEqual([]);
  });
});

describe('update_image_description：只改调用所在会话', () => {
  it('传 session_id 被参数校验拒；不传时改调用所在会话', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    provideEvents(app);
    const updates: Array<[string, string, string]> = [];
    const history: Message[] = [{ role: 'user', content: '[图片 | ref:data:/images/s/a.png]', timestamp: 1 }];
    const memoryStub = {
      getHistory: async () => history,
      updateMessageContent: async (sessionId: string, oldText: string, newText: string) => {
        updates.push([sessionId, oldText, newText]);
        return 1;
      },
    } as unknown as MemoryService;
    const host = app.bind({ services, tools, events });
    await app.plugin(toolsPlugin);
    await app.plugins.idle();
    const svc = new MediaServiceImpl(makeCaps([]), cfgWith({}));
    registerMediaTools({ ...host, memory: fixedRef(memoryStub), sessionManager: ref(), authority: ref() }, svc);
    const registry = host.services.use.get(tools);
    if (!registry) throw new Error('tools 服务未注册');
    const call = toolRequest({ sessionId: 's', platform: 'test' });
    const refused = await registry.execute(
      'update_image_description',
      { image_ref: 'data:/images/s/a.png', description: '一只猫', session_id: 'other' },
      call,
    );
    expect(JSON.parse(refused.content).error).toContain('包含未知参数 "session_id"');
    expect(updates).toEqual([]);
    await registry.execute(
      'update_image_description',
      { image_ref: 'data:/images/s/a.png', description: '一只猫' },
      call,
    );
    await app.stop();
    expect(updates).toEqual([['s', '[图片 | ref:data:/images/s/a.png]', '[图片: 一只猫 | ref:data:/images/s/a.png]']]);
  });
});
