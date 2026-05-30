// ============================================================
// tools.ts — analyze_image / update_image_description 工具
//
// 由 plugin-image-recognition 移植而来。让 agent 主动分析任意图片
// （本地路径 / URL / data URI），以及把识别结果写回历史消息。
// ============================================================

import type { Context } from '@aalis/core';
import type { MediaService } from '@aalis/plugin-media-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import {
  AttachmentRefKind,
  buildAttachmentRefMatcher,
  formatAttachmentRef,
  type Message,
} from '@aalis/plugin-message-api';
import { useToolService } from '@aalis/plugin-tools-api';
import { fileToDataUri } from './ffmpeg.js';
import { getMediaRuntime } from './runtime.js';

/**
 * 把 agent 传入的图片路径规整为 storage URI。
 *
 * 支持：
 * - `[图片: desc | ref:xxx]` 占位符 — 提取 ref 后递归解析
 * - 已是 storage URI：`workspace:/foo`、`data:/images/x.jpg` — 原样返回
 * - 裸名以已知 storage root 开头：`data/images/x.jpg`、`tmp/y.png` —
 *   按首段路由到对应根（修复了 agent 传 `data/images/...` 被错误塞进 workspace 的问题）
 * - 其它相对路径：归到 `workspace:/`（默认）
 */
function resolveImageStorageUri(input: string): string {
  // [图片(: desc)? | ref:xxx] 占位符 → 提取 ref 后递归
  const refMatch = input.match(/\|\s*ref:([^\]\n]+)\]/);
  if (refMatch) return resolveImageStorageUri(refMatch[1].trim());
  const cleaned = input.replace(/^\.?\/+/, '');
  if (cleaned.includes(':/')) return cleaned;
  const firstSeg = cleaned.split('/', 1)[0];
  if (firstSeg) {
    try {
      const { storage } = getMediaRuntime();
      const rootNames = new Set(storage.listRoots().map(r => r.name));
      if (rootNames.has(firstSeg)) {
        const rest = cleaned.slice(firstSeg.length + 1);
        return `${firstSeg}:/${rest}`;
      }
    } catch {
      // runtime 未注入 / listRoots 报错时回退到 workspace 默认
    }
  }
  return `workspace:/${cleaned}`;
}

function normalizeImageRef(input: string): string {
  return input.trim().replace(/^ref:/, '');
}

/** 在历史消息中找到所有 [图片(: ...)? | ref:xxx] 占位符。 */
function findImageDescriptionTokens(messages: Message[], imageRef: string): string[] {
  const tokenPattern = buildAttachmentRefMatcher(AttachmentRefKind.Image, normalizeImageRef(imageRef));
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
          '支持自定义提示词，例如：「提取图中所有文字」「描述 UI 布局」「找到按钮位置」等。\n' +
          '\n' +
          '**关于 detail_level（详略级别）**：\n' +
          '- `auto`（默认）：自动判断图片类型选择详略，未知类一律按详细处理\n' +
          '- `casual`：简洁日常描述（200 字以内、识别梗/游戏标志），适合聊天截图、表情包、生活照\n' +
          '- `detailed`：详细 OCR 描述（不限字数、逐项列出、含 LaTeX 公式），**强烈建议数学题/物理题/代码截图/表格/试卷/PPT/含密集文字的图片显式传 detailed**\n' +
          '\n' +
          '**关于 prompt（自定义提示词）**：\n' +
          '对数学/代码/文档/表格类图片，建议你的 prompt 明确写「请逐题列出每道题与所有选项」「请用 LaTeX 抄录所有公式」' +
          '「请逐行抄录代码并保留缩进」「请把表格按 Markdown 格式列出」等具体要求，避免笼统的「分析这张图」。',
        parameters: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description:
                '图片来源：本地路径（如 workspace/.tmp/screenshots/xxx.png、data/images/onebot_xxx/xxx.jpg）、' +
                'storage URI（如 data:/images/...、workspace:/.tmp/x.png）或网络 URL。' +
                '裸相对路径会按首段匹配 storage 根（如 data/、workspace/、tmp/），未命中时归到 workspace:/ 下。',
            },
            prompt: { type: 'string', description: '分析提示词（可选）。数学/代码/表格类务必写明具体要求。' },
            task: { type: 'string', description: '本次分析需求（可选）。' },
            context: { type: 'string', description: '补充上下文（可选）。' },
            detail_level: {
              type: 'string',
              enum: ['auto', 'casual', 'detailed'],
              description:
                '详略级别。默认 auto（自动判断）；对试卷/数学题/代码/表格/PPT/含密集文字的图片，显式传 detailed 以确保信息完整。',
            },
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
        const detailLevelRaw = (args.detail_level as string) || undefined;
        const detailLevel: 'auto' | 'casual' | 'detailed' | undefined =
          detailLevelRaw === 'casual' || detailLevelRaw === 'detailed' || detailLevelRaw === 'auto'
            ? detailLevelRaw
            : undefined;
        const hint = [
          task ? `用户需求: ${task}` : '',
          !task && customPrompt ? `分析提示词: ${customPrompt}` : '',
          extraContext ? `补充上下文: ${extraContext}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        let imageUrl: string;
        const localPath: string | undefined = undefined;
        if (imageInput.startsWith('http://') || imageInput.startsWith('https://') || imageInput.startsWith('data:')) {
          imageUrl = imageInput;
        } else {
          const uri = resolveImageStorageUri(imageInput);
          imageUrl = await fileToDataUri(uri);
        }

        const desc = await svc.describeImage(imageUrl, { hint, localPath, detailLevel });
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

      const newText = formatAttachmentRef({ kind: AttachmentRefKind.Image, desc, ref: imageRef });
      const history = memory.getFullHistory
        ? await memory.getFullHistory(sessionId, 200)
        : await memory.getHistory(sessionId, 200);
      const oldTexts = findImageDescriptionTokens(history, imageRef);
      if (oldTexts.length === 0) oldTexts.push(formatAttachmentRef({ kind: AttachmentRefKind.Image, ref: imageRef }));

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
