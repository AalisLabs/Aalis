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
 * F2 / 统一改造：给 LLM 喂"对称且丰富"的上下文，便于科学判断是否合并：
 *   - 双方 ≤3 条 evidence 文本片段
 *   - 双方邻居 **总数 + top-K {name,weight}**（按 weight 倒序）
 *   - 可用的相似度分数（cosine / jaccard / structural / fused，任意子集）
 * 与 verifyEventPair 共用 PairNeighborProfile / PairScores 形态。
 */

/** 邻居剖面：人/事件/实体三类，各含总数 + top-K (name, weight) */
export interface PairNeighborProfile {
  peopleCount: number;
  eventCount: number;
  entityCount: number;
  topPeople: Array<{ name: string; weight: number }>;
  topEvents: Array<{ name: string; weight: number }>;
  topEntities: Array<{ name: string; weight: number }>;
}

/** 候选对相似度分数（各项独立可选；缺失字段不渲染） */
interface PairScores {
  /** 余弦相似（embedding 向量内积）0..1 */
  cosineScore?: number;
  /** 文本/集合 Jaccard 相似 0..1（事件用 title+aliases token；实体用 name+aliases） */
  jaccardScore?: number;
  /** 结构相似（Katz + AA 等图相似度融合）0..1 */
  structuralScore?: number;
  /** 综合分（例如 0.7·cos + 0.3·struct）0..1 */
  fusedScore?: number;
}

interface AliasPairContext {
  /** A 节点 ≤3 条 evidence 文本片段（已截断） */
  aEvidenceQuotes?: string[];
  /** B 节点 ≤3 条 evidence 文本片段 */
  bEvidenceQuotes?: string[];
  /** A 节点邻居剖面（计数 + top-K 名字+权重） */
  aNeighbors?: PairNeighborProfile;
  /** B 节点邻居剖面 */
  bNeighbors?: PairNeighborProfile;
  /** 候选对相似度分数（可选子集） */
  scores?: PairScores;
}

/** 渲染相似度分数行（仅渲染已提供的字段） */
function fmtScores(s?: PairScores): string {
  if (!s) return '';
  const parts: string[] = [];
  if (typeof s.cosineScore === 'number') parts.push(`cos ${s.cosineScore.toFixed(2)}`);
  if (typeof s.jaccardScore === 'number') parts.push(`jaccard ${s.jaccardScore.toFixed(2)}`);
  if (typeof s.structuralScore === 'number') parts.push(`struct ${s.structuralScore.toFixed(2)}`);
  if (typeof s.fusedScore === 'number') parts.push(`fused ${s.fusedScore.toFixed(2)}`);
  return parts.length ? `相似度信号：${parts.join(' / ')}` : '';
}

/** 渲染邻居剖面：保留"邻居：人物 N / 事件 M / 实体 K"计数行 + 新增 top-K 名字+权重 */
function fmtNeighborProfile(n?: PairNeighborProfile): string {
  if (!n) return '';
  const lines: string[] = [];
  lines.push(`邻居：人物 ${n.peopleCount} / 事件 ${n.eventCount} / 实体 ${n.entityCount}`);
  const renderTop = (label: string, list: Array<{ name: string; weight: number }>): string | null =>
    list.length === 0 ? null : `  ${label}: ${list.map(x => `${x.name}(${x.weight.toFixed(2)})`).join('、')}`;
  const tp = renderTop('top 人物', n.topPeople);
  const te = renderTop('top 事件', n.topEvents);
  const tn = renderTop('top 实体', n.topEntities);
  if (tp) lines.push(tp);
  if (te) lines.push(te);
  if (tn) lines.push(tn);
  return lines.join('\n');
}

function fmtEvidence(qs?: string[]): string {
  if (!qs || qs.length === 0) return '';
  return `近期证据片段：\n${qs.map(q => `  · ${q}`).join('\n')}`;
}

/**
 * verifyAliasPair 三态返回：
 * - isSame=true：两实体指代同一对象，调用方应执行 alias-merge
 * - isSame=false, hierarchy=undefined：两实体不相关或冲突，调用方应记 mergeReject
 * - isSame=false, hierarchy={parentId,childId}：两实体存在 part-of 关系（父子/包含），
 *   调用方应**拒绝合并**，改建 entity-entity[part-of] 边，避免父概念被并入子概念（或反之）。
 */
interface AliasPairResult {
  isSame: boolean;
  reason: string;
  hierarchy?: { parentId: string; childId: string };
}

export async function verifyAliasPair(
  _ctx: Context,
  model: LLMModel,
  a: EntityNode,
  b: EntityNode,
  disableThinking = true,
  context?: AliasPairContext,
): Promise<AliasPairResult> {
  const prompt = [
    {
      role: 'system' as const,
      content:
        '你是一个实体消歧助手。你只输出 JSON，不要带 markdown 代码块。输出三选一格式：\n' +
        '{"verdict": "same", "reason": "..."}                            // A 与 B 指代同一对象\n' +
        '{"verdict": "hierarchy", "parent": "A"|"B", "reason": "..."}   // 一方是另一方的子集/子部分/子模式/具体版本（part-of）\n' +
        '{"verdict": "different", "reason": "..."}                       // 其它（不同对象 / 仅松散关联）',
    },
    {
      role: 'user' as const,
      content: [
        '判断以下两个实体的关系：',
        '',
        '【A】',
        `名称: ${a.name}`,
        `类型: ${a.entityKind}`,
        a.aliases?.length ? `别名: ${a.aliases.join(', ')}` : '',
        a.summary ? `摘要: ${a.summary}` : '',
        fmtNeighborProfile(context?.aNeighbors),
        fmtEvidence(context?.aEvidenceQuotes),
        '',
        '【B】',
        `名称: ${b.name}`,
        `类型: ${b.entityKind}`,
        b.aliases?.length ? `别名: ${b.aliases.join(', ')}` : '',
        b.summary ? `摘要: ${b.summary}` : '',
        fmtNeighborProfile(context?.bNeighbors),
        fmtEvidence(context?.bEvidenceQuotes),
        '',
        fmtScores(context?.scores),
        '',
        '判定要点：',
        '- 名称相同未必同一对象（例如同名的不同游戏角色、不同公司同名项目）；',
        '- 类型不同时仍可能为同一对象——上游抽取可能把同一概念识别为不同 kind（如把游戏卡牌 "X" 既抽成 thing、又把同名概念抽成 topic；把同名作品既抽成 work 又抽成 thing），此时若名称完全相同、证据上下文相互兼容，倾向判 same；',
        '- 但若类型完全不可调和（如 person vs work / place vs topic）且证据上下文截然不同，应判 different；',
        '- 邻居重叠是强证据：若双方 top 人物/事件/实体出现明显同名重合（即便权重不同），强烈倾向判 same；',
        '- 若两侧的邻居完全没有重叠，且证据片段的上下文话题截然不同，倾向判 different；',
        '- 相似度分数（若提供）：cos/jaccard ≥ 0.85 是强信号，0.6~0.85 中等，< 0.6 仅作辅助；',
        '- 若证据片段中出现"A 又叫 B / B 即 A / 两者通用"等明示同一性的表达，倾向判 same。',
        '',
        '**hierarchy 判定要点（关键，避免父概念被并入子概念）**：',
        '- 一方是另一方的「子模式 / 子地图 / 子关卡 / 子版本 / 子系列 / 子章节 / 子组件」，明显是包含关系而非同一对象，应判 hierarchy；',
        '  · 例：「三角洲行动·绝密航天」(B) part-of「三角洲行动」(A) — A 是母游戏，B 是其中一个模式',
        '  · 例：「红警 3·起义时刻」(B) part-of「红警 3」(A)',
        '  · 例：「Honkai: Star Rail·罗浮章节」(B) part-of「Honkai: Star Rail」(A)',
        '- 当判 hierarchy 时，必须在 "parent" 字段明确指出哪一方是父（"A" 或 "B"）。父=更宽泛的、被包含的；子=更具体的、包含父名的；',
        '- 当人们在聊天中把子模式名缩略为父名（如"今晚打三角洲" 实际在玩绝密航天），不要把此当成"别名"——这是缩略指代，子和父仍是不同对象；',
        '- 若两者只是松散相关（如同一游戏厂商的不同作品、同一公司的不同产品），既不是 same 也不是 hierarchy，判 different。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  try {
    const resp = await model.chat({ messages: prompt, temperature: 0, ...(disableThinking ? { think: false } : {}) });
    const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const parsed = tryParseJson(raw) as { verdict?: unknown; reason?: unknown; parent?: unknown } | undefined;
    if (!parsed) return { isSame: false, reason: 'LLM 输出无法解析' };
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    // 向后兼容：若 LLM 仍按老格式返回 {isSame}，做一次映射
    const legacy = parsed as { isSame?: unknown };
    if (typeof legacy.isSame === 'boolean' && typeof parsed.verdict !== 'string') {
      return { isSame: legacy.isSame, reason };
    }
    if (parsed.verdict === 'same') return { isSame: true, reason };
    if (parsed.verdict === 'hierarchy') {
      const parent = parsed.parent === 'A' || parsed.parent === 'B' ? parsed.parent : null;
      if (!parent) return { isSame: false, reason: `${reason}（hierarchy 但 parent 字段缺失，按 different 处理）` };
      const parentId = parent === 'A' ? a.id : b.id;
      const childId = parent === 'A' ? b.id : a.id;
      return { isSame: false, reason, hierarchy: { parentId, childId } };
    }
    if (parsed.verdict === 'different') return { isSame: false, reason };
    return { isSame: false, reason: `LLM verdict 字段非法："${String(parsed.verdict)}"` };
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
 * 统一改造：与 verifyAliasPair 对称，同时接收邻居剖面（计数 + top-K 名字+权重）+ 多维相似度分数。
 */
interface EventPairContext {
  aEvidenceQuotes?: string[];
  bEvidenceQuotes?: string[];
  /** A 事件邻居剖面（计数 + top-K 名字+权重） */
  aNeighbors?: PairNeighborProfile;
  /** B 事件邻居剖面 */
  bNeighbors?: PairNeighborProfile;
  /** 候选对相似度分数 */
  scores?: PairScores;
}

export async function verifyEventPair(
  _ctx: Context,
  model: LLMModel,
  a: EventNode,
  b: EventNode,
  disableThinking = true,
  context?: EventPairContext,
): Promise<{ isSame: boolean; reason: string }> {
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
        fmtNeighborProfile(context?.aNeighbors),
        fmtEvidence(context?.aEvidenceQuotes),
        '',
        '【B】',
        `标题: ${b.title}`,
        b.category ? `类别: ${b.category}` : '',
        b.aliases?.length ? `别名: ${b.aliases.join(', ')}` : '',
        b.summary ? `摘要: ${b.summary}` : '',
        fmtNeighborProfile(context?.bNeighbors),
        fmtEvidence(context?.bEvidenceQuotes),
        '',
        fmtScores(context?.scores),
        '',
        '判定要点：',
        '- 同一话题在短时间内被多次提及（例如「讨论夏天炎热」「讨论夏季发热」）→ 同一事件；',
        '- 同一事件被不同视角 / 不同人复述（标题/摘要差异大但内核一致）→ 同一事件；',
        '- 邻居重叠是强证据：若双方 top 人物/实体出现明显同名重合，强烈倾向判是；',
        '- 不同次独立发生的同类事件（如两次不同的雷雨）→ 不同事件；',
        '- 相似度分数（若提供）：cos/fused ≥ 0.85 是强信号，0.6~0.85 中等，< 0.6 仅作辅助；struct 主要反映共邻边重叠；',
        '- 类别差异大、邻居完全无重叠、证据上下文话题截然不同 → 倾向判否。',
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
