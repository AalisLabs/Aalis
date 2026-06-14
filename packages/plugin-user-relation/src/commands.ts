/**
 * /relation —— 关系图查看与清理指令。
 *
 * 命令清单（默认前缀由 plugin-commands 配置）：
 * - `relation show person|event|entity <id>`：打印目标节点 + 直连边
 * - `relation orphans`：列出"孤立点"（不被任何边引用的 person/event/entity）
 * - `relation cleanup person <id>` / `... event <id>` / `... entity <id>`：删该节点 + 级联边（authority=3）
 * - `relation cleanup orphans`：一键清理所有孤立点（authority=3）
 * - `relation cleanup all`：清空整个关系图（authority=4, dangerous，需要二次确认 --yes）
 */
import type { Context } from '@aalis/core';
import { useCommandService } from '@aalis/plugin-commands-api';
import { sendPlatformMessage } from '@aalis/plugin-platform-api';
import { getKnownPlatformsLower, isPlaceholderSelfPersonId } from './extractor.js';
import type { RelationService } from './service.js';
import type { EntityNode, EventNode, PersonNode, RelationEdge } from './types.js';

export function registerRelationCommands(
  ctx: Context,
  service: RelationService,
  options?: {
    consolidateLLM?: { modelRef: { provider: string; model: string }; disableThinking?: boolean };
    /** 淘汰配置；/relation compress 与 /relation maintain 会使用 */
    eviction?: {
      maxPersons: number;
      maxEvents: number;
      maxEntities: number;
      maxEdges: number;
      pagerankDamping: number;
      pagerankIterations: number;
      pagerankEpsilon: number;
      hysteresisPct: number;
      targetPct: number;
      /** Weight 时间衰减半衰期（天），0=关闭。默认 180 */
      weightDecayHalfLifeDays?: number;
      /** Weight 衰减下限因子。默认 0.3 */
      weightDecayFloor?: number;
      /** 社群发现算法；默认 'louvain'。 */
      communityAlgorithm?: 'louvain' | 'leiden' | 'slpa';
    };
    /** consolidate 是否默认开 autoLink（/relation maintain 需要） */
    consolidateAutoLink?: boolean;
    /** F3：宽召回低权 pair 跳过 LLM 核验 */
    consolidateSkipLowScorePairs?: boolean;
    /** F3：低权阈值（默认 0.2，0 = 不跳过） */
    consolidateLowScoreThreshold?: number;
  },
): void {
  const cmds = useCommandService(ctx);

  // ---- show ----
  cmds
    .command('relation.show <kind:string> <id:text>', '查看关系图中某节点及其直连边')
    .example('relation show person onebot:1234567')
    .example('relation show entity 9f3a2b...')
    .action(async (_argv, kindArg, idArg) => {
      const kind = String(kindArg ?? '').toLowerCase();
      const id = String(idArg ?? '').trim();
      if (!id) return '用法: relation show <person|event|entity> <id>';
      const snap = await service.loadAll();
      if (kind === 'person') {
        if (!id.includes(':')) return 'person id 应为 platform:userId';
        const p = snap.persons.find(x => x.id === id);
        if (!p) return `未找到 person: ${id}`;
        const nb = await service.getNeighborhood(id);
        return formatPerson(p, nb.events, nb.entities, nb.edges);
      }
      if (kind === 'event') {
        const e = snap.events.find(x => x.id === id);
        if (!e) return `未找到 event: ${id}`;
        const edges = snap.edges.filter(
          ed =>
            (ed.kind === 'person-event' && ed.toEventId === id) ||
            (ed.kind === 'event-event' && (ed.fromEventId === id || ed.toEventId === id)),
        );
        return formatEvent(e, edges);
      }
      if (kind === 'entity') {
        const ent = snap.entities.find(x => x.id === id);
        if (!ent) return `未找到 entity: ${id}`;
        const edges = snap.edges.filter(ed => ed.kind === 'person-entity' && ed.toEntityId === id);
        return formatEntity(ent, edges);
      }
      return `未知 kind: ${kind}（应为 person / event / entity）`;
    });

  // ---- orphans (list) ----
  cmds.command('relation.orphans', '列出图中所有孤立点（不被任何边引用）').action(async () => {
    const snap = await service.loadAll();
    const { orphanPersons, orphanEvents, orphanEntities } = collectOrphans(snap);
    if (orphanPersons.length + orphanEvents.length + orphanEntities.length === 0) {
      return '✓ 无孤立点。';
    }
    const lines: string[] = ['# 孤立点'];
    if (orphanPersons.length) {
      lines.push(`## 人物 (${orphanPersons.length})`);
      for (const p of orphanPersons) lines.push(`- ${p.id}  ${p.displayName ?? ''}`);
    }
    if (orphanEvents.length) {
      lines.push(`## 事件 (${orphanEvents.length})`);
      for (const e of orphanEvents) lines.push(`- ${e.id}  ${e.title}`);
    }
    if (orphanEntities.length) {
      lines.push(`## 实体 (${orphanEntities.length})`);
      for (const e of orphanEntities) lines.push(`- ${e.id}  [${e.entityKind}] ${e.name}`);
    }
    return lines.join('\n');
  });

  // ---- cleanup person/event/entity ----
  cmds
    .command('relation.cleanup.person <id:text>', '删除人物及其所有相关边', { visibility: 'restricted' })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id.includes(':')) return 'person id 应为 platform:userId';
      const [platform, userId] = id.split(':', 2);
      const r = await service.deletePerson(platform!, userId!);
      return `✓ 已删除 person ${id}（级联 ${r.deletedEdges} 条边）`;
    });

  // ---- forget-me：用户自助清理自己的节点 ----
  // 注意：只能清掉「自己作为发言者」被记录的节点和直接挂在节点上的边；
  // 别人在事件 title / evidence 里**提及**你的名字（纯字符串）无法清理——
  // 因为这种情况下系统压根没把"你"识别为一个节点，没有 id 可定位。
  cmds
    .command('relation.forget-me', '清理我自己在关系图中的节点与直接关联（不清理别人对我的文本提及）')
    .action(async argv => {
      const { platform, userId } = argv.session;
      if (!platform || !userId) return '当前会话无法识别你的身份（缺少 platform / userId）';
      const id = `${platform}:${userId}`;
      const snap = await service.loadAll();
      const exists = snap.persons.some(p => p.id === id);
      if (!exists) return `✓ 关系图中没有你的节点（${id}），无需清理。`;
      const r = await service.deletePerson(platform, userId);
      return `✓ 已删除你的节点 ${id}（级联 ${r.deletedEdges} 条边）。注意：别人在事件文本中提到你的字符串不会被清理。`;
    });

  cmds
    .command('relation.cleanup.event <id:text>', '删除事件及其所有相关边', { visibility: 'restricted' })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id) return '请提供 event id';
      const r = await service.deleteEvent(id);
      return `✓ 已删除 event ${id}（级联 ${r.deletedEdges} 条边）`;
    });

  cmds
    .command('relation.cleanup.entity <id:text>', '删除实体及其所有相关边', { visibility: 'restricted' })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id) return '请提供 entity id';
      const r = await service.deleteEntity(id);
      return `✓ 已删除 entity ${id}（级联 ${r.deletedEdges} 条边）`;
    });

  cmds.command('relation.cleanup.orphans', '一键清理所有孤立点', { visibility: 'restricted' }).action(async () => {
    const snap = await service.loadAll();
    const { orphanPersons, orphanEvents, orphanEntities } = collectOrphans(snap);
    let deleted = 0;
    for (const p of orphanPersons) {
      await service.deletePerson(p.platform, p.userId);
      deleted++;
    }
    for (const e of orphanEvents) {
      await service.deleteEvent(e.id);
      deleted++;
    }
    for (const e of orphanEntities) {
      await service.deleteEntity(e.id);
      deleted++;
    }
    return `✓ 已清理 ${deleted} 个孤立点（人物 ${orphanPersons.length} / 事件 ${orphanEvents.length} / 实体 ${orphanEntities.length}）`;
  });

  // ---- cleanup fake-self ----
  // 专门清理 LLM 误抽出的「伪 person」占位：platform 不在运行时白名单
  // (`getPlatformNames(ctx)`) 中，或者 userId 命中通用占位词 `{self, me, bot, assistant}`。
  // 以往的「aalis:aalis / aalis:self / onebot:aalis」都被该规则覆盖，且同时 persona-agnostic
  // （改 persona 名为 Mia / 任意名字都不需要改代码）。依赖 extractor.isPlaceholderSelfPersonId
  // 保证与写入守卫、consolidate 三处口径一致。
  cmds
    .command(
      'relation.cleanup.fake-self',
      '清理 LLM 误抽的伪 person（platform 不在运行时白名单或 userId 为 self/me/bot/assistant）',
      {
        visibility: 'restricted',
      },
    )
    .option('dry-run', '--dry-run', { description: '只列出会被删的节点，不实际删除' })
    .action(async argv => {
      const snap = await service.loadAll();
      const knownPlatforms = getKnownPlatformsLower(ctx);
      const fakes = snap.persons.filter(p => isPlaceholderSelfPersonId(p.platform, p.userId, knownPlatforms));
      if (fakes.length === 0) return '✓ 未发现伪 person。';
      const dry = argv.options['dry-run'] === true;
      const lines: string[] = [
        dry ? `[dry-run] 将删除 ${fakes.length} 个伪 person：` : `已删除 ${fakes.length} 个伪 person：`,
      ];
      let edgesTotal = 0;
      for (const p of fakes) {
        if (dry) {
          const incident = snap.edges.filter(
            ed =>
              (ed.kind === 'person-event' && ed.fromPersonId === p.id) ||
              (ed.kind === 'person-entity' && ed.fromPersonId === p.id) ||
              (ed.kind === 'person-person' && (ed.fromPersonId === p.id || ed.toPersonId === p.id)),
          );
          lines.push(`- ${p.id}  ${p.displayName ?? ''}  (级联 ${incident.length} 边)`);
          edgesTotal += incident.length;
        } else {
          const r = await service.deletePerson(p.platform, p.userId);
          lines.push(`- ${p.id}  ${p.displayName ?? ''}  (级联删 ${r.deletedEdges} 边)`);
          edgesTotal += r.deletedEdges;
        }
      }
      lines.push(
        dry ? `[dry-run] 合计会级联删 ${edgesTotal} 边。去掉 --dry-run 实际执行。` : `合计级联删 ${edgesTotal} 边。`,
      );
      return lines.join('\n');
    });

  cmds
    .command('relation.cleanup.all', '⚠ 危险：清空整个关系图（需要 --yes 确认）', {
      visibility: 'restricted',
    })
    .option('yes', '--yes', { description: '确认执行' })
    .action(async argv => {
      if (argv.options.yes !== true) {
        return '⚠ 该操作将删除所有人物 / 事件 / 实体 / 边。如确实需要，请追加 --yes。';
      }
      const snap = await service.loadAll();
      let n = 0;
      for (const p of snap.persons) {
        await service.deletePerson(p.platform, p.userId);
        n++;
      }
      for (const e of snap.events) {
        await service.deleteEvent(e.id);
        n++;
      }
      for (const e of snap.entities) {
        await service.deleteEntity(e.id);
        n++;
      }
      return `✓ 已清空关系图（删除 ${n} 个节点）`;
    });

  /**
   * 长任务前的"立即反馈"：fire-and-forget 推送一条 ack 给当前会话，
   * 让用户知道命令已被接到、正在跑（consolidate/compress 在大图上可能跑数秒到数十秒）。
   * - 失败静默（CLI 会话没有 platform adapter 会抛错，不影响主流程）
   * - 不 await 完成，纯并发
   */
  function ackBackground(sessionId: string, platform: string, text: string): void {
    // internal 平台（scheduler / workflow 等系统触发）没有真实用户等待，跳过推送
    if (platform === 'internal') return;
    void sendPlatformMessage(ctx, sessionId, text).catch(err => {
      ctx.logger?.debug?.(`[user-relation] 立即反馈推送失败（可忽略）：${(err as Error).message}`);
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

  // ---- consolidate（整理：别名候选 / 自动 part-of / 旧账去重） ----
  cmds
    .command('relation.consolidate', '整理关系图：扫描别名候选、自动 part-of、规范化 PersonEventEdge', {
      visibility: 'restricted',
    })
    .option('auto-link', '--auto-link', { description: '将高置信别名候选自动建为 is-alias-of 边' })
    .option('no-llm', '--no-llm', { description: '跳过 consolidationModel 配置的 LLM 增强（A 核验 + B 摘要重写）' })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.consolidate');
      if (!gate.ok) return `⏳ 上一次 /relation consolidate 还在跑（已累计 ${gate.elapsedSec}s），请稍后再试…`;
      try {
        const autoLink = argv.options['auto-link'] === true;
        const useLlm = argv.options['no-llm'] !== true && !!options?.consolidateLLM;
        ackBackground(
          argv.session.sessionId,
          argv.session.platform,
          `⏳ 正在整理关系图（autoLink=${autoLink ? 'on' : 'off'}，LLM=${useLlm ? 'on' : 'off'}），请稍候…`,
        );
        const r = await service.consolidate({
          autoLink,
          triggerSource: 'manual',
          ctx,
          ...(options?.consolidateSkipLowScorePairs !== undefined
            ? { skipLowScorePairs: options.consolidateSkipLowScorePairs }
            : {}),
          ...(options?.consolidateLowScoreThreshold !== undefined
            ? { lowScoreThreshold: options.consolidateLowScoreThreshold }
            : {}),
          ...(useLlm && options?.consolidateLLM
            ? {
                llm: {
                  ctx,
                  modelRef: options.consolidateLLM.modelRef,
                  disableThinking: options.consolidateLLM.disableThinking ?? true,
                },
              }
            : {}),
        });
        const lines = [
          '关系图整理完成：',
          `- 别名候选：${r.aliasCandidates.length} 对（auto-link=${autoLink ? 'on' : 'off'}，已建 ${r.aliasEdgesCreated} 条 is-alias-of 边）`,
          `- 自动 part-of：新增 ${r.partOfEdgesCreated} 条 event-entity[part-of] 边`,
          `- EventEntityEdge 去重：${r.eventEdgesNormalized} 组重整`,
          `- 实体层级候选：${r.entityHierarchyCandidates} 对，新增 ${r.entityHierarchyEdgesCreated} 条 entity-entity[part-of] 边`,
          `- 侧向父候选：${r.lateralParentCandidates} 簇，新建父实体 ${r.lateralParentsCreated} 个，新增 ${r.lateralEdgesCreated} 条侧向 part-of 边`,
        ];
        if (useLlm) {
          lines.push(
            `- LLM 核验：通过 ${r.llmVerified ?? 0}，否决 ${r.llmRejected ?? 0}；摘要重写 ${r.summariesRewritten ?? 0} 条`,
          );
        }
        if (r.aliasCandidates.length > 0) {
          lines.push('', '别名候选（前 10 条）：');
          for (const c of r.aliasCandidates.slice(0, 10)) {
            lines.push(`  · [${c.aKind}] ${c.aId}  ↔  [${c.bKind}] ${c.bId}  —  ${c.reason}`);
          }
        }
        return lines.join('\n');
      } finally {
        releaseCommand('relation.consolidate');
      }
    });

  // ---- rewrite-weights（手动触发 eager 时间衰减回写） ----
  cmds
    .command(
      'relation.rewrite-weights',
      '关系图：把 event/entity/edge 的 weight 字段物理回写为当前 effectiveWeight（时间衰减落地）',
      { visibility: 'restricted' },
    )
    .action(async argv => {
      const gate = tryAcquireCommand('relation.rewrite-weights');
      if (!gate.ok) return `⏳ 上一次 /relation rewrite-weights 还在跑（已累计 ${gate.elapsedSec}s），请稍后再试…`;
      try {
        const ev = options?.eviction;
        const halfLifeDays = ev?.weightDecayHalfLifeDays ?? 180;
        const floor = ev?.weightDecayFloor ?? 0.3;
        if (halfLifeDays <= 0) {
          return `weight 衰减未启用（halfLifeDays=${halfLifeDays}），无需回写。`;
        }
        ackBackground(
          argv.session.sessionId,
          argv.session.platform,
          `⏳ 正在按 halfLifeDays=${halfLifeDays}、floor=${floor} 回写 weight，请稍候…`,
        );
        const r = await service.rewriteWeights({ halfLifeDays, floor });
        if (r.skipped) {
          return 'weight 衰减未启用，已跳过。';
        }
        return [
          '✓ weight 时间衰减回写完成：',
          `- 事件：写回 ${r.events} 条`,
          `- 实体：写回 ${r.entities} 条`,
          `- 边：  写回 ${r.edges} 条`,
          `（参数：halfLifeDays=${halfLifeDays}, floor=${floor}）`,
        ].join('\n');
      } finally {
        releaseCommand('relation.rewrite-weights');
      }
    });

  // ---- event-duplicates（dry-run：列出 event 重复合并候选，不实际合并） ----
  cmds
    .command(
      'relation.event-duplicates',
      '关系图：扫描事件节点重复合并候选（dry-run，不修改图）。三段式：embedding/jaccard + 结构相似 + LLM 终判',
      { visibility: 'restricted' },
    )
    .action(async argv => {
      const gate = tryAcquireCommand('relation.event-duplicates');
      if (!gate.ok) return `⏳ 上一次 /relation event-duplicates 还在跑（已累计 ${gate.elapsedSec}s），请稍后再试…`;
      try {
        ackBackground(
          argv.session.sessionId,
          argv.session.platform,
          '⏳ 正在扫描 event 重复候选（同 sessionScope / 都 global），请稍候…',
        );
        const useLlm = !!options?.consolidateLLM;
        const r = await service.findEventDuplicates({
          ...(useLlm && options?.consolidateLLM
            ? {
                llm: {
                  ctx,
                  modelRef: options.consolidateLLM.modelRef,
                  disableThinking: options.consolidateLLM.disableThinking ?? true,
                },
              }
            : {}),
        });
        const lines: string[] = [];
        lines.push(`✓ event 重复扫描完成（embedding ${r.embeddingAvailable ? '可用' : '不可用，降级 jaccard'}）`);
        lines.push(
          `候选 ${r.candidates.length} 对，LLM 通过 ${r.llmVerified}，LLM 否决 ${r.llmRejected}，缓存命中 ${r.llmRejectCacheHits}`,
        );
        if (r.candidates.length > 0) {
          lines.push('--- 候选明细（前 20 条）---');
          for (const c of r.candidates.slice(0, 20)) {
            const sims =
              c.fusedScore !== null
                ? `fused=${c.fusedScore.toFixed(2)} (cos=${c.cosineScore?.toFixed(2)}, struct=${c.structuralScore.toFixed(2)})`
                : `jac=${c.jaccardScore.toFixed(2)}, struct=${c.structuralScore.toFixed(2)}`;
            const verdict = c.llmVerdict
              ? `[${c.cacheHit ? '缓存' : c.llmVerdict.isSame ? '✓' : '✗'}] ${c.llmVerdict.reason}`
              : '[未判]';
            lines.push(
              `  · [${c.sessionScope}] ${c.aTitle.slice(0, 18)} ↔ ${c.bTitle.slice(0, 18)}  ${sims}  ${verdict}`,
            );
          }
          if (r.candidates.length > 20) {
            lines.push(`  …省略 ${r.candidates.length - 20} 条`);
          }
        }
        return lines.join('\n');
      } finally {
        releaseCommand('relation.event-duplicates');
      }
    });

  // ---- compress（仅跳出一次容量淘汰 + 伤亡报告） ----
  cmds
    .command('relation.compress', '关系图压缩：手动触发容量淘汰（PageRank 低分 → 删 events/entities/edges）', {
      visibility: 'restricted',
    })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.compress');
      if (!gate.ok) return `⏳ 上一次 /relation compress 还在跑（已累计 ${gate.elapsedSec}s），请稍后再试…`;
      try {
        const ev = options?.eviction;
        ackBackground(
          argv.session.sessionId,
          argv.session.platform,
          '⏳ 正在压缩关系图（孤儿清理 + PageRank 计算 + 容量淘汰），请稍候…',
        );
        const before = await service.loadAll();
        let deletedPersons = 0;
        let deletedEvents = 0;
        let deletedEntities = 0;
        let deletedEdges = 0;
        if (ev && (ev.maxPersons > 0 || ev.maxEvents > 0 || ev.maxEntities > 0 || ev.maxEdges > 0)) {
          // evictByQuota 内部已经先做 pruneOrphans，再做配额淘汰；不要在外面重复调
          const r = await service.evictByQuota({
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
              halfLifeDays: ev.weightDecayHalfLifeDays ?? 180,
              floor: ev.weightDecayFloor ?? 0.3,
            },
            communityAlgorithm: ev.communityAlgorithm,
          });
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
        const eventCap = ev?.maxEvents ?? 0;
        const entityCap = ev?.maxEntities ?? 0;
        const edgeCap = ev?.maxEdges ?? 0;
        return [
          '✓ 关系图压缩完成：',
          `- 人物：${before.persons.length} → ${before.persons.length - deletedPersons}（删 ${deletedPersons} 个孤儿）`,
          `- 事件：${before.events.length} → ${before.events.length - deletedEvents}（删 ${deletedEvents}，阈 ${eventCap}）`,
          `- 实体：${before.entities.length} → ${before.entities.length - deletedEntities}（删 ${deletedEntities}，阈 ${entityCap}）`,
          `- 边：  ${before.edges.length} → ${before.edges.length - deletedEdges}（删 ${deletedEdges}，阈 ${edgeCap}）`,
        ].join('\n');
      } finally {
        releaseCommand('relation.compress');
      }
    });

  // ---- maintain（整理 + 压缩 一步完成） ----
  cmds
    .command(
      'relation.maintain',
      '关系图体检：先整理（别名 / part-of / 层级 / 侧向父），再压缩（容量淘汰），全过程报告',
      { visibility: 'restricted' },
    )
    .option('no-llm', '--no-llm', { description: '跳过 consolidate 阶段的 LLM 增强' })
    .option('no-auto-link', '--no-auto-link', { description: '取消 consolidate 阶段的 autoLink' })
    .action(async argv => {
      const gate = tryAcquireCommand('relation.maintain');
      if (!gate.ok) return `⏳ 上一次 /relation maintain 还在跑（已累计 ${gate.elapsedSec}s），请稍后再试…`;
      try {
        const ev = options?.eviction;
        const useLlm = argv.options['no-llm'] !== true && !!options?.consolidateLLM;
        const autoLink = argv.options['no-auto-link'] !== true && (options?.consolidateAutoLink ?? true);
        ackBackground(
          argv.session.sessionId,
          argv.session.platform,
          `⏳ 正在体检关系图：先整理再压缩（autoLink=${autoLink ? 'on' : 'off'}，LLM=${useLlm ? 'on' : 'off'}），请稍候…`,
        );

        // 顺序：先 consolidate（在原图上合并别名/层级/事件去重）→ 再 evict（在去重后的图上
        // 跑 PageRank 淘汰），这样 PageRank 看到的入出度更完整、淘汰决策更稳，且每个阶段的
        // 节点/边减量都可以独立精确计数（s0 → s1 为整理，s1 → s2 为压缩），不会再像之前
        // "实体 87→87 但下一轮变 85→85" 那样把 consolidate 删的 alias 节点漏算到压缩行。
        const s0 = await service.loadAll();

        // step 1: consolidate
        const cr = await service.consolidate({
          autoLink,
          triggerSource: 'manual',
          ctx,
          ...(options?.consolidateSkipLowScorePairs !== undefined
            ? { skipLowScorePairs: options.consolidateSkipLowScorePairs }
            : {}),
          ...(options?.consolidateLowScoreThreshold !== undefined
            ? { lowScoreThreshold: options.consolidateLowScoreThreshold }
            : {}),
          ...(useLlm && options?.consolidateLLM
            ? {
                llm: {
                  ctx,
                  modelRef: options.consolidateLLM.modelRef,
                  disableThinking: options.consolidateLLM.disableThinking ?? true,
                },
              }
            : {}),
        });
        const s1 = await service.loadAll();

        // step 2: compress
        let evictionMode: 'quota' | 'orphans-only' = 'orphans-only';
        if (ev && (ev.maxPersons > 0 || ev.maxEvents > 0 || ev.maxEntities > 0 || ev.maxEdges > 0)) {
          evictionMode = 'quota';
          await service.evictByQuota({
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
              halfLifeDays: ev.weightDecayHalfLifeDays ?? 180,
              floor: ev.weightDecayFloor ?? 0.3,
            },
            communityAlgorithm: ev.communityAlgorithm,
          });
        } else {
          await service.pruneOrphans();
        }
        const s2 = await service.loadAll();

        // 报告：先整理后压缩，每行只反映本阶段的真实减量
        const consolidateLine =
          `[1/2] 整理：人物 ${s0.persons.length}→${s1.persons.length}，事件 ${s0.events.length}→${s1.events.length}，` +
          `实体 ${s0.entities.length}→${s1.entities.length}，边 ${s0.edges.length}→${s1.edges.length}；` +
          `别名 ${cr.aliasCandidates.length} 候选/${cr.aliasEdgesCreated} 边，` +
          `part-of 新增 ${cr.partOfEdgesCreated}，事件边重整 ${cr.eventEdgesNormalized}，` +
          `层级 ${cr.entityHierarchyCandidates} 候选/${cr.entityHierarchyEdgesCreated} 边，` +
          `侧向父 ${cr.lateralParentCandidates} 簇/新建 ${cr.lateralParentsCreated}/边 ${cr.lateralEdgesCreated}` +
          (useLlm
            ? `，LLM 通过 ${cr.llmVerified ?? 0} 否决 ${cr.llmRejected ?? 0} 摘要重写 ${cr.summariesRewritten ?? 0}`
            : '');
        const compressLine =
          evictionMode === 'quota'
            ? `[2/2] 压缩：人物 ${s1.persons.length}→${s2.persons.length}，事件 ${s1.events.length}→${s2.events.length}，实体 ${s1.entities.length}→${s2.entities.length}，边 ${s1.edges.length}→${s2.edges.length}`
            : `[2/2] 压缩：仅清孤儿（未配置淘汰阈值）—人物 ${s1.persons.length}→${s2.persons.length}，事件 ${s1.events.length}→${s2.events.length}，实体 ${s1.entities.length}→${s2.entities.length}，边 ${s1.edges.length}→${s2.edges.length}`;
        return ['✓ 关系图体检完成：', consolidateLine, compressLine].join('\n');
      } finally {
        releaseCommand('relation.maintain');
      }
    });

  // ---- consolidation-status（查询最近一次 consolidate 运行情况） ----
  cmds
    .command('relation.consolidation-status', '查看最近一次关系图整理（consolidate）的运行时间、触发源与结果')
    .action(async () => {
      const info = service.getLastConsolidateInfo();
      if (!info.lastRunAt) {
        return (
          '⚠ 本次运行以来尚未执行过 consolidation。\n' +
          '触发方式：/relation consolidate（手动）、/relation maintain（压缩后连着整理），或容量淘汰后自动触发。'
        );
      }
      const time = new Date(info.lastRunAt).toLocaleString('zh-CN', { hour12: false });
      const triggerLabel = info.trigger === 'manual' ? '手动' : info.trigger === 'eviction' ? '淘汰后自动' : 'API 调用';
      return `✓ 最近一次 consolidation：${time}（触发方式：${triggerLabel}）\n${info.summary ?? '（无详情）'}`;
    });
}

// ───── helpers ─────

function collectOrphans(snap: {
  persons: PersonNode[];
  events: EventNode[];
  entities: EntityNode[];
  edges: RelationEdge[];
}): { orphanPersons: PersonNode[]; orphanEvents: EventNode[]; orphanEntities: EntityNode[] } {
  const refPerson = new Set<string>();
  const refEvent = new Set<string>();
  const refEntity = new Set<string>();
  for (const e of snap.edges) {
    if (e.kind === 'person-event') {
      refPerson.add(e.fromPersonId);
      refEvent.add(e.toEventId);
    } else if (e.kind === 'person-person') {
      refPerson.add(e.fromPersonId);
      refPerson.add(e.toPersonId);
    } else if (e.kind === 'person-entity') {
      refPerson.add(e.fromPersonId);
      refEntity.add(e.toEntityId);
    } else if (e.kind === 'event-event') {
      refEvent.add(e.fromEventId);
      refEvent.add(e.toEventId);
    }
  }
  return {
    orphanPersons: snap.persons.filter(p => !refPerson.has(p.id)),
    orphanEvents: snap.events.filter(e => !refEvent.has(e.id)),
    orphanEntities: snap.entities.filter(e => !refEntity.has(e.id)),
  };
}

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
