// ============================================================
// routes/files.ts — WebUI 文件管理 REST 路由（storage URI 版）
//
// 历史上同时支持 storage 与 node:fs 两种实现；现已要求 storage 必填，
// node:fs 兜底分支整体移除，所有操作走 StorageService。
// 前端仅需传递相对于 fileRoot 的路径字符串（如 "data/images/xxx.png"）。
// ============================================================

import { basename } from 'node:path';
import type { Context } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import type express from 'express';
import type { RouteGate } from '../gate.js';

export interface FileRoutesOptions {
  /** storage 服务（必填） */
  storage: StorageService;
  /** storage 根 ID，默认 workspace */
  fileRoot: string;
}

/** 注册文件管理相关 REST 路由 */
export function registerFileRoutes(
  expressApp: express.Express,
  _ctx: Context,
  opts: FileRoutesOptions,
  gate: RouteGate,
): void {
  const { storage, fileRoot } = opts;

  function storageUri(relPath: string): string {
    const cleanPath = relPath.replace(/^\/+/, '');
    return `${fileRoot}:/${cleanPath}`;
  }

  function pathFromStorageUri(uri: string): string {
    const idx = uri.indexOf(':/');
    return idx >= 0 ? uri.slice(idx + 2) : uri;
  }

  function storageRootBrowsable(): boolean {
    const root = storage.listRoots().find(r => r.name === fileRoot);
    return Boolean(root?.browsable);
  }

  function sendStorageError(res: express.Response, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message.includes('路径不合法') || message.includes('不允许')
        ? 403
        : message.includes('不存在') || message.includes('ENOENT')
          ? 404
          : message.includes('不是目录') || message.includes('不能') || message.includes('不合法')
            ? 400
            : 500;
    res.status(status).json({ error: message });
  }

  function guardBrowsable(res: express.Response): boolean {
    if (!storageRootBrowsable()) {
      res.status(403).json({ error: '文件根不可浏览' });
      return false;
    }
    return true;
  }

  // 列出目录内容
  expressApp.get('/api/files', gate('webui:files:read', 4), async (req, res) => {
    const dir = String(req.query.path || '');
    if (!guardBrowsable(res)) return;
    try {
      const result = await storage.list(storageUri(dir));
      res.json({ path: result.path, entries: result.entries });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  // 获取文件/目录详情
  expressApp.get('/api/files/info', gate('webui:files:read', 4), async (req, res) => {
    const filePath = String(req.query.path || '');
    if (!guardBrowsable(res)) return;
    try {
      const info = await storage.stat(storageUri(filePath));
      res.json(info);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  // 下载文件
  expressApp.get('/api/files/download', gate('webui:files:read', 4), async (req, res) => {
    const filePath = String(req.query.path || '');
    if (!guardBrowsable(res)) return;
    try {
      const result = await storage.createReadStream(storageUri(filePath));
      const fileName = basename(result.stat.name);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('Content-Length', result.stat.size);
      result.stream.pipe(res);
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  // 重命名
  expressApp.post('/api/files/rename', gate('webui:files:write', 'owner'), async (req, res) => {
    const { path: filePath, newName } = req.body ?? {};
    if (!filePath || !newName) {
      res.status(400).json({ error: '缺少参数' });
      return;
    }
    if (
      typeof newName !== 'string' ||
      newName.includes('/') ||
      newName.includes('\\') ||
      newName === '.' ||
      newName === '..'
    ) {
      res.status(400).json({ error: '文件名不合法' });
      return;
    }
    if (!guardBrowsable(res)) return;
    try {
      const newUri = await storage.rename(storageUri(String(filePath)), String(newName));
      res.json({ ok: true, newPath: pathFromStorageUri(newUri) });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  // 删除
  expressApp.post('/api/files/delete', gate('webui:files:write', 'owner'), async (req, res) => {
    const { path: filePath } = req.body ?? {};
    if (!filePath) {
      res.status(400).json({ error: '缺少参数' });
      return;
    }
    if (!guardBrowsable(res)) return;
    try {
      await storage.delete(storageUri(String(filePath)));
      res.json({ ok: true });
    } catch (err) {
      sendStorageError(res, err);
    }
  });
}
