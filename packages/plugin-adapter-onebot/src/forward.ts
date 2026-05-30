/**
 * 合并转发（forward）展开、图片识别与摘要生成。
 *
 * 设计目标：让 agent 处理合并转发更接近"人类阅读"的方式：
 * - 进入对话上下文 / 历史归档的是一份摘要（信封），而非整块原文，
 *   避免长转发淹没真正对话；
 * - 内部图片走 media 服务转写为文字描述，保证多模态信息
 *   不在摘要里丢失；
 * - 嵌套转发递归展开（带深度上限与已访问 id 集合防环），让摘要能反映
 *   多层结构；
 * - 完整原文仍保留在缓存与 memory metadata 中，agent 想看细节时通过
 *   onebot_get_forward_msg 工具 / 缓存命中拿回。
 *
 * 本模块仅做"纯逻辑"，不直接依赖 Context；适配器通过依赖注入提供
 * fetchForward / recognizeImage / summarize 三个能力函数。
 */

import type { OneBotMessageSegment } from './types.js';
import { getForwardNodes } from './types.js';

/** 单个转发节点的扁平表示 */
export interface ForwardLine {
  /** 缩进层级（顶层=0，嵌套+1） */
  depth: number;
  index: number;
  nickname: string;
  userId?: string;
  /** 已替换图片为 [图片: 描述] / [图片] 的纯文本 */
  text: string;
}

export interface ExpandedForward {
  /** forward id */
  id: string;
  /** 顶层节点条数（嵌套不计入） */
  count: number;
  /** 去重后的参与人列表（昵称(uid) 形式，最多前 8 个） */
  participants: string[];
  /** 完整渲染文本（用于缓存 / 工具回看 / 摘要输入） */
  fullText: string;
  /** 嵌套转发是否被截断（命中深度上限） */
  truncatedDepth: boolean;
  /** 是否有节点被截断（命中 maxNodesPerLevel） */
  truncatedNodes: boolean;
}

export interface ForwardExpandOptions {
  /** 抓取一个 forward id 的原始数据（成功则返回 OneBot 返回的 data） */
  fetchForward: (id: string) => Promise<unknown | null>;
  /** 把图片源转为文字描述（不可用则可返回 undefined） */
  recognizeImage?: (source: string) => Promise<string | undefined>;
  /** 把音频源（record 段）转为文字（转写或描述） */
  recognizeAudio?: (source: string) => Promise<string | undefined>;
  /** 把视频源转为文字描述（抽帧+音轨综合） */
  recognizeVideo?: (source: string) => Promise<string | undefined>;
  /** 嵌套展开深度上限（顶层为 1） */
  maxDepth: number;
  /** 单层节点数上限 */
  maxNodesPerLevel: number;
  /** 是否启用图片识别 */
  imageRecognitionEnabled: boolean;
  /** 是否启用音频识别（默认随 recognizeAudio 是否提供） */
  audioRecognitionEnabled?: boolean;
  /** 是否启用视频识别（默认随 recognizeVideo 是否提供） */
  videoRecognitionEnabled?: boolean;
}

/**
 * 把 CQ 字符串里 [CQ:<kind>,...] 段替换为识别结果（或 fallback 占位）。
 */
async function replaceCqWithRecognizer(
  text: string,
  kind: string,
  fallback: string,
  successPrefix: string,
  successSuffix: string,
  recognizer: ((src: string) => Promise<string | undefined>) | undefined,
): Promise<string> {
  const re = new RegExp(`\\[CQ:${kind}(,[^\\]]+)?\\]`, 'g');
  if (!recognizer) return text.replace(re, fallback);
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return text;
  const replacements = await Promise.all(
    matches.map(async m => {
      const params: Record<string, string> = {};
      const body = m[1] ?? '';
      for (const part of body.replace(/^,/, '').split(',')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        params[part.slice(0, eq)] = part
          .slice(eq + 1)
          .replace(/&amp;/g, '&')
          .replace(/&#91;/g, '[')
          .replace(/&#93;/g, ']')
          .replace(/&#44;/g, ',');
      }
      const src = params.url || params.file;
      if (!src) return { raw: m[0], rendered: fallback };
      try {
        const desc = await recognizer(src);
        return { raw: m[0], rendered: desc ? `${successPrefix}${desc}${successSuffix}` : fallback };
      } catch {
        return { raw: m[0], rendered: fallback };
      }
    }),
  );
  let out = text;
  for (const r of replacements) out = out.replace(r.raw, r.rendered);
  return out;
}

/** 渲染一个节点 content（消息段数组或 CQ 字符串）为纯文本，并把图片换成识别后描述。 */
async function renderNodeContent(content: unknown, opts: ForwardExpandOptions): Promise<string> {
  if (typeof content === 'string') {
    // CQ 码字符串：用正则替换 image / face / at / reply
    let out = content;
    if (opts.imageRecognitionEnabled && opts.recognizeImage) {
      // [CQ:image,file=...,url=...]
      const matches = [...out.matchAll(/\[CQ:image,([^\]]+)\]/g)];
      const replacements = await Promise.all(
        matches.map(async m => {
          const params: Record<string, string> = {};
          for (const part of m[1].split(',')) {
            const eq = part.indexOf('=');
            if (eq <= 0) continue;
            params[part.slice(0, eq)] = part
              .slice(eq + 1)
              .replace(/&amp;/g, '&')
              .replace(/&#91;/g, '[')
              .replace(/&#93;/g, ']')
              .replace(/&#44;/g, ',');
          }
          const src = params.url || params.file;
          if (!src) return { raw: m[0], rendered: '[图片]' };
          try {
            const desc = await opts.recognizeImage!(src);
            return { raw: m[0], rendered: desc ? `[图片: ${desc}]` : '[图片]' };
          } catch {
            return { raw: m[0], rendered: '[图片]' };
          }
        }),
      );
      for (const r of replacements) out = out.replace(r.raw, r.rendered);
    } else {
      out = out.replace(/\[CQ:image[^\]]*\]/g, '[图片]');
    }
    // record / video CQ 段：参数里取 url/file，调对应识别回调
    out = await replaceCqWithRecognizer(
      out,
      'record',
      '[语音]',
      '[语音: ',
      ']',
      opts.audioRecognitionEnabled !== false ? opts.recognizeAudio : undefined,
    );
    out = await replaceCqWithRecognizer(
      out,
      'video',
      '[视频]',
      '[视频: ',
      ']',
      opts.videoRecognitionEnabled !== false ? opts.recognizeVideo : undefined,
    );
    return out
      .replace(/\[CQ:face,[^\]]*id=(\d+)[^\]]*\]/g, '[表情:$1]')
      .replace(/\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]/g, '<at id="$1">$1</at>')
      .replace(/\[CQ:reply[^\]]*\]/g, '')
      .replace(/\[CQ:[a-z]+[^\]]*\]/g, '');
  }

  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const seg of content) {
    if (!seg || typeof seg !== 'object') continue;
    const s = seg as { type?: string; data?: Record<string, unknown> };
    const data = s.data ?? {};
    switch (s.type) {
      case 'text':
        parts.push(String(data.text ?? ''));
        break;
      case 'at':
        parts.push(
          data.qq === 'all' ? '<at>all</at>' : `<at id="${String(data.qq ?? '')}">${String(data.qq ?? '')}</at>`,
        );
        break;
      case 'face':
        parts.push(`[表情:${String(data.id ?? '')}]`);
        break;
      case 'image': {
        const src = (data.url ?? data.file) as string | undefined;
        if (opts.imageRecognitionEnabled && opts.recognizeImage && src) {
          try {
            const desc = await opts.recognizeImage(src);
            parts.push(desc ? `[图片: ${desc}]` : '[图片]');
          } catch {
            parts.push('[图片]');
          }
        } else {
          parts.push('[图片]');
        }
        break;
      }
      case 'reply':
        break;
      case 'forward':
        // 嵌套占位符，递归展开会在外层处理；这里先放标记，外层 expand 用 inline content 优先
        parts.push(data.id ? `<<<NESTED_FORWARD:${String(data.id)}>>>` : '[合并转发]');
        break;
      case 'record': {
        const src = (data.url ?? data.file) as string | undefined;
        if (opts.audioRecognitionEnabled !== false && opts.recognizeAudio && src) {
          try {
            const text = await opts.recognizeAudio(src);
            parts.push(text ? `[语音: ${text}]` : '[语音]');
          } catch {
            parts.push('[语音]');
          }
        } else {
          parts.push('[语音]');
        }
        break;
      }
      case 'video': {
        const src = (data.url ?? data.file) as string | undefined;
        if (opts.videoRecognitionEnabled !== false && opts.recognizeVideo && src) {
          try {
            const text = await opts.recognizeVideo(src);
            parts.push(text ? `[视频: ${text}]` : '[视频]');
          } catch {
            parts.push('[视频]');
          }
        } else {
          parts.push('[视频]');
        }
        break;
      }
      case 'share':
        parts.push(`[分享:${String(data.title ?? '')}]`);
        break;
      case 'json':
        parts.push('[JSON卡片]');
        break;
      case 'xml':
        parts.push('[XML卡片]');
        break;
      default:
        if (s.type) parts.push(`[${s.type}]`);
    }
  }
  return parts.join('');
}

/** 从 forward 节点 item 中提取 inline content（部分 OneBot 实现自带） */
function getInlineNodes(seg: OneBotMessageSegment): unknown[] | null {
  if (seg.type !== 'forward') return null;
  const nodes = getForwardNodes(seg.data ?? {});
  return nodes.length > 0 ? nodes : null;
}

interface NodeMeta {
  nickname: string;
  userId?: string;
  content: unknown;
  /** 节点自带的内嵌 forward inline content（按 forward id 索引），优先于网络抓取 */
  inlineNested: Map<string, unknown[]>;
}

function extractNodeMeta(item: unknown): NodeMeta {
  const node = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  const data = (node.type === 'node' && node.data && typeof node.data === 'object' ? node.data : node) as Record<
    string,
    unknown
  >;
  const sender = (node.sender && typeof node.sender === 'object' ? node.sender : undefined) as
    | Record<string, unknown>
    | undefined;

  const nickname = String(data.nickname ?? sender?.nickname ?? data.name ?? data.user_id ?? sender?.user_id ?? '匿名');
  const userIdRaw = data.user_id ?? data.uin ?? sender?.user_id;
  const userId = userIdRaw != null ? String(userIdRaw) : undefined;
  const content = data.content ?? node.content ?? data.message ?? node.message;

  // 收集本节点内 forward 段自带的 inline content
  const inlineNested = new Map<string, unknown[]>();
  if (Array.isArray(content)) {
    for (const seg of content) {
      if (!seg || typeof seg !== 'object') continue;
      const s = seg as OneBotMessageSegment;
      const nested = getInlineNodes(s);
      if (nested) {
        const fid = s.data?.id != null ? String(s.data.id) : '';
        if (fid) inlineNested.set(fid, nested);
      }
    }
  }

  return { nickname, userId, content, inlineNested };
}

/**
 * 递归展开一个 forward。返回扁平行（含 depth）便于直接拼接文本。
 *
 * @param topId 顶层 forward id
 * @param topNodes 顶层节点数组（如果调用方已抓到了，可直接传入；否则将通过 fetchForward 抓取）
 */
export async function expandForward(
  topId: string,
  topNodes: unknown[] | null,
  opts: ForwardExpandOptions,
): Promise<ExpandedForward> {
  const visited = new Set<string>([topId]);
  const lines: ForwardLine[] = [];
  const participants = new Map<string, string>(); // userId -> nickname
  let truncatedDepth = false;
  let truncatedNodes = false;
  let topCount = 0;

  async function walk(id: string, nodesInput: unknown[] | null, depth: number): Promise<void> {
    if (depth > opts.maxDepth) {
      truncatedDepth = true;
      lines.push({ depth, index: 0, nickname: '系统', text: `[嵌套合并转发 id=${id} 已超过深度上限，未展开]` });
      return;
    }

    let nodes = nodesInput;
    if (!nodes || nodes.length === 0) {
      const data = await opts.fetchForward(id);
      if (!data) {
        lines.push({ depth, index: 0, nickname: '系统', text: `[嵌套合并转发 id=${id} 拉取失败]` });
        return;
      }
      nodes = getForwardNodes(data);
      if (nodes.length === 0) {
        lines.push({ depth, index: 0, nickname: '系统', text: `[嵌套合并转发 id=${id} 内容为空]` });
        return;
      }
    }

    if (depth === 1) topCount = nodes.length;

    const slice = nodes.slice(0, opts.maxNodesPerLevel);
    if (slice.length < nodes.length) truncatedNodes = true;

    for (let i = 0; i < slice.length; i++) {
      const meta = extractNodeMeta(slice[i]);
      if (meta.userId) {
        participants.set(meta.userId, meta.nickname);
      } else {
        participants.set(meta.nickname, meta.nickname);
      }

      const rendered = await renderNodeContent(meta.content, opts);
      lines.push({
        depth,
        index: i + 1,
        nickname: meta.nickname,
        userId: meta.userId,
        text: rendered,
      });

      // 处理本节点中可能的嵌套 forward 占位符
      const placeholderRe = /<<<NESTED_FORWARD:([^>]+)>>>/g;
      const matches = [...rendered.matchAll(placeholderRe)];
      for (const m of matches) {
        const childId = m[1];
        if (visited.has(childId)) {
          // 防环
          continue;
        }
        visited.add(childId);
        const inline = meta.inlineNested.get(childId);
        await walk(childId, inline ?? null, depth + 1);
      }
    }
  }

  await walk(topId, topNodes, 1);

  // 拼接 fullText
  const indent = (d: number) => '  '.repeat(Math.max(0, d - 1));
  const fullLines = lines.map(ln => {
    const prefix = ln.userId ? `${ln.nickname}(${ln.userId})` : ln.nickname;
    const text = ln.text.replace(/<<<NESTED_FORWARD:[^>]+>>>/g, '[展开见下]').trim() || '[空消息]';
    return `${indent(ln.depth)}${ln.index}. ${prefix}: ${text}`;
  });

  const allParticipants = [...participants.entries()];
  const participantList = allParticipants.slice(0, 8).map(([uid, nick]) => {
    return uid === nick ? nick : `${nick}(${uid})`;
  });
  if (allParticipants.length > 8) {
    participantList.push(`...(+${allParticipants.length - 8} 人未列出)`);
  }

  return {
    id: topId,
    count: topCount,
    participants: participantList,
    fullText: fullLines.join('\n'),
    truncatedDepth,
    truncatedNodes,
  };
}

// ===== 摘要 =====

export interface SummarizeOptions {
  /** 调用 LLM 生成摘要（输入完整 forward 文本，输出摘要文本）。返回 null 表示不生成。 */
  summarize?: (text: string, hint: { count: number; participants: string[] }) => Promise<string | null>;
  /** 摘要不可用 / 失败时的回退渲染：把完整文本截断为信封。 */
  fallbackFullTextMaxChars: number;
}

/** 把展开结果包装成最终注入到 event.text 的"信封文本"。 */
export function buildEnvelope(expanded: ExpandedForward, summary: string | null, truncatedFallbackChars = 600): string {
  const meta = `count=${expanded.count} participants="${expanded.participants.join(', ')}"${expanded.truncatedDepth ? ' truncatedDepth' : ''}${expanded.truncatedNodes ? ' truncatedNodes' : ''}`;

  if (summary?.trim()) {
    return `<forward id="${expanded.id}" ${meta}>\n摘要：${summary.trim()}\n</forward>`;
  }

  // 摘要不可用：信封内退化到截断的原文
  const text =
    expanded.fullText.length > truncatedFallbackChars
      ? `${expanded.fullText.slice(0, truncatedFallbackChars)}\n…（已截断，原文保留在缓存中）`
      : expanded.fullText;
  return `<forward id="${expanded.id}" ${meta}>\n${text}\n</forward>`;
}
