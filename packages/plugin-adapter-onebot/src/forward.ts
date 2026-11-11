/**
 * 合并转发（forward）展开、图片识别，与信封、给界面的事实的构造。
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
 * 本模块仅做"纯逻辑"，不碰任何服务；适配器通过依赖注入提供
 * fetchForward / resolveMedia 两个能力函数。
 */

import type { ForwardedChat, ForwardFacts } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';
import type { OneBotMessageSegment, RenderedPart } from './types.js';
import {
  collectForwardSegments,
  escapeMarkup,
  getForwardNodes,
  joinRendered,
  parseCqMessageToSegments,
  segmentSource,
} from './types.js';

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
  /** 没列出的参与人数（多于 8 个时）；都列出了时没有 */
  unlisted?: number;
  /** 完整渲染文本（用于缓存 / 工具回看 / 摘要输入） */
  fullText: string;
  /** 嵌套转发是否被截断（命中深度上限） */
  truncatedDepth: boolean;
  /** 是否有节点被截断（命中 maxNodesPerLevel） */
  truncatedNodes: boolean;
  /** 遇到的嵌套转发的 id（含超过深度没展开、获取失败的：原文里写着它们的 id），按遇到的先后 */
  nested: string[];
}

/** 转发内待识别的媒体项。walk 阶段只登记任务并在行文本里放 token，不做任何模型等待。 */
export interface ForwardMediaTask {
  /** 行文本中的占位 token（NUL 包裹，聊天文本不可能撞上），解析完成后被替换 */
  token: string;
  kind: 'image' | 'audio' | 'video';
  /** 来源：媒体段 url 里的网址或 base64 的 data URL（见 segmentSource） */
  src: string;
}

export interface ForwardExpandOptions {
  /** 抓取一个 forward id 的原始数据（成功则返回 OneBot 返回的 data） */
  fetchForward: (id: string) => Promise<unknown | null>;
  /**
   * 两阶段媒体解析：结构遍历（含嵌套抓取）完成后，把收集到的全部任务一次性交给
   * resolveMedia，由注入方决定下载与识别的并发、上限与降级。返回 token→描述；
   * 缺席或 undefined 的 token 渲染为占位符。缺省时全部媒体按占位符渲染。
   *
   * 之所以不做「遍历中内联识别」：节点串行渲染会把「取媒体源」排到前面所有识别
   * 之后——QQ 媒体 URL 的 rkey 短时效，排到即已过期（实测 61 图连环 400 的风暴）。
   * 遍历与识别解耦后，注入方能在展开瞬间趁 URL 新鲜先落盘。
   */
  resolveMedia?: (tasks: ForwardMediaTask[]) => Promise<Map<string, string | undefined>>;
  /** 嵌套展开深度上限（顶层为 1） */
  maxDepth: number;
  /** 单层节点数上限 */
  maxNodesPerLevel: number;
  /** 是否启用图片识别（音频、视频识别随 resolveMedia 在场而启用） */
  imageRecognitionEnabled: boolean;
}

/** 各媒体类的占位符与识别成功时的包装 */
const MEDIA_LABEL: Record<ForwardMediaTask['kind'], { placeholder: string; prefix: string; suffix: string }> = {
  image: { placeholder: '[图片]', prefix: '[图片: ', suffix: ']' },
  audio: { placeholder: '[语音]', prefix: '[语音: ', suffix: ']' },
  video: { placeholder: '[视频]', prefix: '[视频: ', suffix: ']' },
};

/**
 * 剥除 NUL：媒体 token 用 NUL 做哨兵，所有进入行文本的外部字符串（CQ 串、text 段、
 * at/face/share/未知段、昵称、发送者 id、forward 段 id、系统行里的转发 id）都必须过这道——
 * 剥掉后消息内容无法伪造/搬运 token（NUL 经 JSON \u0000 转义可达，非理论面）。
 */
function stripNul(s: string): string {
  return s.includes('\u0000') ? s.split('\u0000').join('') : s;
}

/** 媒体任务收集器：登记任务返回 token；该类未启用或无源时直接返回占位符。 */
type MediaCollector = (kind: ForwardMediaTask['kind'], src: string) => string;

/**
 * 渲染一个节点的消息段为纯文本。用户写的字（文字段、分享标题）与入站正文一样转义（相邻的文字段连成串再转义），手打的标记
 * 不算标记。媒体段（图片/语音/视频）经收集器登记为待识别任务并放 token——本函数是纯结构渲染，
 * 不发生任何网络/模型等待，保证 walk 快速完成、媒体源被尽早收集。
 */
function renderNodeContent(segments: OneBotMessageSegment[], collect: MediaCollector): string {
  const parts: RenderedPart[] = [];
  for (const seg of segments) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text':
        parts.push({ user: stripNul(String(data.text ?? '')) });
        break;
      case 'at': {
        const qq = stripNul(String(data.qq ?? ''));
        parts.push(data.qq === 'all' ? '<at>all</at>' : `<at id="${qq}">${qq}</at>`);
        break;
      }
      case 'face':
        parts.push(`[表情:${stripNul(String(data.id ?? ''))}]`);
        break;
      case 'image':
        parts.push(collect('image', segmentSource(data.url)));
        break;
      case 'reply':
        break;
      case 'forward':
        // 带 id 的嵌套转发由 walk 按这一段在本节点之后展开（取法同 collectForwardSegments）
        parts.push(data.id != null && String(data.id) ? '[展开见下]' : '[合并转发]');
        break;
      case 'record':
        parts.push(collect('audio', segmentSource(data.url)));
        break;
      case 'video':
        parts.push(collect('video', segmentSource(data.url)));
        break;
      case 'share':
        parts.push(`[分享:${escapeMarkup(stripNul(String(data.title ?? '')))}]`);
        break;
      case 'json':
        parts.push('[JSON卡片]');
        break;
      case 'xml':
        parts.push('[XML卡片]');
        break;
      default:
        if (seg.type) parts.push(`[${stripNul(seg.type)}]`);
    }
  }
  return joinRendered(parts);
}

interface NodeMeta {
  nickname: string;
  userId?: string;
  /** 节点内容的消息段：CQ 码字符串先规范化成段（文本段已做 CQ 反转义），与段数组走同一条渲染路径 */
  segments: OneBotMessageSegment[];
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

  const nickname = escapeMarkup(
    stripNul(String(data.nickname ?? sender?.nickname ?? data.name ?? data.user_id ?? sender?.user_id ?? '匿名')),
  );
  const userIdRaw = data.user_id ?? data.uin ?? sender?.user_id;
  const userId = userIdRaw != null ? stripNul(String(userIdRaw)) : undefined;
  const content = data.content ?? node.content ?? data.message ?? node.message;
  const segments =
    typeof content === 'string'
      ? parseCqMessageToSegments(stripNul(content))
      : Array.isArray(content)
        ? content.filter((seg): seg is OneBotMessageSegment => !!seg && typeof seg === 'object')
        : [];

  return { nickname, userId, segments };
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

  // 媒体两阶段：walk 只登记任务放 token，遍历完成后统一交 resolveMedia 再回填。
  const tasks: ForwardMediaTask[] = [];
  const kindEnabled: Record<ForwardMediaTask['kind'], boolean> = {
    image: opts.imageRecognitionEnabled && !!opts.resolveMedia,
    audio: !!opts.resolveMedia,
    video: !!opts.resolveMedia,
  };
  const collect: MediaCollector = (kind, src) => {
    if (!src || !kindEnabled[kind]) return MEDIA_LABEL[kind].placeholder;
    const token = `\u0000M${tasks.length}\u0000`;
    tasks.push({ token, kind, src });
    return token;
  };

  async function walk(id: string, nodesInput: unknown[] | null, depth: number): Promise<void> {
    if (depth > opts.maxDepth) {
      truncatedDepth = true;
      lines.push({
        depth,
        index: 0,
        nickname: '系统',
        text: `[嵌套合并转发 id=${stripNul(id)} 已超过深度上限，未展开]`,
      });
      return;
    }

    let nodes = nodesInput;
    if (!nodes || nodes.length === 0) {
      const data = await opts.fetchForward(id);
      if (!data) {
        lines.push({ depth, index: 0, nickname: '系统', text: `[嵌套合并转发 id=${stripNul(id)} 拉取失败]` });
        return;
      }
      nodes = getForwardNodes(data);
      if (nodes.length === 0) {
        lines.push({ depth, index: 0, nickname: '系统', text: `[嵌套合并转发 id=${stripNul(id)} 内容为空]` });
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

      const rendered = renderNodeContent(meta.segments, collect);
      lines.push({
        depth,
        index: i + 1,
        nickname: meta.nickname,
        userId: meta.userId,
        text: rendered,
      });

      // 嵌套转发只认本节点内容里的 forward 段（节点自带的 inline content 优先于网络抓取），节点文字不扫
      for (const child of collectForwardSegments(meta.segments)) {
        const childId = stripNul(child.id);
        if (visited.has(childId)) {
          // 防环
          continue;
        }
        visited.add(childId);
        await walk(childId, child.inlineNodes ?? null, depth + 1);
      }
    }
  }

  await walk(topId, topNodes, 1);

  // 媒体解析回填：遍历已完成、全部任务在手，一次性交给注入方（下载先行、识别受限并发）。
  // resolveMedia 整体失败按「全部未识别」处理，占位符兜底，不让展开本身失败。
  if (tasks.length > 0) {
    let resolved = new Map<string, string | undefined>();
    if (opts.resolveMedia) {
      try {
        // 返回值形态失约（非 Map）与抛错同罪同罚：占位符兜底，不让展开失败
        const r = await opts.resolveMedia(tasks);
        if (r instanceof Map) resolved = r;
      } catch {
        resolved = new Map();
      }
    }
    const byToken = new Map(tasks.map(t => [t.token, t] as const));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL 是刻意选的 token 哨兵；输入文本已在渲染时剥 NUL，仅我方 token 含之
    const tokenRe = /\u0000M\d+\u0000/g;
    for (const ln of lines) {
      if (!ln.text.includes('\u0000')) continue;
      ln.text = ln.text.replace(tokenRe, tok => {
        const task = byToken.get(tok);
        if (!task) return '';
        // 描述是识别模型写的字（图上写着什么就可能写出什么），与用户写的字同样转义
        const desc = resolved.get(tok)?.trim();
        const label = MEDIA_LABEL[task.kind];
        return desc ? `${label.prefix}${escapeMarkup(desc)}${label.suffix}` : label.placeholder;
      });
    }
  }

  // 拼接 fullText
  const indent = (d: number) => '  '.repeat(Math.max(0, d - 1));
  const fullLines = lines.map(ln => {
    const prefix = ln.userId ? `${ln.nickname}(${ln.userId})` : ln.nickname;
    const text = ln.text.trim() || '[空消息]';
    return `${indent(ln.depth)}${ln.index}. ${prefix}: ${text}`;
  });

  const allParticipants = [...participants.entries()];
  const unlisted = allParticipants.length - 8;

  return {
    id: topId,
    count: topCount,
    participants: allParticipants.slice(0, 8).map(([uid, nick]) => (uid === nick ? nick : `${nick}(${uid})`)),
    ...(unlisted > 0 ? { unlisted } : {}),
    fullText: fullLines.join('\n'),
    truncatedDepth,
    truncatedNodes,
    nested: [...visited].slice(1),
  };
}

/** 参与人给模型看的写法：前 8 个用「, 」连起来，有没列出的人时末尾接人数 */
export function participantsForModel({
  participants,
  unlisted,
}: Pick<ExpandedForward, 'participants' | 'unlisted'>): string {
  return [...participants, ...(unlisted ? [`...(+${unlisted} 人未列出)`] : [])].join(', ');
}

/**
 * 一段展开交出的转发：给界面的事实与给模型的信封出自同一份事实，信封的写法逐字不变（存档正文因此不变）。有摘要时文字是摘要，
 * 摘要是模型写的字，与用户写的字同样转义；没有时是截到 600 字的原文。「摘要：」、没列出的人数与截断说明是给模型的字，只在信封里
 */
export function forwardedChat(expanded: ExpandedForward, summary: string | null): ForwardedChat {
  const summarized = summary?.trim();
  // 代理安全截断：信封随消息归档、进 agent 与 Laya 的请求，截在 emoji 中间留下的孤代理会让严格的 JSON 解析器或分词器拒收
  const text = summarized ? escapeMarkup(summarized) : truncateChars(expanded.fullText, 600);
  const cutOff = !summarized && text.length < expanded.fullText.length;
  const facts: ForwardFacts = {
    count: expanded.count,
    participants: expanded.participants,
    ...(expanded.unlisted ? { unlisted: expanded.unlisted } : {}),
    text,
    ...(cutOff ? { cutOff: true as const } : {}),
  };
  const meta = `count=${expanded.count} participants="${participantsForModel(expanded)}"${expanded.truncatedDepth ? ' truncatedDepth' : ''}${expanded.truncatedNodes ? ' truncatedNodes' : ''}`;
  const body = summarized ? `摘要：${text}` : cutOff ? `${text}\n…（已截断，原文保留在缓存中）` : text;
  return { id: expanded.id, content: `<forward id="${expanded.id}" ${meta}>\n${body}\n</forward>`, facts };
}
