// ============================================================
// ffmpeg.ts — 视频/动图帧提取工具
//
// 通过 plugin-process-api + plugin-storage-api 委托子进程与临时目录。
// 业务调用方仍以纯函数形式使用，运行时通过 setMediaRuntime() 注入实现。
// ============================================================

import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { getMediaRuntime } from './runtime.js';
import { safeDownloadToTemp } from './safe-fetch.js';

/** 动图/视频扩展名集合（GIF 也按动图处理）。 */
const ANIMATED_EXTS = new Set(['.gif', '.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m4v']);

/** 判断给定 URL/路径/data URI 是否动图或视频。 */
export function isAnimatedFormat(pathOrUrl: string): boolean {
  if (pathOrUrl.startsWith('data:image/gif')) return true;
  if (pathOrUrl.startsWith('data:video/')) return true;
  const clean = pathOrUrl.split('?')[0].split('#')[0];
  const ext = extname(clean).toLowerCase();
  return ANIMATED_EXTS.has(ext);
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Storage URI → data URI（按扩展名猜 mime）。失败抛错。
 */
export async function fileToDataUri(uri: string): Promise<string> {
  const { storage } = getMediaRuntime();
  const ext = extname(uri).slice(1).toLowerCase();
  const buf = (await storage.readFile(uri)) as Uint8Array;
  return `data:${mimeForExt(ext)};base64,${Buffer.from(buf).toString('base64')}`;
}

/**
 * 下载远程 URL 到临时文件。返回本地路径 + 清理函数；失败返回 null。
 * 仅用于 vision/视频帧提取等纯本地处理场景。
 *
 * 内部走 safe-fetch（带 SSRF 防护、20 MiB 上限、15s 超时），
 * 拒绝下载到 169.254.169.254 / 127.0.0.1 / 10.0.0.0/8 等内网地址。
 */
export async function downloadToTemp(url: string): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  return safeDownloadToTemp(url);
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
    if (data.startsWith('http://') || data.startsWith('https://')) {
      const r = await safeDownloadToTemp(data, { imageOnly: false });
      return r;
    }
    // storage URI（如 data:/images/...）→ 解析到本地路径。
    // 同时兼容历史相对路径（如 `data/images/...`，缺少冒号），统一补成 storage URI。
    let storageUri: string | null = null;
    if (/^[a-z][a-z0-9_-]*:\//.test(data)) {
      storageUri = data;
    } else if (/^data\//.test(data)) {
      storageUri = `data:/${data.slice('data/'.length)}`;
    }
    if (storageUri) {
      try {
        const local = await storage.resolveLocalPath?.(storageUri, 'read');
        if (local) return { path: local, uri: storageUri, cleanup: async () => {} };
      } catch {
        /* fall through */
      }
    }
    return null;
  } catch {
    return null;
  }
}
