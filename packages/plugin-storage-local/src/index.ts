import { randomBytes } from 'node:crypto';
import { type BigIntStats, createReadStream, type FSWatcher, watch as fsWatch, statSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type CheckResult, doctor } from '@aalis/api-doctor';
import { type HostPaths, hostPaths } from '@aalis/api-host-paths';
import {
  type StorageEntry,
  type StorageListResult,
  type StorageReadStreamResult,
  type StorageRootInfo,
  type StorageService,
  type StorageStat,
  type StorageUnwatch,
  type StorageWatchEvent,
  type StorageWatchListener,
  storage,
} from '@aalis/api-storage';
import {
  config,
  definePlugin,
  type Logger,
  lifecycle,
  logger,
  optional,
  provide,
  type Services,
  services,
} from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';

const PLUGIN_NAME = '@aalis/plugin-storage-local';

/**
 * 这个插件不是沙箱。它做四件事：
 *
 * 1. 给若干本机目录起稳定的名字：插件自己的数据在按家目录布局派生的内置根里，文件工具用的根在 roots 数组里声明
 *    （缺省只有 workspace），让上层用 URI 表示文件，避免到处写宿主机绝对路径。
 * 2. 在每条 API 内对 `..` 穿越做规范化与校验，防止"workspace:/../../etc/passwd"
 *    这类逻辑越界 bug。
 * 3. 把所有读/写/删过一道 logger，作为统一审计点。
 * 4. 宿主控制文件的执行点兜底：不管经哪个根进来，密钥文件读写都拒，主配置拒写（见 {@link HostFileGuard}）。
 *
 * 它无法阻止 run_python / shell 等子进程在拿到 cwd 之后访问 OS 用户可访问的任何文件——
 * 这种隔离只能靠 OS 用户权限或容器层。请按这个边界来理解和配置。
 *
 * 关于 browsable：仅是给"文件浏览器类 UI"的 hint。当前 plugin-webui-server 的文件页
 * 实际只显示其 fileRoot 配置指向的那一个根（默认 workspace），其它根的 browsable=true
 * 不会让它们出现在文件页里——那些根仅供 agent/工具按 URI 寻址使用。
 *
 * 当 agent 需要访问默认根之外的目录时：
 *   - 推荐：在 roots 里加一条具名根（如 share / project_x），路径限定到目标目录
 *   - 一刀切：在 roots 里加 { name: host, path: '/' }，agent 即可用 host:/绝对路径 访问
 *     宿主机任何位置（高危，启动时会有 WARN 日志）
 */

/** 用户 roots 缺省时注册的根：只有文件工具的工作根。插件自己的数据都在下面的内部路由根里 */
const DEFAULT_ROOTS: RootEntryConfig[] = [
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
  // 高危直通：取消注释或改 enabled 字段无意义——存在即注册。如需 host:/ 直通根，把下行加进 roots：
  // { name: 'host', path: '/', label: '宿主机根', kind: 'host', browsable: false, readable: true, writable: false, deletable: false },
];

/** 插件读写、可删的内部根的权限位 */
const PRIVATE = { browsable: false, readable: true, writable: true, deletable: true } as const;

/**
 * 插件内置的内部路由根：按家目录布局（host-paths）派生，不受用户 roots 影响，不在文件页出现。在用户根之后注册；
 * 用户 roots 里与内部根同名的项被跳过并告警（内部根优先）。见计划书「插件数据约定」。
 * - data：插件状态（数据库、向量库、checkpoint、会话与附件……）。附件句柄里的根名 data 保留，映射到 state/，
 *   不改写历史。可删：/clear 的附件清理依赖它；删除面由各工具自身档位把关。
 * - pluginData：各插件的私有数据目录 state/plugins。
 * - tmp、cache：临时区与缓存；logs：runtime 写文件日志的目录，WebUI 与 CLI 的日志页从这里读，只读。
 * - personas、skills、workflows：self 下按用途分开的三个根，一个根里的路径拼接失误到不了另一个根。
 * - paper：白纸枢纽存放远端任务成品；public：发布服务存放审核通过的作品，作品站从这里读出来部署。
 * kind 供 checkpoint 等按类判断：data、pluginData、tmp、cache、logs、paper、public、self 都不记账
 * （self 等访问层限定写入者后再记，见 plugin-checkpoint）。
 */
function internalRoots(paths: HostPaths): RootEntryConfig[] {
  return [
    { name: 'data', path: paths.state, label: '状态', kind: 'data', ...PRIVATE },
    { name: 'pluginData', path: join(paths.state, 'plugins'), label: '插件数据', kind: 'pluginData', ...PRIVATE },
    { name: 'tmp', path: paths.tmp, label: '临时文件', kind: 'tmp', ...PRIVATE },
    { name: 'cache', path: paths.cache, label: '缓存', kind: 'cache', ...PRIVATE },
    {
      name: 'logs',
      path: paths.logs,
      label: '日志',
      kind: 'logs',
      browsable: false,
      readable: true,
      writable: false,
      deletable: false,
    },
    { name: 'personas', path: paths.self.personas, label: '人设卡', kind: 'self', ...PRIVATE },
    { name: 'skills', path: paths.self.skills, label: '技能', kind: 'self', ...PRIVATE },
    { name: 'workflows', path: paths.self.workflows, label: '编排定义', kind: 'self', ...PRIVATE },
    { name: 'paper', path: paths.stage.paper, label: '白纸', kind: 'paper', ...PRIVATE },
    { name: 'public', path: paths.stage.public, label: '公开作品', kind: 'public', ...PRIVATE },
  ];
}

const configSchema = defineConfig({
  roots: {
    type: 'array',
    label: '存储根目录',
    description:
      '文件工具与 agent 寻址用的根（缺省只有 workspace）；插件自己的数据在内置根里（data、pluginData、tmp、cache、logs、personas、skills、workflows、paper、public），这里同名的项会被跳过。' +
      '直接编辑这个数组：删除不要的、修改 path、加自定义根、加 host:/ 直通根。' +
      'browsable 是给 WebUI 等浏览器类组件的 hint（注意：当前 WebUI 文件页固定显示 fileRoot 配置指向的那一个根，' +
      '其它根仅作为工具/agent 寻址使用）。',
    default: DEFAULT_ROOTS,
    onInvalid: 'error',
    items: {
      name: {
        type: 'string',
        label: '根名 (URI scheme)',
        required: true,
        onInvalid: 'error',
        description: '只允许字母/数字/下划线/连字符，且需以字母开头；如 workspace、share',
      },
      path: {
        type: 'string',
        label: '本机路径',
        required: true,
        onInvalid: 'error',
        description: '可绝对，亦可相对家目录；不存在时自动创建。指向 / 即注册宿主机直通根（高危）。',
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
        onInvalid: 'error',
        description: 'hint：当前实现下仅当 webui-server.fileRoot 指向本根时此开关才生效',
      },
      readable: { type: 'boolean', label: '允许读', default: true, onInvalid: 'error' },
      writable: { type: 'boolean', label: '允许写', default: false, onInvalid: 'error' },
      deletable: { type: 'boolean', label: '允许删除', default: false, onInvalid: 'error' },
    },
  },
});

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
    /** rename 的目标 URI：checkpoint 据它把文件原路移回，不在目标端留重复 */
    toUri?: string,
  ): Promise<void>;
}

/**
 * 宿主控制文件的执行点兜底：密钥文件读写都拒，主配置拒写，只许 runtime 自己读写它们（见计划书「执行点兜底」）。
 * 不管目标经哪个根进来都查：
 * - 文件本身：按 (dev, ino) 比，硬链接与符号链接都挡得住；文件还不存在时按真实路径比（不分大小写，
 *   macOS 与 Windows 的卷默认不分），落在控制文件路径之下的也拒（不许把它建成目录）；
 *   ino 按 bigint 取：Windows 的 64 位文件 ID 转成 number 会丢低位，不同文件可能撞号；
 * - 整个子树：删除、移动、改名一个目录，或以写、删的方式把目录的本地路径交给别的工具时，按目录身份 (dev, ino)
 *   看它是不是控制文件的祖先目录。按身份而不按路径比：macOS 的 firmlink 与 bind mount 给同一个目录不同的路径。
 * 控制文件每次现查：主配置保存时整份换掉，inode 会变。
 */
class HostFileGuard {
  constructor(private readonly files: { secrets: string; config: string }) {}

  /**
   * `read`：读内容（只挡密钥文件）；`write`：写、删、移动（两个都挡）；`subtree`：目标是目录时连子树一起查。
   */
  async check(abs: string, mode: 'read' | 'write', subtree = false): Promise<void> {
    const guarded = mode === 'read' ? [this.files.secrets] : [this.files.secrets, this.files.config];
    const target = await identify(abs);
    for (const file of guarded) {
      const control = await identify(file);
      const sameFile =
        target.stat !== undefined &&
        control.stat !== undefined &&
        target.stat.dev === control.stat.dev &&
        target.stat.ino === control.stat.ino;
      // 含路径相同（isInside 对同一路径判内）
      const underControl = isInside(foldCase(control.real), foldCase(target.real));
      const containsControl =
        subtree && target.stat?.isDirectory() === true && (await ancestorIds(control.real)).has(idOf(target.stat));
      if (sameFile || underControl) {
        const what = file === this.files.secrets ? '密钥文件（只经宿主读写）' : '主配置（只经宿主修改）';
        throw new Error(`不能经存储${mode === 'read' ? '读取' : '修改'}宿主的${what}`);
      }
      if (containsControl) throw new Error('目录里有宿主的密钥文件或主配置，不能经存储删除、移动或交出写权限');
    }
  }
}

const foldCase = (p: string) => p.toLowerCase();
const idOf = (s: BigIntStats) => `${s.dev}:${s.ino}`;

/** 路径的真实路径与 stat；不存在时从最近的已存在祖先算真实路径、不给 stat */
async function identify(abs: string): Promise<{ real: string; stat?: BigIntStats }> {
  try {
    return { real: await realpath(abs), stat: await stat(abs, { bigint: true }) };
  } catch {
    /* 不存在或读不了：往上找 */
  }
  const missing: string[] = [];
  let dir = abs;
  for (;;) {
    missing.unshift(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) return { real: abs };
    dir = parent;
    try {
      return { real: join(await realpath(dir), ...missing) };
    } catch {
      /* 继续往上 */
    }
  }
}

/** 控制文件的各级祖先目录的身份（找得到的那些） */
async function ancestorIds(real: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let dir = dirname(real);
  for (;;) {
    try {
      ids.add(idOf(await stat(dir, { bigint: true })));
    } catch {
      /* 不存在的跳过 */
    }
    const parent = dirname(dir);
    if (parent === dir) return ids;
    dir = parent;
  }
}

/**
 * Per-root 存储服务：每个 root 一个实例 + 一个 ServiceContainer entry。
 *
 * 与 service-granularity 整体方向对齐：每个 root 的真实权限由 StorageRootInfo 的
 * readable/writable/deletable 位携带；storage-api 网关按位路由，按 URI 调度交给
 * `createStorageGateway(storage)` helper。
 *
 * 自包含设计：URI→root 分发不依赖外部 router 插件，单文件即可理解整条数据流。
 */
class ScopedStorageService implements StorageService {
  constructor(
    private readonly root: RootDefinition,
    private readonly guard: HostFileGuard,
    private readonly logger: Logger,
    private readonly services: Services,
    /** 本次激活的清理登记：watch 建的 fs 监听器归提供者所有，提供者关闭时一并关闭 */
    private readonly onDispose: (fn: () => void, label?: string) => () => void,
  ) {}

  /**
   * 读路径 debug 日志去重：同一 key 在 LOG_DEDUP_MS 内只打一次。
   *
   * 背景：checkpoint manifest / file-reader meta / skills 目录在单次回合里会被反复读 list/read/stat，
   * debug 层级若每次都打一行，单次启动加载就能产生数百行噪声。
   * 这里用 LRU + 时间窗口去重，保留首次/边界事件，过滤密集重复。
   * write/delete/download 保持原样（频次低 + 有审计价值）。
   */
  private readonly recentLogAt = new Map<string, number>();
  private static readonly LOG_DEDUP_MS = 1000;
  private static readonly LOG_DEDUP_MAX = 512;

  private debugSampled(key: string, msg: string): void {
    const now = Date.now();
    const last = this.recentLogAt.get(key);
    if (last !== undefined && now - last < ScopedStorageService.LOG_DEDUP_MS) return;
    // LRU：超出上限时清理已过期的条目
    if (this.recentLogAt.size >= ScopedStorageService.LOG_DEDUP_MAX) {
      const cutoff = now - ScopedStorageService.LOG_DEDUP_MS;
      for (const [k, v] of this.recentLogAt) {
        if (v < cutoff) this.recentLogAt.delete(k);
      }
    }
    this.recentLogAt.set(key, now);
    this.logger.debug(msg);
  }

  /** 懒解析 checkpoint 服务；仅当回合活跃时调用 beforeMutate */
  private async snapshot(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    abs: string,
    targetUri?: string,
  ): Promise<void> {
    // 按名动态查：checkpoint 的描述符在实现包里，而 checkpoint 自己要用存储——
    // 声明它会让两个实现包互指。动态查到的不算声明依赖，与这里需要的语义一致
    // （快照能力有就用、没有就直接落盘，不设激活闸）。
    const cp = this.services.get('checkpoint') as CheckpointLike | undefined;
    if (!cp?.isActive()) return;
    await cp.beforeMutate(
      uri,
      op,
      async () => {
        // 只有「目录」与「文件不存在」才返回 null —— checkpoint 据此判定为本回合新建。
        // 其余读取失败（EACCES / EMFILE / 超过单次 readFile 上限…）必须抛出去：压成 null
        // 会让一个回合开始前就存在、且没有任何备份的文件被记成 write-new，回滚时直接删掉。
        let s: Awaited<ReturnType<typeof stat>>;
        try {
          s = await stat(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw err;
        }
        if (s.isDirectory()) return null;
        return { data: await readFile(abs), size: s.size };
      },
      targetUri,
    );
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
    const dispUri = toUri(this.root.name, relPath);
    this.debugSampled(`list:${dispUri}`, `storage.list ${dispUri}`);

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
    const dispUri = toUri(this.root.name, relPath);
    this.debugSampled(`stat:${dispUri}`, `storage.stat ${dispUri}`);
    return this.statFromAbs(abs, relPath);
  }

  async readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    await this.guard.check(abs, 'read');
    const s = await stat(abs);
    if (s.isDirectory()) throw new Error('不能读取目录');
    const dispUri = toUri(this.root.name, relPath);
    this.debugSampled(`read:${dispUri}`, `storage.read ${dispUri} size=${s.size}`);
    return encoding ? readFile(abs, encoding) : readFile(abs);
  }

  /** 字节区间读取（[start, end) 半开）——大文件窗口化访问，绝不整文件载入 */
  async readFileRange(uri: string, start: number, end: number): Promise<Buffer> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    await this.guard.check(abs, 'read');
    const s = await stat(abs);
    if (s.isDirectory()) throw new Error('不能读取目录');
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(s.size, Math.floor(end));
    if (to <= from) return Buffer.alloc(0);
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      await fh.read(buf, 0, to - from, from);
      return buf;
    } finally {
      await fh.close();
    }
  }

  async createReadStream(uri: string): Promise<StorageReadStreamResult> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const abs = await this.resolveExisting(relPath);
    await this.guard.check(abs, 'read');
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
    await this.guard.check(abs, 'write');
    // 目标是目录 → 在快照之前就拒。写目录反正必失败（rename 覆盖不了非空目录），
    // 但放它走到 snapshot 会让 checkpoint 记一条幽灵 write-new（loadOriginal 对目录返回 null），
    // 回滚时按 write-new 把整棵目录删掉。
    const existing = await stat(abs).catch(() => undefined);
    if (existing?.isDirectory()) throw new Error('不能覆盖目录');
    await this.snapshot(toUri(this.root.name, relPath), 'write', abs);
    await mkdir(dirname(abs), { recursive: true });
    // 原子写：先写临时文件再 rename（同分区原子覆盖），防崩溃/并发半写损坏关键持久化（users.json/scheduler-jobs 等）。
    // 随机段避免同进程同毫秒并发写同一路径撞出同名 tmp（一方 rename 后另一方 ENOENT，或串写对方内容）。
    const tmp = `${abs}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
    // 覆盖已有文件时沿用它的权限位：tmp 按默认 mode 创建，rename 后目标继承之，
    // 可执行脚本写一次就从 755 掉到 644。chmod 打在 tmp 上而非 rename 后的目标，
    // 避开两步之间的窗口；目标不存在则保持默认，stat/chmod 失败不拖累写入本身。
    const prevMode = existing ? existing.mode & 0o777 : undefined;
    try {
      await writeFile(tmp, data);
      if (prevMode !== undefined) await chmod(tmp, prevMode).catch(() => {});
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
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
    await this.guard.check(abs, 'write', true);
    await this.guard.check(target, 'write');
    try {
      await lstat(target);
      throw new Error('目标名称已存在');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await this.snapshot(toUri(this.root.name, relPath), 'rename', abs, toUri(this.root.name, newRel));
    await rename(abs, target);
    this.logger.info(`storage.rename ${toUri(this.root.name, relPath)} -> ${toUri(this.root.name, newRel)}`);
    return toUri(this.root.name, newRel);
  }

  /**
   * 移动/重命名到完整目标路径（可跨目录，须同根）。自动建目标父目录，目标已存在拒绝。
   * parseSelfUri 对两端都校验根归属——跨根天然被拒；resolveExisting/resolveForWrite
   * 各自 isInside 约束在根内——宿主绝对路径与 `..` 逃逸都被挡（与其它写操作同防护）。
   */
  async move(fromUri: string, targetUri: string): Promise<string> {
    const fromRel = this.parseSelfUri(fromUri);
    const toRel = this.parseSelfUri(targetUri); // 跨根 → root 不匹配抛错
    this.requirePermission('writable');
    if (!fromRel) throw new Error('不能移动根目录');
    if (!toRel) throw new Error('目标不能是根目录');
    const absFrom = await this.resolveExisting(fromRel);
    const absTo = await this.resolveForWrite(toRel);
    await this.guard.check(absFrom, 'write', true);
    await this.guard.check(absTo, 'write');
    try {
      await lstat(absTo);
      throw new Error('目标已存在');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await mkdir(dirname(absTo), { recursive: true }); // 自动建目标父目录（同 writeFile 语义）
    await this.snapshot(toUri(this.root.name, fromRel), 'rename', absFrom, toUri(this.root.name, toRel));
    await rename(absFrom, absTo); // fs.rename：原子、跨目录、零拷贝
    this.logger.info(`storage.move ${toUri(this.root.name, fromRel)} -> ${toUri(this.root.name, toRel)}`);
    return toUri(this.root.name, toRel);
  }

  /**
   * 递归创建目录（自动建缺失父目录；已存在则幂等）。resolveForWrite 约束在根内
   * （宿主绝对路径 / `..` 逃逸 / symlink 都被挡），与其它写操作同防护。
   */
  async mkdir(uri: string): Promise<string> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('writable');
    if (!relPath) throw new Error('根目录已存在，无需创建');
    const abs = await this.resolveForWrite(relPath);
    await this.guard.check(abs, 'write');
    await mkdir(abs, { recursive: true }); // recursive：建全路径；已存在则 no-op（幂等）
    this.logger.info(`storage.mkdir ${toUri(this.root.name, relPath)}`);
    return toUri(this.root.name, relPath);
  }

  async delete(uri: string): Promise<void> {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('deletable');
    if (!relPath) throw new Error('不能删除根目录');
    const abs = await this.resolveExisting(relPath);
    // `sub/..` 这类解析回根本身的路径同样是删根——上面的字面空路径守卫挡不住
    // （isInside 对 rel==='' 判内、normalizeRelPath 不中和 `..`；审计发现的旁路）。
    if (abs === (await realpath(this.root.realPath))) throw new Error('不能删除根目录');
    await this.guard.check(abs, 'write', true);
    await this.snapshot(toUri(this.root.name, relPath), 'delete', abs);
    await rm(abs, { recursive: true, force: false });
    this.logger.info(`storage.delete ${toUri(this.root.name, relPath)}`);
  }

  async resolveLocalPath(uri: string, access: 'read' | 'write' | 'delete' = 'read'): Promise<string> {
    const relPath = this.parseSelfUri(uri);
    const permission = access === 'delete' ? 'deletable' : access === 'write' ? 'writable' : 'readable';
    this.requirePermission(permission);
    const abs = access === 'write' ? await this.resolveForWrite(relPath) : await this.resolveExisting(relPath);
    // 以写、删的方式交出目录时连子树一起查。以读的方式交出目录（命令的工作目录等）不查子树：拿到目录的工具
    // 本来就能按绝对路径读任何文件，挡它们靠沙箱的拒读清单，在这里拒只会让家目录的上级目录用不了
    await this.guard.check(abs, access === 'read' ? 'read' : 'write', access !== 'read');
    this.logger.debug(`storage.resolveLocalPath ${toUri(this.root.name, relPath)} access=${access}`);
    return abs;
  }

  /**
   * 监听某个 URI 下的变化。基于 fs.watch + 50ms 去抖。
   *
   * - 目录 URI：尝试 recursive 监听整个子树；若平台不支持 recursive，降级为只监听该目录顶层（warn）。
   * - 文件 URI：监听其父目录并按文件名过滤（只报该文件的事件；不直接 watch 文件本身，见实现处说明）。
   * - 事件路径会归一化为相对该 URI 的 storage URI 路径并去抖（同一相对路径 50ms 内只触发一次）。
   */
  watch(uri: string, listener: StorageWatchListener): StorageUnwatch {
    const relPath = this.parseSelfUri(uri);
    this.requirePermission('readable');
    const absBase = resolve(this.root.realPath, normalizeRelPath(relPath));
    if (!isInside(this.root.realPath, absBase)) {
      throw new Error('路径不合法');
    }

    const debounceMs = 50;
    const pending = new Map<string, NodeJS.Timeout>();
    let closed = false;

    const emit = (eventRelToRoot: string): void => {
      if (closed) return;
      const norm = normalizeRelPath(eventRelToRoot).replace(/\\/g, '/');
      const existing = pending.get(norm);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pending.delete(norm);
        if (closed) return;
        const event: StorageWatchEvent = {
          type: 'change',
          uri: toUri(this.root.name, norm),
          path: norm,
        };
        try {
          listener(event);
        } catch (err) {
          this.logger.warn(`storage.watch listener 抛错 ${event.uri}: ${err}`);
        }
      }, debounceMs);
      pending.set(norm, timer);
    };

    let watcher: FSWatcher;
    const baseRelToRoot = normalizeRelPath(relPath);
    // 文件 URI：监听父目录并按文件名过滤，不直接 watch 文件本身——后者回调给的 filename 是文件自己的
    // 名字（拼到 baseRelToRoot 后路径翻倍），且绑定 inode，原子写（临时文件 rename 覆盖）之后再无事件
    const fileName = statSync(absBase).isFile() ? basename(absBase) : null;
    const handle = (filename: string | Buffer | null): void => {
      const name = !filename ? null : typeof filename === 'string' ? filename : filename.toString('utf8');
      if (fileName !== null) {
        if (name === null || name === fileName) emit(baseRelToRoot);
        return;
      }
      if (name === null) {
        emit(baseRelToRoot);
        return;
      }
      // fs.watch 给的 filename 是相对被监听路径的相对路径
      const rel = baseRelToRoot ? `${baseRelToRoot}/${name.split(sep).join('/')}` : name.split(sep).join('/');
      emit(rel);
    };

    try {
      watcher =
        fileName !== null
          ? fsWatch(dirname(absBase), (_event, filename) => handle(filename))
          : fsWatch(absBase, { recursive: true }, (_event, filename) => handle(filename));
      this.logger.debug(
        `storage.watch ${toUri(this.root.name, baseRelToRoot)} ${fileName !== null ? '(file)' : '(recursive)'}`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        this.logger.warn(`storage.watch 当前平台不支持 recursive，仅监听顶层: ${toUri(this.root.name, baseRelToRoot)}`);
        watcher = fsWatch(absBase, (_event, filename) => handle(filename));
      } else {
        throw err;
      }
    }

    watcher.on('error', e => this.logger.warn(`storage.watch 错误 ${toUri(this.root.name, baseRelToRoot)}: ${e}`));

    // 调用方先退订时撤销登记；已关闭的提供者上登记会就地执行，此时 offDispose 尚未赋值
    let offDispose: (() => void) | undefined;
    const unwatch = (): void => {
      if (closed) return;
      closed = true;
      offDispose?.();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      try {
        watcher.close();
      } catch {
        // ignore
      }
      this.logger.debug(`storage.watch 已停止 ${toUri(this.root.name, baseRelToRoot)}`);
    };
    offDispose = this.onDispose(unwatch, `storage.watch ${toUri(this.root.name, baseRelToRoot)}`);
    return unwatch;
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
  home: string,
  name: string,
  label: string,
  kind: string,
  rootPath: string,
  options: Omit<StorageRootInfo, 'name' | 'label' | 'kind'>,
): Promise<RootDefinition> {
  // 相对路径按家目录解析：进程的 cwd 不带语义
  const abs = resolve(home, rootPath);
  // path 已是文件系统根（'/'）等存在的目录时不需要创建；其它情况 mkdir -p
  if (rootPath !== '/') {
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

/** 按一条根配置建目录、解析真实路径并打注册日志；失败时告警并返回 undefined */
async function openRoot(home: string, item: RootEntryConfig, logger: Logger): Promise<RootDefinition | undefined> {
  const { name } = item;
  try {
    const root = await createRoot(home, name, item.label || name, item.kind || 'custom', item.path, {
      browsable: item.browsable === true,
      readable: item.readable !== false,
      writable: item.writable === true,
      deletable: item.deletable === true,
    });
    // 按路径**深度**判定，不按字符串长度：`/x` 只是个普通目录却因为长度 2 被误报，
    // 而 `/etc`（长度 4）这种真该提醒的反而漏报。深度 ≤ 1 才是「根或根下一层」。
    // 这只影响日志级别与提示文案，不参与任何 grant/deny —— 能访问什么由 realPath
    // 加根的 read/write/delete 位决定，与本判断无关。
    const depth = root.realPath.split('/').filter(Boolean).length;
    const isHostScope = depth <= 1;
    const log = isHostScope ? logger.warn.bind(logger) : logger.info.bind(logger);
    log(
      `root ${name}:/ -> ${root.realPath}` +
        ` (browsable=${root.browsable} read=${root.readable} write=${root.writable} delete=${root.deletable})` +
        (isHostScope ? '  ⚠ 该根接近/等于文件系统根，agent 通过此根可访问宿主机大量文件' : ''),
    );
    return root;
  } catch {
    logger.warn(`root ${name} 注册失败，请检查 path 与目录权限`);
    return undefined;
  }
}

/**
 * 从已校验的 roots 构造用户根；空数组时注册默认的 workspace 根。与内部根同名的项跳过并告警，告警里写明配置的路径
 * 与内部根实际指向的位置：升级前把 data、tmp 等根指到别处的配置，那里的数据要搬过去。
 */
async function buildRoots(
  home: string,
  parsedRoots: RootEntryConfig[],
  internal: ReadonlyMap<string, string>,
  logger: Logger,
): Promise<RootDefinition[]> {
  let entries = parsedRoots.slice();
  if (entries.length === 0) {
    logger.warn('storage roots 配置为空，将注册默认根 workspace');
    entries = DEFAULT_ROOTS.slice();
  }

  const out: RootDefinition[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const name = item.name.trim();
    const path = item.path.trim();
    if (!name || !path) {
      logger.warn('roots 跳过无效项：name/path 为空');
      continue;
    }
    if (!ROOT_NAME_RE.test(name)) {
      logger.warn('roots 跳过非法根名（仅允许字母/数字/下划线/连字符，且需以字母开头）');
      continue;
    }
    const internalPath = internal.get(name);
    if (internalPath !== undefined) {
      logger.warn(
        `roots 跳过 ${name}（配置的 path：${path}）：与插件内部根同名，${name}:/ 指向 ${internalPath}；` +
          '配置里的这一项可以删掉，原来放在别处的数据要搬到这里',
      );
      continue;
    }
    if (seen.has(name)) {
      logger.warn(`roots 跳过重复根名 ${name}`);
      continue;
    }
    seen.add(name);
    const root = await openRoot(home, { ...item, name, path }, logger);
    if (root) out.push(root);
  }
  return out;
}

const uses = { provide, services, logger, lifecycle, config, paths: hostPaths, doctor: optional(doctor) };

export default definePlugin({
  name: PLUGIN_NAME,
  displayName: '本地存储根（命名 + 路径解析）',
  subsystem: 'storage',
  configSchema,
  provides: [storage],
  uses,
  async apply(caps) {
    const logger = caps.logger.child('storage');
    const cfg = parseConfig(configSchema, caps.config, logger);
    const paths = caps.paths.require();
    const home = paths.home;
    const guard = new HostFileGuard({ secrets: paths.secrets, config: paths.config });
    const internal = internalRoots(paths);
    const roots = await buildRoots(home, cfg.roots, new Map(internal.map(r => [r.name, r.path])), logger);
    // 插件自己的数据都在内部根里；用户根一个都没有时只是缺了文件工具的工作根，照常提供存储
    if (roots.length === 0) logger.warn('没有可用的用户根（文件工具的工作根），请检查 roots 配置');
    for (const item of internal) {
      const root = await openRoot(home, item, logger);
      if (root) roots.push(root);
    }

    // service-granularity：每个 root 单独注册一个 entry。
    // - entryId = `${实例 id}/${root.name}`，便于在 ServiceContainer 中按根定位、避免跨实例同名冲突；
    // - 权限由 root 的 readable/writable/deletable 位携带（StorageRootInfo），storage-api 网关按位路由；
    // - URI 路由由 createStorageGateway(storage) helper 在调用方完成，不再有 facade。
    for (const root of roots) {
      if (!root.readable && !root.writable && !root.deletable) {
        logger.warn(`root ${root.name} 没有任何权限位，跳过注册`);
        continue;
      }
      const scoped = new ScopedStorageService(root, guard, logger, caps.services, caps.lifecycle.onDispose);
      caps.provide(storage, scoped, {
        entryId: `${caps.lifecycle.id}/${root.name}`,
        label: root.label || `本地根 ${root.name}`,
      });
    }

    // 诊断检查项：探测每个 writable root 是否真的可写。
    // 由 storage 插件按全部根（含内置根）上报，而非 doctor 硬编码 fs.data：
    // 按根上报才能反映用户自定义根（如 host:/、project_x）的真实状态。
    caps.doctor.registerCheck({
      id: 'storage.roots',
      category: 'filesystem',
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
  },
});

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
