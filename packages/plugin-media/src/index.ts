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
  audio: {
    label: '音频识别（转写 + 描述）',
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
        label: '优先音频 Processor',
        description: '留空自动选；选定后强制使用该模型。需其提供 audio cap（LLM-as-audio 或 Whisper 类 ASR）。',
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
        description: 'LLM-as-audio 专用。留空使用内置全能描述 prompt。',
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
};

export const defaultConfig = {
  vision: { mode: 'describe', maxTokens: 300, prompt: '' },
  audio: { mode: 'enabled', language: '', maxTokens: 1024, think: true, prompt: '' },
  video: { mode: 'frames+asr', maxFrames: 5 },
  document: { extractImages: false },
  contextHistory: { enabled: true, maxMessages: 4 },
};

function resolveCfg(raw: Record<string, unknown>): MediaConfigResolved {
  const vision = (raw.vision ?? {}) as Record<string, unknown>;
  const audio = (raw.audio ?? {}) as Record<string, unknown>;
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
      mode: ((audio.mode as string) ?? 'enabled') as 'enabled' | 'disabled',
      prefer: (audio.prefer as string) || undefined,
      language: (audio.language as string) || undefined,
      maxTokens: (audio.maxTokens as number) ?? 1024,
      think: audio.think !== false,
      prompt: (audio.prompt as string) || undefined,
    },
    video: {
      mode: ((video.mode as string) ?? 'frames+asr') as MediaConfigResolved['video']['mode'],
      maxFrames: Math.max(1, (video.maxFrames as number) ?? 5),
    },
    document: { extractImages: !!document.extractImages },
    contextHistory: {
      enabled: ((raw.contextHistory ?? {}) as Record<string, unknown>).enabled !== false,
      maxMessages: Math.max(0, Number(((raw.contextHistory ?? {}) as Record<string, unknown>).maxMessages ?? 4)),
    },
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
    logger.info(`媒体识别预处理器已注册 (vision=${cfg.vision.mode}, audio=${cfg.audio.mode}, video=${cfg.video.mode})`);
  } catch (err) {
    logger.debug(`预处理器注册跳过: ${err instanceof Error ? err.message : err}`);
  }
}
