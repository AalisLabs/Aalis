// ============================================================
// 白纸作品：只把本房间、本发起人的已完成任务成品复制给发布服务；撤下只按来源房间授权。
// 工具回执不含成品相对路径或白纸存储 URI，公开路径由发布服务再次校验。
// ============================================================

import {
  type PublishFile,
  type PublishService,
  type PublishSurfaceInfo,
  publicPathProblem,
  WORK_ID_PATTERN,
} from '@aalis/api-publish';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { StorageService } from '@aalis/api-storage';
import type { BoundTools, ToolCallContext } from '@aalis/api-tools';
import type { ServiceRef } from '@aalis/core';
import { artifactUri, EXTENSIONS } from './artifacts.js';
import { type PaperConfig, specOf } from './config.js';
import type { LedgerStore, TaskRecord } from './ledger.js';
import { actorKey, checkEligibility, effectiveActor, paperLabel } from './rooms.js';
import { enterPaperRoom } from './tools.js';

interface WorksDeps {
  producer: string;
  signal: AbortSignal;
  tools: BoundTools;
  sessionManager: ServiceRef<SessionManagerService>;
  publish: ServiceRef<PublishService>;
  storage: StorageService;
  ledger: LedgerStore;
  cfg: PaperConfig;
  /** 手动修正转为待提交后唤醒后台协调器，确保异常与重启前也有定时补偿。 */
  onPublicationChange?: () => void;
}

type Artifact = TaskRecord['artifacts'][number];
const IMAGE_TYPES = new Set<Artifact['type']>(['png', 'jpeg', 'gif', 'webp']);
const MEDIA_TYPES = new Set<Artifact['type']>(['png', 'jpeg', 'gif', 'webp', 'mp4']);
const fail = (error: string) => JSON.stringify({ ok: false, error });
const done = (fields: Record<string, unknown>) => JSON.stringify({ ok: true, ...fields });
const chars = (value: string) => [...value].length;

/** 所选文件有共同目录时只去这一段目录前缀，不改动文件名。 */
function publishedPaths(artifacts: readonly Artifact[]): string[] {
  if (artifacts.length === 1) {
    const [only] = artifacts;
    if (only.type === 'html') return ['index.html'];
    if (MEDIA_TYPES.has(only.type)) return [`work.${EXTENSIONS[only.type]}`];
  }
  const paths = artifacts.map(a => a.rel.split('/'));
  let common = 0;
  while (paths.every(parts => parts.length > common + 1 && parts[common] === paths[0][common])) common++;
  return paths.map(parts => parts.slice(common).join('/'));
}

/** 自动投稿只认明确的作品根；其它成品留给发起人显式挑选。 */
export function automaticPublicationArtifacts(
  task: TaskRecord,
): { artifacts: Artifact[]; paths: string[] } | { reason: string } {
  const candidates = task.artifacts.filter(a => a.type === 'html' || MEDIA_TYPES.has(a.type));
  if (task.artifacts.length === 1 && candidates.length === 1) {
    return { artifacts: [candidates[0]], paths: publishedPaths(candidates) };
  }
  const roots = task.artifacts.filter(a => a.type === 'html' && a.rel.split('/').pop()?.toLowerCase() === 'index.html');
  if (roots.length !== 1) return { reason: '无法确定唯一的网页入口，请手动选择成品' };
  const root = roots[0].rel.split('/').slice(0, -1).join('/');
  const prefix = root ? `${root}/` : '';
  const artifacts = task.artifacts.filter(a => a.rel.startsWith(prefix));
  if (artifacts.length !== task.artifacts.length) return { reason: '成品分属不同目录，请手动选择成品' };
  const paths = artifacts.map(a => a.rel.slice(prefix.length));
  const lowered = new Set<string>();
  for (const path of paths) {
    if (publicPathProblem(path) || lowered.has(path.toLowerCase())) {
      return { reason: '作品路径不符合发布要求，请手动选择成品' };
    }
    lowered.add(path.toLowerCase());
  }
  return { artifacts, paths };
}

function workId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (WORK_ID_PATTERN.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const match = url.pathname.match(/\/w\/([a-z2-7]{10})\//);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** 发布服务的拒绝类别可展示；发现相对路径时不把远端文件名带进工具回执。 */
function refusal(reason: string, artifacts: readonly Artifact[]): string {
  const privateNames = artifacts.flatMap(a => [a.rel, a.rel.split('/').pop() ?? '']);
  return reason.includes('/') || reason.includes('\\') || privateNames.some(name => name && reason.includes(name))
    ? '作品文件未通过检查'
    : reason;
}

export function registerWorksTools(deps: WorksDeps): void {
  const { tools, ledger } = deps;

  /** 服务目录按当前白纸的授权名单裁剪；不要让别纸的站点名称或地址进入工具回执。 */
  function allowedSurfaces(service: PublishService, paperId: string): PublishSurfaceInfo[] {
    const allowed = specOf(deps.cfg, paperId)?.publishTargets ?? [];
    return service.listSurfaces().filter(surface => allowed.includes(surface.name));
  }

  async function targets(_args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    if (deps.signal.aborted) return fail('白纸已停止');
    const entered = await enterPaperRoom(deps, ctx, 'initiate');
    if (deps.signal.aborted) return fail('白纸已停止');
    if ('refused' in entered) return fail(entered.refused);
    const service = deps.publish.current;
    if (!service) return fail('作品发布服务不可用');
    try {
      const spec = specOf(deps.cfg, entered.paper.paperId);
      const listed = allowedSurfaces(service, entered.paper.paperId);
      const configuredDefault =
        spec?.defaultPublishTarget ?? (spec?.publishTargets.length === 1 ? spec.publishTargets[0] : undefined);
      return done({
        ...(configuredDefault && listed.some(surface => surface.name === configuredDefault)
          ? { defaultTarget: configuredDefault }
          : {}),
        targets: listed.map(({ name, label, baseUrl, available, reason }) => ({
          name,
          label,
          baseUrl,
          available,
          ...(reason ? { reason } : {}),
        })),
      });
    } catch {
      return fail('读取发布目标失败，等 owner 检查发布服务');
    }
  }

  async function nominate(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    if (deps.signal.aborted) return fail('白纸已停止');
    const entered = await enterPaperRoom(deps, ctx, 'initiate');
    if (deps.signal.aborted) return fail('白纸已停止');
    if ('refused' in entered) return fail(entered.refused);
    if (ledger.failure) return fail('白纸账本读取失败，等 owner 处理');
    const service = deps.publish.current;
    if (!service) return fail('作品发布服务不可用');
    const spec = specOf(deps.cfg, entered.paper.paperId);
    const allowed = spec?.publishTargets ?? [];
    if (allowed.length === 0) return fail('这块白纸未获准发布作品');
    if (args.target !== undefined && typeof args.target !== 'string') return fail('发布目标须为目标 ID');
    const requested = typeof args.target === 'string' ? args.target.trim() : '';
    const target = requested || spec?.defaultPublishTarget || (allowed.length === 1 ? allowed[0] : '');
    if (!target) return fail('这块白纸有多个发布目标，请明确选择 target');
    if (!allowed.includes(target)) return fail('这块白纸未获准使用该发布目标');
    let selectedSurface: PublishSurfaceInfo | undefined;
    try {
      selectedSurface = allowedSurfaces(service, entered.paper.paperId).find(surface => surface.name === target);
    } catch {
      return fail('读取发布目标失败，等 owner 检查发布服务');
    }
    if (!selectedSurface) return fail('发布目标未登记');
    if (!selectedSurface.available) return fail('发布目标当前不可用');

    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!/^t-[0-9a-f]{8}$/.test(taskId)) return fail('请提供任务编号');
    const task = Object.hasOwn(ledger.data.tasks, taskId) ? ledger.data.tasks[taskId] : undefined;
    if (!task || task.paperId !== entered.paper.paperId || task.room !== ctx.sessionId) {
      return fail('本房间的白纸上没有这件任务');
    }
    if (actorKey(effectiveActor(ctx)) !== actorKey(task.initiator)) return fail('只能提名自己发起的任务');
    if (task.state !== 'done') return fail('这件任务还没有完成');
    if (task.artifactsCleared) return fail('这件任务的成品已随白纸清空删除');
    if (task.publication?.workId) {
      return done({ workId: task.publication.workId, message: '这件任务已提交发布处理' });
    }
    if (task.publication && task.publication.state !== 'failed') {
      return fail('这件任务的自动发布正在处理，请稍后查看结果');
    }

    const ids = args.artifact_ids;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 50 ||
      ids.some(id => typeof id !== 'string' || !/^a-[0-9a-f]{8}$/.test(id))
    ) {
      return fail('请选 1 到 50 个成品编号');
    }
    if (new Set(ids).size !== ids.length) return fail('成品编号不能重复');
    const artifacts = ids.map(id => task.artifacts.find(a => a.id === id));
    if (artifacts.some(a => !a)) return fail('这件任务里没有所选成品');
    const selected = artifacts as Artifact[];
    const coverId = args.cover_artifact_id;
    let coverArtifact: Artifact | undefined;
    if (coverId !== undefined && coverId !== null && coverId !== '') {
      coverArtifact = task.artifacts.find(a => a.id === coverId);
      if (!coverArtifact || !IMAGE_TYPES.has(coverArtifact.type)) return fail('封面只能是同一任务里的图片');
    }

    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (args.summary !== undefined && typeof args.summary !== 'string') return fail('简介须为文字');
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (chars(title) < 1 || chars(title) > 40) return fail('标题须为 1 到 40 字');
    if (chars(summary) > 300) return fail('简介不能超过 300 字');

    const paths = publishedPaths(selected);
    let repair = task.publication;
    if (repair) {
      try {
        await ledger.exclusive(async () => {
          if (task.publication !== repair || task.state !== 'done' || task.artifactsCleared)
            throw new Error('任务状态已变化');
          task.publication = {
            target,
            title,
            summary,
            state: 'pending',
            artifactIds: selected.map(a => a.id),
            paths,
            ...(coverArtifact ? { coverArtifactId: coverArtifact.id } : {}),
            nextAttemptAt: Date.now() + 30_000,
          };
          try {
            await ledger.save();
          } catch (err) {
            task.publication = repair;
            throw err;
          }
          repair = task.publication;
        });
        deps.onPublicationChange?.();
      } catch {
        return fail('白纸账本保存失败，请稍后重试');
      }
    }
    const files: PublishFile[] = [];
    let cover: Uint8Array | undefined;
    try {
      for (let i = 0; i < selected.length; i++) {
        const bytes = await deps.storage.readFile(artifactUri(task.paperId, task.id, selected[i]));
        files.push({ path: paths[i], bytes: new Uint8Array(bytes as Uint8Array) });
      }
      if (coverArtifact) {
        const bytes = await deps.storage.readFile(artifactUri(task.paperId, task.id, coverArtifact));
        cover = new Uint8Array(bytes as Uint8Array);
      }
    } catch {
      return fail('读取成品失败，等 owner 检查白纸存储');
    }

    if (deps.publish.current !== service || !specOf(deps.cfg, task.paperId)?.publishTargets.includes(target)) {
      return fail('发布目标状态已变化，请重试');
    }
    if (repair && (task.publication !== repair || task.state !== 'done' || task.artifactsCleared)) {
      return fail('任务状态已变化，请重试');
    }

    try {
      if (deps.signal.aborted) return fail('白纸已停止');
      const result = await service.nominate({
        ...(repair ? { submissionKey: `paper:${task.id}` } : {}),
        origin: {
          producer: deps.producer,
          ref: `${task.paperId}/${task.id}`,
          label: task.room,
          notify: { sessionId: task.room, platform: task.platform },
          actorKey: actorKey(task.initiator),
        },
        group: task.paperId,
        groupLabel: paperLabel(task.paperId),
        surfaces: [target],
        title,
        summary,
        files,
        cover,
      });
      if (deps.publish.current !== service || task.state !== 'done' || task.artifactsCleared) {
        return fail('任务或发布服务状态已变化，请稍后重试');
      }
      if ('refused' in result) {
        if (repair && task.publication === repair) {
          await ledger.exclusive(async () => {
            if (task.publication !== repair) return;
            task.publication = {
              ...task.publication!,
              state: 'failed',
              reason: '作品未通过发布检查',
              nextAttemptAt: undefined,
            };
            try {
              await ledger.save();
            } catch (err) {
              task.publication = repair;
              throw err;
            }
          });
        }
        const item =
          result.fileIndex === -1
            ? '封面'
            : typeof result.fileIndex === 'number'
              ? selected[result.fileIndex]?.id
              : undefined;
        return fail(
          `${item ? (item === '封面' ? '封面' : `成品 ${item}`) : '作品'}：${refusal(result.refused, selected)}`,
        );
      }
      if (repair && task.publication === repair) {
        await ledger.exclusive(async () => {
          if (task.publication !== repair) return;
          task.publication = { ...task.publication!, state: 'submitted', workId: result.id, nextAttemptAt: undefined };
          try {
            await ledger.save();
          } catch (err) {
            task.publication = repair;
            throw err;
          }
        });
      }
      return done({
        workId: result.id,
        message: '已提交发布处理；上线后会在本房间通知网址，若需人工处理也会告知',
      });
    } catch {
      return fail('提交作品失败，等 owner 检查发布服务');
    }
  }

  async function takedown(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    if (deps.signal.aborted) return fail('白纸已停止');
    const refused = checkEligibility(deps.sessionManager.require(), ctx, 'use');
    if (refused) return fail(refused);
    const service = deps.publish.current;
    if (!service) return fail('作品发布服务不可用');
    const id = workId(args.work);
    if (!id) return fail('作品编号无效');
    try {
      const item = service.get(id);
      if (!item || item.origin.notify?.sessionId !== ctx.sessionId) return fail('本房间没有这件作品');
      const result = await service.withdraw(
        id,
        { kind: 'origin', actorKey: actorKey(effectiveActor(ctx)) },
        '来源房间撤下',
      );
      if ('refused' in result) return fail(result.refused);
      return done({
        workId: id,
        message: result.degraded
          ? `已从作品集撤下作品 ${id}，但作品站目前没法部署（${result.degraded}），站点上可能还打得开，要等 owner 处理`
          : `已撤下作品 ${id}，站点一般几分钟内不再返回它`,
      });
    } catch {
      return fail('撤下作品失败，等 owner 检查发布服务');
    }
  }

  tools.registerGroup({ name: 'works', label: '作品', description: '把白纸成品提名到作品页、撤下本房间的作品' });
  tools.register({
    groups: ['works'],
    definition: {
      type: 'function',
      function: {
        name: 'works_targets',
        description:
          '查询当前房间这块白纸获准且已登记的发布目标。只在真人当面发起的回合里使用；返回目标 ID、站点地址与可用状态。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    handler: targets,
  });
  tools.register({
    groups: ['works'],
    definition: {
      type: 'function',
      function: {
        name: 'works_nominate',
        description:
          '把自己在本房间白纸上已完成任务的成品提名给获准的单个发布目标审核。只在真人当面发起的回合里使用。先用 works_targets 查询可选目标 ID。',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: '本房间任务编号' },
            artifact_ids: { type: 'array', items: { type: 'string' }, description: '选中的 1–50 个成品编号' },
            cover_artifact_id: { type: 'string', description: '可选：同一任务的图片成品编号' },
            title: { type: 'string', description: '作品标题，1–40 字' },
            summary: { type: 'string', description: '作品简介，0–300 字' },
            target: { type: 'string', description: '发布目标 ID（不是网址）；单目标或配置了默认目标时可省略' },
          },
          required: ['task_id', 'artifact_ids', 'title', 'summary'],
          additionalProperties: false,
        },
      },
    },
    handler: nominate,
  });
  tools.register({
    groups: ['works'],
    definition: {
      type: 'function',
      function: {
        name: 'works_takedown',
        description: '撤下本房间提名的作品；可在内部通知回合使用。',
        parameters: {
          type: 'object',
          properties: { work: { type: 'string', description: '作品编号或作品网址' } },
          required: ['work'],
          additionalProperties: false,
        },
      },
    },
    handler: takedown,
  });
}
