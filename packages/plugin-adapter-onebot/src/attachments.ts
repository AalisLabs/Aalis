// ============================================================
// attachments.ts — 把 OutgoingMessage.attachments 转为 OneBot 可发的字符串
//
// OneBot v11 image.file 字段支持三种 scheme：
//   - http(s)://...        OneBot 守护进程自行拉取
//   - file:///abs/path     OneBot 守护进程从本地文件系统读取
//   - base64://<b64>       数据内嵌在消息里随 WS 隧道发送（适合 Docker 部署）
//
// 由于 NapCat / go-cqhttp 经常跑在 Docker / 远端机器，file:// 不一定可达。
// 默认策略：把 storage URI / data:/http 都转成 base64:// 让数据走 WS 隧道，
// 最稳。超过 MAX_INLINE_BYTES 的附件回退到原始 URL/file:// + warn。
//
// image、audio、video 按文件头分流（格式签名见 @aalis/util-media-signature）：NapCat 能内联的格式走消息段；
// 认得出、但不能内联的媒体（如 BMP、HEIC 图片，MKV、AVI 视频）改经文件上传；不是媒体的拒发——发送工具接受
// 任意 storage URI，不核对的话任意可读文件（如含密钥的配置）能冒充媒体发出。超过内联上限的 storage 文件退回
// file://<宿主路径> 之前同样核对（daemon 与 Aalis 共享文件系统时它读得到）。原样透传的 file:// 与裸路径
// 不经 storage、也不核对。
// file 附件与改走上传的媒体不走消息段，经群文件、私聊文件上传，只收 base64://（见 materializeAttachments）。
//
// file:// 与本地绝对路径不再由本插件直接读取（避免依赖 node:fs），原样透传
// 给 daemon。生产侧 attachments 几乎都来自 plugin-media / plugin-image-sender
// 产出的 storage URI / data URI，故此回归仅在裸 file:// 用例下生效。
// ============================================================

import { Buffer } from 'node:buffer';
import { isStorageUri, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import type { MessageAttachment } from '@aalis/schema-message';
import { detectMediaFormat, MEDIA_HEAD_BYTES, type MediaKind } from '@aalis/util-media-signature';
import { safeFetch } from '@aalis/util-network-guard';
import { readBodyCapped } from './attachment-cache.js';

/** base64 内联上限（10 MiB）。超过则降级为 URL/file:// 并记 warn。 */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/**
 * NapCat 能以消息段内联的格式（格式名取自 @aalis/util-media-signature）；语音的 M4A 与视频的 MP4、MOV 同为
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
  if (!media) throw new Error(`内容不是可发送的 ${kind} 格式（文件头不符），已拒发`);
  if (media.kind === kind && INLINE_FORMATS[kind].has(media.format)) return undefined;
  return media.format.toLowerCase();
}

/**
 * 读 storage 文件的开头（按字节区间，不整份读进内存）。读不出就抛错拒发：能退回宿主路径的是本机存储，
 * 本机存储都支持区间读取
 */
async function readHead(storage: StorageService, uri: string): Promise<Buffer> {
  const head = await storage.readFileRange?.(uri, 0, MEDIA_HEAD_BYTES);
  if (!head) throw new Error('读不出文件头，已拒发');
  return head;
}

/**
 * 物化结果：`file` 是消息段或上传接口的 file 字段；`uploadExt` 有值时这个媒介附件改经文件上传，值是扩展名。
 * 超限的 http 链接与原样透传的 file:// 不读内容，没有这个字段。
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
  if (data.startsWith('http://') || data.startsWith('https://')) {
    logger?.debug?.(`OneBot 下载远程附件: ${data.slice(0, 120)}`);
    const res = await safeFetch(data);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${data}`);
    // 流式限额读取：不先全量 arrayBuffer 再判大小（避免无 Content-Length 时撑爆内存，与入站对称）。
    const capped = await readBodyCapped(res, MAX_INLINE_BYTES);
    if (!capped) {
      logger?.warn?.('OneBot 远程附件超过内联上限，回退到 URL（依赖 daemon 直拉）');
      return { file: data };
    }
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
        throw new Error(`${size}B 超过内联上限，不能以文件上传`);
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

/** 媒介附件对应的消息段标记 */
const SEGMENT_TAGS: Record<MediaKind, string> = { image: 'image', audio: 'record', video: 'video' };

/** 日志里对各类附件的称呼 */
const LABELS: Record<MessageAttachment['kind'], string> = { image: '图片', audio: '语音', video: '视频', file: '文件' };

/** 出站附件的物化结果 */
interface OneBotOutgoingAttachments {
  /** 拼到文字后面的消息段标记（`<image url="base64://…"/>` 等） */
  markers: string;
  /** 文字与消息段发出之后逐个上传的文件：file 附件与改走上传的媒体 */
  uploads: Array<{ file: string; name: string }>;
  /** 没发出去的附件各自的原因（已记 warn），调用方据此留投递失败记录 */
  errors: unknown[];
}

/**
 * 把出站附件分成消息段标记与上传文件：
 * - image / audio / video：按文件头分流。能内联的物化为 base64://（走 WS 隧道，Docker 部署最稳）→ `<image>` /
 *   `<record>` / `<video>`，超过内联上限的退回 URL 或 file:// 宿主路径，daemon 读不到时发不出；认得出但不能内联的
 *   改经文件上传；不是媒体的拒发
 * - file 与改走上传的媒体经群文件、私聊文件上传，内容只收 `base64://`：超过内联上限的文件、原样返回的超限
 *   http 链接与透传的 `file://` 路径，容器里的 NapCat 都读不到，一律拒发。`name` 是群文件里显示的文件名，去掉路径分隔符；缺省时 file 附件叫 `file`，改走上传的媒体按类型与格式
 *   命名（如 `image.bmp`）
 * - 没发出去的附件 warn 后跳过，原因收进 `errors`
 */
export async function materializeAttachments(
  attachments: MessageAttachment[],
  storage: StorageService,
  logger?: Logger,
): Promise<OneBotOutgoingAttachments> {
  const markers: string[] = [];
  const uploads: Array<{ file: string; name: string }> = [];
  const errors: unknown[] = [];
  for (const att of attachments) {
    try {
      const { file, uploadExt } = await attachmentToOneBotFile(att, storage, logger);
      if (att.kind !== 'file' && uploadExt === undefined) {
        markers.push(`<${SEGMENT_TAGS[att.kind]} url="${file}"/>`);
        continue;
      }
      if (!file.startsWith('base64://')) {
        throw new Error('文件上传只收 base64://（超过内联上限或来源是宿主路径、原链接时 NapCat 读不到）');
      }
      const name = (att.name ?? '').replace(/[/\\]/g, '');
      uploads.push({ file, name: name || (uploadExt ? `${att.kind}.${uploadExt}` : 'file') });
    } catch (err) {
      logger?.warn?.(`OneBot ${LABELS[att.kind]}附件未发出: ${err instanceof Error ? err.message : err}`);
      errors.push(err);
    }
  }
  return { markers: markers.join(''), uploads, errors };
}
