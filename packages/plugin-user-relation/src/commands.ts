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
import type { RelationService } from './service.js';
import type { EntityNode, EventNode, PersonNode, RelationEdge } from './types.js';

export function registerRelationCommands(
  ctx: Context,
  service: RelationService,
  options?: { consolidateLLM?: { modelRef: { provider: string; model: string }; disableThinking?: boolean } },
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
    .command('relation.cleanup.person <id:text>', '删除人物及其所有相关边', { authority: 3 })
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
    .command('relation.forget-me', '清理我自己在关系图中的节点与直接关联（不清理别人对我的文本提及）', {
      authority: 1,
    })
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
    .command('relation.cleanup.event <id:text>', '删除事件及其所有相关边', { authority: 3 })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id) return '请提供 event id';
      const r = await service.deleteEvent(id);
      return `✓ 已删除 event ${id}（级联 ${r.deletedEdges} 条边）`;
    });

  cmds
    .command('relation.cleanup.entity <id:text>', '删除实体及其所有相关边', { authority: 3 })
    .action(async (_argv, idArg) => {
      const id = String(idArg ?? '').trim();
      if (!id) return '请提供 entity id';
      const r = await service.deleteEntity(id);
      return `✓ 已删除 entity ${id}（级联 ${r.deletedEdges} 条边）`;
    });

  cmds.command('relation.cleanup.orphans', '一键清理所有孤立点', { authority: 3 }).action(async () => {
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

  cmds
    .command('relation.cleanup.all', '⚠ 危险：清空整个关系图（需要 --yes 确认）', {
      authority: 4,
      safety: 'dangerous',
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

  // ---- consolidate（整理：别名候选 / 自动 part-of / 旧账去重） ----
  cmds
    .command('relation.consolidate', '整理关系图：扫描别名候选、自动 part-of、规范化 PersonEventEdge', {
      authority: 3,
    })
    .option('auto-link', '--auto-link', { description: '将高置信别名候选自动建为 is-alias-of 边' })
    .option('no-llm', '--no-llm', { description: '跳过 consolidationModel 配置的 LLM 增强（A 核验 + B 摘要重写）' })
    .action(async argv => {
      const autoLink = argv.options['auto-link'] === true;
      const useLlm = argv.options['no-llm'] !== true && !!options?.consolidateLLM;
      const r = await service.consolidate({
        autoLink,
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
    });

  // ---- consolidation-status（查询最近一次 consolidate 运行情况） ----
  cmds
    .command('relation.consolidation-status', '查看最近一次关系图整理（consolidate）的运行时间与结果', {
      authority: 1,
    })
    .action(async () => {
      const info = service.getLastConsolidateInfo();
      if (!info.lastRunAt) {
        return (
          '⚠ 本次运行以来尚未执行过 consolidation。\n' +
          '触发方式：/relation consolidate（手动）或等待容量淘汰自动触发。'
        );
      }
      const time = new Date(info.lastRunAt).toLocaleString('zh-CN', { hour12: false });
      return `✓ 最近一次 consolidation 于 ${time} 完成。\n${info.summary ?? '（无详情）'}`;
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
