import { createReadStream, existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Context } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import type express from 'express';

export interface FileRoutesOptions {
  /** storage 服务（可选；缺失时降级到本地 workspace 目录） */
  storage: StorageService | undefined;
  /** storage 根 ID，默认 workspace */
  fileRoot: string;
  /** 本地兼容根目录绝对路径 */
  workspaceRoot: string;
}

/** 注册文件管理相关 REST 路由 */
export function registerFileRoutes(expressApp: express.Express, _ctx: Context, opts: FileRoutesOptions): void {
  const { storage, fileRoot, workspaceRoot } = opts;

  function storageUri(relPath: string): string {
    const cleanPath = relPath.replace(/^\/+/, '');
    return `${fileRoot}:/${cleanPath}`;
  }

  function pathFromStorageUri(uri: string): string {
    const idx = uri.indexOf(':/');
    return idx >= 0 ? uri.slice(idx + 2) : uri;
  }

  function storageRootBrowsable(): boolean {
    const root = storage?.listRoots().find(r => r.name === fileRoot);
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

  function sendStorageUnavailable(res: express.Response): void {
    res.status(503).json({ error: '文件管理需要 storage 服务' });
  }

  /** 安全路径解析：确保在 workspace 目录内，防止路径穿越 */
  function safeResolvePath(relPath: string): string | null {
    const abs = resolve(workspaceRoot, relPath);
    const rel = relative(workspaceRoot, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return abs;
  }

  // 列出目录内容
  expressApp.get('/api/files', async (req, res) => {
    const dir = String(req.query.path || '');
    if (!storage) {
      sendStorageUnavailable(res);
      return;
    }
    if (storage) {
      if (!storageRootBrowsable()) {
        res.status(403).json({ error: '文件根不可浏览' });
        return;
      }
      try {
        const result = await storage.list(storageUri(dir));
        res.json({ path: result.path, entries: result.entries });
      } catch (err) {
        sendStorageError(res, err);
      }
      return;
    }

    const abs = safeResolvePath(dir);
    if (!abs) {
      res.status(403).json({ error: '路径不合法' });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '目录不存在' });
      return;
    }
    const stat = statSync(abs);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: '不是目录' });
      return;
    }
    try {
      const entries = readdirSync(abs)
        .map(name => {
          const fullPath = join(abs, name);
          try {
            const s = statSync(fullPath);
            return {
              name,
              path: relative(workspaceRoot, fullPath).replace(/\\/g, '/'),
              isDirectory: s.isDirectory(),
              size: s.isDirectory() ? 0 : s.size,
              mtime: s.mtime.toISOString(),
              ext: s.isDirectory() ? '' : extname(name).toLowerCase(),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      entries.sort((a, b) => {
        const ad = a as { isDirectory: boolean; name: string };
        const bd = b as { isDirectory: boolean; name: string };
        if (ad.isDirectory !== bd.isDirectory) return ad.isDirectory ? -1 : 1;
        return ad.name.localeCompare(bd.name);
      });
      const currentPath = relative(workspaceRoot, abs).replace(/\\/g, '/');
      res.json({ path: currentPath, entries });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 获取文件/目录详情
  expressApp.get('/api/files/info', async (req, res) => {
    const filePath = String(req.query.path || '');
    if (!storage) {
      sendStorageUnavailable(res);
      return;
    }
    if (storage) {
      if (!storageRootBrowsable()) {
        res.status(403).json({ error: '文件根不可浏览' });
        return;
      }
      try {
        const info = await storage.stat(storageUri(filePath));
        res.json(info);
      } catch (err) {
        sendStorageError(res, err);
      }
      return;
    }

    const abs = safeResolvePath(filePath);
    if (!abs) {
      res.status(403).json({ error: '路径不合法' });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '不存在' });
      return;
    }
    const s = statSync(abs);
    res.json({
      name: basename(abs),
      path: relative(workspaceRoot, abs).replace(/\\/g, '/'),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtime.toISOString(),
      birthtime: s.birthtime.toISOString(),
      ext: s.isDirectory() ? '' : extname(abs).toLowerCase(),
    });
  });

  // 下载文件
  expressApp.get('/api/files/download', async (req, res) => {
    const filePath = String(req.query.path || '');
    if (!storage) {
      sendStorageUnavailable(res);
      return;
    }
    if (storage) {
      if (!storageRootBrowsable()) {
        res.status(403).json({ error: '文件根不可浏览' });
        return;
      }
      try {
        const result = await storage.createReadStream(storageUri(filePath));
        const fileName = basename(result.stat.name);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.setHeader('Content-Length', result.stat.size);
        result.stream.pipe(res);
      } catch (err) {
        sendStorageError(res, err);
      }
      return;
    }

    const abs = safeResolvePath(filePath);
    if (!abs) {
      res.status(403).json({ error: '路径不合法' });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    const s = statSync(abs);
    if (s.isDirectory()) {
      res.status(400).json({ error: '不能下载目录' });
      return;
    }
    const fileName = basename(abs);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Length', s.size);
    createReadStream(abs).pipe(res);
  });

  // 重命名
  expressApp.post('/api/files/rename', async (req, res) => {
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
    if (!storage) {
      sendStorageUnavailable(res);
      return;
    }
    if (storage) {
      if (!storageRootBrowsable()) {
        res.status(403).json({ error: '文件根不可浏览' });
        return;
      }
      try {
        const newUri = await storage.rename(storageUri(String(filePath)), String(newName));
        res.json({ ok: true, newPath: pathFromStorageUri(newUri) });
      } catch (err) {
        sendStorageError(res, err);
      }
      return;
    }

    const abs = safeResolvePath(String(filePath));
    if (!abs) {
      res.status(403).json({ error: '路径不合法' });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    const newPath = resolve(dirname(abs), String(newName));
    const newRel = relative(workspaceRoot, newPath);
    if (newRel.startsWith('..') || isAbsolute(newRel)) {
      res.status(403).json({ error: '目标路径不合法' });
      return;
    }
    if (existsSync(newPath)) {
      res.status(409).json({ error: '目标名称已存在' });
      return;
    }
    try {
      renameSync(abs, newPath);
      res.json({ ok: true, newPath: relative(workspaceRoot, newPath).replace(/\\/g, '/') });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 删除
  expressApp.post('/api/files/delete', async (req, res) => {
    const { path: filePath } = req.body ?? {};
    if (!filePath) {
      res.status(400).json({ error: '缺少参数' });
      return;
    }
    if (!storage) {
      sendStorageUnavailable(res);
      return;
    }
    if (storage) {
      if (!storageRootBrowsable()) {
        res.status(403).json({ error: '文件根不可浏览' });
        return;
      }
      try {
        await storage.delete(storageUri(String(filePath)));
        res.json({ ok: true });
      } catch (err) {
        sendStorageError(res, err);
      }
      return;
    }

    const abs = safeResolvePath(String(filePath));
    if (!abs) {
      res.status(403).json({ error: '路径不合法' });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    if (abs === workspaceRoot) {
      res.status(403).json({ error: '不能删除根目录' });
      return;
    }
    try {
      const s = statSync(abs);
      if (s.isDirectory()) {
        rmSync(abs, { recursive: true });
      } else {
        unlinkSync(abs);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
