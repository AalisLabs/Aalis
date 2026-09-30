import {
  IntegrityError,
  type NominateInput,
  type NominateResult,
  type PublishedItem,
  type PublishOrigin,
  type PublishService,
  type PublishSurface,
  type PublishSurfaceInfo,
  publicWorkUrl,
  type SurfaceBinding,
  WORK_ID_PATTERN,
} from '@aalis/api-publish';
import type { StorageService } from '@aalis/api-storage';
import { checkNomination, contentType } from './checks.js';
import type { ReviewConfig } from './config.js';
import type { ReviewPipeline } from './pipeline.js';
import { decideReview } from './policy.js';
import { ITEM_ROOT, type LedgerItem, PUBLIC_ROOT, type QueueItem, type ReviewStore } from './state.js';

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const DELAY_NOTICE_MS = 30 * 60_000;
const QUOTA_RETRY_MS = 30_000;
const bytes = (value: string | Buffer) => new Uint8Array(typeof value === 'string' ? Buffer.from(value) : value);
const itemRoot = (id: string) => `${ITEM_ROOT}/${id}`;
const src = (id: string, path: string) => `${itemRoot(id)}/src/${path}`;
const out = (id: string, path: string) => `${itemRoot(id)}/out/${path}`;
const publicFile = (id: string, path: string) => `${PUBLIC_ROOT}/${id}/files/${path}`;
const publicThumb = (id: string) => `${PUBLIC_ROOT}/${id}/thumb.png`;
const sourceKey = (origin: PublishOrigin) => origin.notify?.sessionId ?? origin.producer;
const SUBMISSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const submissionSlot = (producer: string, key: string) => JSON.stringify([producer, key]);
const outputPolicy = (config: ReviewConfig): NonNullable<QueueItem['outputPolicy']> =>
  !config.reviewEnabled ? 'off' : config.manualReview ? 'manual' : 'auto';
const allSurfacesLive = (item: LedgerItem): boolean =>
  item.liveSurfaces
    ? item.surfaces.every(name => Object.hasOwn(item.liveSurfaces!, name))
    : item.surfaces.length === 1 && item.live === true;

async function hash(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function nominationFingerprint(input: NominateInput, oldCredit?: string): Promise<string> {
  const files = await Promise.all(input.files.map(async file => [file.path, await hash(file.bytes)]));
  const cover = input.cover ? await hash(input.cover) : null;
  return hash(
    Buffer.from(
      JSON.stringify({
        origin: {
          producer: input.origin.producer,
          ref: input.origin.ref,
          label: input.origin.label,
          notify: input.origin.notify
            ? {
                sessionId: input.origin.notify.sessionId,
                platform: input.origin.notify.platform,
              }
            : null,
          actorKey: input.origin.actorKey ?? null,
        },
        group: input.group,
        groupLabel: input.groupLabel,
        surfaces: input.surfaces,
        title: input.title,
        summary: input.summary,
        ...(oldCredit === undefined ? {} : { credit: oldCredit }),
        files,
        cover,
      }),
    ),
  );
}

function newId(): string {
  const random = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(random, value => alphabet[value & 31]).join('');
}

interface ReviewServiceDeps {
  storage: StorageService;
  store: ReviewStore;
  config: ReviewConfig;
  pipeline: ReviewPipeline;
  now?: () => number;
  signal?: AbortSignal;
  /** 只接受宿主生成的固定文案，不传模型文本、标题与文件路径。 */
  notice?: (origin: PublishOrigin, content: string, id: string, title?: string) => unknown;
}

/** 审核账本与发布边界：流水经构造注入，宿主负责调度与能力装配。 */
export class PublishReviewService implements PublishService {
  readonly #d: ReviewServiceDeps;
  readonly #surfaces = new Map<string, { surface: PublishSurface; token: symbol }>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #processing?: Promise<void>;
  #closed = false;
  #notifying?: Promise<void>;
  #noticeAgain = false;
  get #stopped(): boolean {
    return this.#closed || !!this.#d.signal?.aborted;
  }

  constructor(deps: ReviewServiceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  async nominate(input: NominateInput): Promise<NominateResult> {
    const { store, storage, config } = this.#d;
    return store.exclusive(async () => {
      if (this.#stopped) return { refused: '作品审核已停止', retryAfterMs: QUOTA_RETRY_MS };
      if (store.failure) return { refused: store.failure };
      // 验证与异步落盘必须读同一份字节；调用方仍可持有并修改原 Uint8Array。
      const snapshot: NominateInput = {
        ...input,
        origin: structuredClone(input.origin),
        surfaces: [...input.surfaces],
        files: input.files.map(file => ({ path: file.path, bytes: new Uint8Array(file.bytes) })),
        cover: input.cover ? new Uint8Array(input.cover) : undefined,
      };
      if (snapshot.submissionKey !== undefined && !SUBMISSION_KEY.test(snapshot.submissionKey))
        return { refused: '提交键不合规' };
      const slot =
        snapshot.submissionKey === undefined
          ? undefined
          : submissionSlot(snapshot.origin.producer, snapshot.submissionKey);
      const fingerprint = slot === undefined ? undefined : await nominationFingerprint(snapshot);
      if (slot !== undefined) {
        const previous = store.data.submissions[slot];
        if (previous) {
          if (previous.fingerprint === fingerprint) return { id: previous.id };
          // 旧账本的指纹包含署名；只从旧记录读取一次以识别相同投稿。
          const oldItem = store.data.queue[previous.id] ?? store.data.ledger[previous.id];
          const oldCredit = oldItem && 'credit' in oldItem ? oldItem.credit : undefined;
          if (
            typeof oldCredit === 'string' &&
            previous.fingerprint === (await nominationFingerprint(snapshot, oldCredit))
          )
            return { id: previous.id };
          return { refused: '提交键对应的作品内容已变更' };
        }
      }
      const checked = checkNomination(snapshot, config, new Set(this.#surfaces.keys()));
      if ('refused' in checked) return checked;
      const queued = Object.values(store.data.queue);
      const originKey = sourceKey(snapshot.origin);
      if (queued.length >= config.limits.maxPending)
        return { refused: '待审总数已达上限', retryAfterMs: QUOTA_RETRY_MS };
      if (queued.filter(item => sourceKey(item.origin) === originKey).length >= config.limits.maxPendingPerOrigin)
        return { refused: '这个来源待审作品已达上限', retryAfterMs: QUOTA_RETRY_MS };
      const now = this.#now();
      const recent = store.data.nominations.filter(entry => entry.source === originKey && entry.at >= now - DAY);
      if (recent.length >= config.limits.maxDailyPerOrigin) {
        const expiry = [...recent].sort((a, b) => a.at - b.at)[recent.length - config.limits.maxDailyPerOrigin].at;
        return { refused: '这个来源今天提名数已达上限', retryAfterMs: Math.max(1, expiry + DAY - now + 1) };
      }
      let id = newId();
      while (store.data.queue[id] || store.data.ledger[id] || store.data.terminal[id]) id = newId();
      const item: QueueItem = {
        id,
        state: 'queued',
        origin: snapshot.origin,
        group: snapshot.group,
        groupLabel: snapshot.groupLabel,
        surfaces: snapshot.surfaces,
        title: checked.title,
        summary: checked.summary,
        kind: checked.kind,
        files: snapshot.files.map(file => ({
          path: file.path,
          size: file.bytes.length,
          contentType: contentType(file.path),
        })),
        hasCover: !!snapshot.cover,
        nominatedAt: now,
      };
      try {
        for (const file of snapshot.files) await storage.writeFile(src(id, file.path), Buffer.from(file.bytes));
        if (snapshot.cover) await storage.writeFile(src(id, '_cover'), Buffer.from(snapshot.cover));
        const next = store.copy();
        next.queue[id] = item;
        if (slot !== undefined && fingerprint !== undefined) next.submissions[slot] = { id, fingerprint };
        next.nominations = next.nominations.filter(entry => entry.at >= now - DAY);
        next.nominations.push({ source: originKey, at: item.nominatedAt });
        await store.save(next, this.#event(id, 'nominated'));
      } catch {
        await storage.delete(itemRoot(id)).catch(() => {});
        return { refused: '提名快照无法保存', retryAfterMs: QUOTA_RETRY_MS };
      }
      return { id };
    });
  }

  get(id: string) {
    if (!WORK_ID_PATTERN.test(id)) return undefined;
    const { queue, ledger, terminal } = this.#d.store.data;
    const item = queue[id] ?? ledger[id] ?? terminal[id];
    return item
      ? {
          state: item.state,
          origin: structuredClone(item.origin),
          title: item.title,
          live:
            ledger[id]?.state === 'published'
              ? allSurfacesLive(ledger[id]) && this.#currentSurfacesMatch(ledger[id])
              : undefined,
        }
      : undefined;
  }

  listPublished(surface: string): PublishedItem[] {
    if (this.#d.store.failure) return [];
    return Object.values(this.#d.store.data.ledger)
      .filter(item => item.state === 'published' && item.surfaces.includes(surface))
      .map(item => ({
        id: item.id,
        group: item.group,
        groupLabel: item.groupLabel,
        surfaces: [...item.surfaces],
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        publishedAt: item.publishedAt,
        files: item.files.map(({ path, size, contentType }) => ({ path, size, contentType })),
        hasThumbnail: item.hasThumbnail,
      }));
  }

  listSurfaces(): PublishSurfaceInfo[] {
    return [...this.#surfaces.values()].map(({ surface }) => {
      const info = { name: surface.name, label: surface.label, baseUrl: surface.baseUrl };
      try {
        const health = surface.health();
        return health.ok ? { ...info, available: true } : { ...info, available: false, reason: health.reason };
      } catch {
        return { ...info, available: false, reason: '发布目标状态暂不可核对' };
      }
    });
  }

  processNext(): Promise<void> {
    if (this.#processing) return this.#processing;
    const flight = this.#processNext();
    this.#processing = flight;
    void flight
      .finally(() => {
        if (this.#processing === flight) this.#processing = undefined;
      })
      .catch(() => {});
    return flight;
  }

  async #processNext(): Promise<void> {
    if (this.#stopped) return;
    const { store, storage, pipeline } = this.#d;
    const item = await store.exclusive(async () => {
      if (this.#stopped || store.failure) return undefined;
      const first = Object.values(store.data.queue).find(
        value => value.state === 'queued' || value.state === 'checking',
      );
      if (!first) return undefined;
      const next = store.copy();
      next.queue[first.id].state = 'checking';
      if (next.queue[first.id].outHashes && next.queue[first.id].outputPolicy !== outputPolicy(this.#d.config)) {
        delete next.queue[first.id].outHashes;
        delete next.queue[first.id].thumbnailHash;
        delete next.queue[first.id].review;
        delete next.queue[first.id].outputPolicy;
      }
      await store.save(next);
      return next.queue[first.id];
    });
    if (!item || this.#stopped) return;
    if (item.outHashes) {
      await this.#publish(item.id);
      return;
    }
    let result: Awaited<ReturnType<ReviewPipeline['run']>>;
    try {
      const files = await Promise.all(
        item.files.map(async file => ({
          path: file.path,
          bytes: bytes(await storage.readFile(src(item.id, file.path))),
        })),
      );
      const cover = item.hasCover ? bytes(await storage.readFile(src(item.id, '_cover'))) : undefined;
      if (this.#stopped) return;
      result = await pipeline.run({
        id: item.id,
        title: item.title,
        summary: item.summary,
        files,
        cover,
        signal: this.#d.signal ?? new AbortController().signal,
      });
    } catch {
      if (this.#stopped) return;
      await this.#finishWithoutPublish(item.id, '审核步骤不可用');
      return;
    }
    if (this.#stopped || this.#d.store.data.queue[item.id]?.state !== 'checking') return;
    const decision = decideReview(this.#d.config, result.verdict);
    if (decision.state === 'failed') {
      await this.#finishWithoutPublish(item.id, decision.reasons[0] ?? '审核步骤不可用');
      return;
    }
    // 出来的字节只接受原提名的路径集合；不能让步骤替身或未来模型增删未审文件。
    const expectedPaths = new Set(item.files.map(file => file.path));
    const actualPaths = new Set(result.files.map(file => file.path));
    const outputCheck = checkNomination(
      {
        origin: item.origin,
        group: item.group,
        groupLabel: item.groupLabel,
        surfaces: item.surfaces,
        title: item.title,
        summary: item.summary,
        files: result.files,
      },
      this.#d.config,
      new Set(item.surfaces),
    );
    if (
      result.files.length !== item.files.length ||
      actualPaths.size !== expectedPaths.size ||
      [...actualPaths].some(path => !expectedPaths.has(path)) ||
      'refused' in outputCheck
    ) {
      await this.#finishWithoutPublish(item.id, '审核输出文件集合不符');
      return;
    }
    const hashes: Record<string, string> = {};
    const review = result.evidence;
    if (
      review &&
      (review.images.length > 12 ||
        new Set(review.images.map(image => image.name)).size !== review.images.length ||
        review.images.some(
          image =>
            !/^[a-z0-9-]+\.png$/.test(image.name) ||
            image.name === 'render.png' ||
            image.bytes.length > 25 * 1024 * 1024,
        ))
    ) {
      await this.#finishWithoutPublish(item.id, '审核图像集合不符');
      return;
    }
    try {
      if (review) {
        for (const image of review.images)
          await storage.writeFile(`${itemRoot(item.id)}/review/${image.name}`, Buffer.from(image.bytes));
        if (review.render)
          await storage.writeFile(`${itemRoot(item.id)}/review/render.png`, Buffer.from(review.render));
      }
      for (const file of result.files) {
        hashes[file.path] = await hash(file.bytes);
        await storage.writeFile(out(item.id, file.path), Buffer.from(file.bytes));
      }
      if (result.thumbnail) {
        hashes['_thumb.png'] = await hash(result.thumbnail);
        await storage.writeFile(out(item.id, '_thumb.png'), Buffer.from(result.thumbnail));
      }
    } catch {
      await this.#finishWithoutPublish(item.id, '审核输出无法保存');
      return;
    }
    const accepted = await store.exclusive(async () => {
      if (this.#stopped || store.data.queue[item.id]?.state !== 'checking') return false;
      const next = store.copy();
      next.queue[item.id].outHashes = hashes;
      next.queue[item.id].outputPolicy = outputPolicy(this.#d.config);
      next.queue[item.id].thumbnailHash = hashes['_thumb.png'];
      next.queue[item.id].review = {
        flags: [...(review?.flags ?? [])],
        reasons: [...new Set([...(review?.reasons ?? []), ...result.verdict.reasons])],
        images: review?.images.map(image => image.name) ?? [],
        hasRender: !!review?.render,
        classification: review?.classification,
      };
      if (decision.state === 'awaiting-owner') {
        next.queue[item.id].state = 'awaiting-owner';
        next.queue[item.id].awaitingSince = this.#now();
        next.queue[item.id].awaitingReason = result.verdict.verdict === 'allow' ? 'required' : 'fallback';
      }
      if (decision.state === 'awaiting-owner')
        this.#queueNotice(
          next,
          item.origin,
          `作品要等 owner 审核，最长 ${this.#d.config.ownerTimeoutHours} 小时，有结果会再通知`,
          item.id,
          item.title,
        );
      await store.save(next, this.#event(item.id, decision.state === 'awaiting-owner' ? 'awaiting-owner' : 'approved'));
      return true;
    });
    if (!accepted) return;
    if (decision.state === 'awaiting-owner') return;
    await this.#publish(item.id);
  }

  async approve(id: string): Promise<boolean> {
    return this.#publish(id, 'awaiting-owner');
  }

  async reject(id: string): Promise<boolean> {
    const { store, storage } = this.#d;
    if (!WORK_ID_PATTERN.test(id) || this.#stopped) return false;
    return store.exclusive(async () => {
      const item = store.data.queue[id];
      if (this.#stopped || store.failure || item?.state !== 'awaiting-owner') return false;
      const next = store.copy();
      delete next.queue[id];
      this.#rememberTerminal(next, item, 'rejected');
      this.#queueNotice(next, item.origin, '作品未获批准，这次不发布', id, item.title);
      await store.save(next, this.#event(id, 'rejected', '人工拒绝'));
      await storage.delete(itemRoot(id)).catch(() => {});
      return true;
    });
  }

  onQueueChange(listener: () => void): () => void {
    return this.#d.store.onChange(listener);
  }

  /** 启动后及定时调用：重启清理、人工审核超时、上线延迟提醒。 */
  async reconcile(): Promise<void> {
    const { store, storage } = this.#d;
    await store.exclusive(async () => {
      if (this.#stopped || store.failure) return;
      const next = store.copy();
      const expired: QueueItem[] = [];
      let requeued = false;
      const duplicateIds: string[] = [];
      const delayed: LedgerItem[] = [];
      for (const [id, item] of Object.entries(next.queue)) {
        if (
          item.state === 'awaiting-owner' &&
          (!this.#d.config.reviewEnabled || (!this.#d.config.manualReview && item.awaitingReason !== 'fallback'))
        ) {
          item.state = 'queued';
          delete item.awaitingSince;
          delete item.awaitingReason;
          delete item.outHashes;
          delete item.outputPolicy;
          delete item.thumbnailHash;
          delete item.review;
          this.#clearNotices(next, id);
          requeued = true;
        }
        if (
          next.ledger[id] ||
          (item.state === 'awaiting-owner' &&
            item.awaitingSince !== undefined &&
            item.awaitingSince + this.#d.config.ownerTimeoutHours * HOUR <= this.#now())
        ) {
          if (next.ledger[id]) duplicateIds.push(id);
          else {
            expired.push(item);
            this.#rememberTerminal(next, item, 'expired');
          }
          delete next.queue[id];
        }
      }
      for (const item of Object.values(next.ledger)) {
        if (
          item.state === 'published' &&
          item.notice === 'pending' &&
          !next.notices[`${item.id}:live`] &&
          item.publishedAt + DELAY_NOTICE_MS <= this.#now()
        ) {
          item.notice = 'delayed';
          delayed.push(item);
        }
      }
      for (const item of expired)
        this.#queueNotice(
          next,
          item.origin,
          `作品等 owner 审核超过 ${this.#d.config.ownerTimeoutHours} 小时，这次不发布，需要的话可以重新提名`,
          item.id,
          item.title,
        );
      for (const item of delayed)
        this.#queueNotice(
          next,
          item.origin,
          '作品已获准发布，但作品站暂时没能上线，owner 会处理；上线后会再通知',
          item.id,
          item.title,
        );
      if (
        requeued ||
        expired.length ||
        delayed.length ||
        Object.keys(next.queue).length !== Object.keys(store.data.queue).length
      )
        await store.save(next, [
          ...expired.map(item => this.#event(item.id, 'expired')),
          ...delayed.map(item => this.#event(item.id, 'notice-delayed')),
        ]);
      for (const item of expired) await storage.delete(itemRoot(item.id)).catch(() => {});
      for (const id of duplicateIds) await storage.delete(itemRoot(id)).catch(() => {});
      for (const root of [PUBLIC_ROOT, ITEM_ROOT]) {
        try {
          const listed = await storage.list(`${root}/`);
          for (const entry of listed.entries) {
            if (!entry.isDirectory || !WORK_ID_PATTERN.test(entry.name)) continue;
            const keep =
              root === PUBLIC_ROOT
                ? store.data.ledger[entry.name]?.state === 'published'
                : !!store.data.queue[entry.name];
            if (!keep) await storage.delete(entry.uri).catch(() => {});
          }
        } catch {
          /* 空目录或暂不可列；下次重试，不影响有效账本。 */
        }
      }
    });
  }

  async #publish(id: string, expectedState: 'checking' | 'awaiting-owner' = 'checking'): Promise<boolean> {
    if (!WORK_ID_PATTERN.test(id)) return false;
    const { store, storage } = this.#d;
    return store.exclusive(async () => {
      const item = store.data.queue[id];
      if (store.failure || this.#stopped || !item || item.state !== expectedState || !item.outHashes) return false;
      if (item.state === 'checking' && item.outputPolicy !== outputPolicy(this.#d.config)) return false;
      if (
        item.state === 'awaiting-owner' &&
        (!this.#d.config.reviewEnabled ||
          (!this.#d.config.manualReview && item.awaitingReason !== 'fallback') ||
          item.awaitingSince === undefined ||
          item.awaitingSince + this.#d.config.ownerTimeoutHours * HOUR <= this.#now())
      )
        return false;
      const records: LedgerItem['files'] = [];
      let thumbnail: LedgerItem['thumbnail'];
      try {
        for (const file of item.files) {
          const value = bytes(await storage.readFile(out(id, file.path)));
          const digest = await hash(value);
          if (digest !== item.outHashes[file.path]) throw new IntegrityError('审核后文件被改动');
          await storage.writeFile(publicFile(id, file.path), Buffer.from(value));
          if ((await hash(bytes(await storage.readFile(publicFile(id, file.path))))) !== digest)
            throw new IntegrityError('公开根文件写入不一致');
          records.push({ ...file, size: value.length, sha256: digest });
        }
        if (item.thumbnailHash) {
          const value = bytes(await storage.readFile(out(id, '_thumb.png')));
          if ((await hash(value)) !== item.thumbnailHash) throw new IntegrityError('审核后缩略图被改动');
          await storage.writeFile(publicThumb(id), Buffer.from(value));
          if ((await hash(bytes(await storage.readFile(publicThumb(id))))) !== item.thumbnailHash)
            throw new IntegrityError('公开根缩略图写入不一致');
          thumbnail = { size: value.length, sha256: item.thumbnailHash };
        }
      } catch {
        if (this.#stopped) return false;
        const next = store.copy();
        delete next.queue[id];
        this.#rememberTerminal(next, item, 'failed');
        this.#queueNotice(next, item.origin, '作品暂时没法审核（文件完整性校验失败），这次不发布', id, item.title);
        await store.save(next, this.#event(id, 'integrity-failed'));
        await storage.delete(`${PUBLIC_ROOT}/${id}`).catch(() => {});
        await storage.delete(itemRoot(id)).catch(() => {});
        return false;
      }
      const next = store.copy();
      delete next.queue[id];
      this.#clearNotices(next, id);
      next.ledger[id] = {
        ...item,
        state: 'published',
        files: records,
        publishedAt: this.#now(),
        hasThumbnail: !!thumbnail,
        thumbnail,
        notice: item.origin.notify ? 'pending' : 'none',
        liveSurfaces: {},
      };
      // 账本写失败不是文件完整性问题；保留 checking/outHashes 和公开根，等重试或重启对账。
      if (this.#stopped) return false;
      await store.save(
        next,
        this.#event(
          id,
          'published',
          item.state === 'awaiting-owner'
            ? '人工批准'
            : this.#d.config.reviewEnabled
              ? '自动审核通过'
              : '内容审核关闭，文件校验通过',
        ),
      );
      await storage.delete(itemRoot(id)).catch(() => {});
      this.#changed();
      return true;
    });
  }

  async #finishWithoutPublish(id: string, reason: string): Promise<void> {
    const { store, storage } = this.#d;
    await store.exclusive(async () => {
      const item = store.data.queue[id];
      if (this.#stopped || !item || item.state !== 'checking') return;
      const next = store.copy();
      delete next.queue[id];
      this.#rememberTerminal(next, item, 'failed');
      const message = '作品暂时没法审核（审核步骤不可用），这次不发布';
      this.#queueNotice(next, item.origin, message, id, item.title);
      await store.save(next, this.#event(id, 'failed', reason));
      await storage.delete(itemRoot(id)).catch(() => {});
    });
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    if (!WORK_ID_PATTERN.test(id)) throw new Error('作品文件不存在');
    const item = this.#d.store.data.ledger[id];
    const record = item?.state === 'published' ? item.files.find(file => file.path === path) : undefined;
    if (!record) throw new Error('作品文件不存在');
    try {
      const value = bytes(await this.#d.storage.readFile(publicFile(id, path)));
      if ((await hash(value)) === record.sha256) return value;
    } catch {
      /* 读不到也按完整性异常撤下 */
    }
    await this.withdraw(id, { kind: 'integrity' }, '公开根完整性核对失败');
    throw new IntegrityError('公开根完整性核对失败');
  }

  async readThumbnail(id: string): Promise<Uint8Array> {
    if (!WORK_ID_PATTERN.test(id)) throw new Error('缩略图不存在');
    const item = this.#d.store.data.ledger[id];
    if (item?.state !== 'published' || !item.thumbnail) throw new Error('缩略图不存在');
    try {
      const value = bytes(await this.#d.storage.readFile(publicThumb(id)));
      if ((await hash(value)) === item.thumbnail.sha256) return value;
    } catch {
      /* 同上 */
    }
    await this.withdraw(id, { kind: 'integrity' }, '公开根缩略图完整性核对失败');
    throw new IntegrityError('缩略图完整性核对失败');
  }

  async withdraw(
    id: string,
    by: { kind: 'origin' | 'owner' | 'integrity'; actorKey?: string },
    reason: string,
  ): Promise<{ ok: true; degraded?: string } | { refused: string }> {
    if (!WORK_ID_PATTERN.test(id)) return { refused: '作品编号不合法' };
    const { store, storage } = this.#d;
    return store.exclusive(async () => {
      if (this.#stopped) return { refused: '作品审核已停止' };
      if (store.failure) return { refused: store.failure };
      const queued = store.data.queue[id];
      const published = store.data.ledger[id];
      if (!queued && !published) return { refused: '作品不存在' };
      if (published?.state === 'withdrawn') return { ok: true };
      const next = store.copy();
      if (queued) {
        delete next.queue[id];
        this.#rememberTerminal(next, queued, 'withdrawn');
      }
      if (published) {
        next.ledger[id].state = 'withdrawn';
        next.ledger[id].live = false;
        next.ledger[id].liveSurfaces = {};
        next.ledger[id].withdrawn = { at: this.#now(), by: by.kind, actorKey: by.actorKey, reason };
      }
      this.#clearNotices(next, id);
      await store.save(
        next,
        this.#event(
          id,
          by.kind === 'integrity' ? 'integrity-failed' : 'withdrawn',
          JSON.stringify({ by: by.kind, actorKey: by.actorKey, reason }),
        ),
      );
      await storage.delete(queued ? itemRoot(id) : `${PUBLIC_ROOT}/${id}`).catch(() => {});
      if (published) this.#changed();
      let degraded: string | undefined;
      for (const name of published?.surfaces ?? []) {
        try {
          const health = this.#surfaces.get(name)?.surface.health();
          if (health?.ok === false) {
            degraded = health.reason;
            break;
          }
        } catch {
          degraded = '展示面状态暂不可核对';
          break;
        }
      }
      return degraded ? { ok: true, degraded } : { ok: true };
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  attachSurface(surface: PublishSurface): SurfaceBinding {
    if (surface.baseUrl !== undefined) publicWorkUrl(surface.baseUrl, 'aaaaaaaaaa');
    // 固定登记时的地址范围；调用方修改原对象不能把已登记目标悄悄改指其他域名。
    const source = surface;
    surface = {
      name: source.name,
      label: source.label,
      baseUrl: source.baseUrl,
      urlFor: id => source.urlFor(id),
      health: () => source.health(),
    };
    const token = Symbol(surface.name);
    this.#surfaces.set(surface.name, { surface, token });
    if (Object.keys(this.#d.store.data.notices).length) void this.flushNotices().catch(() => {});
    return {
      live: ids => {
        void this.#live(surface, token, ids).catch(() => {});
      },
      detach: () => {
        if (this.#surfaces.get(surface.name)?.token === token) this.#surfaces.delete(surface.name);
      },
    };
  }

  #verifiedAddress(surface: PublishSurface, id: string): string | undefined {
    try {
      const address = surface.urlFor(id);
      if (Array.from(address).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return;
      const parsed = new URL(address);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        (surface.baseUrl !== undefined
          ? address !== publicWorkUrl(surface.baseUrl, id)
          : parsed.pathname !== `/w/${id}/`)
      )
        return;
      return address;
    } catch {
      return;
    }
  }

  #currentSurfacesMatch(item: LedgerItem): boolean {
    if (!item.liveSurfaces) return item.surfaces.length === 1;
    return item.surfaces.every(name => {
      const surface = this.#surfaces.get(name)?.surface;
      // 单目标旧回执在重启、展示面尚未重挂时仍可供提名方查询。
      if (!surface) return item.surfaces.length === 1;
      return this.#verifiedAddress(surface, item.id) === item.liveSurfaces?.[name];
    });
  }

  async #live(surface: PublishSurface, token: symbol, ids: readonly string[]): Promise<void> {
    const { store } = this.#d;
    for (const id of ids)
      await store.exclusive(async () => {
        if (!WORK_ID_PATTERN.test(id)) return;
        if (this.#stopped || store.failure || this.#surfaces.get(surface.name)?.token !== token) return;
        const item = store.data.ledger[id];
        if (item?.state !== 'published' || !item.surfaces.includes(surface.name)) return;
        if (!item.liveSurfaces && allSurfacesLive(item)) return;
        const address = this.#verifiedAddress(surface, id);
        if (!address) return;
        const confirmed: Record<string, string> = Object.assign(Object.create(null), item.liveSurfaces);
        let invalidated = false;
        for (const name of item.surfaces) {
          if (!Object.hasOwn(confirmed, name)) continue;
          const current = this.#surfaces.get(name)?.surface;
          if (current && this.#verifiedAddress(current, id) !== confirmed[name]) {
            delete confirmed[name];
            invalidated = true;
          }
        }
        const same = Object.hasOwn(confirmed, surface.name) && confirmed[surface.name] === address;
        confirmed[surface.name] = address;
        const next = store.copy();
        const previousNotices = Object.entries(store.data.notices).filter(([, notice]) => notice.id === id);
        next.ledger[id].liveSurfaces = confirmed;
        const completed = allSurfacesLive(next.ledger[id]) && this.#currentSurfacesMatch(next.ledger[id]);
        if (same && !invalidated && completed === item.live) return;
        next.ledger[id].live = completed;
        if (completed) {
          const addresses = item.surfaces.map(name => next.ledger[id].liveSurfaces![name]);
          if (item.origin.notify) next.ledger[id].notice = 'pending';
          this.#queueNotice(next, item.origin, `作品已上线：${addresses.join('、')}`, id, item.title, true);
        } else if (invalidated) {
          delete next.notices[`${id}:live`];
        }
        await store.save(next, this.#event(id, 'live'));
        if (this.#stopped || this.#surfaces.get(surface.name)?.token !== token) {
          const restored = store.copy();
          this.#clearNotices(restored, id);
          for (const [key, notice] of previousNotices) restored.notices[key] = notice;
          restored.ledger[id].live = item.live;
          restored.ledger[id].liveSurfaces = item.liveSurfaces;
          restored.ledger[id].notice = item.notice;
          await store.save(restored);
          return;
        }
      });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#processing?.catch(() => {});
    await this.#notifying?.catch(() => {});
    await this.#d.store.exclusive(async () => {});
  }

  #event(id: string, event: string, detail = '') {
    return { at: this.#now(), id, event, detail };
  }

  #rememberTerminal(
    next: ReviewStore['data'],
    item: QueueItem,
    state: 'rejected' | 'expired' | 'failed' | 'withdrawn',
  ): void {
    if (!Object.values(next.submissions).some(entry => entry.id === item.id)) return;
    next.terminal[item.id] = { state, origin: structuredClone(item.origin), title: item.title };
  }

  #clearNotices(next: ReviewStore['data'], id: string): void {
    for (const [key, notice] of Object.entries(next.notices)) if (notice.id === id) delete next.notices[key];
  }

  #queueNotice(
    next: ReviewStore['data'],
    origin: PublishOrigin,
    content: string,
    id: string,
    title?: string,
    live = false,
  ): void {
    if (!origin.notify) return;
    this.#clearNotices(next, id);
    const key = live ? `${id}:live` : crypto.randomUUID();
    next.notices[key] = { id, origin: structuredClone(origin), content, ...(title ? { title } : {}), live };
    // 入队与业务状态在同一次 save 内提交。此处只排调度，发送始终在锁外。
    void this.flushNotices().catch(() => {});
  }

  flushNotices(): Promise<void> {
    if (this.#notifying) {
      this.#noticeAgain = true;
      return this.#notifying;
    }
    const flight = this.#flushNotices();
    this.#notifying = flight;
    void flight
      .finally(() => {
        if (this.#notifying === flight) this.#notifying = undefined;
        if (this.#noticeAgain) {
          this.#noticeAgain = false;
          if (!this.#stopped) void this.flushNotices().catch(() => {});
        }
      })
      .catch(() => {});
    return flight;
  }

  async #flushNotices(): Promise<void> {
    const { store, notice } = this.#d;
    if (!notice) return;
    while (!this.#stopped) {
      const entry = await store.exclusive(async () =>
        this.#stopped || store.failure
          ? undefined
          : Object.entries(store.data.notices).find(([, notice]) => {
              if (!notice.live) return true;
              const ledger = store.data.ledger[notice.id];
              return ledger?.state === 'published' && allSurfacesLive(ledger) && this.#currentSurfacesMatch(ledger);
            }),
      );
      if (!entry || this.#stopped) return;
      const [key, item] = entry;
      try {
        await notice(item.origin, item.content, item.id, item.title);
      } catch {
        return;
      }
      // 通知实现确认已进入出站总线后才记 sent；这不是平台送达回执。
      // 出站后落盘失败仍可重发，不能承诺跨进程 exactly-once。
      await store.exclusive(async () => {
        if (store.data.notices[key]?.content !== item.content) return;
        const next = store.copy();
        delete next.notices[key];
        if (item.live && next.ledger[item.id]?.state === 'published') next.ledger[item.id].notice = 'sent';
        await store.save(next);
      });
    }
  }
  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* 其他订阅者继续接收 */
      }
    }
  }
}
