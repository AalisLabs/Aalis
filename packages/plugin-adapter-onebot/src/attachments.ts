// ============================================================
// attachments.ts — 把 OutgoingMessage.attachments 转为 OneBot 的消息段与上传文件
//
// OneBot v11 image.file 字段支持三种 scheme：
//   - http(s)://...        OneBot 守护进程自行拉取
//   - file:///abs/path     OneBot 守护进程从本地文件系统读取
//   - base64://<b64>       数据内嵌在消息里随 WS 隧道发送（适合 Docker 部署）
//
// 由于 NapCat / go-cqhttp 经常跑在 Docker / 远端机器，file:// 不一定可达。
// 默认策略：把 storage URI / data:/http 都转成 base64:// 让数据走 WS 隧道，
// 最稳。超过 MAX_INLINE_BYTES 的 storage 文件回退到 file:// + warn；超过的网址拒发，不交给 daemon 去拉
// （它再拉一次不经 SSRF 判定）。
//
// image、audio、video 按文件头分流（格式签名见 @aalis/util-file-signature）：NapCat 能内联的格式走消息段；
// 认得出、但不能内联的媒体（如 BMP、HEIC 图片，MKV、AVI 视频）改经文件上传；不是媒体的拒发——发送工具在 owner
// 自己的会话里能取任意可读的 storage URI，不核对的话任意可读文件（如含密钥的配置）能冒充媒体发出。超过内联上限的
// storage 文件退回 file://<宿主路径> 之前同样核对（daemon 与 Aalis 共享文件系统时它读得到）。原样透传的 file://
// 与裸路径不经 storage、也不核对。
// file 附件与改走上传的媒体不走消息段，经群文件、私聊文件上传，只收 base64://（见 materializeAttachments）。
//
// file:// 与本地绝对路径不再由本插件直接读取（避免依赖 node:fs），原样透传
// 给 daemon。生产侧 attachments 几乎都来自 plugin-media / plugin-image-sender
// 产出的 storage URI / data URI，故此回归仅在裸 file:// 用例下生效。
//
// 她回复正文里的媒体标记只发网址的，同样经 safeFetch 下载后内联（inlineMarkupMedia），不交给 daemon 去拉；其余地址的去掉。
// ============================================================

import { Buffer } from 'node:buffer';
import { isStorageUri, isWebUrl, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import { TextError } from '@aalis/schema-i18n';
import type { MessageAttachment } from '@aalis/schema-message';
import { detectMediaFormat, FILE_HEAD_BYTES, type MediaKind } from '@aalis/util-file-signature';
import { safeFetch } from '@aalis/util-network-guard';
import { readBodyCapped } from './attachment-cache.js';
import { t } from './texts.js';
import type { OutgoingPiece, ParsedSegment } from './types.js';

/** base64 内联上限（10 MiB）。超过的 storage 文件降级为 file:// 并记 warn，超过的网址拒发。 */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/**
 * NapCat 能以消息段内联的格式（格式名取自 @aalis/util-file-signature）；语音的 M4A 与视频的 MP4、MOV 同为
 * ftyp 容器。认得出、但不在这里的媒体，以及与附件 kind 不符的媒体，改经文件上传。
 */
const INLINE_FORMATS: Record<MediaKind, ReadonlySet<string>> = {
  image: new Set(['PNG', 'JPEG', 'GIF', 'WebP']),
  audio: new Set(['MP3', 'WAV', 'OGG', 'FLAC', 'AMR', 'SILK', 'M4A']),
  video: new Set(['MP4', 'MOV', 'WebM']),
};

/**
 * 媒介附件按文件头分流：能内联的返回 undefined（走消息段），认得出但不能内联的返回上传用的扩展名，
 * 都不是就抛错拒发。file 附件不经这里（群文件本来就收任意类型）。
 */
function routeByHead(kind: MediaKind, head: Uint8Array): string | undefined {
  const media = detectMediaFormat(head);
  if (!media) throw new TextError(t('notMedia', { kind }));
  if (media.kind === kind && INLINE_FORMATS[kind].has(media.format)) return undefined;
  return media.format.toLowerCase();
}

/**
 * 读 storage 文件的开头（按字节区间，不整份读进内存）。读不出就抛错拒发：能退回宿主路径的是本机存储，
 * 本机存储都支持区间读取
 */
async function readHead(storage: StorageService, uri: string): Promise<Buffer> {
  const head = await storage.readFileRange?.(uri, 0, FILE_HEAD_BYTES);
  if (!head) throw new TextError(t('noHead'));
  return head;
}

/**
 * 物化结果：`file` 是消息段或上传接口的 file 字段；`uploadExt` 有值时这个媒介附件改经文件上传，值是扩展名。
 * 原样透传的 file:// 不读内容，没有这个字段。
 */
interface OneBotFile {
  file: string;
  uploadExt?: string;
}

/**
 * 把附件物化为 OneBot 消息段 `file` 字段或上传接口可接受的字符串，媒介附件同时按文件头分流。
 */
async function attachmentToOneBotFile(
  att: MessageAttachment,
  storage: StorageService,
  logger?: Logger,
): Promise<OneBotFile> {
  const data = att.data;
  if (!data) throw new Error('attachment.data is empty');
  /** 字节已在手：媒介附件先分流（不是媒体就在这里拒发），再包成 base64:// */
  const fromBytes = (buf: Buffer): OneBotFile => ({
    uploadExt: att.kind === 'file' ? undefined : routeByHead(att.kind, buf),
    file: `base64://${buf.toString('base64')}`,
  });

  // data:image/...;base64,xxx → base64://xxx
  // 注意：data[5] === '/' 时是 storage URI（data:/images/...），不是 data URI
  if (data.startsWith('data:') && data[5] !== '/') {
    const m = data.match(/^data:[^;]+;base64,(.+)$/);
    if (!m) throw new Error('invalid data URI');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.byteLength > MAX_INLINE_BYTES) {
      logger?.warn?.(`OneBot 附件超过 ${MAX_INLINE_BYTES} bytes，无法 base64 内联，已跳过`);
      throw new Error('attachment too large for base64 inline');
    }
    return fromBytes(buf);
  }

  // http(s):// → 下载后 base64 内联
  if (isWebUrl(data)) {
    logger?.debug?.(`OneBot 下载远程附件: ${data.slice(0, 120)}`);
    // 与入站缓存同一上限：慢源不能把发送这条消息的回合拖住几分钟。
    const res = await safeFetch(data, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`download failed (${res.status}): ${data}`);
    // 流式限额读取：不先全量 arrayBuffer 再判大小（避免无 Content-Length 时撑爆内存，与入站对称）。
    const capped = await readBodyCapped(res, MAX_INLINE_BYTES);
    if (!capped) throw new TextError(t('tooLargeToInline'));
    return fromBytes(capped);
  }

  // storage URI（如 data:/images/xxx）→ storage.readFile → base64
  if (isStorageUri(data)) {
    // 读前先量：视频也走这里，超限的不整份读进内存
    const { size } = await storage.stat(data);
    if (size > MAX_INLINE_BYTES) {
      // 交宿主路径之前同样按文件头分流：daemon 读得到宿主路径时，任意可读文件不能借「超过上限」冒充媒体发出
      const uploadExt = att.kind === 'file' ? undefined : routeByHead(att.kind, await readHead(storage, data));
      // 上传只收 base64://，宿主路径容器里的 NapCat 读不到
      if (att.kind === 'file' || uploadExt !== undefined) {
        throw new TextError(t('tooLargeToUpload', { size }));
      }
      logger?.warn?.(
        `OneBot storage 附件 ${size}B 超过内联上限，改交 file:// 宿主路径（daemon 与 Aalis 不共享文件系统时读不到，如 NapCat 在容器里）`,
      );
      try {
        const local = await storage.resolveLocalPath?.(data, 'read');
        if (local) return { file: `file://${local}` };
      } catch {
        /* fall through */
      }
      throw new Error('attachment too large and not resolvable to local path');
    }
    const raw = (await storage.readFile(data)) as Uint8Array;
    return fromBytes(Buffer.from(raw));
  }

  // file:// 或裸路径：直接交给 daemon 处理（依赖 daemon 与文件系统共享）
  if (data.startsWith('file://')) {
    return { file: data };
  }
  // 兜底：当作本地绝对路径，包成 file://
  return { file: `file://${data}` };
}

/** 日志里对各类附件的称呼 */
const LABELS: Record<MessageAttachment['kind'], string> = { image: '图片', audio: '语音', video: '视频', file: '文件' };

/** 出站附件的物化结果 */
interface OneBotOutgoingAttachments {
  /**
   * 能走消息段的媒介附件物化出的段（地址是 `base64://…`，超过内联上限的 storage 文件是宿主路径），不拼成标记再解析：
   * 附件自带的地址原样留在一个段里，拆不出别的段
   */
  segments: ParsedSegment[];
  /** segments 对应的成功物化附件；只有平台发送成功后才可归档。 */
  inlineAttachments: MessageAttachment[];
  /** 文字与消息段发出之后逐个上传的文件：file 附件与改走上传的媒体 */
  uploads: Array<{ file: string; name: string; attachment: MessageAttachment }>;
  /** 没发出去的附件各自的原因（已记 warn），调用方据此留投递失败记录 */
  errors: unknown[];
}

/**
 * 把出站附件分成消息段与上传文件：
 * - image / audio / video：按文件头分流。能内联的物化为 base64://（走 WS 隧道，Docker 部署最稳）的消息段，超过内联
 *   上限的 storage 文件退回 file:// 宿主路径，daemon 读不到时发不出，超过内联上限的网址拒发；认得出但不能内联的改经文件
 *   上传；不是媒体的拒发
 * - file 与改走上传的媒体经群文件、私聊文件上传，内容只收 `base64://`：超过内联上限的文件与透传的 `file://` 路径，
 *   容器里的 NapCat 都读不到，一律拒发。`name` 是群文件里显示的文件名，
 *   去掉路径分隔符；缺省时 file 附件叫 `file`，改走上传的媒体按类型与格式命名（如 `image.bmp`）
 * - 没发出去的附件 warn 后跳过，原因收进 `errors`
 */
export async function materializeAttachments(
  attachments: MessageAttachment[],
  storage: StorageService,
  logger?: Logger,
): Promise<OneBotOutgoingAttachments> {
  const segments: ParsedSegment[] = [];
  const inlineAttachments: MessageAttachment[] = [];
  const uploads: Array<{ file: string; name: string; attachment: MessageAttachment }> = [];
  const errors: unknown[] = [];
  for (const att of attachments) {
    try {
      const { file, uploadExt } = await attachmentToOneBotFile(att, storage, logger);
      if (att.kind !== 'file' && uploadExt === undefined) {
        segments.push({ type: att.kind, data: { url: file } });
        inlineAttachments.push(att);
        continue;
      }
      if (!file.startsWith('base64://')) {
        throw new TextError(t('uploadBase64Only'));
      }
      const name = (att.name ?? '').replace(/[/\\]/g, '');
      uploads.push({ file, name: name || (uploadExt ? `${att.kind}.${uploadExt}` : 'file'), attachment: att });
    } catch (err) {
      logger?.warn?.(`OneBot ${LABELS[att.kind]}附件未发出: ${err instanceof Error ? err.message : err}`);
      errors.push(err);
    }
  }
  return { segments, inlineAttachments, uploads, errors };
}

/**
 * 她回复正文（OutgoingMessage.markup）里的媒体段只发网址的：实现端自己去拉不经 SSRF 判定，这里与附件同一条路，经 safeFetch
 * 下载、按文件头核对后改成 base64:// 内联，各段同时下载。地址不是网址的（file://、本机路径、存储地址、data URI、正文里写的
 * base64:// 等）不交给实现端，与解析不了、下载不了、超过内联上限、不是能内联的媒体的段一样去掉，原因收进 errors（已记 warn），
 * 去掉后没有段的那一条不发；存储里的媒体由 plugin-image-sender 在派发前转成附件。在解析出的段上改、不回头改正文：从正文里删掉
 * 标记再解析，两边的文字会拼出新的标记
 */
export async function inlineMarkupMedia(
  pieces: OutgoingPiece[],
  storage: StorageService,
  logger?: Logger,
): Promise<{ pieces: OutgoingPiece[]; errors: unknown[] }> {
  const errors: unknown[] = [];
  /** 一个段换成的段：网址的媒体段换成内联后的，发不出的为 undefined */
  const inline = async (segment: ParsedSegment): Promise<ParsedSegment | undefined> => {
    const { type } = segment;
    if (type !== 'image' && type !== 'audio' && type !== 'video') return segment;
    const address = String(segment.data.url);
    try {
      // 按网址解析得出 http、https 的才下载：不计首尾空白、不分大小写
      const url = URL.canParse(address) ? new URL(address) : undefined;
      if (!url || !/^https?:$/.test(url.protocol)) throw new TextError(t('notUrl'));
      const { file, uploadExt } = await attachmentToOneBotFile({ kind: type, data: url.href }, storage, logger);
      if (uploadExt !== undefined) throw new TextError(t('cannotInline', { format: uploadExt }));
      return { type, data: { url: file } };
    } catch (err) {
      logger?.warn?.(`OneBot 正文里的${LABELS[type]}标记未发出: ${err instanceof Error ? err.message : err}`);
      errors.push(err);
      return undefined;
    }
  };
  const inlined = await Promise.all(
    pieces.map(async ({ text, segments }) => ({
      text,
      segments: (await Promise.all(segments.map(inline))).filter(segment => segment !== undefined),
    })),
  );
  return { pieces: inlined.filter(piece => piece.segments.length > 0), errors };
}
