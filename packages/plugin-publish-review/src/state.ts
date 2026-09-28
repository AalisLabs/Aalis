import {
  PUBLIC_CONTENT_TYPES,
  type PublishedItem,
  type PublishOrigin,
  publicPathProblem,
  type WorkKind,
} from '@aalis/api-publish';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';

const STATE_URI = 'pluginData:/publish-review/state.json';
export const ITEM_ROOT = 'pluginData:/publish-review/items';
export const PUBLIC_ROOT = 'public:';

export interface FileRecord {
  path: string;
  size: number;
  contentType: string;
  sha256?: string;
}
export interface QueueItem {
  id: string;
  state: 'queued' | 'checking' | 'awaiting-owner';
  origin: PublishOrigin;
  group: string;
  groupLabel: string;
  surfaces: string[];
  title: string;
  summary: string;
  credit: string;
  kind: WorkKind;
  files: FileRecord[];
  hasCover: boolean;
  nominatedAt: number;
  awaitingSince?: number;
  /** 缺省是旧版的全量人工待审；fallback 不因关闭全量人工而重新排队。 */
  awaitingReason?: 'required' | 'fallback';
  outHashes?: Record<string, string>;
  thumbnailHash?: string;
  review?: { flags: string[]; reasons: string[]; images: string[]; hasRender: boolean; classification?: string };
}
export interface LedgerItem extends PublishedItem {
  state: 'published' | 'withdrawn';
  origin: PublishOrigin;
  files: Array<{ path: string; size: number; contentType: string; sha256: string }>;
  thumbnail?: { size: number; sha256: string };
  notice: 'pending' | 'delayed' | 'sent' | 'none';
  nominatedAt: number;
  withdrawn?: { at: number; by: 'origin' | 'owner' | 'integrity'; actorKey?: string; reason: string };
}
interface ReviewState {
  version: 1;
  queue: Record<string, QueueItem>;
  ledger: Record<string, LedgerItem>;
  /** 24 小时内的提名流水；失败、拒绝、撤回也占每日配额。 */
  nominations: Array<{ source: string; at: number }>;
  history: Array<{ at: number; id: string; event: string; detail: string }>;
  notices: Record<string, { id: string; origin: PublishOrigin; content: string; live: boolean }>;
}

function empty(): ReviewState {
  return { version: 1, queue: {}, ledger: {}, nominations: [], history: [], notices: {} };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const string = (value: unknown) => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function origin(value: unknown): boolean {
  if (!record(value) || !string(value.producer) || !string(value.ref) || !string(value.label)) return false;
  if (value.actorKey !== undefined && !string(value.actorKey)) return false;
  return (
    value.notify === undefined ||
    (record(value.notify) && string(value.notify.sessionId) && string(value.notify.platform))
  );
}
function files(value: unknown, published: boolean): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(file => {
      if (
        !record(file) ||
        !string(file.path) ||
        publicPathProblem(file.path) ||
        !time(file.size) ||
        !string(file.contentType)
      )
        return false;
      const ext = file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase();
      if (file.contentType !== PUBLIC_CONTENT_TYPES[ext]) return false;
      return published ? digest(file.sha256) : file.sha256 === undefined;
    })
  );
}
function common(value: Record<string, unknown>, id: string): boolean {
  return (
    value.id === id &&
    origin(value.origin) &&
    string(value.group) &&
    string(value.groupLabel) &&
    strings(value.surfaces) &&
    value.surfaces.length > 0 &&
    string(value.title) &&
    string(value.summary) &&
    string(value.credit) &&
    (value.kind === 'media' || value.kind === 'html') &&
    time(value.nominatedAt)
  );
}
function valid(value: unknown): value is ReviewState {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.queue) ||
    !record(value.ledger) ||
    !Array.isArray(value.nominations)
  )
    return false;
  if (
    value.nominations.some(
      entry =>
        !record(entry) ||
        typeof entry.source !== 'string' ||
        typeof entry.at !== 'number' ||
        !Number.isFinite(entry.at),
    )
  )
    return false;
  if (
    value.history !== undefined &&
    (!Array.isArray(value.history) ||
      value.history.some(
        entry =>
          !record(entry) || !time(entry.at) || !string(entry.id) || !string(entry.event) || !string(entry.detail),
      ))
  )
    return false;
  if (
    value.notices !== undefined &&
    (!record(value.notices) ||
      Object.values(value.notices).some(
        entry =>
          !record(entry) ||
          !string(entry.id) ||
          !origin(entry.origin) ||
          !string(entry.content) ||
          typeof entry.live !== 'boolean',
      ))
  )
    return false;
  for (const [id, entry] of Object.entries(value.queue)) {
    if (
      !/^[a-z2-7]{10}$/.test(id) ||
      !record(entry) ||
      !common(entry, id) ||
      !['queued', 'checking', 'awaiting-owner'].includes(String(entry.state)) ||
      !files(entry.files, false) ||
      typeof entry.hasCover !== 'boolean' ||
      (entry.awaitingSince !== undefined && !time(entry.awaitingSince)) ||
      (entry.awaitingReason !== undefined && !['required', 'fallback'].includes(String(entry.awaitingReason))) ||
      (entry.thumbnailHash !== undefined && !digest(entry.thumbnailHash))
    )
      return false;
    if (
      entry.review !== undefined &&
      (!record(entry.review) ||
        !strings(entry.review.flags) ||
        !strings(entry.review.reasons) ||
        !strings(entry.review.images) ||
        entry.review.images.some(name => !/^[a-z0-9-]+\.png$/.test(name)) ||
        typeof entry.review.hasRender !== 'boolean' ||
        (entry.review.classification !== undefined && !string(entry.review.classification)))
    )
      return false;
    if (
      entry.outHashes !== undefined &&
      (!record(entry.outHashes) ||
        Object.entries(entry.outHashes).some(
          ([path, hash]) => (path !== '_thumb.png' && publicPathProblem(path)) || !digest(hash),
        ))
    )
      return false;
  }
  for (const [id, entry] of Object.entries(value.ledger)) {
    if (
      !/^[a-z2-7]{10}$/.test(id) ||
      !record(entry) ||
      !common(entry, id) ||
      !['published', 'withdrawn'].includes(String(entry.state)) ||
      !files(entry.files, true) ||
      !time(entry.publishedAt) ||
      typeof entry.hasThumbnail !== 'boolean' ||
      !['pending', 'delayed', 'sent', 'none'].includes(String(entry.notice))
    )
      return false;
    if (
      entry.hasThumbnail !== !!entry.thumbnail ||
      (entry.thumbnail !== undefined &&
        (!record(entry.thumbnail) || !time(entry.thumbnail.size) || !digest(entry.thumbnail.sha256)))
    )
      return false;
    if (
      entry.withdrawn !== undefined &&
      (!record(entry.withdrawn) ||
        !time(entry.withdrawn.at) ||
        !['origin', 'owner', 'integrity'].includes(String(entry.withdrawn.by)) ||
        !string(entry.withdrawn.reason) ||
        (entry.withdrawn.actorKey !== undefined && !string(entry.withdrawn.actorKey)))
    )
      return false;
  }
  return true;
}

/** 写入由 StorageService 的本地实现保证单文件原子替换；内存只在写成功后换代。 */
export class ReviewStore {
  data: ReviewState = empty();
  failure?: string;
  auditFailure?: string;
  readonly #listeners = new Set<() => void>();
  #queue: Promise<void> = Promise.resolve();
  constructor(readonly storage: StorageService) {}

  async load(): Promise<void> {
    try {
      const source = await this.storage.readFile(STATE_URI, 'utf8');
      const parsed: unknown = JSON.parse(String(source));
      if (!valid(parsed)) throw new Error('结构不合法');
      this.data = { ...parsed, history: parsed.history ?? [], notices: parsed.notices ?? {} };
      for (const item of Object.values(this.data.queue)) if (item.state === 'checking') item.state = 'queued';
    } catch (err) {
      if (isStorageNotFound(err)) return;
      this.failure = '作品账本读取失败，等 owner 处理';
    }
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async save(
    next: ReviewState,
    event?: ReviewState['history'][number] | Array<ReviewState['history'][number]>,
  ): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    const entries = event ? (Array.isArray(event) ? event : [event]) : [];
    if (entries.length) next.history = [...next.history, ...entries].slice(-100);
    await this.storage.writeFile(STATE_URI, JSON.stringify(next));
    this.data = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* 状态已提交，其他监听者继续 */
      }
    }
    if (entries.length) {
      const uri = 'pluginData:/publish-review/audit.jsonl';
      try {
        let previous = '';
        try {
          previous = String(await this.storage.readFile(uri, 'utf8'));
        } catch (err) {
          if (!isStorageNotFound(err)) throw err;
        }
        await this.storage.writeFile(uri, previous + entries.map(entry => `${JSON.stringify(entry)}\n`).join(''));
        this.auditFailure = undefined;
      } catch {
        this.auditFailure = '审核记录追加失败';
      }
    }
  }

  copy(): ReviewState {
    return structuredClone(this.data);
  }
}
