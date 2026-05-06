import type { Context, Logger } from '@aalis/core';
import type {
  StorageListResult,
  StorageReadStreamResult,
  StorageRootInfo,
  StorageService,
  StorageStat,
} from '@aalis/core';

/** 单条根的聚合视图（带提供者来源） */
export interface AggregatedStorageRoot extends StorageRootInfo {
  /** 提供该根的服务 contextId（便于排查同名冲突） */
  providerId: string;
  /** 提供者的展示标签（见 ctx.provide 的 label） */
  provider?: string;
}

/** 同名存储根冲突明细 */
export interface StorageRootConflict {
  /** 冲突的根名 */
  name: string;
  /** 当前实际生效的根（最高优先级 provider） */
  selected: AggregatedStorageRoot;
  /** 被遮蔽、不会被 URI 路由到的同名根 */
  shadowed: AggregatedStorageRoot[];
  /** 所有候选根，按 provider 优先级从高到低排列 */
  providers: Array<AggregatedStorageRoot & { selected: boolean }>;
}

/**
 * 存储路由器
 *
 * 同名 facade 模式：通过 `ctx.provide('storage', router, { capabilities: ['router'] })`
 * 注册成 storage 服务的"高优先级聚合层"。底层 provider 仍以 `provide('storage', impl)`
 * 单独存在，router 通过 `getAllServices('storage')` 枚举它们并按 URI 根名分发。
 *
 * 自我排除：枚举 storage 服务时过滤掉 instance === this，避免无限递归。
 */
export class StorageRouter implements StorageService {
  private _rootMap: Map<string, string> | null = null;
  private _conflictsLogged = new Set<string>();

  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  invalidate(): void {
    this._rootMap = null;
    this._conflictsLogged.clear();
  }

  /** 仅枚举真正的 provider，排除 router 自身 */
  private getProviders(): Array<{ instance: StorageService; contextId: string; label?: string }> {
    return this.ctx.getAllServices<StorageService>('storage')
      .filter(e => e.instance !== this);
  }

  hasAny(): boolean {
    return this.getProviders().length > 0;
  }

  listAllRoots(): AggregatedStorageRoot[] {
    const out: AggregatedStorageRoot[] = [];
    for (const { instance, contextId, label } of this.getProviders()) {
      for (const r of safeListRoots(instance, contextId, this.logger)) {
        out.push({ ...r, providerId: contextId, provider: label });
      }
    }
    return out;
  }

  getRootConflicts(): StorageRootConflict[] {
    const grouped = new Map<string, AggregatedStorageRoot[]>();
    for (const root of this.listAllRoots()) {
      const roots = grouped.get(root.name);
      if (roots) roots.push(root);
      else grouped.set(root.name, [root]);
    }

    const conflicts: StorageRootConflict[] = [];
    for (const [name, roots] of grouped) {
      if (roots.length <= 1) continue;
      const [selected, ...shadowed] = roots;
      conflicts.push({
        name,
        selected,
        shadowed,
        providers: roots.map((root, index) => ({ ...root, selected: index === 0 })),
      });
    }
    return conflicts;
  }

  // ---- StorageService 实现：合并根 + 按根分发 ----

  listRoots(): StorageRootInfo[] {
    const seen = new Map<string, StorageRootInfo>();
    for (const { instance, contextId } of this.getProviders()) {
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

  resolveLocalPath(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string> {
    const provider = this.resolveProvider(uri);
    if (typeof provider.resolveLocalPath !== 'function') {
      const root = parseRoot(uri);
      throw new Error(`存储根 ${root}:/ 不支持 local-path（远程协议或纯虚拟根无法落到本机绝对路径）`);
    }
    return provider.resolveLocalPath(uri, access);
  }

  // ---- 内部 ----

  private resolveProvider(uri: string): StorageService {
    const root = parseRoot(uri);
    const map = this.ensureRootMap();
    const providerId = map.get(root);
    const providers = this.getProviders();
    if (providerId) {
      const found = providers.find(p => p.contextId === providerId);
      if (found) return found.instance;
      this.invalidate();
    }
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
    for (const { instance, contextId } of this.getProviders()) {
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
