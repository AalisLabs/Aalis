import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type {
  StorageListResult,
  StorageReadStreamResult,
  StorageRootInfo,
  StorageService,
  StorageStat,
} from './types/storage.js';

/** 单条根的聚合视图（带提供者来源） */
export interface AggregatedStorageRoot extends StorageRootInfo {
  /** 提供该根的服务 contextId（便于排查同名冲突） */
  providerId: string;
  /** 提供者的展示标签（见 ctx.provide 的 label） */
  provider?: string;
}

/**
 * 存储路由器
 *
 * 与 {@link LLMRouter} 同形态：
 *   - 不持有数据，只在 ServiceContainer 上做聚合查询
 *   - 服务注册/注销时由 Context 调 invalidate() 清掉根名映射缓存
 *
 * 关键差异：
 *   1. **本身实现 `StorageService`**。这样 file 工具、shell、code-runner 这些
 *      只依赖 `StorageService` 接口的调用方，从 `ctx.getService('storage')`
 *      切到 `ctx.storage` 即可同时访问到所有 provider 提供的根，不需要每个
 *      调用方自己做聚合。
 *   2. **按 URI 的根名分发**。`workspace:/a.md` 走 local provider，未来
 *      `share:/x` 可以走 SMB provider，调用方无感。
 *   3. **`listRoots()` 合并去重**。同名根冲突时保留高优先级 provider，并 warn。
 *
 * 注意：路由器自身没有"沙箱"语义，每个根的实际权限和约束由源 provider 决定。
 */
export class StorageRouter implements StorageService {
  private _rootMap: Map<string, string> | null = null;
  private _conflictsLogged = new Set<string>();

  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  /** 服务注册/注销时调用，清掉根名→contextId 的映射缓存 */
  invalidate(): void {
    this._rootMap = null;
    this._conflictsLogged.clear();
  }

  /** 是否至少有一个 storage provider 在线 */
  hasAny(): boolean {
    return this.ctx.getAllServices<StorageService>('storage').length > 0;
  }

  /** 聚合所有 provider 的根（带来源标识，未去重） */
  listAllRoots(): AggregatedStorageRoot[] {
    const out: AggregatedStorageRoot[] = [];
    for (const { instance, contextId, label } of this.ctx.getAllServices<StorageService>('storage')) {
      for (const r of safeListRoots(instance, contextId, this.logger)) {
        out.push({ ...r, providerId: contextId, provider: label });
      }
    }
    return out;
  }

  // ---- StorageService 实现：合并根 + 按根分发 ----

  /** 合并去重后的根列表。根名冲突时保留首条（=高优先级 provider 提供） */
  listRoots(): StorageRootInfo[] {
    const seen = new Map<string, StorageRootInfo>();
    for (const { instance, contextId } of this.ctx.getAllServices<StorageService>('storage')) {
      for (const r of safeListRoots(instance, contextId, this.logger)) {
        const existing = seen.get(r.name);
        if (!existing) {
          seen.set(r.name, r);
        } else if (!this._conflictsLogged.has(r.name)) {
          this._conflictsLogged.add(r.name);
          this.logger.warn(
            `存储根名冲突: "${r.name}" 同时由多个 provider 提供，将使用高优先级实现，` +
              `后注册的来源 contextId=${contextId} 被忽略`,
          );
        }
      }
    }
    return [...seen.values()];
  }

  list(uri: string): Promise<StorageListResult> {
    return this.resolveProvider(uri).list(uri);
  }
  stat(uri: string): Promise<StorageStat> {
    return this.resolveProvider(uri).stat(uri);
  }
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    return this.resolveProvider(uri).readFile(uri, encoding);
  }
  createReadStream(uri: string): Promise<StorageReadStreamResult> {
    return this.resolveProvider(uri).createReadStream(uri);
  }
  writeFile(uri: string, data: string | Buffer): Promise<void> {
    return this.resolveProvider(uri).writeFile(uri, data);
  }
  rename(uri: string, newName: string): Promise<string> {
    return this.resolveProvider(uri).rename(uri, newName);
  }
  delete(uri: string): Promise<void> {
    return this.resolveProvider(uri).delete(uri);
  }

  /** 仅当 URI 所属 provider 实现了 resolveLocalPath 才可用；否则抛出明确错误 */
  resolveLocalPath(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string> {
    const provider = this.resolveProvider(uri);
    if (typeof provider.resolveLocalPath !== 'function') {
      const root = parseRoot(uri);
      throw new Error(`存储根 ${root}:/ 不支持 local-path（远程协议或纯虚拟根无法落到本机绝对路径）`);
    }
    return provider.resolveLocalPath(uri, access);
  }

  // ---- 内部 ----

  /** 按 URI 的根名找到对应 provider；缺失时给出可用根列表 */
  private resolveProvider(uri: string): StorageService {
    const root = parseRoot(uri);
    const map = this.ensureRootMap();
    const providerId = map.get(root);
    const providers = this.ctx.getAllServices<StorageService>('storage');
    if (providerId) {
      const found = providers.find(p => p.contextId === providerId);
      if (found) return found.instance;
      // 缓存里有但服务已下线：清缓存重试一次
      this.invalidate();
    }
    // 慢路径：当场枚举一次（缓存可能没赶上事件）
    for (const { instance, contextId } of providers) {
      for (const r of safeListRoots(instance, contextId, this.logger)) {
        if (r.name === root) return instance;
      }
    }
    const known = [...this.ensureRootMap().keys()];
    throw new Error(
      `未知存储根: ${root}（已注册根: ${known.join(', ') || '(无)'}）`,
    );
  }

  private ensureRootMap(): Map<string, string> {
    if (this._rootMap) return this._rootMap;
    const map = new Map<string, string>();
    for (const { instance, contextId } of this.ctx.getAllServices<StorageService>('storage')) {
      for (const r of safeListRoots(instance, contextId, this.logger)) {
        if (!map.has(r.name)) map.set(r.name, contextId);
      }
    }
    this._rootMap = map;
    return map;
  }
}

function parseRoot(uri: string): string {
  const idx = uri.indexOf(':/');
  if (idx <= 0) throw new Error(`存储 URI 不合法: ${uri}（应为 <根名>:/<相对路径>）`);
  return uri.slice(0, idx);
}

function safeListRoots(instance: StorageService, contextId: string, logger: Logger): StorageRootInfo[] {
  try {
    return instance.listRoots() ?? [];
  } catch (err) {
    logger.warn(`storage provider ${contextId} listRoots 失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
