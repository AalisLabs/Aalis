// ============================================================
// routes/files.ts — 按句柄下载文件
//
// GET /api/session-file?sessionId=<会话>&handle=<句柄>：会话条目里的文件。句柄由会话服务签发、绑定会话与文件，先请它核验。
// GET /api/page-file?handle=<句柄>：页面单元格里的文件。句柄由本插件签发（page-files.ts）。
// 核验出的存储地址读出后一律当附件以 octet-stream 下发，不在 WebUI 源里内联。只有 owner（cookie 闸）能取。
// 不接受存储地址：按地址任意读取会把 data 根（家目录的 state/，里面有 token 与审计）整个暴露出去。
// 句柄核验不过（含签发方不在、重启过）回 403，文件已不在回 404，其余读不出的回 500 并记告警。
// ============================================================

import type { SessionProtocolService } from '@aalis/api-session-protocol';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { ErrorResponse } from '@aalis/api-webui';
import type { Logger, ServiceSelection } from '@aalis/core';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import type { PageFiles } from '../page-files.js';
import { route } from '../route.js';
import { pipeToResponse } from './pipe-to-response.js';

export function registerFileRoutes(
  expressApp: express.Express,
  storage: StorageService,
  issuers: { sessions: Pick<ServiceSelection<SessionProtocolService>, 'present' | 'use'>; pages: PageFiles },
  logger: Logger,
  gate: RouteGate,
): void {
  /** what 是日志里的叫法：会话文件或页面文件 */
  async function sendAttachment(
    res: express.Response<ErrorResponse>,
    file: { uri: string; name: string } | undefined,
    what: string,
  ) {
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
      pipeToResponse(stream, res, logger, `${what} ${file.uri}`);
    } catch (err) {
      if (isStorageNotFound(err)) {
        res.status(404).json({ error: '文件已不在' });
        return;
      }
      logger.warn(`读取${what} ${file.uri} 失败:`, err);
      res.status(500).json({ error: '读取文件失败' });
    }
  }

  route(expressApp, 'GET /api/session-file', gate(), (req, res) =>
    sendAttachment(
      res,
      issuers.sessions.present
        ? issuers.sessions.use.resolveFile(String(req.query.sessionId ?? ''), String(req.query.handle ?? ''))
        : undefined,
      '会话文件',
    ),
  );
  route(expressApp, 'GET /api/page-file', gate(), (req, res) =>
    sendAttachment(res, issuers.pages.resolve(String(req.query.handle ?? '')), '页面文件'),
  );
}
