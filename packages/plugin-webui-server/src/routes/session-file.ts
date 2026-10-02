// ============================================================
// routes/session-file.ts — 会话条目里的文件按句柄下载
//
// GET /api/session-file?sessionId=<会话>&handle=<句柄>。句柄由会话服务签发、绑定会话与文件，先请它核验，再按核验出的
// 存储地址读出，一律当附件以 octet-stream 下发，不在 WebUI 源里内联。只有 owner（cookie 闸）能取。
// 不接受存储地址：按地址任意读取会把 data 根（家目录的 state/，里面有 token 与审计）整个暴露出去。
// 句柄核验不过（含会话服务不在、重启过）回 403，文件已不在回 404，其余读不出的回 500 并记告警。
// ============================================================

import type { SessionProtocolService } from '@aalis/api-session-protocol';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger, ServiceRef } from '@aalis/core';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import { pipeToResponse } from './pipe-to-response.js';

export function registerSessionFileRoute(
  expressApp: express.Express,
  storage: StorageService,
  sessions: Pick<ServiceRef<SessionProtocolService>, 'current'>,
  logger: Logger,
  gate: RouteGate,
): void {
  expressApp.get('/api/session-file', gate(), async (req, res) => {
    const file = sessions.current?.resolveFile(String(req.query.sessionId ?? ''), String(req.query.handle ?? ''));
    if (!file) {
      res.status(403).json({ error: '文件句柄无效' });
      return;
    }
    try {
      const { stream, stat } = await storage.createReadStream(file.uri);
      // attachment 按扩展名设了类型，随后一律盖成 octet-stream
      res.attachment(file.name);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      pipeToResponse(stream, res, logger, `会话文件 ${file.uri}`);
    } catch (err) {
      if (isStorageNotFound(err)) {
        res.status(404).json({ error: '文件已不在' });
        return;
      }
      logger.warn(`读取会话文件 ${file.uri} 失败:`, err);
      res.status(500).json({ error: '读取文件失败' });
    }
  });
}
