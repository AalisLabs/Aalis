// ============================================================
// attachment-cache.ts — 统一附件落盘（storage URI 版）
//
// 入站/出站的 image / audio / video / file 统一缓存到
//   data:/{kind}s/{safeSessionId}/{sha256-16}.{ext}
//
// 设计要点：
// - 只接受已下载好的 Buffer，下载/get_record/ffmpeg 由调用方负责
// - 单文件 size cap 由调用方传入，超限直接返回 null
// - 文件名用 sha256(buffer) 前 16 字符做内容寻址，自然去重
// - 返回的 ref 仍是相对路径（如 `data/audios/.../xxx.wav`）以兼容历史 ref:
//   解析；存盘走 storage.writeFile('data:/...')
//
// loadAttachmentBuffer 遇到 file:// / OS 绝对路径时改走 ProcessService.readExternalFile，
// 避免 adapter 直接依赖 node:fs。原因：OneBot daemon 推来的路径可能不在任何 storage
// root 下（典型：NapCat 容器挂载的 /tmp）。“读外部任意路径”是 process 能力、
// 不应污染 storage 沙箱语义。
// ============================================================

import { Buffer } from 'node:buffer';
import type { ProcessService } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { safeFetch } from '@aalis/util-network-guard';

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

/** 简易判定：形如 <root>:/<path>，且 root 非 http/https/data/file。 */
function isStorageUri(s: string): boolean {
  if (!/^[a-z][a-z0-9_-]*:\//.test(s)) return false;
  const scheme = s.slice(0, s.indexOf(':')).toLowerCase();
  return scheme !== 'http' && scheme !== 'https' && scheme !== 'data' && scheme !== 'file';
}

/**
 * 把 Buffer 落盘到 `data:/{kind}s/{session}/{hash}.{ext}`。
 * 超过 maxBytes 时返回 null，由调用方决定降级策略。
 * 返回值是 `data/{kind}s/{session}/{filename}` 这一历史相对路径，
 * 用于写入 attachment ref；storage 落盘走 `data:/...` URI。
 */
export async function cacheAttachmentBuffer(
  storage: StorageService,
  buf: Buffer,
  kind: AttachmentKind,
  sessionId: string,
  ext: string,
  maxBytes: number,
): Promise<string | null> {
  if (buf.byteLength > maxBytes) return null;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hash = Buffer.from(digest).toString('hex').slice(0, 16);
  const dirRel = `${KIND_DIR[kind]}/${safeSessionDir(sessionId)}`;
  const filename = `${hash}.${ext.replace(/^\.+/, '') || 'bin'}`;
  const uri = `data:/${dirRel}/${filename}`;
  await storage.writeFile(uri, buf);
  return `data/${dirRel}/${filename}`;
}

/**
 * 流式读取响应体并限额：Content-Length 头超限即拒；流式累计超 maxBytes 即 abort 返回 null。
 * 避免无 Content-Length 时全量缓冲撑爆内存（体积上限留在下载消费方，不塞进只做校验的 util-network-guard）。
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) return null;
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 从 URL / data: URI / file:// / storage URI 取到 Buffer。失败返回 null。
 */
export async function loadAttachmentBuffer(
  storage: StorageService,
  proc: ProcessService,
  source: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Buffer | null> {
  try {
    if (source.startsWith('data:')) {
      const m = source.match(/^data:[^;]+;base64,(.+)$/);
      if (!m) return null;
      return Buffer.from(m[1], 'base64');
    }
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const res = await safeFetch(source, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      return readBodyCapped(res, maxBytes);
    }
    if (isStorageUri(source)) {
      const raw = (await storage.readFile(source)) as Uint8Array;
      return Buffer.from(raw);
    }
    // file:// 或绝对路径：OneBot daemon 推来的任意 OS 路径，走 process.readExternalFile
    const raw = await proc.readExternalFile(source);
    return Buffer.from(raw);
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
 * 失败（典型：SILK，ffmpeg 不含 silk 解码器）返回 null。
 */
export async function transcodeAudioBufferToWav(
  proc: ProcessService,
  storage: StorageService,
  input: Buffer,
  inputExt: string,
): Promise<Buffer | null> {
  const tmp = await proc.makeTempDir('onebot-audio');
  try {
    const ext = inputExt.replace(/^\.+/, '') || 'bin';
    const inUri = `${tmp.uri}/in.${ext}`;
    const outUri = `${tmp.uri}/out.wav`;
    const inPath = `${tmp.path}/in.${ext}`;
    const outPath = `${tmp.path}/out.wav`;
    await storage.writeFile(inUri, input);
    await proc.execFile(
      'ffmpeg',
      ['-i', inPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', outPath],
      { timeout: 60000 },
    );
    const raw = (await storage.readFile(outUri)) as Uint8Array;
    const out = Buffer.from(raw);
    return out.byteLength >= 256 ? out : null;
  } catch {
    return null;
  } finally {
    await tmp.cleanup();
  }
}
