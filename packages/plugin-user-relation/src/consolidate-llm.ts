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
 */
export async function verifyAliasPair(
  _ctx: Context,
  model: LLMModel,
  a: EntityNode,
  b: EntityNode,
  disableThinking = true,
): Promise<{ isSame: boolean; reason: string }> {
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
        '',
        '【B】',
        `名称: ${b.name}`,
        `类型: ${b.entityKind}`,
        b.aliases?.length ? `别名: ${b.aliases.join(', ')}` : '',
        b.summary ? `摘要: ${b.summary}` : '',
        '',
        '注意：名称相同未必同一对象（例如同名的不同游戏角色）；类型不同时几乎不可能为同一对象。',
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
