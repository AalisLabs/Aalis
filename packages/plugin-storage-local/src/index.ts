import { createReadStream } from 'node:fs';
import { mkdir, readdir, realpath, stat, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ConfigSchema, Context, StorageEntry, StorageListResult, StorageReadStreamResult, StorageRootInfo, StorageService, StorageStat } from '@aalis/core';
import { StorageCapabilities } from '@aalis/core';
import type { Logger } from '@aalis/core';

export const name = '@aalis/plugin-storage-local';
export const displayName = '本地安全存储';
export const provides = ['storage'];

export const configSchema: ConfigSchema = {
  workspaceRoot: { type: 'string', label: 'Workspace 目录', default: 'workspace', description: '用户可见文件产物的根目录' },
  dataRoot: { type: 'string', label: 'Data 目录', default: 'data', description: 'Aalis 内部状态数据目录' },
  tmpRoot: { type: 'string', label: '临时目录', default: 'workspace/.tmp', description: '临时文件目录' },
  pluginDataRoot: { type: 'string', label: '插件数据目录', default: 'data/plugins', description: '插件持久化私有数据目录' },
  logsRoot: { type: 'string', label: '日志目录', default: 'data', description: '日志文件所在目录' },
  exposeDataToBrowser: { type: 'boolean', label: '允许浏览 Data', default: false, description: '是否允许通用文件浏览器显示 data 根目录' },
  exposeTmpToBrowser: { type: 'boolean', label: '允许浏览临时文件', default: false, description: '是否允许通用文件浏览器显示 tmp 根目录' },
};

export const defaultConfig = {
  workspaceRoot: 'workspace',
  dataRoot: 'data',
  tmpRoot: 'workspace/.tmp',
  pluginDataRoot: 'data/plugins',
  logsRoot: 'data',
  exposeDataToBrowser: false,
  exposeTmpToBrowser: false,
};

interface RootDefinition extends StorageRootInfo {
  realPath: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/^\/+/, '');
}

function toUri(root: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath).replace(/\\/g, '/');
  return `${root}:/${normalized}`;
}

function parseUri(uri: string): { root: string; relPath: string } {
  const idx = uri.indexOf(':/');
  if (idx <= 0) throw new Error(`存储 URI 不合法: ${uri}`);
  const root = uri.slice(0, idx);
  const relPath = normalizeRelPath(uri.slice(idx + 2));
  return { root, relPath };
}

class LocalStorageService implements StorageService {
  private roots = new Map<string, RootDefinition>();

  constructor(roots: RootDefinition[], private readonly logger: Logger) {
    for (const root of roots) this.roots.set(root.name, root);
  }

  listRoots(): StorageRootInfo[] {
    return [...this.roots.values()].map(({ realPath: _realPath, ...root }) => root);
  }

  async list(uri: string): Promise<StorageListResult> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'readable');
    const abs = await this.resolveExisting(rootDef, relPath);
    const s = await stat(abs);
    if (!s.isDirectory()) throw new Error('不是目录');
    this.logger.debug(`storage.list ${toUri(rootDef.name, relPath)}`);

    const entries = await readdir(abs);
    const result: StorageEntry[] = [];
    for (const name of entries) {
      const childRel = normalizeRelPath(`${relPath}/${name}`);
      try {
        const childAbs = await this.resolveExisting(rootDef, childRel);
        const childStat = await stat(childAbs);
        result.push({
          name,
          path: childRel,
          uri: toUri(rootDef.name, childRel),
          isDirectory: childStat.isDirectory(),
          size: childStat.isDirectory() ? 0 : childStat.size,
          mtime: childStat.mtime.toISOString(),
          ext: childStat.isDirectory() ? '' : extname(name).toLowerCase(),
        });
      } catch {
        // 跳过指向根目录外或无法读取的符号链接/条目。
      }
    }

    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      root: this.publicRoot(rootDef),
      path: normalizeRelPath(relPath),
      entries: result,
    };
  }

  async stat(uri: string): Promise<StorageStat> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'readable');
    const abs = await this.resolveExisting(rootDef, relPath);
    this.logger.debug(`storage.stat ${toUri(rootDef.name, relPath)}`);
    return this.statFromAbs(rootDef, abs, relPath);
  }

  async readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'readable');
    const abs = await this.resolveExisting(rootDef, relPath);
    const s = await stat(abs);
    if (s.isDirectory()) throw new Error('不能读取目录');
    this.logger.debug(`storage.read ${toUri(rootDef.name, relPath)} size=${s.size}`);
    return encoding ? readFile(abs, encoding) : readFile(abs);
  }

  async createReadStream(uri: string): Promise<StorageReadStreamResult> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'readable');
    const abs = await this.resolveExisting(rootDef, relPath);
    const fileStat = await this.statFromAbs(rootDef, abs, relPath);
    if (fileStat.isDirectory) throw new Error('不能下载目录');
    this.logger.info(`storage.download ${toUri(rootDef.name, relPath)} size=${fileStat.size}`);
    return { stream: createReadStream(abs), stat: fileStat };
  }

  async writeFile(uri: string, data: string | Buffer): Promise<void> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'writable');
    if (!relPath) throw new Error('不能覆盖根目录');
    const abs = await this.resolveForWrite(rootDef, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    this.logger.info(`storage.write ${toUri(rootDef.name, relPath)} size=${Buffer.byteLength(data)}`);
  }

  async rename(uri: string, newName: string): Promise<string> {
    if (!newName || newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      throw new Error('文件名不合法');
    }
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'writable');
    if (!relPath) throw new Error('不能重命名根目录');
    const abs = await this.resolveExisting(rootDef, relPath);
    const newRel = normalizeRelPath(`${dirname(relPath) === '.' ? '' : dirname(relPath)}/${newName}`);
    const target = await this.resolveForWrite(rootDef, newRel);
    try {
      await lstat(target);
      throw new Error('目标名称已存在');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await rename(abs, target);
    this.logger.info(`storage.rename ${toUri(rootDef.name, relPath)} -> ${toUri(rootDef.name, newRel)}`);
    return toUri(rootDef.name, newRel);
  }

  async delete(uri: string): Promise<void> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'deletable');
    if (!relPath) throw new Error('不能删除根目录');
    const abs = await this.resolveExisting(rootDef, relPath);
    await rm(abs, { recursive: true, force: false });
    this.logger.warn(`storage.delete ${toUri(rootDef.name, relPath)}`);
  }

  async resolveLocalPath(uri: string, access: 'read' | 'write' | 'delete' = 'read'): Promise<string> {
    const { root, relPath } = parseUri(uri);
    const permission = access === 'delete' ? 'deletable' : access === 'write' ? 'writable' : 'readable';
    const rootDef = this.requireRoot(root, permission);
    const abs = access === 'write'
      ? await this.resolveForWrite(rootDef, relPath)
      : await this.resolveExisting(rootDef, relPath);
    this.logger.debug(`storage.resolveLocalPath ${toUri(rootDef.name, relPath)} access=${access}`);
    return abs;
  }

  private requireRoot(root: string, permission: 'readable' | 'writable' | 'deletable'): RootDefinition {
    const rootDef = this.roots.get(root);
    if (!rootDef) throw new Error(`未知存储根: ${root}`);
    if (!rootDef[permission]) throw new Error(`存储根 ${root} 不允许该操作`);
    return rootDef;
  }

  private async resolveExisting(root: RootDefinition, relPath: string): Promise<string> {
    const lexical = resolve(root.realPath, normalizeRelPath(relPath));
    if (!isInside(root.realPath, lexical)) throw new Error('路径不合法');
    const resolved = await realpath(lexical);
    if (!isInside(root.realPath, resolved)) throw new Error('路径不合法');
    return resolved;
  }

  private async resolveForWrite(root: RootDefinition, relPath: string): Promise<string> {
    const normalized = normalizeRelPath(relPath);
    const lexical = resolve(root.realPath, normalized);
    if (!isInside(root.realPath, lexical)) throw new Error('路径不合法');
    const existingParent = await this.findExistingParent(dirname(lexical));
    const parent = await realpath(existingParent);
    if (!isInside(root.realPath, parent)) throw new Error('路径不合法');
    return lexical;
  }

  private async findExistingParent(absPath: string): Promise<string> {
    let current = absPath;
    while (true) {
      try {
        const s = await lstat(current);
        if (!s.isDirectory()) throw new Error('父路径不是目录');
        return current;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = dirname(current);
        if (parent === current) throw err;
        current = parent;
      }
    }
  }

  private async statFromAbs(root: RootDefinition, abs: string, relPath: string): Promise<StorageStat> {
    const s = await stat(abs);
    const path = normalizeRelPath(relPath || relative(root.realPath, abs));
    return {
      name: basename(abs),
      path,
      uri: toUri(root.name, path),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtime.toISOString(),
      birthtime: s.birthtime.toISOString(),
      ext: s.isDirectory() ? '' : extname(abs).toLowerCase(),
    };
  }

  private publicRoot(root: RootDefinition): StorageRootInfo {
    const { realPath: _realPath, ...publicRoot } = root;
    return publicRoot;
  }
}

async function createRoot(name: string, label: string, kind: string, rootPath: string, options: Omit<StorageRootInfo, 'name' | 'label' | 'kind'>): Promise<RootDefinition> {
  const abs = resolve(process.cwd(), rootPath);
  await mkdir(abs, { recursive: true });
  return {
    name,
    label,
    kind,
    realPath: await realpath(abs),
    ...options,
  };
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const roots = await Promise.all([
    createRoot('workspace', 'Workspace', 'workspace', String(config.workspaceRoot ?? 'workspace'), {
      browsable: true,
      readable: true,
      writable: true,
      deletable: true,
    }),
    createRoot('data', 'Data', 'data', String(config.dataRoot ?? 'data'), {
      browsable: Boolean(config.exposeDataToBrowser),
      readable: true,
      writable: true,
      deletable: false,
    }),
    createRoot('tmp', '临时文件', 'tmp', String(config.tmpRoot ?? 'workspace/.tmp'), {
      browsable: Boolean(config.exposeTmpToBrowser),
      readable: true,
      writable: true,
      deletable: true,
    }),
    createRoot('pluginData', '插件数据', 'pluginData', String(config.pluginDataRoot ?? 'data/plugins'), {
      browsable: false,
      readable: true,
      writable: true,
      deletable: false,
    }),
    createRoot('logs', '日志', 'logs', String(config.logsRoot ?? 'data'), {
      browsable: false,
      readable: true,
      writable: false,
      deletable: false,
    }),
  ]);

  const storage = new LocalStorageService(roots, ctx.logger.child('storage'));
  ctx.provide('storage', storage, {
    capabilities: [
      StorageCapabilities.List,
      StorageCapabilities.Read,
      StorageCapabilities.Write,
      StorageCapabilities.Delete,
    ],
    label: 'Local Safe Storage',
  });
}
