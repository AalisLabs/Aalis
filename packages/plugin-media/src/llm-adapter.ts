// ============================================================
// llm-adapter.ts — 把声明了 vision/audio 能力的 LLM 自动包装为 MediaProcessor
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

const DEFAULT_AUDIO_PROMPT =
  '请描述这段音频的内容（语音内容、环境音、情绪、音乐风格等）。用中文回答，控制在150字以内。';

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
  return {
    name,
    capabilities: [cap],
    displayName: `${entry.label ?? entry.contextId} (${capShortName(cap)})`,
    priority: 0,
    async describe(input: DescribeInput, _ctx: Context): Promise<DescribeResult> {
      const prompt = input.hint
        ? `${opts.prompt ?? defaultPromptFor(cap, input.attachments.length)}\n\n额外要求：${input.hint}`
        : (opts.prompt ?? defaultPromptFor(cap, input.attachments.length));
      const maxTokens = input.maxTokens ?? opts.maxTokens ?? 300;

      // image / video.passthrough 走 images[] 字段
      // audio describe 走 images[] 是不正确的；plugin-llm 当前没有 audio 字段，
      // 所以本 adapter 仅在 LLM 实际声明 Audio capability 时才注册 audio.describe。
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

      if (cap === 'audio.describe') {
        // 当前 LLM 协议 Message 没有 audio 字段。Adapter 把 audio data 内联到 content
        // 的方式 provider-specific，故在通用层我们仅支持把 audio 转成"提示词描述请求"，
        // 让支持 audio 的 provider plugin 自行扩展（例如未来 plugin-gemini 实现自定义 adapter）。
        // 此处保底：返回明确的"未实现"占位，避免静默失败。
        throw new Error(
          `LLM "${entry.contextId}" 声明了 Audio 能力，但 plugin-media 通用 adapter 暂不支持音频字段。请由 provider plugin 注册专门的 MediaProcessor。`,
        );
      }

      throw new Error(`LLM adapter 不支持 capability=${cap}`);
    },
  };
}

function capShortName(cap: MediaCapability): string {
  switch (cap) {
    case 'vision':
      return 'vision';
    case 'audio.transcribe':
      return 'asr';
    case 'audio.describe':
      return 'audio';
    case 'video.passthrough':
      return 'video';
    case 'document.image':
      return 'doc-img';
  }
}

function defaultPromptFor(cap: MediaCapability, count: number): string {
  if (cap === 'audio.describe') return DEFAULT_AUDIO_PROMPT;
  if (count > 1) return DEFAULT_VISION_BATCH_PROMPT;
  return DEFAULT_VISION_PROMPT;
}

/**
 * 扫描当前 ctx 中所有 LLM entry，按其声明的能力返回应注册的 MediaProcessor 数组。
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
    if (caps.includes(LLMCapabilities.Audio)) {
      processors.push(wrapLLMAsProcessor(entry, 'audio.describe', opts));
    }
    if (caps.includes(LLMCapabilities.Video)) {
      processors.push(wrapLLMAsProcessor(entry, 'video.passthrough', opts));
    }
  }
  return processors;
}
