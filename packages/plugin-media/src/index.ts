// ============================================================
// @aalis/plugin-media — 多模态媒体识别调度器
//
// 职责：
//   1. 注册 'media' 服务（MediaService），调度 vision/audio/video 处理
//   2. 内置 LLM-as-Processor adapter：自动把所有 vision/audio LLM 包装为 MediaProcessor
//   3. 注册 agent preprocessor，归一化 IncomingMessage.attachments 并写描述
//   4. 视频处理编排：ffmpeg 抽帧 + ASR 抽音轨 → 拼综合描述
//
// 与 plugin-image-recognition 的关系：
//   - plugin-image-recognition 已被本插件取代并删除
//   - 所有图片/动图/视频/音频路径统一走 attachments[]
// ============================================================

import type { ConfigSchema, Context } from '@aalis/core';
import { useAgent } from '@aalis/plugin-agent-api';
import { createProcessGateway } from '@aalis/plugin-process-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import { DEFAULT_AUDIO_PROMPT, DEFAULT_VISION_BATCH_PROMPT, DEFAULT_VISION_PROMPT } from './llm-adapter.js';
import { buildPreprocessor } from './preprocessor.js';
import { setMediaRuntime } from './runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from './service.js';
import { registerMediaTools } from './tools.js';

export const name = '@aalis/plugin-media';
export const displayName = '多模态媒体识别';
export const subsystem = 'media';
export const provides = ['media'];
export const inject = {
  required: ['process', 'storage'],
  optional: ['llm', 'agent', 'asr'],
};

export const configSchema: ConfigSchema = {
  vision: {
    label: '图像识别',
    fields: {
      mode: {
        type: 'select',
        label: '处理模式',
        options: [
          { label: '由副模型转文本（推荐，文本主模型也能用）', value: 'describe' },
          { label: '直通：原始图片交给主模型自行识别（需主模型有 vision 能力）', value: 'passthrough' },
          { label: '禁用：丢弃图片', value: 'disabled' },
        ],
        default: 'describe',
      },
      prefer: {
        type: 'llm-ref',
        label: '优先模型',
        description: '留空则自动选择优先级最高的 vision LLM；选定后强制使用该模型进行图像描述。',
      },
      maxTokens: { type: 'number', label: '描述最大 token', default: 300 },
      think: {
        type: 'boolean',
        label: '启用思考链 (thinking)',
        default: false,
        description: '启用后识别质量可能提升但 token 成本上升；关闭且后端为 Ollama 时会传 reasoning_effort=none。',
      },
      prompt: {
        type: 'textarea',
        label: '单图描述 prompt',
        default: '',
        description: `留空使用内置默认值。\n默认：${DEFAULT_VISION_PROMPT}`,
      },
      batchPrompt: {
        type: 'textarea',
        label: '多图批量描述 prompt',
        default: '',
        description: `多张图片一起描述时使用（动图抽帧 / 图组）。留空则回落到“单图 prompt”或内置默认。\n默认：${DEFAULT_VISION_BATCH_PROMPT}`,
      },
    },
  },
  audio: {
    label: '音频识别（转写 + 描述）',
    fields: {
      mode: {
        type: 'select',
        label: '模式',
        options: [
          { label: '启用（转写后注入上下文）', value: 'enabled' },
          { label: '直通：原始音频交给主模型（需主模型有 audio 能力）', value: 'passthrough' },
          { label: '禁用', value: 'disabled' },
        ],
        default: 'enabled',
      },
      language: {
        type: 'string',
        label: '默认语种 (ISO 639-1)',
        default: '',
        description: '仅对 Whisper 类 ASR 生效；LLM-as-audio 会在 prompt 里作为提示。',
      },
      maxTokens: {
        type: 'number',
        label: '最大输出 token',
        default: 1024,
        description: 'LLM-as-audio 专用。e4b 等小模型在 thinking enabled 下需 ≥1024，否则空响应。',
      },
      think: {
        type: 'boolean',
        label: '启用思考链 (thinking)',
        default: true,
        description:
          'LLM-as-audio 专用。启用后识别质量更高但 token 成本 ×5-8；关闭则会传 reasoning_effort=none 给 Ollama。',
      },
      prompt: {
        type: 'textarea',
        label: '自定义 prompt',
        default: '',
        description: `LLM-as-audio 专用。留空使用内置全能描述 prompt。\n默认：${DEFAULT_AUDIO_PROMPT}`,
      },
    },
  },
  video: {
    label: '视频识别',
    fields: {
      mode: {
        type: 'select',
        label: '模式',
        options: [
          { label: '关键帧 + 音轨转写', value: 'frames+asr' },
          { label: '仅关键帧', value: 'frames-only' },
          { label: '禁用', value: 'disabled' },
        ],
        default: 'frames+asr',
      },
      maxFrames: { type: 'number', label: '最大关键帧数', default: 5 },
      maxTokens: {
        type: 'number',
        label: '最大输出 token',
        default: 512,
        description: '仅对 video.passthrough（原生视频 LLM）生效；帧抽取描述由 vision.maxTokens 控制。',
      },
      think: {
        type: 'boolean',
        label: '启用思考链 (thinking)',
        default: false,
        description: '仅对 video.passthrough 生效。关闭且后端为 Ollama 时会传 reasoning_effort=none。',
      },
      prompt: {
        type: 'textarea',
        label: '自定义 prompt',
        default: '',
        description: '仅对 video.passthrough 生效；留空使用默认描述 prompt。',
      },
      framesHint: {
        type: 'textarea',
        label: '抽帧描述 hint',
        default: '',
        description: '抽帧后拼帧下发 vision 模型时的 hint。留空使用默认：“以下为同一视频的关键帧，按时间顺序排列。”',
      },
      animatedPrompt: {
        type: 'textarea',
        label: '动图/短视频描述 prompt',
        default: '',
        description:
          '`describeImage` 遇到动图时作为 vision.prompt 的 fallback hint。留空使用默认：“描述这个动图/视频。”',
      },
      framePrefix: {
        type: 'string',
        label: '画面描述前缀',
        default: '[画面] ',
        description: '拼到抽帧综合描述前的标记，例如 “[画面] …”。',
      },
      audioTrackPrefix: {
        type: 'string',
        label: '音轨转写前缀',
        default: '[音轨] ',
        description: '拼到视频音轨转写前的标记，例如 “[音轨] …”。',
      },
    },
  },
  document: {
    label: '文档',
    fields: {
      extractImages: {
        type: 'boolean',
        label: '抽取并识别文档内嵌图片（实验）',
        default: false,
      },
    },
  },
  animatedImage: {
    label: '动图 / GIF',
    fields: {
      maxFrames: {
        type: 'number',
        label: '最大关键帧数',
        default: 5,
        description:
          '动图（gif/webp 动画等）抽帧上限，与视频 video.maxFrames 独立。动图信息量较低，默认 5 已足够；调高会增加 vision 调用成本。',
      },
    },
  },
  contextHistory: {
    label: '多模态上下文注入',
    fields: {
      enabled: {
        type: 'boolean',
        label: '允许多模态 processor 读取聊天上下文',
        default: true,
        description:
          '启用后，图片描述 / 音频识别 / 视频抽帧调用多模态模型时，会将近期聊天记录拼到 prompt 里，让模型能联系上下文进行识别。对传统 Whisper-style ASR 后端无效。',
      },
      maxMessages: {
        type: 'number',
        label: '上下文最大消息条数',
        default: 4,
      },
    },
  },
  senderContext: {
    label: '发送者画像注入 (vision)',
    fields: {
      enabled: {
        type: 'boolean',
        label: '允许在 vision 上下文中注入发送者 user-profile 摘要',
        default: true,
        description:
          '启用后，vision 描述图片时会带上发送者的长期 fact 摘要（来自 plugin-user-profile），帮助模型理解 “草羊机截图 = Minecraft 玩家在炫耀” 类场景。读取失败微 user-profile 未启用时静默跳过，不会阻断识别。',
      },
      profileMaxChars: {
        type: 'number',
        label: 'profile 摘要最大字符数',
        default: 200,
        description: '超过截断。填 0 等于禁用 profile 注入。',
      },
    },
  },
};

export const defaultConfig = {
  vision: { mode: 'describe', maxTokens: 300, think: false, prompt: '', batchPrompt: '' },
  audio: { mode: 'enabled', language: '', maxTokens: 1024, think: true, prompt: '' },
  video: {
    mode: 'frames+asr',
    maxFrames: 5,
    maxTokens: 512,
    think: false,
    prompt: '',
    framesHint: '',
    animatedPrompt: '',
    framePrefix: '[画面] ',
    audioTrackPrefix: '[音轨] ',
  },
  document: { extractImages: false },
  animatedImage: { maxFrames: 5 },
  contextHistory: { enabled: true, maxMessages: 4 },
  senderContext: { enabled: true, profileMaxChars: 200 },
};

function resolveCfg(raw: Record<string, unknown>): MediaConfigResolved {
  const vision = (raw.vision ?? {}) as Record<string, unknown>;
  const audio = (raw.audio ?? {}) as Record<string, unknown>;
  const video = (raw.video ?? {}) as Record<string, unknown>;
  const document = (raw.document ?? {}) as Record<string, unknown>;
  return {
    vision: {
      mode: ((vision.mode as string) ?? 'describe') as MediaConfigResolved['vision']['mode'],
      prefer: (vision.prefer as MediaConfigResolved['vision']['prefer']) || undefined,
      maxTokens: (vision.maxTokens as number) ?? 300,
      think: vision.think === true,
      prompt: (vision.prompt as string) || undefined,
      batchPrompt: (vision.batchPrompt as string) || undefined,
    },
    audio: {
      mode: ((audio.mode as string) ?? 'enabled') as 'enabled' | 'passthrough' | 'disabled',
      language: (audio.language as string) || undefined,
      maxTokens: (audio.maxTokens as number) ?? 1024,
      think: audio.think !== false,
      prompt: (audio.prompt as string) || undefined,
    },
    video: {
      mode: ((video.mode as string) ?? 'frames+asr') as MediaConfigResolved['video']['mode'],
      maxFrames: Math.max(1, (video.maxFrames as number) ?? 5),
      maxTokens: (video.maxTokens as number) ?? 512,
      think: video.think === true,
      prompt: (video.prompt as string) || undefined,
      framesHint: (video.framesHint as string) || undefined,
      animatedPrompt: (video.animatedPrompt as string) || undefined,
      framePrefix: (video.framePrefix as string) ?? '[画面] ',
      audioTrackPrefix: (video.audioTrackPrefix as string) ?? '[音轨] ',
    },
    document: { extractImages: !!document.extractImages },
    animatedImage: {
      maxFrames: Math.max(1, (((raw.animatedImage ?? {}) as Record<string, unknown>).maxFrames as number) ?? 5),
    },
    contextHistory: {
      enabled: ((raw.contextHistory ?? {}) as Record<string, unknown>).enabled !== false,
      maxMessages: Math.max(0, Number(((raw.contextHistory ?? {}) as Record<string, unknown>).maxMessages ?? 4)),
    },
    senderContext: {
      enabled: ((raw.senderContext ?? {}) as Record<string, unknown>).enabled !== false,
      profileMaxChars: Math.max(
        0,
        Number(((raw.senderContext ?? {}) as Record<string, unknown>).profileMaxChars ?? 200),
      ),
    },
  };
}

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg = resolveCfg(raw);
  const logger = ctx.logger.child('media');
  setMediaRuntime({ proc: createProcessGateway(ctx), storage: createStorageGateway(ctx) });
  const svc = new MediaServiceImpl(ctx, logger, cfg);

  ctx.provide('media', svc, { capabilities: ['vision', 'audio', 'video'] });

  // 注册 analyze_image / update_image_description 工具
  try {
    registerMediaTools(ctx, () => svc);
  } catch (err) {
    logger.debug(`媒体工具注册跳过（plugin-tools 未就绪？）: ${err instanceof Error ? err.message : err}`);
  }

  // 注册 preprocessor（agent 不一定可用，可选 inject）
  // dispose 必须挂 onDispose：插件 bounce/reload 时旧 preprocessor 中间件不会被
  // 自动清理（注册在 agent.ctx 而非自身 ctx 上）。
  try {
    const disposePreproc = useAgent(ctx).registerPreprocessor(
      'media',
      buildPreprocessor(ctx, () => svc),
    );
    ctx.onDispose(disposePreproc);
    logger.info(`媒体识别预处理器已注册 (vision=${cfg.vision.mode}, audio=${cfg.audio.mode}, video=${cfg.video.mode})`);
  } catch (err) {
    logger.debug(`预处理器注册跳过: ${err instanceof Error ? err.message : err}`);
  }
}
