import type { Context, Logger } from '@aalis/core';
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

// ════════════════════════════════════════════════════════════
// 图片描述去重：内容寻址键 + 落盘续命
//
// 附件落盘路径带会话名（`images/{session}/{sha256前16}.{ext}`），同一张表情包
// 在两个群会落成两条路径 → 改前各识别一次。改后取路径里的内容哈希做键，
// 跨会话共用一条；再加快照落盘，进程重启也不必重认。
// 识别一次静态图十几秒、动图近一分钟，这是纯赚的算力。
// ════════════════════════════════════════════════════════════

const ctx = { getAllServices: () => [], getService: () => undefined } as unknown as Context;
const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

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

function makeSvc(): { svc: MediaServiceImpl; describeCount: () => number } {
  let n = 0;
  const cfg = {
    vision: { mode: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(ctx, logger, cfg);
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
