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
 * fetchForward / resolveMedia / summarize 三个能力函数。
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

/** 转发内待识别的媒体项。walk 阶段只登记任务并在行文本里放 token，不做任何模型等待。 */
export interface ForwardMediaTask {
  /** 行文本中的占位 token（NUL 包裹，聊天文本不可能撞上），解析完成后被替换 */
  token: string;
  kind: 'image' | 'audio' | 'video';
  /** 原始来源（URL / file / base64） */
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
  /** 是否启用图片识别 */
  imageRecognitionEnabled: boolean;
  /** 是否启用音频识别（默认启用，随 resolveMedia 缺省而失效） */
  audioRecognitionEnabled?: boolean;
  /** 是否启用视频识别（默认启用，随 resolveMedia 缺省而失效） */
  videoRecognitionEnabled?: boolean;
}

/** 各媒体类的占位符与识别成功时的包装 */
const MEDIA_LABEL: Record<ForwardMediaTask['kind'], { placeholder: string; prefix: string; suffix: string }> = {
  image: { placeholder: '[图片]', prefix: '[图片: ', suffix: ']' },
  audio: { placeholder: '[语音]', prefix: '[语音: ', suffix: ']' },
  video: { placeholder: '[视频]', prefix: '[视频: ', suffix: ']' },
};

/** 解析 CQ 段参数体（`,k=v,k=v`），含 CQ 转义还原。 */
function parseCqParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
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
  return params;
}

/**
 * 剥除 NUL：媒体 token 用 NUL 做哨兵，所有进入行文本的外部字符串（CQ 串、text 段、
 * at/face/share/未知段、昵称）都必须过这道——剥掉后消息内容无法伪造/搬运 token
 * （NUL 经 JSON \u0000 转义可达，非理论面）。
 */
function stripNul(s: string): string {
  return s.includes('\u0000') ? s.split('\u0000').join('') : s;
}

/** 媒体任务收集器：登记任务返回 token；该类未启用或无源时直接返回占位符。 */
type MediaCollector = (kind: ForwardMediaTask['kind'], src: string | undefined) => string;

/** 把 CQ 字符串里 [CQ:<cqType>,...] 段交给收集器（登记任务或落占位符）。 */
function replaceCqMedia(text: string, cqType: string, kind: ForwardMediaTask['kind'], collect: MediaCollector): string {
  return text.replace(new RegExp(`\\[CQ:${cqType}(,[^\\]]+)?\\]`, 'g'), (_m, body: string | undefined) => {
    const params = parseCqParams(body ?? '');
    return collect(kind, params.url || params.file);
  });
}

/**
 * 渲染一个节点 content（消息段数组或 CQ 字符串）为纯文本。
 * 媒体段（图片/语音/视频）经收集器登记为待识别任务并放 token——本函数是纯结构渲染，
 * 不发生任何网络/模型等待，保证 walk 快速完成、媒体源被尽早收集。
 */
function renderNodeContent(content: unknown, collect: MediaCollector): string {
  if (typeof content === 'string') {
    // CQ 码字符串：用正则替换 image / record / video / face / at / reply
    let out = replaceCqMedia(stripNul(content), 'image', 'image', collect);
    out = replaceCqMedia(out, 'record', 'audio', collect);
    out = replaceCqMedia(out, 'video', 'video', collect);
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
        parts.push(stripNul(String(data.text ?? '')));
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
        parts.push(collect('image', (data.url ?? data.file) as string | undefined));
        break;
      case 'reply':
        break;
      case 'forward':
        // 嵌套占位符，递归展开会在外层处理；这里先放标记，外层 expand 用 inline content 优先
        parts.push(data.id ? `<<<NESTED_FORWARD:${String(data.id)}>>>` : '[合并转发]');
        break;
      case 'record':
        parts.push(collect('audio', (data.url ?? data.file) as string | undefined));
        break;
      case 'video':
        parts.push(collect('video', (data.url ?? data.file) as string | undefined));
        break;
      case 'share':
        parts.push(`[分享:${stripNul(String(data.title ?? ''))}]`);
        break;
      case 'json':
        parts.push('[JSON卡片]');
        break;
      case 'xml':
        parts.push('[XML卡片]');
        break;
      default:
        if (s.type) parts.push(`[${stripNul(s.type)}]`);
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

  const nickname = stripNul(
    String(data.nickname ?? sender?.nickname ?? data.name ?? data.user_id ?? sender?.user_id ?? '匿名'),
  );
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

  // 媒体两阶段：walk 只登记任务放 token，遍历完成后统一交 resolveMedia 再回填。
  const tasks: ForwardMediaTask[] = [];
  const kindEnabled: Record<ForwardMediaTask['kind'], boolean> = {
    image: opts.imageRecognitionEnabled && !!opts.resolveMedia,
    audio: opts.audioRecognitionEnabled !== false && !!opts.resolveMedia,
    video: opts.videoRecognitionEnabled !== false && !!opts.resolveMedia,
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

      const rendered = renderNodeContent(meta.content, collect);
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
        const desc = resolved.get(tok)?.trim();
        const label = MEDIA_LABEL[task.kind];
        return desc ? `${label.prefix}${desc}${label.suffix}` : label.placeholder;
      });
    }
  }

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
