// ============================================================
// @aalis/plugin-image-sender — 让 agent 主动发图
//
// 工具：
//   1. preview_image —— 在选图前用 vision 看清候选图（搜索结果标题常误导）
//   2. send_image    —— 真正把图发出去；同步描述并入档，让"AI 之前发过的图"
//                       能被 memory_recall 召回
//
// send_image 来源：url / file_path / history_ref
// 此插件不直接调用平台 API，而是 emit `outbound:message`（含 attachments[]）；
// 由各 platform adapter（OneBot / WebUI）按自身能力处理结构化附件。
// ============================================================

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Context } from '@aalis/core';
import type { MediaService } from '@aalis/plugin-media-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message, MessageAttachment, OutgoingMessage } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import { useToolService } from '@aalis/plugin-tools-api';

export const name = '@aalis/plugin-image-sender';
export const displayName = '图片发送';
export const subsystem = 'tools';
export const inject = { optional: ['memory', 'media', 'message-archive'] };

/** 单张图描述同步等待上限。超时不阻塞发送，只是 description 字段为空。 */
const DESCRIBE_TIMEOUT_MS = 8_000;
/** preview_image 单次允许的候选数量上限。 */
const PREVIEW_MAX_CANDIDATES = 8;

export function apply(ctx: Context): void {
  const tools = useToolService(ctx);

  // ── preview_image ─────────────────────────────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'preview_image',
        description:
          '在真正发送前，先让自己"看见"候选图片的实际内容（vision 模型识别）。' +
          '适用场景：search_images 返回了若干 URL，但标题常常误导/含糊，' +
          '你想从中挑出最符合语境的一张再 send_image 发出。' +
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

  // ── send_image ────────────────────────────────────────────────────────────
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'send_image',
        description:
          '主动向当前会话发送一张图片。可以从 URL、本地文件、或历史消息中已识别的图片引用发出。\n' +
          '使用场景：用户请求"发个表情包"、"发刚才那张图给我"、"在网上找张猫的图"等。\n' +
          '建议流程：search_images 拿到候选 URL → preview_image 看清内容 → send_image 选其一发出。\n' +
          '若想"重发自己之前发过的图"，先用 memory_recall 按描述检索历史，' +
          '从命中消息里找到 [图片: ... | ref:xxx]，把 xxx 传给 history_ref。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '网络图片 URL（http/https）。' },
            file_path: { type: 'string', description: '本地图片路径（绝对或相对工程根）。' },
            history_ref: {
              type: 'string',
              description: '历史消息中的图片引用路径（[图片 | ref:xxx] 中 xxx 部分）。',
            },
            caption: { type: 'string', description: '可选：图片附带的文字说明。' },
          },
        },
      },
    },
    handler: async (args, callCtx) => {
      const url = (args.url as string)?.trim();
      const filePath = (args.file_path as string)?.trim();
      const historyRef = (args.history_ref as string)?.trim();
      const caption = (args.caption as string)?.trim() || '';

      let imageData: string | null = null;
      let refTag: string | null = null;
      let via: 'url' | 'file_path' | 'history_ref' = 'url';
      try {
        if (url) {
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return JSON.stringify({ error: 'url 必须是 http/https 开头' });
          }
          imageData = url;
          refTag = url;
          via = 'url';
        } else if (filePath) {
          const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
          if (!existsSync(abs)) return JSON.stringify({ error: `本地文件不存在: ${abs}` });
          imageData = `file://${abs}`;
          refTag = abs;
          via = 'file_path';
        } else if (historyRef) {
          const found = await resolveHistoryRef(ctx, callCtx.sessionId, historyRef);
          if (!found) return JSON.stringify({ error: `未在历史中找到引用: ${historyRef}` });
          imageData = found;
          refTag = historyRef.replace(/^ref:/, '').trim();
          via = 'history_ref';
        } else {
          return JSON.stringify({ error: '必须提供 url / file_path / history_ref 之一' });
        }

        // 同步描述：让 LLM 在 tool result 里立刻看到自己发了什么；
        // 也让档案里的标记格式（[图片: desc | ref:xxx]）能被后续 memory_recall 命中。
        // history_ref 复用已有描述（历史里已经有），跳过二次识别。
        let description = '';
        if (via !== 'history_ref') {
          description = await safeDescribe(ctx, imageData);
        }

        const attachment: MessageAttachment = {
          kind: 'image',
          data: imageData,
        };
        const outgoing: OutgoingMessage = {
          sessionId: callCtx.sessionId,
          content: caption,
          attachments: [attachment],
          source: 'agent',
        };
        ctx.emit('outbound:message', outgoing);

        // 入档：assistant 角色，content 用统一的 [图片: desc | ref:xxx] 格式；
        // plugin-memory-vector 会自动 embed 此条，未来 memory_recall 能召回。
        // history_ref 跳过入档（同一张图重发，避免向量库膨胀）。
        if (via !== 'history_ref') {
          await archiveOutboundImage(ctx, callCtx.sessionId, refTag, description, caption, imageData);
        }

        return JSON.stringify({
          ok: true,
          sent: { kind: 'image', via, ref: refTag, description: description || null },
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  ctx.logger.info('[image-sender] 工具 send_image / preview_image 已注册');
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

/** 把 AI 自己发出的图入档为一条 assistant 消息，让 memory_recall 能找到。 */
async function archiveOutboundImage(
  ctx: Context,
  sessionId: string,
  ref: string | null,
  description: string,
  caption: string,
  imageData: string,
): Promise<void> {
  const archive = ctx.getService<MessageArchiveService>('message-archive');
  if (!archive?.saveMessage) return;
  const refStr = ref ?? imageData;
  const tag = description ? `[图片: ${description} | ref:${refStr}]` : `[图片 | ref:${refStr}]`;
  const content = caption ? `${caption}\n${tag}` : tag;
  const message: Message = {
    role: 'assistant',
    content,
    timestamp: Date.now(),
    metadata: { source: 'image-sender', kind: 'outbound-image', ref: refStr },
  };
  try {
    await archive.saveMessage(sessionId, message, { debugLabel: '[image-sender] 已入档发送的图片' });
  } catch (err) {
    ctx.logger.warn(`[image-sender] 入档失败: ${err instanceof Error ? err.message : err}`);
  }
}

/** 在最近 200 条消息里寻找匹配 historyRef 的图片来源（取本地路径或 URL）。 */
async function resolveHistoryRef(ctx: Context, sessionId: string, ref: string): Promise<string | null> {
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) return null;
  const history: Message[] = memory.getFullHistory
    ? await memory.getFullHistory(sessionId, 200)
    : await memory.getHistory(sessionId, 200);
  const normalized = ref.replace(/^ref:/, '').trim();
  // 允许 ref 形如 data/images/xxx.jpg；优先本地文件路径
  const abs = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
  if (existsSync(abs)) return `file://${abs}`;
  // http(s) ref：直接当 URL 用（image-sender 自己入档的出站图通常走这条）
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized;
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
