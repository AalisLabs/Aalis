// ============================================================
// @aalis/plugin-image-sender — 让 agent 主动发送图片/语音/视频
//
// 工具：
//   1. preview_image    —— 在选图前用 vision 看清候选图（搜索结果标题常误导）
//   2. send_attachment  —— 统一的出站附件接口：把 image/audio/video 发出去；
//                          同步描述并入档，让"AI 之前发过的图/视频"能被
//                          memory_recall 召回
//
// send_attachment 来源：url / storage_uri / history_ref（不接受裸本地路径）
// 此插件不直接调用平台 API，而是 emit `outbound:message`（含 attachments[]）；
// 由各 platform adapter（OneBot / WebUI）按自身能力处理结构化附件。
// ============================================================

import type { Context } from '@aalis/core';
import type { MediaService } from '@aalis/plugin-media-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import {
  AttachmentRefKind,
  formatAttachmentRef,
  type Message,
  type MessageAttachment,
  type OutgoingMessage,
  WellKnownKinds,
} from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import { useToolService } from '@aalis/plugin-tools-api';

export const name = '@aalis/plugin-image-sender';
export const displayName = '图片发送';
export const subsystem = 'tools';
export const inject = { optional: ['memory', 'media', 'message-archive'] };

/** 可发送的附件类型。 */
type MediaKind = 'image' | 'audio' | 'video';

/** 单张图描述同步等待上限。超时不阻塞发送，只是 description 字段为空。 */
const DESCRIBE_TIMEOUT_MS = 8_000;
/** 视频描述同步等待上限（视频需抽帧+ASR，耗时远高于图片）。 */
const VIDEO_DESCRIBE_TIMEOUT_MS = 30_000;
/** preview_image 单次允许的候选数量上限。 */
const PREVIEW_MAX_CANDIDATES = 8;

export function apply(ctx: Context): void {
  const tools = useToolService(ctx);
  const storage = createStorageGateway(ctx);

  // 把 storage URI（含 ':/'）解析为发送可用的数据串：
  // - stat 验证存在性
  // - 可解析本地路径时转 file://（供 daemon 直链），否则保留原 URI
  async function resolveStorageUri(
    input: string,
  ): Promise<{ ok: true; data: string; ref: string } | { ok: false; error: string }> {
    try {
      await storage.stat(input);
    } catch {
      return { ok: false, error: `存储资源不存在: ${input}` };
    }
    const local = await tryResolveLocal(storage, input);
    return { ok: true, data: local ? `file://${local}` : input, ref: input };
  }

  // ── preview_image ─────────────────────────────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'preview_image',
        description:
          '在真正发送前，先让自己"看见"候选图片的实际内容（vision 模型识别）。' +
          '适用场景：search_images 返回了若干 URL，但标题常常误导/含糊，' +
          '你想从中挑出最符合语境的一张再 send_attachment 发出。' +
          '本工具不发送任何消息，只返回每张图的描述。',
        parameters: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              description: `要识别的图片 URL 列表（http/https），最多 ${PREVIEW_MAX_CANDIDATES} 张。`,
            },
            hint: {
              type: 'string',
              description: '可选：给 vision 模型的关注点提示（例如"这张图里有猫吗"）。',
            },
          },
          required: ['urls'],
        },
      },
    },
    handler: async args => {
      const urls = Array.isArray(args.urls) ? (args.urls as unknown[]).map(String) : [];
      const hint = (args.hint as string) || undefined;
      if (urls.length === 0) return JSON.stringify({ error: 'urls 不能为空' });
      if (urls.length > PREVIEW_MAX_CANDIDATES) {
        return JSON.stringify({ error: `最多 ${PREVIEW_MAX_CANDIDATES} 张` });
      }

      const media = ctx.getService<MediaService>('media');
      if (!media?.describeImage) {
        return JSON.stringify({ error: '未启用 media 服务，无法识别图片' });
      }

      const results = await Promise.all(
        urls.map(async (url, index) => {
          const trimmed = url.trim();
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return { index, url: trimmed, ok: false, error: 'url 必须是 http/https' };
          }
          try {
            const desc = await Promise.race([
              media.describeImage(trimmed, { hint }),
              new Promise<string>((_resolve, reject) =>
                setTimeout(() => reject(new Error('vision 超时')), DESCRIBE_TIMEOUT_MS),
              ),
            ]);
            const description = (desc ?? '').trim();
            return description
              ? { index, url: trimmed, ok: true, description }
              : { index, url: trimmed, ok: false, error: 'vision 返回空' };
          } catch (err) {
            return { index, url: trimmed, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );

      return JSON.stringify({ ok: true, count: results.length, results });
    },
  });

  // ── send_attachment ───────────────────────────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'send_attachment',
        description:
          '主动向当前会话发送一个附件（图片 / 语音 / 视频，仅附件本身，不带文字）。\n' +
          '使用场景：用户请求"发个表情包"、"发刚才那张图/那段语音给我"、"在网上找张猫的图"等。\n' +
          'kind 必填，指定附件类型；来源三选一：\n' +
          '  - url：网络资源 URL（http/https）。\n' +
          '  - storage_uri：存储库内的资源 URI（如 data:/images/xxx）。\n' +
          '  - history_ref：历史消息中已识别的引用（[图片/语音/视频: ... | ref:xxx] 中 xxx 部分），\n' +
          '    用于"把之前那条媒体重发/转发回去"。\n' +
          '建议流程（图片）：search_images 拿候选 URL → preview_image 看清内容 → send_attachment 选其一发出。\n' +
          '若想重发自己之前发过的媒体，先用 memory_recall 按描述检索历史，从命中消息里找到 ref 再传 history_ref。\n' +
          '注意：本工具不发送任何文字。如需配文，请把文字写在你本轮最终输出的 message 字段里——' +
          '不要在 message 中重复媒体描述。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['image', 'audio', 'video'],
              description: '附件类型：image=图片，audio=语音，video=视频。',
            },
            url: { type: 'string', description: '网络资源 URL（http/https）。' },
            storage_uri: { type: 'string', description: '存储库内资源 URI（如 data:/images/xxx）。' },
            history_ref: {
              type: 'string',
              description: '历史消息中的引用路径（[... | ref:xxx] 中 xxx 部分）。',
            },
          },
          required: ['kind'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const kind = (args.kind as string)?.trim() as MediaKind;
      if (kind !== 'image' && kind !== 'audio' && kind !== 'video') {
        return JSON.stringify({ error: 'kind 必须是 image / audio / video 之一' });
      }
      const url = (args.url as string)?.trim();
      const storageUri = (args.storage_uri as string)?.trim();
      const historyRef = (args.history_ref as string)?.trim();

      let data: string | null = null;
      let refTag: string | null = null;
      let via: 'url' | 'storage_uri' | 'history_ref' = 'url';
      try {
        if (url) {
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return JSON.stringify({ error: 'url 必须是 http/https 开头' });
          }
          data = url;
          refTag = url;
          via = 'url';
        } else if (storageUri) {
          const resolved = await resolveStorageUri(storageUri);
          if (!resolved.ok) return JSON.stringify({ error: resolved.error });
          data = resolved.data;
          refTag = resolved.ref;
          via = 'storage_uri';
        } else if (historyRef) {
          const found = await resolveHistoryRef(ctx, storage, callCtx.sessionId, historyRef);
          if (!found) return JSON.stringify({ error: `未在历史中找到引用: ${historyRef}` });
          data = found;
          refTag = historyRef.replace(/^ref:/, '').trim();
          via = 'history_ref';
        } else {
          return JSON.stringify({ error: '必须提供 url / storage_uri / history_ref 之一' });
        }

        // 同步描述：让 LLM 在 tool result 里立刻看到自己发了什么；
        // 也让档案里的标记格式（[图片: desc | ref:xxx]）能被后续 memory_recall 命中。
        // history_ref 复用历史已有描述，跳过二次识别；audio 暂无描述能力。
        let description = '';
        if (via !== 'history_ref') {
          description = await safeDescribeMedia(ctx, kind, data);
        }

        const attachment: MessageAttachment = { kind, data };
        const outgoing: OutgoingMessage = {
          sessionId: callCtx.sessionId,
          content: '',
          attachments: [attachment],
          source: 'agent',
        };
        ctx.emit('outbound:message', outgoing);

        // 入档：assistant 角色，content 用统一的 [类型: desc | ref:xxx] 格式；
        // plugin-memory-vector 会自动 embed 此条，未来 memory_recall 能召回。
        // history_ref 跳过入档（同一媒体重发，避免向量库膨胀）。
        if (via !== 'history_ref') {
          await archiveOutboundAttachment(ctx, callCtx.sessionId, refTag ?? data, description, kind);
        }

        return JSON.stringify({
          ok: true,
          sent: { kind, via, ref: refTag, description: description || null },
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  ctx.logger.info('[image-sender] 工具 send_attachment / preview_image 已注册');
}

/** 按 kind 调用对应的 media 描述能力，超时或失败返回空串（不阻塞发送）。 */
async function safeDescribeMedia(ctx: Context, kind: MediaKind, data: string): Promise<string> {
  if (kind === 'image') return safeDescribe(ctx, data);
  if (kind === 'video') return safeDescribeVideo(ctx, data);
  // audio 暂无描述能力
  return '';
}

/** 调 media.describeImage，超时或失败返回空串（不阻塞发送）。 */
async function safeDescribe(ctx: Context, imageData: string): Promise<string> {
  const media = ctx.getService<MediaService>('media');
  if (!media?.describeImage) return '';
  try {
    const desc = await Promise.race([
      media.describeImage(imageData),
      new Promise<string>((_resolve, reject) =>
        setTimeout(() => reject(new Error('vision 超时')), DESCRIBE_TIMEOUT_MS),
      ),
    ]);
    return (desc ?? '').trim();
  } catch (err) {
    ctx.logger.debug(`[image-sender] vision 失败，跳过描述: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

/** 调 media.describeVideo，超时或失败返回空串（视频抽帧耗时长，用更宽松的超时）。 */
async function safeDescribeVideo(ctx: Context, videoUrl: string): Promise<string> {
  const media = ctx.getService<MediaService>('media');
  if (!media?.describeVideo) return '';
  try {
    const desc = await Promise.race([
      media.describeVideo(videoUrl),
      new Promise<string>((_resolve, reject) =>
        setTimeout(() => reject(new Error('video 描述超时')), VIDEO_DESCRIBE_TIMEOUT_MS),
      ),
    ]);
    return (desc ?? '').trim();
  } catch (err) {
    ctx.logger.debug(`[image-sender] video 描述失败，跳过: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

/** 把 AI 自己发出的图/语音/视频入档为一条 assistant 消息，让 memory_recall 能找到。 */
async function archiveOutboundAttachment(
  ctx: Context,
  sessionId: string,
  ref: string,
  description: string,
  kind: MediaKind,
): Promise<void> {
  const archive = ctx.getService<MessageArchiveService>('message-archive');
  if (!archive?.saveMessage) return;
  const attachKind =
    kind === 'video' ? AttachmentRefKind.Video : kind === 'audio' ? AttachmentRefKind.Audio : AttachmentRefKind.Image;
  const msgKind =
    kind === 'video'
      ? WellKnownKinds.OutboundVideo
      : kind === 'audio'
        ? WellKnownKinds.OutboundAudio
        : WellKnownKinds.OutboundImage;
  const label = kind === 'video' ? '视频' : kind === 'audio' ? '语音' : '图片';
  const tag = formatAttachmentRef({ kind: attachKind, desc: description, ref });
  const message: Message = {
    role: 'assistant',
    kind: msgKind,
    content: tag,
    timestamp: Date.now(),
    metadata: { source: 'image-sender', ref },
  };
  try {
    await archive.saveMessage(sessionId, message, {
      debugLabel: `[image-sender] 已入档发送的${label}`,
    });
  } catch (err) {
    ctx.logger.warn(`[image-sender] 入档失败: ${err instanceof Error ? err.message : err}`);
  }
}

/** 在最近 200 条消息里寻找匹配 historyRef 的图片来源（取本地路径或 URL）。 */
async function resolveHistoryRef(
  ctx: Context,
  storage: StorageService,
  sessionId: string,
  ref: string,
): Promise<string | null> {
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) return null;
  const history: Message[] = memory.getFullHistory
    ? await memory.getFullHistory(sessionId, 200)
    : await memory.getHistory(sessionId, 200);
  const normalized = ref.replace(/^ref:/, '').trim();
  // http(s) ref：直接当 URL 用
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized;
  }
  // file:// ref：原样返回
  if (normalized.startsWith('file://')) return normalized;
  // storage URI 格式：stat 不在则忽略，在则尝试本地路径
  if (normalized.includes(':/')) {
    try {
      await storage.stat(normalized);
      const local = await tryResolveLocal(storage, normalized);
      return local ? `file://${local}` : normalized;
    } catch {
      // fallthrough 到历史子串匹配
    }
  }
  // 回退：搜历史里 images / attachments 数组里包含 normalized 子串的项
  for (const msg of history) {
    const m = msg as Message & { images?: string[]; attachments?: MessageAttachment[] };
    if (m.images?.length) {
      for (const img of m.images) {
        if (img.includes(normalized)) return img;
      }
    }
    if (m.attachments?.length) {
      for (const att of m.attachments) {
        if (att.data.includes(normalized)) return att.data;
      }
    }
  }
  return null;
}

/** 如果 storage 支持 resolveLocalPath，则解析为本地绝对路径供下游 file:// 直链使用。 */
async function tryResolveLocal(storage: StorageService, uri: string): Promise<string | null> {
  if (typeof storage.resolveLocalPath !== 'function') return null;
  try {
    const p = await storage.resolveLocalPath(uri, 'read');
    return p ?? null;
  } catch {
    return null;
  }
}
