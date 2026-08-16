import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { Context } from '../../packages/core/src/index.js';
import type { ForwardMediaTask } from '../../packages/plugin-adapter-onebot/src/forward.js';
import { expandForward } from '../../packages/plugin-adapter-onebot/src/forward.js';
import type { ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import { createForwardExpander } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';

// ════════════════════════════════════════════════════════════
// 合并转发媒体两阶段解析——「先落盘后识别」结构保证。
//
// 事故背景：旧结构在节点串行渲染中内联 await 识别，第 N 张图的「取媒体源」
// 排在前面所有识别之后；QQ 媒体 URL 的 rkey 短时效，识别队列一深（本机视觉
// 模型饱和时排几十分钟）URL 即过期，实测一晚 61 图连环 400。
// 契约：walk 只收集任务（零模型等待）→ resolveMedia 一次性拿到全部任务
// → 下载先行（趁 URL 新鲜）→ 识别受限并发消化。本文件钉死这条结构。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

/** 造一个 node 节点：content 为消息段数组 */
function node(nick: string, uid: string, content: unknown[]): unknown {
  return { type: 'node', data: { nickname: nick, user_id: uid, content } };
}

const img = (url: string) => ({ type: 'image', data: { url } });
const txt = (text: string) => ({ type: 'text', data: { text } });

// ───────────────────────── forward.ts 纯逻辑 ─────────────────────────

describe('expandForward 两阶段媒体解析（纯逻辑）', () => {
  const baseOpts = {
    fetchForward: async () => null,
    maxDepth: 3,
    maxNodesPerLevel: 30,
    imageRecognitionEnabled: true,
  };

  it('walk 收集全部任务后一次性交给 resolveMedia，描述回填进 fullText', async () => {
    const seen: ForwardMediaTask[][] = [];
    const resolveMedia = async (tasks: ForwardMediaTask[]) => {
      seen.push(tasks);
      return new Map(tasks.map(t => [t.token, `描述<${t.src}>`]));
    };
    const nodes = [
      node('甲', '1', [txt('看图'), img('http://a/1.jpg')]),
      node('乙', '2', [img('http://a/2.jpg'), { type: 'record', data: { url: 'http://a/3.amr' } }]),
    ];
    const r = await expandForward('F1', nodes, { ...baseOpts, resolveMedia });

    // 一次性拿到全部 3 个任务（跨节点收集，而非逐节点逐个）
    expect(seen).toHaveLength(1);
    expect(seen[0].map(t => t.kind)).toEqual(['image', 'image', 'audio']);
    expect(r.fullText).toContain('[图片: 描述<http://a/1.jpg>]');
    expect(r.fullText).toContain('[图片: 描述<http://a/2.jpg>]');
    expect(r.fullText).toContain('[语音: 描述<http://a/3.amr>]');
    expect(r.fullText).not.toContain('\u0000'); // token 不外泄
  });

  it('CQ 字符串节点的媒体段同样进任务收集', async () => {
    const resolveMedia = async (tasks: ForwardMediaTask[]) => new Map(tasks.map(t => [t.token, `D${t.kind}`]));
    const nodes = [node('甲', '1', undefined as unknown as unknown[])];
    (nodes[0] as { data: Record<string, unknown> }).data.content =
      '看[CQ:image,file=x,url=http://a/cq.jpg]和[CQ:record,url=http://a/cq.amr]';
    const r = await expandForward('F1', nodes, { ...baseOpts, resolveMedia });
    expect(r.fullText).toContain('[图片: Dimage]');
    expect(r.fullText).toContain('[语音: Daudio]');
    expect(r.fullText).not.toContain('\u0000');
  });

  it('嵌套转发内的媒体也在同一批任务里（结构遍历先于一切识别）', async () => {
    const seen: ForwardMediaTask[][] = [];
    const resolveMedia = async (tasks: ForwardMediaTask[]) => {
      seen.push(tasks);
      return new Map(tasks.map(t => [t.token, 'D']));
    };
    const nested = [node('丙', '3', [img('http://a/nested.jpg')])];
    const nodes = [
      node('甲', '1', [img('http://a/top.jpg'), { type: 'forward', data: { id: 'F2', content: nested } }]),
    ];
    const r = await expandForward('F1', nodes, { ...baseOpts, resolveMedia });
    expect(seen).toHaveLength(1);
    expect(seen[0].map(t => t.src)).toEqual(['http://a/top.jpg', 'http://a/nested.jpg']);
    expect(r.fullText).not.toContain('\u0000');
  });

  it('无 resolveMedia / 结果缺席 / resolveMedia 整体抛错 → 占位符兜底，展开不失败', async () => {
    const nodes = [node('甲', '1', [img('http://a/1.jpg')])];
    const noResolver = await expandForward('F1', nodes, { ...baseOpts });
    expect(noResolver.fullText).toContain('[图片]');

    const missing = await expandForward('F1', nodes, { ...baseOpts, resolveMedia: async () => new Map() });
    expect(missing.fullText).toContain('[图片]');

    const throwing = await expandForward('F1', nodes, {
      ...baseOpts,
      resolveMedia: async () => {
        throw new Error('boom');
      },
    });
    expect(throwing.fullText).toContain('[图片]');
    expect(throwing.fullText).not.toContain('\u0000');
  });

  it('图片识别关闭时不产生图片任务（音频不受影响）', async () => {
    const seen: ForwardMediaTask[][] = [];
    const resolveMedia = async (tasks: ForwardMediaTask[]) => {
      seen.push(tasks);
      return new Map(tasks.map(t => [t.token, 'D']));
    };
    const nodes = [node('甲', '1', [img('http://a/1.jpg'), { type: 'record', data: { url: 'http://a/2.amr' } }])];
    const r = await expandForward('F1', nodes, { ...baseOpts, imageRecognitionEnabled: false, resolveMedia });
    expect(seen[0].map(t => t.kind)).toEqual(['audio']);
    expect(r.fullText).toContain('[图片]');
    expect(r.fullText).toContain('[语音: D]');
  });

  it('审计闭环：非文本入口（at/share/昵称/未知段）的 NUL 一律被剥——零任务时也不泄漏', async () => {
    const resolveMedia = async (tasks: ForwardMediaTask[]) => new Map(tasks.map(t => [t.token, 'D']));
    const evil = 'A\u0000M0\u0000B';
    const nodes = [
      {
        type: 'node',
        data: {
          nickname: `坏\u0000人`,
          user_id: '1',
          content: [
            { type: 'at', data: { qq: evil } },
            { type: 'share', data: { title: evil } },
            { type: 'weird\u0000seg', data: {} },
          ],
        },
      },
    ];
    const r = await expandForward('F1', nodes, { ...baseOpts, resolveMedia });
    expect(r.fullText).not.toContain('\u0000');
    expect(r.participants.join()).not.toContain('\u0000');
  });

  it('审计闭环：攻击者段伪造 token 无法搬运他人识别结果（有真实任务时）', async () => {
    const resolveMedia = async (tasks: ForwardMediaTask[]) => new Map(tasks.map(t => [t.token, `秘密描述`]));
    const nodes = [
      node('甲', '1', [img('http://a/real.jpg')]),
      node('乙', '2', [{ type: 'share', data: { title: '\u0000M0\u0000' } }]),
    ];
    const r = await expandForward('F1', nodes, { ...baseOpts, resolveMedia });
    const lines = r.fullText.split('\n');
    expect(lines[0]).toContain('[图片: 秘密描述]');
    expect(lines[1]).not.toContain('秘密描述'); // share.title 的 NUL 被剥，只剩无害的 M0 文本
    expect(r.fullText).not.toContain('\u0000');
  });

  it('审计闭环：resolveMedia 返回值形态失约（非 Map）→ 占位符兜底，展开不失败', async () => {
    const nodes = [node('甲', '1', [img('http://a/1.jpg')])];
    const r = await expandForward('F1', nodes, {
      ...baseOpts,
      resolveMedia: (async () => null) as unknown as (typeof baseOpts & { resolveMedia: unknown })['resolveMedia'],
    } as Parameters<typeof expandForward>[2]);
    expect(r.fullText).toContain('[图片]');
    expect(r.fullText).not.toContain('\u0000');
  });
});

// ───────────────────── forward-expand 解析器（下载先行） ─────────────────────

interface Harness {
  expander: ReturnType<typeof createForwardExpander<object>>;
  writes: string[];
  describeCalls: string[];
  describeDone: number;
  releaseDescribe: () => void;
  infoLogs: string[];
}

function makeHarness(overrides: Partial<ForwardConfig> = {}, opts: { brokenDownload?: boolean } = {}): Harness {
  const writes: string[] = [];
  const describeCalls: string[] = [];
  const infoLogs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });

  const h: Harness = {
    expander: undefined as unknown as Harness['expander'],
    writes,
    describeCalls,
    describeDone: 0,
    releaseDescribe: release,
    infoLogs,
  };

  const media: Partial<MediaService> = {
    describeImage: async (src: string) => {
      describeCalls.push(src);
      await gate;
      h.describeDone++;
      return `图述<${src.slice(0, 24)}>`;
    },
  };
  const storage = {
    writeFile: async (uri: string) => {
      writes.push(uri);
    },
  };
  const proc = {
    readExternalFile: async () => {
      throw new Error('测试环境无外部文件');
    },
    makeTempDir: async () => {
      throw new Error('测试不落 temp');
    },
  };
  const services: Record<string, unknown> = {
    media,
    storage: opts.brokenDownload ? undefined : storage,
    process: opts.brokenDownload ? undefined : proc,
  };
  const ctx = {
    getService: (name: string) => services[name],
    logger: {
      info: (msg: string) => {
        infoLogs.push(msg);
      },
      debug: () => {},
      warn: () => {},
    },
  } as unknown as Context;

  const forwardCfg: ForwardConfig = {
    enabled: true,
    maxDepth: 3,
    maxNodesPerLevel: 30,
    imageRecognition: true,
    imageRecognitionConcurrency: 2,
    recognitionMaxItems: 32,
    summarize: false,
    summaryMaxChars: 600,
    summaryInputLimit: 8000,
    summaryPrompt: '',
    ...overrides,
  };

  h.expander = createForwardExpander<object>({
    ctx,
    forwardCfg,
    attachmentMaxBytes: 20 * 1024 * 1024,
    sendAction: async (_state, action) => {
      if (action !== 'get_forward_msg') throw new Error(`意外 action: ${action}`);
      return { messages: HARNESS_NODES };
    },
  });
  return h;
}

/** 5 张图，data URI 源（无网络即可被 loadAttachmentBuffer 解码落盘） */
const PNG_B64 = Buffer.from('fake-image-bytes-for-hashing').toString('base64');
const HARNESS_NODES = Array.from({ length: 5 }, (_, i) =>
  node(`人${i}`, String(i), [txt(`第${i}条`), img(`data:image/png;base64,${PNG_B64}${'A'.repeat(i * 4)}`)]),
);
const FORWARD_TEXT = '<forward id="F1">[合并转发消息]</forward>';

describe('forward-expand 两阶段解析器（下载先行、识别受限并发）', () => {
  it('全部图片在任何识别完成之前就已落盘——下载不排在识别队列后面', async () => {
    const h = makeHarness();
    const pending = h.expander.expandForwardsInText({}, FORWARD_TEXT, undefined, 'onebot:test:group:1');

    // 识别被闸门卡住（0 完成、至多 concurrency=2 在飞）时，5 张图应全部完成落盘。
    // 旧结构（节点串行+内联识别）下这里最多落 2 张——本断言是结构差异的判别锚。
    expect(await waitFor(() => h.writes.filter(w => w.includes('/images/')).length === 5)).toBe(true);
    expect(h.describeDone).toBe(0);
    expect(h.describeCalls.length).toBeLessThanOrEqual(2);

    h.releaseDescribe();
    const out = await pending;
    expect(out).toContain('[图片: 图述<');
    expect(out).not.toContain('\u0000');
    expect(h.describeCalls).toHaveLength(5);
  });

  it('识别收到的是落盘后的本地相对路径，而非原始 URL（rkey 过期从此无关）', async () => {
    const h = makeHarness();
    const pending = h.expander.expandForwardsInText({}, FORWARD_TEXT, undefined, 'onebot:test:group:1');
    await waitFor(() => h.describeCalls.length > 0);
    h.releaseDescribe();
    await pending;
    for (const src of h.describeCalls) {
      expect(src).toMatch(/^data\/images\/onebot_test_group_1\//);
    }
  });

  it('recognitionMaxItems 截断：超出项不识别、占位符保留、日志点名', async () => {
    const h = makeHarness({ recognitionMaxItems: 2 });
    const pending = h.expander.expandForwardsInText({}, FORWARD_TEXT, undefined, 'onebot:test:group:1');
    await waitFor(() => h.describeCalls.length === 2);
    h.releaseDescribe();
    const out = await pending;
    expect(h.describeCalls).toHaveLength(2);
    expect((out.match(/\[图片: 图述</g) ?? []).length).toBe(2);
    expect((out.match(/\[图片\]/g) ?? []).length).toBe(3);
    expect(h.infoLogs.some(l => l.includes('超出上限'))).toBe(true);
  });

  it('审计闭环：同一条消息多个 forward id 并行展开——第二条的落盘不等第一条的识别', async () => {
    const h = makeHarness();
    const TWO = '<forward id="F1">[合并转发消息]</forward><forward id="F2">[合并转发消息]</forward>';
    const pending = h.expander.expandForwardsInText({}, TWO, undefined, 'onebot:test:group:1');

    // 识别闸门卡死（0 完成、至多 2 在飞）时，两条转发共 10 次落盘应全部完成。
    // 串行 for 变异下 F2 的 5 张一个都不会落——审计探针实测形状。
    expect(await waitFor(() => h.writes.filter(w => w.includes('/images/')).length === 10)).toBe(true);
    expect(h.describeDone).toBe(0);
    expect(h.describeCalls.length).toBeLessThanOrEqual(2);

    h.releaseDescribe();
    const out = await pending;
    expect(out).toContain('[图片: 图述<');
    expect(h.describeCalls).toHaveLength(10);
  });

  it('落盘不可用（storage/process 缺席）→ 回退原始 src 识别，不阻塞展开', async () => {
    const h = makeHarness({}, { brokenDownload: true });
    const pending = h.expander.expandForwardsInText({}, FORWARD_TEXT, undefined, 'onebot:test:group:1');
    await waitFor(() => h.describeCalls.length > 0);
    h.releaseDescribe();
    const out = await pending;
    expect(out).toContain('[图片: 图述<');
    for (const src of h.describeCalls) {
      expect(src.startsWith('data:image/png;base64,')).toBe(true);
    }
  });
});
