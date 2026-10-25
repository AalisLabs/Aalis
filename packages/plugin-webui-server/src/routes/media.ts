// ============================================================
// routes/media.ts — 聊天里的图片、视频与音频按存储地址取
//
// GET /api/media?uri=<storage URI>（如 data:/images/x.png）。聊天消息与会话历史里的附件多半是存储
// 地址，浏览器拿它当不了图片地址；客户端把它换成这条路由。只有 owner（cookie 闸）能取；按文件头判定类型，
// 只放行浏览器能直接显示或播放的图片、视频与音频，其余（含 HTML、SVG、JSON 记录）一律 415，不在 WebUI 源里内联。
// 响应带 nosniff 与 sandbox CSP，类型取判定结果、不取扩展名。文件不存在回 404，其余读不出的（含存储拒绝的越界路径）
// 回 500 并记告警。
// ============================================================

import { isStorageNotFound, isStorageUri, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import { detectMediaFormat, FILE_HEAD_BYTES, type MediaFormat, type MediaFormatName } from '@aalis/util-file-signature';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import { route } from '../route.js';
import { t } from '../texts.js';
import { pipeToResponse } from './pipe-to-response.js';

/** 浏览器能直接显示或播放的格式：这条路由与图片代理（只取其中的图片）都只提供这几种，响应类型取判定结果 */
const BROWSER_MEDIA: ReadonlySet<MediaFormatName> = new Set([
  'PNG',
  'JPEG',
  'GIF',
  'WebP',
  'MP4',
  'WebM',
  'MP3',
  'WAV',
  'OGG',
  'M4A',
]);

/** 按文件头判定出浏览器能直接显示或播放的格式，判不出或不在 {@link BROWSER_MEDIA} 里的为 undefined */
export function browserMediaOf(head: Uint8Array): MediaFormat | undefined {
  const format = detectMediaFormat(head.subarray(0, FILE_HEAD_BYTES));
  return format && BROWSER_MEDIA.has(format.format) ? format : undefined;
}

/** 传入的是 storage 的业务句柄：区间读恒有定义，提供者不支持时调用即抛错 */
export function registerMediaRoutes(
  expressApp: express.Express,
  storage: StorageService & Required<Pick<StorageService, 'readFileRange'>>,
  logger: Logger,
  gate: RouteGate,
): void {
  route(expressApp, 'GET /api/media', gate(), async (req, res) => {
    const uri = String(req.query.uri ?? '');
    if (!isStorageUri(uri)) {
      res.status(400).json({ error: t('notStorageUri') });
      return;
    }
    try {
      const format = browserMediaOf(await storage.readFileRange(uri, 0, FILE_HEAD_BYTES));
      if (!format) {
        res.status(415).json({ error: t('notMedia') });
        return;
      }
      const { stream, stat } = await storage.createReadStream(uri);
      res.setHeader('Content-Type', format.mime);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Cache-Control', 'private, max-age=3600');
      pipeToResponse(stream, res, logger, `媒体文件 ${uri}`);
    } catch (err) {
      if (isStorageNotFound(err)) {
        res.status(404).json({ error: t('fileMissing') });
        return;
      }
      logger.warn(`读取媒体文件 ${uri} 失败:`, err);
      res.status(500).json({ error: t('readFailed') });
    }
  });
}
