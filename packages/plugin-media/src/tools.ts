// ============================================================
// tools.ts — analyze_image / update_image_description 工具
//
// 由 plugin-image-recognition 移植而来。让 agent 主动分析任意图片
// （本地路径 / URL / data URI），以及把识别结果写回历史消息。
// ============================================================

import type { MemoryService } from '@aalis/api-memory';
import type { BoundTools } from '@aalis/api-tools';
import type { ServiceRef } from '@aalis/core';
import { AttachmentRefKind, buildAttachmentRefMatcher, formatAttachmentRef, type Message } from '@aalis/schema-message';
import { fileToDataUri } from './ffmpeg.js';
import { getMediaRuntime } from './runtime.js';
import { safeDownloadToTemp } from './safe-fetch.js';
import type { MediaServiceImpl } from './service.js';

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

/** 工具登记用到的能力：登记门面 tools，以及 update_image_description 回写历史的 memory */
interface ToolsCaps {
  tools: BoundTools;
  memory: ServiceRef<MemoryService>;
}

export function registerMediaTools(caps: ToolsCaps, svc: MediaServiceImpl): void {
  const { tools } = caps;

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'analyze_image',
        description:
          '查看一张图片或动图的内容：历史消息里的 `[图片 | ref:…]` 指针、本地文件（storage URI）或网络 URL 都可以。\n' +
          '按当前配置交付：或把图片直接随结果交给你查看（此时 prompt/detail_level 不生效；若你看不到图片，请如实说明），' +
          '或返回图像识别模型的文字描述。\n' +
          '支持自定义提示词，例如：「提取图中所有文字」「描述 UI 布局」「找到按钮位置」等。\n' +
          '\n' +
          '**关于 detail_level（详略级别）**：\n' +
          '- `auto`（默认）：模型看图自判类型并按类型给相应详略（单次推理自路由）\n' +
          '- `casual`：简洁日常描述（200 字以内、识别梗/游戏标志），适合聊天截图、表情包、生活照\n' +
          '- `detailed`：详细 OCR 描述（不限字数、逐项列出、含 LaTeX 公式），**强烈建议代码截图/表格/PPT/含密集文字的图片显式传 detailed**\n' +
          '- `professional`：学科题目严格识别（逐题列题号、强 LaTeX、几何坐标验证），适合数学/物理/化学试卷与习题\n' +
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
              enum: ['auto', 'casual', 'detailed', 'professional'],
              description:
                '详略级别。默认 auto（模型自判）；代码/表格/PPT/含密集文字的图显式传 detailed，' +
                '数学/物理/化学题目显式传 professional 以获得严格 LaTeX 与几何识别。',
            },
          },
          required: ['image'],
        },
      },
    },
    handler: async (args, callCtx) => {
      try {
        const imageInput = String(args.image);
        const customPrompt = (args.prompt as string) || undefined;
        const task = (args.task as string) || undefined;
        const extraContext = (args.context as string) || undefined;
        const detailLevelRaw = (args.detail_level as string) || undefined;
        const detailLevel: 'auto' | 'casual' | 'detailed' | 'professional' | undefined =
          detailLevelRaw === 'casual' ||
          detailLevelRaw === 'detailed' ||
          detailLevelRaw === 'professional' ||
          detailLevelRaw === 'auto'
            ? detailLevelRaw
            : undefined;
        const hint = [
          task ? `用户需求: ${task}` : '',
          customPrompt ? `分析提示词: ${customPrompt}` : '',
          extraContext ? `补充上下文: ${extraContext}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        let imageUrl: string;
        if (imageInput.startsWith('http://') || imageInput.startsWith('https://') || imageInput.startsWith('data:')) {
          imageUrl = imageInput;
        } else {
          const uri = resolveImageStorageUri(imageInput);
          imageUrl = await fileToDataUri(uri);
        }

        // 主模型自己能看且调用方接得住图（agent 工具循环）：图片随工具结果交出（规范化 +
        // 动图抽帧与当轮附件同一出口），不经识别模型。mcp-server / workflow 只读 content，
        // 对它们照常走识别模型出文字。
        if (callCtx.acceptsImages && svc.resolveDelivery(callCtx.sessionId, callCtx.platform) === 'passthrough') {
          // 远端 URL 先在工具层下载并校验是图片：原样交给主请求的话，链接失效 / 不是图片会变成整轮 400，
          // 模型没有机会纠正；下载失败留在工具层返回错误，模型可换路。
          let source = imageUrl;
          let cleanup: (() => Promise<void>) | undefined;
          if (/^https?:\/\//i.test(source)) {
            const dl = await safeDownloadToTemp(source, { imageOnly: true });
            if (!dl) return JSON.stringify({ error: '图片无法下载，或目标不是图片' });
            source = `file://${dl.path}`; // 物化链认 file:// / data: / storage URI，不认裸绝对路径
            cleanup = dl.cleanup;
          } else if (source.startsWith('data:') && !/^data:image\//i.test(source)) {
            return JSON.stringify({ error: '目标不是图片（data URI 不是 image/*）' });
          }
          let images: string[];
          try {
            images = await svc.transformModelImages([source], 'passthrough');
          } finally {
            await cleanup?.();
          }
          if (images.length === 0) return JSON.stringify({ error: '图片无法读取或转换为可发送形态' });
          // content 会落库、也会在后续回合被回看：措辞对未来也成立，并带上来源便于重新查看
          return {
            content: JSON.stringify({
              ok: true,
              image: imageInput,
              note: '图片已在本回合直接呈现给你；历史中不保留图片本身，需要时按 image 引用重新查看',
            }),
            images,
          };
        }

        const desc = await svc.describeImage(imageUrl, { hint, detailLevel });
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

      const memory = caps.memory.current;
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
