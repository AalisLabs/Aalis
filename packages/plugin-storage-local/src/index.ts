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
 * 1. 给若干本机目录起稳定的名字（roots 数组里声明，包括默认 workspace/data/tmp/
 *    pluginData/logs，以及用户加的任何根），让上层用 URI 表示文件，避免到处写
 *    宿主机绝对路径。
 * 2. 在每条 API 内对 `..` 穿越做规范化与校验，防止"workspace:/../../etc/passwd"
 *    这类逻辑越界 bug。
 * 3. 把所有读/写/删过一道 logger，作为统一审计点。
 *
 * 它无法阻止 run_python / shell 等子进程在拿到 cwd 之后访问 OS 用户可访问的任何文件——
 * 这种隔离只能靠 OS 用户权限或容器层。请按这个边界来理解和配置。
 *
 * 关于 browsable：仅是给"文件浏览器类 UI"的 hint。当前 plugin-webui-server 的文件页
 * 实际只显示其 fileRoot 配置指向的那一个根（默认 workspace），其它根的 browsable=true
 * 不会让它们出现在文件页里——那些根仅供 agent/工具按 URI 寻址使用。
 *
 * 当 agent 需要访问"内置 5 个根之外"的目录时：
 *   - 推荐：在 roots 里加一条具名根（如 share / project_x），路径限定到目标目录
 *   - 一刀切：在 roots 里加 { name: host, path: '/' }，agent 即可用 host:/绝对路径 访问
 *     宿主机任何位置（高危，启动时会有 WARN 日志）
 */

export const configSchema: ConfigSchema = {
  roots: {
    type: 'array',
    label: '存储根目录',
    description:
      '所有可用根都在这里声明（包括 workspace/data/tmp 等内置根）。' +
      '直接编辑这个数组：删除不要的、修改 path、加自定义根、加 host:/ 直通根。' +
      'browsable 是给 WebUI 等浏览器类组件的 hint（注意：当前 WebUI 文件页固定显示 fileRoot 配置指向的那一个根，' +
      '其它根仅作为工具/agent 寻址使用）。',
    default: [
      { name: 'workspace', path: 'workspace', label: 'Workspace', kind: 'workspace', browsable: true,  readable: true, writable: true,  deletable: true  },
      { name: 'data',      path: 'data',      label: 'Data',      kind: 'data',      browsable: false, readable: true, writable: true,  deletable: false },
      { name: 'tmp',       path: 'workspace/.tmp', label: '临时文件', kind: 'tmp',  browsable: false, readable: true, writable: true,  deletable: true  },
      { name: 'pluginData',path: 'data/plugins',   label: '插件数据', kind: 'pluginData', browsable: false, readable: true, writable: true, deletable: false },
      { name: 'logs',      path: 'data',      label: '日志',      kind: 'logs',      browsable: false, readable: true, writable: false, deletable: false },
      // 高危直通：取消注释或改 enabled 字段无意义——存在即注册。如需 host:/ 直通根，把下行加进 roots：
      // { name: 'host', path: '/', label: '宿主机根', kind: 'host', browsable: false, readable: true, writable: false, deletable: false },
    ],
    items: {
      name:      { type: 'string',  label: '根名 (URI scheme)', description: '只允许字母/数字/下划线/连字符，且需以字母开头；如 workspace、share' },
      path:      { type: 'string',  label: '本机路径',          description: '可绝对，亦可相对项目根；不存在时自动创建。指向 / 即注册宿主机直通根（高危）。' },
      label:     { type: 'string',  label: '展示名称',          default: '' },
      kind:      { type: 'string',  label: '类型标签',          default: 'custom', description: '语义提示：workspace / data / tmp / pluginData / logs / custom / external / shared / host' },
      browsable: { type: 'boolean', label: 'WebUI 浏览器可见 (hint)', default: false, description: 'hint：当前实现下仅当 webui-server.fileRoot 指向本根时此开关才生效' },
      readable:  { type: 'boolean', label: '允许读',            default: true },
      writable:  { type: 'boolean', label: '允许写',            default: false },
      deletable: { type: 'boolean', label: '允许删除',          default: false },
    },
  },
};

export const defaultConfig = {
  roots: [
    { name: 'workspace',  path: 'workspace',      label: 'Workspace', kind: 'workspace',  browsable: true,  readable: true, writable: true,  deletable: true  },
    { name: 'data',       path: 'data',           label: 'Data',      kind: 'data',       browsable: false, readable: true, writable: true,  deletable: false },
    { name: 'tmp',        path: 'workspace/.tmp', label: '临时文件',  kind: 'tmp',        browsable: false, readable: true, writable: true,  deletable: true  },
    { name: 'pluginData', path: 'data/plugins',   label: '插件数据',  kind: 'pluginData', browsable: false, readable: true, writable: true,  deletable: false },
    { name: 'logs',       path: 'data',           label: '日志',      kind: 'logs',       browsable: false, readable: true, writable: false, deletable: false },
  ] as RootEntryConfig[],
};

interface RootEntryConfig {
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

// 用最小接口表达对 checkpoint 服务的依赖，避免循环依赖。
interface CheckpointLike {
  isActive(): boolean;
  beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
  ): Promise<void>;
}

class LocalStorageService implements StorageService {
  private roots = new Map<string, RootDefinition>();

  constructor(
    roots: RootDefinition[],
    private readonly logger: Logger,
    private readonly ctx?: Context,
  ) {
    for (const root of roots) this.roots.set(root.name, root);
  }

  /** 懒解析 checkpoint 服务；仅当回合活跃时调用 beforeMutate */
  private async snapshot(uri: string, op: 'write' | 'delete' | 'rename', abs: string): Promise<void> {
    if (!this.ctx) return;
    const cp = this.ctx.getService<CheckpointLike>('checkpoint');
    if (!cp || !cp.isActive()) return;
    await cp.beforeMutate(uri, op, async () => {
      try {
        const s = await stat(abs);
        if (s.isDirectory()) return null;
        return { data: await readFile(abs), size: s.size };
      } catch {
        return null;
      }
    });
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
    await this.snapshot(toUri(rootDef.name, relPath), 'write', abs);
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
    await this.snapshot(toUri(rootDef.name, relPath), 'rename', abs);
    await rename(abs, target);
    this.logger.info(`storage.rename ${toUri(rootDef.name, relPath)} -> ${toUri(rootDef.name, newRel)}`);
    return toUri(rootDef.name, newRel);
  }

  async delete(uri: string): Promise<void> {
    const { root, relPath } = parseUri(uri);
    const rootDef = this.requireRoot(root, 'deletable');
    if (!relPath) throw new Error('不能删除根目录');
    const abs = await this.resolveExisting(rootDef, relPath);
    await this.snapshot(toUri(rootDef.name, relPath), 'delete', abs);
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
  // path 已是文件系统根（'/'）等存在的目录时不需要创建；其它情况 mkdir -p
  if (rootPath !== '/' && rootPath !== '') {
    await mkdir(abs, { recursive: true });
  }
  return {
    name,
    label,
    kind,
    realPath: await realpath(abs),
    ...options,
  };
}

const ROOT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** 从 raw config.roots 构造可用根。空/异常时回退到 defaultConfig.roots。 */
async function buildRoots(rawRoots: unknown, logger: Logger): Promise<RootDefinition[]> {
  let entries: RootEntryConfig[] = Array.isArray(rawRoots) ? (rawRoots as RootEntryConfig[]).slice() : [];
  if (entries.length === 0) {
    logger.warn('storage roots 配置为空，将注册默认 5 个内置根（workspace/data/tmp/pluginData/logs）');
    entries = (defaultConfig.roots as RootEntryConfig[]).slice();
  }

  const out: RootDefinition[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const path = String(item.path ?? '').trim();
    if (!name || !path) {
      logger.warn(`roots 跳过无效项 (name/path 为空): ${JSON.stringify(item)}`);
      continue;
    }
    if (!ROOT_NAME_RE.test(name)) {
      logger.warn(`roots 跳过非法根名 ${name}（仅允许字母/数字/下划线/连字符，且需以字母开头）`);
      continue;
    }
    if (seen.has(name)) {
      logger.warn(`roots 跳过重复根名 ${name}`);
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
          browsable: item.browsable === true,
          readable: item.readable !== false,
          writable: item.writable === true,
          deletable: item.deletable === true,
        },
      );
      const isHostScope = root.realPath === '/' || root.realPath.length <= 3;
      const log = isHostScope ? logger.warn.bind(logger) : logger.info.bind(logger);
      log(
        `root ${name}:/ -> ${root.realPath}` +
          ` (browsable=${root.browsable} read=${root.readable} write=${root.writable} delete=${root.deletable})` +
          (isHostScope ? '  ⚠ 该根接近/等于文件系统根，agent 通过此根可访问宿主机大量文件' : ''),
      );
      out.push(root);
    } catch (err) {
      logger.warn(`root 注册失败 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const logger = ctx.logger.child('storage');
  const roots = await buildRoots(config.roots, logger);
  if (roots.length === 0) throw new Error('plugin-storage-local: 没有任何可用根，请检查 roots 配置');

  const storage = new LocalStorageService(roots, logger, ctx);
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
