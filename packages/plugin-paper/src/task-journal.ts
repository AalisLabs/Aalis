// biome-ignore lint/style/noRestrictedImports: 高频短事件键同步哈希，避免每次落盘前额外的线程池往返。
import { createHash } from 'node:crypto';
import { sanitizeRunLog } from '@aalis/api-remote-agent';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';

const ROOT = 'pluginData:/paper/task-logs';
const FILE = /^(\d{12})-([a-f0-9]{64})\.json$/;
const PREVIEW_CHARS = 8192;
const PENDING_BYTES = 8 * 1024 * 1024;

interface Pending {
  taskId: string;
  key?: string;
  hash: string;
  order: number;
  receivedAt: number;
  entry: Record<string, unknown>;
}

interface Index {
  next: number;
  seen: Set<string>;
}

function validTaskId(taskId: string): void {
  if (!/^t-[a-f0-9]{8}$/.test(taskId)) throw new Error('Invalid paper task ID');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function marker(reason: string, details: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'task_journal_incomplete', reason, ...details });
}

/** Durable, ordered, per-task JSONL journal. Failed writes are reported and can be retried with flush(). */
export class TaskJournal {
  #queue: Promise<unknown> = Promise.resolve();
  #indexes = new Map<string, Index>();
  #pending: Pending[] = [];
  #missing = new Set<string>();

  constructor(
    private readonly storage: StorageService,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly now: () => number,
  ) {}

  uri(taskId: string): string {
    validTaskId(taskId);
    return `${ROOT}/${taskId}/`;
  }

  /** Returns true only when this key already exists or the event was persisted. */
  record(taskId: string, key: string | undefined, entry: Record<string, unknown>): Promise<boolean> {
    validTaskId(taskId);
    if (key !== undefined && typeof key !== 'string') throw new TypeError('Journal key must be a string');
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Journal entry must be an object');
    }
    // Snapshot before queuing so a caller cannot mutate an event while it awaits storage.
    const snapshot = JSON.parse(JSON.stringify(sanitizeRunLog(entry))) as unknown;
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('Journal entry must serialize to an object');
    }
    const digest = hash(key === undefined ? `host:${crypto.randomUUID()}` : `event:${key}`);
    const receivedAt = this.now();
    return this.#enqueue(async () => {
      const item = this.#pending.find(p => p.taskId === taskId && p.hash === digest) ?? {
        taskId,
        key,
        hash: digest,
        order: 0,
        receivedAt,
        entry: snapshot as Record<string, unknown>,
      };
      const index = await this.#index(taskId);
      if (!index) {
        this.#hold(item);
        return false;
      }
      // A listing failure leaves the sequence unallocated. Retry earlier events first.
      for (const pending of [...this.#pending]) {
        if (pending.taskId === taskId) await this.#write(pending, index);
      }
      if (index.seen.has(digest)) return true;
      return this.#write(item, index);
    });
  }

  /** Complete JSONL. Rejects before loading event bodies when listed bytes exceed maxBytes. */
  read(taskId: string, maxBytes?: number): Promise<string> {
    validTaskId(taskId);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new RangeError('Journal maxBytes must be a nonnegative integer');
    }
    return this.#enqueue(() => this.#read(taskId, maxBytes));
  }

  /** Last N JSONL records for display; oversized records become marked previews. */
  recent(taskId: string, limit = 20): Promise<string> {
    validTaskId(taskId);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Journal limit must be a nonnegative integer');
    return this.#enqueue(async () => {
      if (limit === 0) return '';
      const listed = await this.#files(taskId);
      if (typeof listed === 'string') return `${listed}\n`;
      const selected = listed.slice(-limit);
      const lines: string[] = [];
      const first = selected[0];
      if (first) {
        let expected = 1;
        let earlierGap: string | undefined;
        for (const file of listed.slice(0, -selected.length)) {
          const order = this.#order(file.name);
          if (order > expected && !earlierGap) {
            earlierGap = marker('missing_sequence', { from: expected, to: order - 1 });
          }
          expected = order + 1;
        }
        if (earlierGap) lines.push(earlierGap);
        const actual = this.#order(first.name);
        if (actual > expected) lines.push(marker('missing_sequence', { from: expected, to: actual - 1 }));
      }
      let previous: number | undefined;
      for (const file of selected) {
        const order = this.#order(file.name);
        if (previous !== undefined && order > previous + 1) {
          lines.push(marker('missing_sequence', { from: previous + 1, to: order - 1 }));
        }
        previous = order;
        const uri = `${this.uri(taskId)}${file.name}`;
        try {
          let preview: string;
          if (file.size > PREVIEW_CHARS && this.storage.readFileRange) {
            try {
              preview = (await this.storage.readFileRange(uri, 0, PREVIEW_CHARS)).toString('utf8');
            } catch {
              preview = String(await this.storage.readFile(uri, 'utf8'));
            }
          } else {
            preview = String(await this.storage.readFile(uri, 'utf8'));
          }
          if (file.size > PREVIEW_CHARS || preview.length > PREVIEW_CHARS) {
            lines.push(
              JSON.stringify({
                type: 'task_journal_preview_truncated',
                order,
                originalBytes: file.size,
                preview: preview.slice(0, PREVIEW_CHARS),
              }),
            );
          } else {
            const value = JSON.parse(preview);
            if (!value || typeof value !== 'object' || value.order !== order) throw new Error('invalid record');
            lines.push(JSON.stringify(value));
          }
        } catch {
          this.logger.warn(`白纸任务 ${taskId} 操作日志第 ${order} 条读取失败；日志不完整`);
          lines.push(marker('record_read_failed', { order }));
        }
      }
      const pending = this.#pending.filter(p => p.taskId === taskId).map(p => p.order);
      if (pending.length) lines.push(marker('write_pending', { orders: pending }));
      if (this.#missing.has(taskId)) lines.push(marker('write_failed_retry_buffer_full'));
      return lines.length ? `${lines.join('\n')}\n` : '';
    });
  }

  /** Retry writes that failed in this process. */
  flush(taskId?: string): Promise<boolean> {
    return this.#enqueue(async () => {
      for (const item of [...this.#pending]) {
        if (taskId && item.taskId !== taskId) continue;
        const index = await this.#index(item.taskId);
        if (index) await this.#write(item, index);
      }
      return (
        !this.#pending.some(item => !taskId || item.taskId === taskId) &&
        !(taskId ? this.#missing.has(taskId) : this.#missing.size > 0)
      );
    });
  }

  /** List retained task journals without loading event bodies. */
  list(): Promise<Array<{ taskId: string; entries: number }>> {
    return this.#enqueue(async () => {
      let dirs: Awaited<ReturnType<StorageService['list']>>['entries'];
      try {
        dirs = (await this.storage.list(ROOT)).entries;
      } catch (error) {
        if (isStorageNotFound(error)) return [];
        this.logger.warn('白纸操作日志清单读取失败');
        throw error;
      }
      const result: Array<{ taskId: string; entries: number }> = [];
      for (const dir of dirs) {
        if (!dir.isDirectory || !/^t-[a-f0-9]{8}$/.test(dir.name)) continue;
        try {
          const entries = (await this.storage.list(this.uri(dir.name))).entries;
          result.push({ taskId: dir.name, entries: entries.filter(e => !e.isDirectory && FILE.test(e.name)).length });
        } catch (error) {
          this.logger.warn(`白纸任务 ${dir.name} 操作日志清单读取失败`);
          throw error;
        }
      }
      return result.sort((a, b) => a.taskId.localeCompare(b.taskId));
    });
  }

  /** Explicit owner cleanup; never called automatically. */
  remove(taskId: string): Promise<void> {
    validTaskId(taskId);
    return this.#enqueue(async () => {
      try {
        await this.storage.delete(this.uri(taskId));
      } catch (error) {
        if (!isStorageNotFound(error)) throw error;
      }
      this.#indexes.delete(taskId);
      this.#pending = this.#pending.filter(p => p.taskId !== taskId);
      this.#missing.delete(taskId);
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #index(taskId: string): Promise<Index | undefined> {
    const cached = this.#indexes.get(taskId);
    if (cached) return cached;
    try {
      const listing = await this.storage.list(this.uri(taskId));
      const files = listing.entries
        .filter(e => !e.isDirectory)
        .map(e => FILE.exec(e.name))
        .filter(m => m !== null);
      const next = files.reduce((max, match) => Math.max(max, Number(match[1]) + 1), 1);
      const index = { next, seen: new Set(files.map(match => match[2])) };
      this.#indexes.set(taskId, index);
      return index;
    } catch (error) {
      if (isStorageNotFound(error)) {
        const index = { next: 1, seen: new Set<string>() };
        this.#indexes.set(taskId, index);
        return index;
      }
      this.logger.warn(`白纸任务 ${taskId} 操作日志目录读取失败；等待重试`);
      return undefined;
    }
  }

  async #write(item: Pending, index: Index): Promise<boolean> {
    if (index.seen.has(item.hash)) {
      this.#pending = this.#pending.filter(p => p !== item);
      return true;
    }
    if (!item.order) item.order = index.next++;
    const file = `${this.uri(item.taskId)}${String(item.order).padStart(12, '0')}-${item.hash}.json`;
    try {
      await this.storage.writeFile(
        file,
        JSON.stringify({
          receivedAt: item.receivedAt,
          order: item.order,
          ...(item.key === undefined ? {} : { key: item.key }),
          entry: item.entry,
        }),
      );
      index.seen.add(item.hash);
      this.#pending = this.#pending.filter(p => p !== item);
      return true;
    } catch {
      this.#hold(item);
      this.logger.warn(`白纸任务 ${item.taskId} 操作日志第 ${item.order} 条写入失败；日志可能有缺口，请重试`);
      return false;
    }
  }

  #hold(item: Pending): void {
    if (this.#pending.includes(item)) return;
    const bytes = this.#pending.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)), 0);
    if (bytes + Buffer.byteLength(JSON.stringify(item)) <= PENDING_BYTES) this.#pending.push(item);
    else this.#missing.add(item.taskId);
  }

  #order(name: string): number {
    return Number(FILE.exec(name)?.[1]);
  }

  async #files(taskId: string): Promise<Awaited<ReturnType<StorageService['list']>>['entries'] | string> {
    let entries: Awaited<ReturnType<StorageService['list']>>['entries'];
    try {
      entries = (await this.storage.list(this.uri(taskId))).entries;
    } catch (error) {
      if (isStorageNotFound(error)) entries = [];
      else {
        this.logger.warn(`白纸任务 ${taskId} 操作日志目录读取失败；无法确认完整性`);
        return marker('directory_read_failed');
      }
    }
    return entries.filter(e => !e.isDirectory && FILE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async #read(taskId: string, maxBytes?: number): Promise<string> {
    const listed = await this.#files(taskId);
    if (typeof listed === 'string') return `${listed}\n`;
    const files = listed;
    if (maxBytes !== undefined && files.reduce((sum, file) => sum + file.size + 1, 0) > maxBytes) {
      throw new RangeError(`Task journal exceeds ${maxBytes} byte read limit`);
    }
    const lines: string[] = [];
    let expected = 1;
    for (const file of files) {
      const order = this.#order(file.name);
      if (order > expected) lines.push(marker('missing_sequence', { from: expected, to: order - 1 }));
      expected = order + 1;
      try {
        const raw = await this.storage.readFile(`${this.uri(taskId)}${file.name}`, 'utf8');
        const value = JSON.parse(String(raw));
        if (!value || typeof value !== 'object' || value.order !== order) throw new Error('invalid record');
        lines.push(JSON.stringify(value));
      } catch {
        this.logger.warn(`白纸任务 ${taskId} 操作日志第 ${order} 条读取失败；日志不完整`);
        lines.push(marker('record_read_failed', { order }));
      }
    }
    const pending = this.#pending.filter(p => p.taskId === taskId).map(p => p.order);
    if (pending.length) lines.push(marker('write_pending', { orders: pending }));
    if (this.#missing.has(taskId)) lines.push(marker('write_failed_retry_buffer_full'));
    const result = lines.length ? `${lines.join('\n')}\n` : '';
    if (maxBytes !== undefined && Buffer.byteLength(result) > maxBytes) {
      throw new RangeError(`Task journal exceeds ${maxBytes} byte read limit`);
    }
    return result;
  }
}
