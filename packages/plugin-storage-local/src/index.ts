import { createReadStream } from 'node:fs';
import { mkdir, readdir, realpath, stat, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ConfigSchema, Context, StorageEntry, StorageListResult, StorageReadStreamResult, StorageRootInfo, StorageService, StorageStat } from '@aalis/core';
import { StorageCapabilities } from '@aalis/core';
import type { Logger } from '@aalis/core';

export const name = '@aalis/plugin-storage-local';
export const displayName = '本地存储根（命名 + 路径解析）';
export const provides = ['storage'];

/**
 * 这个插件不是沙箱。它做三件事：
 *
 * 1. 给项目里的若干目录起稳定的名字（workspace / data / tmp / pluginData / logs，
 *    以及用户在 customRoots 里加的根），让上层用 URI 表示文件，避免到处写绝对路径。
 * 2. 在每条 API 内对 `..` 穿越做规范化与校验，防止"workspace:/../../etc/passwd"
 *    这类逻辑越界 bug。
 * 3. 把所有读/写/删过一道 logger，作为统一审计点。
 *
 * 它无法阻止 run_python / shell 等子进程在拿到 cwd 之后访问 OS 用户可访问的任何文件——
 * 这种隔离只能靠 OS 用户权限或容器层。请按这个边界来理解和配置。
 *
 * 当 agent 需要访问"内置根之外"的目录（如外接磁盘、用户文档夹）时，
 * 推荐通过 customRoots 显式起一个名字，而不是去掉这层。
 */

export const configSchema: ConfigSchema = {
  workspaceRoot: { type: 'string', label: 'Workspace 目录', default: 'workspace', description: '用户可见文件产物的根目录' },
  dataRoot: { type: 'string', label: 'Data 目录', default: 'data', description: 'Aalis 内部状态数据目录' },
  tmpRoot: { type: 'string', label: '临时目录', default: 'workspace/.tmp', description: '临时文件目录' },
  pluginDataRoot: { type: 'string', label: '插件数据目录', default: 'data/plugins', description: '插件持久化私有数据目录' },
  logsRoot: { type: 'string', label: '日志目录', default: 'data', description: '日志文件所在目录' },
  exposeDataToBrowser: { type: 'boolean', label: '允许浏览 Data', default: false, description: '是否允许通用文件浏览器显示 data 根目录' },
  exposeTmpToBrowser: { type: 'boolean', label: '允许浏览临时文件', default: false, description: '是否允许通用文件浏览器显示 tmp 根目录' },
  hostRoot: {
    label: '直通宿主机根 (host:/)',
    description:
      '⚠ 高危：开启后注册名为 host 的根指向文件系统根，allowing agent/工具用 host:/绝对路径 直接访问宿主机任意文件。' +
      '仅在你完全信任当前 agent + 配置时启用；建议优先使用 customRoots 起一个最小范围的命名根。',
    fields: {
      enabled: { type: 'boolean', label: '启用 host:/ 根', default: false },
      readable: { type: 'boolean', label: '允许读', default: true },
      writable: { type: 'boolean', label: '允许写', default: false },
      deletable: { type: 'boolean', label: '允许删除', default: false },
      browsable: { type: 'boolean', label: '允许在文件浏览器显示', default: false, description: '默认关闭，避免 WebUI 暴露整个文件系统' },
    },
  },
  customRoots: {
    type: 'array',
    label: '自定义命名根',
    description:
      '为内置 5 个根之外的任意目录起一个名字，便于 agent 通过 URI 访问外部文件。' +
      '注意：自定义根不会被沙箱保护——所有内置根的免责声明同样适用。',
    default: [],
    items: {
      name: { type: 'string', label: '根名 (URI scheme)', description: '只允许英数与下划线，例如 share' },
      path: { type: 'string', label: '本机路径', description: '可绝对，亦可相对项目根；不存在会自动创建' },
      label: { type: 'string', label: '展示名称', default: '' },
      kind: { type: 'string', label: '类型标签', default: 'custom', description: '语义提示，常用值：custom / external / shared' },
      browsable: { type: 'boolean', label: '允许在文件浏览器显示', default: true },
      readable: { type: 'boolean', label: '允许读', default: true },
      writable: { type: 'boolean', label: '允许写', default: false },
      deletable: { type: 'boolean', label: '允许删除', default: false },
    },
  },
};

export const defaultConfig = {
  workspaceRoot: 'workspace',
  dataRoot: 'data',
  tmpRoot: 'workspace/.tmp',
  pluginDataRoot: 'data/plugins',
  logsRoot: 'data',
  exposeDataToBrowser: false,
  exposeTmpToBrowser: false,
  hostRoot: {
    enabled: false,
    readable: true,
    writable: false,
    deletable: false,
    browsable: false,
  },
  customRoots: [] as CustomRootConfig[],
};

interface HostRootConfig {
  enabled?: boolean;
  readable?: boolean;
  writable?: boolean;
  deletable?: boolean;
  browsable?: boolean;
}

interface CustomRootConfig {
  name: string;
  path: string;
  label?: string;
  kind?: string;
  browsable?: boolean;
  readable?: boolean;
  writable?: boolean;
  deletable?: boolean;
}

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
    try {
      const target = await lstat(lexical);
      if (target.isSymbolicLink()) throw new Error('不允许写入符号链接');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
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

const RESERVED_ROOT_NAMES = new Set(['workspace', 'data', 'tmp', 'pluginData', 'logs']);
const ROOT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

async function buildCustomRoots(
  raw: unknown,
  logger: Logger,
): Promise<RootDefinition[]> {
  if (!Array.isArray(raw)) return [];
  const out: RootDefinition[] = [];
  const seen = new Set<string>();
  for (const item of raw as CustomRootConfig[]) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const path = String(item.path || '').trim();
    if (!name || !path) {
      logger.warn(`customRoots 跳过无效项 (name/path 为空): ${JSON.stringify(item)}`);
      continue;
    }
    if (!ROOT_NAME_RE.test(name)) {
      logger.warn(`customRoots 跳过非法根名 ${name}（仅允许字母/数字/下划线/连字符，且需以字母开头）`);
      continue;
    }
    if (RESERVED_ROOT_NAMES.has(name)) {
      logger.warn(`customRoots 跳过保留根名 ${name}`);
      continue;
    }
    if (seen.has(name)) {
      logger.warn(`customRoots 跳过重复根名 ${name}`);
      continue;
    }
    seen.add(name);
    try {
      const root = await createRoot(
        name,
        item.label || name,
        item.kind || 'custom',
        path,
        {
          browsable: item.browsable !== false,
          readable: item.readable !== false,
          writable: item.writable === true,
          deletable: item.deletable === true,
        },
      );
      logger.info(
        `已注册自定义根 ${name}:/ -> ${root.realPath}` +
          ` (browsable=${root.browsable} read=${root.readable} write=${root.writable} delete=${root.deletable})`,
      );
      out.push(root);
    } catch (err) {
      logger.warn(`customRoots 注册失败 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const logger = ctx.logger.child('storage');
  const builtin = await Promise.all([
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

  const custom = await buildCustomRoots(config.customRoots, logger);
  const roots = [...builtin, ...custom];

  const hostCfg = (config.hostRoot ?? {}) as HostRootConfig;
  if (hostCfg.enabled) {
    try {
      const hostRoot = await createRoot('host', '宿主机根 (host:/)', 'host', '/', {
        browsable: hostCfg.browsable === true,
        readable: hostCfg.readable !== false,
        writable: hostCfg.writable === true,
        deletable: hostCfg.deletable === true,
      });
      logger.warn(
        `已启用 host:/ 直通根 (read=${hostRoot.readable} write=${hostRoot.writable} delete=${hostRoot.deletable} browsable=${hostRoot.browsable})。` +
          ` agent/工具现在可用 host:/<绝对路径> 访问宿主机任意文件。`,
      );
      roots.push(hostRoot);
    } catch (err) {
      logger.warn(`host 根注册失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const storage = new LocalStorageService(roots, logger);
  ctx.provide('storage', storage, {
    capabilities: [
      StorageCapabilities.List,
      StorageCapabilities.Read,
      StorageCapabilities.Write,
      StorageCapabilities.Delete,
      StorageCapabilities.LocalPath,
    ],
    label: '本地存储根',
  });
}
