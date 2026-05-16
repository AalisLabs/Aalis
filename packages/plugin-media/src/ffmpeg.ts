// ============================================================
// ffmpeg.ts — 视频/动图帧提取工具
//
// 复用自 plugin-image-recognition 的成熟实现，独立出来以便 plugin-media
// 与未来其他视频识别 backend 共享。逻辑保持一致，只去掉 sharp fallback
// （sharp 仅 GIF 有用，新代码统一要求 ffmpeg 即可，简化部署判断）。
// ============================================================

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { safeDownloadToTemp } from './safe-fetch.js';

const execFileAsync = promisify(execFile);

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

/** 本地文件 → data URI（按扩展名猜 mime）。失败抛错。 */
export async function fileToDataUri(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const ext = extname(filePath).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
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
  const mime = mimeMap[ext] ?? 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
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
  try {
    const { stdout } = await execFileAsync(
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
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** 提取指定帧为 PNG，返回 data URI 数组。 */
export async function extractFrames(filePath: string, frameIndices: number[]): Promise<string[]> {
  if (frameIndices.length === 0) return [];
  const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-media-frames-'));
  try {
    const selectExpr = frameIndices.map(i => `eq(n\\,${i})`).join('+');
    await execFileAsync(
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
        join(tmpDir, 'frame_%04d.png'),
      ],
      { timeout: 60000 },
    );
    const results: string[] = [];
    for (let i = 1; i <= frameIndices.length; i++) {
      const framePath = join(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
      try {
        const buf = await readFile(framePath);
        results.push(`data:image/png;base64,${buf.toString('base64')}`);
      } catch {
        // 该帧可能不存在
      }
    }
    return results;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 抽取视频音轨为 mp3。返回 data URI 或 null（失败/无音轨）。 */
export async function extractAudioTrack(filePath: string): Promise<string | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-media-audio-'));
  try {
    const out = join(tmpDir, 'audio.mp3');
    await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-ar', '16000', '-y', out],
      { timeout: 120000 },
    );
    const buf = await readFile(out);
    if (buf.byteLength < 256) return null; // 几乎肯定没音轨
    return `data:audio/mpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
  const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-media-wav-'));
  try {
    const out = join(tmpDir, 'audio.wav');
    await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', out],
      { timeout: 60000 },
    );
    const buf = await readFile(out);
    if (buf.byteLength < 256) return null;
    return buf.toString('base64');
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 把 base64 data URL / file:/ 路径写到临时文件，返回本地路径与清理函数。 */
export async function materializeAttachment(
  data: string,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-media-att-'));
  const cleanup = async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    if (data.startsWith('data:')) {
      const m = data.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) {
        await cleanup();
        return null;
      }
      const ext = m[1].split('/')[1] || 'bin';
      const filePath = join(tmpDir, `att.${ext}`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, Buffer.from(m[2], 'base64'));
      return { path: filePath, cleanup };
    }
    if (data.startsWith('file://')) {
      return { path: data.slice('file://'.length), cleanup };
    }
    if (data.startsWith('http://') || data.startsWith('https://')) {
      // 远程 URL：走 SSRF 防护通道下载到临时文件（与 downloadToTemp 同栈）
      await cleanup();
      return await safeDownloadToTemp(data, { imageOnly: false });
    }
    // 已经是本地路径（可能是相对 cwd 的相对路径，例如 adapter 缓存的 data/images/xxx）
    const abs = resolve(process.cwd(), data);
    return { path: abs, cleanup };
  } catch {
    await cleanup();
    return null;
  }
}
