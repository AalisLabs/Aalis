import type { PublishedItem } from '@aalis/api-publish';
import { isStorageNotFound, type OwnStorage } from '@aalis/api-storage';
import { newAssetSalt } from './cloudflare/hash.js';
import type { WorksSiteConfig } from './config.js';
import type { Tombstone } from './site/build.js';
import { sha256 } from './verify.js';

const DEFAULT_INSTANCE = '@aalis/plugin-works-site';

/** 状态文件在本插件私有目录下的相对路径：默认实例的在目录根上，其他实例按实例 ID 安全编码后各放一个子目录 */
export function statePathForInstance(instanceId: string): string {
  if (instanceId === DEFAULT_INSTANCE) return 'state.json';
  if (!instanceId.startsWith(`${DEFAULT_INSTANCE}:`)) throw new TypeError('作品站实例 ID 不合法');
  const encoded = Array.from(new TextEncoder().encode(instanceId), byte => byte.toString(16).padStart(2, '0')).join('');
  return `instances/${encoded}/state.json`;
}

export interface CurrentDeployment {
  id: string;
  branch: string;
  nonce: string;
  at: number;
  files: Record<string, string>; // path -> SHA-256, never Pages asset keys
  works: PublishedItem[];
  alias?: string;
  verified?: boolean;
}

export interface InFlightDeployment extends Omit<CurrentDeployment, 'id'> {
  id?: string;
  kind: 'new' | 'withdraw';
  /** Changed files are all verified; a random sample of unchanged files is also verified. */
  changed: string[];
}

export interface SiteAlert {
  id: string;
  kind:
    | 'unknown-deployment'
    | 'settings'
    | 'domains'
    | 'probe'
    | 'content'
    | 'cache-lag'
    | 'alias'
    | 'auth'
    | 'integrity'
    | 'deploy-failed';
  detail: string;
  at: number;
  acknowledged?: boolean;
}

export interface WorksState {
  version: 1;
  scope?: string;
  assetSalt: string;
  groups: Record<string, { branch: string; alias?: string; createdAt: number }>;
  current: Record<string, CurrentDeployment>;
  known: Record<string, { branch: string; at: number }>;
  inFlight?: InFlightDeployment;
  tombstones: Tombstone[];
  paused?: { reason: string; at: number };
  lastFailure?: 'auth' | 'deploy-failed';
  alerts: SiteAlert[];
  history: Array<{ at: number; branch: string; deployment: string; result: string }>;
}

async function scopeFingerprint(config: WorksSiteConfig): Promise<string> {
  const { targetId, accountId, projectName, productionBranch, siteOrigin, basePath } = config;
  return sha256(
    new TextEncoder().encode(
      JSON.stringify([targetId, accountId, projectName, productionBranch, siteOrigin, basePath]),
    ),
  );
}

function hasRemoteHistory(state: WorksState): boolean {
  return (
    Object.keys(state.current).length > 0 ||
    Object.keys(state.known).length > 0 ||
    Object.keys(state.groups).length > 0 ||
    state.inFlight !== undefined ||
    state.tombstones.length > 0
  );
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const workId = (v: unknown): v is string => string(v) && /^[a-z2-7]{10}$/.test(v);
const deploymentId = (v: unknown): v is string => string(v) && /^[0-9a-f][0-9a-f-]{7,63}$/.test(v);
const branch = (v: unknown): v is string => string(v) && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(v);

function works(v: unknown): v is PublishedItem[] {
  return (
    Array.isArray(v) &&
    v.every(
      item =>
        record(item) &&
        workId(item.id) &&
        string(item.group) &&
        (item.kind === 'html' || item.kind === 'media') &&
        Array.isArray(item.files) &&
        item.files.every(file => record(file) && string(file.path) && time(file.size) && string(file.contentType)),
    )
  );
}

function current(v: unknown, allowMissingId: boolean): boolean {
  return (
    record(v) &&
    (allowMissingId ? v.id === undefined || deploymentId(v.id) : deploymentId(v.id)) &&
    branch(v.branch) &&
    string(v.nonce) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(v.nonce) &&
    time(v.at) &&
    record(v.files) &&
    Object.entries(v.files).every(
      ([path, hash]) => path.startsWith('/') && string(hash) && /^[a-f0-9]{64}$/.test(hash),
    ) &&
    works(v.works) &&
    (v.alias === undefined || string(v.alias)) &&
    (v.verified === undefined || typeof v.verified === 'boolean')
  );
}

function valid(v: unknown): v is WorksState {
  if (
    !record(v) ||
    v.version !== 1 ||
    !string(v.assetSalt) ||
    !/^[a-f0-9]{64}$/.test(v.assetSalt) ||
    !record(v.groups) ||
    !record(v.current) ||
    !record(v.known) ||
    !Array.isArray(v.tombstones) ||
    !Array.isArray(v.alerts) ||
    !Array.isArray(v.history)
  )
    return false;
  if (v.scope !== undefined && (!string(v.scope) || !/^[a-f0-9]{64}$/.test(v.scope))) return false;
  if (
    Object.values(v.groups).some(
      g => !record(g) || !branch(g.branch) || !time(g.createdAt) || (g.alias !== undefined && !string(g.alias)),
    )
  )
    return false;
  if (
    Object.entries(v.current).some(
      ([key, value]) => !branch(key) || !current(value, false) || (value as CurrentDeployment).branch !== key,
    )
  )
    return false;
  if (Object.entries(v.known).some(([key, k]) => !deploymentId(key) || !record(k) || !branch(k.branch) || !time(k.at)))
    return false;
  if (
    v.inFlight !== undefined &&
    (!current(v.inFlight, true) ||
      !['new', 'withdraw'].includes(String((v.inFlight as Record<string, unknown>).kind)) ||
      !Array.isArray((v.inFlight as Record<string, unknown>).changed) ||
      !(v.inFlight as InFlightDeployment).changed.every(string))
  )
    return false;
  if (v.tombstones.some(t => !record(t) || !string(t.branch) || !string(t.path) || !time(t.until))) return false;
  if (v.paused !== undefined && (!record(v.paused) || !string(v.paused.reason) || !time(v.paused.at))) return false;
  if (v.lastFailure !== undefined && !['auth', 'deploy-failed'].includes(String(v.lastFailure))) return false;
  if (
    v.alerts.some(
      a =>
        !record(a) ||
        !string(a.id) ||
        !string(a.kind) ||
        !string(a.detail) ||
        !time(a.at) ||
        (a.acknowledged !== undefined && typeof a.acknowledged !== 'boolean'),
    )
  )
    return false;
  return v.history.every(h => record(h) && time(h.at) && branch(h.branch) && string(h.deployment) && string(h.result));
}

export class WorksStore {
  data?: WorksState;
  failure?: string;
  #writing: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #listeners = new Set<() => void>();
  /** 状态文件的完整存储地址 */
  readonly uri: string;
  readonly #path: string;
  readonly #defaultInstance: boolean;
  constructor(
    readonly storage: Pick<OwnStorage, 'readFile' | 'writeFile' | 'uri'>,
    instanceId = DEFAULT_INSTANCE,
  ) {
    this.#path = statePathForInstance(instanceId);
    this.#defaultInstance = instanceId === DEFAULT_INSTANCE;
    this.uri = storage.uri(this.#path);
  }

  async load(): Promise<void> {
    try {
      const raw = await this.storage.readFile(this.#path, 'utf8');
      const parsed: unknown = JSON.parse(String(raw));
      if (!valid(parsed)) throw new Error('结构不合法');
      this.data = parsed;
    } catch (err) {
      if (isStorageNotFound(err)) {
        this.data = {
          version: 1,
          assetSalt: newAssetSalt(),
          groups: {},
          current: {},
          known: {},
          tombstones: [],
          alerts: [],
          history: [],
        };
        await this.save(this.data);
        return;
      }
      this.failure = '作品站状态文件读取失败';
    }
  }

  /** Once a remote deployment exists, never reinterpret its ledger under another public scope. */
  async bindScope(config: WorksSiteConfig): Promise<void> {
    if (this.failure) return; // Existing unreadable-state behavior keeps this instance disabled.
    const next = await scopeFingerprint(config);
    await this.update(state => {
      if (hasRemoteHistory(state)) {
        if (state.scope) {
          if (state.scope !== next) throw new Error('作品站发布范围与已部署账本不符');
        } else if (this.#defaultInstance && (config.targetId !== 'works' || config.basePath !== '/')) {
          // Before scope was persisted, the only instance was the default root target.
          throw new Error('作品站发布范围与旧版根目录账本不符');
        }
      }
      state.scope = next;
    });
  }

  /** 每次写盘成功、内存换成新状态之后调 listener（作品站页重取、健康状况的提示跟着变）；返回退订 */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** One serialized whole-state write; memory advances only after durable write succeeds. */
  save(next: WorksState): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('作品站状态实例已停止'));
    if (this.failure) return Promise.reject(new Error(this.failure));
    const run = this.#writing.then(async () => {
      if (this.#closed) throw new Error('作品站状态实例已停止');
      await this.storage.writeFile(this.#path, JSON.stringify(next));
      this.data = next;
      this.#changed();
    });
    this.#writing = run.catch(() => {});
    return run;
  }

  /** Serial read-modify-write: concurrent WebUI, timer and deploy callbacks never commit stale snapshots. */
  update<T>(change: (draft: WorksState) => T): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('作品站状态实例已停止'));
    if (this.failure) return Promise.reject(new Error(this.failure));
    const run = this.#writing.then(async () => {
      if (this.#closed) throw new Error('作品站状态实例已停止');
      if (!this.data) throw new Error('作品站状态尚未加载');
      const draft = structuredClone(this.data);
      const result = change(draft);
      await this.storage.writeFile(this.#path, JSON.stringify(draft));
      this.data = draft;
      this.#changed();
      return result;
    });
    this.#writing = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Stop accepting writes and wait only for already started local writes, never remote requests. */
  close(): Promise<void> {
    this.#closed = true;
    return this.#writing;
  }

  copy(): WorksState {
    if (this.failure || !this.data) throw new Error(this.failure ?? '作品站状态尚未加载');
    return structuredClone(this.data);
  }
}
