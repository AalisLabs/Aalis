import type { CodeSandboxService } from '@aalis/api-code-sandbox';
import { type LLMModel, resolveLLMModel } from '@aalis/api-llm';
import type { PublishFile } from '@aalis/api-publish';
import type { StorageService } from '@aalis/api-storage';
import type { ServiceRef } from '@aalis/core';
import type { OfflineRenderer } from '@aalis/util-offline-render';
import { contentType, markContent } from './checks.js';
import { type ClassificationVerdict, classifyImage, classifyText, combineVerdicts, reviewText } from './classify.js';
import type { ReviewConfig } from './config.js';
import { SandboxedMedia } from './media.js';
import type { ReviewResult } from './policy.js';
import { stripEmbeddedDataUrls, stripStaticMedia } from './strip/index.js';

export interface ReviewEvidence {
  flags: string[];
  reasons: string[];
  images: Array<{ name: string; bytes: Uint8Array }>;
  render?: Uint8Array;
  classification?: string;
}

/** W9 提供真实的净化、渲染和分类步骤；W6 的测试以注入实现验证持久化与发布边界。 */
export interface ReviewPipeline {
  run(input: {
    id: string;
    title: string;
    summary: string;
    files: readonly PublishFile[];
    cover?: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ verdict: ReviewResult; files: PublishFile[]; thumbnail?: Uint8Array; evidence?: ReviewEvidence }>;
}

interface ReviewPipelineDeps {
  config: ReviewConfig;
  storage: StorageService;
  llm?: ServiceRef<LLMModel>;
  sandbox?: ServiceRef<CodeSandboxService>;
  renderer?: OfflineRenderer;
  ffmpegPath?: string;
  ffprobePath?: string;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const texts = new Set(['html', 'css', 'js', 'mjs', 'json', 'svg']);
const staticImages = new Set(['png', 'jpg', 'jpeg', 'webp']);
const mimeExt: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
};

function exactModel(
  source: ServiceRef<LLMModel> | undefined,
  ref: { provider?: string; model?: string } | undefined,
  vision = false,
): LLMModel | undefined {
  if (!source || !ref?.provider || !ref.model) return undefined;
  return resolveLLMModel(source, ref, vision ? ['vision'] : undefined)?.instance;
}

/** Real review steps. Anything not fully observed yields unsure and waits for human review before publication. */
export function createReviewPipeline(deps: ReviewPipelineDeps): ReviewPipeline {
  return {
    async run(input) {
      const reasons: string[] = [];
      const evidence: ReviewEvidence = { flags: [], reasons, images: [] };
      const media = new SandboxedMedia({
        storage: deps.storage,
        sandbox: deps.sandbox?.current,
        ffmpegPath: deps.ffmpegPath ?? deps.config.ffmpegPath,
        ffprobePath: deps.ffprobePath,
        id: input.id,
        signal: input.signal,
      });
      const files: PublishFile[] = [];
      const images: Array<{ bytes: Uint8Array; type: string; name: string }> = [];
      const textsForReview: string[] = [];
      let audio = false;
      try {
        for (const file of input.files) {
          input.signal.throwIfAborted();
          const type = extension(file.path);
          let bytes: Uint8Array = new Uint8Array(file.bytes);
          if (type === 'mp4') {
            const clean = await media.stripMp4(bytes);
            bytes = clean.bytes;
            audio ||= clean.audio;
            images.push({ bytes, type, name: file.path });
          } else if (staticImages.has(type) || type === 'gif') {
            bytes = stripStaticMedia(type, bytes);
            images.push({ bytes, type, name: file.path });
          } else if (texts.has(type)) {
            let body = decoder.decode(bytes);
            if (type === 'svg') body = decoder.decode(stripStaticMedia('svg', bytes));
            const embeddedResult = await stripEmbeddedDataUrls(body, async (mime, embedded) => {
              const embeddedType = mimeExt[mime];
              if (embeddedType === 'mp4') {
                const clean = await media.stripMp4(embedded);
                audio ||= clean.audio;
                return clean.bytes;
              }
              return stripStaticMedia(embeddedType, embedded);
            });
            for (const embedded of embeddedResult.images)
              images.push({ bytes: embedded.bytes, type: mimeExt[embedded.mime], name: `embedded-${images.length}` });
            body = embeddedResult.text;
            textsForReview.push(body);
            bytes = encoder.encode(body);
            if (type === 'svg') images.push({ bytes, type, name: file.path });
          }
          files.push({ path: file.path, bytes });
        }
      } catch {
        return { verdict: { verdict: 'failed', reasons: ['文件元数据无法安全剥离'] }, files: [] };
      }

      input.signal.throwIfAborted();
      if (!deps.config.reviewEnabled) return { verdict: { verdict: 'allow', reasons: [] }, files, evidence };

      const marked = markContent(`${input.title}\n${input.summary}`, textsForReview);
      evidence.flags.push(...marked.flags);
      reasons.push(...marked.reasons);
      if (audio) reasons.push('含音轨，审核不听声音');
      const isHtml = files.some(file => file.path === 'index.html');
      if (isHtml) {
        const base = `https://render.invalid/${input.id}/`;
        const resources = new Map(
          files.map(
            file =>
              [
                file.path === 'index.html' ? base : base + file.path,
                { body: file.bytes, contentType: contentType(file.path) },
              ] as const,
          ),
        );
        try {
          if (!deps.renderer) throw new Error('离线渲染不可用');
          const render = stripStaticMedia(
            'png',
            await deps.renderer.renderPng({
              entry: base,
              resources,
              viewport: { width: 1280, height: 800 },
              clip: { kind: 'page', maxHeight: 2400 },
              signal: input.signal,
            }),
          );
          evidence.render = render;
          images.unshift({ bytes: render, type: 'png', name: 'render' });
        } catch {
          reasons.push('离线渲染失败');
        }
      }
      if (input.cover) {
        const format = ['png', 'jpg', 'jpeg', 'gif', 'webp'].find(type => {
          try {
            stripStaticMedia(type, input.cover!);
            return true;
          } catch {
            return false;
          }
        });
        if (format) images.push({ bytes: stripStaticMedia(format, input.cover), type: format, name: 'cover' });
        else reasons.push('封面无法净化');
      }

      const values: ClassificationVerdict[] = [];
      const categories: string[] = [];
      const notes: string[] = [];
      const text = reviewText(
        input.title,
        input.summary,
        files.map(file => file.path),
        textsForReview.join('\n'),
      );
      if (text.truncated) reasons.push('文字太长，自动审核没看全');
      const deadline = AbortSignal.timeout(15 * 60_000);
      const signal = AbortSignal.any([input.signal, deadline]);
      const textResult = await classifyText(exactModel(deps.llm, deps.config.textClassifier), text.text, signal);
      values.push(textResult?.verdict ?? 'unsure');
      if (textResult) {
        categories.push(...textResult.categories);
        notes.push(textResult.note);
      } else reasons.push('文字分类不可用');
      const vision = exactModel(deps.llm, deps.config.imageClassifier ?? deps.config.textClassifier, true);
      const prepared: Array<{ png: Uint8Array; name: string; contact: boolean }> = [];
      const sourceDigests = new Set<string>();
      let thumbnail: Uint8Array | undefined;
      for (const image of images) {
        input.signal.throwIfAborted();
        try {
          const sourceDigest = Buffer.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(image.bytes))),
          ).toString('hex');
          if (sourceDigests.has(sourceDigest)) continue;
          sourceDigests.add(sourceDigest);
          if (image.type === 'gif' || image.type === 'mp4') {
            const extracted = await media.extractFrames(image.bytes, image.type);
            if (extracted.overflow) reasons.push('动画或视频较长，自动审核没看全');
            const sheets = await media.contactSheets(extracted.frames);
            for (const png of sheets) prepared.push({ png, name: image.name, contact: true });
            if (!thumbnail || image.name === 'cover')
              thumbnail =
                image.type === 'mp4'
                  ? await media.frameAt(image.bytes, 'mp4', 1, 480).catch(() => undefined)
                  : await media.toPng(extracted.frames[0], 'png', 480).catch(() => undefined);
          } else {
            const png =
              image.type === 'png'
                ? stripStaticMedia('png', image.bytes)
                : image.type === 'svg'
                  ? stripStaticMedia(
                      'png',
                      await deps.renderer!.renderPng({
                        entry: `https://render.invalid/${input.id}/asset.svg`,
                        resources: new Map([
                          [
                            `https://render.invalid/${input.id}/asset.svg`,
                            { body: image.bytes, contentType: 'image/svg+xml' },
                          ],
                        ]),
                        viewport: { width: 1024, height: 1024 },
                        clip: { kind: 'page', maxHeight: 2400 },
                        signal: input.signal,
                      }),
                    )
                  : await media.toPng(image.bytes, image.type);
            prepared.push({ png, name: image.name, contact: false });
            if (!thumbnail || image.name === 'cover')
              thumbnail = await media.toPng(png, 'png', 480).catch(() => undefined);
          }
        } catch {
          reasons.push(image.type === 'gif' || image.type === 'mp4' ? '抽帧失败' : '图像转换或分类失败');
          values.push('unsure');
        }
      }
      const seen = new Set<string>();
      const unique: typeof prepared = [];
      for (const item of prepared) {
        const hash = Buffer.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(item.png))),
        ).toString('hex');
        if (seen.has(hash)) continue;
        seen.add(hash);
        unique.push(item);
      }
      if (unique.length > 12) reasons.push('图像太多，自动审核没看全');
      for (const item of unique.slice(0, 12)) {
        evidence.images.push({ name: `image-${evidence.images.length + 1}.png`, bytes: item.png });
        const result = await classifyImage(vision, item.png, signal, item.contact);
        values.push(result?.verdict ?? 'unsure');
        if (result) {
          categories.push(...result.categories);
          notes.push(result.note);
        } else reasons.push('图像分类不可用');
      }
      evidence.classification = notes.filter(Boolean).join('；').slice(0, 2000);
      let verdict = combineVerdicts(values);
      if (reasons.length && verdict === 'allow') verdict = 'unsure';
      const fixedCategories = [...new Set(categories)];
      const result: ReviewResult = { verdict, reasons: verdict === 'reject' ? fixedCategories : reasons };
      return { verdict: result, files, thumbnail, evidence };
    },
  };
}
