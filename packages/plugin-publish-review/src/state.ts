import {
  type ItemState,
  PUBLIC_CONTENT_TYPES,
  type PublishedItem,
  type PublishOrigin,
  publicPathProblem,
  type WorkKind,
} from '@aalis/api-publish';
import { type BoundStorage, isStorageNotFound } from '@aalis/api-storage';
import { asText, TextError, type TextRef, toSourceReplacer } from '@aalis/schema-i18n';
import { t } from './texts.js';

// 账本、审核记录与各作品条目在本插件的私有目录里；审核通过的文件在公开根里
const STATE = 'state.json';
/** 审核记录（私有目录下的相对路径） */
export const AUDIT = 'audit.jsonl';
const ITEMS = 'items';
export const PUBLIC_ROOT = 'public:';

/** 一件作品的条目目录（私有目录下的相对路径），给 path 时是其中的文件 */
export function itemPath(id: string, path?: string): string {
  return path === undefined ? `${ITEMS}/${id}` : `${ITEMS}/${id}/${path}`;
}

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
  kind: WorkKind;
  files: FileRecord[];
  hasCover: boolean;
  nominatedAt: number;
  awaitingSince?: number;
  /** 缺省是旧版的全量人工待审；fallback 不因关闭全量人工而重新排队。 */
  awaitingReason?: 'required' | 'fallback';
  outHashes?: Record<string, string>;
  /** 与审核输出一同持久化；旧记录缺少此标记时必须重新处理。 */
  outputPolicy?: 'off' | 'auto' | 'manual';
  thumbnailHash?: string;
  /** reasons 是类别值与宿主写的原因：新记录的原因可以是文字对象，旧记录是字符串 */
  review?: {
    flags: string[];
    reasons: Array<string | TextRef>;
    images: string[];
    hasRender: boolean;
    classification?: string;
  };
}
/** 撤下的一方与理由：理由是撤下方给的原话，只留作排查，页面不显示 */
export interface Withdrawal {
  by: 'origin' | 'owner' | 'integrity';
  actorKey?: string;
  reason: string;
}
export interface LedgerItem extends PublishedItem {
  state: 'published' | 'withdrawn';
  origin: PublishOrigin;
  files: Array<{ path: string; size: number; contentType: string; sha256: string }>;
  thumbnail?: { size: number; sha256: string };
  notice: 'pending' | 'delayed' | 'sent' | 'none';
  /** 展示面完成部署与内容核对后才为真，独立于通知是否送达。 */
  live?: boolean;
  /** 已完成线上核验的展示面及其核验过的公开地址；旧账本可缺省。 */
  liveSurfaces?: Record<string, string>;
  nominatedAt: number;
  withdrawn?: Withdrawal & { at: number };
}
interface ReviewState {
  version: 1;
  queue: Record<string, QueueItem>;
  ledger: Record<string, LedgerItem>;
  /** 24 小时内的提名流水；失败、拒绝、撤回也占每日配额。 */
  nominations: Array<{ source: string; at: number }>;
  /** JSON.stringify([producer, submissionKey]) -> 已持久收件；长期保存以免终态被重用。 */
  submissions: Record<string, { id: string; fingerprint: string }>;
  /** 仅保存带提交键的终态，供自动提名方可靠追踪。 */
  terminal: Record<
    string,
    { state: Extract<ItemState, 'rejected' | 'expired' | 'failed' | 'withdrawn'>; origin: PublishOrigin; title: string }
  >;
  /**
   * detail 是裁决者与理由：新记录可以是文字对象，旧记录是字符串。撤下与完整性撤下的新记录另带 withdrawn（撤下的一方与理由，
   * 页面不显示）；旧记录没有
   */
  history: Array<{ at: number; id: string; event: string; detail: string | TextRef; withdrawn?: Withdrawal }>;
  notices: Record<
    string,
    {
      id: string;
      origin: PublishOrigin;
      /** 交给她转述的正文（写给模型的原文） */
      content: string;
      /** 给人看的那句（文字对象，参数截过长度时可能退成截短的原文）；旧记录没有，显示正文 */
      text?: string | TextRef;
      title?: string;
      live: boolean;
      /** 第一次发送失败的时刻；发出去之前一直保留，用来算连续失败了多久 */
      failingSince?: number;
      /** 连续失败超过期限后放弃的时刻：不再自动重发，在审核页列出，owner 可以手动重发 */
      abandoned?: number;
      /** 她已经转述过、平台没确认收下：之后重发直接发宿主原文 */
      narrated?: boolean;
    }
  >;
}

function empty(): ReviewState {
  return {
    version: 1,
    queue: {},
    ledger: {},
    nominations: [],
    submissions: {},
    terminal: {},
    history: [],
    notices: {},
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const string = (value: unknown) => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const text = (value: unknown) => asText(value) !== undefined;
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
/** 撤下的一方与理由（账本与历史同形） */
const withdrawal = (value: Record<string, unknown>) =>
  ['origin', 'owner', 'integrity'].includes(String(value.by)) &&
  string(value.reason) &&
  (value.actorKey === undefined || string(value.actorKey));
function liveUrl(value: unknown, id: string): boolean {
  if (!string(value) || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.href === value &&
      parsed.pathname.endsWith(`/w/${id}/`)
    );
  } catch {
    return false;
  }
}
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
    value.submissions !== undefined &&
    (!record(value.submissions) ||
      Object.values(value.submissions).some(
        entry => !record(entry) || !string(entry.id) || !/^[a-z2-7]{10}$/.test(entry.id) || !digest(entry.fingerprint),
      ))
  )
    return false;
  if (
    value.terminal !== undefined &&
    (!record(value.terminal) ||
      Object.entries(value.terminal).some(
        ([id, entry]) =>
          !/^[a-z2-7]{10}$/.test(id) ||
          !record(entry) ||
          !['rejected', 'expired', 'failed', 'withdrawn'].includes(String(entry.state)) ||
          !origin(entry.origin) ||
          !string(entry.title),
      ))
  )
    return false;
  if (
    value.history !== undefined &&
    (!Array.isArray(value.history) ||
      value.history.some(
        entry =>
          !record(entry) ||
          !time(entry.at) ||
          !string(entry.id) ||
          !string(entry.event) ||
          !text(entry.detail) ||
          (entry.withdrawn !== undefined && (!record(entry.withdrawn) || !withdrawal(entry.withdrawn))),
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
          (entry.text !== undefined && !text(entry.text)) ||
          (entry.title !== undefined && !string(entry.title)) ||
          typeof entry.live !== 'boolean' ||
          (entry.failingSince !== undefined && !time(entry.failingSince)) ||
          (entry.abandoned !== undefined && !time(entry.abandoned)) ||
          (entry.narrated !== undefined && typeof entry.narrated !== 'boolean'),
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
      (entry.outputPolicy !== undefined && !['off', 'auto', 'manual'].includes(String(entry.outputPolicy))) ||
      (entry.thumbnailHash !== undefined && !digest(entry.thumbnailHash))
    )
      return false;
    if (
      entry.review !== undefined &&
      (!record(entry.review) ||
        !strings(entry.review.flags) ||
        !Array.isArray(entry.review.reasons) ||
        !entry.review.reasons.every(text) ||
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
      (entry.live !== undefined && typeof entry.live !== 'boolean') ||
      (entry.liveSurfaces !== undefined &&
        (!record(entry.liveSurfaces) ||
          Object.entries(entry.liveSurfaces).some(
            ([name, url]) => !(entry.surfaces as string[]).includes(name) || !liveUrl(url, id),
          ))) ||
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
      (!record(entry.withdrawn) || !time(entry.withdrawn.at) || !withdrawal(entry.withdrawn))
    )
      return false;
  }
  if (value.submissions !== undefined) {
    const seen = new Set<string>();
    for (const [slot, submission] of Object.entries(value.submissions)) {
      if (!record(submission) || !string(submission.id)) return false;
      let parts: unknown;
      try {
        parts = JSON.parse(slot);
      } catch {
        return false;
      }
      if (
        !Array.isArray(parts) ||
        parts.length !== 2 ||
        !parts.every(string) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parts[1]) ||
        seen.has(submission.id)
      )
        return false;
      seen.add(submission.id);
      const item =
        value.queue[submission.id] ??
        value.ledger[submission.id] ??
        (record(value.terminal) ? value.terminal[submission.id] : undefined);
      if (!record(item) || !record(item.origin) || item.origin.producer !== parts[0]) return false;
    }
  }
  return true;
}

/** 写入由 StorageService 的本地实现保证单文件原子替换；内存只在写成功后换代。 */
export class ReviewStore {
  data: ReviewState = empty();
  failure?: TextRef;
  auditFailure?: TextRef;
  readonly #listeners = new Set<() => void>();
  #queue: Promise<void> = Promise.resolve();
  /** 作品条目的总目录（完整的存储地址） */
  readonly itemRoot: string;
  constructor(readonly storage: BoundStorage) {
    this.itemRoot = storage.own.uri(ITEMS);
  }

  /** 一件作品的条目目录（完整的存储地址），给 path 时是其中的文件 */
  item(id: string, path?: string): string {
    return this.storage.own.uri(itemPath(id, path));
  }

  async load(): Promise<void> {
    try {
      const source = await this.storage.own.readFile(STATE, 'utf8');
      const parsed: unknown = JSON.parse(String(source));
      if (!valid(parsed)) throw new Error('结构不合法');
      this.data = {
        ...parsed,
        submissions: parsed.submissions ?? {},
        terminal: parsed.terminal ?? {},
        history: parsed.history ?? [],
        notices: parsed.notices ?? {},
      };
      for (const item of Object.values(this.data.queue)) if (item.state === 'checking') item.state = 'queued';
    } catch (err) {
      if (isStorageNotFound(err)) return;
      this.failure = t('ledgerUnreadable');
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
    if (this.failure) throw new TextError(this.failure);
    const entries = event ? (Array.isArray(event) ? event : [event]) : [];
    if (entries.length) next.history = [...next.history, ...entries].slice(-100);
    await this.storage.own.writeFile(STATE, JSON.stringify(next));
    this.data = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* 状态已提交，其他监听者继续 */
      }
    }
    if (entries.length) {
      try {
        let previous = '';
        try {
          previous = String(await this.storage.own.readFile(AUDIT, 'utf8'));
        } catch (err) {
          if (!isStorageNotFound(err)) throw err;
        }
        // 审核记录照日志的写法：文字对象写原文
        await this.storage.own.writeFile(
          AUDIT,
          previous + entries.map(entry => `${JSON.stringify(entry, toSourceReplacer)}\n`).join(''),
        );
        this.auditFailure = undefined;
      } catch {
        this.auditFailure = t('auditAppendFailed');
      }
    }
  }

  copy(): ReviewState {
    return structuredClone(this.data);
  }
}
