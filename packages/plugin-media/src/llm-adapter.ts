// ============================================================
// llm-adapter.ts — 把声明了 vision 能力的 LLM 自动包装为 MediaProcessor
//
// 注：audio 调用由专门的 ASR 插件（plugin-asr-whisper-cpp / plugin-asr-openai）
// 提供。LLM 作为音频端要求的金子路径仅 OpenAI Realtime / gpt-4o-audio /
// Gemini Live 等云端服务可用，本地 Ollama 0.24.x 在完成 audio I/O 之前
// 不进入本路径。
// ============================================================

import type { Context } from '@aalis/core';
import type { LLMModel, LLMModelEntry } from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import type { DescribeInput, DescribeResult, MediaCapability, MediaProcessor } from '@aalis/plugin-media-api';
import type { Message } from '@aalis/plugin-message-api';

const DEFAULT_VISION_PROMPT =
  '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如有）、表情包含义等。用中文回答，控制在100字以内。';

const DEFAULT_VISION_BATCH_PROMPT =
  '以下是一组（按时间或上下文顺序排列的）图片。请综合所有图片做一段统一描述，重点说明动态变化、关键元素和含义。用中文回答，控制在150字以内。';

interface LlmProcessorOptions {
  /** 自定义 prompt 覆盖默认值 */
  prompt?: string;
  /** 最大输出 tokens */
  maxTokens?: number;
}

/** 把单个 LLMModelEntry 包装成 MediaProcessor。 */
function wrapLLMAsProcessor(
  entry: LLMModelEntry,
  cap: MediaCapability,
  opts: LlmProcessorOptions = {},
): MediaProcessor {
  const llm: LLMModel = entry.instance;
  const name = `llm:${entry.contextId}#${capShortName(cap)}`;
  const proc: MediaProcessor = {
    name,
    capabilities: [cap],
    displayName: `${entry.label ?? entry.contextId} (${capShortName(cap)})`,
    priority: 0,
    async describe(input: DescribeInput, _ctx: Context): Promise<DescribeResult> {
      const base = opts.prompt ?? defaultPromptFor(cap, input.attachments.length);
      const ctxBlock = input.context ? `\n\n上下文/最近对话:\n${input.context}` : '';
      const hintBlock = input.hint ? `\n\n额外要求：${input.hint}` : '';
      const prompt = `${base}${ctxBlock}${hintBlock}`;
      const maxTokens = input.maxTokens ?? opts.maxTokens ?? 300;

      // image / video.passthrough 走 images[] 字段
      // 视频帧已被预处理拆为图片再调用本方法。
      if (cap === 'vision' || cap === 'document.image' || cap === 'video.passthrough') {
        const images = input.attachments.map(a => a.data);
        const messages: Message[] = [{ role: 'user', content: prompt, images }];
        const resp = await llm.chat({ messages, maxTokens, think: false });
        const text = resp.content?.trim() ?? '';
        return {
          descriptions: input.mode === 'single' ? input.attachments.map(() => text) : [text],
          meta: { processor: name, model: llm.id, tokens: resp.usage?.totalTokens },
        };
      }

      throw new Error(`LLM adapter 不支持 capability=${cap}`);
    },
  };

  return proc;
}

function capShortName(cap: MediaCapability): string {
  switch (cap) {
    case 'vision':
      return 'vision';
    case 'audio':
      return 'audio';
    case 'video.passthrough':
      return 'video';
    case 'document.image':
      return 'doc-img';
  }
}

function defaultPromptFor(_cap: MediaCapability, count: number): string {
  if (count > 1) return DEFAULT_VISION_BATCH_PROMPT;
  return DEFAULT_VISION_PROMPT;
}

/**
 * 扫描当前 ctx 中所有 LLM entry，按其声明的能力返回应注册的 MediaProcessor 数组。
 * 注：audio 能力不再由 LLM 适配器提供——现有本地 LLM runtime (Ollama 0.24.x)
 * HTTP API 未暴露音频输入字段。请启用 @aalis/plugin-asr-whisper-cpp 或
 * @aalis/plugin-asr-openai 提供语音识别能力。
 */
export function scanLLMProcessors(ctx: Context, opts: LlmProcessorOptions = {}): MediaProcessor[] {
  const processors: MediaProcessor[] = [];
  const all = ctx.getAllServices<LLMModel>('llm');
  for (const entry of all) {
    const caps = entry.capabilities;
    if (caps.includes(LLMCapabilities.Vision)) {
      processors.push(wrapLLMAsProcessor(entry, 'vision', opts));
      processors.push(wrapLLMAsProcessor(entry, 'document.image', opts));
    }
    if (caps.includes(LLMCapabilities.Video)) {
      processors.push(wrapLLMAsProcessor(entry, 'video.passthrough', opts));
    }
  }
  return processors;
}
