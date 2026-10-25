// ============================================================
// ffmpeg.ts — 视频/动图帧提取工具
//
// 通过 api-process + api-storage 委托子进程与临时目录。
// 业务调用方仍以纯函数形式使用，运行时通过 setMediaRuntime() 注入实现。
// ============================================================

import { Buffer } from 'node:buffer';
import { isStorageUri } from '@aalis/api-storage';
import { detectMediaFormat, FILE_HEAD_BYTES, isAnimatedImage } from '@aalis/util-file-signature';
import { getMediaRuntime } from './runtime.js';
import { safeFetchBuffer } from './safe-fetch.js';

/** 要抽帧的媒体：视频容器，或多帧的 GIF、APNG 与动态 WebP；单帧的 GIF 与别的图片按静图。扩展名与写着的类型都不看 */
export function needsFrames(bytes: Uint8Array): boolean {
  return detectMediaFormat(bytes.subarray(0, FILE_HEAD_BYTES))?.kind === 'video' || isAnimatedImage(bytes);
}

/**
 * 来源的字节：base64 data URL 解码，file:// 经 process 读，网址经 safeFetchBuffer 下载（20 MiB 上限，随 signal 停下），
 * 存储地址经 storage 读。别的形态与读不出的为 null：调用方按静图交给识别或规范化，取不到由它们报出
 */
export async function readSourceBytes(data: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const dataUri = data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUri) return Buffer.from(dataUri[1], 'base64');
    if (data.startsWith('file://')) return await getMediaRuntime().proc.readExternalFile(data);
    if (/^https?:\/\//i.test(data)) return await safeFetchBuffer(data, { signal });
    if (isStorageUri(data)) return (await getMediaRuntime().storage.readFile(data)) as Uint8Array;
    return null;
  } catch {
    return null;
  }
}

export function selectFrameIndices(totalFrames: number, maxFrames: number): number[] {
  if (totalFrames <= 0) return [];
  if (totalFrames === 1) return [0];
  if (totalFrames <= maxFrames) return Array.from({ length: totalFrames }, (_, i) => i);
  const indices: number[] = [0];
  const innerCount = maxFrames - 2;
  for (let i = 1; i <= innerCount; i++) {
    indices.push(Math.round((i * (totalFrames - 1)) / (maxFrames - 1)));
  }
  indices.push(totalFrames - 1);
  return [...new Set(indices)].sort((a, b) => a - b);
}

export async function getFrameCount(filePath: string): Promise<number> {
  const { proc } = getMediaRuntime();
  try {
    const r = await proc.execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'csv=p=0',
        filePath,
      ],
      { timeout: 30000 },
    );
    const n = Number.parseInt(r.stdout.trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** 提取指定帧为 PNG，返回 data URI 数组。 */
export async function extractFrames(filePath: string, frameIndices: number[]): Promise<string[]> {
  if (frameIndices.length === 0) return [];
  const { proc, storage } = getMediaRuntime();
  const tmp = await proc.makeTempDir('media-frames');
  try {
    const selectExpr = frameIndices.map(i => `eq(n\\,${i})`).join('+');
    await proc.execFile(
      'ffmpeg',
      [
        '-i',
        filePath,
        '-vf',
        `select='${selectExpr}'`,
        '-vsync',
        'vfr',
        '-f',
        'image2',
        '-y',
        `${tmp.path}/frame_%04d.png`,
      ],
      { timeout: 60000 },
    );
    const results: string[] = [];
    for (let i = 1; i <= frameIndices.length; i++) {
      const name = `frame_${String(i).padStart(4, '0')}.png`;
      try {
        const buf = await storage.readFile(`${tmp.uri}/${name}`);
        results.push(`data:image/png;base64,${Buffer.from(buf as Uint8Array).toString('base64')}`);
      } catch {
        // 该帧可能不存在
      }
    }
    return results;
  } finally {
    await tmp.cleanup();
  }
}

/** 抽取视频音轨为 mp3。返回 data URI 或 null（失败/无音轨）。 */
export async function extractAudioTrack(filePath: string): Promise<string | null> {
  const { proc, storage } = getMediaRuntime();
  const tmp = await proc.makeTempDir('media-audio');
  try {
    const outUri = `${tmp.uri}/audio.mp3`;
    const outLocal = `${tmp.path}/audio.mp3`;
    await proc.execFile(
      'ffmpeg',
      ['-i', filePath, '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-ar', '16000', '-y', outLocal],
      { timeout: 120000 },
    );
    const buf = (await storage.readFile(outUri)) as Uint8Array;
    if (buf.byteLength < 256) return null; // 几乎肯定没音轨
    return `data:audio/mpeg;base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  } finally {
    await tmp.cleanup();
  }
}

/**
 * 把任意 ffmpeg 可解码的音频文件转码为 16kHz mono WAV。
 *
 * 选用 WAV/PCM 而非 mp3：
 * - Gemma 3n 等多模态模型偏好 16kHz 单声道 PCM（官方 cookbook 示例如此）
 * - 无损，避免有损二次压缩对 ASR 质量的影响
 * - 不依赖 libmp3lame，所有 ffmpeg build 都自带 pcm_s16le
 *
 * 输入支持的格式取决于本机 ffmpeg：mp3 / wav / amr / m4a / ogg / flac 通常都行；
 * SILK 不在 ffmpeg 原生支持范围内，会失败返回 null。
 *
 * 返回纯 base64（不带 data: 前缀），失败返回 null。
 */
export async function transcodeAudioToWav(filePath: string): Promise<string | null> {
  const { proc, storage } = getMediaRuntime();
  const tmp = await proc.makeTempDir('media-wav');
  try {
    const outUri = `${tmp.uri}/audio.wav`;
    const outLocal = `${tmp.path}/audio.wav`;
    await proc.execFile(
      'ffmpeg',
      ['-i', filePath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', outLocal],
      { timeout: 60000 },
    );
    const buf = (await storage.readFile(outUri)) as Uint8Array;
    if (buf.byteLength < 256) return null;
    return Buffer.from(buf).toString('base64');
  } catch {
    return null;
  } finally {
    await tmp.cleanup();
  }
}

/**
 * 已读到的字节写到临时文件，交给 ffprobe 与 ffmpeg，返回本地路径、存储地址与清理函数；写不出返回 null。文件一律叫
 * source.bin：ffmpeg 按内容探测格式，扩展名不参与。存储地址一并交回：下游（materializeAttachment → audioToBase64）按它
 * 判是否落入 storage 根，丢掉它会让音频退回 readExternalFile 直读本地路径、绕开 storage
 */
export async function materializeBytes(
  bytes: Uint8Array,
): Promise<{ path: string; uri: string; cleanup: () => Promise<void> } | null> {
  let tmp: { path: string; uri: string; cleanup: () => Promise<void> } | undefined;
  try {
    const { proc, storage } = getMediaRuntime();
    tmp = await proc.makeTempDir('media-src');
    const uri = `${tmp.uri}/source.bin`;
    await storage.writeFile(uri, Buffer.from(bytes));
    return { path: `${tmp.path}/source.bin`, uri, cleanup: tmp.cleanup };
  } catch {
    await tmp?.cleanup();
    return null;
  }
}

/** 把 base64 data URL / file:/ 路径写到临时文件，返回本地路径与清理函数。 */
export async function materializeAttachment(
  data: string,
): Promise<{ path: string; uri?: string; cleanup: () => Promise<void> } | null> {
  const { proc, storage } = getMediaRuntime();
  try {
    // data URI（必须带 `;base64,`）：区分于 storage URI `data:/...`
    const dataUriMatch = data.match(/^data:([^;]+);base64,(.+)$/);
    if (dataUriMatch) {
      const ext = dataUriMatch[1].split('/')[1] || 'bin';
      const tmp = await proc.makeTempDir('media-att');
      const uri = `${tmp.uri}/att.${ext}`;
      await storage.writeFile(uri, Buffer.from(dataUriMatch[2], 'base64'));
      return { path: `${tmp.path}/att.${ext}`, uri, cleanup: tmp.cleanup };
    }
    if (data.startsWith('file://')) {
      return { path: data.slice('file://'.length), cleanup: async () => {} };
    }
    // 网址：受保护的下载（SSRF 防护、20 MiB 上限、15 秒超时）读进内存再落临时文件
    if (data.startsWith('http://') || data.startsWith('https://')) {
      return await materializeBytes(await safeFetchBuffer(data));
    }
    // storage URI（如 data:/images/...）→ 解析到本地路径。
    if (isStorageUri(data)) {
      try {
        const local = await storage.resolveLocalPath?.(data, 'read');
        if (local) return { path: local, uri: data, cleanup: async () => {} };
      } catch {
        /* fall through */
      }
    }
    return null;
  } catch {
    return null;
  }
}
