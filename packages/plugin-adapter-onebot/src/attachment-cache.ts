// ============================================================
// attachment-cache.ts — 统一附件落盘
//
// 把入站/出站的 image / audio / video / file 统一缓存到
//   data/{kind}s/{safeSessionId}/{sha256-16}.{ext}
// 以保持与图片缓存目录布局一致，便于人工检查、归档、再分析。
//
// 设计要点：
// - 只接受已下载好的 Buffer，下载/get_record/ffmpeg 由调用方负责
// - 单文件 size cap 由调用方传入，超限直接返回 null（调用方退回原 URL）
// - 文件名用 sha256(buffer) 前 16 字符做内容寻址，自然去重
// - 返回相对 cwd 的路径（如 `data/audios/.../xxx.wav`），供下游读盘
// ============================================================

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

const KIND_DIR: Record<AttachmentKind, string> = {
  image: 'images',
  audio: 'audios',
  video: 'videos',
  file: 'files',
};

/** 把 sessionId 转为文件系统安全的名字（替换 `:`/`/`/`\\`）。 */
function safeSessionDir(sessionId: string): string {
  return sessionId.replace(/[:/\\]/g, '_');
}

/**
 * 把 Buffer 落盘到 `data/{kind}s/{session}/{hash}.{ext}`。
 * 超过 maxBytes 时返回 null，由调用方决定降级策略。
 */
export async function cacheAttachmentBuffer(
  buf: Buffer,
  kind: AttachmentKind,
  sessionId: string,
  ext: string,
  maxBytes: number,
): Promise<string | null> {
  if (buf.byteLength > maxBytes) return null;
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const dirRel = `data/${KIND_DIR[kind]}/${safeSessionDir(sessionId)}`;
  const dirAbs = resolve(process.cwd(), dirRel);
  await mkdir(dirAbs, { recursive: true });
  const filename = `${hash}.${ext.replace(/^\.+/, '') || 'bin'}`;
  await writeFile(resolve(dirAbs, filename), buf);
  return `${dirRel}/${filename}`;
}

/**
 * 从 URL / data: URI / file:// / 本地路径取到 Buffer。
 * 失败返回 null。
 */
export async function loadAttachmentBuffer(source: string): Promise<Buffer | null> {
  try {
    if (source.startsWith('data:')) {
      const m = source.match(/^data:[^;]+;base64,(.+)$/);
      if (!m) return null;
      return Buffer.from(m[1], 'base64');
    }
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const res = await fetch(source, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    const path = source.startsWith('file://') ? source.slice('file://'.length) : resolve(process.cwd(), source);
    return await readFile(path);
  } catch {
    return null;
  }
}

/** 简易 magic-header 探测，仅用于落盘扩展名选择与日志。 */
export function detectExtensionFromBuffer(buf: Buffer, fallback = 'bin'): string {
  if (buf.length < 12) return fallback;
  // image
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'webp';
  // audio
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (buf.subarray(0, 5).toString('ascii') === '#!AMR') return 'amr';
  const silkHead = buf[0] === 0x02 ? buf.subarray(1, 10) : buf.subarray(0, 9);
  if (silkHead.toString('ascii') === '#!SILK_V3') return 'silk';
  // video / container
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return fallback;
}

/**
 * 用 ffmpeg 把任意可解码音频 Buffer 转为 16kHz mono PCM WAV。
 * Gemma 3n cookbook 推荐格式；ASR / 多模态 LLM 都能直接消费。
 *
 * 失败（典型：SILK，ffmpeg 不含 silk 解码器）返回 null。
 */
export async function transcodeAudioBufferToWav(input: Buffer, inputExt: string): Promise<Buffer | null> {
  const tmp = await mkdtemp(join(tmpdir(), 'aalis-onebot-audio-'));
  try {
    const inPath = join(tmp, `in.${inputExt.replace(/^\.+/, '') || 'bin'}`);
    const outPath = join(tmp, 'out.wav');
    await writeFile(inPath, input);
    await execFileAsync(
      'ffmpeg',
      ['-i', inPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', outPath],
      { timeout: 60000 },
    );
    const out = await readFile(outPath);
    return out.byteLength >= 256 ? out : null;
  } catch {
    return null;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
