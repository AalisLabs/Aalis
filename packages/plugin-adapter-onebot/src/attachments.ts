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
// file:// 与本地绝对路径不再由本插件直接读取（避免依赖 node:fs），原样透传
// 给 daemon。生产侧 attachments 几乎都来自 plugin-media / plugin-image-sender
// 产出的 storage URI / data URI，故此回归仅在裸 file:// 用例下生效。
// ============================================================

import { Buffer } from 'node:buffer';
import type { Logger } from '@aalis/core';
import type { MessageAttachment } from '@aalis/plugin-message-api';
import type { StorageService } from '@aalis/plugin-storage-api';

/** base64 内联上限（10 MiB）。超过则降级为 URL/file:// 并记 warn。 */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/** 把 Buffer 包成 base64:// 字符串。 */
function toBase64Uri(buf: Buffer): string {
  return `base64://${buf.toString('base64')}`;
}

/** 简易判定：形如 <root>:/<path>，且 root 非 http/https/file。
 * 注意："data:/path" 是 storage 根路径（storage URI），
 * "data:image/png;base64,..." 是标准 data URI（非 storage）——
 * 区分依据：storage URI 的冒号后紧跟 '/'，标准 data URI 后跟 MIME type。 */
function isStorageUri(s: string): boolean {
  if (!/^[a-z][a-z0-9_-]*:\//.test(s)) return false;
  const colonIdx = s.indexOf(':');
  const scheme = s.slice(0, colonIdx).toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'file') return false;
  // data:/ → storage root；data:mime/type;base64,... → 标准 data URI → 非 storage
  if (scheme === 'data') return s[colonIdx + 1] === '/';
  return true;
}

/**
 * 把附件物化为 OneBot `image.file` 可接受的字符串。
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
    return toBase64Uri(buf);
  }

  // http(s):// → 下载后 base64 内联
  if (data.startsWith('http://') || data.startsWith('https://')) {
    logger?.debug?.(`OneBot 下载远程附件: ${data.slice(0, 120)}`);
    const res = await fetch(data);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${data}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_INLINE_BYTES) {
      logger?.warn?.(`OneBot 远程附件 ${ab.byteLength}B 超过内联上限，回退到 URL（依赖 daemon 直拉）`);
      return data;
    }
    return toBase64Uri(Buffer.from(ab));
  }

  // storage URI（如 data:/images/xxx）→ storage.readFile → base64
  if (isStorageUri(data)) {
    const raw = (await storage.readFile(data)) as Uint8Array;
    if (raw.byteLength > MAX_INLINE_BYTES) {
      logger?.warn?.(`OneBot storage 附件 ${raw.byteLength}B 超过内联上限，尝试转 file:// 由 daemon 处理`);
      try {
        const local = await storage.resolveLocalPath?.(data, 'read');
        if (local) return `file://${local}`;
      } catch {
        /* fall through */
      }
      throw new Error('attachment too large and not resolvable to local path');
    }
    return toBase64Uri(Buffer.from(raw));
  }

  // file:// 或裸路径：直接交给 daemon 处理（依赖 daemon 与文件系统共享）
  if (data.startsWith('file://')) {
    return data;
  }
  // 兜底：当作本地绝对路径，包成 file://
  return `file://${data}`;
}

/**
 * 把 attachments[] 渲染为可拼接到 content 的 `<image url="..."/>` 标记串。
 * - 仅渲染 image / video（其余 kind 由后续扩展或忽略）
 * - 失败的附件 warn 后跳过
 */
export async function renderAttachmentsAsContentMarkers(
  attachments: MessageAttachment[] | undefined,
  storage: StorageService,
  logger?: Logger,
): Promise<string> {
  if (!attachments?.length) return '';
  const parts: string[] = [];
  for (const att of attachments) {
    if (att.kind !== 'image' && att.kind !== 'video') {
      logger?.debug?.(`OneBot 跳过 ${att.kind} 附件（暂未支持非图像/视频结构化发送）`);
      continue;
    }
    try {
      const uri = await attachmentToOneBotFile(att, storage, logger);
      parts.push(`<image url="${uri}"/>`);
    } catch (err) {
      logger?.warn?.(`OneBot 附件物化失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  return parts.join('');
}
