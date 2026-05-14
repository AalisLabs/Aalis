// ============================================================
// service.ts — MediaService 实现
// ============================================================

import type { Context, Logger } from '@aalis/core';
import type { ModelRef } from '@aalis/plugin-llm-api';
import type {
  BuildContextOptions,
  DescribeImageOptions,
  DescribeOptions,
  MediaCapability,
  MediaProcessor,
  MediaProcessReport,
  MediaService,
  TranscribeOptions,
} from '@aalis/plugin-media-api';
import type { IncomingMessage, MessageAttachment } from '@aalis/plugin-message-api';
import { lookupCachedDescription, rememberDescription } from './cache.js';
import { buildIncomingImageContext, buildVisionPrompt } from './context.js';
import {
  downloadToTemp,
  extractAudioTrack,
  extractFrames,
  getFrameCount,
  isAnimatedFormat,
  materializeAttachment,
  selectFrameIndices,
} from './ffmpeg.js';
import { scanLLMProcessors } from './llm-adapter.js';
import { normalizeAttachments } from './normalize.js';

export interface MediaConfigResolved {
  vision: { mode: 'describe' | 'passthrough' | 'disabled'; prefer?: string; maxTokens: number; prompt?: string };
  audio: {
    transcribe: { mode: 'enabled' | 'disabled'; prefer?: string; language?: string };
    describe: { mode: 'enabled' | 'disabled'; prefer?: string };
  };
  video: { mode: 'frames+asr' | 'frames-only' | 'disabled'; maxFrames: number };
  document: { extractImages: boolean };
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

    // audio.describe
    if (byKind.audio.length > 0 && this.cfg.audio.describe.mode === 'enabled') {
      const proc = this.pickProcessor('audio.describe', opts.prefer ?? this.cfg.audio.describe.prefer);
      if (proc?.describe) {
        for (const i of byKind.audio) {
          try {
            const r = await proc.describe(
              { attachments: [attachments[i]], mode: 'single', hint: opts.hint, maxTokens: opts.maxTokens },
              this.ctx,
            );
            out[i] = r.descriptions[0];
          } catch (err) {
            this.logger.warn(`音频描述失败: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    return out;
  }

  async transcribe(attachment: MessageAttachment, opts: TranscribeOptions = {}): Promise<string | undefined> {
    if (this.cfg.audio.transcribe.mode === 'disabled') return undefined;
    const proc = this.pickProcessor('audio.transcribe', opts.prefer ?? this.cfg.audio.transcribe.prefer);
    if (!proc?.transcribe) {
      this.logger.debug('无 audio.transcribe processor 可用');
      return undefined;
    }
    try {
      const r = await proc.transcribe(
        {
          attachment,
          language: opts.language ?? this.cfg.audio.transcribe.language,
          withTimestamps: opts.withTimestamps,
        },
        this.ctx,
      );
      return r.text;
    } catch (err) {
      this.logger.warn(`音频转写失败: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  async processMessage(msg: IncomingMessage): Promise<MediaProcessReport> {
    const attachments = normalizeAttachments(msg);
    const report: MediaProcessReport = { total: attachments.length, successCount: 0, items: [] };
    if (attachments.length === 0) return report;

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
              const text = await this.processVideo(att);
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
                const r = await proc.describe(
                  {
                    attachments: [att],
                    mode: 'single',
                    maxTokens: this.cfg.vision.maxTokens,
                    hint: this.cfg.vision.prompt,
                  },
                  this.ctx,
                );
                item.description = r.descriptions[0];
                descriptions[i] = item.description;
                if (item.description) rememberDescription(att.data, item.description);
              }
            }
          }
        } else if (att.kind === 'audio') {
          // 优先 transcribe（更准），失败/未启用则降级 describe
          if (this.cfg.audio.transcribe.mode === 'enabled') {
            const text = await this.transcribe(att);
            if (text) {
              item.cap = 'audio.transcribe';
              item.description = `[语音转写] ${text}`;
              descriptions[i] = item.description;
            }
          }
          if (!item.description && this.cfg.audio.describe.mode === 'enabled') {
            const proc = this.pickProcessor('audio.describe', this.cfg.audio.describe.prefer);
            item.cap = 'audio.describe';
            item.processor = proc?.name;
            if (proc?.describe) {
              const r = await proc.describe({ attachments: [att], mode: 'single' }, this.ctx);
              item.description = r.descriptions[0];
              descriptions[i] = item.description;
            }
          }
        } else if (att.kind === 'video') {
          if (this.cfg.video.mode !== 'disabled') {
            item.description = await this.processVideo(att);
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

  /** 视频：抽帧 + 抽音轨转写 → 拼综合描述 */
  private async processVideo(att: MessageAttachment): Promise<string | undefined> {
    const local = await materializeAttachment(att.data);
    if (!local) {
      this.logger.debug('视频无法物化为本地文件，跳过');
      return undefined;
    }
    try {
      const frameTexts: string[] = [];
      const totalFrames = await getFrameCount(local.path);
      if (totalFrames > 0) {
        const indices = selectFrameIndices(totalFrames, this.cfg.video.maxFrames);
        const frames = await extractFrames(local.path, indices);
        if (frames.length > 0) {
          const proc = this.pickProcessor('vision', this.cfg.vision.prefer);
          if (proc?.describe) {
            const frameAtts: MessageAttachment[] = frames.map(d => ({ kind: 'image', data: d, mimeType: 'image/png' }));
            const r = await proc.describe(
              {
                attachments: frameAtts,
                mode: 'combined',
                maxTokens: this.cfg.vision.maxTokens,
                hint: '以下为同一视频的关键帧，按时间顺序排列。',
              },
              this.ctx,
            );
            const text = r.descriptions[0];
            if (text) frameTexts.push(`[画面] ${text}`);
          }
        }
      }

      if (this.cfg.video.mode === 'frames+asr' && this.cfg.audio.transcribe.mode === 'enabled') {
        const audioDataUrl = await extractAudioTrack(local.path);
        if (audioDataUrl) {
          const text = await this.transcribe({ kind: 'audio', data: audioDataUrl, mimeType: 'audio/mpeg' });
          if (text) frameTexts.push(`[音轨] ${text}`);
        }
      }

      if (frameTexts.length === 0) return undefined;
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
    return buildIncomingImageContext(this.ctx, msg, opts?.beforeLimit);
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
            const indices = selectFrameIndices(total, this.cfg.video.maxFrames);
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
                  hint: buildVisionPrompt(this.cfg.vision.prompt ?? '描述这个动图/视频。', opts.hint),
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
      const r = await proc.describe(
        {
          attachments: [{ kind: 'image', data: imageUrl }],
          mode: 'single',
          maxTokens: opts.maxTokens ?? this.cfg.vision.maxTokens,
          hint: buildVisionPrompt(this.cfg.vision.prompt ?? '请简洁描述这张图片。', opts.hint),
        },
        this.ctx,
      );
      result = r.descriptions[0] ?? '';
    }

    if (!noCache && !opts.hint && result) rememberDescription(imageUrl, result);
    return result;
  }
}
