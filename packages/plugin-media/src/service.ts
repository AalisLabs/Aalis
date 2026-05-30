// ============================================================
// service.ts — MediaService 实现
// ============================================================

import type { Context, Logger } from '@aalis/core';
import type { ModelRef } from '@aalis/plugin-llm-api';
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
} from '@aalis/plugin-media-api';
import type { IncomingMessage, MessageAttachment } from '@aalis/plugin-message-api';
import { AttachmentRefKind, formatAttachmentRef } from '@aalis/plugin-message-api';
import { lookupCachedDescription, rememberDescription } from './cache.js';
import { buildIncomingImageContext } from './context.js';
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
  DEFAULT_VISION_DETAILED_PROMPT,
  DEFAULT_VISION_PROFESSIONAL_PROMPT,
  DEFAULT_VISION_PROMPT,
  scanLLMProcessors,
  VISION_CLASSIFY_PROMPT,
} from './llm-adapter.js';
import { normalizeAttachments } from './normalize.js';
import { getMediaRuntime } from './runtime.js';

export interface MediaConfigResolved {
  vision: {
    mode: 'describe' | 'passthrough' | 'disabled';
    prefer?: string;
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
    /** 仅对 video.passthrough 生效（原生视频 LLM）。帧抽取描述走 vision.maxTokens */
    maxTokens: number;
    /** 仅对 video.passthrough 生效 */
    think: boolean;
    /** 仅对 video.passthrough 生效 */
    prompt?: string;
    /** 抽帧后给 vision 模型的 hint，留空为内置默认 */
    framesHint?: string;
    /** describeImage 动图分支的 fallback hint，留空为内置默认 */
    animatedPrompt?: string;
    /** 综合描述中画面部分的前缀 */
    framePrefix: string;
    /** 综合描述中音轨部分的前缀 */
    audioTrackPrefix: string;
  };
  document: { extractImages: boolean };
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

  constructor(
    private readonly ctx: Context,
    private readonly logger: Logger,
    private readonly cfg: MediaConfigResolved,
  ) {}

  registerProcessor(p: MediaProcessor): () => void {
    this.external.push(p);
    this.logger.info(`已注册 MediaProcessor: ${p.name} caps=[${p.capabilities.join(',')}]`);
    return () => {
      this.external = this.external.filter(x => x !== p);
    };
  }

  listProcessors(cap?: MediaCapability): MediaProcessor[] {
    const llm = this.refreshLLMProcessors();
    const all = [...this.external, ...llm];
    return cap ? all.filter(p => p.capabilities.includes(cap)) : all;
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
          const r = await proc.describe(
            { attachments: subset, mode: 'single', hint: opts.hint, maxTokens: opts.maxTokens },
            this.ctx,
          );
          for (let j = 0; j < byKind.image.length; j++) {
            out[byKind.image[j]] = r.descriptions[j] ?? r.descriptions[0];
          }
        } catch (err) {
          this.logger.warn(`图像描述失败: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // audio：使用统一 audio cap。LLM-as-audio 会同时覆盖转写 + 描述；Whisper 类仅返回转写。
    if (byKind.audio.length > 0 && this.cfg.audio.mode === 'enabled') {
      const proc = this.pickProcessor('audio', opts.prefer ?? this.cfg.audio.prefer);
      if (proc?.transcribe) {
        for (const i of byKind.audio) {
          try {
            const r = await proc.transcribe(
              {
                attachment: attachments[i],
                language: this.cfg.audio.language,
                context: opts.hint,
              },
              this.ctx,
            );
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
    const proc = this.pickProcessor('audio', opts.prefer ?? this.cfg.audio.prefer);
    if (!proc?.transcribe) {
      this.logger.debug('无 audio processor 可用');
      return undefined;
    }
    try {
      const r = await proc.transcribe(
        {
          attachment,
          language: opts.language ?? this.cfg.audio.language,
          withTimestamps: opts.withTimestamps,
          context: opts.context,
        },
        this.ctx,
      );
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
   *   返回 `data/images/{session}/{hash}.{ext}`（历史相对路径格式）。
   * - `http(s)://` URL → 直接返回原 URL（analyze_image 可直接处理）。
   * - 已是 storage URI（如 `data:/images/...`，OneBot 已落盘）→ 转换为相对路径。
   * - 其它无法处理的格式 → 返回 null（描述仍写入，不含 ref）。
   */
  private async cacheImageRef(att: MessageAttachment, sessionId: string): Promise<string | null> {
    const data = att.data;
    if (typeof data !== 'string' || !data) return null;
    if (data.startsWith('http://') || data.startsWith('https://')) return data;
    // 已是 storage URI（scheme 非 http/https/data/file）→ 转为相对路径
    const storagePrefixMatch = data.match(/^([a-z][a-z0-9_-]*):\/(.+)$/);
    if (storagePrefixMatch) {
      const scheme = storagePrefixMatch[1].toLowerCase();
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'data' && scheme !== 'file') {
        return `${scheme}/${storagePrefixMatch[2]}`;
      }
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
      return `data/${dirRel}/${filename}`;
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
        ? await safeBuildContext(
            this.ctx,
            msg,
            this.cfg.contextHistory.maxMessages,
            this.cfg.senderContext,
            this.logger,
          )
        : undefined;

    const descriptions: Array<string | undefined> = new Array(attachments.length).fill(undefined);

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const item: MediaProcessReport['items'][number] = { kind: att.kind };
      try {
        if (att.kind === 'image') {
          if (this.cfg.vision.mode === 'disabled') {
            item.description = undefined;
          } else if (this.cfg.vision.mode === 'passthrough') {
            // passthrough：不调用 processor，attachment 原样保留以便 agent 直接喂给主模型
            item.description = undefined;
          } else {
            // 动图（gif/webm/...）走视频帧流程获得综合描述
            const animated = isAnimatedFormat(att.data) || att.mimeType === 'image/gif';
            // 缓存查询（hint/上下文为空时）
            const cached = lookupCachedDescription(att.data);
            if (cached) {
              item.description = cached;
              item.cap = 'vision';
              descriptions[i] = cached;
            } else if (animated) {
              const text = await this.processVideo(att, ctxText, 'animated');
              if (text) {
                item.description = text;
                item.cap = 'vision';
                descriptions[i] = text;
                rememberDescription(att.data, text);
              }
            } else {
              const proc = this.pickProcessor('vision', this.cfg.vision.prefer);
              item.cap = 'vision';
              item.processor = proc?.name;
              if (proc?.describe) {
                // 自动归档路径也走双重识别：用户未显式覆盖 cfg.vision.prompt 时，
                // 先调一次轻量分类挑专业/详细/简洁 prompt，避免所有图都吃 casual prompt。
                // 显式覆盖的 vision.prompt 视为用户强意图，直接尊重不再分类。
                // basePrompt（完整 prompt 覆盖）vs hint（额外追加约束）语义分离，
                // 避免两段 prompt 同时存在产生指令冲突。
                let basePrompt: string;
                let tier: 'override' | 'casual' | 'detailed' | 'professional';
                if (this.cfg.vision.prompt) {
                  basePrompt = this.cfg.vision.prompt;
                  tier = 'override';
                } else {
                  const picked = await this.classifyAndPickPrompt(proc, att.data);
                  basePrompt = picked.prompt;
                  tier = picked.tier;
                }
                this.logger.info(
                  `[vision.describe] source=auto tier=${tier} promptChars=${basePrompt.length} (session=${msg.sessionId})`,
                );
                const [r, ref] = await Promise.all([
                  proc.describe(
                    {
                      attachments: [att],
                      mode: 'single',
                      maxTokens: this.cfg.vision.maxTokens,
                      basePrompt,
                      context: ctxText,
                    },
                    this.ctx,
                  ),
                  this.cacheImageRef(att, msg.sessionId),
                ]);
                const raw = r.descriptions[0];
                if (raw) {
                  item.description = ref
                    ? formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: raw, ref })
                    : `[图片描述] ${raw}`;
                  descriptions[i] = item.description;
                  rememberDescription(att.data, item.description);
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
      }
      report.items.push(item);
    }

    // 写回 IncomingMessage
    msg.attachments = attachments;
    msg._attachmentDescriptions = descriptions;
    return report;
  }

  /** 视频：抽帧 + 抽音轨转写 → 拼综合描述
   *
   * sourceKind: 'video'（默认）用 cfg.video.maxFrames；'animated' 用 cfg.animatedImage.maxFrames。
   * 动图比纯视频信息量低，默认给更小预算（5 vs 8），节省 vision 调用。
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
      return hasRef
        ? '[视频] 无法下载或读取视频文件内容（URL 不可访问或解码失败）'
        : '[视频] OneBot 服务端未提供视频文件 URL，无法获取内容';
    }
    const t0 = Date.now();
    this.logger.info(`[video] 开始处理 sourceKind=${sourceKind} mode=${this.cfg.video.mode} path=${local.path}`);
    try {
      const frameTexts: string[] = [];
      const totalFrames = await getFrameCount(local.path);
      if (totalFrames > 0) {
        const maxFrames = sourceKind === 'animated' ? this.cfg.animatedImage.maxFrames : this.cfg.video.maxFrames;
        const indices = selectFrameIndices(totalFrames, maxFrames);
        const frames = await extractFrames(local.path, indices);
        this.logger.info(`[video] 抽帧 total=${totalFrames} → 采样 ${frames.length}/${maxFrames} 帧（实际抽出/期望）`);
        if (frames.length > 0) {
          const proc = this.pickProcessor('vision', this.cfg.vision.prefer);
          if (proc?.describe) {
            const frameAtts: MessageAttachment[] = frames.map(d => ({ kind: 'image', data: d, mimeType: 'image/png' }));
            const r = await proc.describe(
              {
                attachments: frameAtts,
                mode: 'combined',
                maxTokens: this.cfg.vision.maxTokens,
                hint: this.cfg.video.framesHint ?? '以下为同一视频的关键帧，按时间顺序排列。',
                context: contextText,
              },
              this.ctx,
            );
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
        }
      } else {
        this.logger.warn(`[video] getFrameCount=0，可能 ffprobe 失败或非视频容器；path=${local.path}`);
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
      if (frameTexts.length === 0)
        return '[视频] 已收到视频文件但未能抽取关键帧或音轨（可能缺少 ffmpeg/ffprobe，或视频解码失败）';
      return frameTexts.join('\n');
    } finally {
      await local.cleanup();
    }
  }

  /** 重新扫描 LLM entries（按 entry id 列表的签名变化决定是否重建）。 */
  private refreshLLMProcessors(): MediaProcessor[] {
    const all = this.ctx.getAllServices('llm');
    const sig = all
      .map(e => `${e.contextId}:${e.capabilities.join(',')}`)
      .sort()
      .join('|');
    if (this.llmCache?.signature === sig) return this.llmCache.processors;
    const processors = scanLLMProcessors(this.ctx, {
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
      video: {
        prompt: this.cfg.video.prompt,
        maxTokens: this.cfg.video.maxTokens,
        think: this.cfg.video.think,
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

  async buildContext(msg: IncomingMessage, opts?: BuildContextOptions): Promise<string> {
    return buildIncomingImageContext(this.ctx, msg, opts?.beforeLimit, this.cfg.senderContext);
  }

  /**
   * 单图描述（带缓存 + 自动判定动图）。供 analyze_image 工具与外部直接调用。
   */
  async describeImage(imageUrl: string, opts: DescribeImageOptions = {}): Promise<string> {
    const noCache = opts.noCache === true;
    if (!noCache && !opts.hint) {
      const cached = lookupCachedDescription(imageUrl);
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
          const total = await getFrameCount(local.path);
          if (total > 0) {
            const indices = selectFrameIndices(total, this.cfg.animatedImage.maxFrames);
            const frames = await extractFrames(local.path, indices);
            if (frames.length > 0) {
              const frameAtts: MessageAttachment[] = frames.map(d => ({
                kind: 'image' as const,
                data: d,
                mimeType: 'image/png',
              }));
              const r = await proc.describe(
                {
                  attachments: frameAtts,
                  mode: 'combined',
                  maxTokens: opts.maxTokens ?? this.cfg.vision.maxTokens,
                  basePrompt: this.cfg.vision.prompt ?? this.cfg.video.animatedPrompt ?? '描述这个动图/视频。',
                  hint: opts.hint,
                },
                this.ctx,
              );
              result = r.descriptions[0] ?? '';
            }
          }
        } finally {
          if (downloaded) await downloaded.cleanup();
        }
      }
    } else {
      // detailLevel 决策：auto 走两阶段（分类→选 prompt）；casual/detailed 直接选定
      const detailLevel = opts.detailLevel ?? 'auto';
      let basePrompt: string;
      let chosenTier: 'casual' | 'detailed' | 'professional';
      if (detailLevel === 'casual') {
        basePrompt = this.cfg.vision.prompt || DEFAULT_VISION_PROMPT;
        chosenTier = 'casual';
      } else if (detailLevel === 'detailed') {
        basePrompt = DEFAULT_VISION_DETAILED_PROMPT;
        chosenTier = 'detailed';
        chosenTier = 'professional';
      } else {
        // auto：调一次轻量分类（耗时 ~1-2s）
        const picked = await this.classifyAndPickPrompt(proc, imageUrl);
        basePrompt = picked.prompt;
        chosenTier = picked.tier;
      }
      this.logger.info(
        `[vision.describe] source=tool tier=${chosenTier} (detailLevel=${detailLevel}) promptChars=${basePrompt.length}`,
      );
      const r = await proc.describe(
        {
          attachments: [{ kind: 'image', data: imageUrl }],
          mode: 'single',
          maxTokens: opts.maxTokens ?? this.cfg.vision.maxTokens,
          basePrompt,
          hint: opts.hint,
        },
        this.ctx,
      );
      result = r.descriptions[0] ?? '';
    }

    if (!noCache && !opts.hint && result) rememberDescription(imageUrl, result);
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
  /**
   * 两阶段第一步：用极简 prompt 让 vision 模型分类图片，返回对应的二阶 base prompt。
   *
   * 设计：
   * - 分类输出只有 3 个有效标签（document/casual/mixed），其他任何输出都按 detailed 处理
   * - mixed 类也用 detailed prompt（"宁详勿略"原则）
   * - 任何异常（超时/网络/模型拒绝）→ fallback 到 detailed prompt，保证不漏信息
   * - 不计入描述缓存（hint 不同，缓存键也不会重复）
   */
  private async classifyAndPickPrompt(
    proc: MediaProcessor,
    imageUrl: string,
  ): Promise<{ prompt: string; tier: 'casual' | 'detailed' | 'professional' }> {
    if (!proc.describe) return { prompt: DEFAULT_VISION_DETAILED_PROMPT, tier: 'detailed' };
    const t0 = Date.now();
    try {
      const r = await proc.describe(
        {
          attachments: [{ kind: 'image', data: imageUrl }],
          mode: 'single',
          // 分类输出极短，给 32 token 即可（容纳标签 + 可能的多余空白）
          maxTokens: 32,
          // 用 basePrompt 完全替换默认 base，避免 casual 描述 prompt 与分类指令冲突
          basePrompt: VISION_CLASSIFY_PROMPT,
        },
        this.ctx,
      );
      const label = (r.descriptions[0] ?? '').toLowerCase().trim();
      // 4 标签匹配：professional → 专业题目；casual → 简洁；其余（document/mixed/unknown）→ detailed
      let tier: 'casual' | 'detailed' | 'professional';
      let prompt: string;
      if (label === 'professional' || label.startsWith('professional')) {
        tier = 'professional';
        prompt = DEFAULT_VISION_PROFESSIONAL_PROMPT;
      } else if (label === 'casual' || label.startsWith('casual')) {
        tier = 'casual';
        prompt = this.cfg.vision.prompt || DEFAULT_VISION_PROMPT;
      } else {
        tier = 'detailed';
        prompt = DEFAULT_VISION_DETAILED_PROMPT;
      }
      this.logger.info(
        `[vision.classify] ${Date.now() - t0}ms label="${label}" → tier=${tier} (prompt ${prompt.length}字)`,
      );
      return { prompt, tier };
    } catch (err) {
      this.logger.warn(`[vision.classify] 失败，fallback 到 detailed: ${err instanceof Error ? err.message : err}`);
      return { prompt: DEFAULT_VISION_DETAILED_PROMPT, tier: 'detailed' };
    }
  }
}

/** 安全构造对话上下文：失败/异常返回 undefined，不让 processor 调用受阻。 */
async function safeBuildContext(
  ctx: Context,
  msg: IncomingMessage,
  beforeLimit: number,
  senderCfg: { enabled: boolean; profileMaxChars: number } | undefined,
  logger: Logger,
): Promise<string | undefined> {
  try {
    const text = await buildIncomingImageContext(ctx, msg, beforeLimit, senderCfg);
    return text && text.trim().length > 0 ? text : undefined;
  } catch (err) {
    logger.debug(`buildContext 失败，跳过: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
