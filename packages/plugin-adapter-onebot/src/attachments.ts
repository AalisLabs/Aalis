// ============================================================
// attachments.ts — 把 OutgoingMessage.attachments 转为 OneBot 可发的字符串
//
// OneBot v11 image.file 字段支持三种 scheme：
//   - http(s)://...        OneBot 守护进程自行拉取
//   - file:///abs/path     OneBot 守护进程从本地文件系统读取
//   - base64://<b64>       数据内嵌在消息里随 WS 隧道发送（适合 Docker 部署）
//
// 由于 NapCat / go-cqhttp 经常跑在 Docker / 远端机器，file:// 不一定可达。
// 默认策略：把所有附件转成 base64://，让数据走 WS 隧道，最稳。
// 超过 MAX_INLINE_BYTES 的附件回退到原始 URL/file:// + warn。
// ============================================================

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Logger } from '@aalis/core';
import type { MessageAttachment } from '@aalis/plugin-message-api';

/** base64 内联上限（10 MiB）。超过则降级为 URL/file:// 并记 warn。 */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/** 把 Buffer 包成 base64:// 字符串。 */
function toBase64Uri(buf: Buffer): string {
  return `base64://${buf.toString('base64')}`;
}

/**
 * 把附件物化为 OneBot `image.file` 可接受的字符串。
 *
 * 默认始终返回 base64:// 让数据随 WS 隧道发出，避免 OneBot daemon 与 Aalis
 * 不在同一文件系统时（典型场景：NapCat 跑在 Docker 内）发生 ENOENT。
 *
 * 失败时抛错，调用方可降级或忽略此条附件。
 */
async function attachmentToOneBotFile(att: MessageAttachment, logger?: Logger): Promise<string> {
  const data = att.data;
  if (!data) throw new Error('attachment.data is empty');

  // data:image/...;base64,xxx → base64://xxx
  if (data.startsWith('data:')) {
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

  // file:// 或本地绝对/相对路径 → 读取后 base64 内联
  let absPath: string;
  if (data.startsWith('file://')) {
    absPath = data.slice('file://'.length);
  } else if (isAbsolute(data)) {
    absPath = data;
  } else {
    absPath = resolve(process.cwd(), data);
  }
  const st = await stat(absPath).catch(() => null);
  if (!st?.isFile()) {
    // 让 daemon 自己尝试 file://（适用于 daemon 与 Aalis 共用文件系统的场景）
    logger?.warn?.(`OneBot 附件本地路径不可读，回退 file:// 由 daemon 处理: ${absPath}`);
    return `file://${absPath}`;
  }
  if (st.size > MAX_INLINE_BYTES) {
    logger?.warn?.(`OneBot 本地附件 ${st.size}B 超过内联上限，回退 file:// 由 daemon 处理`);
    return `file://${absPath}`;
  }
  const buf = await readFile(absPath);
  return toBase64Uri(buf);
}

/**
 * 把 attachments[] 渲染为可拼接到 content 的 `<image url="..."/>` 标记串。
 * - 仅渲染 image / video（其余 kind 由后续扩展或忽略）
 * - 失败的附件 warn 后跳过
 */
export async function renderAttachmentsAsContentMarkers(
  attachments: MessageAttachment[] | undefined,
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
      const uri = await attachmentToOneBotFile(att, logger);
      parts.push(`<image url="${uri}"/>`);
    } catch (err) {
      logger?.warn?.(`OneBot 附件物化失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  return parts.join('');
}
