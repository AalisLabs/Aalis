import type { Context } from '@aalis/core';
import { resolveLLMModel } from '@aalis/plugin-llm-api';
import type { MediaService } from '@aalis/plugin-media-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import { buildEnvelope, expandForward } from './forward.js';
import type { OneBotMessageSegment } from './types.js';
import { collectForwardSegments } from './types.js';

/**
 * 合并转发摘要默认 system prompt。
 *
 * 设计重点：明确要求保留多人互动结构（谁说了什么 / 态度 / 回应关系）,
 * 避免出现 “Alice 表达了对…” 这种压成一句、丢掉互动的退化摘要。
 *
 * 用户可通过配置 `forward.summaryPrompt` 完全覆盖本默认值。
 */
export const DEFAULT_FORWARD_SUMMARY_PROMPT =
  '你是聊天记录摘要助手。给定一段合并转发的原始内容，用简体中文输出一段含多人互动细节的摘要：\n' +
  '- 按时间顺序串联主线，使用“某人：……”或“某人对某人说……”这种紧凑句式保留发言人轮次与互动关系，但不要逐条复述每句寒暄；\n' +
  '- 明确点出每位主要参与人的关键发言 / 立场 / 情绪变化，以及他们互相同意、反驳、调侃、追问的点；\n' +
  '- 原文里出现的请求 / 指令 / 待执行事项 / 希望机器人代发或转告的内容，必须原文输出并保留具体目标对象 / 群聊 / 要表达的观点；\n' +
  '- 图片识别结果、链接、文件名等视觉 / 附件信息也要写进来；\n' +
  '- 不要寒暄、不要解释自己、不要使用 markdown 列表或标题；输出单段落纯文本；\n' +
  '- 控制在目标字数以内，优先保留互动细节与可引用发言，寒暄/重复信息略去。';

/**
 * 合并转发原文缓存条目：完整原文 + 摘要 + 元信息。
 */
export interface ForwardEntry {
  fullText: string;
  summary: string | null;
  count: number;
  participants: string[];
  expandedAt: number;
}

export interface ForwardConfig {
  enabled: boolean;
  maxDepth: number;
  maxNodesPerLevel: number;
  imageRecognition: boolean;
  /** 同一条合并转发内图片识别并发上限。默认 8。 */
  imageRecognitionConcurrency: number;
  summarize: boolean;
  summaryLLM?: { provider: string; model: string };
  summaryMaxChars: number;
  /** 喂给摘要 LLM 的原文最大字符数。原文超过则前段截断；<=0 表示不截断 */
  summaryInputLimit: number /**
   * 摘要使用的 system prompt。为空字符串 / undefined 时使用 `DEFAULT_FORWARD_SUMMARY_PROMPT`。
   * 传入非空字符串则完全覆盖默认 prompt。
   */;
  summaryPrompt?: string;
}

export interface ForwardExpanderDeps<TState> {
  ctx: Context;
  forwardCfg: ForwardConfig;
  /** 调用 OneBot action 的回调（已绑定到具体的连接状态） */
  sendAction: (state: TState, action: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface ForwardExpander<TState> {
  getCachedForward(id: string): ForwardEntry | undefined;
  setCachedForward(id: string, entry: ForwardEntry): void;
  loadPersistedForward(id: string): Promise<ForwardEntry | undefined>;
  fetchForwardOnce(state: TState, id: string): Promise<unknown | null>;
  expandForwardsInText(state: TState, text: string, rawSegments: OneBotMessageSegment[] | undefined): Promise<string>;
}

const FORWARD_CACHE_TTL_MS = 60 * 60 * 1000;
const FORWARD_METADATA_NS = 'onebot:forward';

/**
 * 把一个异步函数包成"同时最多 N 路"的并发受限版本。
 * 用于合并转发内大量图片识别请求时削峰，避免压垮上游 / 触发限流。
 */
function createConcurrencyLimited<TArg, TRet>(
  fn: (arg: TArg) => Promise<TRet>,
  limit: number,
): (arg: TArg) => Promise<TRet> {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      queue.push(() => {
        active++;
        resolve();
      });
    });
  };
  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return async (arg: TArg) => {
    await acquire();
    try {
      return await fn(arg);
    } finally {
      release();
    }
  };
}

/**
 * 合并转发展开器工厂。
 *
 * 收到一条带 forward 段的消息时，立即递归拉取原文、做图像识别、生成摘要，
 * 并把完整原文写入此缓存（也会同步到 MemoryService.saveMetadata 做持久化），
 * 这样：
 *   1) LLM 在对话上下文里看到的是"信封 + 摘要"，不被超长原文淹没；
 *   2) 想看细节时调 onebot_get_forward_msg 工具直接命中缓存/持久化层；
 *   3) 摘要会随 inbound:message 进入历史归档与向量库，被语义召回。
 *
 * 内存缓存 1h TTL；持久化由 memory metadata 兜底（如果实现支持）。
 */
export function createForwardExpander<TState>(deps: ForwardExpanderDeps<TState>): ForwardExpander<TState> {
  const { ctx, sendAction, forwardCfg } = deps;
  const forwardCache = new Map<string, { entry: ForwardEntry; expiresAt: number }>();

  function getCachedForward(id: string): ForwardEntry | undefined {
    const c = forwardCache.get(id);
    if (!c) return undefined;
    if (c.expiresAt < Date.now()) {
      forwardCache.delete(id);
      return undefined;
    }
    return c.entry;
  }

  function setCachedForward(id: string, entry: ForwardEntry): void {
    forwardCache.set(id, { entry, expiresAt: Date.now() + FORWARD_CACHE_TTL_MS });
    const memory = ctx.getService<MemoryService>('memory');
    if (memory?.saveMetadata) {
      memory
        .saveMetadata(FORWARD_METADATA_NS, id, entry as unknown as Record<string, unknown>)
        .catch((err: unknown) => ctx.logger.debug(`forward metadata 持久化失败 id=${id}: ${err}`));
    }
  }

  /** 从持久化层加载（缓存未命中时尝试） */
  async function loadPersistedForward(id: string): Promise<ForwardEntry | undefined> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getMetadata) return undefined;
    try {
      const data = await memory.getMetadata(FORWARD_METADATA_NS, id);
      if (data && typeof data === 'object' && typeof (data as { fullText?: unknown }).fullText === 'string') {
        return data as unknown as ForwardEntry;
      }
    } catch (err) {
      ctx.logger.debug(`forward metadata 读取失败 id=${id}: ${err}`);
    }
    return undefined;
  }

  /**
   * 拉取一条合并转发的内容，依次尝试多种参数键。
   * 不同 OneBot 实现接受的字段不同：标准为 id，NapCat/Lagrange 部分版本接受
   * message_id / res_id / m_resid。
   */
  async function fetchForwardOnce(state: TState, id: string): Promise<unknown | null> {
    const attempts: Array<Record<string, unknown>> = [{ id }, { message_id: id }, { res_id: id }, { m_resid: id }];
    let lastErr: unknown;
    for (const params of attempts) {
      try {
        return await sendAction(state, 'get_forward_msg', params);
      } catch (err) {
        lastErr = err;
      }
    }
    ctx.logger.debug(`get_forward_msg 全部参数尝试失败 id=${id}: ${lastErr}`);
    return null;
  }

  /** 用 LLM 给一段 forward 原文生成摘要；失败/未配置则返回 null。 */
  async function summarizeForward(
    text: string,
    hint: { count: number; participants: string[] },
  ): Promise<string | null> {
    if (!forwardCfg.summarize) return null;

    const entry = resolveLLMModel(ctx, forwardCfg.summaryLLM, ['chat']);
    if (!entry) {
      ctx.logger.debug('forward 摘要：无可用 LLM 服务，跳过');
      return null;
    }
    const llm = entry.instance;

    const inputLimit = forwardCfg.summaryInputLimit;
    const trimmedInput =
      inputLimit > 0 && text.length > inputLimit ? `${text.slice(0, inputLimit)}\n…（原文已截断）` : text;

    // 摘要 prompt：用户可通过 forward.summaryPrompt 覆盖默认值，默认 prompt
    // 明确要求保留多人互动结构，避免压成一句的退化摘要。
    const sys =
      forwardCfg.summaryPrompt && forwardCfg.summaryPrompt.trim().length > 0
        ? forwardCfg.summaryPrompt
        : DEFAULT_FORWARD_SUMMARY_PROMPT;
    const userPrompt = `合并转发包含 ${hint.count} 条消息，主要参与人：${hint.participants.join(', ') || '未知'}。\n目标字数：≤${forwardCfg.summaryMaxChars} 字（可超出 10% 以完整保留互动结构）。\n\n原文：\n${trimmedInput}`;

    try {
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        think: false,
        maxTokens: Math.max(800, Math.ceil(forwardCfg.summaryMaxChars * 1.5)),
      });
      const out = (resp.content ?? '').trim();
      if (!out) {
        ctx.logger.debug(
          `forward 摘要返回空内容: model=${forwardCfg.summaryLLM ? `${forwardCfg.summaryLLM.provider}/${forwardCfg.summaryLLM.model}` : 'default'}, chars=${forwardCfg.summaryMaxChars}`,
        );
        return null;
      }
      return out;
    } catch (err) {
      ctx.logger.warn(`forward 摘要生成失败: ${err}`);
      return null;
    }
  }

  /**
   * 把 event.text 中所有 <forward id="X">[合并转发消息]</forward> 占位符
   * 替换为"信封文本"（含摘要）；完整原文写入 forwardCache + memory metadata。
   *
   * 优先使用消息段里随帧带来的 inline content（部分 NapCat 版本会内嵌），
   * 这种情况下顶层无需走网络。
   */
  async function expandForwardsInText(
    state: TState,
    text: string,
    rawSegments: OneBotMessageSegment[] | undefined,
  ): Promise<string> {
    if (!forwardCfg.enabled) return text;
    if (!text.includes('<forward id=')) return text;

    const inlineMap = new Map<string, unknown[]>();
    if (rawSegments && Array.isArray(rawSegments)) {
      for (const f of collectForwardSegments(rawSegments)) {
        if (f.inlineNodes && f.inlineNodes.length > 0) inlineMap.set(f.id, f.inlineNodes);
      }
    }

    const idRe = /<forward id="([^"]+)">\[合并转发消息\]<\/forward>/g;
    const ids = new Set<string>();
    let m: RegExpExecArray | null = idRe.exec(text);
    while (m !== null) {
      ids.add(m[1]);
      m = idRe.exec(text);
    }
    if (ids.size === 0) return text;

    const mediaSvc = forwardCfg.imageRecognition ? ctx.getService<MediaService>('media') : undefined;
    const rawRecognize = mediaSvc?.describeImage ? (src: string) => mediaSvc.describeImage(src) : undefined;
    // 用一个简单 semaphore 限制单次展开内的图片识别并发，避免 OOM/触发上游限流
    const recognizeImage = rawRecognize
      ? createConcurrencyLimited(rawRecognize, Math.max(1, forwardCfg.imageRecognitionConcurrency))
      : undefined;

    const envelopeMap = new Map<string, string>();
    for (const id of ids) {
      let entry = getCachedForward(id);
      if (!entry) {
        const persisted = await loadPersistedForward(id);
        if (persisted) {
          setCachedForward(id, persisted);
          entry = persisted;
        }
      }
      if (entry) {
        envelopeMap.set(
          id,
          buildEnvelope(
            {
              id,
              count: entry.count,
              participants: entry.participants,
              fullText: entry.fullText,
              truncatedDepth: false,
              truncatedNodes: false,
            },
            entry.summary,
          ),
        );
        continue;
      }

      try {
        const expanded = await expandForward(id, inlineMap.get(id) ?? null, {
          fetchForward: (childId: string) => fetchForwardOnce(state, childId),
          recognizeImage,
          maxDepth: forwardCfg.maxDepth,
          maxNodesPerLevel: forwardCfg.maxNodesPerLevel,
          imageRecognitionEnabled: forwardCfg.imageRecognition,
        });

        if (!expanded.fullText.trim()) {
          envelopeMap.set(
            id,
            `<forward id="${id}">[合并转发消息：协议端无法读取（可能已过期/不在当前会话作用域）]</forward>`,
          );
          continue;
        }

        const summary = await summarizeForward(expanded.fullText, {
          count: expanded.count,
          participants: expanded.participants,
        });

        const stored: ForwardEntry = {
          fullText: expanded.fullText,
          summary,
          count: expanded.count,
          participants: expanded.participants,
          expandedAt: Date.now(),
        };
        setCachedForward(id, stored);

        const truncFlag = expanded.truncatedDepth || expanded.truncatedNodes ? ' [truncated]' : '';
        // 日志里输出完整摘要（或在无摘要时输出完整原文），便于排查 forward 实际入库内容；
        // 不再做 80 字 preview 截断，避免「日志看不到全貌」。原文/摘要都已入库到
        // forwardCache + memory metadata，后续 onebot_get_forward_msg 可直接取回。
        const fullPreview = (summary ?? expanded.fullText).replace(/\n/g, ' ');
        ctx.logger.debug(
          `forward 展开完成 id=${id} count=${expanded.count} participants=[${expanded.participants.join(',')}]` +
            ` summary=${summary ? `${summary.length}字` : 'null'}${truncFlag} content="${fullPreview}"`,
        );

        envelopeMap.set(id, buildEnvelope(expanded, summary));
      } catch (err) {
        ctx.logger.warn(`forward 展开失败 id=${id}: ${err}`);
        envelopeMap.set(id, `<forward id="${id}">[合并转发消息：展开过程出错]</forward>`);
      }
    }

    return text.replace(idRe, (raw, id: string) => envelopeMap.get(id) ?? raw);
  }

  return {
    getCachedForward,
    setCachedForward,
    loadPersistedForward,
    fetchForwardOnce,
    expandForwardsInText,
  };
}
