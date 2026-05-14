// ============================================================
// normalize.ts — IncomingMessage.attachments 归一化
//
// 唯一职责：补齐 attachments 中缺失的 mimeType（按扩展名/data URL 头推断）。
// 老的 images[]/files[] 字段已从 IncomingMessage 移除，由各适配器在边界
// 处自行装入 attachments[]。
// ============================================================

import type { IncomingMessage, MessageAttachment } from '@aalis/plugin-message-api';

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus', 'amr', 'silk']);

/** 从 data URL / 路径推断 mime；无法判定返回 undefined。 */
function guessMime(data: string, name?: string): string | undefined {
  if (data.startsWith('data:')) {
    const m = data.match(/^data:([^;]+);/);
    if (m) return m[1];
  }
  const src = name ?? data;
  const clean = src.split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  if (IMAGE_MIME_BY_EXT[ext]) return IMAGE_MIME_BY_EXT[ext];
  if (VIDEO_EXTS.has(ext)) return `video/${ext === 'mov' ? 'quicktime' : ext}`;
  if (AUDIO_EXTS.has(ext)) return `audio/${ext === 'mp3' ? 'mpeg' : ext}`;
  return undefined;
}

/** 仅补齐 mimeType，保持原顺序。 */
export function normalizeAttachments(msg: IncomingMessage): MessageAttachment[] {
  if (!msg.attachments?.length) return [];
  return msg.attachments.map(a => ({
    ...a,
    mimeType: a.mimeType ?? guessMime(a.data, a.name),
  }));
}
