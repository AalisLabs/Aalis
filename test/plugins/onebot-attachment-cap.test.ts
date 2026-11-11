import { describe, expect, it } from 'vitest';
import { readBodyCapped } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';

// ════════════════════════════════════════════════════════════
// 入站附件下载流式限额：无 Content-Length 时也不会全量缓冲耗尽内存。
// ════════════════════════════════════════════════════════════

function fakeRes(chunks: Uint8Array[], contentLength?: number): Response {
  let i = 0;
  return {
    ok: true,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null,
    },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

describe('readBodyCapped 流式限额', () => {
  it('流式累计超 maxBytes → 早退返回 null（不全量缓冲）', async () => {
    expect(await readBodyCapped(fakeRes([new Uint8Array(600), new Uint8Array(600)]), 1000)).toBeNull();
  });

  it('Content-Length 头即超限 → 立即拒，不拉取', async () => {
    expect(await readBodyCapped(fakeRes([], 99999), 1000)).toBeNull();
  });

  it('在 maxBytes 内 → 返回完整 buffer', async () => {
    const buf = await readBodyCapped(fakeRes([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), 1000);
    expect(buf?.length).toBe(5);
  });
});

// ── SILK 短路：QQ 语音原生格式 ffmpeg 无解码器，转码前就地跳过，不 spawn 子进程 ──

import { cacheOneAttachment } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';

describe('cacheOneAttachment SILK 短路', () => {
  it('SILK 音频：不尝试转码（makeTempDir 零调用）、返回 null 保留原 URL', async () => {
    const silk = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.alloc(16)]);
    const source = `data:audio/silk;base64,${silk.toString('base64')}`;
    const storage = { writeFile: async () => {} };
    const proc = {
      makeTempDir: async () => {
        throw new Error('不应触发转码（SILK 应在 ffmpeg 之前短路）');
      },
    };
    const warns: string[] = [];
    const out = await cacheOneAttachment(
      storage as never,
      proc as never,
      'audio',
      source,
      'onebot:t:group:1',
      1024 * 1024,
      { warn: (m: string) => warns.push(m) },
      new AbortController().signal,
    );
    expect(out).toBeNull();
    expect(warns.some(w => w.includes('SILK'))).toBe(true);
  });
});

// ── 转码的输入：ffmpeg 按内容探测格式，临时文件一律叫 in.bin ──

describe('cacheOneAttachment 语音转码', () => {
  it('交给 ffmpeg 的临时文件叫 in.bin，不按判定的格式起扩展名', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(16)]);
    const written: string[] = [];
    const inputs: string[] = [];
    const out = await cacheOneAttachment(
      {
        writeFile: async (uri: string) => void written.push(uri),
        readFile: async () => Buffer.alloc(300),
      } as never,
      {
        makeTempDir: async () => ({ uri: 'tmp:/t', path: '/zz-tmp/t', cleanup: async () => {} }),
        execFile: async (_cmd: string, args: string[]) => {
          inputs.push(args[args.indexOf('-i') + 1]);
          return { stdout: '', stderr: '' };
        },
      } as never,
      'audio',
      `data:audio/mpeg;base64,${mp3.toString('base64')}`,
      'onebot:t:group:1',
      1024 * 1024,
      { warn: () => {} },
      new AbortController().signal,
    );
    expect(out?.endsWith('.wav')).toBe(true);
    expect(written[0]).toBe('tmp:/t/in.bin');
    expect(inputs).toEqual(['/zz-tmp/t/in.bin']);
  });
});

// ── 大小闸必须覆盖全部来源：此前只有 http 分支真限额 ──

describe('cacheOneAttachment 大小闸覆盖全部来源', () => {
  it('storage 来源：先 stat 再决定，超限不读进内存', async () => {
    let readCalled = false;
    const storage = {
      stat: async () => ({ size: 50 * 1024 * 1024 }),
      readFile: async () => {
        readCalled = true;
        return new Uint8Array(0);
      },
      writeFile: async () => {},
    };
    const out = await cacheOneAttachment(
      storage as never,
      {} as never,
      'file',
      'data:/files/big.bin',
      'onebot:t:group:1',
      1024 * 1024,
      { warn: () => {} },
      new AbortController().signal,
    );
    expect(out).toBeNull();
    expect(readCalled, '超限文件被整份读进内存 = 无谓地占用一次峰值内存，正是这条要挡的').toBe(false);
  });

  it('storage 来源：未超限照常读取', async () => {
    const storage = {
      stat: async () => ({ size: 3 }),
      readFile: async () => new Uint8Array([1, 2, 3]),
      writeFile: async () => {},
    };
    const out = await cacheOneAttachment(
      storage as never,
      {} as never,
      'file',
      'data:/files/small.bin',
      'onebot:t:group:1',
      1024 * 1024,
      { warn: () => {} },
      new AbortController().signal,
    );
    expect(out, '正常大小不该被误拒').not.toBeNull();
  });

  it('OS 绝对路径来源：maxBytes 透传给 readExternalFile', async () => {
    const seen: Array<number | undefined> = [];
    const proc = {
      readExternalFile: async (_path: string, maxBytes?: number) => {
        seen.push(maxBytes);
        throw new Error('外部文件超过上限');
      },
    };
    const out = await cacheOneAttachment(
      { writeFile: async () => {} } as never,
      proc as never,
      'file',
      '/var/napcat/cache/big.mp4',
      'onebot:t:group:1',
      1024 * 1024,
      { warn: () => {} },
      new AbortController().signal,
    );
    expect(out).toBeNull();
    expect(seen, '不透传上限的话，实现侧无从预检，只能整份读完再判').toEqual([1024 * 1024]);
  });
});

// ── 落盘扩展名取文件头判定的格式，认不出的落 .bin，不按附件种类猜 ──

describe('cacheOneAttachment 落盘扩展名', () => {
  const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const MOV = Buffer.from([...be32(20), ...Buffer.from('ftypqt  '), 0, 0, 0, 0, ...Buffer.from('qt  ')]);
  const MKV = Buffer.from([
    ...[0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01],
    ...[0x42, 0x82, 0x88],
    ...Buffer.from('matroska'),
  ]);

  it.each([
    ['video', 'MOV', '.mov', MOV],
    ['video', 'MKV', '.mkv', MKV],
    ['image', '认不出的字节', '.bin', Buffer.from('placeholder bytes, not media')],
  ] as const)('%s 附件装 %s：落盘地址以 %s 结尾', async (kind, _label, ext, data) => {
    const written: string[] = [];
    const out = await cacheOneAttachment(
      { writeFile: async (uri: string) => void written.push(uri) } as never,
      {} as never,
      kind,
      `data:application/octet-stream;base64,${data.toString('base64')}`,
      'onebot:t:group:1',
      1024 * 1024,
      { warn: () => {} },
      new AbortController().signal,
    );
    expect(out?.endsWith(ext)).toBe(true);
    expect(written).toEqual([out]);
  });
});

// ── 中止：下载与转码途中中止时抛中止原因，不按取不到、转不了处理 ──

describe('cacheOneAttachment 中止', () => {
  it('读取途中中止、随后读取出错：抛中止原因，不当成取不到', async () => {
    const ac = new AbortController();
    const pending = cacheOneAttachment(
      { writeFile: async () => {} } as never,
      {
        readExternalFile: async () => {
          ac.abort(new Error('zz-停用'));
          throw new Error('读到一半断了');
        },
      } as never,
      'file',
      '/zz-napcat/cache/a.bin',
      'onebot:t:group:1',
      1024 * 1024,
      { warn: () => {} },
      ac.signal,
    );
    await expect(pending).rejects.toThrow('zz-停用');
  });

  it('转码途中中止：抛中止原因，不记「转 WAV 失败」', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(16)]);
    const ac = new AbortController();
    const warns: string[] = [];
    let transcoding = false;
    const pending = cacheOneAttachment(
      { writeFile: async () => {} } as never,
      {
        makeTempDir: async () => ({ uri: 'tmp:/t', path: '/zz-tmp/t', cleanup: async () => {} }),
        execFile: (_cmd: string, _args: string[], opts: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            transcoding = true;
            const stopped = new Error('execFile ffmpeg 退出码 null (signal SIGTERM)');
            opts.signal?.addEventListener('abort', () => reject(stopped), { once: true });
          }),
      } as never,
      'audio',
      `data:audio/mpeg;base64,${mp3.toString('base64')}`,
      'onebot:t:group:1',
      1024 * 1024,
      { warn: (m: string) => warns.push(m) },
      ac.signal,
    );
    await expect.poll(() => transcoding).toBe(true);
    ac.abort(new Error('zz-停用'));
    await expect(pending).rejects.toThrow('zz-停用');
    expect(warns).toEqual([]);
  });
});
