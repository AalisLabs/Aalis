import type { Logger } from '@aalis/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import {
  descriptionKey,
  flushDescriptionCache,
  loadDescriptionCache,
  lookupCachedDescription,
  rememberDescription,
} from '../../packages/plugin-media/src/cache.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 图片描述去重：内容寻址键 + 落盘续命
//
// 附件落盘路径带会话名（`images/{session}/{sha256前16}.{ext}`），同一张表情包
// 在两个群会落成两条路径 → 改前各识别一次。改后**无上下文**的描述取路径里的内容
// 哈希做键，跨会话共用一条；**带会话上下文**的描述仍用原路径做键，只在本会话内
// 复用（否则 A 群的语境会随描述串到 B 群）。再加快照落盘，进程重启也不必重认。
// 识别一次静态图十几秒、动图近一分钟，这是纯赚的算力。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

/** 无提供者的能力桩：识别走外部注册的 processor，其余能力一律缺席 */
const caps = emptyMediaCaps(logger);

/** 内存 storage：只实现 cache.ts 用到的两个方法，够用即可。 */
const files = new Map<string, string>();
const fakeStorage = {
  readFile: async (uri: string) => {
    const v = files.get(uri);
    if (v === undefined) throw new Error(`ENOENT: ${uri}`);
    return v;
  },
  writeFile: async (uri: string, data: string | Buffer) => {
    files.set(uri, typeof data === 'string' ? data : data.toString('utf8'));
  },
};
const SNAPSHOT_URI = 'data:/media/descriptions.json';

function makeSvc(over: Record<string, unknown> = {}): { svc: MediaServiceImpl; describeCount: () => number } {
  let n = 0;
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
    ...over,
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(caps, cfg);
  svc.registerProcessor({
    name: 'fake-vision',
    capabilities: ['vision'],
    priority: 10,
    describe: async () => {
      n++;
      return { descriptions: ['一只橘猫'] };
    },
  } as MediaProcessor);
  return { svc, describeCount: () => n };
}

function msgIn(session: string, data: string): IncomingMessage {
  return {
    content: '[图片]',
    sessionId: session,
    platform: 'onebot',
    attachments: [{ kind: 'image', data }],
  } as IncomingMessage;
}

describe('descriptionKey：只认落盘布局，不做宽泛猜测', () => {
  it('内容寻址路径 → 取内容哈希（相对路径与 storage URI 同键）', () => {
    expect(descriptionKey('data/images/onebot_g_1/0123456789abcdef.gif')).toBe('0123456789abcdef');
    expect(descriptionKey('data:/images/onebot_g_1/0123456789abcdef.gif')).toBe('0123456789abcdef');
  });

  it('同一内容在不同会话目录下同键——表情包跨群只识别一次', () => {
    const a = descriptionKey('data/images/onebot_g_111/89abcdef01234567.jpg');
    const b = descriptionKey('data/images/onebot_g_222/89abcdef01234567.jpg');
    expect(a).toBe(b);
  });

  it('其它 kind 目录同样适用（视频/音频/文件走同一落盘布局）', () => {
    expect(descriptionKey('data/videos/s/aaaabbbbccccdddd.mp4')).toBe('aaaabbbbccccdddd');
  });

  it('非内容寻址来源原样做键：远端 URL 结尾像哈希也不误判', () => {
    const url = 'https://example.invalid/pic/0123456789abcdef.jpg';
    expect(descriptionKey(url)).toBe(url);
    const dataUri = 'data:image/png;base64,AAAA';
    expect(descriptionKey(dataUri)).toBe(dataUri);
    // 层级不符（缺会话目录）也不当内容寻址
    expect(descriptionKey('images/0123456789abcdef.jpg')).toBe('images/0123456789abcdef.jpg');
  });

  it('哈希长度不符（非 16 位十六进制）不当内容寻址——旧键行为保持', () => {
    const p = 'data/images/onebot_g_1/cachetest1.jpg';
    expect(descriptionKey(p)).toBe(p);
  });
});

describe('带会话上下文的描述不跨会话共享（防语境串台）', () => {
  it('contextHistory 开启时：同一张图在另一个群重新识别，不复用前一个群的描述', async () => {
    // 描述里可能掺进 A 群的近期对话与发送者画像（vision prompt 带 context），
    // 复用到 B 群等于把 A 群语境搬过去。这类描述退回会话内私有键。
    const { svc, describeCount } = makeSvc({ contextHistory: { enabled: true, maxMessages: 4 } });
    const p = (session: string) => `data/images/${session}/aaaa1111bbbb2222.jpg`;
    await svc.processMessage(msgIn('onebot:t:group:A', p('onebot_t_group_A')));
    await svc.processMessage(msgIn('onebot:t:group:B', p('onebot_t_group_B')));
    expect(describeCount(), '带上下文的描述不该跨群复用').toBe(2);
    // 同一个群里仍然复用，去重收益不丢
    await svc.processMessage(msgIn('onebot:t:group:A', p('onebot_t_group_A')));
    expect(describeCount()).toBe(2);
  });
});

describe('跨会话去重（真实 processMessage 全流）', () => {
  it('同一张图先后出现在两个群：模型只被调用一次', async () => {
    const { svc, describeCount } = makeSvc();
    const hashPath = (session: string) => `data/images/${session}/1111222233334444.jpg`;
    const first = await svc.processMessage(msgIn('onebot:t:group:A', hashPath('onebot_t_group_A')));
    expect(describeCount()).toBe(1);
    expect(first.items[0].description).toContain('一只橘猫');

    const second = await svc.processMessage(msgIn('onebot:t:group:B', hashPath('onebot_t_group_B')));
    expect(describeCount(), '第二个群命中缓存，不该再调模型').toBe(1);
    // 命中分支按归档形态重新包装，与首次识别的描述位完全同构（命中≠丢格式）。
    // 这里 att.data 是适配器给的相对路径（非 storage URI），cacheImageRef 返回 null，
    // 两次都落 `[图片描述] …` 形态；ref 标记由适配器改写消息文本时另行给出。
    expect(second.items[0].description).toBe(first.items[0].description);
    expect(second.items[0].description).toContain('一只橘猫');
  });
});

describe('落盘续命', () => {
  beforeAll(() => {
    setMediaRuntime({ proc: {} as never, storage: fakeStorage as never });
  });

  it('快照可灌回：本进程从未识别过的内容也能命中', async () => {
    files.set(SNAPSHOT_URI, JSON.stringify([['ffff0000ffff0000', '上一次进程识别出的描述']]));
    const n = await loadDescriptionCache(logger as never);
    expect(n).toBe(1);
    expect(lookupCachedDescription('data/images/any_session/ffff0000ffff0000.png')).toBe('上一次进程识别出的描述');
  });

  it('flush 写出的是内容哈希键，重启后另一个会话也能命中', async () => {
    rememberDescription('data/images/onebot_t_group_X/5555666677778888.gif', '会跳舞的猫');
    await flushDescriptionCache();
    const dumped = JSON.parse(files.get(SNAPSHOT_URI) as string) as Array<[string, string]>;
    expect(dumped.some(([k, v]) => k === '5555666677778888' && v === '会跳舞的猫')).toBe(true);
  });

  it('带会话上下文的描述（本地落盘路径键）与详略档键也进快照；base64 / 远端 URL 键不进', async () => {
    // contextHistory 默认开启，到达识别走的是会话私有键（落盘路径原串）；快照若只收内容哈希键，
    // 这类描述重启即丢，缓存形同虚设。
    const privatePath = 'data:/images/onebot_t_group_Y/1234abcd1234abcd.jpg';
    const legacyPath = 'data/images/onebot_t_group_Y/abcd1234abcd1234.jpg';
    rememberDescription(privatePath, '群里的截图', false);
    rememberDescription(legacyPath, '群里的旧路径截图', false);
    rememberDescription('data:image/png;base64,QUFBQQ==', '上传的图', false);
    rememberDescription('https://example.invalid/pic/abcdef0123456789.jpg', '远端图', false);
    // 详略档后缀（`#detailed`）接在键尾，判定前须剥掉，否则两种键形态都认不出
    rememberDescription(privatePath, '群里的截图（详）', false, 'detailed');
    rememberDescription('data:/images/onebot_t_group_Y/c0ffee00c0ffee00.jpg', '共享的图（详）', true, 'detailed');
    await flushDescriptionCache();
    const dumped = JSON.parse(files.get(SNAPSHOT_URI) as string) as Array<[string, string]>;
    expect(dumped.some(([k, v]) => k === privatePath && v === '群里的截图')).toBe(true);
    expect(dumped.some(([k, v]) => k === legacyPath && v === '群里的旧路径截图')).toBe(true);
    expect(dumped.some(([k, v]) => k === `${privatePath}#detailed` && v === '群里的截图（详）')).toBe(true);
    expect(dumped.some(([k, v]) => k === 'c0ffee00c0ffee00#detailed' && v === '共享的图（详）')).toBe(true);
    expect(dumped.some(([k]) => k.startsWith('data:image/'))).toBe(false);
    expect(dumped.some(([k]) => k.startsWith('https://'))).toBe(false);
  });

  it('占位符与空串不入快照（失败的识别不该被当成结果长期复用）', async () => {
    rememberDescription('data/images/onebot_t_group_X/9999888877776666.gif', '[图片: 识别失败]');
    rememberDescription('data/images/onebot_t_group_X/6666777788889999.gif', '');
    await flushDescriptionCache();
    const dumped = JSON.parse(files.get(SNAPSHOT_URI) as string) as Array<[string, string]>;
    expect(dumped.some(([k]) => k === '9999888877776666')).toBe(false);
    expect(dumped.some(([k]) => k === '6666777788889999')).toBe(false);
  });

  it('快照损坏/缺失只降级为不复用，不抛错', async () => {
    files.set(SNAPSHOT_URI, '{ 这不是 JSON');
    await expect(loadDescriptionCache(logger as never)).resolves.toBe(0);
    files.delete(SNAPSHOT_URI);
    await expect(loadDescriptionCache(logger as never)).resolves.toBe(0);
  });
});
