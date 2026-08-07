import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as ollama from '../../packages/plugin-llm-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 图片拿不到时的两种语义，由调用方经 requireImages 声明。
//
// true（视觉识别，图片就是全部内容）：一张都拿不到必须抛。省掉 images 降级成
// 纯文本，模型只看得到 prompt 里的「[图片]」占位，会照着编出一段描述，上游拿到
// 非空内容就记成识别成功——失败被伪装成幻觉。线上曾连续 7371 次如此。
//
// false（顺手带图，如主对话把群消息附件一并递上）：必须保持宽松。抛错会让一张
// 过期图把本来完全能答的一轮打断，群里收到的是内部异常文案。
//
// 图片解析发生在发请求之前，故这些用例不需要 Ollama 在跑。
// ════════════════════════════════════════════════════════════

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// 回环 + 保留端口：被 network-guard 的出口闸直接拒，不产生真实网络流量
const UNREACHABLE = 'http://127.0.0.1:1/nope.png';
const WAV_1B = 'data:audio/wav;base64,UklGRg==';

async function makeModel(): Promise<LLMModel> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(ollama, { baseUrl: 'http://127.0.0.1:11434', customModels: 'testvision' });
  await app.plugins.idle();
  const entries = app.ctx.getAllServices<LLMModel>('llm');
  const model = entries.find(e => e.instance.id.includes('testvision'))?.instance ?? entries[0]?.instance;
  if (!model) throw new Error('未注册出 llm model entry');
  return model;
}

/** 截获发往 Ollama 的请求体，避免用例依赖真实服务 */
function captureBody(): { get: () => Record<string, unknown> | undefined } {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      const ndjson = `${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`;
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: 'ok' }, done: true, choices: [{ message: { content: 'ok' } }] }),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(ndjson));
            c.close();
          },
        }),
      } as unknown as Response;
    }),
  );
  return { get: () => body };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Ollama 图片获取失败的两种语义', () => {
  it('requireImages 时全部拿不到就抛，不省掉 images 字段照发', async () => {
    const model = await makeModel();
    await expect(
      model.chat({
        messages: [{ role: 'user', content: '描述这张图', images: [UNREACHABLE] }],
        requireImages: true,
      }),
    ).rejects.toThrow(/图片全部获取失败/);
  });

  it('不声明 requireImages 时保持宽松，按纯文本继续而不是打断这一轮', async () => {
    const model = await makeModel();
    const cap = captureBody();
    await model.chat({ messages: [{ role: 'user', content: '这图啥意思', images: [UNREACHABLE] }] });
    const messages = cap.get()?.messages as Array<{ images?: unknown }>;
    expect(messages[0].images).toBeUndefined();
  });

  it('部分拿不到时按剩余的继续，且只把拿到的那张发出去', async () => {
    const model = await makeModel();
    const cap = captureBody();
    await model.chat({
      messages: [{ role: 'user', content: '描述', images: [PNG_1PX, UNREACHABLE] }],
      requireImages: true,
    });
    const messages = cap.get()?.messages as Array<{ images?: string[] }>;
    expect(messages[0].images?.length).toBe(1);
  });

  it('主对话走的 chatStream 同样保持宽松，一张死图不打断整轮', async () => {
    const model = await makeModel();
    const cap = captureBody();
    // plugin-agent 的主路径走 chatStream，且它无条件给任何模型挂 images——
    // 这里若变严格，一张过期图会让整轮对话变成群里一句内部异常文案。
    for await (const _ of model.chatStream!({
      messages: [{ role: 'user', content: '这图啥意思', images: [UNREACHABLE] }],
    })) {
      // 只关心不抛，不关心增量
    }
    const messages = cap.get()?.messages as Array<{ images?: unknown }>;
    expect(messages[0].images).toBeUndefined();
  });

  it('带音频改走的 OpenAI 兼容路径同样受 requireImages 管', async () => {
    const model = await makeModel();
    await expect(
      model.chat({
        messages: [{ role: 'user', content: '这是什么', images: [UNREACHABLE], audios: [WAV_1B] }],
        requireImages: true,
      }),
    ).rejects.toThrow(/图片全部获取失败/);
  });
});

// ════════════════════════════════════════════════════════════
// media 的接线：视觉识别必须声明 requireImages。
//
// 这是整条修复的唯一接线点——漏了它，ollama 侧的严格性全部落空，
// 线上那 7371 次幻觉立刻复发。
// ════════════════════════════════════════════════════════════
describe('media 视觉识别的接线', () => {
  it('describe 调用向 model 声明了 requireImages', async () => {
    const { scanLLMProcessors } = await import('../../packages/plugin-media/src/llm-adapter.js');
    let seen: Record<string, unknown> | undefined;
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('llm', {
      id: 'fake/vision',
      capabilities: ['vision'],
      chat: async (req: Record<string, unknown>) => {
        seen = req;
        return { content: '一只猫' };
      },
    });
    const vision = scanLLMProcessors(app.ctx).find(p => p.capabilities.includes('vision' as never));
    if (!vision?.describe) throw new Error('未扫描出带 describe 的 vision processor');
    // data URL 直接内联，不触网
    await vision.describe({ attachments: [{ data: PNG_1PX, mimeType: 'image/png' }] } as never, app.ctx);
    expect(seen?.requireImages).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// 识别失败要如实进描述位，且不能记成成功。
//
// 留空的话渲染出来只是个裸占位，LLM 无从区分「有图没识别出来」和「本来没图」。
// ════════════════════════════════════════════════════════════
describe('识别失败的如实上报', () => {
  it('失败写进描述位，且 successCount 不增', async () => {
    const media = await import('../../packages/plugin-media/src/index.js');
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('llm', {
      id: 'fake/vision',
      capabilities: ['vision'],
      chat: async () => {
        throw new Error('图片全部获取失败（共 1 张），拒绝降级为纯文本请求');
      },
    });
    await app.ctx.useModule(media, {});
    await app.plugins.idle();

    const svc = app.ctx.getService<{
      processMessage: (m: unknown) => Promise<{ successCount: number; total: number }>;
    }>('media');
    const msg = { sessionId: 's', attachments: [{ kind: 'image', data: PNG_1PX, mimeType: 'image/png' }] };
    const report = await svc!.processMessage(msg);

    expect(report.total).toBe(1);
    expect(report.successCount).toBe(0);
    expect((msg as { _attachmentDescriptions?: string[] })._attachmentDescriptions?.[0]).toMatch(
      /图片：获取或识别失败/,
    );
  });
});
