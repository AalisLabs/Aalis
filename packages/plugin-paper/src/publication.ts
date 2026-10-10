import type { PublishFile, PublishService, PublishSurfaceInfo } from '@aalis/api-publish';
import type { StorageService } from '@aalis/api-storage';
import type { Logger, ServiceSelection } from '@aalis/core';
import { artifactUri } from './artifacts.js';
import { type PaperConfig, specOf } from './config.js';
import { failedBeforeSubmission } from './deliver.js';
import type { LedgerStore, TaskRecord } from './ledger.js';
import { actorKey, paperLabel } from './rooms.js';
import type { TaskJournal } from './task-journal.js';
import { automaticPublicationArtifacts, pathsProblem, retryDelay } from './works.js';

type Publication = NonNullable<TaskRecord['publication']>;
const RETRY_MS = 30_000;
/** 待提交最长等多久：发布目标或发布服务一直不可用时，到期转失败并通知，不让任务一直挂着 */
const PENDING_DEADLINE_MS = 24 * 3_600_000;

interface PaperPublicationDeps {
  journal?: TaskJournal;
  ledger: LedgerStore;
  cfg: PaperConfig;
  storage: StorageService;
  publish: ServiceSelection<PublishService>;
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
      const notice = task.notice;
      task.publication = { ...previous, ...patch };
      // 已完成任务的发布在提交之前转为失败，是房间还没听说的结果：清掉通知标记，由完成通知报它。第一次失败时本来就
      // 没有标记；经 works_nominate 重新提名之后再失败，标记还是上一次失败的，不清就不再通知。当场被拒的提名由工具
      // 回执告知，不经这里
      if (patch.state === 'failed' && failedBeforeSubmission(task)) delete task.notice;
      try {
        await this.#d.ledger.save();
      } catch (err) {
        task.publication = previous;
        if (notice) task.notice = notice;
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
      if (pub.state === 'pending') {
        const deadline = (pub.pendingSince ?? task.endedAt ?? task.createdAt) + PENDING_DEADLINE_MS;
        if (this.#now() >= deadline) {
          await this.#update(task.id, pub, {
            state: 'failed',
            reason: '24 小时内没能提交发布（发布目标或发布服务一直不可用）',
            nextAttemptAt: undefined,
            directSend: true,
          });
          continue;
        }
        // 只在推迟重试时把期限算进唤醒时刻；其余情况推进不了时 30 秒后重试，期限到了自然会查到
        if ((pub.nextAttemptAt ?? 0) > this.#now()) {
          nearest = Math.min(nearest, pub.nextAttemptAt!, deadline);
          continue;
        }
      }
      try {
        if (await this.#advance(task, pub)) nearest = Math.min(nearest, this.#now() + RETRY_MS);
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
  /** 发布服务此刻选中的那一家：推进途中换了人，这一轮就不再往下走 */
  #selectedId(): string | undefined {
    return this.#d.publish.list().find(p => p.selected)?.id;
  }
  #valid(task: TaskRecord, pub: Publication, serviceId: string): boolean {
    if (this.#closed || this.#d.signal.aborted || this.#selectedId() !== serviceId) return false;
    if (this.#d.ledger.data.tasks[task.id] !== task || task.publication !== pub) return false;
    if (task.state !== 'done' || task.artifactsCleared) return false;
    return !!specOf(this.#d.cfg, task.paperId)?.publishTargets.includes(pub.target);
  }

  /** 返回 true 表示暂时推进不了（发布服务、展示面或成品读取暂不可用），由 #sweep 排进 RETRY_MS 之后的唤醒 */
  async #advance(task: TaskRecord, pub: Publication): Promise<boolean> {
    const publisher = this.#d.publish.list().find(p => p.selected);
    if (!publisher) return true;
    const service = publisher.use;
    if (!this.#valid(task, pub, publisher.id)) {
      if (
        this.#selectedId() === publisher.id &&
        task.publication === pub &&
        task.state === 'done' &&
        !task.artifactsCleared &&
        !specOf(this.#d.cfg, task.paperId)?.publishTargets.includes(pub.target)
      ) {
        await this.#update(task.id, pub, { state: 'failed', reason: '这块白纸未获准使用该发布目标', directSend: true });
      }
      return false;
    }
    if (pub.state === 'submitted') {
      if (!pub.workId) return false;
      const item = service.get(pub.workId);
      if (!this.#valid(task, pub, publisher.id)) return false;
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
      return false;
    }
    let surface: PublishSurfaceInfo | undefined;
    try {
      surface = service.listSurfaces().find(s => s.name === pub.target);
    } catch {
      return true;
    }
    if (!surface?.available) return true;

    let selected: { artifacts: TaskRecord['artifacts']; paths: string[] } | { reason: string };
    if (pub.artifactIds) {
      const artifacts = pub.artifactIds.map(id => task.artifacts.find(a => a.id === id));
      if (artifacts.some(a => !a)) {
        await this.#update(task.id, pub, { state: 'failed', reason: '已选成品不再存在', directSend: true });
        return false;
      }
      if (pub.paths) {
        selected =
          pub.paths.length === artifacts.length && !pathsProblem(pub.paths)
            ? { artifacts: artifacts as TaskRecord['artifacts'], paths: pub.paths }
            : { reason: '已选作品路径不符合发布要求' };
      } else {
        selected = automaticPublicationArtifacts({ ...task, artifacts: artifacts as TaskRecord['artifacts'] });
      }
    } else {
      selected = automaticPublicationArtifacts(task);
    }
    if ('reason' in selected) {
      await this.#update(task.id, pub, { state: 'failed', reason: selected.reason, directSend: true });
      return false;
    }
    if (!pub.artifactIds) {
      const saved = await this.#update(task.id, pub, {
        artifactIds: selected.artifacts.map(a => a.id),
        paths: selected.paths,
      });
      if (!saved) return false;
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
          await this.#update(task.id, pub, { state: 'failed', reason: '已选封面不再存在', directSend: true });
          return false;
        }
        cover = new Uint8Array(
          (await this.#d.storage.readFile(artifactUri(task.paperId, task.id, artifact))) as Uint8Array,
        );
      }
    } catch {
      return true;
    }
    if (!this.#valid(task, pub, publisher.id)) return false;
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
    if (!this.#valid(task, pub, publisher.id)) return false;
    if ('refused' in result) {
      const retry = retryDelay(result);
      if (retry !== undefined) {
        await this.#update(task.id, pub, { state: 'pending', nextAttemptAt: this.#now() + retry, reason: undefined });
        return false;
      }
      await this.#update(task.id, pub, { state: 'failed', reason: '作品未通过发布检查' });
      return false;
    }
    await this.#update(task.id, pub, { state: 'submitted', workId: result.id, nextAttemptAt: undefined });
    return false;
  }
}
