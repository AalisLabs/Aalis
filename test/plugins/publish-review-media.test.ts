import { describe, expect, it } from 'vitest';
import { inspectMp4Probe, SandboxedMedia } from '../../packages/plugin-publish-review/src/media.js';

describe('publish review media checks', () => {
  it('rejects extra tracks and retained private metadata', () => {
    expect(inspectMp4Probe({ streams: [{ codec_type: 'video', tags: {} }], format: { tags: {} } })).toEqual({
      audio: false,
    });
    expect(() =>
      inspectMp4Probe({ streams: [{ codec_type: 'video' }, { codec_type: 'subtitle' }], format: {} }),
    ).toThrow();
    expect(() => inspectMp4Probe({ streams: [{ codec_type: 'video' }, { codec_type: 'data' }], format: {} })).toThrow();
    expect(() =>
      inspectMp4Probe({ streams: [{ codec_type: 'video', tags: { location: 'x' } }], format: {} }),
    ).toThrow();
    expect(() => inspectMp4Probe({ streams: [{ codec_type: 'video' }], format: { tags: { title: 'x' } } })).toThrow();
    expect(() =>
      inspectMp4Probe({ streams: [{ codec_type: 'video' }], format: { tags: { encoder: 'private' } } }),
    ).toThrow();
    expect(() =>
      inspectMp4Probe({ streams: [{ codec_type: 'video' }], format: { tags: { compatible_brands: 'secret' } } }),
    ).toThrow();
    expect(
      inspectMp4Probe({
        streams: [
          { codec_type: 'video', tags: { language: 'und', handler_name: 'VideoHandler', vendor_id: '[0][0][0][0]' } },
        ],
        format: { tags: { major_brand: 'isom', minor_version: '512', compatible_brands: 'isomiso2avc1mp41' } },
      }),
    ).toEqual({ audio: false });
  });
});

describe('sandboxed media contract', () => {
  it('uses one private output directory, no network, explicit demuxer and protocol whitelist for every command', async () => {
    const files = new Map<string, Buffer>();
    const calls: Array<{ cmd: string; args: string[]; policy: { network: string; fsWrite: string[] } }> = [];
    const storage = {
      mkdir: async (uri: string) => uri,
      writeFile: async (uri: string, data: Buffer) => {
        files.set(uri, Buffer.from(data));
      },
      readFile: async (uri: string) => files.get(uri) ?? Buffer.alloc(0),
      resolveLocalPath: async (uri: string) => `/private/${uri.slice('pluginData:/'.length)}`,
      list: async (uri: string) => ({
        entries: [...files.keys()]
          .filter(key => key.startsWith(`${uri}/`))
          .map(key => ({ uri: key, name: key.slice(uri.length + 1) })),
      }),
    };
    const uri = (path: string) => `pluginData:/${path.slice('/private/'.length)}`;
    const sandbox = {
      available: true,
      run: async (req: { cmd: string; args: string[]; policy: { network: string; fsWrite: string[] } }) => {
        calls.push(req);
        const output = req.args.at(-1)!;
        if (req.cmd === '/tools/ffprobe')
          return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }], format: { tags: {} } }) };
        files.set(uri(output), Buffer.from([1, 2, 3]));
        return { code: 0, stdout: '' };
      },
    };
    const media = new SandboxedMedia({
      storage: storage as never,
      sandbox: sandbox as never,
      ffmpegPath: '/tools/ffmpeg',
      id: 'abcdefghijklmnop',
      signal: new AbortController().signal,
    });
    const result = await media.stripMp4(Uint8Array.of(1, 2, 3));
    expect(result).toEqual({ bytes: Uint8Array.of(1, 2, 3), audio: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('0:v:0');
    expect(calls[0].args).toContain('0:a:0?');
    for (const call of calls) {
      expect(call.args).toContain('-protocol_whitelist');
      expect(call.args).toContain('-f');
      expect(call.policy.network).toBe('deny');
      expect(call.policy.fsWrite).toHaveLength(1);
      expect(call.policy.fsWrite[0]).toMatch(
        /^\/private\/publish-review\/items\/abcdefghijklmnop\/work\/[0-9a-f]{16}\/out$/,
      );
    }
    const retry = new SandboxedMedia({
      storage: storage as never,
      sandbox: sandbox as never,
      ffmpegPath: '/tools/ffmpeg',
      id: 'abcdefghijklmnop',
      signal: new AbortController().signal,
    });
    await retry.stripMp4(Uint8Array.of(4, 5, 6));
    expect(calls[2].args.at(-1)).not.toBe(calls[0].args.at(-1));
    expect(calls[2].policy.fsWrite[0]).not.toBe(calls[0].policy.fsWrite[0]);
  });

  it.each(['gif', 'mp4'] as const)('%s 命令成功却只解出部分源帧时拒绝结果', async ext => {
    const chunk = (type: string, value: Uint8Array) => {
      const bytes = Buffer.alloc(12 + value.length);
      bytes.writeUInt32BE(value.length, 0);
      bytes.write(type, 4);
      Buffer.from(value).copy(bytes, 8);
      let crc = -1;
      for (const byte of bytes.subarray(4, 8 + value.length)) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      bytes.writeUInt32BE((crc ^ -1) >>> 0, 8 + value.length);
      return bytes;
    };
    const frame = Buffer.concat([
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      chunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0)),
      chunk('IDAT', Uint8Array.of(1, 2, 3)),
      chunk('IEND', new Uint8Array()),
    ]);
    const files = new Map<string, Buffer>();
    let stderr = '[Parsed_showinfo_0 @ 0x1] n:   0 pts: 0\n';
    const storage = {
      mkdir: async (uri: string) => uri,
      writeFile: async (uri: string, value: Buffer) => {
        files.set(uri, Buffer.from(value));
      },
      readFile: async (uri: string) => files.get(uri) ?? Buffer.alloc(0),
      resolveLocalPath: async (uri: string) => `/private/${uri.slice('pluginData:/'.length)}`,
      list: async (uri: string) => ({
        entries: [...files.keys()]
          .filter(key => key.startsWith(`${uri}/frame-`))
          .map(key => ({ uri: key, name: key.slice(uri.length + 1) })),
      }),
    };
    const sandbox = {
      available: true,
      run: async (req: { cmd: string; args: string[] }) => {
        if (req.cmd.endsWith('ffprobe'))
          return { code: 0, stdout: JSON.stringify({ streams: [{ nb_read_frames: '5' }] }), stderr: '' };
        const output = req.args.at(-1)!;
        const frameUri = `pluginData:/${output.slice('/private/'.length).replace('frame-%012d.png', 'frame-000000000000.png')}`;
        files.set(frameUri, frame);
        return { code: 0, stdout: '', stderr };
      },
    };
    const media = new SandboxedMedia({
      storage: storage as never,
      sandbox: sandbox as never,
      ffmpegPath: '/tools/ffmpeg',
      id: 'abcdefghijklmnop',
      signal: new AbortController().signal,
    });
    await expect(media.extractFrames(Uint8Array.of(1, 2, 3), ext, 0.5)).rejects.toThrow('抽帧帧数不符');
    stderr = 'showinfo output missing or damaged';
    const retry = new SandboxedMedia({
      storage: storage as never,
      sandbox: sandbox as never,
      ffmpegPath: '/tools/ffmpeg',
      id: 'abcdefghijklmnop',
      signal: new AbortController().signal,
    });
    await expect(retry.extractFrames(Uint8Array.of(1, 2, 3), ext, 0.5)).rejects.toThrow('抽帧帧数无法核对');
  });
});
