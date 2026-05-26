/**
 * consolidate 阶段的可选 LLM 集成：
 *  (A) 别名候选语义核验：对 autoLink 待合并的实体对，让 LLM 二判 yes/no
 *  (B) 合并后摘要重写：合并完成后用大上下文模型重写 canonical 实体的 summary
 *
 * 这两步都是「可选」：仅当 consolidationModel 已配置时启用，否则保持原算法行为。
 */

import type { Context } from '@aalis/core';
import { LLMCapabilities, type LLMModel, type ModelRef, resolveLLMModel } from '@aalis/plugin-llm-api';

import type { EntityNode, EventNode, PersonNode } from './types.js';

interface ConsolidateLLMConfig {
  modelRef: ModelRef;
  disableThinking?: boolean;
}

/** 解析配置的 LLM 模型；未配置或不可用时返回 undefined。 */
export function resolveConsolidateModel(ctx: Context, cfg: ConsolidateLLMConfig | undefined): LLMModel | undefined {
  if (!cfg) return undefined;
  const entry = resolveLLMModel(ctx, cfg.modelRef, [LLMCapabilities.Chat]);
  return entry?.instance;
}

/**
 * (A) 判断两个实体是否为同一实体。LLM 输出 JSON：{"isSame": boolean, "reason": string}
 * 解析失败或 LLM 表示不是 → 返回 false。
 *
 * F2：可选 context 给 LLM 喂"上下文证据"——每边 ≤3 条 evidence 片段 + 邻居人数/事件数。
 * 提供后 LLM 判断更稳（能识别同名异物——例如同名不同游戏角色，邻居完全不重叠）。
 */
interface AliasPairContext {
  /** A 节点 ≤3 条 evidence 文本片段（已截断） */
  aEvidenceQuotes?: string[];
  /** B 节点 ≤3 条 evidence 文本片段 */
  bEvidenceQuotes?: string[];
  /** A 节点邻居人数 / 事件数 / 实体数（来自 snapshot 统计） */
  aNeighbors?: { people: number; events: number; entities: number };
  /** B 节点邻居人数 / 事件数 / 实体数 */
  bNeighbors?: { people: number; events: number; entities: number };
}

export async function verifyAliasPair(
  _ctx: Context,
  model: LLMModel,
  a: EntityNode,
  b: EntityNode,
  disableThinking = true,
  context?: AliasPairContext,
): Promise<{ isSame: boolean; reason: string }> {
  const fmtNeighbors = (n?: { people: number; events: number; entities: number }): string =>
    n ? `邻居：人物 ${n.people} / 事件 ${n.events} / 实体 ${n.entities}` : '';
  const fmtEvidence = (qs?: string[]): string => {
    if (!qs || qs.length === 0) return '';
    return `近期证据片段：\n${qs.map(q => `  · ${q}`).join('\n')}`;
  };
  const prompt = [
    {
      role: 'system' as const,
      content:
        '你是一个实体消歧助手。你只输出 JSON，不要带 markdown 代码块。输出格式：{"isSame": true|false, "reason": "简短说明"}。',
    },
    {
      role: 'user' as const,
      content: [
        '判断以下两个实体是否指代同一个现实对象：',
        '',
        '【A】',
        `名称: ${a.name}`,
        `类型: ${a.entityKind}`,
        a.aliases?.length ? `别名: ${a.aliases.join(', ')}` : '',
        a.summary ? `摘要: ${a.summary}` : '',
        fmtNeighbors(context?.aNeighbors),
        fmtEvidence(context?.aEvidenceQuotes),
        '',
        '【B】',
        `名称: ${b.name}`,
        `类型: ${b.entityKind}`,
        b.aliases?.length ? `别名: ${b.aliases.join(', ')}` : '',
        b.summary ? `摘要: ${b.summary}` : '',
        fmtNeighbors(context?.bNeighbors),
        fmtEvidence(context?.bEvidenceQuotes),
        '',
        '判定要点：',
        '- 名称相同未必同一对象（例如同名的不同游戏角色、不同公司同名项目）；',
        '- 类型不同时几乎不可能为同一对象；',
        '- 若两侧的邻居（关联人物/事件/实体）完全没有重叠，且证据片段的上下文话题截然不同，倾向判否；',
        '- 若证据片段中出现"A 又叫 B / B 即 A / 两者通用"等明示同一性的表达，倾向判是。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  try {
    const resp = await model.chat({ messages: prompt, temperature: 0, ...(disableThinking ? { think: false } : {}) });
    const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const parsed = tryParseJson(raw) as { isSame?: unknown; reason?: unknown } | undefined;
    if (!parsed || typeof parsed.isSame !== 'boolean') return { isSame: false, reason: 'LLM 输出无法解析' };
    return { isSame: parsed.isSame, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch (err) {
    return { isSame: false, reason: `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * (A2) 判断两个事件是否为同一事件。LLM 输出 JSON：{"isSame": boolean, "reason": string}
 * 类比 verifyAliasPair，针对 EventNode 字段（title/summary/category/aliases）。
 *
 * 调用方应已经过结构相似 + 文本相似双向过滤（避免对全图 N² 个 pair 调 LLM）。
 * 解析失败 / 异常 → 视为 false（保守不合并）。
 *
 * context.aEvidenceQuotes 给 LLM 提供原文上下文（每边 ≤3 条 evidence 截断），
 * 有助于区分「同一事件多次描述」vs「不同次发生的同类事件」。
 */
interface EventPairContext {
  aEvidenceQuotes?: string[];
  bEvidenceQuotes?: string[];
  /** 结构相似（Katz + AA 融合）分数，供 LLM 参考 */
  structuralScore?: number;
  /** 文本相似（cos 或 jaccard）分数 */
  textualScore?: number;
}

export async function verifyEventPair(
  _ctx: Context,
  model: LLMModel,
  a: EventNode,
  b: EventNode,
  disableThinking = true,
  context?: EventPairContext,
): Promise<{ isSame: boolean; reason: string }> {
  const fmtEvidence = (qs?: string[]): string => {
    if (!qs || qs.length === 0) return '';
    return `近期证据片段：\n${qs.map(q => `  · ${q}`).join('\n')}`;
  };
  const fmtSim = (): string => {
    const parts: string[] = [];
    if (typeof context?.structuralScore === 'number') parts.push(`结构相似 ${context.structuralScore.toFixed(2)}`);
    if (typeof context?.textualScore === 'number') parts.push(`文本相似 ${context.textualScore.toFixed(2)}`);
    return parts.length ? `相似度信号：${parts.join(' / ')}` : '';
  };
  const prompt = [
    {
      role: 'system' as const,
      content:
        '你是一个事件消歧助手。你只输出 JSON，不要带 markdown 代码块。输出格式：{"isSame": true|false, "reason": "简短说明"}。' +
        '事件是「发生过一次的事 / 一个话题段落」，若两条记录描述同一桩事 / 同一段持续讨论的话题，则视为同一事件。',
    },
    {
      role: 'user' as const,
      content: [
        '判断以下两个事件是否为同一事件：',
        '',
        '【A】',
        `标题: ${a.title}`,
        a.category ? `类别: ${a.category}` : '',
        a.aliases?.length ? `别名: ${a.aliases.join(', ')}` : '',
        a.summary ? `摘要: ${a.summary}` : '',
        fmtEvidence(context?.aEvidenceQuotes),
        '',
        '【B】',
        `标题: ${b.title}`,
        b.category ? `类别: ${b.category}` : '',
        b.aliases?.length ? `别名: ${b.aliases.join(', ')}` : '',
        b.summary ? `摘要: ${b.summary}` : '',
        fmtEvidence(context?.bEvidenceQuotes),
        '',
        fmtSim(),
        '',
        '判定要点：',
        '- 同一话题在短时间内被多次提及（例如「讨论夏天炎热」「讨论夏季发热」）→ 同一事件；',
        '- 同一事件被不同视角 / 不同人复述（标题/摘要差异大但内核一致）→ 同一事件；',
        '- 不同次独立发生的同类事件（如两次不同的雷雨）→ 不同事件；',
        '- 类别差异大、证据上下文话题截然不同 → 倾向判否。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  try {
    const resp = await model.chat({ messages: prompt, temperature: 0, ...(disableThinking ? { think: false } : {}) });
    const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const parsed = tryParseJson(raw) as { isSame?: unknown; reason?: unknown } | undefined;
    if (!parsed || typeof parsed.isSame !== 'boolean') return { isSame: false, reason: 'LLM 输出无法解析' };
    return { isSame: parsed.isSame, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch (err) {
    return { isSame: false, reason: `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * (B) 合并后重写 canonical 实体摘要。
 * 失败返回 undefined（保留原 summary）。
 */
export async function rewriteEntitySummary(
  ctx: Context,
  model: LLMModel,
  entity: EntityNode,
  context: {
    aliases: string[];
    recentEvents: Array<Pick<EventNode, 'title' | 'summary'>>;
    relatedPersons: Array<Pick<PersonNode, 'displayName'>>;
  },
  disableThinking = true,
): Promise<string | undefined> {
  const prompt = [
    {
      role: 'system' as const,
      content:
        '你是一个知识库整理助手。请基于给定信息为实体重写一段简短中性的摘要（80 字以内），覆盖关键属性与近期相关事件。不要使用 markdown，直接输出纯文本摘要。',
    },
    {
      role: 'user' as const,
      content: [
        `实体名称: ${entity.name}`,
        `类型: ${entity.entityKind}`,
        context.aliases.length ? `所有别名: ${context.aliases.join(', ')}` : '',
        entity.summary ? `当前摘要: ${entity.summary}` : '',
        context.recentEvents.length
          ? `近期相关事件:\n${context.recentEvents.map(e => `- ${e.title}${e.summary ? ` — ${e.summary}` : ''}`).join('\n')}`
          : '',
        context.relatedPersons.length
          ? `相关人物: ${context.relatedPersons
              .map(p => p.displayName)
              .filter(Boolean)
              .join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  try {
    const resp = await model.chat({ messages: prompt, temperature: 0.2, ...(disableThinking ? { think: false } : {}) });
    const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const cleaned = raw
      .trim()
      .replace(/^```(?:text|markdown)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return cleaned || undefined;
  } catch (err) {
    ctx.logger.warn(`[user-relation] consolidate 摘要重写失败: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * (C) 推断实体父子层级：给定一批「名称上有包含关系」的实体对，让 LLM 确认是否真实存在 part-of 关系。
 * 输入：候选列表，每项 {parent, child}（parent 名称是 child 名称的子串）。
 * 输出：每项 {parentId, childId, confirmed, reason}。
 * 解析失败 / LLM 表示 false → confirmed=false。
 */
export async function inferEntityHierarchy(
  ctx: Context,
  model: LLMModel,
  candidates: Array<{ parent: EntityNode; child: EntityNode }>,
  disableThinking = true,
): Promise<Array<{ parentId: string; childId: string; confirmed: boolean; reason: string }>> {
  if (candidates.length === 0) return [];
  const candidateLines = candidates.map(
    (c, i) =>
      `[${i}] 父实体: ${c.parent.name}（${c.parent.entityKind}${c.parent.summary ? `，${c.parent.summary.slice(0, 40)}` : ''}）` +
      ` ← 子实体候选: ${c.child.name}（${c.child.entityKind}${c.child.summary ? `，${c.child.summary.slice(0, 40)}` : ''}）`,
  );
  const prompt = [
    {
      role: 'system' as const,
      content:
        '你是一个实体层级推断助手。对每对实体，判断"子实体候选"是否确实属于"父实体"（part-of 关系：子是父的具体版本、模式、章节、关卡、地点分支等），而非仅仅名字字符串上包含父的名称。' +
        '只输出 JSON 数组，不要带 markdown 代码块。格式：[{"index":0,"isPartOf":true,"reason":"简短说明"},…]',
    },
    {
      role: 'user' as const,
      content: `请判断以下 ${candidates.length} 对实体的父子关系：\n\n${candidateLines.join('\n')}`,
    },
  ];
  try {
    const resp = await model.chat({ messages: prompt, temperature: 0, ...(disableThinking ? { think: false } : {}) });
    const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const parsed = tryParseJson(raw) as Array<{ index?: number; isPartOf?: unknown; reason?: unknown }> | undefined;
    if (!Array.isArray(parsed)) {
      ctx.logger.warn('[user-relation] inferEntityHierarchy: LLM 输出无法解析为数组');
      return candidates.map(c => ({
        parentId: c.parent.id,
        childId: c.child.id,
        confirmed: false,
        reason: 'LLM 输出解析失败',
      }));
    }
    return candidates.map((c, i) => {
      const item = parsed.find(x => x.index === i);
      if (!item || typeof item.isPartOf !== 'boolean') {
        return { parentId: c.parent.id, childId: c.child.id, confirmed: false, reason: 'LLM 未返回该项' };
      }
      return {
        parentId: c.parent.id,
        childId: c.child.id,
        confirmed: item.isPartOf,
        reason: typeof item.reason === 'string' ? item.reason : '',
      };
    });
  } catch (err) {
    ctx.logger.warn(
      `[user-relation] inferEntityHierarchy LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return candidates.map(c => ({
      parentId: c.parent.id,
      childId: c.child.id,
      confirmed: false,
      reason: `LLM 失败: ${err instanceof Error ? err.message : String(err)}`,
    }));
  }
}

/**
 * (D) 父实体「侧向推断」：给定一组同 kind 的「兄弟实体」（它们的名字共享一段前缀），
 * 让 LLM 判断「该共同前缀作为父实体名是否有意义」。
 * 输入：候选父名 + 候选 kind + 兄弟实体（≥2）。
 * 输出：{ accept: boolean, suggestedName?: string, reason: string }
 *   - accept=true 且未给 suggestedName → 用原前缀；给了则用 LLM 修正后的名字（可能更通顺）。
 *   - accept=false → 调用方不创建该父实体。
 * 解析失败 / LLM 失败 → accept=false。
 */
export async function inferMissingParent(
  ctx: Context,
  model: LLMModel,
  candidate: { parentName: string; kind: string; siblings: EntityNode[] },
  disableThinking = true,
): Promise<{ accept: boolean; suggestedName?: string; reason: string }> {
  const siblingLines = candidate.siblings.map(s => `- ${s.name}${s.summary ? `（${s.summary.slice(0, 40)}）` : ''}`);
  const prompt = [
    {
      role: 'system' as const,
      content:
        '你是一个实体层级推断助手。给定一组同类「兄弟实体」和它们名字的共同前缀，判断「这个前缀作为它们的父实体名是否在现实中有意义」。' +
        '只输出 JSON，不要带 markdown 代码块。格式：{"accept": true/false, "suggestedName": "可选，更通顺的父名", "reason": "简短说明"}。' +
        '判断要点：' +
        '(1) 前缀必须能独立指代一个真实存在的、被广泛理解的「父级概念」（如游戏系列、作品、品牌、地点）；' +
        '(2) 不要因为名字字面包含就硬造（例如「橙汁」不是「橙色橘子」的父级）；' +
        '(3) 若前缀仅是没意义的字符片段，accept=false；' +
        '(4) 若前缀略不通顺但语义清晰，可在 suggestedName 给出修正名。',
    },
    {
      role: 'user' as const,
      content: [
        `候选父实体名: ${candidate.parentName}`,
        `类型: ${candidate.kind}`,
        `兄弟实体（共 ${candidate.siblings.length} 个）:`,
        ...siblingLines,
      ].join('\n'),
    },
  ];
  try {
    const resp = await model.chat({ messages: prompt, temperature: 0, ...(disableThinking ? { think: false } : {}) });
    const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const parsed = tryParseJson(raw) as { accept?: unknown; suggestedName?: unknown; reason?: unknown } | undefined;
    if (!parsed || typeof parsed.accept !== 'boolean') {
      return { accept: false, reason: 'LLM 输出解析失败' };
    }
    return {
      accept: parsed.accept,
      ...(typeof parsed.suggestedName === 'string' && parsed.suggestedName.trim()
        ? { suggestedName: parsed.suggestedName.trim() }
        : {}),
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch (err) {
    ctx.logger.warn(
      `[user-relation] inferMissingParent LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { accept: false, reason: `LLM 失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const s = trimmed.indexOf('{');
    const e = trimmed.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(trimmed.slice(s, e + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
