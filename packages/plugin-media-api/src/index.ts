// ============================================================
// @aalis/plugin-media-api — 多模态媒体识别契约
//
// Aalis 把"媒体 → 文本"的处理路径抽象为 MediaProcessor。
// plugin-media 既是该契约的调度器，也是 LLM 服务的内置 adapter
// （任意声明了 vision / audio 能力的 LLM 都自动暴露为对应 processor）。
// 真正"非 LLM"的 backend（如 whisper.cpp / 云 ASR）则注册为独立 processor。
//
// 依赖：仅 @aalis/core 与 @aalis/plugin-message-api。
// ============================================================

import type { Context } from '@aalis/core';
import type { ModelRef } from '@aalis/plugin-llm-api';
import type { IncomingMessage, MessageAttachment } from '@aalis/plugin-message-api';

/** 媒体能力枚举（与 LLM Capability 互不重叠：LLM 描述模型能力，Media 描述处理动作） */
export type MediaCapability =
  /** 给图描述（含动图抽帧后整合） */
  | 'vision'
  /** 音频转字幕/逐字稿（whisper-style） */
  | 'audio.transcribe'
  /** 音频自然语言描述（含环境音、情绪、音乐风格等，需 audio-LLM） */
  | 'audio.describe'
  /** 视频原生理解（passthrough，需要 LLM 支持 video） */
  | 'video.passthrough'
  /** 文档内嵌图片识别（OCR / 图理解） */
  | 'document.image';

/** Processor 的处理动作语义。一个 backend 可同时声明多种 cap。 */
export interface MediaProcessor {
  /** 唯一标识，建议 `<provider>:<modelOrKind>` 形式 */
  name: string;
  /** 可处理的能力集 */
  capabilities: MediaCapability[];
  /** 显示名（UI 用） */
  displayName?: string;
  /** 优先级（数值大者优先；同 cap 多 processor 时由 MediaService 仲裁；默认 0） */
  priority?: number;
  /** 描述/识别（用于 vision / audio.describe / document.image / video.passthrough） */
  describe?(input: DescribeInput, ctx: Context): Promise<DescribeResult>;
  /** 转写（用于 audio.transcribe） */
  transcribe?(input: TranscribeInput, ctx: Context): Promise<TranscribeResult>;
}

export interface DescribeInput {
  /** 待描述的附件（同一 batch 内 mime/kind 由调用方保证一致） */
  attachments: MessageAttachment[];
  /** 上下文提示（可选）：例如 "请详细描述这些图片中的人物表情" */
  hint?: string;
  /**
   * 对话上下文文本（可选）：plugin-media 从近期聊天历史构建，
   * processor 可拼接到 prompt 里让 LLM 能联系上下文理解附件。
   */
  context?: string;
  /** 期望最大输出 token */
  maxTokens?: number;
  /** 调用语义：'single' 每个 attachment 单独描述；'combined' 合并描述 */
  mode?: 'single' | 'combined';
}

export interface DescribeResult {
  /** 与 attachments 等长（mode=single）或单元素（mode=combined） */
  descriptions: string[];
  /** 用于审计 / debug */
  meta?: { processor: string; model?: string; tokens?: number };
}

export interface TranscribeInput {
  /** 单条音频 attachment */
  attachment: MessageAttachment;
  /** 期望语种（ISO 639-1，如 'zh' / 'en'）；不填由 backend 自检 */
  language?: string;
  /** 是否需要时间戳分段 */
  withTimestamps?: boolean;
  /**
   * 对话上下文文本（可选）：仅当 backend 为 LLM-as-ASR（如 gemma4:e4b）时有意义；
   * 传统 Whisper 类 ASR 端点会忽略。
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
  meta?: { processor: string; model?: string };
}

// ----- 服务接口 -----

/** plugin-media 暴露的服务（subsystem='media'） */
export interface MediaService {
  /** 注册非 LLM 的 backend（LLM 走内置 adapter 自动注册，无需手动调用） */
  registerProcessor(p: MediaProcessor): () => void;
  /** 列出当前可用 processor */
  listProcessors(cap?: MediaCapability): MediaProcessor[];
  /** 选 processor：优先 prefer（可是 processor name 字符串或 LLM ModelRef），再按 priority；找不到返回 null */
  pickProcessor(cap: MediaCapability, prefer?: string | ModelRef | null): MediaProcessor | null;

  /** 描述：根据每个 attachment 的 kind/mime 自动选 processor */
  describe(attachments: MessageAttachment[], opts?: DescribeOptions): Promise<Array<string | undefined>>;
  /** 转写：单条音频 */
  transcribe(attachment: MessageAttachment, opts?: TranscribeOptions): Promise<string | undefined>;

  /**
   * 一站式：处理整条 IncomingMessage 的所有 attachments，
   * 把每条附件的文本描述写入 msg._attachmentDescriptions（与 attachments 同长度）。
   * 由 plugin-media 的 preprocessor 内部调用，外部一般不需要直接用。
   */
  processMessage(msg: IncomingMessage): Promise<MediaProcessReport>;

  // ===== 描述缓存 / 上下文构造（image-rec 合并而来）=====

  /**
   * 主动描述单张图片（含动图自动多帧）。失败返回空串。
   * 与 describe([att]) 不同：本方法专为 `analyze_image` 等单图工具优化，
   * 内部走描述缓存（同 url 24h 内复用）；可传 hint 注入用户意图。
   */
  describeImage(imageUrl: string, opts?: DescribeImageOptions): Promise<string>;

  /** 查描述缓存（不触发识别）。未命中返回 null。 */
  lookupDescription(imageUrl: string): string | null;

  /** 写入描述缓存（一般由 describeImage 自动调用，外部很少用）。 */
  rememberDescription(imageUrl: string, description: string): void;

  /**
   * 为含图消息构造视觉识别上下文（当前消息 + 引用消息 + 最近历史）。
   * 用作 vision LLM 的 hint，让模型聚焦用户真正关心的问题。
   */
  buildContext(msg: IncomingMessage, opts?: BuildContextOptions): Promise<string>;
}

export interface DescribeImageOptions {
  /** 用户意图 / 上下文（如 "找出图中的猫"） */
  hint?: string;
  /** 本地缓存路径（用于动图帧提取，避免重新下载远程文件） */
  localPath?: string;
  /** 跳过缓存读写（true 时即使有缓存也会重新识别） */
  noCache?: boolean;
  /** 最大输出 token */
  maxTokens?: number;
}

export interface BuildContextOptions {
  /** 最近前文条数，默认由实现决定 */
  beforeLimit?: number;
}

export interface DescribeOptions {
  hint?: string;
  maxTokens?: number;
  /** 强制使用某个 processor（processor name 或 LLM ModelRef） */
  prefer?: string | ModelRef;
}

export interface TranscribeOptions {
  language?: string;
  withTimestamps?: boolean;
  prefer?: string | ModelRef;
}

export interface MediaProcessReport {
  total: number;
  successCount: number;
  /** 与 msg.attachments 同长度，对应每条的处理结果摘要 */
  items: Array<{
    kind: MessageAttachment['kind'];
    cap?: MediaCapability;
    processor?: string;
    description?: string;
    error?: string;
  }>;
}

/** 助手：从 ctx 取媒体服务（subsystem='media' 唯一服务）。 */
export function useMediaService(ctx: Context): MediaService | undefined {
  return ctx.getService<MediaService>('media');
}

// ----- 事件 -----

declare module '@aalis/core' {
  interface AalisEvents {
    /**
     * 一条入站消息的所有附件已被 plugin-media 处理（成功或失败均会发）。
     * 用于 webui / archive / 调试日志。
     */
    'media:processed': [data: { sessionId: string; report: MediaProcessReport }];
  }
}
