// ----- 图像识别服务接口 -----
//
// 由 plugin-image-recognition 等插件实现。其他插件（如 plugin-message-archive、
// plugin-memory-summary）通过 `ctx.getService<ImageRecognitionService>('image-recognition')`
// 消费该服务，无需依赖具体实现。
//
// 第三方若要实现替代方案（如调用专用视觉 API），只需满足本接口即可。

import type { IncomingMessage } from '@aalis/core';
import { registerCapabilityProbe } from '@aalis/core';

/** 图像识别处理消息的输入 */
export interface ImageRecognitionInput {
  /** 文本内容 */
  content: string;
  /** 图片列表（URL / data URI / 本地路径） */
  images: string[];
  /** 可选：当前消息、引用消息或最近上下文，用于指导图片识别重点 */
  context?: string;
  /** 可选：附件出现顺序，用于在 transformedContent 中保留图文混排 */
  attachmentOrder?: Array<'image' | 'file'>;
}

/** 图像识别上下文构造选项 */
export interface ImageRecognitionContextOptions {
  /** 最近前文条数，默认由实现决定 */
  beforeLimit?: number;
}

/** 图像识别处理消息的结果 */
export interface ImageRecognitionResult {
  /** 原始 content（便于下游比对） */
  content: string;
  /** 各图片对应的描述 */
  imageDescriptions?: string[];
  /** 处理信息（用于日志/归档） */
  info: {
    imageCount: number;
    successCount: number;
    descriptions: string[];
    /** 替换掉图片占位后的文本（如 "[图片: xxx描述]" 形式） */
    transformedContent: string;
  };
}

/**
 * 图像识别服务
 *
 * 内置能力（`ImageRecognitionCapabilityRegistry`）：
 * - `describe`: 单张图片描述
 * - `process-message`: 整条消息批处理（图文混排）
 * - `build-context`: 为图片识别构造上下文
 * - `animated`: 支持 GIF/视频帧提取与综合描述
 *
 * 第三方可扩展能力：
 * ```ts
 * declare module '@aalis/core' {
 *   interface ImageRecognitionCapabilityRegistry {
 *     Ocr: 'ocr';
 *     ObjectDetection: 'object_detection';
 *   }
 * }
 * ```
 */
export interface ImageRecognitionService {
  /** 当前是否可用（如 LLM 尚未就绪时为 false） */
  readonly available: boolean;
  /**
   * 当前是否处于「本插件主动识别」模式
   *
   * - true：识别后把图片替换为文字描述交给主 Agent
   * - false：直接把图片原样透传给主 Agent（要求主模型具备 vision 能力）
   */
  readonly enabled: boolean;

  /**
   * 描述单张图片，返回文字描述。失败/不可用时返回空串。
   * @param imageUrl 图片 URL 或 data URI
   * @param localRefPath 可选的本地缓存文件路径（用于动图帧提取等）
   */
  describe(imageUrl: string, localRefPath?: string): Promise<string>;

  /**
   * 对整条含图消息做批处理：识别所有图片并返回处理结果。
   * 不可用或 images 为空时返回 null。
   */
  processMessage(input: ImageRecognitionInput): Promise<ImageRecognitionResult | null>;

  /**
   * 为含图消息构造视觉识别上下文。
   * 实现应把上下文作为识别线索，而不是覆盖图片事实的强约束。
   */
  buildContext?(message: IncomingMessage, options?: ImageRecognitionContextOptions): Promise<string>;

  /**
   * 查询已缓存的图片描述（不会触发识别）。未命中返回 null。
   * 用于引用回复等场景：同一张图片在主消息流程中被识别过后，可以免费复用。
   */
  lookupDescription?(imageUrl: string): string | null;
}

// ----- 图像识别能力声明（capability 框架）-----

/**
 * 图像识别服务能力注册表
 *
 * 第三方可通过 declaration merging 追加：
 * ```ts
 * declare module '@aalis/core' {
 *   interface ImageRecognitionCapabilityRegistry {
 *     Ocr: 'ocr';
 *   }
 * }
 * ```
 */
export interface ImageRecognitionCapabilityRegistry {
  /** 单图描述 */
  Describe: 'describe';
  /** 批处理整条消息（含图文混排） */
  ProcessMessage: 'process-message';
  /** 构造图片识别上下文 */
  BuildContext: 'build-context';
  /** 支持动图/视频帧提取 */
  Animated: 'animated';
  /** 描述缓存查询 */
  DescriptionCache: 'description-cache';
}

/** 图像识别能力字符串 union（自动包含第三方扩展） */
export type ImageRecognitionCapability = ImageRecognitionCapabilityRegistry[keyof ImageRecognitionCapabilityRegistry];

/** 图像识别内置能力常量 */
export const ImageRecognitionCapabilities = {
  Describe: 'describe',
  ProcessMessage: 'process-message',
  BuildContext: 'build-context',
  Animated: 'animated',
  DescriptionCache: 'description-cache',
} as const satisfies ImageRecognitionCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    'image-recognition': ImageRecognitionCapability;
  }
}

// 注册能力↔方法探测器

registerCapabilityProbe('image-recognition', ImageRecognitionCapabilities.Describe, inst =>
  typeof (inst as { describe?: unknown }).describe === 'function'
    ? true
    : 'ImageRecognitionService.describe() is required for capability "describe"');

registerCapabilityProbe('image-recognition', ImageRecognitionCapabilities.ProcessMessage, inst =>
  typeof (inst as { processMessage?: unknown }).processMessage === 'function'
    ? true
    : 'ImageRecognitionService.processMessage() is required for capability "process-message"');

registerCapabilityProbe('image-recognition', ImageRecognitionCapabilities.BuildContext, inst =>
  typeof (inst as { buildContext?: unknown }).buildContext === 'function'
    ? true
    : 'ImageRecognitionService.buildContext() is required for capability "build-context"');

registerCapabilityProbe('image-recognition', ImageRecognitionCapabilities.DescriptionCache, inst =>
  typeof (inst as { lookupDescription?: unknown }).lookupDescription === 'function'
    ? true
    : 'ImageRecognitionService.lookupDescription() is required for capability "description-cache"');

// Animated 为配置/运行时开关，无固定方法签名，不做探测。
