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
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  delete(uri: string): Promise<void>;
  /**
   * 把 storage URI 解析为本机绝对路径，给必须使用本地路径的子进程（shell、code-runner）用。
   *
   * 注意：解析过程会校验目标位于声明的根内，但**不会限制后续子进程的访问范围**。
   * 调用方必须自觉只把这条路径用作"工作目录/起点"，不要把它当成沙箱边界。
   */
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
}

// ----- 存储能力声明 -----

export interface StorageCapabilityRegistry {
  List: 'list';
  Read: 'read';
  Write: 'write';
  Delete: 'delete';
  LocalPath: 'local-path';
}

export type StorageCapability = StorageCapabilityRegistry[keyof StorageCapabilityRegistry];

export const StorageCapabilities = {
  List: 'list',
  Read: 'read',
  Write: 'write',
  Delete: 'delete',
  LocalPath: 'local-path',
} as const satisfies StorageCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    storage: StorageCapability;
  }
}

import type { Context } from '@aalis/core';
import { registerCapabilityProbe } from '@aalis/core';

registerCapabilityProbe('storage', StorageCapabilities.List, inst =>
  typeof (inst as { list?: unknown }).list === 'function' &&
  typeof (inst as { listRoots?: unknown }).listRoots === 'function'
    ? true
    : 'StorageService.listRoots()/list() are required for capability "list"',
);

registerCapabilityProbe('storage', StorageCapabilities.Read, inst =>
  typeof (inst as { readFile?: unknown }).readFile === 'function' &&
  typeof (inst as { createReadStream?: unknown }).createReadStream === 'function'
    ? true
    : 'StorageService.readFile()/createReadStream() are required for capability "read"',
);

registerCapabilityProbe('storage', StorageCapabilities.Write, inst =>
  typeof (inst as { writeFile?: unknown }).writeFile === 'function' &&
  typeof (inst as { rename?: unknown }).rename === 'function'
    ? true
    : 'StorageService.writeFile()/rename() are required for capability "write"',
);

registerCapabilityProbe('storage', StorageCapabilities.Delete, inst =>
  typeof (inst as { delete?: unknown }).delete === 'function'
    ? true
    : 'StorageService.delete() is required for capability "delete"',
);

registerCapabilityProbe('storage', StorageCapabilities.LocalPath, inst =>
  typeof (inst as { resolveLocalPath?: unknown }).resolveLocalPath === 'function'
    ? true
    : 'StorageService.resolveLocalPath() is required for capability "local-path"',
);

// ----- 聚合 / 路由 helper -----
//
// service-granularity 之后，每个 storage 后端按 root 拆出独立 entry：
//   contextId = `${plugin-instance-id}/${root.name}`
//   capabilities = 反映该 root 的真实权限（read/write/delete/local-path）
//
// 不再有 "router facade entry"。所有按 URI / root 名查询的逻辑都是纯函数。

export interface AggregatedStorageRoot extends StorageRootInfo {
  /** 提供该根的 entry contextId（便于排查同名冲突） */
  providerId: string;
  /** entry 的 label（来自 ctx.provide 的 label 选项） */
  provider?: string;
}

export interface StorageRootConflict {
  /** 冲突的根名 */
  name: string;
  /** 当前实际生效的根（按枚举顺序首个） */
  selected: AggregatedStorageRoot;
  /** 被遮蔽、不会被 URI 路由到的同名根 */
  shadowed: AggregatedStorageRoot[];
  /** 所有候选根，按 entry 顺序从高到低排列 */
  providers: Array<AggregatedStorageRoot & { selected: boolean }>;
}

export interface StorageProviderEntry {
  instance: StorageService;
  contextId: string;
  capabilities: string[];
  label?: string;
}

function safeListRoots(entry: { instance: StorageService; contextId: string }): StorageRootInfo[] {
  try {
    return entry.instance.listRoots() ?? [];
  } catch {
    return [];
  }
}

/** 枚举所有 storage entry（capabilities 过滤可选） */
export function getStorageEntries(
  ctx: Context,
  requiredCaps?: readonly StorageCapability[],
): StorageProviderEntry[] {
  return ctx.getAllServices<StorageService>('storage', requiredCaps as readonly string[] | undefined);
}

/** 聚合所有 entry 的 root 列表（保留 providerId/label） */
export function aggregateStorageRoots(ctx: Context): AggregatedStorageRoot[] {
  const out: AggregatedStorageRoot[] = [];
  for (const entry of getStorageEntries(ctx)) {
    for (const r of safeListRoots(entry)) {
      out.push({ ...r, providerId: entry.contextId, provider: entry.label });
    }
  }
  return out;
}

/** 同名 root 冲突诊断（用于 doctor / 启动日志） */
export function getStorageRootConflicts(ctx: Context): StorageRootConflict[] {
  const grouped = new Map<string, AggregatedStorageRoot[]>();
  for (const r of aggregateStorageRoots(ctx)) {
    const arr = grouped.get(r.name);
    if (arr) arr.push(r);
    else grouped.set(r.name, [r]);
  }
  const conflicts: StorageRootConflict[] = [];
  for (const [name, roots] of grouped) {
    if (roots.length <= 1) continue;
    const [selected, ...shadowed] = roots;
    conflicts.push({
      name,
      selected,
      shadowed,
      providers: roots.map((r, i) => ({ ...r, selected: i === 0 })),
    });
  }
  return conflicts;
}

/** 按 root 名查找首个匹配且满足 caps 的 entry */
export function resolveStorageEntryForRoot(
  ctx: Context,
  rootName: string,
  requiredCaps?: readonly StorageCapability[],
): StorageProviderEntry | undefined {
  for (const entry of getStorageEntries(ctx, requiredCaps)) {
    if (safeListRoots(entry).some(r => r.name === rootName)) return entry;
  }
  return undefined;
}

/** 按 storage URI（`<root>:/<path>`）找到对应 entry */
export function resolveStorageByPath(
  ctx: Context,
  uri: string,
  requiredCaps?: readonly StorageCapability[],
): StorageProviderEntry | undefined {
  return resolveStorageEntryForRoot(ctx, parseUriRoot(uri), requiredCaps);
}

function parseUriRoot(uri: string): string {
  const idx = uri.indexOf(':/');
  if (idx <= 0) throw new Error(`存储 URI 不合法: ${uri}（应为 <根名>:/<相对路径>）`);
  return uri.slice(0, idx);
}

/**
 * 创建一个面向调用方的 StorageService 网关：每次方法调用按 URI 路由到对应 entry。
 *
 * 不注册到 ServiceContainer——纯本地构造，没有 facade entry。适用于 tools / shell /
 * checkpoint 等需要单一 StorageService 句柄、又想透明跨 root 调度的场景。
 *
 * 调用方无需关心当前有哪些 root 由哪个后端提供；URI 即标识 + 路由 key。
 */
export function createStorageGateway(ctx: Context): StorageService {
  const knownRootsList = (): string[] => {
    const set = new Set<string>();
    for (const entry of getStorageEntries(ctx)) {
      for (const r of safeListRoots(entry)) set.add(r.name);
    }
    return [...set];
  };
  const dispatch = (uri: string, caps?: readonly StorageCapability[]): StorageService => {
    const target = resolveStorageByPath(ctx, uri, caps);
    if (!target) {
      const known = knownRootsList();
      throw new Error(
        `未知存储根: ${parseUriRoot(uri)}（已注册根: ${known.join(', ') || '(无)'}` +
          (caps ? `, 需能力 [${caps.join(',')}]` : '') +
          ')',
      );
    }
    return target.instance;
  };

  return {
    listRoots() {
      const seen = new Map<string, StorageRootInfo>();
      for (const r of aggregateStorageRoots(ctx)) {
        if (seen.has(r.name)) continue;
        const { providerId: _p, provider: _l, ...info } = r;
        seen.set(r.name, info);
      }
      return [...seen.values()];
    },
    list: uri => dispatch(uri, ['list']).list(uri),
    stat: uri => dispatch(uri).stat(uri),
    readFile: (uri, encoding) => dispatch(uri, ['read']).readFile(uri, encoding),
    createReadStream: uri => dispatch(uri, ['read']).createReadStream(uri),
    writeFile: (uri, data) => dispatch(uri, ['write']).writeFile(uri, data),
    rename: (uri, newName) => dispatch(uri, ['write']).rename(uri, newName),
    delete: uri => dispatch(uri, ['delete']).delete(uri),
    resolveLocalPath: (uri, access) => {
      const caps: StorageCapability[] =
        access === 'write'
          ? ['write', 'local-path']
          : access === 'delete'
            ? ['delete', 'local-path']
            : ['local-path'];
      const target = dispatch(uri, caps);
      if (!target.resolveLocalPath) {
        throw new Error(`存储根 ${parseUriRoot(uri)} 不支持 local-path（远程协议或纯虚拟根）`);
      }
      return target.resolveLocalPath(uri, access);
    },
  };
}
