// ============================================================
// tools.ts — analyze_image / update_image_description 工具
//
// 由 plugin-image-recognition 移植而来。让 agent 主动分析图片（存储地址 / URL / data URI），
// 以及把识别结果写回调用所在会话的历史消息。存储里的图先过媒体判据（@aalis/api-media 的 mediaScopeOf：别的会话的
// 按会话管理的取用规则，本机文件按这一轮的主体，多人的一轮逐个参与者判、有人过不了时发参与者审批），再读一次、按文件头认格式。
// ============================================================

import { Buffer } from 'node:buffer';
import type { AuthorityService } from '@aalis/api-authority';
import { mediaRef, mediaScopeOf } from '@aalis/api-media';
import type { MemoryService } from '@aalis/api-memory';
import type { SessionManagerService } from '@aalis/api-session-manager';
import { isHostAbsolutePath, isStorageNotFound, isStorageUri, isWebUrl } from '@aalis/api-storage';
import type { BoundTools } from '@aalis/api-tools';
import type { Events, ServiceSelection } from '@aalis/core';
import { AttachmentRefKind, buildAttachmentRefMatcher, formatAttachmentRef, type Message } from '@aalis/schema-message';
import { detectMediaFormat, FILE_HEAD_BYTES } from '@aalis/util-file-signature';
import { readSourceBytes } from './ffmpeg.js';
import { getMediaRuntime } from './runtime.js';
import type { MediaServiceImpl } from './service.js';

/** 过不了媒体判据时回给模型的话：先判后读，存储里有没有、是不是图片都回这一句 */
const OUT_OF_SCOPE =
  '这张图不在这一轮能看的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人';
/** 判媒体归属与回写图片描述回看的历史条数 */
const HISTORY_LIMIT = 200;

/**
 * 存储里没有这个文件时回给模型的话，相对路径过不了判据时也回它（不透露文件在不在）：相对路径归到了工作区，写成
 * `data/images/…` 的多半是想写存储地址
 */
const notFound = (uri: string) =>
  `找不到 ${uri}：相对路径按工作区（workspace:/）找，别处的图要写带根名的存储地址，如 data:/images/…`;

/** agent 传入的图片来源：历史里的 `[图片(: desc)? | ref:xxx]` 占位符取出其中的引用，其余取原文，都去掉首尾空白 */
function imageRefOf(input: string): string {
  const refMatch = input.match(/\|\s*ref:([^\]\n]+)\]/);
  return (refMatch ? refMatch[1] : input).trim();
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

/** 某会话最近的历史：有完整历史就取它 */
function recentHistory(service: MemoryService, sessionId: string): Promise<Message[]> {
  return service.getFullHistory
    ? service.getFullHistory(sessionId, HISTORY_LIMIT)
    : service.getHistory(sessionId, HISTORY_LIMIT);
}

/**
 * 工具登记用到的能力：登记门面 tools；update_image_description 回写历史的 memory 与发改写通知的 events；判媒体归属的会话管理、
 * 权限和记忆（缺席时判据按它的约定取值）。存储取自媒体运行时
 */
interface ToolsCaps {
  tools: ServiceSelection<BoundTools>;
  memory: ServiceSelection<MemoryService>;
  events: ServiceSelection<Events>;
  sessionManager: ServiceSelection<SessionManagerService>;
  authority: ServiceSelection<AuthorityService>;
}

export function registerMediaTools(caps: ToolsCaps, svc: MediaServiceImpl): void {
  const { tools, sessionManager, authority } = caps;

  /** 媒体判据要的服务：每次判时按一次调用交给 mediaScopeOf */
  const scopeServices = {
    sessionManager,
    authority,
    history: async (sessionId: string) => (caps.memory.present ? recentHistory(caps.memory.use, sessionId) : []),
  };

  tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: 'analyze_image',
        description:
          '查看一张图片或动图的内容：历史消息里的 `[图片 | ref:…]` 指针、本地文件（storage URI）或网络 URL 都可以。' +
          '存储里的图能看本会话收到或产生的；别的会话的按 owner 给这个会话设的取用范围与开关；' +
          '不属于任何会话的本机文件要这一轮里有 owner 的话（有别人的话一起进来时要她批），' +
          '或这一轮是按 owner 的授权自动运行的（如她建的定时任务）而所在会话里没有别人。\n' +
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
                '图片来源：历史里的 `[图片 | ref:…]` 引用、存储地址（如 data:/images/<会话目录>/<写入方>/<文件>、' +
                'tmp:/browser/...）或网络 URL。相对路径按工作区（workspace:/）找，别处的图要写带根名的存储地址。',
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
    // 本地识图模型慢时一张图可达数分钟：等多久由执行器的让出时限管，中止信号一路交给识图的模型调用
    background: {},
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

        // 只按取出的引用判一次：网址与 data URI（`data:/…` 是存储地址）直接用；相对路径与 file_* 工具一致归到 `workspace:/`，
        // 不按首段补成别的根；本机路径不收。存储里的图先判后读，整读一次、按文件头认格式与 mime
        const ref = imageRefOf(imageInput);
        let imageUrl: string;
        if (isWebUrl(ref) || (ref.startsWith('data:') && !isStorageUri(ref))) {
          imageUrl = ref;
        } else {
          const relative = !ref.includes(':/') && !isHostAbsolutePath(ref);
          const uri = mediaRef(relative ? `workspace:/${ref}` : ref);
          if (!uri || !isStorageUri(uri)) {
            return JSON.stringify({ error: '图片来源要写历史引用、存储地址或网址，不能写本机路径' });
          }
          if (!(await mediaScopeOf(callCtx, scopeServices)(uri))) {
            return JSON.stringify({ error: relative ? notFound(uri) : OUT_OF_SCOPE });
          }
          let buf: Uint8Array;
          try {
            buf = (await getMediaRuntime().storage.readFile(uri)) as Uint8Array;
          } catch (err) {
            if (!isStorageNotFound(err)) throw err;
            return JSON.stringify({ error: notFound(uri) });
          }
          const format = detectMediaFormat(buf.subarray(0, FILE_HEAD_BYTES));
          if (format?.kind !== 'image')
            return JSON.stringify({ error: '目标不是图片（文件内容不是受支持的图片格式）' });
          imageUrl = `data:${format.mime};base64,${Buffer.from(buf).toString('base64')}`;
        }

        // 这次调用的主模型能看图（acceptsImages，agent 按模型登记的能力填）且交付不是转文字：图片随工具结果交出
        // （规范化 + 动图抽帧与当轮附件同一出口），不经识别模型。不能看图的会话与只读 content 的
        // mcp-server / workflow 照常走识别模型出文字，配置强制直通也一样：结果里的图交不到模型。
        if (callCtx.acceptsImages && svc.resolveDelivery(true) === 'passthrough') {
          // 先在工具层读到字节、按文件头认是图片（data URI 写的类型不看）：原样交给主请求的话，链接失效 / 不是图片会变成
          // 整轮 400，模型没有机会纠正；读不到或不是图片留在工具层返回错误，模型可换路。网址经受保护的下载读进内存，不落临时文件
          const web = isWebUrl(imageUrl);
          const bytes = await readSourceBytes(imageUrl, callCtx.signal);
          const format = bytes && detectMediaFormat(bytes.subarray(0, FILE_HEAD_BYTES));
          if (!bytes || format?.kind !== 'image') {
            return JSON.stringify({
              error: web ? '图片无法下载，或目标不是图片' : '目标不是图片（文件内容不是受支持的图片格式）',
            });
          }
          const images = await svc.transformModelImages(
            [`data:${format.mime};base64,${Buffer.from(bytes).toString('base64')}`],
            'passthrough',
          );
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

        const desc = await svc.describeImage(imageUrl, {
          hint,
          detailLevel,
          sessionId: callCtx.sessionId,
          signal: callCtx.signal,
        });
        return JSON.stringify(desc ? { description: desc } : { error: '没有可用的视觉模型或识别失败' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: 'update_image_description',
        description:
          '更新当前会话历史消息中图片的描述。当你通过 analyze_image 识别了一张历史图片后，' +
          '调用此工具将描述写回数据库，以便未来检索。',
        parameters: {
          type: 'object',
          properties: {
            image_ref: {
              type: 'string',
              description: '图片引用（ref: 后面的部分），如 data:/images/<会话目录>/<写入方>/<文件>',
            },
            description: { type: 'string', description: '图片描述文字' },
          },
          required: ['image_ref', 'description'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const imageRef = normalizeImageRef(String(args.image_ref));
      const desc = String(args.description);
      const { sessionId } = callCtx;

      // 先读历史再改写：固定同一家
      const memory = caps.memory.list().find(p => p.selected)?.use;
      if (!memory?.updateMessageContent) {
        return JSON.stringify({ error: '记忆服务不可用或不支持内容更新' });
      }

      const newText = formatAttachmentRef({ kind: AttachmentRefKind.Image, desc, ref: imageRef });
      const history = await recentHistory(memory, sessionId);
      const oldTexts = findImageDescriptionTokens(history, imageRef);
      if (oldTexts.length === 0) oldTexts.push(formatAttachmentRef({ kind: AttachmentRefKind.Image, ref: imageRef }));

      const replaced = oldTexts.filter(oldText => oldText !== newText);
      let updated = 0;
      for (const oldText of replaced) {
        updated += await memory.updateMessageContent(sessionId, oldText, newText, HISTORY_LIMIT);
      }
      if (updated === 0) return `未找到匹配的图片引用（session=${sessionId}，可能引用路径不匹配或描述已相同）`;
      // 改写通知带改写后的整条：按改写前读到的这段历史、同一替换算出（更早的消息改到了也不在其中）
      const rewritten = history.flatMap(message => {
        const content = replaced.reduce((text, oldText) => text.replaceAll(oldText, newText), message.content ?? '');
        return content === (message.content ?? '') ? [] : [{ ...message, content }];
      });
      if (rewritten.length > 0) {
        await caps.events.use.emit('memory:messages-rewritten', { sessionId, messages: rewritten });
      }
      return `已更新 ${updated} 条消息中的图片描述`;
    },
  });
}
