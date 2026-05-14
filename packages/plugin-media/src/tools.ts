// ============================================================
// tools.ts — analyze_image / update_image_description 工具
//
// 由 plugin-image-recognition 移植而来。让 agent 主动分析任意图片
// （本地路径 / URL / data URI），以及把识别结果写回历史消息。
// ============================================================

import { resolve } from 'node:path';
import type { Context } from '@aalis/core';
import type { MediaService } from '@aalis/plugin-media-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import { useToolService } from '@aalis/plugin-tools-api';
import { fileToDataUri } from './ffmpeg.js';

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeImageRef(input: string): string {
  return input.trim().replace(/^ref:/, '');
}

/** 在历史消息中找到所有 [图片(: ...)? | ref:xxx] 占位符。 */
function findImageDescriptionTokens(messages: Message[], imageRef: string): string[] {
  const refPattern = escapeRegExp(normalizeImageRef(imageRef));
  const tokenPattern = new RegExp(`\\[图片(?:: [^\\]\\n]*?)? \\| ref:${refPattern}\\]`, 'g');
  const tokens = new Set<string>();
  for (const message of messages) {
    const content = message.content ?? '';
    for (const match of content.matchAll(tokenPattern)) tokens.add(match[0]);
  }
  return [...tokens];
}

export function registerMediaTools(ctx: Context, getSvc: () => MediaService): void {
  const tools = useToolService(ctx);

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'analyze_image',
        description:
          '分析一张图片或动图/视频的内容，返回文字描述。\n' +
          '可以分析截图文件（如 screen_capture 返回的路径）、本地图片文件或网络图片 URL。\n' +
          '支持自定义提示词，例如：「提取图中所有文字」「描述 UI 布局」「找到按钮位置」等。',
        parameters: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description: '图片来源：本地文件路径（如 workspace/.tmp/screenshots/xxx.png）或网络 URL',
            },
            prompt: { type: 'string', description: '分析提示词（可选）。' },
            task: { type: 'string', description: '本次分析需求（可选）。' },
            context: { type: 'string', description: '补充上下文（可选）。' },
          },
          required: ['image'],
        },
      },
    },
    handler: async args => {
      try {
        const svc = getSvc();
        const imageInput = String(args.image);
        const customPrompt = (args.prompt as string) || undefined;
        const task = (args.task as string) || undefined;
        const extraContext = (args.context as string) || undefined;
        const hint = [
          task ? `用户需求: ${task}` : '',
          !task && customPrompt ? `分析提示词: ${customPrompt}` : '',
          extraContext ? `补充上下文: ${extraContext}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        let imageUrl: string;
        let localPath: string | undefined;
        if (imageInput.startsWith('http://') || imageInput.startsWith('https://') || imageInput.startsWith('data:')) {
          imageUrl = imageInput;
        } else {
          localPath = resolve(process.cwd(), imageInput);
          imageUrl = await fileToDataUri(localPath);
        }

        const desc = await svc.describeImage(imageUrl, { hint, localPath });
        return JSON.stringify(desc ? { description: desc } : { error: '没有可用的视觉模型或识别失败' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'update_image_description',
        description:
          '更新历史消息中图片的描述。当你通过 analyze_image 识别了一张历史图片后，' +
          '调用此工具将描述写回数据库，以便未来检索。',
        parameters: {
          type: 'object',
          properties: {
            image_ref: {
              type: 'string',
              description: '图片引用路径（ref: 后面的部分），如 data/images/onebot_xxx/abc123.jpg',
            },
            description: { type: 'string', description: '图片描述文字' },
            session_id: {
              type: 'string',
              description: '图片所在的会话 ID。可选；不填时使用当前会话。',
            },
          },
          required: ['image_ref', 'description'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const imageRef = normalizeImageRef(String(args.image_ref));
      const desc = String(args.description);
      const sessionId =
        typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : callCtx.sessionId;

      const memory = ctx.getService<MemoryService>('memory');
      if (!memory?.updateMessageContent) {
        return JSON.stringify({ error: '记忆服务不可用或不支持内容更新' });
      }

      const newText = `[图片: ${desc} | ref:${imageRef}]`;
      const history = memory.getFullHistory
        ? await memory.getFullHistory(sessionId, 200)
        : await memory.getHistory(sessionId, 200);
      const oldTexts = findImageDescriptionTokens(history, imageRef);
      if (oldTexts.length === 0) oldTexts.push(`[图片 | ref:${imageRef}]`);

      let updated = 0;
      for (const oldText of oldTexts) {
        if (oldText === newText) continue;
        updated += await memory.updateMessageContent(sessionId, oldText, newText, 200);
      }
      return updated > 0
        ? `已更新 ${updated} 条消息中的图片描述`
        : `未找到匹配的图片引用（session=${sessionId}，可能引用路径不匹配或描述已相同）`;
    },
  });
}
