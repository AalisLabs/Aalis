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
// image、audio、video 内联前按文件头核对格式，不符就拒发：发送工具接受任意 storage URI，
// 不核对的话任意可读文件（如含密钥的配置）能冒充媒体经 base64 发出。超过内联上限的 storage 文件退回
// file://<宿主路径> 之前同样核对（daemon 与 Aalis 共享文件系统时它读得到）。原样透传的 file:// 与裸路径
// 不经 storage、也不核对。
// file 附件不走消息段，经群文件、私聊文件上传，只收 base64://（见 materializeFileAttachment）。
//
// file:// 与本地绝对路径不再由本插件直接读取（避免依赖 node:fs），原样透传
// 给 daemon。生产侧 attachments 几乎都来自 plugin-media / plugin-image-sender
// 产出的 storage URI / data URI，故此回归仅在裸 file:// 用例下生效。
// ============================================================

import { Buffer } from 'node:buffer';
import { isStorageUri, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import type { MessageAttachment } from '@aalis/schema-message';
import { safeFetch } from '@aalis/util-network-guard';
import { detectExtensionFromBuffer, readBodyCapped } from './attachment-cache.js';

/** base64 内联上限（10 MiB）。超过则降级为 URL/file:// 并记 warn。 */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/** 各媒介内联前认的格式（detectExtensionFromBuffer 的结果）；audio 的 mp4 是 M4A，与 MP4 同为 ftyp 容器。 */
const INLINE_FORMATS: Record<'image' | 'audio' | 'video', ReadonlySet<string>> = {
  image: new Set(['png', 'jpg', 'gif', 'webp']),
  audio: new Set(['wav', 'mp3', 'ogg', 'flac', 'amr', 'silk', 'mp4']),
  video: new Set(['mp4', 'webm']),
};

/** 文件头读这么多字节（detectExtensionFromBuffer 看的都在前 12 字节里） */
const HEAD_BYTES = 64;

/** 媒介附件按文件头核对格式，不符就抛错拒发；file 附件不核对（群文件本来就收任意类型） */
function assertFormat(kind: MessageAttachment['kind'], head: Buffer): void {
  if (kind !== 'file' && !INLINE_FORMATS[kind].has(detectExtensionFromBuffer(head, ''))) {
    throw new Error(`内容不是可发送的 ${kind} 格式（文件头不符），已拒发`);
  }
}

/** 把 Buffer 包成 base64:// 字符串，媒介附件先核对文件头 */
function toBase64Uri(kind: MessageAttachment['kind'], buf: Buffer): string {
  assertFormat(kind, buf);
  return `base64://${buf.toString('base64')}`;
}

/**
 * 读 storage 文件的开头（按字节区间，不整份读进内存）。读不出就抛错拒发：能退回宿主路径的是本机存储，
 * 本机存储都支持区间读取
 */
async function readHead(storage: StorageService, uri: string): Promise<Buffer> {
  const head = await storage.readFileRange?.(uri, 0, HEAD_BYTES);
  if (!head) throw new Error('读不出文件头，已拒发');
  return head;
}

/**
 * 把附件物化为 OneBot 消息段 `file` 字段或上传接口可接受的字符串。
 */
async function attachmentToOneBotFile(
  att: MessageAttachment,
  storage: StorageService,
  logger?: Logger,
): Promise<string> {
  const data = att.data;
  if (!data) throw new Error('attachment.data is empty');

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
    return toBase64Uri(att.kind, buf);
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
      return data;
    }
    return toBase64Uri(att.kind, capped);
  }

  // storage URI（如 data:/images/xxx）→ storage.readFile → base64
  if (isStorageUri(data)) {
    // 读前先量：视频也走这里，超限的不整份读进内存
    const { size } = await storage.stat(data);
    if (size > MAX_INLINE_BYTES) {
      // 交宿主路径之前同样核对文件头：daemon 读得到宿主路径时，任意可读文件不能借「超过上限」冒充媒体发出
      assertFormat(att.kind, await readHead(storage, data));
      logger?.warn?.(
        `OneBot storage 附件 ${size}B 超过内联上限，改交 file:// 宿主路径（daemon 与 Aalis 不共享文件系统时读不到，如 NapCat 在容器里）`,
      );
      try {
        const local = await storage.resolveLocalPath?.(data, 'read');
        if (local) return `file://${local}`;
      } catch {
        /* fall through */
      }
      throw new Error('attachment too large and not resolvable to local path');
    }
    const raw = (await storage.readFile(data)) as Uint8Array;
    return toBase64Uri(att.kind, Buffer.from(raw));
  }

  // file:// 或裸路径：直接交给 daemon 处理（依赖 daemon 与文件系统共享）
  if (data.startsWith('file://')) {
    return data;
  }
  // 兜底：当作本地绝对路径，包成 file://
  return `file://${data}`;
}

/** 媒介附件对应的消息段标记与日志里的称呼 */
const MARKERS: Record<'image' | 'audio' | 'video', { tag: string; label: string }> = {
  image: { tag: 'image', label: '图片' },
  audio: { tag: 'record', label: '语音' },
  video: { tag: 'video', label: '视频' },
};

/**
 * 把媒介附件渲染为可拼接到 content 的标记串。
 * - image / audio / video：物化为 base64://（走 WS 隧道，Docker 部署最稳）→ `<image>` / `<record>` / `<video>`；
 *   超过内联上限的退回 URL 或 file:// 宿主路径，daemon 读不到时发不出
 * - file 不走消息段，由调用方经 materializeFileAttachment 物化后上传
 * - 失败的附件（含文件头不符）warn 后跳过
 */
export async function renderAttachmentsAsContentMarkers(
  attachments: MessageAttachment[] | undefined,
  storage: StorageService,
  logger?: Logger,
): Promise<string> {
  if (!attachments?.length) return '';
  const parts: string[] = [];
  for (const att of attachments) {
    if (att.kind === 'file') continue;
    const { tag, label } = MARKERS[att.kind];
    try {
      const uri = await attachmentToOneBotFile(att, storage, logger);
      parts.push(`<${tag} url="${uri}"/>`);
    } catch (err) {
      logger?.warn?.(`OneBot ${label}附件物化失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  return parts.join('');
}

/**
 * 把 file 附件物化为群文件、私聊文件上传用的 `{ file, name }`，内容只收 `base64://`：
 * attachmentToOneBotFile 遇到超过内联上限的 storage 文件会退回 `file://<宿主路径>`，
 * 超限的 http 链接会原样返回，这两种形态容器里的 NapCat 都读不到，一律拒发（抛错）。
 * `name` 是群文件里显示的文件名，去掉路径分隔符；缺省为 `file`。
 */
export async function materializeFileAttachment(
  att: MessageAttachment,
  storage: StorageService,
  logger?: Logger,
): Promise<{ file: string; name: string }> {
  const file = await attachmentToOneBotFile(att, storage, logger);
  if (!file.startsWith('base64://')) {
    throw new Error('文件附件只能以 base64:// 上传（超过内联上限或来源是宿主路径、原链接时 NapCat 读不到）');
  }
  const name = (att.name ?? '').replace(/[/\\]/g, '');
  return { file, name: name || 'file' };
}
