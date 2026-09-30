import { type PublishFile, type PublishService, type PublishSurfaceInfo, publicPathProblem } from '@aalis/api-publish';
import type { StorageService } from '@aalis/api-storage';
import type { Logger, ServiceRef } from '@aalis/core';
import { artifactUri } from './artifacts.js';
import { type PaperConfig, specOf } from './config.js';
import type { LedgerStore, TaskRecord } from './ledger.js';
import { actorKey, paperLabel } from './rooms.js';
import type { TaskJournal } from './task-journal.js';
import { automaticPublicationArtifacts } from './works.js';

type Publication = NonNullable<TaskRecord['publication']>;
const RETRY_MS = 30_000;

interface PaperPublicationDeps {
  journal?: TaskJournal;
  ledger: LedgerStore;
  cfg: PaperConfig;
  storage: StorageService;
  publish: ServiceRef<PublishService>;
  producer: string;
  signal: AbortSignal;
  logger: Logger;
  now?: () => number;
  onChange?: () => void;
}

/** 只按账本中的明确意图投稿；串行扫描，关闭时等待在途操作。 */
export class PaperPublication {
  readonly #d: PaperPublicationDeps;
  #open = false;
  #closed = false;
  #running?: Promise<void>;
  #again = false;
  #timer?: ReturnType<typeof setTimeout>;
  #unfollow?: () => void;

  constructor(deps: PaperPublicationDeps) {
    this.#d = deps;
  }

  open(): void {
    if (this.#closed || this.#open) return;
    this.#open = true;
    this.#unfollow = this.#d.publish.follow(service => {
      const unsubscribe = service.onChange(() => this.kick());
      this.kick();
      return unsubscribe;
    });
    this.kick();
  }

  kick(): void {
    if (!this.#open || this.#closed || this.#d.signal.aborted) return;
    this.#again = true;
    if (this.#running) return;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#again && !this.#closed) queueMicrotask(() => this.kick());
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#unfollow?.();
    await this.#running;
  }

  async #drain(): Promise<void> {
    while (this.#again && !this.#closed && !this.#d.signal.aborted) {
      this.#again = false;
      try {
        await this.#sweep();
      } catch (err) {
        this.#d.logger.error(`白纸作品提交扫描失败: ${String(err)}`);
        this.#arm(RETRY_MS);
      }
    }
  }

  #arm(delay: number): void {
    if (this.#closed || this.#d.signal.aborted) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.kick();
      },
      Math.max(1, delay),
    );
    this.#timer.unref?.();
  }

  async #update(taskId: string, expected: Publication, patch: Partial<Publication>): Promise<boolean> {
    const changed = await this.#d.ledger.exclusive(async () => {
      const task = this.#d.ledger.data.tasks[taskId];
      if (!task || task.publication !== expected) return false;
      const previous = task.publication;
      task.publication = { ...previous, ...patch };
      try {
        await this.#d.ledger.save();
      } catch (err) {
        task.publication = previous;
        throw err;
      }
      return true;
    });
    if (changed) {
      if (patch.state && patch.state !== expected.state)
        await this.#d.journal?.record(taskId, undefined, {
          type: 'publication',
          target: expected.target,
          ...patch,
        });
      this.#d.onChange?.();
    }
    return changed;
  }

  async #sweep(): Promise<void> {
    if (this.#d.ledger.failure) return;
    let nearest = Number.POSITIVE_INFINITY;
    for (const task of Object.values(this.#d.ledger.data.tasks)) {
      if (this.#closed || this.#d.signal.aborted) return;
      const pub = task.publication;
      if (!pub || pub.state === 'live' || pub.state === 'failed') continue;
      if ((task.state === 'failed' || task.state === 'cancelled') && pub.state === 'pending') {
        await this.#update(task.id, pub, {
          state: 'failed',
          reason: task.state === 'cancelled' ? '创作任务已取消，未提交发布' : '创作任务失败，未提交发布',
          nextAttemptAt: undefined,
        });
        continue;
      }
      if (task.state !== 'done' || task.artifactsCleared) continue;
      if (pub.state === 'pending' && (pub.nextAttemptAt ?? 0) > this.#now()) {
        nearest = Math.min(nearest, pub.nextAttemptAt!);
        continue;
      }
      try {
        await this.#advance(task, pub);
      } catch (err) {
        this.#d.logger.warn(`白纸作品 ${task.id} 提交/跟踪暂时失败: ${String(err)}`);
        nearest = Math.min(nearest, this.#now() + RETRY_MS);
      }
      if (task.publication?.state === 'pending' && (task.publication.nextAttemptAt ?? 0) > this.#now()) {
        nearest = Math.min(nearest, task.publication.nextAttemptAt!);
      }
      if (task.publication?.state === 'submitted') nearest = Math.min(nearest, this.#now() + RETRY_MS);
    }
    if (Number.isFinite(nearest)) this.#arm(nearest - this.#now());
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }
  #valid(task: TaskRecord, pub: Publication, service: PublishService): boolean {
    if (this.#closed || this.#d.signal.aborted || this.#d.publish.current !== service) return false;
    if (this.#d.ledger.data.tasks[task.id] !== task || task.publication !== pub) return false;
    if (task.state !== 'done' || task.artifactsCleared) return false;
    return !!specOf(this.#d.cfg, task.paperId)?.publishTargets.includes(pub.target);
  }

  async #advance(task: TaskRecord, pub: Publication): Promise<void> {
    const service = this.#d.publish.current;
    if (!service) {
      this.#arm(RETRY_MS);
      return;
    }
    if (!this.#valid(task, pub, service)) {
      if (
        this.#d.publish.current === service &&
        task.publication === pub &&
        task.state === 'done' &&
        !task.artifactsCleared &&
        !specOf(this.#d.cfg, task.paperId)?.publishTargets.includes(pub.target)
      ) {
        await this.#update(task.id, pub, { state: 'failed', reason: '这块白纸未获准使用该发布目标' });
      }
      return;
    }
    if (pub.state === 'submitted') {
      if (!pub.workId) return;
      const item = service.get(pub.workId);
      if (!this.#valid(task, pub, service)) return;
      if (!item || item.origin.producer !== this.#d.producer || item.origin.ref !== `${task.paperId}/${task.id}`) {
        await this.#update(task.id, pub, { state: 'failed', reason: '发布回执无法核对来源' });
      } else if (item.live) {
        await this.#update(task.id, pub, { state: 'live', reason: undefined });
      } else if (
        item.state === 'rejected' ||
        item.state === 'expired' ||
        item.state === 'failed' ||
        item.state === 'withdrawn'
      ) {
        await this.#update(task.id, pub, { state: 'failed', reason: `发布处理${item.state}` });
      }
      return;
    }
    let surface: PublishSurfaceInfo | undefined;
    try {
      surface = service.listSurfaces().find(s => s.name === pub.target);
    } catch {
      this.#arm(RETRY_MS);
      return;
    }
    if (!surface?.available) {
      this.#arm(RETRY_MS);
      return;
    }

    let selected: { artifacts: TaskRecord['artifacts']; paths: string[] } | { reason: string };
    if (pub.artifactIds) {
      const artifacts = pub.artifactIds.map(id => task.artifacts.find(a => a.id === id));
      if (artifacts.some(a => !a)) {
        await this.#update(task.id, pub, { state: 'failed', reason: '已选成品不再存在' });
        return;
      }
      if (pub.paths) {
        const lowered = new Set<string>();
        const valid =
          pub.paths.length === artifacts.length &&
          pub.paths.every(path => {
            if (publicPathProblem(path) || lowered.has(path.toLowerCase())) return false;
            lowered.add(path.toLowerCase());
            return true;
          });
        selected = valid
          ? { artifacts: artifacts as TaskRecord['artifacts'], paths: pub.paths }
          : { reason: '已选作品路径不符合发布要求' };
      } else {
        selected = automaticPublicationArtifacts({ ...task, artifacts: artifacts as TaskRecord['artifacts'] });
      }
    } else {
      selected = automaticPublicationArtifacts(task);
    }
    if ('reason' in selected) {
      await this.#update(task.id, pub, { state: 'failed', reason: selected.reason });
      return;
    }
    if (!pub.artifactIds) {
      const saved = await this.#update(task.id, pub, {
        artifactIds: selected.artifacts.map(a => a.id),
        paths: selected.paths,
      });
      if (!saved) return;
      pub = task.publication!;
    }
    const files: PublishFile[] = [];
    let cover: Uint8Array | undefined;
    try {
      for (let i = 0; i < selected.artifacts.length; i++) {
        const artifact = selected.artifacts[i];
        const bytes = await this.#d.storage.readFile(artifactUri(task.paperId, task.id, artifact));
        files.push({ path: selected.paths[i], bytes: new Uint8Array(bytes as Uint8Array) });
      }
      if (pub.coverArtifactId) {
        const artifact = task.artifacts.find(a => a.id === pub.coverArtifactId);
        if (!artifact || !['png', 'jpeg', 'gif', 'webp'].includes(artifact.type)) {
          await this.#update(task.id, pub, { state: 'failed', reason: '已选封面不再存在' });
          return;
        }
        cover = new Uint8Array(
          (await this.#d.storage.readFile(artifactUri(task.paperId, task.id, artifact))) as Uint8Array,
        );
      }
    } catch {
      this.#arm(RETRY_MS);
      return;
    }
    if (!this.#valid(task, pub, service)) return;
    const result = await service.nominate({
      submissionKey: `paper:${task.id}`,
      origin: {
        producer: this.#d.producer,
        ref: `${task.paperId}/${task.id}`,
        label: task.room,
        notify: { sessionId: task.room, platform: task.platform },
        actorKey: actorKey(task.initiator),
      },
      group: task.paperId,
      groupLabel: paperLabel(task.paperId),
      surfaces: [pub.target],
      title: pub.title,
      summary: pub.summary,
      files,
      ...(cover ? { cover } : {}),
    });
    if (!this.#valid(task, pub, service)) return;
    if ('refused' in result) {
      if (typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0) {
        await this.#update(task.id, pub, {
          state: 'pending',
          nextAttemptAt: this.#now() + Math.ceil(result.retryAfterMs),
          reason: undefined,
        });
        return;
      }
      await this.#update(task.id, pub, { state: 'failed', reason: '作品未通过发布检查' });
      return;
    }
    await this.#update(task.id, pub, { state: 'submitted', workId: result.id, nextAttemptAt: undefined });
  }
}
