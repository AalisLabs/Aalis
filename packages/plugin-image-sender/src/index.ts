// ============================================================
// @aalis/plugin-image-sender — 让 agent 主动发图
//
// 工具 send_image 支持 4 种来源：
//   - url:        网络图片 URL（适配器会主动下载为本地文件再发）
//   - file_path:  本地绝对/相对路径
//   - history_ref: 引用此前历史消息中已存在的 [图片 | ref:xxx] 标记
//   - search_pick: 由 agent 在调用前先用 search_images 取到候选 url，再传入
// 此插件不直接调用平台 API，而是 emit `outbound:message`（含 attachments[]）。
// 由各 platform adapter（OneBot / WebUI）按自身能力处理结构化附件。
// ============================================================

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message, MessageAttachment, OutgoingMessage } from '@aalis/plugin-message-api';
import { useToolService } from '@aalis/plugin-tools-api';

export const name = '@aalis/plugin-image-sender';
export const displayName = '图片发送';
export const subsystem = 'tools';
export const inject = { optional: ['memory'] };

export function apply(ctx: Context): void {
  const tools = useToolService(ctx);

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'send_image',
        description:
          '主动向当前会话发送一张图片。可以从 URL、本地文件、或历史消息中已识别的图片引用发出。\n' +
          '使用场景：用户请求"发个表情包"、"发刚才那张图给我"、"在网上找张猫的图"等。\n' +
          '与 search_images 配合使用：先 search_images 拿到 URL，再 send_image 选其中一张发出。',
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
      try {
        if (url) {
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return JSON.stringify({ error: 'url 必须是 http/https 开头' });
          }
          imageData = url;
        } else if (filePath) {
          const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
          if (!existsSync(abs)) return JSON.stringify({ error: `本地文件不存在: ${abs}` });
          imageData = `file://${abs}`;
        } else if (historyRef) {
          const found = await resolveHistoryRef(ctx, callCtx.sessionId, historyRef);
          if (!found) return JSON.stringify({ error: `未在历史中找到引用: ${historyRef}` });
          imageData = found;
        } else {
          return JSON.stringify({ error: '必须提供 url / file_path / history_ref 之一' });
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
        return JSON.stringify({
          ok: true,
          sent: { kind: 'image', via: url ? 'url' : filePath ? 'file_path' : 'history_ref' },
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  ctx.logger.info('[image-sender] 工具 send_image 已注册');
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
