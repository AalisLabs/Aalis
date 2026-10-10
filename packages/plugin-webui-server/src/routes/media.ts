// ============================================================
// routes/media.ts — 聊天里的图片、视频与音频按存储地址取
//
// GET /api/media?uri=<storage URI>（如 data:/images/x.png）。聊天消息与会话历史里的附件多半是存储
// 地址，浏览器拿它当不了图片地址；客户端把它换成这条路由。只有 owner（cookie 闸）能取；按文件头判定类型，
// 只放行浏览器能直接显示或播放的图片、视频与音频，其余（含 HTML、SVG、JSON 账本）一律 415，不在 WebUI 源里内联。
// 响应带 nosniff 与 sandbox CSP，类型取判定结果、不取扩展名。文件不存在回 404，其余读不出的（含存储拒绝的越界路径）
// 回 500 并记告警。
// ============================================================

import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import { detectMediaFormat, MEDIA_HEAD_BYTES } from '@aalis/util-media-signature';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import { route } from '../route.js';
import { pipeToResponse } from './pipe-to-response.js';

/** 判定出的格式 → 响应类型；不在表里的不提供 */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  GIF: 'image/gif',
  WebP: 'image/webp',
  MP4: 'video/mp4',
  WebM: 'video/webm',
  MP3: 'audio/mpeg',
  WAV: 'audio/wav',
  OGG: 'audio/ogg',
  M4A: 'audio/mp4',
};

/** 存储地址：<根名>:/<路径> */
const STORAGE_URI = /^[A-Za-z][\w-]*:\/[^\0]*$/;

/** 传入的是 storage 的业务句柄：区间读恒有定义，提供者不支持时调用即抛错 */
export function registerMediaRoutes(
  expressApp: express.Express,
  storage: StorageService & Required<Pick<StorageService, 'readFileRange'>>,
  logger: Logger,
  gate: RouteGate,
): void {
  route(expressApp, 'GET /api/media', gate(), async (req, res) => {
    const uri = String(req.query.uri ?? '');
    if (!STORAGE_URI.test(uri) || /^https?:/i.test(uri)) {
      res.status(400).json({ error: '不是存储地址' });
      return;
    }
    try {
      const head = await storage.readFileRange(uri, 0, MEDIA_HEAD_BYTES);
      const type = MEDIA_TYPES[detectMediaFormat(new Uint8Array(head))?.format ?? ''];
      if (!type) {
        res.status(415).json({ error: '只提供图片、视频与音频' });
        return;
      }
      const { stream, stat } = await storage.createReadStream(uri);
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Cache-Control', 'private, max-age=3600');
      pipeToResponse(stream, res, logger, `媒体文件 ${uri}`);
    } catch (err) {
      if (isStorageNotFound(err)) {
        res.status(404).json({ error: '文件不存在' });
        return;
      }
      logger.warn(`读取媒体文件 ${uri} 失败:`, err);
      res.status(500).json({ error: '读取文件失败' });
    }
  });
}
