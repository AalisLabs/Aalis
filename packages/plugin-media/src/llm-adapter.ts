// ============================================================
// llm-adapter.ts — 把声明了 vision/audio 能力的 LLM 自动包装为 MediaProcessor
// ============================================================

import type { Context } from '@aalis/core';
import type { LLMModel, LLMModelEntry } from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import type {
  DescribeInput,
  DescribeResult,
  MediaCapability,
  MediaProcessor,
  TranscribeInput,
  TranscribeResult,
} from '@aalis/plugin-media-api';
import type { Message } from '@aalis/plugin-message-api';
import { materializeAttachment } from './ffmpeg.js';

const DEFAULT_VISION_PROMPT =
  '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如有）、表情包含义等。用中文回答，控制在100字以内。';

const DEFAULT_VISION_BATCH_PROMPT =
  '以下是一组（按时间或上下文顺序排列的）图片。请综合所有图片做一段统一描述，重点说明动态变化、关键元素和含义。用中文回答，控制在150字以内。';

const DEFAULT_AUDIO_DESCRIBE_PROMPT =
  '请描述这段音频的内容（语音内容大意、环境音、情绪、音乐风格等）。用中文回答，控制在150字以内。';

// ASR prompt：参考 Google Gemma 3n 官方 audio_understanding 范例措辞，要求模型只输出原文转写。
const DEFAULT_AUDIO_TRANSCRIBE_PROMPT =
  '请将下面这段语音转写为原始语言的文字。严格遵循以下格式要求：\n* 仅输出转写文本，不要换行，不要任何前缀或解释。\n* 数字以阿拉伯数字呈现（例如写「3」而非「三」、写「1.7」而非「一点七」）。';

interface LlmProcessorOptions {
  /** 自定义 prompt 覆盖默认值 */
  prompt?: string;
  /** 最大输出 tokens */
  maxTokens?: number;
}

/**
 * 通过 magic header 探测音频格式，仅用于诊断 / 拒绝不支持的格式。
 * 返回简短格式名（mp3/wav/ogg/m4a/amr/silk/unknown）。
 */
function detectAudioFormat(buf: Buffer): string {
  if (buf.length < 12) return 'unknown';
  // SILK V3：QQ 语音原生格式，前 1 字节可能为 0x02（"flags" 前缀），随后 "#!SILK_V3"
  const silkHead = buf[0] === 0x02 ? buf.subarray(1, 10) : buf.subarray(0, 9);
  if (silkHead.toString('ascii') === '#!SILK_V3') return 'silk';
  // AMR：'#!AMR\n' 或 '#!AMR-WB\n'
  if (buf.subarray(0, 5).toString('ascii') === '#!AMR') return 'amr';
  // mp3：'ID3' 或 MPEG 同步帧 0xFFEx / 0xFFFx
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  // WAV：'RIFF....WAVE'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  // OGG：'OggS'
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  // M4A / MP4：offset 4 'ftyp'
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  // FLAC：'fLaC'
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  return 'unknown';
}

/**
 * 把 audio attachment.data 解析为 base64（去掉 data: 前缀），供 LLM provider 直接使用。
 *
 * 会做一次格式校验：QQ 原生 SILK 格式没有任何主流多模态 LLM / Whisper 能直接解码，
 * 这里命中即抛错，让上游写入清晰的 warn（典型成因：OneBot 实现端 `get_record` 没真正
 * 执行 silk→mp3 转码，只是改了扩展名）。
 */
async function audioToBase64(data: string): Promise<string> {
  let buf: Buffer;
  const m = data.match(/^data:[^;]+;base64,(.+)$/);
  if (m) {
    buf = Buffer.from(m[1], 'base64');
  } else {
    const mat = await materializeAttachment(data);
    if (!mat) throw new Error(`无法物化音频附件: ${data.slice(0, 80)}`);
    try {
      const { readFile } = await import('node:fs/promises');
      buf = await readFile(mat.path);
    } finally {
      await mat.cleanup();
    }
  }
  const fmt = detectAudioFormat(buf);
  if (fmt === 'silk' || fmt === 'amr') {
    throw new Error(
      `音频格式为 ${fmt}，主流多模态 LLM/Whisper 均无法解码；请确认 OneBot 实现端 get_record 已正确转码到 mp3/wav`,
    );
  }
  return buf.toString('base64');
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
      const prompt = input.hint
        ? `${opts.prompt ?? defaultPromptFor(cap, input.attachments.length)}\n\n额外要求：${input.hint}`
        : (opts.prompt ?? defaultPromptFor(cap, input.attachments.length));
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

      if (cap === 'audio.describe') {
        // 把音频附件转 base64 后放到 Message.audios，由 provider 适配（如 plugin-ollama 透传给 /api/chat audios 字段）
        const audios = await Promise.all(input.attachments.map(a => audioToBase64(a.data)));
        const messages: Message[] = [{ role: 'user', content: prompt, audios }];
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

  if (cap === 'audio.transcribe') {
    proc.transcribe = async (input: TranscribeInput, _ctx: Context): Promise<TranscribeResult> => {
      const langHint = input.language ? `\n* 输出语言：${input.language}` : '';
      const prompt = `${opts.prompt ?? DEFAULT_AUDIO_TRANSCRIBE_PROMPT}${langHint}`;
      const audios = [await audioToBase64(input.attachment.data)];
      const messages: Message[] = [{ role: 'user', content: prompt, audios }];
      const resp = await llm.chat({ messages, maxTokens: opts.maxTokens ?? 512, think: false });
      const text = (resp.content ?? '').trim();
      return {
        text,
        language: input.language,
        meta: { processor: name, model: llm.id },
      };
    };
  }

  return proc;
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
  if (cap === 'audio.describe') return DEFAULT_AUDIO_DESCRIBE_PROMPT;
  if (cap === 'audio.transcribe') return DEFAULT_AUDIO_TRANSCRIBE_PROMPT;
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
      // Gemma 3n / Gemini / GPT-4o-audio 等原生音频 LLM 同时具备「描述」与「转写」能力，
      // 仅靠不同 prompt 即可切换；都注册以让 MediaService 的 transcribe-first / describe-fallback 链路完整。
      processors.push(wrapLLMAsProcessor(entry, 'audio.transcribe', opts));
      processors.push(wrapLLMAsProcessor(entry, 'audio.describe', opts));
    }
    if (caps.includes(LLMCapabilities.Video)) {
      processors.push(wrapLLMAsProcessor(entry, 'video.passthrough', opts));
    }
  }
  return processors;
}
