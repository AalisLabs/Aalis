import path from 'node:path';
import type { Context } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import type express from 'express';
import type { RouteGate } from '../gate.js';

/**
 * file-reader 元信息（与 plugin-file-reader 的 FileMeta 保持一致；
 * 此处不直接 import 是为了避免 webui-server 反向依赖 file-reader 插件包）
 */
interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sessionId: string;
  uploadedAt: number;
  textCache?: string;
}

const ROOT_PREFIX = 'pluginData:/file-reader';

interface UploadedFilesRoutesOptions {
  storage: StorageService | undefined;
}

export function registerUploadedFilesRoutes(
  expressApp: express.Express,
  ctx: Context,
  opts: UploadedFilesRoutesOptions,
  gate: RouteGate,
): void {
  const { storage } = opts;

  if (!storage) {
    expressApp.get('/api/uploaded-files', (_req, res) => {
      res.status(503).json({ error: 'storage 服务不可用' });
    });
    expressApp.get('/api/uploaded-files/download', (_req, res) => {
      res.status(503).json({ error: 'storage 服务不可用' });
    });
    expressApp.post('/api/uploaded-files/delete', (_req, res) => {
      res.status(503).json({ error: 'storage 服务不可用' });
    });
    return;
  }

  function isSafeSessionId(s: string): boolean {
    return /^[A-Za-z0-9._:-]{1,128}$/.test(s);
  }
  function isSafeFileId(s: string): boolean {
    return /^[A-Fa-f0-9]{8,64}$/.test(s);
  }

  async function readMeta(sessionId: string, fileId: string): Promise<FileMeta | null> {
    try {
      const raw = await storage!.readFile(`${ROOT_PREFIX}/${sessionId}/${fileId}.meta.json`);
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      return JSON.parse(text) as FileMeta;
    } catch {
      return null;
    }
  }

  /** 列出某 session 下的所有上传文件元信息（不传 sessionId 时列全部 session） */
  expressApp.get('/api/uploaded-files', gate('webui:files:read', 'restricted'), async (req, res) => {
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
    if (sessionId !== undefined && !isSafeSessionId(sessionId)) {
      res.status(400).json({ error: 'sessionId 非法' });
      return;
    }
    try {
      const results: FileMeta[] = [];
      const sessions: string[] = [];
      if (sessionId) {
        sessions.push(sessionId);
      } else {
        try {
          const root = await storage.list(ROOT_PREFIX);
          for (const e of root.entries) {
            if (e.isDirectory) sessions.push(e.name);
          }
        } catch {
          /* 根目录不存在视为空 */
        }
      }
      for (const sid of sessions) {
        try {
          const list = await storage.list(`${ROOT_PREFIX}/${sid}`);
          for (const e of list.entries) {
            if (!e.name.endsWith('.meta.json')) continue;
            try {
              const raw = await storage.readFile(e.uri);
              const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
              const meta = JSON.parse(text) as FileMeta;
              // 不外泄全文缓存
              const { textCache: _tc, ...slim } = meta;
              results.push(slim as FileMeta);
            } catch (err) {
              ctx.logger.debug(`读取 meta 失败 ${e.uri}:`, err);
            }
          }
        } catch {
          /* session 目录不存在 */
        }
      }
      results.sort((a, b) => b.uploadedAt - a.uploadedAt);
      res.json({ files: results });
    } catch (err) {
      ctx.logger.warn('列出上传文件失败:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** 下载文件 */
  expressApp.get('/api/uploaded-files/download', gate('webui:files:read', 'restricted'), async (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    const fileId = String(req.query.fileId || '');
    if (!isSafeSessionId(sessionId) || !isSafeFileId(fileId)) {
      res.status(400).json({ error: 'sessionId 或 fileId 非法' });
      return;
    }
    const meta = await readMeta(sessionId, fileId);
    if (!meta) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    const ext = path.extname(meta.name) || '';
    const dataUri = `${ROOT_PREFIX}/${sessionId}/${fileId}${ext}`;
    try {
      const result = await storage.createReadStream(dataUri);
      res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
      res.setHeader('Content-Length', String(result.stat.size));
      result.stream.pipe(res);
    } catch (err) {
      ctx.logger.warn('下载上传文件失败:', err);
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** 删除文件 */
  expressApp.post('/api/uploaded-files/delete', gate('webui:files:write', 'restricted'), async (req, res) => {
    const body = (req.body ?? {}) as { sessionId?: string; fileId?: string };
    const sessionId = body.sessionId ?? '';
    const fileId = body.fileId ?? '';
    if (!isSafeSessionId(sessionId) || !isSafeFileId(fileId)) {
      res.status(400).json({ error: 'sessionId 或 fileId 非法' });
      return;
    }
    const meta = await readMeta(sessionId, fileId);
    if (!meta) {
      res.status(404).json({ error: '文件不存在或已被删除' });
      return;
    }
    const ext = path.extname(meta.name) || '';
    const dataUri = `${ROOT_PREFIX}/${sessionId}/${fileId}${ext}`;
    const metaUri = `${ROOT_PREFIX}/${sessionId}/${fileId}.meta.json`;
    const errors: string[] = [];
    try {
      await storage.delete(dataUri);
    } catch (err) {
      errors.push(`数据文件: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await storage.delete(metaUri);
    } catch (err) {
      errors.push(`meta: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 同步通知 file-reader 服务把内存索引也清掉
    try {
      const reader = ctx.getService<{ deleteFile?: (id: string) => Promise<boolean> }>('file-reader');
      if (reader?.deleteFile) await reader.deleteFile(fileId);
    } catch (err) {
      ctx.logger.debug('file-reader 索引同步失败:', err);
    }
    if (errors.length > 0) {
      res.status(500).json({ error: errors.join('; ') });
      return;
    }
    res.json({ ok: true, name: meta.name, id: fileId });
  });
}
