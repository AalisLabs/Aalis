// ============================================================
// attachments.ts — 把 OutgoingMessage.attachments 转为 OneBot 可发的本地文件
//
// 远程 URL → 下载到 data/.tmp-outgoing/ → 返回 file:///abs/path
// data URI → 写临时文件 → 返回 file:///abs/path
// file://  → 原样返回（去掉 file:// 前缀）
// http(s):// 在 noDownload=false 时下载；否则原样保留
// 本地路径 → 转为 file:// 形式
// ============================================================

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import type { Logger } from '@aalis/core';
import type { MessageAttachment } from '@aalis/plugin-message-api';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

async function ensureTmpDir(): Promise<string> {
  const dir = join(tmpdir(), 'aalis-onebot-out');
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

function extFromMime(mime: string | undefined): string {
  if (!mime) return '.bin';
  return EXT_BY_MIME[mime] ?? `.${mime.split('/')[1] ?? 'bin'}`;
}

/**
 * 把附件物化为本地文件，返回 file:// URI。失败抛错。
 * 用于 OneBot 发图：HTTP URL 也下载下来，避免远端实现拒绝外网链接。
 */
async function attachmentToFileUri(att: MessageAttachment, logger?: Logger): Promise<string> {
  const data = att.data;
  if (!data) throw new Error('attachment.data is empty');

  if (data.startsWith('file://')) return data;
  if (data.startsWith('data:')) {
    const m = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('invalid data URI');
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const dir = await ensureTmpDir();
    const ext = att.name ? extname(att.name) : extFromMime(mime);
    const filePath = join(dir, `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await writeFile(filePath, buf);
    return `file://${filePath}`;
  }
  if (data.startsWith('http://') || data.startsWith('https://')) {
    logger?.debug?.(`OneBot 下载远程附件: ${data.slice(0, 120)}`);
    const res = await fetch(data);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${data}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = await ensureTmpDir();
    const clean = data.split('?')[0].split('#')[0];
    const ext =
      extname(clean).toLowerCase() || extFromMime(att.mimeType || res.headers.get('content-type')?.split(';')[0] || '');
    const filePath = join(dir, `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await writeFile(filePath, buf);
    return `file://${filePath}`;
  }
  // 已是本地路径（绝对或相对）
  const abs = isAbsolute(data) ? data : resolve(process.cwd(), data);
  return `file://${abs}`;
}

/**
 * 把 attachments[] 渲染为可拼接到 content 的 `<image url="file://..."/>` 标记串。
 * - 仅渲染 image / video（其余 kind 由后续扩展或忽略）
 * - 失败的附件以注释形式提示，便于排查
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
      const uri = await attachmentToFileUri(att, logger);
      parts.push(`<image url="${uri}"/>`);
    } catch (err) {
      logger?.warn?.(`OneBot 附件物化失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  return parts.join('');
}
