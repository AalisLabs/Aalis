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
import { materializeAttachment, transcodeAudioToWav } from './ffmpeg.js';

const DEFAULT_VISION_PROMPT =
  '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如有）、表情包含义等。用中文回答，控制在100字以内。';

const DEFAULT_VISION_BATCH_PROMPT =
  '以下是一组（按时间或上下文顺序排列的）图片。请综合所有图片做一段统一描述，重点说明动态变化、关键元素和含义。用中文回答，控制在150字以内。';

// 全能音频 prompt：语音转写为原文 + 音乐/环境音描述。
// 注意：e4b 这类小模型在 thinking enabled 时此类开放式 prompt 会消耗
// ~600-900 completion token；要求 maxTokens 至少 1024，否则会被截断为空。
// 详见 /memories/repo/aalis-ollama-gemma4-audio.md。
const DEFAULT_AUDIO_PROMPT =
  '请用中文描述这段音频的内容：' +
  '若含语音/对话则转写为原文（中文用中文写，英文保留英文）；' +
  '若含音乐则描述风格、乐器、情绪及可识别歌词；' +
  '若是环境音/音效则描述场景；' +
  '仅输出内容本身，不要 markdown 标记。';

interface LlmProcessorOptions {
  /** 自定义 prompt 覆盖默认值 */
  prompt?: string;
  /** 最大输出 tokens */
  maxTokens?: number;
  /**
   * 是否启用 thinking（思考链）。
   * - true（默认）：模型先内部推理后输出，质量更好但 token 消耗 ~5-8 倍
   * - false：直接输出，token 省但全能 prompt 下偶发 echo prompt
   * 对 Ollama OpenAI 兼容路径会翻译为 `reasoning_effort: "none"`。
   */
  think?: boolean;
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
 * 处理策略：
 * 1. 物化到本地文件
 * 2. 探测 magic header；mp3/wav/ogg/m4a/flac 等主流格式直接透传
 * 3. 其它格式（含 OneBot/NapCat 常见的 amr 与 raw audio）一律用 ffmpeg
 *    转码为 16kHz mono WAV，这是 Gemma 3n 等多模态 LLM 官方推荐的格式
 * 4. ffmpeg 转码失败（典型如 SILK——ffmpeg 没有 silk 解码器）才抛错
 */
async function audioToBase64(data: string): Promise<string> {
  const mat = await materializeAttachment(data);
  if (!mat) throw new Error(`无法物化音频附件: ${data.slice(0, 80)}`);
  try {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(mat.path);
    const fmt = detectAudioFormat(buf);

    // 主流格式：多模态 LLM 与 Whisper 都能直接解码，无需转码
    if (fmt === 'mp3' || fmt === 'wav' || fmt === 'ogg' || fmt === 'm4a' || fmt === 'flac') {
      return buf.toString('base64');
    }

    // 其它格式（amr / silk / unknown / 裸 PCM 等）一律走 ffmpeg 转 WAV
    const wav = await transcodeAudioToWav(mat.path);
    if (!wav) {
      throw new Error(
        `音频格式为 ${fmt}，ffmpeg 无法转码为 WAV（可能是 SILK 或加密格式）；` +
          '请检查 OneBot 实现端 get_record 是否真正执行了 silk→mp3 转码',
      );
    }
    return wav;
  } finally {
    await mat.cleanup();
  }
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
      // audio 默认更大：e4b thinking enabled 时全能 prompt 消耗 ~600-900 token
      const defaultMax = cap === 'audio' ? 1024 : 300;
      const maxTokens = input.maxTokens ?? opts.maxTokens ?? defaultMax;
      // audio 默认保留 thinking（识别质量更高）；其他 cap 维持原 false 行为。
      const think = opts.think ?? cap === 'audio';

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

      if (cap === 'audio') {
        // 把音频附件转 base64 后放到 Message.audios，由 provider 适配（如 plugin-ollama 走 chat-completions audio 块）
        const audios = await Promise.all(input.attachments.map(a => audioToBase64(a.data)));
        const sizesKB = audios.map(a => Math.round((a.length * 3) / 4 / 1024));
        const messages: Message[] = [{ role: 'user', content: prompt, audios }];
        const t0 = Date.now();
        _ctx.logger.info(
          `[audio.describe] 调用 ${llm.id}，${audios.length} 段音频 (${sizesKB.join('/')}KB), maxTokens=${maxTokens}, think=${think}`,
        );
        const resp = await llm.chat({ messages, maxTokens, think });
        const rawLen = resp.content?.length ?? 0;
        const text = resp.content?.trim() ?? '';
        _ctx.logger.info(
          `[audio.describe] ${llm.id} 完成 ${Date.now() - t0}ms, raw=${rawLen}字 trim=${text.length}字, tokens=${resp.usage?.totalTokens ?? '?'}` +
            (rawLen > 0 ? `, 内容前200字="${(resp.content ?? '').slice(0, 200).replace(/\n/g, ' ')}"` : ' [空响应]'),
        );
        return {
          descriptions: input.mode === 'single' ? input.attachments.map(() => text) : [text],
          meta: { processor: name, model: llm.id, tokens: resp.usage?.totalTokens },
        };
      }

      throw new Error(`LLM adapter 不支持 capability=${cap}`);
    },
  };

  if (cap === 'audio') {
    proc.transcribe = async (input: TranscribeInput, _ctx: Context): Promise<TranscribeResult> => {
      const langHint = input.language ? `\n* 输出语言：${input.language}` : '';
      const ctxBlock = input.context ? `\n\n上下文/最近对话:\n${input.context}` : '';
      const prompt = `${opts.prompt ?? DEFAULT_AUDIO_PROMPT}${langHint}${ctxBlock}`;
      const b64 = await audioToBase64(input.attachment.data);
      const sizeKB = Math.round((b64.length * 3) / 4 / 1024);
      const audios = [b64];
      const messages: Message[] = [{ role: 'user', content: prompt, audios }];
      const maxTokens = opts.maxTokens ?? 1024;
      const think = opts.think ?? true;
      const t0 = Date.now();
      _ctx.logger.info(
        `[audio.transcribe] 调用 ${llm.id}，音频 ${sizeKB}KB, prompt ${prompt.length}字, maxTokens=${maxTokens}, think=${think}`,
      );
      const resp = await llm.chat({ messages, maxTokens, think });
      const rawLen = resp.content?.length ?? 0;
      const text = (resp.content ?? '').trim();
      _ctx.logger.info(
        `[audio.transcribe] ${llm.id} 完成 ${Date.now() - t0}ms, raw=${rawLen}字 trim=${text.length}字, tokens=${resp.usage?.totalTokens ?? '?'}` +
          (rawLen > 0
            ? `, 内容前200字="${(resp.content ?? '').slice(0, 200).replace(/\n/g, ' ')}"`
            : ' [空响应——模型未返回任何内容]'),
      );
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
    case 'audio':
      return 'audio';
    case 'video.passthrough':
      return 'video';
    case 'document.image':
      return 'doc-img';
  }
}

function defaultPromptFor(cap: MediaCapability, count: number): string {
  if (cap === 'audio') return DEFAULT_AUDIO_PROMPT;
  if (count > 1) return DEFAULT_VISION_BATCH_PROMPT;
  return DEFAULT_VISION_PROMPT;
}

/**
 * 扫描当前 ctx 中所有 LLM entry，按其声明的能力返回应注册的 MediaProcessor 数组。
 */
/**
 * 扫描当前 ctx 中所有 LLM entry，按其声明的能力返回应注册的 MediaProcessor 数组。
 * @param opts 默认应用于所有 cap 的参数，以及 per-cap 覆盖（audio 可独立配 prompt/maxTokens/think）
 */
export function scanLLMProcessors(
  ctx: Context,
  opts: LlmProcessorOptions & { audio?: LlmProcessorOptions } = {},
): MediaProcessor[] {
  const { audio: audioOverride, ...defaults } = opts;
  const processors: MediaProcessor[] = [];
  const all = ctx.getAllServices<LLMModel>('llm');
  for (const entry of all) {
    const caps = entry.capabilities;
    if (caps.includes(LLMCapabilities.Vision)) {
      processors.push(wrapLLMAsProcessor(entry, 'vision', defaults));
      processors.push(wrapLLMAsProcessor(entry, 'document.image', defaults));
    }
    if (caps.includes(LLMCapabilities.Audio)) {
      // Gemma 3n / Gemini / GPT-4o-audio 等原生音频 LLM 单一 cap 覆盖转写 + 描述，由全能 prompt 驱动
      processors.push(wrapLLMAsProcessor(entry, 'audio', { ...defaults, ...audioOverride }));
    }
    if (caps.includes(LLMCapabilities.Video)) {
      processors.push(wrapLLMAsProcessor(entry, 'video.passthrough', defaults));
    }
  }
  return processors;
}
