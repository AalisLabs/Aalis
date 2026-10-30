/**
 * /relation —— 关系图查看、清理与维护指令。
 *
 * 命令清单（默认前缀由 plugin-commands 配置）。标 restricted 的为 restricted 可见性（需 owner 授予），其余为 public：
 * - `relation show person|event|entity <id>`：打印目标节点 + 直连边
 * - `relation orphans`：列出"孤立点"（不被任何边引用的 person/event/entity）
 *   show 与 orphans 与读工具同一判据：调用会话的关系图范围是仅本会话时只列本会话的事件，人与实体照常
 * - `relation forget-me`：删除调用者自己的 Person 节点及其级联边
 * - `relation consolidation-status`：查看最近一次 consolidate 的运行时间、触发源与结果
 * - `relation cleanup person|event|entity <id>`：删该节点 + 级联边（restricted）
 * - `relation cleanup orphans`：一键清理所有孤立点（restricted）
 * - `relation cleanup all --yes`：清空整个关系图，不带 --yes 只返回提示（restricted）
 * - `relation consolidate [--auto-link] [--no-llm]`：整理关系图（restricted）
 * - `relation rewrite-weights`：把 weight 物理回写为当前 effectiveWeight（restricted）
 * - `relation event-duplicates`：扫描事件重复合并候选，不修改图（restricted）
 * - `relation compress`：手动触发容量淘汰（restricted）
 * - `relation maintain [--no-llm] [--no-auto-link]`：先整理后压缩（restricted）
 */

import type { BoundCommands } from '@aalis/api-commands';
import { type I18nService, localizeFor } from '@aalis/api-i18n';
import type { LLMModel } from '@aalis/api-llm';
import { type PlatformAdapter, resolvePlatformBySession } from '@aalis/api-platform';
import type { Logger, ServiceSelection } from '@aalis/core';
import { type TextRef, textLines } from '@aalis/schema-i18n';
import type { RelationService } from './service.js';
import { t } from './texts.js';
import type { ConsolidateCounts, EntityNode, EventNode, LastConsolidate, PersonNode, RelationEdge } from './types.js';
import { findOrphans, withinScope } from './utils.js';
import { ENTITY_KIND_NAMES, nameIn } from './webui.js';

/** /relation 指令用到的能力 */
interface CommandsCaps {
  commands: BoundCommands;
  platform: ServiceSelection<PlatformAdapter>;
  llm: ServiceSelection<LLMModel>;
  /** 立即回执按会话的语言渲染；缺席时按原文 */
  i18n: ServiceSelection<I18nService>;
  logger: Logger;
  /** 判一个会话的关系图范围是不是仅本会话（按会话现读），与读工具同一个 */
  sessionOnly(sessionId: string, platform: string | undefined): boolean;
}

/** consolidation 的触发来源的显示名 */
const TRIGGER_NAMES: Record<LastConsolidate['trigger'], TextRef> = {
  manual: t('triggerManual'),
  eviction: t('triggerEviction'),
  api: t('triggerApi'),
};

/** 整理的各项计数：条件片段（event 重复、LLM 增强与其中的缓存命中）各成一句，以「，」相连 */
function consolidateSummary(counts: ConsolidateCounts): TextRef {
  const parts = [
    t('consolidateCounts', {
      aliasCandidates: counts.aliasCandidates,
      aliasEdges: counts.aliasEdgesCreated,
      eventEdges: counts.eventEdgesNormalized,
      hierarchyCandidates: counts.entityHierarchyCandidates,
      hierarchyEdges: counts.entityHierarchyEdgesCreated,
      lateralCandidates: counts.lateralParentCandidates,
      lateralParents: counts.lateralParentsCreated,
      lateralEdges: counts.lateralEdgesCreated,
    }),
  ];
  if (counts.eventDuplicateCandidates > 0) {
    parts.push(
      t('consolidateDuplicates', { candidates: counts.eventDuplicateCandidates, merged: counts.eventDuplicatesMerged }),
    );
  }
  if (counts.llm) {
    const { verified, rejected, cacheHits, summariesRewritten: rewritten } = counts.llm;
    parts.push(
      cacheHits > 0
        ? t('consolidateLlmCached', { verified, rejected, cacheHits, rewritten })
        : t('consolidateLlm', { verified, rejected, rewritten }),
    );
  }
  return parts.reduce((head, tail) => t('andThen', { head, tail }));
}

/** 容量淘汰配置：index.ts 解析一次，extractor 与 /relation compress、maintain、rewrite-weights 共用 */
export interface EvictionConfig {
  maxPersons: number;
  maxEvents: number;
  maxEntities: number;
  maxEdges: number;
  pagerankDamping: number;
  pagerankIterations: number;
  pagerankEpsilon: number;
  hysteresisPct: number;
  targetPct: number;
  /** Weight 时间衰减半衰期（天），0=关闭 */
  weightDecayHalfLifeDays: number;
  /** Weight 衰减下限因子 */
  weightDecayFloor: number;
  /** 社群发现算法 */
  communityAlgorithm: 'louvain' | 'leiden' | 'slpa';
}

export function registerRelationCommands(
  { commands: cmds, platform, llm, i18n, logger, sessionOnly }: CommandsCaps,
  service: RelationService,
  options: {
    consolidateLLM?: { modelRef: { provider: string; model: string }; disableThinking: boolean };
    eviction: EvictionConfig;
    /** consolidate 是否默认开 autoLink（/relation maintain 需要） */
    consolidateAutoLink: boolean;
    /** F3：宽召回低权 pair 跳过 LLM 核验 */
    consolidateSkipLowScorePairs: boolean;
    /** F3：低权阈值（0 = 不跳过） */
    consolidateLowScoreThreshold: number;
  },
): void {
  cmds.command('relation', t('relationDescription'));
  cmds.command('relation.cleanup', t('cleanupDescription'));

  /** 调用会话的关系图范围是仅本会话时为这个会话，否则不过滤 */
  const scopeOf = ({ sessionId, platform }: { sessionId: string; platform: string }) =>
    sessionOnly(sessionId, platform) ? sessionId : undefined;

  // ---- show ----
  cmds
    .command('relation.show <kind:string> <id:text>', t('showDescription'))
    .argument('kind', t('showKindArgument'))
    .argument('id', t('showIdArgument'))
    .example('/relation show person onebot:1234567')
    .example('/relation show entity 9f3a2b...')
    .action(async (argv, kindArg, idArg) => {
      const kind = String(kindArg ?? '').toLowerCase();
      const id = String(idArg ?? '').trim();
      if (!id) return t('emptyId');
      // 别的会话的事件连同连着它们的边都去掉：按 id 取它回未找到
      const scope = scopeOf(argv.session);
      const snap = withinScope(await service.loadAll(), scope);
      if (kind === 'person') {
        if (!id.includes(':')) return t('badPersonId');
        const p = snap.persons.find(x => x.id === id);
        if (!p) return t('nodeNotFound', { kind, id });
        const nb = withinScope(await service.getNeighborhood(id), scope);
        return formatPerson(p, nb.events, nb.entities, nb.edges);
      }
      if (kind === 'event') {
        const e = snap.events.find(x => x.id === id);
        if (!e) return t('nodeNotFound', { kind, id });
        const edges = snap.edges.filter(
          ed =>
            (ed.kind === 'person-event' && ed.toEventId === id) ||
            (ed.kind === 'event-event' && (ed.fromEventId === id || ed.toEventId === id)),
        );
        return formatEvent(e, edges);
      }
      if (kind === 'entity') {
        const ent = snap.entities.find(x => x.id === id);
        if (!ent) return t('nodeNotFound', { kind, id });
        const edges = snap.edges.filter(ed => ed.kind === 'person-entity' && ed.toEntityId === id);
        return formatEntity(ent, edges);
      }
      return t('unknownKind', { kind });
    });

  // ---- orphans (list) ----
  // 孤立按全图判（人与实体照常），事件一节只列本会话的
  cmds.command('relation.orphans', t('orphansDescription')).action(async argv => {
    const scope = scopeOf(argv.session);
    const { persons, events: allEvents, entities } = findOrphans(await service.loadAll());
    const events = scope ? allEvents.filter(e => e.sessionScope === scope) : allEvents;
    if (persons.length + events.length + entities.length === 0) {
      return t('noOrphans');
    }
    const lines: Array<string | TextRef> = [t('orphansTitle')];
    if (persons.length) {
      lines.push(t('orphanSection', { kind: t('persons'), count: persons.length }));
      for (const p of persons) lines.push(`- ${p.id}  ${p.displayName ?? ''}`);
    }
    if (events.length) {
      lines.push(t('orphanSection', { kind: t('events'), count: events.length }));
      for (const e of events) lines.push(`- ${e.id}  ${e.title}`);
    }
    if (entities.length) {
      lines.push(t('orphanSection', { kind: t('entities'), count: entities.length }));
      for (const e of entities) {
        lines.push(t('orphanEntity', { id: e.id, kind: nameIn(ENTITY_KIND_NAMES, e.entityKind), name: e.name }));
      }
    }
    return textLines(lines);
  });

  // ---- cleanup person/event/entity ----
  cmds
    .command('relation.cleanup.person <id:text>', t('cleanupPersonDescription'), { visibility: 'restricted' })
    .argument('id', 'platform:userId')
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id.includes(':')) return t('badPersonId');
      const [platform, userId] = id.split(':', 2);
      const r = await service.deletePerson(platform!, userId!);
      return t('nodeDeleted', { kind: 'person', id, edges: r.deletedEdges });
    });

  // ---- forget-me：用户自助清理自己的节点 ----
  // 注意：只能清掉「自己作为发言者」被记录的节点和直接挂在节点上的边；
  // 别人在事件 title / evidence 里**提及**你的名字（纯字符串）无法清理——
  // 因为这种情况下系统压根没把"你"识别为一个节点，没有 id 可定位。
  cmds.command('relation.forget-me', t('forgetMeDescription')).action(async argv => {
    const { platform, userId } = argv.session;
    if (!platform || !userId) return t('noIdentity');
    const id = `${platform}:${userId}`;
    const snap = await service.loadAll();
    const exists = snap.persons.some(p => p.id === id);
    if (!exists) return t('notInGraph', { id });
    const r = await service.deletePerson(platform, userId);
    return t('selfDeleted', { id, edges: r.deletedEdges });
  });

  cmds
    .command('relation.cleanup.event <id:text>', t('cleanupEventDescription'), { visibility: 'restricted' })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id) return t('needId', { kind: 'event' });
      const r = await service.deleteEvent(id);
      return t('nodeDeleted', { kind: 'event', id, edges: r.deletedEdges });
    });

  cmds
    .command('relation.cleanup.entity <id:text>', t('cleanupEntityDescription'), { visibility: 'restricted' })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id) return t('needId', { kind: 'entity' });
      const r = await service.deleteEntity(id);
      return t('nodeDeleted', { kind: 'entity', id, edges: r.deletedEdges });
    });

  cmds
    .command('relation.cleanup.orphans', t('cleanupOrphansDescription'), { visibility: 'restricted' })
    .action(async () => {
      const r = await service.pruneOrphans();
      return t('orphansPruned', {
        total: r.deletedPersons + r.deletedEvents + r.deletedEntities,
        persons: r.deletedPersons,
        events: r.deletedEvents,
        entities: r.deletedEntities,
        edges: r.deletedDanglingEdges,
      });
    });

  cmds
    .command('relation.cleanup.all', t('cleanupAllDescription'), {
      visibility: 'restricted',
    })
    .option('yes', '--yes', { description: t('yesOption') })
    .action(async argv => {
      if (argv.options.yes !== true) {
        return t('cleanupAllWarning');
      }
      // 一次批量提交（sqlite/inmemory 原子，mongodb 仅按序遇错即停、可幂等重清），
      // 不逐节点级联：后者每删一个节点付 2 次全图读，
      // 生产图规模下要跑数分钟且中途失败会留下半张图（见 service.clearAll 的注释）。
      const cleared = await service.clearAll(logger);
      return t('graphCleared', { count: cleared });
    });

  let renderWarned = false;
  /** 按会话的语言渲染立即回执出错：这次按原文发出，告警一次，之后不再告警 */
  const onRenderError = (err: unknown) => {
    if (renderWarned) return;
    renderWarned = true;
    logger.warn('按会话的语言渲染立即回执出错，按原文发出（之后再出错不再告警）:', err);
  };

  /**
   * 长任务前的"立即反馈"：fire-and-forget 推送一条 ack 给当前会话（按这个会话的语言渲染；读者只带会话 id，不带
   * ExecutionInput 的 platform：那是调用者身份的平台），
   * 让用户知道命令已被接到、正在跑（consolidate/compress 在大图上可能跑数秒到数十秒）。
   * - 只推给有平台适配器认领的会话（定时任务发进群里的也推）；没有认领者的会话（如编排的内部会话）没有人在等，不推
   * - 推送失败静默，不 await 完成，纯并发
   */
  function ackBackground(sessionId: string, text: TextRef): void {
    void (async () => {
      const adapter = await resolvePlatformBySession(platform, sessionId, logger);
      await adapter?.use.sendMessage(sessionId, localizeFor(i18n, text, { sessionId }, { onError: onRenderError }));
    })().catch(err => {
      logger.debug(`[user-relation] 立即反馈推送失败（可忽略）：${(err as Error).message}`);
    });
  }

  /**
   * 进程内 per-command mutex：避免用户连按两次 /relation maintain 等长任务命令时
   * 后台叠加两份相同写流程（PageRank / consolidate LLM 都很贵且会改图，并发跑会
   * 互相覆盖统计、白白浪费 token）。第二次调用立即返回 ack 文本，不阻塞 commands
   * 路由。锁的粒度是**命令名**，跨命令仍可并发（与原有行为一致）。
   */
  const runningCommands = new Map<string, number>(); // commandName → startedAt epoch ms
  function tryAcquireCommand(name: string): { ok: true } | { ok: false; elapsedSec: number } {
    const startedAt = runningCommands.get(name);
    if (startedAt !== undefined) {
      return { ok: false, elapsedSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)) };
    }
    runningCommands.set(name, Date.now());
    return { ok: true };
  }
  function releaseCommand(name: string): void {
    runningCommands.delete(name);
  }

  /** consolidate / maintain 共用的 consolidate 选项 */
  function buildConsolidateOpts(autoLink: boolean, useLlm: boolean): Parameters<RelationService['consolidate']>[0] {
    return {
      autoLink,
      triggerSource: 'manual',
      skipLowScorePairs: options.consolidateSkipLowScorePairs,
      lowScoreThreshold: options.consolidateLowScoreThreshold,
      ...(useLlm && options.consolidateLLM
        ? {
            llm: {
              models: llm,
              modelRef: options.consolidateLLM.modelRef,
              disableThinking: options.consolidateLLM.disableThinking,
            },
          }
        : {}),
    };
  }

  /** compress / maintain 共用的 evictByQuota 配额 */
  function buildEvictQuota(ev: EvictionConfig): Parameters<RelationService['evictByQuota']>[0] {
    return {
      maxPersons: ev.maxPersons,
      maxEvents: ev.maxEvents,
      maxEntities: ev.maxEntities,
      maxEdges: ev.maxEdges,
      pagerankDamping: ev.pagerankDamping,
      pagerankIterations: ev.pagerankIterations,
      pagerankEpsilon: ev.pagerankEpsilon,
      hysteresisPct: ev.hysteresisPct,
      targetPct: ev.targetPct,
      decay: {
        halfLifeDays: ev.weightDecayHalfLifeDays,
        floor: ev.weightDecayFloor,
      },
      communityAlgorithm: ev.communityAlgorithm,
    };
  }

  // ---- consolidate（整理：别名候选 / 旧账去重） ----
  cmds
    .command('relation.consolidate', t('consolidateDescription'), {
      visibility: 'restricted',
    })
    .option('auto-link', '--auto-link', { description: t('autoLinkOption') })
    .option('no-llm', '--no-llm', { description: t('noLlmOption') })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.consolidate');
      if (!gate.ok) return t('busy', { command: 'consolidate', seconds: gate.elapsedSec });
      try {
        const autoLink = argv.options['auto-link'] === true;
        const useLlm = argv.options['no-llm'] !== true && !!options.consolidateLLM;
        ackBackground(
          argv.session.sessionId,
          t('ackConsolidate', { autoLink: autoLink ? 'on' : 'off', llm: useLlm ? 'on' : 'off' }),
        );
        const r = await service.consolidate(buildConsolidateOpts(autoLink, useLlm));
        const lines: Array<string | TextRef> = [
          t('consolidated'),
          t('consolidatedAliases', {
            candidates: r.aliasCandidates.length,
            autoLink: autoLink ? 'on' : 'off',
            edges: r.aliasEdgesCreated,
          }),
          t('consolidatedEventEdges', { groups: r.eventEdgesNormalized }),
          t('consolidatedHierarchy', { candidates: r.entityHierarchyCandidates, edges: r.entityHierarchyEdgesCreated }),
          t('consolidatedLateral', {
            clusters: r.lateralParentCandidates,
            parents: r.lateralParentsCreated,
            edges: r.lateralEdgesCreated,
          }),
        ];
        if (useLlm) {
          lines.push(
            t('consolidatedLlm', {
              verified: r.llmVerified ?? 0,
              rejected: r.llmRejected ?? 0,
              rewritten: r.summariesRewritten ?? 0,
            }),
          );
        }
        if (r.aliasCandidates.length > 0) {
          lines.push('', t('aliasCandidatesHead'));
          for (const c of r.aliasCandidates.slice(0, 10)) {
            lines.push(`  · [${c.aKind}] ${c.aId}  ↔  [${c.bKind}] ${c.bId}  —  ${c.reason}`);
          }
        }
        return textLines(lines);
      } finally {
        releaseCommand('relation.consolidate');
      }
    });

  // ---- rewrite-weights（手动触发 eager 时间衰减回写） ----
  cmds
    .command('relation.rewrite-weights', t('rewriteWeightsDescription'), { visibility: 'restricted' })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.rewrite-weights');
      if (!gate.ok) return t('busy', { command: 'rewrite-weights', seconds: gate.elapsedSec });
      try {
        const { weightDecayHalfLifeDays: halfLifeDays, weightDecayFloor: floor } = options.eviction;
        if (halfLifeDays <= 0) {
          return t('decayOff', { halfLifeDays });
        }
        ackBackground(argv.session.sessionId, t('ackRewrite', { halfLifeDays, floor }));
        const r = await service.rewriteWeights({ halfLifeDays, floor });
        if (r.skipped) {
          return t('decaySkipped');
        }
        return textLines([
          t('rewritten'),
          t('rewrittenEvents', { count: r.events }),
          t('rewrittenEntities', { count: r.entities }),
          t('rewrittenEdges', { count: r.edges }),
          t('rewrittenParameters', { halfLifeDays, floor }),
        ]);
      } finally {
        releaseCommand('relation.rewrite-weights');
      }
    });

  // ---- event-duplicates（dry-run：列出 event 重复合并候选，不实际合并） ----
  cmds
    .command('relation.event-duplicates', t('eventDuplicatesDescription'), { visibility: 'restricted' })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.event-duplicates');
      if (!gate.ok) return t('busy', { command: 'event-duplicates', seconds: gate.elapsedSec });
      try {
        ackBackground(argv.session.sessionId, t('ackDuplicates'));
        const r = await service.findEventDuplicates({
          ...(options.consolidateLLM
            ? {
                llm: {
                  models: llm,
                  modelRef: options.consolidateLLM.modelRef,
                  disableThinking: options.consolidateLLM.disableThinking,
                },
              }
            : {}),
        });
        const lines: TextRef[] = [
          r.embeddingAvailable ? t('duplicatesScanned') : t('duplicatesScannedJaccard'),
          t('duplicatesCounted', {
            candidates: r.candidates.length,
            verified: r.llmVerified,
            rejected: r.llmRejected,
            cacheHits: r.llmRejectCacheHits,
          }),
        ];
        if (r.candidates.length > 0) {
          lines.push(t('duplicatesHead'));
          for (const c of r.candidates.slice(0, 20)) {
            const scores =
              c.fusedScore !== null
                ? `fused=${c.fusedScore.toFixed(2)} (cos=${c.cosineScore?.toFixed(2)}, struct=${c.structuralScore.toFixed(2)})`
                : `jac=${c.jaccardScore.toFixed(2)}, struct=${c.structuralScore.toFixed(2)}`;
            const verdict = c.llmVerdict
              ? t(c.cacheHit ? 'verdictCached' : c.llmVerdict.isSame ? 'verdictPassed' : 'verdictRejected', {
                  reason: c.llmVerdict.reason,
                })
              : t('verdictNone');
            lines.push(
              t('duplicateLine', {
                scope: c.sessionScope,
                a: c.aTitle.slice(0, 18),
                b: c.bTitle.slice(0, 18),
                scores,
                verdict,
              }),
            );
          }
          if (r.candidates.length > 20) {
            lines.push(t('duplicatesOmitted', { count: r.candidates.length - 20 }));
          }
        }
        return textLines(lines);
      } finally {
        releaseCommand('relation.event-duplicates');
      }
    });

  // ---- compress（仅跳出一次容量淘汰 + 伤亡报告） ----
  cmds
    .command('relation.compress', t('compressDescription'), {
      visibility: 'restricted',
    })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.compress');
      if (!gate.ok) return t('busy', { command: 'compress', seconds: gate.elapsedSec });
      try {
        const ev = options.eviction;
        ackBackground(argv.session.sessionId, t('ackCompress'));
        const before = await service.loadAll();
        let deletedPersons = 0;
        let deletedEvents = 0;
        let deletedEntities = 0;
        let deletedEdges = 0;
        if (ev.maxPersons > 0 || ev.maxEvents > 0 || ev.maxEntities > 0 || ev.maxEdges > 0) {
          // evictByQuota 内部已经先做 pruneOrphans，再做配额淘汰；不要在外面重复调
          const r = await service.evictByQuota(buildEvictQuota(ev));
          deletedPersons = r.deletedPersons;
          deletedEvents = r.deletedEvents;
          deletedEntities = r.deletedEntities;
          deletedEdges = r.deletedEdges;
        } else {
          // 没配置配额：只清孤儿
          const orphans = await service.pruneOrphans();
          deletedPersons = orphans.deletedPersons;
          deletedEvents = orphans.deletedEvents;
          deletedEntities = orphans.deletedEntities;
        }
        return textLines([
          t('compressed'),
          t('compressedPersons', {
            before: before.persons.length,
            after: before.persons.length - deletedPersons,
            deleted: deletedPersons,
          }),
          t('compressedEvents', {
            before: before.events.length,
            after: before.events.length - deletedEvents,
            deleted: deletedEvents,
            max: ev.maxEvents,
          }),
          t('compressedEntities', {
            before: before.entities.length,
            after: before.entities.length - deletedEntities,
            deleted: deletedEntities,
            max: ev.maxEntities,
          }),
          t('compressedEdges', {
            before: before.edges.length,
            after: before.edges.length - deletedEdges,
            deleted: deletedEdges,
            max: ev.maxEdges,
          }),
        ]);
      } finally {
        releaseCommand('relation.compress');
      }
    });

  // ---- maintain（整理 + 压缩 一步完成） ----
  cmds
    .command('relation.maintain', t('maintainDescription'), { visibility: 'restricted' })
    .option('no-llm', '--no-llm', { description: t('maintainNoLlmOption') })
    .option('no-auto-link', '--no-auto-link', { description: t('maintainNoAutoLinkOption') })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.maintain');
      if (!gate.ok) return t('busy', { command: 'maintain', seconds: gate.elapsedSec });
      try {
        const ev = options.eviction;
        const useLlm = argv.options['no-llm'] !== true && !!options.consolidateLLM;
        const autoLink = argv.options['no-auto-link'] !== true && options.consolidateAutoLink;
        ackBackground(
          argv.session.sessionId,
          t('ackMaintain', { autoLink: autoLink ? 'on' : 'off', llm: useLlm ? 'on' : 'off' }),
        );

        // 顺序：先 consolidate（在原图上合并别名/层级/事件去重）→ 再 evict（在去重后的图上
        // 跑 PageRank 淘汰），这样 PageRank 看到的入出度更完整、淘汰决策更稳，且每个阶段的
        // 节点/边减量都可以独立精确计数（s0 → s1 为整理，s1 → s2 为压缩），不会再像之前
        // "实体 87→87 但下一轮变 85→85" 那样把 consolidate 删的 alias 节点漏算到压缩行。
        const s0 = await service.loadAll();

        // step 1: consolidate
        const cr = await service.consolidate(buildConsolidateOpts(autoLink, useLlm));
        const s1 = await service.loadAll();

        // step 2: compress
        let evictionMode: 'quota' | 'orphans-only' = 'orphans-only';
        if (ev.maxPersons > 0 || ev.maxEvents > 0 || ev.maxEntities > 0 || ev.maxEdges > 0) {
          evictionMode = 'quota';
          await service.evictByQuota(buildEvictQuota(ev));
        } else {
          await service.pruneOrphans();
        }
        const s2 = await service.loadAll();

        // 报告：先整理后压缩，每行只反映本阶段的真实减量；整理一行的 LLM 增强是另一句，以「，」相连
        const consolidated = t('maintainConsolidated', {
          persons0: s0.persons.length,
          persons1: s1.persons.length,
          events0: s0.events.length,
          events1: s1.events.length,
          entities0: s0.entities.length,
          entities1: s1.entities.length,
          edges0: s0.edges.length,
          edges1: s1.edges.length,
          aliasCandidates: cr.aliasCandidates.length,
          aliasEdges: cr.aliasEdgesCreated,
          eventEdges: cr.eventEdgesNormalized,
          hierarchyCandidates: cr.entityHierarchyCandidates,
          hierarchyEdges: cr.entityHierarchyEdgesCreated,
          lateralCandidates: cr.lateralParentCandidates,
          lateralParents: cr.lateralParentsCreated,
          lateralEdges: cr.lateralEdgesCreated,
        });
        const consolidateLine = useLlm
          ? t('andThen', {
              head: consolidated,
              tail: t('consolidateLlm', {
                verified: cr.llmVerified ?? 0,
                rejected: cr.llmRejected ?? 0,
                rewritten: cr.summariesRewritten ?? 0,
              }),
            })
          : consolidated;
        const sizes = {
          persons1: s1.persons.length,
          persons2: s2.persons.length,
          events1: s1.events.length,
          events2: s2.events.length,
          entities1: s1.entities.length,
          entities2: s2.entities.length,
          edges1: s1.edges.length,
          edges2: s2.edges.length,
        };
        const compressLine =
          evictionMode === 'quota' ? t('maintainCompressed', sizes) : t('maintainOrphansOnly', sizes);
        return textLines([t('maintained'), consolidateLine, compressLine]);
      } finally {
        releaseCommand('relation.maintain');
      }
    });

  // ---- consolidation-status（查询最近一次 consolidate 运行情况） ----
  cmds.command('relation.consolidation-status', t('consolidationStatusDescription')).action(async () => {
    const last = service.getLastConsolidateInfo();
    if (!last) return t('notConsolidatedYet');
    return t('lastConsolidation', {
      at: last.at,
      trigger: TRIGGER_NAMES[last.trigger],
      summary: consolidateSummary(last.counts),
    });
  });
}

// ───── helpers ─────

function formatPerson(p: PersonNode, events: EventNode[], entities: EntityNode[], edges: RelationEdge[]): string {
  const lines = [`# Person ${p.id}`, `displayName: ${p.displayName ?? '—'}`];
  lines.push(`events (${events.length}):`);
  for (const e of events.slice(0, 20)) lines.push(`  - ${e.id}  ${e.title}`);
  lines.push(`entities (${entities.length}):`);
  for (const e of entities.slice(0, 20)) lines.push(`  - ${e.id}  [${e.entityKind}] ${e.name}`);
  lines.push(`edges (${edges.length}):`);
  for (const e of edges.slice(0, 20)) lines.push(`  - ${formatEdgeLine(e)}`);
  return lines.join('\n');
}

function formatEvent(e: EventNode, edges: RelationEdge[]): string {
  const lines = [`# Event ${e.id}`, `title: ${e.title}`];
  if (e.category) lines.push(`category: ${e.category}`);
  if (e.summary) lines.push(`summary: ${e.summary}`);
  lines.push(`edges (${edges.length}):`);
  for (const ed of edges.slice(0, 30)) lines.push(`  - ${formatEdgeLine(ed)}`);
  return lines.join('\n');
}

function formatEntity(ent: EntityNode, edges: RelationEdge[]): string {
  const lines = [`# Entity ${ent.id}`, `name: ${ent.name}`, `kind: ${ent.entityKind}`];
  if (ent.aliases?.length) lines.push(`aliases: ${ent.aliases.join(', ')}`);
  if (ent.summary) lines.push(`summary: ${ent.summary}`);
  lines.push(`edges (${edges.length}):`);
  for (const ed of edges.slice(0, 30)) lines.push(`  - ${formatEdgeLine(ed)}`);
  return lines.join('\n');
}

function formatEdgeLine(e: RelationEdge): string {
  if (e.kind === 'person-event') return `[${e.kind}] ${e.fromPersonId} → ${e.toEventId} (${e.role})`;
  if (e.kind === 'person-person') return `[${e.kind}] ${e.fromPersonId} → ${e.toPersonId} (${e.relationType})`;
  if (e.kind === 'person-entity') return `[${e.kind}] ${e.fromPersonId} → ${e.toEntityId} (${e.role})`;
  if (e.kind === 'event-event') return `[event-event] ${e.fromEventId} → ${e.toEventId} (${e.relationType})`;
  if (e.kind === 'event-entity') return `[event-entity] ${e.fromEventId} → ${e.toEntityId} (${e.relationType})`;
  return `[entity-entity] ${e.fromEntityId} → ${e.toEntityId} (${e.relationType})`;
}
