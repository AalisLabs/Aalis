// ============================================================
// service.ts — MediaService 实现
// ============================================================

import type { ASRService } from '@aalis/api-asr';
import { LLMCapabilities, type LLMModel, type ModelRef, resolveLLMModel } from '@aalis/api-llm';
import type {
  BuildContextOptions,
  DescribeImageOptions,
  DescribeOptions,
  DescribeVideoOptions,
  MediaCapability,
  MediaProcessor,
  MediaProcessReport,
  MediaService,
  TranscribeOptions,
} from '@aalis/api-media';
import type { MemoryService } from '@aalis/api-memory';
import type { SessionManagerService } from '@aalis/api-session-manager';
import { isStorageUri, parseUriRoot } from '@aalis/api-storage';
import type { Logger, ServiceRef } from '@aalis/core';
import type { IncomingMessage, MessageAttachment } from '@aalis/schema-message';
import { AttachmentRefKind, formatAttachmentRef } from '@aalis/schema-message';

/** 附件 kind → 中文显示名。复用 schema-message 的单一来源，避免 `[audio：…]` 这种中英混排。 */
const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  image: AttachmentRefKind.Image,
  audio: AttachmentRefKind.Audio,
  video: AttachmentRefKind.Video,
  file: AttachmentRefKind.File,
};

import {
  lookupCachedDescription,
  rememberDescription,
  rememberDescriptionAlias,
  VIDEO_FAILURE_TEXTS,
} from './cache.js';
import { buildIncomingImageContext, type ContextCaps } from './context.js';
import {
  downloadToTemp,
  extractAudioTrack,
  extractFrames,
  getFrameCount,
  isAnimatedFormat,
  materializeAttachment,
  selectFrameIndices,
} from './ffmpeg.js';
import {
  DEFAULT_VISION_AUTO_PROMPT,
  DEFAULT_VISION_BATCH_PROMPT,
  DEFAULT_VISION_DETAILED_PROMPT,
  DEFAULT_VISION_PROFESSIONAL_PROMPT,
  DEFAULT_VISION_PROMPT,
  imageToBase64DataUrl,
  scanLLMProcessors,
} from './llm-adapter.js';
import { normalizeAttachments } from './normalize.js';
import { getMediaRuntime } from './runtime.js';

/**
 * 调度器用到的能力。llm / asr 是 processor 池的两个来源；sessionManager 供 auto 交付形态
 * 解析本会话主模型；memory 供识别上下文取历史与发送者画像。四者都可缺席（各自路径降级）。
 */
export interface MediaServiceCaps {
  logger: Logger;
  llm: ServiceRef<LLMModel>;
  asr: ServiceRef<ASRService>;
  sessionManager: ServiceRef<SessionManagerService>;
  memory: ServiceRef<MemoryService>;
}

export interface MediaConfigResolved {
  vision: {
    /**
     * 接触到图片立即识别落描述：描述进档案与向量库（可召回），被吞掉的消息也有记忆。
     * 关 = 档案只留指针 `[图片 | ref:…]`，主模型需要时经 analyze_image 按需看。
     */
    recognizeOnArrival: boolean;
    /**
     * 主模型需要看图（当轮附件、analyze_image）时怎么给：直通原图（需主模型 vision 能力，
     * 动图抽帧）/ 由识别模型转文字；auto 按本会话生效主模型的 vision 能力自动选。
     */
    delivery: 'auto' | 'passthrough' | 'describe';
    prefer?: string | ModelRef;
    maxTokens: number;
    think: boolean;
    prompt?: string;
    /** 多图批量描述 prompt，留空则回落 prompt / 内置默认 */
    batchPrompt?: string;
  };
  /**
   * 音频识别（单一 cap，完成转写 + 描述双重职责）。
   * - LLM-as-audio backend：全能 prompt 驱动，语音输原文、音乐/环境输描述。
   * - Whisper 类 ASR：仅转写语音，非语音输出为空（service 会补充占位描述）。
   */
  audio: {
    mode: 'enabled' | 'passthrough' | 'disabled';
    /** 优先音频处理器（processor.name，统一池含 whisper/asr 与 audio LLM）。留空=按优先级自动选。 */
    prefer?: string;
    language?: string;
    /** 默认最大 output tokens。e4b thinking enabled 时全能 prompt 需要 ≥1024 */
    maxTokens: number;
    /** 是否启用 thinking（识别质量 ↑，但 token 成本 ×5-8）。默认 true */
    think: boolean;
    /** 自定义 prompt。留空使用 LLM adapter 内置的全能描述 prompt */
    prompt?: string;
  };
  video: {
    mode: 'frames+asr' | 'frames-only' | 'disabled';
    maxFrames: number;
    /** 抽帧后给 vision 模型的 hint，留空为内置默认 */
    framesHint?: string;
    /** describeImage 动图分支的 fallback hint，留空为内置默认 */
    animatedPrompt?: string;
    /** 综合描述中画面部分的前缀 */
    framePrefix: string;
    /** 综合描述中音轨部分的前缀 */
    audioTrackPrefix: string;
  };
  /** 动图/GIF 的关键帧抽取上限（与视频拆分，便于给动图更小的预算） */
  animatedImage: { maxFrames: number };
  /** 是否在调用多模态 processor 时注入聊天上下文 */
  contextHistory: { enabled: boolean; maxMessages: number };
  /** vision 上下文中是否注入发送者画像（user-profile 摘要等先验信息） */
  senderContext: { enabled: boolean; profileMaxChars: number };
}

export class MediaServiceImpl implements MediaService {
  /** 由 backend 插件或测试代码显式注册的非 LLM processor。 */
  private external: MediaProcessor[] = [];
  /** 上一次扫描得到的 LLM-as-processor 列表（懒计算）。 */
  private llmCache: { processors: MediaProcessor[]; signature: string } | null = null;

  private readonly logger: Logger;

  constructor(
    private readonly caps: MediaServiceCaps,
    private readonly cfg: MediaConfigResolved,
  ) {
    this.logger = caps.logger;
  }

  /** 识别上下文的能力切片（memory 可能缺席，失败一律降级为无上下文） */
  private get contextCaps(): ContextCaps {
    return { memory: this.caps.memory, logger: this.logger };
  }

  registerProcessor(p: MediaProcessor): () => void {
    this.external.push(p);
    this.logger.info(`已注册 MediaProcessor: ${p.name} caps=[${p.capabilities.join(',')}]`);
    return () => {
      this.external = this.external.filter(x => x !== p);
    };
  }

  listProcessors(cap?: MediaCapability): MediaProcessor[] {
    const all = [...this.external, ...this.refreshLLMProcessors(), ...this.asrProcessors()];
    return cap ? all.filter(p => p.capabilities.includes(cap)) : all;
  }

  /**
   * 把核心 `asr` 服务的每个 provider（whisper-cpp / 云 ASR…）包成 cap='audio' 的 MediaProcessor，
   * 与「audio 能力的 LLM」同池，供 pickProcessor('audio', prefer) 统一仲裁。transcribe 直接转调 asr 服务。
   */
  private asrProcessors(): MediaProcessor[] {
    return this.caps.asr.all().map(e => {
      const asr = e.instance;
      const name = `asr:${e.contextId}`;
      return {
        name,
        capabilities: ['audio'],
        displayName: `Whisper/ASR · ${e.label ?? e.contextId}`,
        priority: e.priority,
        // asr-api 的 meta.processor 可选、media-api 必填 → 显式映射并盖上桥接器名。
        transcribe: async input => {
          const r = await asr.transcribe(input);
          return {
            text: r.text,
            segments: r.segments,
            language: r.language,
            meta: { processor: name, model: r.meta?.model },
          };
        },
      };
    });
  }

  pickProcessor(cap: MediaCapability, prefer?: string | ModelRef | null): MediaProcessor | null {
    const candidates = this.listProcessors(cap);
    if (candidates.length === 0) return null;
    if (prefer) {
      // 字符串（历史格式 / 代码传入的 processor name）
      if (typeof prefer === 'string' && prefer.length > 0) {
        const exact = candidates.find(p => p.name === prefer);
        if (exact) return exact;
      } else if (typeof prefer === 'object' && (prefer.provider || prefer.model)) {
        // ModelRef → 匹配 llm-adapter 生成的 processor name
        // processor.name 格式：`llm:${provider}/${model}#${capShort}`
        const exact = candidates.find(p => {
          if (!p.name.startsWith('llm:')) return false;
          const ctxPart = p.name.slice('llm:'.length).split('#')[0];
          if (prefer.provider && prefer.model) return ctxPart === `${prefer.provider}/${prefer.model}`;
          if (prefer.provider) return ctxPart.startsWith(`${prefer.provider}/`);
          return ctxPart.endsWith(`/${prefer.model}`);
        });
        if (exact) return exact;
      }
    }
    // 按 priority 降序，再按外部 backend 优先
    return [...candidates].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  }

  async describe(attachments: MessageAttachment[], opts: DescribeOptions = {}): Promise<Array<string | undefined>> {
    if (attachments.length === 0) return [];
    const out: Array<string | undefined> = new Array(attachments.length).fill(undefined);
    // 按 kind 分组批处理
    const byKind: Record<string, number[]> = { image: [], audio: [], video: [], file: [] };
    attachments.forEach((a, i) => {
      byKind[a.kind].push(i);
    });

    // image
    if (byKind.image.length > 0) {
      const proc = this.pickProcessor('vision', opts.prefer);
      if (proc?.describe) {
        try {
          const subset = byKind.image.map(i => attachments[i]);
          const r = await proc.describe({
            attachments: subset,
            mode: 'single',
            hint: opts.hint,
            maxTokens: opts.maxTokens,
          });
          for (let j = 0; j < byKind.image.length; j++) {
            out[byKind.image[j]] = r.descriptions[j] ?? r.descriptions[0];
          }
        } catch (err) {
          this.logger.warn(`图像描述失败: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // audio：统一池（whisper/ASR 与 audio LLM）按 audio.prefer > 优先级选一个 processor，走其 transcribe
    if (byKind.audio.length > 0 && this.cfg.audio.mode === 'enabled') {
      const proc = this.pickProcessor('audio', this.cfg.audio.prefer);
      if (proc?.transcribe) {
        for (const i of byKind.audio) {
          try {
            const r = await proc.transcribe({
              attachment: attachments[i],
              language: this.cfg.audio.language,
              context: opts.hint,
            });
            out[i] = r.text || undefined;
          } catch (err) {
            this.logger.warn(`音频识别失败: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    return out;
  }

  async transcribe(
    attachment: MessageAttachment,
    opts: TranscribeOptions & { context?: string } = {},
  ): Promise<string | undefined> {
    if (this.cfg.audio.mode === 'disabled') return undefined;
    // 音频后端=统一池（whisper/ASR 与 audio LLM），由 audio.prefer > 优先级选一个 processor
    const proc = this.pickProcessor('audio', this.cfg.audio.prefer);
    if (!proc?.transcribe) {
      this.logger.debug('无音频处理器可用（asr / audio LLM 均未注册）');
      return undefined;
    }
    try {
      const r = await proc.transcribe({
        attachment,
        language: opts.language ?? this.cfg.audio.language,
        withTimestamps: opts.withTimestamps,
        context: opts.context,
      });
      return r.text;
    } catch (err) {
      this.logger.warn(`音频识别失败: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  /**
   * 对入站附件图片进行落盘，返回可写入 AttachmentRef 的相对路径。
   *
   * - `data:` URI（WebUI base64）→ 解码后写入 `data:/images/{session}/{hash}.{ext}`，
   *   返回 `data/images/{session}/{hash}.{ext}`（历史相对路径格式），并登记
   *   「来源 → 落盘 ref」描述缓存别名（见 cache.rememberDescriptionAlias）。
   * - `http(s)://` URL → 直接返回原 URL（analyze_image 可直接处理）。
   * - 已是 storage URI（如 `data:/images/...`，OneBot 已落盘）→ 转换为相对路径。
   * - 其它无法处理的格式 → 返回 null（描述仍写入，不含 ref）。
   */
  private async cacheImageRef(att: MessageAttachment, sessionId: string): Promise<string | null> {
    const data = att.data;
    if (typeof data !== 'string' || !data) return null;
    if (data.startsWith('http://') || data.startsWith('https://')) return data;
    // 已是 storage URI（含 data:/，根名 data，OneBot 已落盘）→ 转为相对路径 root/rest
    if (isStorageUri(data)) {
      const root = parseUriRoot(data);
      return `${root}/${data.slice(root.length + 2)}`;
    }
    // base64 data URI（WebUI 上传的原始图片）
    if (!data.startsWith('data:')) return null;
    try {
      const m = data.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) return null;
      const mimeType = m[1];
      const rawExt = mimeType.split('/')[1] ?? 'bin';
      const ext = rawExt === 'jpeg' ? 'jpg' : rawExt === 'svg+xml' ? 'svg' : rawExt;
      const buf = Buffer.from(m[2], 'base64');
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hash = Buffer.from(digest).toString('hex').slice(0, 16);
      const safeSession = sessionId.replace(/[:/\\]/g, '_');
      const dirRel = `images/${safeSession}`;
      const filename = `${hash}.${ext}`;
      const { storage } = getMediaRuntime();
      await storage.writeFile(`data:/${dirRel}/${filename}`, buf);
      const ref = `data/${dirRel}/${filename}`;
      // 落盘时登记一次别名：原始来源串（这条整段 base64 data URI）此后经别名落到
      // ref 的内容哈希键上——同一张图从别的来源再进来只识别一次，描述也进得了快照。
      rememberDescriptionAlias(data, ref);
      return ref;
    } catch (err) {
      this.logger.debug(`图片落盘失败，将不含 ref: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async processMessage(msg: IncomingMessage): Promise<MediaProcessReport> {
    const attachments = normalizeAttachments(msg);
    const report: MediaProcessReport = { total: attachments.length, successCount: 0, items: [] };
    if (attachments.length === 0) return report;

    // 多模态上下文：在进入任何 processor 调用前构造一次，后续复用。
    const ctxText =
      this.cfg.contextHistory.enabled && attachments.length > 0
        ? await safeBuildContext(this.contextCaps, msg, this.cfg.contextHistory.maxMessages, this.cfg.senderContext)
        : undefined;

    // 描述是否可跨会话复用：带了本会话对话上下文的描述属于「此群此刻的解读」，
    // 只在本会话内复用（键退回含会话目录的落盘路径），否则会把 A 群语境搬进 B 群。
    const shareable = !ctxText;

    const descriptions: Array<string | undefined> = new Array(attachments.length).fill(undefined);

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const item: MediaProcessReport['items'][number] = { kind: att.kind };
      try {
        if (att.kind === 'image') {
          // 动图线索先登记：直通出口的抽帧（agent:llm:before 中间件，见 index.ts）拿到的
          // images[] 只剩 data 串，而 QQ 图 URL 常无扩展名，mimeType 只有归档期（现在）看得到。
          if (!isAnimatedFormat(att.data) && att.mimeType === 'image/gif') this.rememberAnimated(att.data);
          if (!this.cfg.vision.recognizeOnArrival) {
            // 只留指针：不调 processor。OneBot 适配器已把 ref 写进正文；WebUI 等平台的
            // base64 上传没有落盘 ref，这里落一份并写指针，否则档案里图片零痕迹、按需看无从下手。
            const ref = await this.cacheImageRef(att, msg.sessionId);
            item.description = ref ? formatAttachmentRef({ kind: AttachmentRefKind.Image, ref }) : undefined;
            descriptions[i] = item.description;
          } else {
            // 动图（gif/webm/...）走视频帧流程获得综合描述
            const animated = isAnimatedFormat(att.data) || att.mimeType === 'image/gif';
            // 缓存查询（hint/上下文为空时）。缓存里是裸描述，按本路径的形态重新包装：
            // 静态图带 ref 标记（与新鲜识别同构），动图沿用裸文本（与动图新鲜路径同构）。
            const cached = lookupCachedDescription(att.data, shareable);
            if (cached) {
              item.cap = 'vision';
              if (animated) {
                item.description = cached;
              } else {
                const ref = await this.cacheImageRef(att, msg.sessionId);
                item.description = ref
                  ? formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: cached, ref })
                  : `[图片描述] ${cached}`;
              }
              descriptions[i] = item.description;
            } else if (animated) {
              const text = await this.processVideo(att, ctxText, 'animated');
              if (text) {
                item.description = text;
                item.cap = 'vision';
                descriptions[i] = text;
                rememberDescription(att.data, text, shareable);
              }
            } else {
              const proc = this.pickProcessor('vision', this.cfg.vision.prefer);
              item.cap = 'vision';
              item.processor = proc?.name;
              if (proc?.describe) {
                // 自动归档路径：单次自路由推理（模型看图自判类型、按类型给相应详略），
                // 不再前置一次分类推理。显式覆盖的 cfg.vision.prompt 视为用户强意图，直接尊重。
                // basePrompt（完整 prompt 覆盖）vs hint（额外追加约束）语义分离，
                // 避免两段 prompt 同时存在产生指令冲突。
                const basePrompt = this.cfg.vision.prompt || DEFAULT_VISION_AUTO_PROMPT;
                this.logger.info(
                  `[vision.describe] source=auto promptChars=${basePrompt.length} (session=${msg.sessionId})`,
                );
                const [r, ref] = await Promise.all([
                  proc.describe({
                    attachments: [att],
                    mode: 'single',
                    maxTokens: this.cfg.vision.maxTokens,
                    basePrompt,
                    context: ctxText,
                  }),
                  this.cacheImageRef(att, msg.sessionId),
                ]);
                const raw = r.descriptions[0];
                if (raw) {
                  item.description = ref
                    ? formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: raw, ref })
                    : `[图片描述] ${raw}`;
                  descriptions[i] = item.description;
                  // 缓存只存裸描述：无上下文时键空间与 describeImage（转发/工具路径）
                  // 共用同一内容哈希；带上下文时退回会话内私有键（见 rememberDescription）。
                  // 存格式化文本会让另一侧拿到嵌套包装，存裸描述则各消费点按自己的形态包装。
                  rememberDescription(att.data, raw, shareable);
                }
              }
            }
          }
        } else if (att.kind === 'audio') {
          // 统一音频识别：LLM-as-audio 返回转写或描述，Whisper 仅返回转写。
          // 空串补上占位让主 LLM 知情有附件但未能识别，避免幻觉。
          if (this.cfg.audio.mode === 'passthrough') {
            // passthrough：不转写，attachment 原样保留，由主模型直接理解（需主模型有 audio 能力）
            item.description = undefined;
          } else if (this.cfg.audio.mode === 'enabled') {
            const text = await this.transcribe(att, { context: ctxText });
            item.cap = 'audio';
            // 空响应不应该被歸因为“非语音”——模型可能是 maxTokens 不足 / 上下文超限 / 超时，
            // 详细原因看 llm-adapter 里的 warn 日志（含 raw 长度、tokens 资源占用比）。
            item.description = text ? `[音频] ${text}` : '[音频] 识别失败（模型未返回内容，详见日志）';
            descriptions[i] = item.description;
          }
        } else if (att.kind === 'video') {
          if (this.cfg.video.mode !== 'disabled') {
            item.description = await this.processVideo(att, ctxText);
            descriptions[i] = item.description;
            item.cap = 'vision';
          }
        } else if (att.kind === 'file') {
          // 文件交给 file-reader / 其他插件，本插件不处理（除非声明 document.image，将来扩展）
          item.description = undefined;
        }
        if (item.description) report.successCount++;
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`附件处理失败 [${att.kind}]: ${item.error}`);
        // 把失败如实写进描述位：留空的话渲染出来只是个裸占位，LLM 无从区分
        // 「这里有张图但没识别出来」和「这条消息本来就没图」。写一句实话，
        // 它才能据此追问或跳过，而不是被一段幻觉描述当成事实喂进上下文。
        descriptions[i] = `[${ATTACHMENT_KIND_LABEL[att.kind]}：获取或识别失败，内容未知]`;
      }
      report.items.push(item);
    }

    // 写回 IncomingMessage
    msg.attachments = attachments;
    msg._attachmentDescriptions = descriptions;
    return report;
  }

  /**
   * 直通模式的动图线索：data 串 → 已知为动图。归档期看得到 mimeType，出口期只剩 data 串。
   * 只登记出口自身判不出的那类（data 无动图特征、仅 mimeType 表明）——WebUI 的完整 base64
   * data URI 自带 `data:image/gif` 前缀无需登记，登记它们会让 200 条上限的集合囤积 GB 级串。
   */
  private readonly animatedHints = new Set<string>();

  private rememberAnimated(data: string): void {
    this.animatedHints.add(data);
    if (this.animatedHints.size > 200) {
      const oldest = this.animatedHints.values().next().value;
      if (oldest !== undefined) this.animatedHints.delete(oldest);
    }
  }

  /** 抽帧内核：本地动图/视频文件 → 均匀采样的关键帧 data URI（describe/describeImage/直通三处共用）。抽不出返回 []。 */
  private async framesFromLocal(path: string, maxFrames: number): Promise<string[]> {
    const totalFrames = await getFrameCount(path);
    if (totalFrames <= 0) {
      this.logger.debug(`[frames] ffprobe 未数出帧（探测失败或非视频容器）: ${path}`);
      return [];
    }
    const frames = await extractFrames(path, selectFrameIndices(totalFrames, maxFrames));
    this.logger.debug(`[frames] total=${totalFrames} → 采样 ${frames.length}/${maxFrames}`);
    return frames;
  }

  /**
   * 主模型需要看图时的交付形态。auto：按本会话生效主模型的 vision 能力——有则直通原图，
   * 无则由识别模型转文字。解析链与 agent 同源（session-manager：会话 > 父默认 > 平台档），
   * 拿不到 session-manager 或会话未指定模型时退回 LLM 默认 entry。
   */
  resolveDelivery(sessionId?: string, platform?: string): 'passthrough' | 'describe' {
    if (this.cfg.vision.delivery !== 'auto') return this.cfg.vision.delivery;
    const sm = this.caps.sessionManager.current;
    const ref = sm && sessionId ? sm.resolveConfig(sessionId, platform).llm : undefined;
    const entry = resolveLLMModel(this.caps.llm, ref?.provider && ref?.model ? ref : undefined, ['chat']);
    return entry?.instance.capabilities.includes(LLMCapabilities.Vision) ? 'passthrough' : 'describe';
  }

  /**
   * 出口形态变换（agent:llm:before 中间件内核 / analyze_image 直通分支）。按交付形态决定
   * 主模型收到什么：
   *
   * - describe：识别由识别模型负责，结果已作为文字拼进消息正文（或由 analyze_image 返回），
   *   主模型不看图。实测一张 57KB 的图挂上去要多花 1,090 token、4.7 秒预填充——同一张图识别两遍。
   * - passthrough：主模型亲自看图 → 动图抽帧为多张静图，静图规范化后交出。
   *
   * 直通必须过**形态规范化**：适配器给 attachment.data 的是历史相对路径 ref
   * （`data/images/…`），而 provider 只认 data URI / http / file:// / 绝对路径，裸路径
   * 会被当成 base64 送出去，触发 `illegal base64 data at input byte N`（实测 400、整轮
   * 回复失败）。已经是 data URI / http 的逐字节原样返回；交不出合法形态的那一张丢弃并
   * warn——留着它等于让整轮请求被 provider 拒收。
   */
  async transformModelImages(images: string[], delivery: 'passthrough' | 'describe'): Promise<string[]> {
    if (delivery === 'describe') return [];
    const out: string[] = [];
    /** 交给 provider 前的最后一道：非 data URI / http 的一律物化成 data URL，失败就丢这一张。 */
    const normalized = async (src: string): Promise<void> => {
      try {
        out.push(await imageToBase64DataUrl(src));
      } catch (err) {
        this.logger.warn(`[passthrough] 图片无法规范化，本轮丢弃该图: ${(err as Error).message}`);
      }
    };

    for (const data of images) {
      const animated = isAnimatedFormat(data) || this.animatedHints.has(data);
      if (!animated) {
        await normalized(data);
        continue;
      }
      try {
        const local = await materializeAttachment(data);
        if (!local) {
          // 退回整图规范化——**不能**因为这里物化失败就短路丢图：data URI / http 在
          // imageToBase64DataUrl 里是直接短路返回的，压根不走物化，短路会把这些合法
          // 形态一起丢掉（回归用例 media-passthrough-frames「物化失败 / 抽不出帧」守着）。
          // 只有裸 ref 才会在那边二次失败并被丢弃。
          // 每消息只处理一次（WeakSet 不重试），这里不留痕的话用户只会看到"主模型没看懂动图"。
          this.logger.debug('[passthrough] 动图无法物化为本地文件，退回整图规范化');
          await normalized(data);
          continue;
        }
        try {
          const frames = await this.framesFromLocal(local.path, this.cfg.animatedImage.maxFrames);
          if (frames.length > 0) {
            this.logger.info(`[passthrough] 动图抽帧 ${frames.length} 帧直通主模型`);
            out.push(...frames); // 抽帧产物已是 data URI
          } else {
            await normalized(data);
          }
        } finally {
          await local.cleanup();
        }
      } catch (err) {
        this.logger.warn(`[passthrough] 动图抽帧失败，退回整图规范化: ${(err as Error).message}`);
        await normalized(data);
      }
    }
    return out;
  }

  /**
   * 视频：抽帧 + 抽音轨转写 → 拼综合描述。
   * sourceKind: 'video'（默认）用 cfg.video.maxFrames；'animated' 用 cfg.animatedImage.maxFrames
   * （两者独立配置，动图信息量低通常给更小预算）。
   */
  private async processVideo(
    att: MessageAttachment,
    contextText?: string,
    sourceKind: 'video' | 'animated' = 'video',
  ): Promise<string | undefined> {
    const local = await materializeAttachment(att.data);
    if (!local) {
      this.logger.debug('视频无法物化为本地文件，跳过');
      // 显式占位，避免 LLM 看不到"视频曾到达但无法读取内容"这一事实
      const hasRef = typeof att.data === 'string' && att.data.length > 0;
      return hasRef ? VIDEO_FAILURE_TEXTS.unreadable : VIDEO_FAILURE_TEXTS.noUrl;
    }
    const t0 = Date.now();
    this.logger.info(`[video] 开始处理 sourceKind=${sourceKind} mode=${this.cfg.video.mode} path=${local.path}`);
    try {
      const frameTexts: string[] = [];
      const maxFrames = sourceKind === 'animated' ? this.cfg.animatedImage.maxFrames : this.cfg.video.maxFrames;
      const frames = await this.framesFromLocal(local.path, maxFrames);
      this.logger.info(`[video] 抽帧采样 ${frames.length}/${maxFrames} 帧（实际抽出/期望上限）`);
      if (frames.length > 0) {
        const proc = this.pickProcessor('vision', this.cfg.vision.prefer);
        if (proc?.describe) {
          const frameAtts: MessageAttachment[] = frames.map(d => ({ kind: 'image', data: d, mimeType: 'image/png' }));
          const r = await proc.describe({
            attachments: frameAtts,
            mode: 'combined',
            maxTokens: this.cfg.vision.maxTokens,
            hint: this.cfg.video.framesHint ?? '以下为同一视频的关键帧，按时间顺序排列。',
            context: contextText,
          });
          const text = r.descriptions[0];
          if (text) {
            frameTexts.push(`${this.cfg.video.framePrefix}${text}`);
          } else {
            this.logger.warn(
              `[video] vision 综合描述返回空：${frames.length} 帧未产出文本（详见上方 vision.describe 日志）`,
            );
          }
        } else {
          this.logger.warn('[video] 无可用 vision processor，跳过帧描述');
        }
      } else {
        this.logger.warn(`[video] 未抽出关键帧（ffprobe 失败/非视频容器/解码失败）；path=${local.path}`);
      }

      if (this.cfg.video.mode === 'frames+asr' && this.cfg.audio.mode === 'enabled') {
        const audioDataUrl = await extractAudioTrack(local.path);
        if (audioDataUrl) {
          const text = await this.transcribe(
            { kind: 'audio', data: audioDataUrl, mimeType: 'audio/mpeg' },
            { context: contextText },
          );
          if (text) {
            frameTexts.push(`${this.cfg.video.audioTrackPrefix}${text}`);
          } else {
            this.logger.info('[video] 音轨抽取成功但转写为空（无人声或转写失败，详见 audio.transcribe 日志）');
          }
        } else {
          this.logger.info('[video] extractAudioTrack 返回空，无可用音轨');
        }
      }

      this.logger.info(`[video] 完成 ${Date.now() - t0}ms：产出 ${frameTexts.length} 段（帧综合 + 音轨转写）`);
      if (frameTexts.length === 0) return VIDEO_FAILURE_TEXTS.noFrames;
      return frameTexts.join('\n');
    } finally {
      await local.cleanup();
    }
  }

  /** 重新扫描 LLM entries（按 entry id 列表的签名变化决定是否重建）。 */
  private refreshLLMProcessors(): MediaProcessor[] {
    const all = this.caps.llm.all();
    const sig = all
      .map(e => `${e.contextId}:${e.instance.capabilities.join(',')}`)
      .sort()
      .join('|');
    if (this.llmCache?.signature === sig) return this.llmCache.processors;
    const processors = scanLLMProcessors(this.caps, {
      prompt: this.cfg.vision.prompt,
      maxTokens: this.cfg.vision.maxTokens,
      vision: {
        prompt: this.cfg.vision.prompt,
        batchPrompt: this.cfg.vision.batchPrompt,
        maxTokens: this.cfg.vision.maxTokens,
        think: this.cfg.vision.think,
      },
      audio: {
        prompt: this.cfg.audio.prompt,
        maxTokens: this.cfg.audio.maxTokens,
        think: this.cfg.audio.think,
      },
    });
    this.llmCache = { processors, signature: sig };
    return processors;
  }

  // ===== 描述缓存 / 上下文构造 =====

  lookupDescription(imageUrl: string): string | null {
    return lookupCachedDescription(imageUrl);
  }

  rememberDescription(imageUrl: string, description: string): void {
    rememberDescription(imageUrl, description);
  }

  rememberDescriptionAlias(source: string, landedRef: string): void {
    rememberDescriptionAlias(source, landedRef);
  }

  async buildContext(msg: IncomingMessage, opts?: BuildContextOptions): Promise<string> {
    return buildIncomingImageContext(this.contextCaps, msg, opts?.beforeLimit, this.cfg.senderContext);
  }

  /**
   * 单图描述（带缓存 + 自动判定动图）。供 analyze_image 工具与外部直接调用。
   */
  async describeImage(imageUrl: string, opts: DescribeImageOptions = {}): Promise<string> {
    // 描述缓存按详略档分键：auto（默认）与到达识别共用一条，casual/detailed/professional 各自一条——
    // 否则「详细分析」会直接命中到达时写下的简述。带 hint 仍不进缓存（不同意图结果不同）。
    const detailLevel = opts.detailLevel ?? 'auto';
    const cacheVariant = detailLevel === 'auto' ? undefined : detailLevel;
    const useCache = opts.noCache !== true && !opts.hint;
    if (useCache) {
      const cached = lookupCachedDescription(imageUrl, true, cacheVariant);
      if (cached) return cached;
    }

    const proc = this.pickProcessor('vision', this.cfg.vision.prefer);
    if (!proc?.describe) {
      this.logger.debug('describeImage: 无 vision processor');
      return '';
    }

    const animated = isAnimatedFormat(opts.localPath ?? imageUrl);
    let result = '';

    if (animated) {
      // 动图/视频：抽帧后 combined 描述
      let local = opts.localPath ? { path: opts.localPath, cleanup: async () => {} } : null;
      let downloaded: { path: string; cleanup: () => Promise<void> } | null = null;
      if (!local) {
        if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
          downloaded = await downloadToTemp(imageUrl);
          if (downloaded) local = downloaded;
        } else {
          const mat = await materializeAttachment(imageUrl);
          if (mat) local = mat;
        }
      }
      if (local) {
        try {
          const frames = await this.framesFromLocal(local.path, this.cfg.animatedImage.maxFrames);
          if (frames.length > 0) {
            const frameAtts: MessageAttachment[] = frames.map(d => ({
              kind: 'image' as const,
              data: d,
              mimeType: 'image/png',
            }));
            const r = await proc.describe({
              attachments: frameAtts,
              mode: 'combined',
              maxTokens: opts.maxTokens ?? this.cfg.vision.maxTokens,
              basePrompt: this.cfg.video.animatedPrompt || DEFAULT_VISION_BATCH_PROMPT,
              hint: opts.hint,
            });
            result = r.descriptions[0] ?? '';
          }
        } finally {
          // 清理本地化产物：local 即 downloaded 或 materializeAttachment 的结果（opts.localPath 那个是 noop）。
          if (local) await local.cleanup();
        }
      }
    } else {
      // detailLevel 决策：casual/detailed/professional 直接选定模板；
      // auto 用自路由 prompt 单次推理（模型看图自判类型、按类型给相应详略）。
      let basePrompt: string;
      if (detailLevel === 'casual') {
        basePrompt = this.cfg.vision.prompt || DEFAULT_VISION_PROMPT;
      } else if (detailLevel === 'detailed') {
        basePrompt = DEFAULT_VISION_DETAILED_PROMPT;
      } else if (detailLevel === 'professional') {
        basePrompt = DEFAULT_VISION_PROFESSIONAL_PROMPT;
      } else {
        basePrompt = this.cfg.vision.prompt || DEFAULT_VISION_AUTO_PROMPT;
      }
      this.logger.info(`[vision.describe] source=tool detailLevel=${detailLevel} promptChars=${basePrompt.length}`);
      const r = await proc.describe({
        attachments: [{ kind: 'image', data: imageUrl }],
        mode: 'single',
        maxTokens: opts.maxTokens ?? this.cfg.vision.maxTokens,
        basePrompt,
        hint: opts.hint,
      });
      result = r.descriptions[0] ?? '';
    }

    if (useCache && result) rememberDescription(imageUrl, result, true, cacheVariant);
    return result;
  }

  /**
   * 按 URL（或本地路径）描述单个视频。复用 processVideo 私有路径，
   * 走帧抽样 + 可选音轨转写，结果命中视图描述缓存。
   */
  async describeVideo(videoUrl: string, opts: DescribeVideoOptions = {}): Promise<string> {
    if (!videoUrl) return '';
    const cached = lookupCachedDescription(videoUrl);
    if (cached) return cached;
    const att: MessageAttachment = { kind: 'video', data: opts.localPath ?? videoUrl };
    try {
      const text = await this.processVideo(att, opts.hint);
      if (text) rememberDescription(videoUrl, text);
      return text ?? '';
    } catch (err) {
      this.logger.warn(`describeVideo 失败 url=${videoUrl}: ${err instanceof Error ? err.message : err}`);
      return '';
    }
  }
}

/** 安全构造对话上下文：失败/异常返回 undefined，不让 processor 调用受阻。 */
async function safeBuildContext(
  caps: ContextCaps,
  msg: IncomingMessage,
  beforeLimit: number,
  senderCfg: { enabled: boolean; profileMaxChars: number } | undefined,
): Promise<string | undefined> {
  try {
    const text = await buildIncomingImageContext(caps, msg, beforeLimit, senderCfg);
    return text && text.trim().length > 0 ? text : undefined;
  } catch (err) {
    caps.logger.debug(`buildContext 失败，跳过: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
