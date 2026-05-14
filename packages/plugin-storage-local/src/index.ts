import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ConfigSchema, Context, Logger } from '@aalis/core';
import type { CheckResult } from '@aalis/plugin-doctor-api';
import { useDoctorService } from '@aalis/plugin-doctor-api';
import type {
  StorageEntry,
  StorageListResult,
  StorageReadStreamResult,
  StorageRootInfo,
  StorageService,
  StorageStat,
} from '@aalis/plugin-storage-api';
import { StorageCapabilities, type StorageCapability } from '@aalis/plugin-storage-api';

export const name = '@aalis/plugin-storage-local';
export const displayName = '本地存储根（命名 + 路径解析）';
export const subsystem = 'storage';
export const provides = ['storage'];
export const inject = {
  optional: ['doctor'],
};

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
      {
        name: 'workspace',
        path: 'workspace',
        label: 'Workspace',
        kind: 'workspace',
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      },
      {
        name: 'data',
        path: 'data',
        label: 'Data',
        kind: 'data',
        browsable: false,
        readable: true,
        writable: true,
        deletable: false,
      },
      {
        name: 'tmp',
        path: 'workspace/.tmp',
        label: '临时文件',
        kind: 'tmp',
        browsable: false,
        readable: true,
        writable: true,
        deletable: true,
      },
      {
        name: 'pluginData',
        path: 'data/plugins',
        label: '插件数据',
        kind: 'pluginData',
        browsable: false,
        readable: true,
        writable: true,
        deletable: false,
      },
      {
        name: 'logs',
        path: 'data',
        label: '日志',
        kind: 'logs',
        browsable: false,
        readable: true,
        writable: false,
        deletable: false,
      },
      // 高危直通：取消注释或改 enabled 字段无意义——存在即注册。如需 host:/ 直通根，把下行加进 roots：
      // { name: 'host', path: '/', label: '宿主机根', kind: 'host', browsable: false, readable: true, writable: false, deletable: false },
    ],
    items: {
      name: {
        type: 'string',
        label: '根名 (URI scheme)',
        description: '只允许字母/数字/下划线/连字符，且需以字母开头；如 workspace、share',
      },
      path: {
        type: 'string',
        label: '本机路径',
        description: '可绝对，亦可相对项目根；不存在时自动创建。指向 / 即注册宿主机直通根（高危）。',
      },
      label: { type: 'string', label: '展示名称', default: '' },
      kind: {
        type: 'string',
        label: '类型标签',
        default: 'custom',
        description: '语义提示：workspace / data / tmp / pluginData / logs / custom / external / shared / host',
      },
      browsable: {
        type: 'boolean',
        label: 'WebUI 浏览器可见 (hint)',
        default: false,
        description: 'hint：当前实现下仅当 webui-server.fileRoot 指向本根时此开关才生效',
      },
      readable: { type: 'boolean', label: '允许读', default: true },
      writable: { type: 'boolean', label: '允许写', default: false },
      deletable: { type: 'boolean', label: '允许删除', default: false },
    },
  },
};

export const defaultConfig = {
  roots: [
    {
      name: 'workspace',
      path: 'workspace',
      label: 'Workspace',
      kind: 'workspace',
      browsable: true,
      readable: true,
      writable: true,
      deletable: true,
    },
    {
      name: 'data',
      path: 'data',
      label: 'Data',
      kind: 'data',
      browsable: false,
      readable: true,
      writable: true,
      deletable: false,
    },
    {
      name: 'tmp',
      path: 'workspace/.tmp',
      label: '临时文件',
      kind: 'tmp',
      browsable: false,
      readable: true,
      writable: true,
      deletable: true,
    },
    {
      name: 'pluginData',
      path: 'data/plugins',
      label: '插件数据',
      kind: 'pluginData',
      browsable: false,
      readable: true,
      writable: true,
      deletable: false,
    },
    {
      name: 'logs',
      path: 'data',
      label: '日志',
      kind: 'logs',
      browsable: false,
      readable: true,
      writable: false,
      deletable: false,
    },
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

/**
 * Per-root 存储服务：每个 root 一个实例 + 一个 ServiceContainer entry。
 *
 * 与 service-granularity 整体方向对齐：每个 entry 暴露的 capabilities 反映该 root 的
 * 真实权限（readable/writable/deletable），消费者用 `ctx.getAllServices('storage', [cap])`
 * 即可静态过滤；按 URI 调度交给 `createStorageGateway(ctx)` helper。
 *
 * 历史上 LocalStorageService 是单实例 + 内部 root 表，依赖 plugin-storage-router 做
 * URI→root 分发。删除 router 后改为这种自包含设计，单文件即可理解整条数据流。
 */
class ScopedStorageService implements StorageService {
  constructor(
    private readonly root: RootDefinition,
    private readonly logger: Logger,
    private readonly ctx: Context,
  ) {}

  /** 懒解析 checkpoint 服务；仅当回合活跃时调用 beforeMutate */
  private async snapshot(uri: string, op: 'write' | 'delete' | 'rename', abs: string): Promise<void> {
    const cp = this.ctx.getService<CheckpointLike>('checkpoint');
    if (!cp?.isActive()) return;
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
    return [this.publicRoot()];
  }

  async list(uri: string): Promise<StorageListResult> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    const s = await stat(abs);
    if (!s.isDirectory()) throw new Error('不是目录');
    this.logger.debug(`storage.list ${toUri(this.root.name, relPath)}`);

    const entries = await readdir(abs);
    const result: StorageEntry[] = [];
    for (const name of entries) {
      const childRel = normalizeRelPath(`${relPath}/${name}`);
      try {
        const childAbs = await this.resolveExisting(childRel);
        const childStat = await stat(childAbs);
        result.push({
          name,
          path: childRel,
          uri: toUri(this.root.name, childRel),
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
      root: this.publicRoot(),
      path: normalizeRelPath(relPath),
      entries: result,
    };
  }

  async stat(uri: string): Promise<StorageStat> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    this.logger.debug(`storage.stat ${toUri(this.root.name, relPath)}`);
    return this.statFromAbs(abs, relPath);
  }

  async readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    const s = await stat(abs);
    if (s.isDirectory()) throw new Error('不能读取目录');
    this.logger.debug(`storage.read ${toUri(this.root.name, relPath)} size=${s.size}`);
    return encoding ? readFile(abs, encoding) : readFile(abs);
  }

  async createReadStream(uri: string): Promise<StorageReadStreamResult> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    const fileStat = await this.statFromAbs(abs, relPath);
    if (fileStat.isDirectory) throw new Error('不能下载目录');
    this.logger.info(`storage.download ${toUri(this.root.name, relPath)} size=${fileStat.size}`);
    return { stream: createReadStream(abs), stat: fileStat };
  }

  async writeFile(uri: string, data: string | Buffer): Promise<void> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('writable');
    if (!relPath) throw new Error('不能覆盖根目录');
    const abs = await this.resolveForWrite(relPath);
    await this.snapshot(toUri(this.root.name, relPath), 'write', abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    this.logger.info(`storage.write ${toUri(this.root.name, relPath)} size=${Buffer.byteLength(data)}`);
  }

  async rename(uri: string, newName: string): Promise<string> {
    if (!newName || newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      throw new Error('文件名不合法');
    }
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('writable');
    if (!relPath) throw new Error('不能重命名根目录');
    const abs = await this.resolveExisting(relPath);
    const newRel = normalizeRelPath(`${dirname(relPath) === '.' ? '' : dirname(relPath)}/${newName}`);
    const target = await this.resolveForWrite(newRel);
    try {
      await lstat(target);
      throw new Error('目标名称已存在');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await this.snapshot(toUri(this.root.name, relPath), 'rename', abs);
    await rename(abs, target);
    this.logger.info(`storage.rename ${toUri(this.root.name, relPath)} -> ${toUri(this.root.name, newRel)}`);
    return toUri(this.root.name, newRel);
  }

  async delete(uri: string): Promise<void> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('deletable');
    if (!relPath) throw new Error('不能删除根目录');
    const abs = await this.resolveExisting(relPath);
    await this.snapshot(toUri(this.root.name, relPath), 'delete', abs);
    await rm(abs, { recursive: true, force: false });
    this.logger.warn(`storage.delete ${toUri(this.root.name, relPath)}`);
  }

  async resolveLocalPath(uri: string, access: 'read' | 'write' | 'delete' = 'read'): Promise<string> {
    const relPath = this.parseSelfUri(uri);
    const permission = access === 'delete' ? 'deletable' : access === 'write' ? 'writable' : 'readable';
    this.requirePermission(permission);
    const abs = access === 'write' ? await this.resolveForWrite(relPath) : await this.resolveExisting(relPath);
    this.logger.debug(`storage.resolveLocalPath ${toUri(this.root.name, relPath)} access=${access}`);
    return abs;
  }

  // ---- 内部 ----

  private parseSelfUri(uri: string): string {
    const { root, relPath } = parseUri(uri);
    if (root !== this.root.name) {
      throw new Error(`URI 根 "${root}" 不属于本 entry (${this.root.name})`);
    }
    return relPath;
  }

  private requirePermission(permission: 'readable' | 'writable' | 'deletable'): void {
    if (!this.root[permission]) {
      throw new Error(`存储根 ${this.root.name} 不允许该操作 (${permission})`);
    }
  }

  private async resolveExisting(relPath: string): Promise<string> {
    const lexical = resolve(this.root.realPath, normalizeRelPath(relPath));
    if (!isInside(this.root.realPath, lexical)) throw new Error('路径不合法');
    const resolved = await realpath(lexical);
    if (!isInside(this.root.realPath, resolved)) throw new Error('路径不合法');
    return resolved;
  }

  private async resolveForWrite(relPath: string): Promise<string> {
    const normalized = normalizeRelPath(relPath);
    const lexical = resolve(this.root.realPath, normalized);
    if (!isInside(this.root.realPath, lexical)) throw new Error('路径不合法');
    const existingParent = await this.findExistingParent(dirname(lexical));
    const parent = await realpath(existingParent);
    if (!isInside(this.root.realPath, parent)) throw new Error('路径不合法');
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

  private async statFromAbs(abs: string, relPath: string): Promise<StorageStat> {
    const s = await stat(abs);
    const path = normalizeRelPath(relPath || relative(this.root.realPath, abs));
    return {
      name: basename(abs),
      path,
      uri: toUri(this.root.name, path),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtime.toISOString(),
      birthtime: s.birthtime.toISOString(),
      ext: s.isDirectory() ? '' : extname(abs).toLowerCase(),
    };
  }

  private publicRoot(): StorageRootInfo {
    const { realPath: _realPath, ...info } = this.root;
    return info;
  }
}

async function createRoot(
  name: string,
  label: string,
  kind: string,
  rootPath: string,
  options: Omit<StorageRootInfo, 'name' | 'label' | 'kind'>,
): Promise<RootDefinition> {
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
      const root = await createRoot(name, item.label || name, item.kind || 'custom', path, {
        browsable: item.browsable === true,
        readable: item.readable !== false,
        writable: item.writable === true,
        deletable: item.deletable === true,
      });
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

  // service-granularity：每个 root 单独注册一个 entry。
  // - capabilities 反映该 root 的真实权限（不撒谎、不堆砌全集）；
  // - entryId = `${ctx.id}/${root.name}`，便于在 ServiceContainer 中按根定位、避免跨实例同名冲突；
  // - URI 路由由 createStorageGateway(ctx) helper 在调用方完成，不再有 facade。
  for (const root of roots) {
    const caps: StorageCapability[] = [];
    if (root.readable) caps.push(StorageCapabilities.List, StorageCapabilities.Read, StorageCapabilities.LocalPath);
    if (root.writable) caps.push(StorageCapabilities.Write);
    if (root.deletable) caps.push(StorageCapabilities.Delete);
    if (caps.length === 0) {
      logger.warn(`root ${root.name} 没有任何权限位，跳过注册`);
      continue;
    }
    const scoped = new ScopedStorageService(root, logger, ctx);
    ctx.provide('storage', scoped, {
      entryId: `${ctx.id}/${root.name}`,
      capabilities: caps,
      label: root.label || `本地根 ${root.name}`,
    });
  }

  // 诊断检查项：探测每个 writable root 是否真的可写。
  // 历史上 plugin-doctor 内置了硬编码的 fs.data 检查，但 data/ 仅是默认 root 之一，
  // 不应由 doctor 单独「祝福」。现统一由 storage 插件按当前 roots 配置上报，能反映
  // 用户自定义根（如 host:/、project_x）的真实状态。
  useDoctorService(ctx).registerCheck({
    id: 'storage.roots',
    category: 'filesystem',
    pluginName: name,
    async run() {
      const targets = roots.filter(r => r.writable);
      if (targets.length === 0) {
        return { id: 'storage.roots', category: 'filesystem', level: 'warn', message: '没有任何 writable 存储根' };
      }
      const results: CheckResult[] = [];
      for (const root of targets) {
        results.push(await probeRootWritable(root.name, root.realPath));
      }
      return results;
    },
  });
}

/** 探测某个根目录是否可写：在根下写一个临时文件并立即删除 */
async function probeRootWritable(rootName: string, dir: string): Promise<CheckResult> {
  const id = `storage.roots.${rootName}`;
  try {
    await mkdir(dir, { recursive: true });
    const probe = resolve(dir, `.doctor-probe-${process.pid}-${Date.now()}`);
    await writeFile(probe, 'ok');
    await stat(probe);
    await unlink(probe);
    return { id, category: 'filesystem', level: 'ok', message: `根 ${rootName} (${dir}) 可写` };
  } catch (err) {
    return {
      id,
      category: 'filesystem',
      level: 'error',
      message: `根 ${rootName} (${dir}) 不可写`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
