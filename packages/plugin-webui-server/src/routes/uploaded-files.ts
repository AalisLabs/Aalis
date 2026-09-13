import path from 'node:path';
import type { StorageService } from '@aalis/api-storage';
import type { Context } from '@aalis/core';
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

/**
 * 会话目录名候选：与 plugin-file-reader 同一套替换（sessionId 含 `:` 时 Windows 文件名不收），
 * 老版本按原样 sessionId 建过目录，读侧两种都试（替换后的优先）。
 */
function sessionDirs(sessionId: string): string[] {
  const safe = sessionId.replace(/[:/\\]/g, '_');
  return safe === sessionId ? [sessionId] : [safe, sessionId];
}

interface UploadedFilesRoutesOptions {
  /** storage 服务（必填）——传入的是 createStorageGateway 的返回值，恒为对象；
   *  storage 服务缺席时 gateway 各方法内部 dispatch 抛错，而列表路由的内层 catch 会把它
   *  吞成空列表（前端看到「没有文件」而非「存储不可用」），download/delete 则落 404 */
  storage: StorageService;
}

export function registerUploadedFilesRoutes(
  expressApp: express.Express,
  ctx: Context,
  opts: UploadedFilesRoutesOptions,
  gate: RouteGate,
): void {
  const { storage } = opts;

  function isSafeSessionId(s: string): boolean {
    return /^[A-Za-z0-9._:-]{1,128}$/.test(s);
  }
  function isSafeFileId(s: string): boolean {
    return /^[A-Fa-f0-9]{8,64}$/.test(s);
  }

  /** 读 meta 并返回它实际所在的会话目录名（数据文件与它同目录） */
  async function readMeta(sessionId: string, fileId: string): Promise<{ meta: FileMeta; dir: string } | null> {
    for (const dir of sessionDirs(sessionId)) {
      try {
        const raw = await storage.readFile(`${ROOT_PREFIX}/${dir}/${fileId}.meta.json`);
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        return { meta: JSON.parse(text) as FileMeta, dir };
      } catch {
        /* 试下一种目录名 */
      }
    }
    return null;
  }

  /** 列出某 session 下的所有上传文件元信息（不传 sessionId 时列全部 session） */
  expressApp.get('/api/uploaded-files', gate(), async (req, res) => {
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
    if (sessionId !== undefined && !isSafeSessionId(sessionId)) {
      res.status(400).json({ error: 'sessionId 非法' });
      return;
    }
    try {
      const results: FileMeta[] = [];
      const sessions: string[] = [];
      if (sessionId) {
        sessions.push(...sessionDirs(sessionId));
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
  expressApp.get('/api/uploaded-files/download', gate(), async (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    const fileId = String(req.query.fileId || '');
    if (!isSafeSessionId(sessionId) || !isSafeFileId(fileId)) {
      res.status(400).json({ error: 'sessionId 或 fileId 非法' });
      return;
    }
    const found = await readMeta(sessionId, fileId);
    if (!found) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    const { meta, dir } = found;
    const ext = path.extname(meta.name) || '';
    const dataUri = `${ROOT_PREFIX}/${dir}/${fileId}${ext}`;
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
  expressApp.post('/api/uploaded-files/delete', gate(), async (req, res) => {
    const body = (req.body ?? {}) as { sessionId?: string; fileId?: string };
    const sessionId = body.sessionId ?? '';
    const fileId = body.fileId ?? '';
    if (!isSafeSessionId(sessionId) || !isSafeFileId(fileId)) {
      res.status(400).json({ error: 'sessionId 或 fileId 非法' });
      return;
    }
    const found = await readMeta(sessionId, fileId);
    if (!found) {
      res.status(404).json({ error: '文件不存在或已被删除' });
      return;
    }
    const { meta, dir } = found;
    const ext = path.extname(meta.name) || '';
    const dataUri = `${ROOT_PREFIX}/${dir}/${fileId}${ext}`;
    const metaUri = `${ROOT_PREFIX}/${dir}/${fileId}.meta.json`;
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
