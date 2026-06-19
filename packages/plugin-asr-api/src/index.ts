// ============================================================
// @aalis/plugin-asr-api — 语音识别(ASR)服务契约
//
// 把"音频 → 文本"抽象为核心 `asr` 服务：whisper.cpp / 云 ASR / LLM-as-audio
// 都以 `ctx.provide('asr', impl, { capabilities, priority })` 注册为多 provider，
// 消费方 `getService('asr', ['audio'])` 由核心按「偏好 > 优先级 > capability」解析。
// 用哪个 provider 经核心 servicePreferences（WebUI「服务」页下拉框）切换——
// 多个 whisper / whisper+云ASR / LLM-as-audio 在同一下拉框里平等可选。
//
// 依赖：仅 @aalis/core 与 @aalis/plugin-message-api。
// ============================================================

import type { Context } from '@aalis/core';
import type { MessageAttachment } from '@aalis/plugin-message-api';

/** ASR 能力枚举 */
export type ASRCapability =
  /** 语音/音频转文本 */
  | 'audio'
  /** 支持时间戳分段输出 */
  | 'timestamps';

export interface TranscribeInput {
  /** 单条音频 attachment */
  attachment: MessageAttachment;
  /** 期望语种（ISO 639-1，如 'zh' / 'en'）；不填由 backend 自检 */
  language?: string;
  /** 是否需要时间戳分段 */
  withTimestamps?: boolean;
  /**
   * 对话上下文文本（可选）：仅当 backend 为 LLM-as-audio 时有意义；
   * 传统 Whisper 类 ASR 会忽略。
   */
  context?: string;
}

export interface TranscribeResult {
  /** 完整文本 */
  text: string;
  /** 分段（如 backend 提供） */
  segments?: Array<{ start: number; end: number; text: string }>;
  /** 检测到的语种 */
  language?: string;
  meta?: { processor?: string; model?: string };
}

/**
 * ASR 服务：把单条音频转成文本。
 * 多个 provider 由核心 DI 仲裁（偏好 > 优先级 > capability）；消费方无需感知具体后端。
 */
export interface ASRService {
  transcribe(input: TranscribeInput, ctx: Context): Promise<TranscribeResult>;
}

/** 助手：从 ctx 取首选 ASR 服务（按核心「偏好 > 优先级」解析）。无可用后端返回 undefined。 */
export function useASRService(ctx: Context): ASRService | undefined {
  return ctx.getService<ASRService>('asr', ['audio']);
}

// ----- 服务类型 + 能力注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    asr: ASRService;
  }
  interface ServiceCapabilityMap {
    asr: ASRCapability;
  }
}
