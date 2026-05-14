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
import { buildPreprocessor } from './preprocessor.js';
import { type MediaConfigResolved, MediaServiceImpl } from './service.js';
import { registerMediaTools } from './tools.js';

export const name = '@aalis/plugin-media';
export const displayName = '多模态媒体识别';
export const subsystem = 'media';
export const provides = ['media'];
export const inject = {
  optional: ['llm', 'agent'],
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
      prompt: { type: 'textarea', label: '自定义提示词', default: '' },
    },
  },
  audioTranscribe: {
    label: '音频转写 (ASR)',
    fields: {
      mode: {
        type: 'select',
        label: '模式',
        options: [
          { label: '启用', value: 'enabled' },
          { label: '禁用', value: 'disabled' },
        ],
        default: 'enabled',
      },
      prefer: {
        type: 'llm-ref',
        label: '优先 ASR Processor',
        description: '留空自动选；选定后强制使用该模型（需具 audio_transcription 或 audio 能力）。',
      },
      language: { type: 'string', label: '默认语种 (ISO 639-1)', default: '' },
    },
  },
  audioDescribe: {
    label: '音频描述 (audio-LLM)',
    fields: {
      mode: {
        type: 'select',
        label: '模式',
        options: [
          { label: '启用（需要支持 audio 能力的 LLM）', value: 'enabled' },
          { label: '禁用', value: 'disabled' },
        ],
        default: 'disabled',
      },
      prefer: {
        type: 'llm-ref',
        label: '优先模型',
        description: '留空自动选；选定后强制使用该模型（需具 audio 能力）。',
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
};

export const defaultConfig = {
  vision: { mode: 'describe', maxTokens: 300, prompt: '' },
  audioTranscribe: { mode: 'enabled', language: '' },
  audioDescribe: { mode: 'disabled' },
  video: { mode: 'frames+asr', maxFrames: 5 },
  document: { extractImages: false },
};

function resolveCfg(raw: Record<string, unknown>): MediaConfigResolved {
  const vision = (raw.vision ?? {}) as Record<string, unknown>;
  const audioT = (raw.audioTranscribe ?? {}) as Record<string, unknown>;
  const audioD = (raw.audioDescribe ?? {}) as Record<string, unknown>;
  const video = (raw.video ?? {}) as Record<string, unknown>;
  const document = (raw.document ?? {}) as Record<string, unknown>;
  return {
    vision: {
      mode: ((vision.mode as string) ?? 'describe') as MediaConfigResolved['vision']['mode'],
      prefer: (vision.prefer as string) || undefined,
      maxTokens: (vision.maxTokens as number) ?? 300,
      prompt: (vision.prompt as string) || undefined,
    },
    audio: {
      transcribe: {
        mode: ((audioT.mode as string) ?? 'enabled') as 'enabled' | 'disabled',
        prefer: (audioT.prefer as string) || undefined,
        language: (audioT.language as string) || undefined,
      },
      describe: {
        mode: ((audioD.mode as string) ?? 'disabled') as 'enabled' | 'disabled',
        prefer: (audioD.prefer as string) || undefined,
      },
    },
    video: {
      mode: ((video.mode as string) ?? 'frames+asr') as MediaConfigResolved['video']['mode'],
      maxFrames: Math.max(1, (video.maxFrames as number) ?? 5),
    },
    document: { extractImages: !!document.extractImages },
  };
}

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg = resolveCfg(raw);
  const logger = ctx.logger.child('media');
  const svc = new MediaServiceImpl(ctx, logger, cfg);

  ctx.provide('media', svc, { capabilities: ['vision', 'audio', 'video'] });

  // 注册 analyze_image / update_image_description 工具
  try {
    registerMediaTools(ctx, () => svc);
  } catch (err) {
    logger.debug(`媒体工具注册跳过（plugin-tools 未就绪？）: ${err instanceof Error ? err.message : err}`);
  }

  // 注册 preprocessor（agent 不一定可用，可选 inject）
  try {
    useAgent(ctx).registerPreprocessor(
      'media',
      buildPreprocessor(ctx, () => svc),
    );
    logger.info(
      `媒体识别预处理器已注册 (vision=${cfg.vision.mode}, audio.asr=${cfg.audio.transcribe.mode}, video=${cfg.video.mode})`,
    );
  } catch (err) {
    logger.debug(`预处理器注册跳过: ${err instanceof Error ? err.message : err}`);
  }
}
