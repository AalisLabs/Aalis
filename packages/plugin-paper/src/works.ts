// ============================================================
// 白纸作品：只把本房间、本发起人的已完成任务成品复制给发布服务；撤下只按来源房间授权。
// 工具回执不含成品相对路径或白纸存储 URI，公开路径由发布服务再次校验。
// ============================================================

import { type PublishFile, type PublishService, WORK_ID_PATTERN } from '@aalis/api-publish';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { StorageService } from '@aalis/api-storage';
import type { BoundTools, ToolCallContext } from '@aalis/api-tools';
import type { ServiceRef } from '@aalis/core';
import { artifactUri, EXTENSIONS } from './artifacts.js';
import type { PaperConfig } from './config.js';
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

  async function nominate(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    if (deps.signal.aborted) return fail('白纸已停止');
    const entered = await enterPaperRoom(deps, ctx, 'initiate');
    if (deps.signal.aborted) return fail('白纸已停止');
    if ('refused' in entered) return fail(entered.refused);
    if (ledger.failure) return fail('白纸账本读取失败，等 owner 处理');
    const service = deps.publish.current;
    if (!service) return fail('作品发布服务不可用');

    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!/^t-[0-9a-f]{8}$/.test(taskId)) return fail('请提供任务编号');
    const task = Object.hasOwn(ledger.data.tasks, taskId) ? ledger.data.tasks[taskId] : undefined;
    if (!task || task.paperId !== entered.paper.paperId || task.room !== ctx.sessionId) {
      return fail('本房间的白纸上没有这件任务');
    }
    if (actorKey(effectiveActor(ctx)) !== actorKey(task.initiator)) return fail('只能提名自己发起的任务');
    if (task.state !== 'done') return fail('这件任务还没有完成');
    if (task.artifactsCleared) return fail('这件任务的成品已随白纸清空删除');

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

    try {
      if (deps.signal.aborted) return fail('白纸已停止');
      const result = await service.nominate({
        origin: {
          producer: deps.producer,
          ref: `${task.paperId}/${task.id}`,
          label: ctx.sessionId,
          notify: { sessionId: ctx.sessionId, platform: ctx.platform ?? task.platform },
          actorKey: actorKey(effectiveActor(ctx)),
        },
        group: task.paperId,
        groupLabel: paperLabel(task.paperId),
        surfaces: ['works'],
        title,
        summary,
        credit: deps.cfg.worksCredit,
        files,
        cover,
      });
      if ('refused' in result) {
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
      return done({
        workId: result.id,
        message: '已提交审核；通过并上线后会在本房间通知网址，需要 owner 审核时也会先说一声',
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
        name: 'works_nominate',
        description: '把自己在本房间白纸上已完成任务的成品提名给作品站审核。只在真人当面发起的回合里使用。',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: '本房间任务编号' },
            artifact_ids: { type: 'array', items: { type: 'string' }, description: '选中的 1–50 个成品编号' },
            cover_artifact_id: { type: 'string', description: '可选：同一任务的图片成品编号' },
            title: { type: 'string', description: '作品标题，1–40 字' },
            summary: { type: 'string', description: '作品简介，0–300 字' },
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
