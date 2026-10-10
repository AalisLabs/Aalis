// ----- 存储服务接口 -----

import type { Readable } from 'node:stream';

export type StorageRootKind = 'workspace' | 'data' | 'tmp' | 'pluginData' | 'logs' | string;

export interface StorageRootInfo {
  /** 根 ID，如 workspace、data、tmp */
  name: string;
  /** 展示名称 */
  label?: string;
  /** 语义类型，用于权限 UI 和策略判断 */
  kind: StorageRootKind;
  /** 是否允许通过通用文件浏览 UI 展示 */
  browsable: boolean;
  /** 默认是否允许读 */
  readable: boolean;
  /** 默认是否允许写 */
  writable: boolean;
  /** 默认是否允许删除 */
  deletable: boolean;
}

export interface StorageEntry {
  name: string;
  path: string;
  uri: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ext: string;
}

export interface StorageStat {
  name: string;
  path: string;
  uri: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  birthtime: string;
  ext: string;
}

export interface StorageListResult {
  root: StorageRootInfo;
  path: string;
  entries: StorageEntry[];
}

export interface StorageReadStreamResult {
  stream: Readable;
  stat: StorageStat;
}

/**
 * 文件变化事件。当前实现统一上报 `change`（含创建/修改/删除）；
 * `type` 字段保留扩展空间以便后续细分。
 */
export interface StorageWatchEvent {
  type: 'change';
  /** 完整 storage URI，如 `skills:/foo/SKILL.md` */
  uri: string;
  /** 根内相对路径 */
  path: string;
}

export type StorageWatchListener = (event: StorageWatchEvent) => void;

/** 写文件的选项 */
export interface StorageWriteOptions {
  /**
   * 内容是凭据（访问 token 一类）：只给运行 Aalis 的系统用户读写。本地提供者以 0600 建文件，覆写已有文件时一并收紧，
   * 内容从不以更宽的权限落盘；做不到的提供者应拒写，不得照常写成别人读得到的文件
   */
  secret?: boolean;
}

/** 取消监听 */
export type StorageUnwatch = () => void;

/**
 * StorageService 的职责定位：
 *
 * 1) **命名根**：把项目里的几个目录起一个稳定名字（workspace / data / tmp /
 *    pluginData / logs，以及用户自定义根），让上层用 URI（`name:/path`）表示文件，
 *    而不是把绝对路径硬编码到配置或工具调用里。
 * 2) **路径解析**：对 storage URI 做规范化、根内 `..` 穿越保护、symlink realpath 校验。
 *    这是为防止上层代码意外越界（防 bug），不是用来对抗恶意子进程。
 * 3) **审计点**：所有读/写/删都经过 logger，便于事后排查。
 *
 * 它**不是**沙箱：`resolveLocalPath` 一旦把绝对路径交给 `run_python`、shell 等子进程，
 * 子进程可以访问当前 OS 用户能访问的任何文件。真正的隔离应该靠 OS 用户权限或容器，
 * 不应该指望这一层。
 */
export interface StorageService {
  listRoots(): StorageRootInfo[];
  list(uri: string): Promise<StorageListResult>;
  stat(uri: string): Promise<StorageStat>;
  /**
   * 读取整个文件。目标不存在时，提供者抛出带 `code: 'ENOENT'` 的错误（list / stat / delete 等
   * 按路径定位的方法同理）；其它失败（权限、根不可读等）不得用这个 code。消费方用
   * {@link isStorageNotFound} 区分「不存在」与「读不出」。
   */
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  /**
   * 可选：按字节区间读取文件（[start, end) 半开区间）。为大文件的窗口化访问
   * （日志尾读等）而设，避免整文件载入内存。提供者未实现时业务层的 readFileRange 抛错——
   * 调用方应 try/catch 回退到 readFile（readTailLines 已内置该回退）。
   */
  readFileRange?(uri: string, start: number, end: number): Promise<Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer, options?: StorageWriteOptions): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  /**
   * 移动/重命名到任意目标 URI（可跨目录，须同存储根）。自动创建目标父目录，
   * 目标已存在则拒绝（不覆盖）。底层 fs.rename——原子、零拷贝，大文件也瞬间完成。
   * 与 `rename`（仅同目录改名、拒绝路径分隔符）的区别：`move` 接受完整目标路径。
   * 不支持移动的根实现为抛错。
   */
  move(fromUri: string, toUri: string): Promise<string>;
  /**
   * 创建目录（递归，自动建所有缺失的父目录；已存在则幂等无操作）。约束在存储根内
   * （拒宿主绝对路径 / `..` 逃逸）。返回创建的目录 URI。
   * 不支持创建目录的根实现为抛错。
   */
  mkdir(uri: string): Promise<string>;
  delete(uri: string): Promise<void>;
  /**
   * 把 storage URI 解析为本机绝对路径，给必须使用本地路径的子进程（shell、code-runner）用。
   *
   * 注意：解析过程会校验目标位于声明的根内，但**不会限制后续子进程的访问范围**。
   * 调用方必须自觉只把这条路径用作"工作目录/起点"，不要把它当成沙箱边界。
   */
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
  /**
   * 监听某个 URI（文件或目录）下的变化。返回取消监听的函数。
   *
   * - 目录 URI（如 `skills:/`）：递归监听其下所有文件/子目录。
   * - 文件 URI（如 `data:/persona.yaml`）：仅监听该文件本身。
   * - 后端可能对事件做去抖处理；调用方不应假定一次写操作必定对应一次事件。
   * - 远程/纯虚拟根可能不支持，此时方法本身可能不存在或调用抛错。
   */
  watch?(uri: string, listener: StorageWatchListener): StorageUnwatch;
}

import { defineService, parseInstanceId } from '@aalis/core';
import { configError } from '@aalis/schema-config';

/** 存储 URI 的 scheme 文法：`<root>:/<path>`，root 以字母开头 + 字母/数字/下划线/连字符。 */
const STORAGE_URI_RE = /^[a-zA-Z][a-zA-Z0-9_-]*:\//;
/** 非 storage 的保留 scheme：这些 `:/` 形态另有专门读取路径（safeFetch / readExternalFile），不算 storage URI。 */
const RESERVED_URI_SCHEMES = new Set(['http', 'https', 'file']);

/**
 * 判定字符串是否为 storage URI（`<root>:/path`）—— 权威文法，全体消费者（onebot/media/asr）复用，
 * 勿各自重抄。与之区分：http/https/file URL（保留 scheme）、标准 data-URI `data:<mime>;base64,...`。
 *
 * `data:` 的歧义由文法天然区分——storage 根 `data` 写作 `data:/...`（冒号后紧跟 `/`，正则匹配）；
 * 标准 data-URI 是 `data:image/...;base64,...`（冒号后跟 MIME，正则不匹配）。
 */
export function isStorageUri(s: string): boolean {
  if (!STORAGE_URI_RE.test(s)) return false;
  const scheme = s.slice(0, s.indexOf(':')).toLowerCase();
  return !RESERVED_URI_SCHEMES.has(scheme);
}

/**
 * 判定 storage 操作抛出的错误是否表示「目标不存在」—— 契约级判据，全体消费者复用，勿各自重抄。
 *
 * 先看 `code`：有 code 时只认 `'ENOENT'`，文案里带 not found 的其它错误（EACCES 等）不算；
 * 没有 code 时才退回文案正则，兼顾不透传 errno 的提供者。提供者的「未知存储根」不含这些字样，
 * 判为读失败而非不存在。
 */
export function isStorageNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code !== undefined) return code === 'ENOENT';
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return /ENOENT|not found|不存在/i.test(typeof message === 'string' ? message : String(err));
}

/** 从 storage URI 取根名（`data:/images/x.jpg` → `data`）。非 `<根名>:/...` 形态抛错。 */
export function parseUriRoot(uri: string): string {
  const idx = uri.indexOf(':/');
  if (idx <= 0) throw new Error(`存储 URI 不合法: ${uri}（应为 <根名>:/<相对路径>）`);
  return uri.slice(0, idx);
}

/**
 * 能不能给这个存储地址签发界面下载用的句柄：是存储地址、根认识，且不是插件私有数据的根。data 根映射到家目录的 state/
 * （里面有 WebUI 的 token 与审计），pluginData 是各插件的私有目录，这两类根里的文件不签发。按根的种类判、不按路径：
 * owner 自己加的指到家目录的根里，state/ 下的文件照常签发。会话条目与页面单元格的文件句柄共用这一条
 */
export function canIssueFileHandle(roots: readonly StorageRootInfo[], uri: string): boolean {
  if (!isStorageUri(uri)) return false;
  const root = roots.find(r => r.name === parseUriRoot(uri));
  return root !== undefined && root.kind !== 'data' && root.kind !== 'pluginData';
}

/**
 * 宿主机绝对路径（`/abs`、`C:\path`、`C:/path`）：不是存储地址，配置路径与工具路径都不接受。
 * Windows 盘符文法与单字母根名冲突，一律按盘符认（根名文法见 docs/concepts/storage-uri-grammar.md）
 */
export function isHostAbsolutePath(input: string): boolean {
  return /^(?:\/|[a-zA-Z]:[\\/])/.test(input);
}

/**
 * 把配置里的路径/裸名归一为 storage URI —— 契约级文法，全体后端消费者（memory/vectorstore/
 * checkpoint/scheduler/persona…）复用，勿各自重抄。
 * - 本机路径（宿主机绝对路径与家目录简写 `~/…`）→ 抛配置错误（不带堆栈），写明要填 storage URI 并举例：
 *   首段当根名只会撞上「未知存储根」，而首段恰好与某个根同名时（如 `/data/x`）会悄悄落到那个根里。
 *   家目录简写不进 {@link isHostAbsolutePath}：那是工具路径也用的判据，工具侧的 `~` 按普通目录名相对 cwd 求值
 * - 已是 storage URI（含 `:/`）→ 原样返回。
 * - `foo/bar`（含 `/`，可带前导 `./`）→ `foo:/bar`（首段当根名）。
 * - `name`（单段裸名）→ `<fallbackRoot>:/name`（默认归 data 根相对路径，而非把裸名当根名——
 *   后者会让提供者抛「未知存储根」）。
 * 空输入留给调用方各自处理（各包默认文件名不同）。
 */
export function toStorageUri(input: string, fallbackRoot = 'data'): string {
  const s = input.trim();
  if (isHostAbsolutePath(s) || /^~[\\/]/.test(s)) {
    const example = `${fallbackRoot}:/${s.split(/[\\/]/).filter(Boolean).at(-1) ?? ''}`;
    throw configError(
      `这里要写 storage URI（<根名>:/<路径>，如 ${example}），不能写本机路径 "${s}"；` +
        '要用存储根以外的目录，先在「本地存储根」的 roots 里加一个指向它的根，并打开它的「允许写」；这个根文件工具也能访问',
    );
  }
  if (s.includes(':/')) return s;
  const cleaned = s.replace(/^\.\/+/, '');
  const idx = cleaned.indexOf('/');
  return idx > 0 ? `${cleaned.slice(0, idx)}:/${cleaned.slice(idx + 1)}` : `${fallbackRoot}:/${cleaned}`;
}

export interface ParsedStorageUri {
  root: string;
  /** 不含前导 `/`；空数组表示根目录 `<root>:/` */
  segments: string[];
}

/** 归一化路径段：消除空段、`.`、`..`（`..` 在根处 clamp，永不越过 root）。 */
function normalizeSegments(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const seg of input) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** 拆分完整 storage URI 为根名 + 路径段。仅接受 `<根名>:/<相对路径>`。 */
export function parseStorageUri(uri: string): ParsedStorageUri {
  const idx = uri.indexOf(':/');
  if (idx <= 0) {
    throw new Error(`存储 URI 不合法: "${uri}"（应为 <根名>:/<相对路径>，例如 workspace:/notes/a.md）`);
  }
  const root = uri.slice(0, idx);
  const rest = uri.slice(idx + 2).replace(/^\/+/, '');
  const segments = rest ? rest.split('/').filter(Boolean) : [];
  return { root, segments: normalizeSegments(segments) };
}

/** 把根名 + 段拼回 URI；空段返回 `<root>:/`。 */
function joinStorageUri(root: string, segments: readonly string[]): string {
  return `${root}:/${segments.length ? segments.join('/') : ''}`;
}

/** 反斜杠/正斜杠混排统一成正斜杠。 */
function unifySlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

/**
 * 把**工具用户输入的路径**求值为完整 storage URI —— 工具侧路径解析的唯一入口，
 * 与 `toStorageUri`（配置路径归一）语义不同。规则（按顺序）：
 * 1. 空 / `.` → 当前 `cwd` 自身
 * 2. 宿主机绝对路径（{@link isHostAbsolutePath}）→ 抛错（安全：禁止越出存储体系访问宿主文件系统）。
 *    单字母根名在这里不可达
 * 3. 含 `:/` → 视为完整 storage URI，归一化（消 `.`/`..`）后返回（任意根；根级访问控制在别处做）
 * 4. 其它 → 相对 `cwd` 求值（与 unix shell 一致：`foo` 落在 cwd 之下）
 *
 * `cwd` 必须是合法 storage URI（如 `workspace:/`、`data:/work`）；调用方传各自的工作目录。
 */
export function resolveAgainstCwd(input: string | undefined, cwd: string): string {
  const raw = (input ?? '').trim();
  const cwdParsed = parseStorageUri(cwd);
  if (!raw || raw === '.') return joinStorageUri(cwdParsed.root, cwdParsed.segments);
  if (isHostAbsolutePath(raw)) {
    throw new Error(
      `不接受宿主机绝对路径 "${raw}"。请改用 storage URI（如 aalis:/packages/core）` +
        `或相对当前 cwd 的路径。调用 cwd 工具可查看当前目录与所有可用 storage 根。`,
    );
  }
  if (/^[a-zA-Z][a-zA-Z0-9_-]*:\//.test(raw)) {
    const parsed = parseStorageUri(unifySlashes(raw));
    return joinStorageUri(parsed.root, parsed.segments);
  }
  const relSegments = unifySlashes(raw).split('/').filter(Boolean);
  return joinStorageUri(cwdParsed.root, normalizeSegments([...cwdParsed.segments, ...relSegments]));
}

// ----- 大文件尾读工具 -----

export interface ReadTailOptions {
  /** 每次向前读取的字节块大小，默认 64KiB */
  chunkSize?: number;
  /** 向前扫描的总字节上限（防超长行/深分页失控），默认 4MiB；触顶时返回已收集的完整行 */
  maxBytes?: number;
  /** 行过滤器：仅通过者被计数与返回（如日志分页的 seq < before 判定） */
  filter?: (line: string) => boolean;
}

/**
 * 从文件末尾向前分块读取，返回最后 maxLines 个非空行（保持文件内顺序）。
 *
 * 为"日志尾读/向上分页"这类场景而设：文件可能几百 MB，但调用方只要末尾几百行——
 * 决不能整文件载入。优先走 readFileRange 窗口化读取；提供者不支持时回退整文件
 * readFile（保守但正确）。
 *
 * 字节级精确：UTF-8 的多字节序列中不会出现 0x0A，因此行切分在 Buffer 层进行，
 * 只对"完整行区间"解码——块边界永远不会把一个多字节字符劈成乱码。
 */
export async function readTailLines(
  storage: StorageService,
  uri: string,
  maxLines: number,
  opts?: ReadTailOptions,
): Promise<string[]> {
  const chunkSize = Math.max(4096, opts?.chunkSize ?? 64 * 1024);
  const maxBytes = Math.max(chunkSize, opts?.maxBytes ?? 4 * 1024 * 1024);
  const filter = opts?.filter;

  let size: number;
  try {
    size = (await storage.stat(uri)).size;
  } catch {
    return []; // 文件不存在/暂不可读 → 无历史
  }

  const collect = (decoded: string, out: string[]): string[] => {
    let lines = decoded.split('\n').filter(l => l.length > 0);
    if (filter) lines = lines.filter(filter);
    return lines.concat(out);
  };

  try {
    let pos = size;
    let pending: Buffer = Buffer.alloc(0); // 已读但头部可能是半行的字节区，字节级保留待下一块补齐
    let out: string[] = [];
    let bytes = 0;
    while (pos > 0 && out.length < maxLines && bytes < maxBytes) {
      const start = Math.max(0, pos - chunkSize);
      const buf = await storage.readFileRange?.(uri, start, pos);
      if (!buf) throw new Error('readFileRange unavailable');
      pos = start;
      bytes += buf.length;
      const combined = pending.length > 0 ? Buffer.concat([buf, pending]) : buf;
      if (pos > 0) {
        const nl = combined.indexOf(0x0a);
        if (nl === -1) {
          pending = combined; // 一整块都没凑出行边界（超长行），继续向前
          continue;
        }
        pending = combined.subarray(0, nl + 1);
        out = collect(combined.subarray(nl + 1).toString('utf8'), out);
      } else {
        pending = Buffer.alloc(0);
        out = collect(combined.toString('utf8'), out);
      }
    }
    // pos>0 时 pending 头部是半行，解码会得到残缺内容——丢弃；pos===0 时已并入
    return out.slice(-maxLines);
  } catch {
    // 提供者不支持范围读 → 整文件回退
    try {
      const raw = (await storage.readFile(uri, 'utf8')) as string;
      let lines = raw.split('\n').filter(l => l.length > 0);
      if (filter) lines = lines.filter(filter);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }
}

// ----- 服务描述符 -----

/** 业务层恒定义的几个可选方法：选中的那一家不支持时由调用本身抛错，调用方无需判存在 */
type StorageMethods = StorageService & Required<Pick<StorageService, 'resolveLocalPath' | 'readFileRange' | 'watch'>>;

/**
 * 本插件的私有目录 `pluginData:/<插件名>/` 上的存储视图（{@link BoundStorage.own}）。插件名取定义名的最后一段、去掉
 * `plugin-` 前缀（`@aalis/plugin-paper` → `paper`），多实例共用这个目录、由插件自己分子目录。方法与 {@link StorageService}
 * 相同，路径参数相对这个目录：规范化之后越出目录的（`..` 越过目录）、宿主机绝对路径与存储地址都抛错；返回值里的地址是
 * 完整的存储地址。
 */
export type OwnStorage = Omit<StorageMethods, 'listRoots'> & {
  /** 相对路径对应的完整存储地址（要交给别处、写进记录时用）；不给即目录本身 */
  uri(path?: string): string;
};

/** `storage` 的业务层：调用转发给选中的那一家，另带本插件的私有目录 */
export interface BoundStorage extends StorageMethods {
  readonly own: OwnStorage;
}

/** 私有目录下的相对路径 → 完整存储地址；越不出目录 */
function ownUri(dir: string, path: string): string {
  if (isHostAbsolutePath(path) || STORAGE_URI_RE.test(path)) throw new Error(`插件私有目录只收相对路径: ${path}`);
  const segments: string[] = [];
  for (const segment of unifySlashes(path).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment !== '..') segments.push(segment);
    else if (segments.pop() === undefined) throw new Error(`路径越出插件私有目录 pluginData:/${dir}/: ${path}`);
  }
  return joinStorageUri('pluginData', [dir, ...segments]);
}

export const storage = defineService<StorageService, BoundStorage>('storage', port => {
  const provider = port.provider;
  const supported = <K extends 'resolveLocalPath' | 'readFileRange' | 'watch'>(name: K): StorageMethods[K] => {
    const method = provider[name];
    if (typeof method !== 'function') throw new Error(`存储提供者不支持 ${name}`);
    return method as StorageMethods[K];
  };
  const extra: Pick<StorageMethods, 'resolveLocalPath' | 'readFileRange' | 'watch'> = {
    resolveLocalPath: (uri, access) => supported('resolveLocalPath')(uri, access),
    readFileRange: (uri, start, end) => supported('readFileRange')(uri, start, end),
    watch: (uri, listener) => supported('watch')(uri, listener),
  };
  const methods: StorageMethods = Object.assign(Object.create(provider) as StorageMethods, extra);
  const { moduleName } = parseInstanceId(port.id);
  const dir = moduleName.slice(moduleName.lastIndexOf('/') + 1).replace(/^plugin-/, '');
  const uri = (path = '') => ownUri(dir, path);
  const own: OwnStorage = {
    uri,
    list: path => methods.list(uri(path)),
    stat: path => methods.stat(uri(path)),
    readFile: (path, encoding) => methods.readFile(uri(path), encoding),
    readFileRange: (path, start, end) => methods.readFileRange(uri(path), start, end),
    createReadStream: path => methods.createReadStream(uri(path)),
    writeFile: (path, data, options) => methods.writeFile(uri(path), data, options),
    rename: (path, newName) => methods.rename(uri(path), newName),
    move: (from, to) => methods.move(uri(from), uri(to)),
    mkdir: path => methods.mkdir(uri(path)),
    delete: path => methods.delete(uri(path)),
    resolveLocalPath: (path, access) => methods.resolveLocalPath(uri(path), access),
    watch: (path, listener) => methods.watch(uri(path), listener),
  };
  return Object.assign(methods, { own });
});
