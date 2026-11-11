// ============================================================
// attachment-cache.ts — 统一附件落盘（storage URI 版）
//
// 入站/出站的 image / audio / video / file 统一缓存到本适配器自己的子目录
//   data:/{kind}s/{会话目录}/onebot/{sha256-16}.{ext}（@aalis/api-media 的会话媒体目录约定）
//
// 设计要点：
// - cacheAttachmentBuffer 只接受 Buffer；cacheOneAttachment 负责下载与音频的 ffmpeg 转码；
//   get_record 由调用方负责
// - 下载与转码接调用方给的中止信号（本插件这次激活的）：停用、停机时随之停下，不等各自的时限
// - 单文件 size cap 由调用方传入，超限直接返回 null
// - 文件名用 sha256(buffer) 前 16 字符做内容寻址，自然去重（api-media 的命名约定）
// - 返回落盘的存储地址，写进附件引用
// - loadAttachmentBuffer 各分支的来源写在分支上；入站消息段的来源解析时已滤过（见 types.ts 的 segmentSource）
// ============================================================

import { Buffer } from 'node:buffer';
import { sessionMediaUri } from '@aalis/api-media';
import type { ProcessService } from '@aalis/api-process';
import { isStorageUri, isWebUrl, type StorageService } from '@aalis/api-storage';
import { detectMediaFormat, FILE_HEAD_BYTES } from '@aalis/util-file-signature';
import { safeFetch } from '@aalis/util-network-guard';

type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

/** 本适配器在会话媒体目录里的子目录名（写入方） */
export const MEDIA_WRITER = 'onebot';

/**
 * 把 Buffer 落盘到 `data:/{kind}s/{会话目录}/onebot/{hash}.{ext}`，返回这个存储地址。
 * 超过 maxBytes 时返回 null，由调用方决定降级策略。
 */
async function cacheAttachmentBuffer(
  storage: StorageService,
  buf: Buffer<ArrayBuffer>,
  kind: AttachmentKind,
  sessionId: string,
  ext: string,
  maxBytes: number,
): Promise<string | null> {
  if (buf.byteLength > maxBytes) return null;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hash = Buffer.from(digest).toString('hex').slice(0, 16);
  const uri = `${sessionMediaUri(kind, sessionId, MEDIA_WRITER)}/${hash}.${ext.replace(/^\.+/, '') || 'bin'}`;
  await storage.writeFile(uri, buf);
  return uri;
}

/**
 * 流式读取响应体并限额：Content-Length 头超限即拒；流式累计超 maxBytes 即 abort 返回 null。
 * 避免无 Content-Length 时全量缓冲耗尽内存（体积上限留在下载消费方，不放入只做校验的 util-network-guard）。
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer<ArrayBuffer> | null> {
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
 * 从 URL / data: URI / file:// / storage URI 取到 Buffer。失败返回 null；中止时抛中止原因。
 */
async function loadAttachmentBuffer(
  storage: StorageService,
  proc: ProcessService,
  source: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer<ArrayBuffer> | null> {
  try {
    // 存储地址只来自出站附件（本机插件发出的，如 send_attachment）。storage URI 优先：data:/ 也是 storage
    // （根名 data），不能被下面的 data: 分支误当 data-URI。
    if (isStorageUri(source)) {
      // 读前先量：http 分支有 readBodyCapped 限额，这条此前整份读进内存再由
      // cacheAttachmentBuffer 事后判超限——白白承受一次内存峰值，大文件足以压垮进程。
      if (Number.isFinite(maxBytes)) {
        const st = await storage.stat(source);
        if (st.size > maxBytes) return null;
      }
      const raw = (await storage.readFile(source)) as Uint8Array;
      return Buffer.from(raw);
    }
    if (source.startsWith('data:')) {
      const m = source.match(/^data:[^;]+;base64,(.+)$/);
      if (!m) return null;
      return Buffer.from(m[1], 'base64');
    }
    if (isWebUrl(source)) {
      const res = await safeFetch(source, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      if (!res.ok) return null;
      return readBodyCapped(res, maxBytes);
    }
    // file:// 或绝对路径：get_record 交回的本机路径（适配器自己发起的请求的应答）与插件代码直接发出的出站附件。走
    // process.readExternalFile，不直接依赖 node:fs：这些路径可能不在任何 storage root 下（典型：NapCat 容器挂载的 /tmp），
    // 读外部任意路径是 process 能力，不污染 storage 沙箱语义
    const raw = await proc.readExternalFile(source, Number.isFinite(maxBytes) ? maxBytes : undefined);
    return Buffer.from(raw);
  } catch {
    // 中止不是取不到：抛中止原因，调用方停下
    signal.throwIfAborted();
    return null;
  }
}

/**
 * 把单个附件下载（必要时转码）后落盘，返回落盘的存储地址。失败返回 null；signal 中止时抛中止原因。
 * - audio：先 ffmpeg → 16kHz mono WAV，再以 .wav 入库（用户期望转码后存储，
 *   方便后续 LLM 反复分析；同时避免下游每次重转码）。
 * - 其他 kind：原样落盘，扩展名取文件头判定的格式（@aalis/util-file-signature），认不出的落 .bin，不按 kind 猜。
 */
export async function cacheOneAttachment(
  storage: StorageService,
  proc: ProcessService,
  kind: 'image' | 'audio' | 'video' | 'file',
  source: string,
  sessionId: string,
  maxBytes: number,
  logger: { warn: (msg: string) => void },
  signal: AbortSignal,
): Promise<string | null> {
  const buf = await loadAttachmentBuffer(storage, proc, source, maxBytes, signal);
  if (!buf) return null;
  const format = detectMediaFormat(buf.subarray(0, FILE_HEAD_BYTES));
  const ext = format?.ext ?? 'bin';
  if (kind === 'audio') {
    // SILK（QQ 语音原生格式）ffmpeg 无解码器，转码必败——就地短路，省一次注定失败的
    // 子进程+临时目录。入站路径正常经 get_record 先转 mp3 不会走到这；走到这的是
    // get_record 失败或转发内语音（后者的 get_record 前置尚未实现）。
    if (format?.format === 'SILK') {
      logger.warn(`OneBot 音频为 SILK 格式（ffmpeg 不支持），跳过转码保留原 URL (size=${buf.byteLength}B)`);
      return null;
    }
    const wav = await transcodeAudioBufferToWav(proc, storage, buf, signal);
    if (!wav) {
      logger.warn(`OneBot 音频转 WAV 失败 (in=${ext}, size=${buf.byteLength}B)，保留原 URL`);
      return null;
    }
    return await cacheAttachmentBuffer(storage, wav, 'audio', sessionId, 'wav', maxBytes);
  }
  return await cacheAttachmentBuffer(storage, buf, kind, sessionId, ext, maxBytes);
}

/**
 * 用 ffmpeg 把任意可解码音频 Buffer 转为 16kHz mono PCM WAV。
 * 失败（典型：SILK，ffmpeg 不含 silk 解码器）返回 null；中止时由 process 服务停掉 ffmpeg，抛中止原因。
 * 输入的临时文件一律叫 in.bin：ffmpeg 按内容探测格式，扩展名不参与。
 */
async function transcodeAudioBufferToWav(
  proc: ProcessService,
  storage: StorageService,
  input: Buffer<ArrayBuffer>,
  signal: AbortSignal,
): Promise<Buffer<ArrayBuffer> | null> {
  const tmp = await proc.makeTempDir('onebot-audio');
  try {
    const inUri = `${tmp.uri}/in.bin`;
    const outUri = `${tmp.uri}/out.wav`;
    const inPath = `${tmp.path}/in.bin`;
    const outPath = `${tmp.path}/out.wav`;
    await storage.writeFile(inUri, input);
    await proc.execFile(
      'ffmpeg',
      ['-i', inPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', outPath],
      { timeout: 60000, signal },
    );
    const raw = (await storage.readFile(outUri)) as Uint8Array;
    const out = Buffer.from(raw);
    return out.byteLength >= 256 ? out : null;
  } catch {
    // 中止不是转不了：抛中止原因，不按转码失败告警
    signal.throwIfAborted();
    return null;
  } finally {
    await tmp.cleanup();
  }
}
