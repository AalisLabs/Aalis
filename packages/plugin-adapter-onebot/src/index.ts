import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { contributions } from '@aalis/api-contributions';
import { flowControl } from '@aalis/api-flow-control';
import { hooks } from '@aalis/api-hooks';
import { i18n } from '@aalis/api-i18n';
import { llm } from '@aalis/api-llm';
import { clearSessionMedia, media } from '@aalis/api-media';
import { memory } from '@aalis/api-memory';
import { messageArchive, outboundAddress } from '@aalis/api-message-archive';
import { type PlatformAdapter, type PlatformConnection, platform, type SessionTypeDecl } from '@aalis/api-platform';
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { TextError, type TextRef, textClauses, textOf, toSource, truncateParams } from '@aalis/schema-i18n';
import {
  ATTACHMENT_REF_KINDS,
  type ForwardedChat,
  formatAttachmentRef,
  type Message,
  type MessageAttachment,
  type OutboundDeliveryResult,
  type OutgoingMessage,
  stripSenderPrefix,
  WellKnownKinds,
  WellKnownMetadataKeys,
  WellKnownNoticeTypes,
  withForwards,
} from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';
import WebSocket from 'ws';
import { cacheOneAttachment, MEDIA_WRITER } from './attachment-cache.js';
import { capReplyMedia, inlineMarkupMedia, MEDIA_FETCH_CONCURRENCY, materializeAttachments } from './attachments.js';
import {
  createConcurrencyLimited,
  createForwardExpander,
  defaultForwardSummaryPrompt,
  type ForwardConfig,
} from './forward-expand.js';
import { lookupDescriptionByUrl, rememberLandedAlias } from './media-alias.js';
import { extractSentMessageId, SentMessageTracker } from './sent-messages.js';
import { t } from './texts.js';
import type {
  NormalizedRequestEvent,
  OneBotActionResponse,
  OneBotConnectionConfig,
  OneBotMessageSegment,
  OneBotProtocol,
  OneBotRawEvent,
  OutgoingPiece,
} from './types.js';
import {
  escapeMarkup,
  isGroupInviteCard,
  normalizeOneBotMessage,
  parseContentToSegments,
  segmentsToText,
  withReply,
} from './types.js';
import { OneBotV11 } from './v11.js';

/**
 * 从原始配置对象中解析出 forward 子配置。
 */
function parseForwardConfig(fwdRaw: ConfigOf<typeof configSchema>['forward']): ForwardConfig {
  return {
    enabled: fwdRaw.enabled,
    maxDepth: Math.max(1, Math.floor(fwdRaw.maxDepth)),
    maxNodesPerLevel: Math.max(1, Math.floor(fwdRaw.maxNodesPerLevel)),
    imageRecognition: fwdRaw.imageRecognition,
    imageRecognitionConcurrency: Math.max(1, Math.floor(fwdRaw.imageRecognitionConcurrency)),
    recognitionMaxItems: Math.max(0, Math.floor(fwdRaw.recognitionMaxItems)),
    summarize: fwdRaw.summarize,
    summaryMaxChars: Math.max(80, Math.floor(fwdRaw.summaryMaxChars)),
    summaryInputLimit: Math.max(0, Math.floor(fwdRaw.summaryInputLimit)),
    summaryPrompt: fwdRaw.summaryPrompt,
  };
}

import { OneBotV12 } from './v12.js';

// ===== 插件元数据 =====

const configSchema = defineConfig({
  connections: {
    type: 'array',
    onInvalid: 'error',
    label: t('connectionsLabel'),
    description: t('connectionsDescription'),
    items: {
      url: {
        type: 'string',
        label: t('urlLabel'),
        required: true,
        onInvalid: 'error',
        description: t('urlDescription'),
      },
      accessToken: {
        type: 'string',
        label: t('accessTokenLabel'),
        secret: true,
        onInvalid: 'error',
        description: t('accessTokenDescription'),
      },
      selfId: { type: 'string', label: t('selfIdLabel'), description: t('selfIdDescription') },
      protocol: {
        type: 'select',
        label: t('protocolLabel'),
        description: t('protocolDescription'),
        default: 'auto',
        options: [
          { label: t('protocolAuto'), value: 'auto' },
          { label: 'OneBot v11', value: 'v11' },
          { label: 'OneBot v12', value: 'v12' },
        ],
      },
    },
    default: [],
  },
  splitMessage: {
    label: t('splitLabel'),
    description: t('splitDescription'),
    fields: {
      enabled: { type: 'boolean', label: t('enable'), description: t('splitEnabledDescription'), default: false },
      delayPerChar: {
        type: 'number',
        label: t('delayPerCharLabel'),
        description: t('delayPerCharDescription'),
        default: 50,
      },
      maxDelay: {
        type: 'number',
        label: t('maxDelayLabel'),
        description: t('maxDelayDescription'),
        default: 3000,
      },
      patterns: {
        type: 'multiselect',
        label: t('patternsLabel'),
        description: t('patternsDescription'),
        allowCustom: true,
        onInvalid: 'error',
        options: [
          { label: t('patternFullStop'), value: '。' },
          { label: t('patternExclamation'), value: '！' },
          { label: t('patternQuestion'), value: '？' },
          { label: t('patternSemicolon'), value: '；' },
          { label: t('patternComma'), value: '，' },
          { label: t('patternEnumComma'), value: '、' },
          { label: t('patternPeriod'), value: '.' },
          { label: t('patternPeriodSpace'), value: '. ' },
          { label: t('patternBang'), value: '!' },
          { label: t('patternQuery'), value: '?' },
          { label: t('patternAsciiSemicolon'), value: ';' },
          { label: t('patternAsciiComma'), value: ',' },
          { label: t('patternAsciiCommaSpace'), value: ', ' },
          { label: t('patternNewline'), value: '\\n' },
          { label: t('patternTab'), value: '\\t' },
          { label: t('patternSpace'), value: ' ' },
        ],
        default: ['。', '！', '？', '.', '!', '?', '\\n'],
      },
    },
  },
  forward: {
    label: t('forwardLabel'),
    description: t('forwardDescription'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('forwardEnabledLabel'),
        default: true,
        description: t('forwardEnabledDescription'),
      },
      maxDepth: {
        type: 'number',
        label: t('forwardMaxDepthLabel'),
        default: 3,
        description: t('forwardMaxDepthDescription'),
      },
      maxNodesPerLevel: {
        type: 'number',
        label: t('maxNodesLabel'),
        default: 30,
        description: t('maxNodesDescription'),
      },
      imageRecognition: {
        type: 'boolean',
        label: t('imageRecognitionLabel'),
        default: true,
        description: t('imageRecognitionDescription'),
      },
      imageRecognitionConcurrency: {
        type: 'number',
        label: t('concurrencyLabel'),
        default: 8,
        description: t('concurrencyDescription'),
      },
      recognitionMaxItems: {
        type: 'number',
        label: t('recognitionMaxLabel'),
        default: 32,
        description: t('recognitionMaxDescription'),
      },
      summarize: {
        type: 'boolean',
        label: t('summarizeLabel'),
        default: true,
        description: t('summarizeDescription'),
      },
      summaryMaxChars: {
        type: 'number',
        label: t('summaryMaxCharsLabel'),
        default: 600,
        description: t('summaryMaxCharsDescription'),
      },
      summaryInputLimit: {
        type: 'number',
        label: t('summaryInputLimitLabel'),
        default: 8000,
        description: t('summaryInputLimitDescription'),
      },
      summaryPrompt: {
        type: 'textarea',
        label: t('summaryPromptLabel'),
        default: '',
        description: t('summaryPromptDescription', { prompt: defaultForwardSummaryPrompt('<输出语言>') }),
      },
    },
  },
  reply: {
    label: t('replyLabel'),
    description: t('replyDescription'),
    fields: {
      maxDepth: {
        type: 'number',
        label: t('replyMaxDepthLabel'),
        default: 5,
        description: t('replyMaxDepthDescription'),
      },
    },
  },
  attachmentCache: {
    label: t('cacheLabel'),
    description: t('cacheDescription'),
    fields: {
      maxBytes: {
        type: 'number',
        label: t('cacheMaxBytesLabel'),
        default: 10 * 1024 * 1024,
        description: t('cacheMaxBytesDescription'),
      },
    },
  },
});

// ===== 内部类型 =====

/** 单个 WebSocket 连接状态 */
interface ConnectionState {
  config: OneBotConnectionConfig;
  ws?: WebSocket;
  status: 'online' | 'offline' | 'connecting';
  selfId?: string;
  selfNickname?: string;
  protocol?: OneBotProtocol;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  lastPong: number;
  pendingActions: Map<
    string,
    {
      action: string;
      resolve: (data: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
}

/**
 * action 的三种结局之一：已经发给实现端、没等到回执（超时，或在飞时连接关闭、适配器停止）。实现端可能已经执行，结果未知，
 * 不能当作没发出，也不能重发
 */
class ActionUnconfirmedError extends Error {
  constructor(action: string, why: string) {
    super(`OneBot action ${action} 没等到回执（${why}），结果未知，可能已经执行`);
  }
}

/**
 * action 的三种结局之一：实现端回了失败，确定没执行。retcode 是实现端的返回码；unsupported 表示实现端不支持这个动作（返回码
 * 由协议对象的 unsupportedRetcode 给），调用方只在这时才可以改用别的动作名。带文字对象（投递失败的原因给人看），实现端的原话
 * 原样作参数；message 是它的原文（工具结果取它）
 */
class OneBotActionError extends Error {
  readonly text: TextRef;
  readonly action: string;
  readonly retcode: number;
  readonly unsupported: boolean;
  constructor(action: string, retcode: number, unsupported: boolean, detail: string | undefined) {
    const text = detail ? t('actionFailedDetail', { action, retcode, detail }) : t('actionFailed', { action, retcode });
    super(text.source);
    this.text = text;
    this.action = action;
    this.retcode = retcode;
    this.unsupported = unsupported;
  }
}

/**
 * 结清全部在飞 action：清定时器、reject 唤醒等待方、清账。返回结清条数。
 * ws 断开与插件拆卸两条清理路共用——只清定时器不 reject 会让等待方的 promise
 * 永久悬空（bounce 瞬间在飞的 get_forward_msg/get_msg 静默丢失、闭包泄漏）。在飞的都已发给实现端，按结果未知结清。
 * @internal 导出仅为让对称性可被直接断言。
 */
export function settlePendingActions(
  pendingActions: Map<string, { action: string; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>,
  reason: string,
): number {
  const n = pendingActions.size;
  for (const [, pending] of pendingActions) {
    clearTimeout(pending.timer);
    pending.reject(new ActionUnconfirmedError(pending.action, reason));
  }
  pendingActions.clear();
  return n;
}

// ===== 工具函数 =====

/** 撤回原文的时间标注：同日 HH:mm，跨日 M/D HH:mm（供撤回通知内嵌，纯函数）。 */
function formatRecallClock(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 通知里的人：查到昵称写「昵称(id)」，没有写 id，都没有写 fallback（给模型的正文取它的原文） */
function who(nick: string | undefined, id: string | undefined, fallback: TextRef): string | TextRef {
  return nick ? `${nick}(${id})` : (id ?? fallback);
}

/**
 * 确定没发出的各条原因以「; 」相连成一句（同改前的分隔）。两两二分着嵌套，层数随条数按对数增长：附件多时依次相连会超过
 * 渲染的嵌套上限（同 schema-i18n 的 textClauses）
 */
function joinReasons(reasons: readonly (string | TextRef)[]): string | TextRef {
  if (reasons.length === 1) return reasons[0];
  const half = Math.ceil(reasons.length / 2);
  return t('andThen', { head: joinReasons(reasons.slice(0, half)), tail: joinReasons(reasons.slice(half)) });
}

/**
 * 撤回通知文案（纯函数，供单测）。
 *
 * 能反查到归档原文时，附「发送时间 + 内容摘录」——LLM 由此知道被撤回的**是哪句话**，
 * 而不是只看到一个对它毫无意义的平台 msg id（历史消息呈现给 LLM 时不带 messageId，
 * 只给 id 它对应不上）。查不到原文时退回旧文案（msg id 便于人工排查）。
 *
 * 摘录规则：按存档记下的标签（senderLabel，存档元数据的 SenderLabel）去掉与通知重复的发送者前缀、压平空白、
 * truncateChars 截断（不切碎代理对——见 llm-lone-surrogate 教训）。
 */
export function buildRecallNoticeContent(opts: {
  isGroup: boolean;
  userLabel: string;
  opLabel?: string;
  messageId?: string;
  original?: { content: string; timestamp?: number; senderLabel?: string };
  now?: number;
}): string {
  const { isGroup, userLabel, opLabel, messageId, original } = opts;
  let detail = messageId ? `（msg=${messageId}）` : '';
  if (original?.content) {
    const bare = stripSenderPrefix(original.content, original.senderLabel).replace(/\s+/g, ' ').trim();
    if (bare) {
      const excerpt = truncateChars(bare, 60, '…');
      const clock = original.timestamp ? formatRecallClock(original.timestamp, opts.now ?? Date.now()) : '';
      detail = `（${clock ? `${clock} 发送` : '原文'}：「${excerpt}」）`;
    }
  }
  const head = isGroup
    ? opLabel && opLabel !== userLabel
      ? `${opLabel} 撤回了 ${userLabel} 的消息`
      : `${userLabel} 撤回了一条消息`
    : `${userLabel} 撤回了一条私聊消息`;
  return `[notice/${isGroup ? 'group_recall' : 'friend_recall'}] ${head}${detail}`;
}

/** 频道的窗口 id `<guild>:<channel>`：会话 id 的目标段与入站消息的 groupId 都用它 */
function channelWindowId(guildId?: string, channelId?: string): string {
  return `${guildId ?? 'unknown'}:${channelId ?? 'unknown'}`;
}

/** 生成 sessionId: onebot:{selfId}:{detailType}:{targetId} */
function makeSessionId(
  selfId: string,
  detailType: string,
  userId?: string,
  groupId?: string,
  guildId?: string,
  channelId?: string,
): string {
  let targetId: string;
  if (detailType === 'private') {
    targetId = userId ?? 'unknown';
  } else if (detailType === 'group') {
    targetId = groupId ?? 'unknown';
  } else if (detailType === 'channel') {
    targetId = channelWindowId(guildId, channelId);
  } else {
    targetId = 'unknown';
  }
  return `onebot:${selfId}:${detailType}:${targetId}`;
}

/** 本平台的类型：消息带的类型名（v11 的 message_type、v12 的 detail_type）与会话 id 的第三段，群与频道多方、私聊一对一 */
const SESSION_TYPES: readonly SessionTypeDecl[] = [
  { name: 'group', label: t('typeGroup'), multiParty: true },
  { name: 'private', label: t('typePrivate'), multiParty: false },
  { name: 'channel', label: t('typeChannel'), multiParty: true },
];

/** 解析 sessionId 回连接信息 */
function parseSessionId(sessionId: string): {
  selfId: string;
  detailType: string;
  targetId: string;
} | null {
  const parts = sessionId.split(':');
  if (parts[0] !== 'onebot' || parts.length < 4) return null;
  return {
    selfId: parts[1],
    detailType: parts[2],
    targetId: parts.slice(3).join(':'),
  };
}

/** 生成唯一 echo ID */
let echoCounter = 0;
function nextEcho(): string {
  return `aalis_${Date.now()}_${++echoCounter}`;
}

// ===== 附件统一缓存 =====
//
// image/audio/video/file 一律落盘到 data:/{kind}s/{会话目录}/onebot/{hash}.{ext}，便于人工归档、
// 跨轮工具复用、多模态历史回放。详见 ./attachment-cache.ts。

/** 附件的种类：/clear 的类型，回执里的称呼与类型显示名（字典键） */
const MEDIA_KINDS = [
  ['image', 'mediaImage', 'clearTypeImage'],
  ['video', 'mediaVideo', 'clearTypeVideo'],
  ['audio', 'mediaAudio', 'clearTypeAudio'],
  ['file', 'mediaFile', 'clearTypeFile'],
] as const;

// ===== 协议版本实例 =====
const protocolV11 = new OneBotV11();
const protocolV12 = new OneBotV12();

// ===== 重连配置 =====
const RECONNECT_INTERVAL = 5000;
const ACTION_TIMEOUT = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 15000;

// ===== 请求事件 =====
/** 好友申请、入群邀请与加群申请合成的系统通知的 IncomingMessage.source */
const REQUEST_SOURCE = 'onebot-request';

// ===== 消息分条逻辑 =====

/**
 * 解析「切割模式列表」：每项是一个字符串，按 JS 风格解码转义序列
 * （\\n→换行、\\t→制表符、\\r→回车、\\\\→反斜杠）。空串与重复项被忽略。
 */
function resolveSplitPatterns(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const decoded = raw.replace(/\\([nrt\\])/g, (_, c) =>
      c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : '\\',
    );
    if (decoded.length > 0 && !out.includes(decoded)) out.push(decoded);
  }
  return out;
}

/** 转义正则元字符，用于 lookbehind。 */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按配置的「切割模式列表」将文本拆分为多条消息。
 * 每个模式作为一个原子 lookbehind 匹配——文本必须以该模式整体结尾才会切割。
 * XML 标记（<at>、<image> 等）保持与相邻文本在一起，不在标记内部切割。
 */
export function splitMessageByPunctuation(content: string, patterns: string[]): string[] {
  if (content.length <= 10 || patterns.length === 0) return [content];

  // 识别 XML 标记位置，拆分时不切割它们。at 用 [^>]* 容纳属性（含 <at id=..>/<at self id=..>/<at>all</at>），
  // 并覆盖自闭合的 video/record，与下游 parseContentToSegments 接受的格式一致，避免昵称含逗号/url 含点时被切碎。
  const xmlTagRegex =
    /<at\b[^>]*>[^<]*<\/at>|<face\s+id=["'][^"']*["']\s*\/>|<image\s+url=["'][^"']*["']\s*\/>|<reply\s+id=["'][^"']*["']\s*\/>|<video\s+url=["'][^"']*["']\s*\/>|<record\s+url=["'][^"']*["']\s*\/>/g;

  interface Token {
    type: 'text' | 'tag';
    value: string;
  }
  const tokens: Token[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null = xmlTagRegex.exec(content);
  while (m !== null) {
    if (m.index > lastIdx) tokens.push({ type: 'text', value: content.slice(lastIdx, m.index) });
    tokens.push({ type: 'tag', value: m[0] });
    lastIdx = m.index + m[0].length;
    m = xmlTagRegex.exec(content);
  }
  if (lastIdx < content.length) tokens.push({ type: 'text', value: content.slice(lastIdx) });

  // 拆分正则：每个模式独立 lookbehind，用 | 合并
  const splitRegex = new RegExp(patterns.map(p => `(?<=${escapeForRegex(p)})`).join('|'));

  const pieces: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (token.type === 'tag') {
      current += token.value;
      continue;
    }
    const parts = token.value.split(splitRegex);
    for (let i = 0; i < parts.length; i++) {
      current += parts[i];
      if (i < parts.length - 1 && current.trim()) {
        pieces.push(current);
        current = '';
      }
    }
  }
  if (current.trim()) pieces.push(current);

  // 尾部清理：去除每段末尾匹配到的切割模式（按长度倒序匹配，优先去掉长模式）
  const sortedPatterns = [...patterns].sort((a, b) => b.length - a.length);
  const stripTrailing = (s: string): string => {
    let cur = s;
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of sortedPatterns) {
        if (cur.endsWith(p)) {
          cur = cur.slice(0, -p.length);
          changed = true;
        }
      }
      const trimmed = cur.replace(/\s+$/, '');
      if (trimmed !== cur) {
        cur = trimmed;
        changed = true;
      }
    }
    return cur;
  };

  const result: string[] = [];
  for (const piece of pieces) {
    const cleaned = stripTrailing(piece).trim();
    if (cleaned) result.push(cleaned);
  }

  return result.length > 0 ? result : [content];
}

/**
 * 把一条消息中的 `<image url="..." />` 标签拆成独立片段，
 * 让图片始终单条发送，避免与文字粘连显得"假"。
 * 文本两侧留白会被 trim；如果结果为空则回退到原文。
 */
function splitImageOut(content: string): string[] {
  const re = /<image\s+url=["'][^"']*["']\s*\/>/g;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    if (m.index > last) {
      const text = content.slice(last, m.index).trim();
      if (text) out.push(text);
    }
    out.push(m[0]);
    last = m.index + m[0].length;
    m = re.exec(content);
  }
  if (last < content.length) {
    const tail = content.slice(last).trim();
    if (tail) out.push(tail);
  }
  return out.length > 0 ? out : [content];
}

// ===== 插件入口 =====

/**
 * media / memory 缺席即降级——不登记落盘附件的描述别名、转发原文只剩 1h 内存缓存，
 * 收发主干照常，故声明为 optional，不进激活闸。
 */
const uses = {
  storage,
  processService,
  events,
  logger,
  lifecycle,
  config,
  contributions,
  provide,
  llm: optional(llm),
  media: optional(media),
  memory: optional(memory),
  messageArchive: optional(messageArchive),
  flowControl: optional(flowControl),
  hooks: optional(hooks),
  /** 默认合并转发摘要的输出语言（全局默认层的语言列表），缺席时按中文 */
  i18n: optional(i18n),
};
type Caps = BoundOf<typeof uses>;

function runAdapter(caps: Caps): void {
  const { contributions, events, lifecycle, logger, media, messageArchive, flowControl } = caps;
  const cfg = parseConfig(configSchema, caps.config.use, logger.use);
  const storage = caps.storage.use;
  const proc = caps.processService.use;
  const connections: OneBotConnectionConfig[] = cfg.connections;
  for (const conn of connections) {
    if (!URL.canParse(conn.url) || !['ws:', 'wss:'].includes(new URL(conn.url).protocol)) {
      throw configError(t('badUrl'));
    }
  }

  // 消息分条配置
  const splitEnabled = cfg.splitMessage.enabled;
  const splitDelayPerChar = Math.max(0, cfg.splitMessage.delayPerChar);
  const splitMaxDelay = Math.max(0, cfg.splitMessage.maxDelay);
  const splitPatterns = resolveSplitPatterns(cfg.splitMessage.patterns);

  // 聊天流控配置已迁移至 plugin-flow-control / plugin-trigger-policy。

  // 合并转发处理配置。
  const forwardCfg = parseForwardConfig(cfg.forward);

  // 引用消息处理配置
  const replyCfg = {
    maxDepth: Math.max(1, Math.floor(cfg.reply.maxDepth)),
  };

  // 附件落盘上限（image / audio / video / file 共用同一阈值）
  const attachmentMaxBytes =
    cfg.attachmentCache.maxBytes > 0
      ? cfg.attachmentCache.maxBytes
      : configSchema.attachmentCache.fields.maxBytes.default;

  if (connections.length === 0) {
    logger.use.info('OneBot 适配器未配置任何连接');
  }

  const states: ConnectionState[] = [];

  // ===== 用户昵称缓存（userId → nickname，从每条消息的 sender 信息累积） =====
  // 键为历史所有发言者 userId，需软上限 + onDispose 清理，否则长跑/大群下无界增长。
  const NICKNAME_CACHE_MAX = 5000;
  const nicknameCache = new Map<string, string>();

  // ===== 待处理请求（好友/入群）=====
  // 键 → 实现端给的 flag。键带收到它的账号（同一实例多个账号的申请互不覆盖），群请求另带申请类型与群号；处理成功才删
  const pendingFriendRequests = new Map<string, string>();
  const pendingGroupRequests = new Map<string, string>();
  const friendRequestKey = (selfId: string, userId: string) => `${selfId}:${userId}`;
  const groupRequestKey = (selfId: string, subType: 'add' | 'invite', userId: string, groupId: string) =>
    `${selfId}:${subType}:${userId}:${groupId}`;

  // ===== 桥接：平台 notice 入档 + 自禁言桥接 =====
  //
  // 流控/触发判定均已迁移；适配器只保留以下两类辅助：
  //  1. archivePlatformNotice —— 平台事件入档
  //  2. recoverSelfMute / 群禁言 notice → flow-control.setMuted（由 flow-control 插件实际暂停触发）

  /** 自禁言记录（sessionId → untilTs，毫秒），用于 adapter.getSelfMutes() */
  const selfMuted = new Map<string, number>();
  /** 已通过 shut_up_timestamp 完成恢复检查的会话集合 */
  const muteRecoveryChecked = new Set<string>();
  /** 机器人自身近期发出消息记录，支撑 adapter.getSentMessages() / 撤回自己发的消息 */
  const sentTracker = new SentMessageTracker();

  function setSelfMute(sessionId: string, durationSec: number): void {
    const flow = flowControl.present ? flowControl.use : undefined;
    if (durationSec > 0) {
      selfMuted.set(sessionId, Date.now() + durationSec * 1000);
      flow?.setMuted(sessionId, durationSec, 'onebot');
    } else {
      selfMuted.delete(sessionId);
      flow?.setMuted(sessionId, 0);
    }
  }

  // ── 平台 notice 入档 ──

  /** content 写给模型（text 的原文加上 [notice/…]，有的另带排查细节），text 是给人看的那句 */
  async function archivePlatformNotice(opts: {
    sessionId: string;
    noticeType: string;
    subType?: string;
    content: string;
    text: TextRef;
    userId?: string;
    targetId?: string;
    groupId?: string;
    operatorId?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const archive = messageArchive.present ? messageArchive.use : undefined;
    if (!archive?.archiveNotice) return;
    try {
      await archive.archiveNotice({
        sessionId: opts.sessionId,
        noticeType: opts.noticeType,
        subType: opts.subType,
        content: opts.content,
        text: opts.text,
        platform: 'onebot',
        userId: opts.userId,
        targetId: opts.targetId,
        groupId: opts.groupId,
        operatorId: opts.operatorId,
        data: opts.data,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.use.warn(`notice 入档失败 (${opts.noticeType}): ${err}`);
    }
  }

  // ── 通过 selfId 反查连接 ──

  function findStateBySelfId(selfId: string | undefined): ConnectionState | undefined {
    if (!selfId) return undefined;
    const target = String(selfId);
    return states.find(s => s.selfId != null && String(s.selfId) === target);
  }

  /** 会话 id 里的账号是本实例的连接（含配置里写明、连接还没上来的）：会话路由与出站认领都按它判断 */
  function ownsAccount(sessionId: string): boolean {
    const parsed = parseSessionId(sessionId);
    return parsed !== null && findStateBySelfId(parsed.selfId) !== undefined;
  }

  function parseGroupSessionId(sessionId: string): { selfId?: string; groupId?: string } {
    // 形如 onebot:{selfId}:group:{groupId}
    const parts = sessionId.split(':');
    if (parts.length >= 4 && parts[0] === 'onebot' && parts[2] === 'group') {
      return { selfId: parts[1], groupId: parts.slice(3).join(':') };
    }
    return {};
  }

  /** 启动/重连后通过 get_group_member_info.shut_up_timestamp 恢复禁言状态（每会话一次） */
  async function recoverSelfMuteIfNeeded(sessionId: string): Promise<void> {
    if (muteRecoveryChecked.has(sessionId)) return;
    muteRecoveryChecked.add(sessionId);
    const existing = selfMuted.get(sessionId) ?? 0;
    if (Date.now() < existing) return;
    const { selfId, groupId } = parseGroupSessionId(sessionId);
    if (!selfId || !groupId) return;
    const state = findStateBySelfId(selfId);
    if (!state || state.status !== 'online') return;
    try {
      const data = (await sendAction(state, 'get_group_member_info', {
        group_id: Number(groupId) || groupId,
        user_id: Number(selfId) || selfId,
        no_cache: true,
      })) as Record<string, unknown>;
      const ts = Number(data.shut_up_timestamp ?? 0);
      const nowSec = Math.floor(Date.now() / 1000);
      if (ts > nowSec) {
        const remainSec = ts - nowSec;
        setSelfMute(sessionId, remainSec);
        logger.use.info(
          `[禁言恢复] session=${sessionId} 检测到 shut_up_timestamp=${ts}，剩余 ${remainSec}s，已恢复禁言状态`,
        );
        await archivePlatformNotice({
          sessionId,
          noticeType: 'group_ban',
          subType: 'recovered',
          content: `[notice/group_ban/recovered] 检测到我在该群仍处于禁言状态，剩余约 ${remainSec} 秒（重启/重连后从 shut_up_timestamp 恢复）`,
          text: t('muteRecovered', { ms: remainSec * 1000 }),
          targetId: selfId,
          groupId,
          data: { duration: remainSec, until: ts * 1000 },
        });
      }
    } catch (err) {
      // 静默失败：可能是协议端不支持或群已退出
      logger.use.debug(
        `[禁言恢复] session=${sessionId} shut_up_timestamp 查询失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ----- 群信息缓存 -----

  interface GroupInfo {
    name: string;
    fetchedAt: number;
  }
  const groupInfoCache = new Map<string, GroupInfo>();
  const GROUP_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

  /** 获取群信息（带缓存） */
  async function getGroupInfo(state: ConnectionState, groupId: string): Promise<GroupInfo | null> {
    const cached = groupInfoCache.get(groupId);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL) return cached;

    try {
      const data = (await sendAction(state, 'get_group_info', {
        group_id: Number(groupId) || groupId,
      })) as Record<string, unknown>;
      const info: GroupInfo = {
        name: String(data.group_name ?? ''),
        fetchedAt: Date.now(),
      };
      if (info.name) groupInfoCache.set(groupId, info);
      return info;
    } catch {
      return null;
    }
  }

  // ----- self 群身份缓存 -----

  interface SelfMemberInfo {
    role?: 'owner' | 'admin' | 'member';
    title?: string;
    fetchedAt: number;
  }
  /** key = `${selfId}:${groupId}` */
  const selfMemberInfoCache = new Map<string, SelfMemberInfo>();
  const SELF_MEMBER_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

  /**
   * 获取 self 账号在指定群内的角色与头衔（带缓存）。
   * 用于把"自己是管理员"等关键身份信息注入到 system prompt，
   * 避免 LLM 误以为自己只是普通群员。
   */
  async function getSelfMemberInfo(
    state: ConnectionState,
    selfId: string,
    groupId: string,
  ): Promise<SelfMemberInfo | null> {
    const key = `${selfId}:${groupId}`;
    const cached = selfMemberInfoCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < SELF_MEMBER_CACHE_TTL) return cached;

    try {
      const data = (await sendAction(state, 'get_group_member_info', {
        group_id: Number(groupId) || groupId,
        user_id: Number(selfId) || selfId,
      })) as Record<string, unknown>;
      const rawRole = data.role;
      const role: SelfMemberInfo['role'] =
        rawRole === 'owner' || rawRole === 'admin' || rawRole === 'member' ? rawRole : undefined;
      const rawTitle = data.title;
      const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : undefined;
      const info: SelfMemberInfo = { role, title, fetchedAt: Date.now() };
      selfMemberInfoCache.set(key, info);
      return info;
    } catch (err) {
      logger.use.debug(
        `获取 self 群身份失败 (selfId=${selfId} groupId=${groupId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** 获取用户昵称（群聊优先取群名片，私聊取陌生人昵称） */
  async function resolveNickname(
    state: ConnectionState,
    userId?: string,
    groupId?: string,
  ): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      if (groupId) {
        const data = (await sendAction(state, 'get_group_member_info', {
          group_id: Number(groupId) || groupId,
          user_id: Number(userId) || userId,
        })) as Record<string, unknown>;
        return (data.card as string) || (data.nickname as string) || undefined;
      }
      const data = (await sendAction(state, 'get_stranger_info', {
        user_id: Number(userId) || userId,
      })) as Record<string, unknown>;
      return (data.nickname as string) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 获取引用消息的内容并渲染为可读文本。
   *
   * 与主消息流程对称：
   * - 复用 segmentsToText 完整渲染所有段（at / 图片 / forward 占位 / face / record / video …）
   * - 嵌套 forward：调用 expandForwards 展开为信封+摘要，换回占位的位置
   * - 图片：按段查描述缓存，命中时写成 `[图片: 描述]`，未命中保留 `[图片]` 占位符
   *   （主消息流的图片识别会自动写缓存，因此先发图、后被引用的常见路径能复用）
   */
  function findReplySegmentId(segments: OneBotMessageSegment[]): string | undefined {
    for (const seg of segments) {
      if (seg.type !== 'reply') continue;
      const data = seg.data as Record<string, unknown> | undefined;
      const id = data?.id ?? data?.message_id;
      if (id != null) return String(id);
    }
    return undefined;
  }

  async function fetchReplyMessage(
    state: ConnectionState,
    messageId: string,
    sessionId?: string,
    depth = 0,
    seen = new Set<string>(),
  ): Promise<{
    content?: string;
    userId?: string;
    nickname?: string;
  } | null> {
    if (depth >= replyCfg.maxDepth || seen.has(messageId)) return null;
    seen.add(messageId);

    // 0. 优先查我们自己的归档：命中即可拿到已烘焙了图片描述、forward 摘要等的"富文本"原文，
    //    避免再走 OneBot get_msg（且能跨 URL 鉴权失效）。
    if (sessionId) {
      const archive = messageArchive.present ? messageArchive.use : undefined;
      if (archive?.findByMessageId) {
        try {
          const archived = await archive.findByMessageId(sessionId, messageId);
          if (archived) {
            const {
              [WellKnownMetadataKeys.UserId]: rawUserId,
              [WellKnownMetadataKeys.Nickname]: rawNickname,
              [WellKnownMetadataKeys.SenderLabel]: label,
            } = archived.metadata ?? {};
            const userId = rawUserId != null ? String(rawUserId) : undefined;
            const nickname = rawNickname != null ? String(rawNickname) : undefined;
            // 归档正文带发送者前缀，引用渲染层会再加发送者标签：按存档记下的标签去掉这一层，避免重复
            const body = stripSenderPrefix(archived.content ?? '', typeof label === 'string' ? label : undefined);
            return { content: body || undefined, userId, nickname };
          }
        } catch (err) {
          logger.use.debug(`引用消息归档反查失败: ${err}`);
        }
      }
    }

    try {
      const data = (await sendAction(state, 'get_msg', {
        message_id: Number(messageId) || messageId,
      })) as Record<string, unknown>;
      // 与入站共用同一条归一路径（段数组 / CQ 字符串 / raw_message 原文）：
      // CQ 码不会流进引用文本，reply/at 段语义也与数组格式一致。
      const segments = normalizeOneBotMessage(data.message, data.raw_message);
      const sender = data.sender as Record<string, unknown> | undefined;
      const nickname = (sender?.card as string) || (sender?.nickname as string) || undefined;

      // 1. 用与主流程同款渲染器把所有段转成可读文本；图片只查描述缓存复用，不主动触发视觉模型。描述是识别模型写的字，与用户
      // 写的字同样转义
      const mediaSvc = media.present ? media.use : undefined;
      const describe = (seg: OneBotMessageSegment) => {
        if (seg.type !== 'image' || !mediaSvc || typeof seg.data.url !== 'string') return undefined;
        const desc = lookupDescriptionByUrl(mediaSvc, seg.data.url);
        return desc ? `[图片: ${escapeMarkup(desc)}]` : undefined;
      };
      let content = segmentsToText(segments, state.selfId, undefined, describe);

      // 2. 嵌套合并转发：展开为信封 + 摘要（命中现有 forward 缓存即零开销），换回占位的位置
      try {
        content = withForwards(content, await expandForwards(state, segments, sessionId ?? 'onebot:unknown'));
      } catch (err) {
        logger.use.debug(`引用消息中的合并转发展开失败: ${err}`);
      }

      const nestedReplyId = findReplySegmentId(segments);
      if (nestedReplyId) {
        const nested = await fetchReplyMessage(state, nestedReplyId, sessionId, depth + 1, seen);
        if (nested?.content) {
          const nestedLabel = nested.nickname || nested.userId || '?';
          content += `\n[该引用消息又引用 ${nestedLabel} 的消息: ${nested.content}]`;
        }
      }

      return {
        content: content || undefined,
        userId: data.user_id != null ? String(data.user_id) : undefined,
        nickname,
      };
    } catch {
      return null;
    }
  }

  // ===== 合并转发自动展开（详见 ./forward-expand.ts）=====
  const forwardExpander = createForwardExpander({
    logger: logger.use,
    memory: caps.memory,
    media,
    llm: caps.llm,
    i18n: caps.i18n,
    storage,
    processService: caps.processService,
    forwardCfg,
    attachmentMaxBytes,
    sendAction,
  });
  const { getOrLoadForward, fetchForward, expandForwards } = forwardExpander;

  // 参与 memory:clear。转发原文是聊天内容，归入 context：条目记下的会话只用于取用判定，只在全局清理时清，会话级清理不动它
  // （靠持久化层的 7 天回收）。收发的附件按所选种类清本适配器在会话媒体目录里的子目录：会话级清这个会话的，全局清各会话的。
  // 多实例共用同一命名空间与目录、各有一份内存缓存：每个实例都清一遍（重复删是空操作），回显按来源合成一行——已有成功项时不再
  // 追加，前一实例失败而本实例成功时改写那一行。四种附件各登记一个类型，/clear -t 才选得中（别的写入方也登记同名类型，帮助里只列
  // 一次）。
  for (const [type, , label] of MEDIA_KINDS)
    contributions.use.contribute('memory:clear-type', { id: type, label: t(label) });
  caps.hooks.use.middleware('memory:clear', async (data, next) => {
    const report = (line: (typeof data.results)[number]) => {
      const prev = data.results.find(r => r.source === line.source);
      if (!prev) data.results.push(line);
      else if (!prev.success && line.success) Object.assign(prev, line);
    };
    const wants = (type: string) => !data.types || data.types.includes(type);
    if (data.scope === 'all' && wants('context')) {
      try {
        const removed = await forwardExpander.clearAll();
        report({ source: 'onebot-forward', success: true, message: t('forwardCleared', { count: removed }) });
      } catch (err) {
        report({ source: 'onebot-forward', success: false, message: t('forwardFailed', { error: textOf(err) }) });
      }
    }
    const sessionId = data.scope === 'all' ? undefined : data.sessionId;
    if (data.scope === 'all' || sessionId) {
      for (const [type, noun] of MEDIA_KINDS) {
        if (!wants(type)) continue;
        const kind = t(noun);
        const line = { source: `onebot-${type}`, type };
        try {
          const count = await clearSessionMedia(storage, type, MEDIA_WRITER, sessionId);
          report({ ...line, success: true, message: t('mediaCleared', { kind, count }) });
        } catch (err) {
          report({ ...line, success: false, message: t('mediaFailed', { kind, error: textOf(err) }) });
        }
      }
    }
    await next();
  });

  // ----- Action 发送 -----

  function sendAction(state: ConnectionState, action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new TextError(t('wsNotConnected')));
        return;
      }

      const echo = nextEcho();
      const timer = setTimeout(() => {
        state.pendingActions.delete(echo);
        reject(new ActionUnconfirmedError(action, `${ACTION_TIMEOUT / 1000} 秒超时`));
      }, ACTION_TIMEOUT);

      state.pendingActions.set(echo, { action, resolve, reject, timer });

      const payload = JSON.stringify({ action, params, echo });
      state.ws.send(payload);
    });
  }

  /**
   * 把一段文字切成要发的各条。markup：正文含平台标记，按配置分条、图片单独成条，各条的标记解析成 @、媒体与引用；不设时整段
   * 作一个文字段原样发出
   */
  function toPieces(content: string, markup?: boolean): OutgoingPiece[] {
    // 她的回复分条发送，再拆出 <image .../>：图片始终独立成条，不与文本粘连
    const texts = markup
      ? (splitEnabled ? splitMessageByPunctuation(content, splitPatterns) : [content]).flatMap(p => splitImageOut(p))
      : [content];
    return texts
      .map(text => text.trim())
      .filter(Boolean)
      .map(text => ({ text, segments: markup ? parseContentToSegments(text) : [{ type: 'text', data: { text } }] }));
  }

  /**
   * 逐条发出，一条没发成就停，后面的不发：交回实现端给出的各条消息 id（按发送顺序，没给的不算）、已发出的条数与停下那一条的
   * 错误。不重试：没等到回执的那条实现端可能已经发出，重发会在群里出现两遍。连接不可用时在发第一条之前抛错。replyTo：引用
   * 回复的平台消息 id，只加在第一条前。还在准备的条（她回复里要下载内联的媒体）逐条等到了再发，等到 undefined 的那条不发、
   * 不计条数
   */
  async function sendPieces(
    sessionId: string,
    pieces: (OutgoingPiece | Promise<OutgoingPiece | undefined>)[],
    replyTo?: string,
  ): Promise<{ messageIds: string[]; sent: number; failure?: unknown }> {
    const parsed = parseSessionId(sessionId);
    if (!parsed) throw new TextError(t('badSessionId', { sessionId }));

    const state = findStateBySelfId(parsed.selfId);
    if (!state || state.status !== 'online' || !state.ws || !state.protocol) {
      // 经路由与出站认领到这里的账号都是本实例的；认不出的账号由路由处报错并列出各实例的已知账号
      const reason = !state
        ? t('noConnection')
        : state.status !== 'online'
          ? t('connectionStatus', { status: state.status })
          : !state.ws
            ? t('wsEmpty')
            : t('protocolNotReady');
      throw new TextError(t('connectionDownBecause', { selfId: parsed.selfId, reason }));
    }

    const messageIds: string[] = [];
    let sent = 0;
    for (const pending of pieces) {
      const piece = await pending;
      if (!piece) continue;
      const { text, segments } = piece;
      // 与上一条之间按这一条的字数延迟
      if (sent > 0) {
        const delay = Math.min(text.replace(/<[^>]+>/g, '').length * splitDelayPerChar, splitMaxDelay);
        if (delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
      const { action, params } = state.protocol.buildSendMessage({
        detailType: parsed.detailType,
        targetId: parsed.targetId,
        segments: withReply(segments, sent === 0 ? replyTo : undefined),
      });

      let sendResult: unknown;
      try {
        sendResult = await sendAction(state, action, params);
      } catch (failure) {
        return { messageIds, sent, failure };
      }
      // 记录发出消息的 message_id，支撑「撤回自己发的消息」（每分条各自独立的 id）
      const sentId = extractSentMessageId(sendResult);
      if (sentId) {
        sentTracker.record(sessionId, sentId, text, Date.now());
        messageIds.push(sentId);
      }
      sent++;
    }
    return { messageIds, sent };
  }

  // ----- 版本自动检测 -----

  async function detectProtocol(state: ConnectionState): Promise<OneBotProtocol> {
    // 策略: 先尝试 v11 的 get_version_info，成功则为 v11
    // 失败则尝试 v12 的 get_version，成功则为 v12
    // 都失败则默认 v11（更常见）
    try {
      const data = await sendAction(state, 'get_version_info', {});
      const info = data as Record<string, unknown>;
      const protoVer = String(info?.protocol_version ?? '');
      logger.use.info(
        `OneBot 版本检测: get_version_info 成功 (protocol_version=${protoVer}, app=${info?.app_name ?? 'unknown'})`,
      );
      // 有些实现可能报 v12 但走的 v11 接口，以接口可用性为准
      return protocolV11;
    } catch {
      // get_version_info 不可用，尝试 v12
    }

    try {
      const data = await sendAction(state, 'get_version', {});
      const info = data as Record<string, unknown>;
      logger.use.info(
        `OneBot 版本检测: get_version 成功 (impl=${info?.impl ?? 'unknown'}, onebot_version=${info?.onebot_version ?? '?'})`,
      );
      return protocolV12;
    } catch {
      // 也不可用
    }

    logger.use.warn('OneBot 版本自动检测失败，默认使用 v11 协议');
    return protocolV11;
  }

  // ----- PlatformAdapter 实现 -----

  const adapter = {
    adapterName: 'OneBot',
    platform: 'onebot',
    sessionTypes: SESSION_TYPES,

    getConnections(): PlatformConnection[] {
      return states.map(s => ({
        id: `onebot:${s.selfId ?? s.config.url}`,
        platform: 'onebot',
        selfId: s.selfId,
        selfNickname: s.selfNickname,
        status: s.status,
        detail: {
          url: s.config.url,
          protocol: s.protocol?.version ?? 'unknown',
          nickname: s.selfNickname,
        },
      }));
    },

    /**
     * 只认本实例连接里的账号（含配置里写明、连接还没上来的）：同一插件装多个实例时，会话、平台动作与
     * 合成会话 id 都按 id 里的账号路由到所属实例。离线的已知账号照样认领，由发送处报出连接不可用。
     */
    canHandle: ownsAccount,

    /** 给了会话只回那个会话的账号；不给会话时本实例恰好一个已知账号才回它，多个账号时说不出是哪个，不回 */
    getSelfIdentity(sessionId?: string) {
      const known = states.filter(s => s.selfId);
      const state =
        sessionId === undefined
          ? known.length === 1
            ? known[0]
            : undefined
          : findStateBySelfId(parseSessionId(sessionId)?.selfId);
      if (!state) return undefined;
      return {
        platform: 'onebot',
        selfId: state.selfId,
        nickname: state.selfNickname,
      };
    },

    /** 契约的直发：纯文字，不解析标记、不分条。她的回复经 outbound:message 带 markup 发出 */
    async sendMessage(sessionId: string, content: string): Promise<void> {
      const { failure } = await sendPieces(sessionId, toPieces(content));
      if (failure !== undefined) throw failure;
    },

    async callAction(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
      const parsed = parseSessionId(sessionId);
      if (!parsed) throw new Error(`无法解析 sessionId: ${sessionId}`);

      const state = findStateBySelfId(parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws) {
        throw new Error(`OneBot 连接不可用: selfId=${parsed.selfId}`);
      }

      // 合并转发：先查收到时记下的条目（展开结果与收到它的会话），没展开过的交给工具过了取用判定再按 id 拉
      if (action === 'get_forward_msg') {
        const id = String(params.id ?? '');
        if (id) {
          // 内存缓存，落空再读持久化层（重启后场景）
          const entry = await getOrLoadForward(id);
          // 展开过的返回完整原文 + 摘要（如果有）、截断标志与收到它的会话。工具层按这些会话过取用判定，再用 fullText 渲染。
          if (entry?.fullText !== undefined) return { __aalisForwardEntry: true, ...entry };
          // 没展开过的（关掉展开、拉不到、什么也没展开出来、嵌套的）返回收到它的会话与按 id 现拉的办法：工具层过了取用判定才拉。
          // 从没收到过的会话为空
          return {
            __aalisForwardReceipt: true,
            sessionIds: entry?.sessionIds ?? [],
            fetch: () => fetchForward(state, id),
          };
        }
      }

      return sendAction(state, action, params);
    },

    /**
     * 非标准扩展：返回当前进程内已知"自身被禁言"的群快照。
     * 数据来自适配器自身的 selfMuted（由 group_ban notice 与 shut_up_timestamp 恢复维护）。
     */
    getSelfMutes(): Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }> {
      const now = Date.now();
      const out: Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }> = [];
      for (const [sid, untilTs] of selfMuted) {
        if (untilTs > now) {
          const { selfId, groupId } = parseGroupSessionId(sid);
          if (selfId && groupId) {
            out.push({ selfId, groupId, untilTs, remainingSec: Math.ceil((untilTs - now) / 1000) });
          }
        } else {
          selfMuted.delete(sid);
        }
      }
      return out;
    },

    /**
     * 非标准扩展：返回机器人自身在某会话近期发出的消息（新→旧），用于「撤回自己发的消息」。
     */
    getSentMessages(sessionId: string, limit = 10) {
      return sentTracker.recent(sessionId, limit, Date.now());
    },

    /** 非标准扩展：撤回成功后从记录中移除一条（使「撤回最近一条」可重复往前走）。 */
    forgetSentMessage(sessionId: string, messageId: string): void {
      sentTracker.forget(sessionId, messageId);
    },

    /**
     * 非标准扩展：把文件传到群文件（群会话）或私聊文件（私聊会话），`file` 只收 base64://
     * （见 attachments.ts 的 materializeAttachments）。连接不可用、v12 连接与其他会话类型一律抛错。
     * 不重试：上传超时多半是文件还在传，重试会在群文件里留两份。
     */
    async uploadFile(sessionId: string, file: string, name: string): Promise<void> {
      const parsed = parseSessionId(sessionId);
      if (!parsed) throw new TextError(t('badSessionId', { sessionId }));
      const state = findStateBySelfId(parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws || !state.protocol) {
        throw new TextError(t('connectionDown', { selfId: parsed.selfId }));
      }
      if (state.protocol.version !== 'v11') throw new TextError(t('v12NoFile'));
      const targetId = Number(parsed.targetId) || parsed.targetId;
      if (parsed.detailType === 'group') {
        await sendAction(state, 'upload_group_file', { group_id: targetId, file, name });
      } else if (parsed.detailType === 'private') {
        await sendAction(state, 'upload_private_file', { user_id: targetId, file, name });
      } else {
        throw new TextError(t('typeNoFile', { type: parsed.detailType }));
      }
    },

    /** 处理账号 selfId 收到的好友请求：approve=true 同意，remark 为备注（同意时有效）。没有这条申请、连接不可用时抛错 */
    async handleFriendRequest(selfId: string, userId: string, approve: boolean, remark?: string): Promise<string> {
      const key = friendRequestKey(selfId, userId);
      const flag = pendingFriendRequests.get(key);
      if (!flag) throw new Error(`未找到来自 ${userId} 的好友申请（可能已处理）`);
      const state = findStateBySelfId(selfId);
      if (!state || state.status !== 'online') throw new Error('连接不可用，无法处理请求');
      await sendAction(state, 'set_friend_add_request', { flag, approve, remark: remark ?? '' });
      pendingFriendRequests.delete(key);
      return approve
        ? `已同意 ${userId} 的好友申请${remark ? `，备注: ${remark}` : ''}`
        : `已拒绝 ${userId} 的好友申请`;
    },

    /**
     * 处理账号 selfId 收到的群请求：subType 是调用方要处理的申请类型（add 加群申请、invite 入群邀请），类型对不上的按没有这条
     * 申请报错；approve=true 同意，reason 为拒绝理由。没有这条申请、连接不可用时抛错
     */
    async handleGroupRequest(
      selfId: string,
      subType: 'add' | 'invite',
      userId: string,
      groupId: string,
      approve: boolean,
      reason?: string,
    ): Promise<string> {
      const key = groupRequestKey(selfId, subType, userId, groupId);
      const flag = pendingGroupRequests.get(key);
      const typeLabel = subType === 'invite' ? '入群邀请' : '加群申请';
      if (!flag) throw new Error(`未找到来自 ${userId} 关于群 ${groupId} 的${typeLabel}（可能已处理）`);
      const state = findStateBySelfId(selfId);
      if (!state || state.status !== 'online') throw new Error('连接不可用，无法处理请求');
      await sendAction(state, 'set_group_add_request', { flag, sub_type: subType, approve, reason: reason ?? '' });
      pendingGroupRequests.delete(key);
      return approve
        ? `已同意 ${userId} 的${typeLabel}（群 ${groupId}）`
        : `已拒绝 ${userId} 的${typeLabel}（群 ${groupId}）${reason ? `，理由: ${reason}` : ''}`;
    },
  } as PlatformAdapter & {
    getSelfMutes(): Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }>;
    getSentMessages(sessionId: string, limit?: number): Array<{ messageId: string; ts: number; preview: string }>;
    forgetSentMessage(sessionId: string, messageId: string): void;
    uploadFile(sessionId: string, file: string, name: string): Promise<void>;
    handleFriendRequest(selfId: string, userId: string, approve: boolean, remark?: string): Promise<string>;
    handleGroupRequest(
      selfId: string,
      subType: 'add' | 'invite',
      userId: string,
      groupId: string,
      approve: boolean,
      reason?: string,
    ): Promise<string>;
  };

  caps.provide.use(platform, adapter);

  // ----- 连接管理 -----

  function connectOne(connConfig: OneBotConnectionConfig): ConnectionState {
    const state: ConnectionState = {
      config: connConfig,
      status: 'offline',
      selfId: connConfig.selfId != null ? String(connConfig.selfId) : undefined,
      lastPong: 0,
      pendingActions: new Map(),
    };

    // 根据配置预设协议版本
    const proto = connConfig.protocol ?? 'auto';
    if (proto === 'v11') {
      state.protocol = protocolV11;
    } else if (proto === 'v12') {
      state.protocol = protocolV12;
    }
    // 'auto' 时 state.protocol 在连接后检测设置

    states.push(state);
    doConnect(state);
    return state;
  }

  function stopHeartbeat(state: ConnectionState): void {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }

  function doConnect(state: ConnectionState): void {
    if (lifecycle.use.signal.aborted) return;

    state.status = 'connecting';
    logger.use.info(`正在连接 OneBot: ${state.config.url} (协议: ${state.protocol?.version ?? '待检测'})`);

    const headers: Record<string, string> = {};
    if (state.config.accessToken) {
      headers.Authorization = `Bearer ${state.config.accessToken}`;
    }

    const ws = new WebSocket(state.config.url, { headers });
    state.ws = ws;

    // 诊断：捕获 unexpected-response（服务器返回非 101 时触发，且不会触发 error）
    ws.on('unexpected-response', (_req, res) => {
      logger.use.warn(`OneBot unexpected-response: status=${res.statusCode}, headers=${JSON.stringify(res.headers)}`);
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        logger.use.warn(`OneBot unexpected-response body: ${body}`);
      });
    });

    // 连接超时：如果 WS 握手在 CONNECT_TIMEOUT 内未完成，主动关闭并触发重连
    const connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        logger.use.warn(
          `OneBot 连接超时 (${CONNECT_TIMEOUT / 1000}s): ${state.config.url}, readyState=${ws.readyState}`,
        );
        ws.terminate();
      }
    }, CONNECT_TIMEOUT);

    ws.on('upgrade', res => {
      logger.use.debug(`OneBot WS upgrade: status=${res.statusCode}`);
    });

    ws.on('open', () => {
      clearTimeout(connectTimer);
      state.status = 'online';
      state.lastPong = Date.now();
      logger.use.info(`OneBot 已连接: ${state.config.url}`);

      // 客户端心跳：定期 ping，检测待机后的死连接
      stopHeartbeat(state);
      ws.on('pong', () => {
        state.lastPong = Date.now();
      });
      state.heartbeatTimer = setInterval(() => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - state.lastPong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
          logger.use.warn(`OneBot 心跳超时，主动断开: ${state.config.url}`);
          state.ws.terminate();
          return;
        }
        state.ws.ping();
      }, HEARTBEAT_INTERVAL);

      onConnected(state);
    });

    ws.on('message', raw => {
      // 收到任何消息即说明链路存活，重置心跳计时器
      state.lastPong = Date.now();
      try {
        const data = JSON.parse(raw.toString());

        // Action 响应 (有 echo 字段且不为空字符串)
        if ('echo' in data && typeof data.echo === 'string' && data.echo !== '') {
          const resp = data as OneBotActionResponse;
          const pending = state.pendingActions.get(resp.echo!);
          if (pending) {
            clearTimeout(pending.timer);
            state.pendingActions.delete(resp.echo!);
            if (resp.status === 'ok') {
              pending.resolve(resp.data);
            } else {
              const unsupported = resp.retcode === state.protocol?.unsupportedRetcode;
              pending.reject(new OneBotActionError(pending.action, resp.retcode, unsupported, resp.message));
            }
          }
          return;
        }

        // 事件分发（需要协议已确定）
        if (!state.protocol) return;

        const event = data as OneBotRawEvent;
        const eventType = state.protocol.parseEventType(event);

        if (eventType === 'message') {
          handleMessageEvent(state, event);
        } else if (eventType === 'meta') {
          handleMetaEvent(state, event);
        } else if (eventType === 'notice') {
          handleNoticeEvent(state, event);
        } else if (eventType === 'request') {
          handleRequestEvent(state, event);
        } else {
          // 未识别事件类型（如 NapCat 的 post_type='message_sent' 自身消息回显、自定义 post_type 等）
          const ev = event as Record<string, unknown>;
          const ident = String(ev.post_type ?? ev.type ?? 'unknown');
          logger.use.debug(
            `OneBot[${state.protocol.version}] 跳过未识别事件类型: post_type=${ident}, keys=[${Object.keys(ev).slice(0, 12).join(',')}]`,
          );
        }
      } catch (err) {
        logger.use.debug('OneBot 消息解析失败:', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(connectTimer);
      state.status = 'offline';
      state.ws = undefined;
      stopHeartbeat(state);
      settlePendingActions(state.pendingActions, '连接已关闭');

      logger.use.warn(`OneBot 连接断开: ${state.config.url}，${RECONNECT_INTERVAL / 1000}s 后重连`);
      scheduleReconnect(state);
    });

    ws.on('error', err => {
      clearTimeout(connectTimer);
      logger.use.warn(
        `OneBot 连接错误: ${err.message}, code=${(err as NodeJS.ErrnoException).code}, readyState=${ws.readyState}`,
      );
    });
  }

  async function onConnected(state: ConnectionState): Promise<void> {
    // 1. 如果协议未确定（auto），先检测
    if (!state.protocol) {
      try {
        state.protocol = await detectProtocol(state);
        logger.use.info(`OneBot 协议版本: ${state.protocol.version} (${state.config.url})`);
      } catch (err) {
        logger.use.warn(`OneBot 协议检测异常: ${err}，默认使用 v11`);
        state.protocol = protocolV11;
      }
    }

    // 2. 获取 self info（即使配置已给 selfId，也尝试补齐昵称）
    if (!state.selfId || !state.selfNickname) {
      try {
        const action = state.protocol.getSelfInfoAction();
        const data = await sendAction(state, action, {});
        const selfInfo = state.protocol.parseSelfInfo(data);
        if (selfInfo.userId) state.selfId = selfInfo.userId;
        if (selfInfo.nickname) state.selfNickname = selfInfo.nickname;
        if (selfInfo.userId || selfInfo.nickname) {
          const namePart = state.selfNickname ? `, nickname=${state.selfNickname}` : '';
          logger.use.info(`OneBot self_id: ${state.selfId ?? '?'}${namePart} (via ${action})`);
        }
      } catch (err) {
        logger.use.debug(`获取 self info 失败: ${err}`);
      }
    }

    // 3. 重置该 selfId 下所有群会话的「自禁言恢复检查」标记，
    //    确保重连后下一条消息会重新通过 shut_up_timestamp 校验当前禁言状态
    if (state.selfId) {
      const prefix = `onebot:${state.selfId}:group:`;
      for (const sid of Array.from(muteRecoveryChecked)) {
        if (sid.startsWith(prefix)) muteRecoveryChecked.delete(sid);
      }
    }
  }

  function scheduleReconnect(state: ConnectionState): void {
    if (lifecycle.use.signal.aborted) return;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    logger.use.info(`OneBot 将在 ${RECONNECT_INTERVAL / 1000}s 后尝试重连: ${state.config.url}`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      logger.use.info(`OneBot 正在重试连接: ${state.config.url}`);
      doConnect(state);
    }, RECONNECT_INTERVAL);
  }

  // ----- 事件处理 -----

  /**
   * 语音附件的来源：v11 的语音段把 file（附件的 name）交给 get_record，用它换出的地址（base64、网址或本机路径任一），换不出时用段里的
   * 来源；v12 标准没有这个动作，它的附件不带 name，直接用段里的来源
   */
  async function recordSource(state: ConnectionState, att: { url: string; name?: string }): Promise<string> {
    const fileRef = att.name;
    if (!fileRef) return att.url;
    try {
      const data = (await sendAction(state, 'get_record', { file: fileRef, out_format: 'mp3' })) as
        | { file?: string; url?: string; base64?: string }
        | undefined;
      logger.use.debug(
        `OneBot get_record 完成 (file=${fileRef}, ` +
          `kind=${data?.base64 ? 'base64' : data?.url ? 'url' : data?.file ? 'file' : 'empty'})`,
      );
      if (data?.base64) return `data:audio/mpeg;base64,${data.base64}`;
      if (data?.url) return String(data.url);
      if (data?.file) return `file://${data.file}`;
    } catch (err) {
      logger.use.debug(`OneBot get_record 转换失败 (file=${fileRef}): ${err}`);
    }
    return att.url;
  }

  function handleMessageEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    // 从 sender 信息累积昵称缓存（在解析消息前，以便 at 标签能查到昵称）
    const sender = (raw.sender ?? raw.user) as Record<string, unknown> | undefined;
    const rawUserId = raw.user_id != null ? String(raw.user_id) : undefined;
    if (rawUserId && sender) {
      const nick = (sender.card as string) || (sender.nickname as string);
      if (nick) {
        // 软上限 FIFO：满了且是新键就淘汰最早一个（Map 按插入序），防无界增长
        if (nicknameCache.size >= NICKNAME_CACHE_MAX && !nicknameCache.has(rawUserId)) {
          const oldest = nicknameCache.keys().next().value;
          if (oldest !== undefined) nicknameCache.delete(oldest);
        }
        nicknameCache.set(rawUserId, nick);
      }
    }

    const fallbackSelfId = state.selfId ?? 'unknown';
    const event = state.protocol.parseMessageEvent(raw, fallbackSelfId, nicknameCache);
    if (!event) {
      // 解析器把消息丢弃（通常是文本为空），打日志暴露原始段类型以便诊断
      const segs = Array.isArray(raw.message)
        ? (raw.message as Array<{ type?: string }>).map(s => String(s?.type ?? '?')).filter(Boolean)
        : [];
      const rawText = typeof raw.raw_message === 'string' ? raw.raw_message : '';
      logger.use.debug(
        `OneBot[${state.protocol.version}] 消息事件被解析器丢弃（text 为空）: post_type=${String(raw.post_type ?? raw.type ?? '?')}, message_type=${String(raw.message_type ?? raw.detail_type ?? '?')}, segments=[${segs.join(',')}], raw_message=${rawText}`,
      );
      return;
    }

    // 更新 selfId
    if (event.selfId !== 'unknown' && !state.selfId) {
      state.selfId = event.selfId;
    }

    if (event.detailType === 'private' && isGroupInviteCard(event.message)) {
      logger.use.debug(
        `OneBot[${state.protocol.version}] 私聊里的入群邀请卡片不入站（与入群邀请事件重复）: userId=${event.userId}`,
      );
      return;
    }

    const sessionId = makeSessionId(
      event.selfId,
      event.detailType,
      event.userId,
      event.groupId,
      event.guildId,
      event.channelId,
    );

    logger.use.debug(
      `OneBot[${state.protocol.version}] 收到消息 [${event.detailType}] ${event.userId ?? '?'}: ${event.text}`,
    );

    // 注：指令解析已迁移到 plugin-commands 的 inbound:command 相位；
    // 适配器只负责将原始消息送入 inbound:message 总线，由 gateway 链路统一拦截。

    // 类型名原样带出实现端给的消息类型：声明里没有的（如部分 v11 实现扩展的 guild）由会话管理按多方记下并告警
    const sessionType = event.detailType;

    // 异步获取群信息、引用消息，然后送入 inbound:message
    (async () => {
      let groupName: string | undefined;
      let replyTo: { messageId: string; content?: string; userId?: string; nickname?: string } | undefined;

      // ----- 统一附件落盘 -----
      // 所有 image / audio / video / file 统一缓存到 data:/{kind}s/{会话目录}/onebot/，
      // 让历史回放、跨轮工具调用、人工归档使用同一份目录布局。
      //
      // 特别地：
      //  - audio：先调 OneBot get_record 把 QQ silk 转成可解码格式（NapCat 等
      //    实现常忽略 out_format 参数，返回 amr 原文），随后本地 ffmpeg
      //    强制转 16kHz mono WAV 再落盘，下游 LLM 直接消费。
      //  - 落盘失败的项保留原 URL，正文里写占位 [图片]/[语音]/...。
      //  - 来源见 segmentSource，语音另经 get_record 换（recordSource）；没有来源的不落盘，附件照留、data 为空。
      const atts = event.attachments ?? [];
      const localPaths: (string | null)[] = await Promise.all(
        atts.map(async att => {
          try {
            const source = att.kind === 'audio' ? await recordSource(state, att) : att.url;
            if (!source) return null;
            const landed = await cacheOneAttachment(
              storage,
              proc,
              att.kind,
              source,
              sessionId,
              attachmentMaxBytes,
              logger.use,
            );
            if (landed && att.kind !== 'audio') {
              rememberLandedAlias(media.present ? media.use : undefined, att.kind, att.url, landed);
            }
            return landed;
          } catch (err) {
            logger.use.debug(`OneBot 附件缓存异常 [${att.kind}]: ${err}`);
            return null;
          }
        }),
      );

      // 落盘了的按段写成 [xxx | ref:data:/...]，重新渲染正文
      const refs = new Map<OneBotMessageSegment, string>();
      atts.forEach((att, i) => {
        const local = localPaths[i];
        if (local) refs.set(att.segment, formatAttachmentRef({ kind: ATTACHMENT_REF_KINDS[att.kind], ref: local }));
      });
      if (refs.size > 0) event.text = segmentsToText(event.message, event.selfId, nicknameCache, seg => refs.get(seg));

      // 主动展开合并转发，LLM 不必再调用工具。展开另放 forwards，正文里留占位：转发里别人的话不算发言人写的，存档拼回原位
      let forwards: ForwardedChat[] = [];
      try {
        forwards = await expandForwards(state, event.message, sessionId);
      } catch (err) {
        logger.use.debug(`合并转发自动展开失败: ${err}`);
      }

      // 获取群名
      if (event.detailType === 'group' && event.groupId) {
        const info = await getGroupInfo(state, event.groupId);
        if (info?.name) groupName = info.name;
      }

      // 获取引用消息内容
      if (event.replyToMessageId) {
        const reply = await fetchReplyMessage(state, event.replyToMessageId, sessionId);
        replyTo = {
          messageId: event.replyToMessageId,
          content: reply?.content,
          userId: reply?.userId,
          nickname: reply?.nickname,
        };
      }

      // 适配器不再做流控/触发判定 —— 一律送入 inbound:message，
      // 由生效的触发插件 / plugin-flow-control 在 inbound:trigger / inbound:flow 相位
      // 决定是否吞噬、归档、或继续派发给 agent。
      // 启动后/重连后通过 shut_up_timestamp 懒查询恢复禁言状态（每会话一次）
      if (sessionType === 'group') {
        void recoverSelfMuteIfNeeded(sessionId);
      }

      // 群消息：拉取 self 在该群的角色/头衔（带缓存），让 agent 正确认知自身权限
      let selfRole: 'owner' | 'admin' | 'member' | undefined;
      let selfTitle: string | undefined;
      if (sessionType === 'group' && event.groupId && state.selfId) {
        const selfInfo = await getSelfMemberInfo(state, state.selfId, event.groupId);
        if (selfInfo) {
          selfRole = selfInfo.role;
          selfTitle = selfInfo.title;
        }
      }

      events.use.emit('inbound:message', {
        content: event.text,
        sessionId,
        platform: 'onebot',
        selfId: event.selfId,
        messageId: event.messageId,
        userId: event.userId,
        nickname: event.nickname,
        attachments: event.attachments?.map((a, i) => {
          // 落盘成功 → data 用本地路径（下游 ffmpeg / vision / audio LLM
          // 都按本地文件读取，避免远程 URL 反复下载与 QQ 鉴权过期）。
          // 落盘失败 → 退回原 URL，下游各自尝试。
          const local = localPaths[i];
          return {
            kind: a.kind,
            data: local ?? a.url,
            // 落盘后的音频统一是 16kHz mono WAV
            mimeType: local && a.kind === 'audio' ? 'audio/wav' : a.mimeType,
            name: a.name,
          };
        }),
        sessionType,
        groupName,
        // 多方窗口的 id：群为群号，频道为 `<guild>:<channel>`（与会话 id 的目标段一致）
        groupId: sessionType === 'channel' ? channelWindowId(event.guildId, event.channelId) : event.groupId,
        senderRole: event.senderRole,
        senderTitle: event.senderTitle,
        selfRole,
        selfTitle,
        replyTo,
        ...(forwards.length > 0 ? { forwards } : {}),
        // triggerType 由生效的触发插件在 inbound:trigger 相位中填充
      });
    })().catch(err => {
      logger.use.warn(`OneBot 消息处理异常: ${err}`);
    });
  }

  // ===== 请求事件处理（加好友 / 加群 / 邀请入群）=====
  // 合成的系统通知带 source：属于系统侧注入，不经触发判定、不过回复后冷却（禁言与限速照常），
  // 在 agent 里各自成一轮，排在同一会话在跑的一轮之后

  function handleRequestEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const req: NormalizedRequestEvent | null = state.protocol.parseRequestEvent(raw, fallbackSelfId);
    if (!req) {
      logger.use.debug(
        `OneBot[${state.protocol.version}] 跳过未识别 request: request_type=${String(raw.request_type ?? raw.detail_type ?? '?')}, sub_type=${String(raw.sub_type ?? '?')}`,
      );
      return;
    }

    const requestLabel = req.requestType === 'group' ? `${req.requestType}/${req.subType}` : req.requestType;
    const requestGroupId = req.requestType === 'group' ? req.groupId : '-';
    logger.use.info(
      `OneBot[${state.protocol.version}] 请求事件: ${requestLabel}, userId=${req.userId}, groupId=${requestGroupId}`,
    );

    if (req.requestType === 'friend') {
      // 存储待处理的好友请求 flag
      pendingFriendRequests.set(friendRequestKey(req.selfId, req.userId), req.flag);

      // 将请求包装为合成消息，交由 agent 决策（以私聊会话形式发送）
      const sessionId = makeSessionId(req.selfId, 'private', req.userId);
      const commentPart = req.comment ? `，验证信息："${escapeMarkup(req.comment)}"` : '';
      const content = `[系统通知] 用户 ${req.userId} 向我发出了好友申请${commentPart}。请决定是否同意，调用 onebot_handle_friend_request 工具处理（user_id="${req.userId}"）。`;
      const text = req.comment
        ? t('friendRequestWithComment', { user: req.userId, comment: req.comment })
        : t('friendRequest', { user: req.userId });

      events.use
        .emit('inbound:message', {
          content,
          text,
          sessionId,
          platform: 'onebot',
          selfId: req.selfId,
          userId: req.userId,
          sessionType: 'private',
          source: REQUEST_SOURCE,
        })
        .catch((err: unknown) => logger.use.warn(`请求事件处理失败: ${err}`));
    } else if (req.requestType === 'group') {
      pendingGroupRequests.set(groupRequestKey(req.selfId, req.subType, req.userId, req.groupId), req.flag);

      // 被邀请入群：以私聊形式通知（bot 还没在群里，无法发群消息）
      const sessionId = makeSessionId(req.selfId, 'private', req.userId);
      const groupPart = `群 ${req.groupId}`;
      const commentPart = req.comment ? `，备注："${escapeMarkup(req.comment)}"` : '';
      const said = { user: req.userId, group: req.groupId };

      let content: string;
      if (req.subType === 'invite') {
        content = `[系统通知] 用户 ${req.userId} 邀请我加入${groupPart}${commentPart}。请决定是否接受邀请，调用 onebot_handle_group_invite 工具处理（user_id="${req.userId}", group_id="${req.groupId}"）。`;
      } else {
        // sub_type === 'add': 有人申请加入 bot 管理的群（bot 是管理员）
        const gsId = makeSessionId(req.selfId, 'group', undefined, req.groupId);
        content = `[系统通知] 用户 ${req.userId} 申请加入${groupPart}${commentPart}。请决定是否同意，调用 onebot_approve_join_request 工具处理（user_id="${req.userId}", group_id="${req.groupId}"）。`;
        events.use
          .emit('inbound:message', {
            content,
            text: req.comment ? t('joinRequestWithComment', { ...said, comment: req.comment }) : t('joinRequest', said),
            sessionId: gsId,
            platform: 'onebot',
            selfId: req.selfId,
            userId: req.userId,
            sessionType: 'group',
            groupId: req.groupId,
            source: REQUEST_SOURCE,
          })
          .catch((err: unknown) => logger.use.warn(`群申请事件处理失败: ${err}`));
        return;
      }

      events.use
        .emit('inbound:message', {
          content,
          text: req.comment ? t('groupInviteWithComment', { ...said, comment: req.comment }) : t('groupInvite', said),
          sessionId,
          platform: 'onebot',
          selfId: req.selfId,
          userId: req.userId,
          sessionType: 'private',
          source: REQUEST_SOURCE,
        })
        .catch((err: unknown) => logger.use.warn(`邀请事件处理失败: ${err}`));
    }
  }

  function handleNoticeEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const notice = state.protocol.parseNoticeEvent(raw, fallbackSelfId);
    if (!notice) {
      logger.use.debug(
        `OneBot[${state.protocol.version}] 跳过未识别 notice: notice_type=${String(raw.notice_type ?? raw.detail_type ?? '?')}, sub_type=${String(raw.sub_type ?? '?')}`,
      );
      return;
    }

    // 过滤高频无用通知（输入状态等）
    if (notice.noticeType === 'notify' && notice.subType === 'input_status') return;

    logger.use.debug(
      `OneBot[${state.protocol.version}] 通知事件: ${notice.noticeType}${notice.subType ? `/${notice.subType}` : ''}`,
    );

    // 所有用户戳一戳共用入站链路；触发插件按目标区分点名与旁观互动。给人看的那句放 text（会话历史画成通知）；
    // 不带 source：带了就按内部注入，不经触发策略。
    if (notice.noticeType === WellKnownNoticeTypes.Poke) {
      const selfId = notice.selfId;
      // 自己发出的动作是工具回显，不作为新用户输入再次触发。
      if (notice.userId === selfId || (!notice.groupId && !notice.userId)) return;
      const sessionType = notice.groupId ? 'group' : 'private';
      const targetIsBot = notice.targetId === selfId || (!notice.groupId && notice.targetId == null);
      (async () => {
        // 两个昵称一起查：入站只等一个来回，与只查戳的人时一样
        const [nick, targetNick] = await Promise.all([
          resolveNickname(state, notice.userId, notice.groupId),
          targetIsBot ? undefined : resolveNickname(state, notice.targetId, notice.groupId),
        ]);
        const user = who(nick, notice.userId, t('someoneSubject'));
        const target = targetIsBot ? '你' : (notice.targetId ?? '某人');
        await events.use.emit('inbound:message', {
          content: `[戳一戳: ${escapeMarkup(toSource(user))} 戳了${target}]`,
          text: targetIsBot
            ? t('poked', { user })
            : t('pokedOther', { user, target: who(targetNick, notice.targetId, t('someone')) }),
          sessionId: makeSessionId(selfId, sessionType, notice.userId, notice.groupId),
          platform: 'onebot',
          selfId,
          userId: notice.userId,
          nickname: nick,
          sessionType,
          groupId: notice.groupId,
          noticeType: WellKnownNoticeTypes.Poke,
          noticeTargetIsSelf: targetIsBot,
        });
      })().catch(err => logger.use.warn(`poke 处理异常: ${err}`));
      return;
    }

    // 群禁言（v11: group_ban / v12: group_member_ban|group_member_unban）
    // 当被禁言的是 bot 自己时，将该群的流控会话静默掉，避免无意义的回复尝试
    if (
      notice.noticeType === 'group_ban' ||
      notice.noticeType === 'group_member_ban' ||
      notice.noticeType === 'group_member_unban'
    ) {
      if (notice.groupId) {
        const isLift = notice.noticeType === 'group_member_unban' || notice.subType === 'lift_ban';
        const isSelf = notice.userId != null && notice.userId === notice.selfId;
        const sessionId = makeSessionId(notice.selfId, 'group', undefined, notice.groupId);
        const duration = Number(notice.data?.duration ?? 0);
        const operatorId = notice.data?.operatorId as string | undefined;

        // 自己被禁言/解禁：通过 flow-control.setMuted 桥接（无 flow-control 时仅维护本地 selfMuted）
        if (isSelf) {
          if (isLift) {
            setSelfMute(sessionId, 0);
            logger.use.info(`[禁言解除] session=${sessionId} 操作者=${operatorId ?? 'unknown'}`);
          } else {
            // 时长未知时按 60s 兜底（旧 flowCfg.muteTimeSeconds 默认值）
            const dur = duration > 0 ? duration : 60;
            setSelfMute(sessionId, dur);
            logger.use.info(
              `[被禁言] session=${sessionId} 时长=${dur}s 操作者=${operatorId ?? 'unknown'}，` +
                `已通知 flow-control 暂停该群触发`,
            );
          }
        }

        // notice 入档（自己 / 他人都记录，便于 agent 感知群内动态）
        (async () => {
          const opNick = await resolveNickname(state, operatorId, notice.groupId);
          const targetNick = isSelf ? undefined : await resolveNickname(state, notice.userId, notice.groupId);
          const op = who(opNick, operatorId, t('adminSubject'));
          const target = isSelf ? t('self') : who(targetNick, notice.userId, t('someone'));
          const verb = isLift ? '解除了禁言' : `禁言了 ${duration > 0 ? `${duration} 秒` : '若干时间'}`;
          const untilTs = isLift ? 0 : duration > 0 ? Date.now() + duration * 1000 : 0;
          const untilLabel = untilTs > 0 ? `（解禁于 ${new Date(untilTs).toISOString()}）` : '';
          const content = `[notice/group_ban${isLift ? '/lift' : ''}] ${toSource(op)} 把 ${toSource(target)} ${verb}${untilLabel}`;
          await archivePlatformNotice({
            sessionId,
            noticeType: notice.noticeType,
            subType: notice.subType,
            content,
            text: isLift
              ? t('banLifted', { op, target })
              : untilTs > 0
                ? t('banned', { op, target, ms: duration * 1000, until: untilTs })
                : t('bannedUnknown', { op, target }),
            userId: notice.userId,
            targetId: notice.userId,
            groupId: notice.groupId,
            operatorId,
            data: { duration, isSelf, isLift, untilTs },
          });
        })().catch(err => logger.use.warn(`group_ban 入档异常: ${err}`));
      }
      return;
    }

    // 消息撤回
    // v11: group_recall / friend_recall
    // v12: group_message_delete (sub_type: recall|delete)
    if (
      notice.noticeType === 'group_recall' ||
      notice.noticeType === 'friend_recall' ||
      notice.noticeType === 'group_message_delete'
    ) {
      const isGroup = notice.noticeType !== 'friend_recall';
      const sessionId = isGroup
        ? makeSessionId(notice.selfId, 'group', undefined, notice.groupId)
        : makeSessionId(notice.selfId, 'private', notice.userId);
      const operatorId = notice.data?.operatorId as string | undefined;
      const messageId = notice.data?.messageId as string | undefined;
      (async () => {
        const userNick = await resolveNickname(state, notice.userId, notice.groupId);
        const opNick = isGroup ? await resolveNickname(state, operatorId, notice.groupId) : undefined;
        const user = who(userNick, notice.userId, t('someoneSubject'));
        const userLabel = toSource(user);
        const opLabel = opNick ? `${opNick}(${operatorId})` : operatorId;
        // 反查被撤回的归档原文：入站消息归档时带 metadata.messageId（archive:meta.messageId）。
        // 显式传 500 条扫描窗（活跃群百条几分钟即滚过，撤回常发生在更久之后）。
        // 查不到（未归档/超窗）或反查抛错都退回旧文案，不阻塞通知入档。
        let original: { content: string; timestamp?: number; senderLabel?: string } | undefined;
        if (messageId) {
          try {
            const found = await (messageArchive.present
              ? messageArchive.use.findByMessageId?.(sessionId, messageId, 500)
              : undefined);
            if (found && typeof found.content === 'string' && found.content) {
              const label = found.metadata?.[WellKnownMetadataKeys.SenderLabel];
              original = {
                content: found.content,
                timestamp: found.timestamp,
                senderLabel: typeof label === 'string' ? label : undefined,
              };
            }
          } catch {
            /* 反查失败不阻塞 */
          }
        }
        const content = buildRecallNoticeContent({ isGroup, userLabel, opLabel, messageId, original });
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          content,
          text: !isGroup
            ? t('recalledPrivate', { user })
            : opLabel && opLabel !== userLabel
              ? t('recalledOther', { op: opLabel, user })
              : t('recalled', { user }),
          userId: notice.userId,
          groupId: notice.groupId,
          operatorId,
          data: { messageId },
        });
      })().catch(err => logger.use.warn(`recall 入档异常: ${err}`));
      return;
    }

    // 群成员增减
    if (
      notice.noticeType === 'group_increase' ||
      notice.noticeType === 'group_decrease' ||
      notice.noticeType === 'group_member_increase' ||
      notice.noticeType === 'group_member_decrease'
    ) {
      if (!notice.groupId) return;
      const isJoin = notice.noticeType === 'group_increase' || notice.noticeType === 'group_member_increase';
      const sessionId = makeSessionId(notice.selfId, 'group', undefined, notice.groupId);
      const operatorId = notice.data?.operatorId as string | undefined;
      const isSelf = notice.userId != null && notice.userId === notice.selfId;
      (async () => {
        const userNick = await resolveNickname(state, notice.userId, notice.groupId);
        const opNick = await resolveNickname(state, operatorId, notice.groupId);
        const user = isSelf ? t('selfSubject') : who(userNick, notice.userId, t('someoneSubject'));
        const opLabel = opNick ? `${opNick}(${operatorId})` : operatorId;
        let text: TextRef;
        if (isJoin) {
          text =
            notice.subType === 'invite' && opLabel ? t('joinedInvited', { user, op: opLabel }) : t('joined', { user });
        } else {
          if (notice.subType === 'kick' && opLabel) text = t('removed', { user, op: opLabel });
          else if (notice.subType === 'kick_me') text = t('removed', { user, op: opLabel ?? t('admin') });
          else text = t('left', { user });
        }
        const content = `[notice/${notice.noticeType}${notice.subType ? `/${notice.subType}` : ''}] ${toSource(text)}`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          subType: notice.subType,
          content,
          text,
          userId: notice.userId,
          groupId: notice.groupId,
          operatorId,
          data: { isSelf },
        });
      })().catch(err => logger.use.warn(`group_member 变动 入档异常: ${err}`));
      return;
    }

    // 群管理员变动
    if (notice.noticeType === 'group_admin' || notice.noticeType === 'group_member_admin') {
      if (!notice.groupId) return;
      const sessionId = makeSessionId(notice.selfId, 'group', undefined, notice.groupId);
      const isSelf = notice.userId != null && notice.userId === notice.selfId;
      const isSet = notice.subType === 'set' || notice.subType === 'unban' /* spurious */;
      (async () => {
        const userNick = await resolveNickname(state, notice.userId, notice.groupId);
        const user = isSelf ? t('selfSubject') : who(userNick, notice.userId, t('someoneSubject'));
        const text =
          notice.subType === 'set'
            ? t('adminSet', { user })
            : notice.subType === 'unset'
              ? t('adminUnset', { user })
              : t('adminChanged', { user });
        const content = `[notice/group_admin/${notice.subType ?? 'change'}] ${toSource(text)}`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          subType: notice.subType,
          content,
          text,
          userId: notice.userId,
          groupId: notice.groupId,
          data: { isSelf, isSet },
        });
      })().catch(err => logger.use.warn(`group_admin 入档异常: ${err}`));
      return;
    }

    // 好友添加
    if (notice.noticeType === 'friend_add' || notice.noticeType === 'friend_increase') {
      if (!notice.userId) return;
      const sessionId = makeSessionId(notice.selfId, 'private', notice.userId);
      (async () => {
        const userNick = await resolveNickname(state, notice.userId);
        const text = t('friendAdded', { user: who(userNick, notice.userId, t('someoneSubject')) });
        const content = `[notice/${notice.noticeType}] ${toSource(text)}`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          content,
          text,
          userId: notice.userId,
        });
      })().catch(err => logger.use.warn(`friend_add 入档异常: ${err}`));
      return;
    }

    // 群文件上传 → 转化为 inbound:message；给人看的那句与不带 source 同戳一戳
    if (notice.noticeType === 'group_upload' && notice.groupId) {
      const selfId = notice.selfId;
      const sessionId = makeSessionId(selfId, 'group', notice.userId, notice.groupId);
      const fileName = notice.data?.fileName;
      const content = `[文件上传: ${notice.userId} 上传了 ${fileName == null ? '未知文件' : escapeMarkup(String(fileName))}]`;

      (async () => {
        const nick = await resolveNickname(state, notice.userId, notice.groupId);
        await events.use.emit('inbound:message', {
          content,
          text: t('uploaded', {
            user: who(nick, notice.userId, t('someoneSubject')),
            file: fileName == null ? t('unknownFile') : String(fileName),
          }),
          sessionId,
          platform: 'onebot',
          selfId,
          userId: notice.userId,
          sessionType: 'group',
          groupId: notice.groupId,
          noticeType: 'group_upload',
        });
      })().catch(err => logger.use.warn(`group_upload 处理异常: ${err}`));
      return;
    }
  }

  function handleMetaEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const meta = state.protocol.parseMetaEvent(raw);

    if (meta.subType === 'connect' || meta.subType === 'lifecycle') {
      logger.use.debug(`OneBot[${state.protocol.version}] meta 事件: ${meta.subType}`);
      if (meta.selfId && !state.selfId) {
        state.selfId = meta.selfId;
        logger.use.info(`OneBot self_id (via meta): ${state.selfId}`);
      }
      if (meta.version) {
        logger.use.info(
          `OneBot 实现: ${meta.version.impl ?? 'unknown'} v${meta.version.version ?? '?'} (onebot ${meta.version.onebot_version ?? '?'})`,
        );
      }
    } else if (meta.subType === 'heartbeat') {
      // 心跳事件不输出日志
    } else if (meta.subType === 'status_update') {
      logger.use.debug(`OneBot[${state.protocol.version}] 状态更新事件`);
    } else {
      logger.use.debug(`OneBot[${state.protocol.version}] 跳过未识别 meta 事件: sub_type=${meta.subType ?? '?'}`);
    }
  }

  // ----- 群聊时间感知提示 + 特殊事件触发上下文 -----
  // 群聊中多人消息平铺在历史中，注入提示帮助模型关注时间线
  // 特殊事件（戳一戳、群文件上传）转成的入站进了这一轮时注入说明，让模型知道触发原因：按入站自带的事件种类认，不看正文
  const noticeHints: Array<{ noticeType: string; hint: string }> = [
    {
      noticeType: WellKnownNoticeTypes.Poke,
      hint: '这条消息是平台的「戳一戳」互动通知，不是用户输入的文字。请根据正文中的发起者和被戳对象理解事件，不要把群友互戳当成有人戳你。',
    },
    { noticeType: 'group_upload', hint: '这条消息不是用户手动输入的文字，而是一个文件上传通知事件。' },
  ];

  /**
   * 该会话是否该由本插件实例出声——多实例（reusable）下各管各的会话，避免
   * 每个实例都注一份同样的提示。
   *
   * 判定取"疑罪从无"：只有当 selfId 明确指向**别的**实例时才拒绝。selfId 尚未
   * 握手获取时 sessionId 会以 'unknown' 兜底（见 fallbackSelfId），这种判不出
   * 归属的情形一律放行——宁可多实例下偶有重复，也不让单实例场景静默缺提示。
   */
  function ownsSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const parsed = parseSessionId(sessionId);
    if (!parsed) return false;
    if (findStateBySelfId(parsed.selfId)) return true;
    return parsed.selfId === 'unknown' || states.every(s => s.selfId == null);
  }

  // 群提示 + 事件提示同属 turn-hint 槽（落点 = 最后一条 user 消息之前）。
  // 合成**一个**贡献返回多块：同槽多贡献按全局键排序、槽内顺序无语义，而这两块
  // 有位置语义——事件提示的"这条消息"必须紧贴它描述的那条 user 消息（组装器把
  // 多块保序物化，故事件提示恒为末块）。幂等由组装器按全局键保障。
  contributions.use.contribute('agent:prompt', {
    id: 'platform-hint',
    anchor: 'turn-hint',
    build(view) {
      // 会话不属于本实例就不出声——否则多账号并存时每个实例都注一份重复提示
      if (!ownsSession(view.sessionId)) return null;
      const blocks: string[] = [];

      // 多方的聊天窗口（群与频道）：按会话 id 里的类型查本平台声明的多方标记
      const type = parseSessionId(view.sessionId ?? '')?.detailType;
      if (SESSION_TYPES.some(decl => decl.name === type && decl.multiParty)) {
        // 措辞不用「以上」——本块落点在检索材料/状态块之后，位置指代会把
        // 非历史的注入材料错误圈进去；按内容指称写成位置无关的表述。
        blocks.push(
          '注意：本轮上下文中的群聊历史记录包含多位群友的发言。' +
            '请留意消息的时间先后顺序，优先关注近期的对话内容和上下文。',
        );
      }

      // 特殊事件触发上下文：这一轮有一条输入是这种事件时说明缘由
      for (const { noticeType, hint } of noticeHints) {
        if (view.inputs.some(({ message }) => message.noticeType === noticeType)) blocks.push(hint);
      }

      return blocks.length > 0 ? blocks : null;
    },
  });

  // ----- 监听消息回复事件 -----

  /**
   * 投递失败回报给 agent：写一条系统提示进会话记忆，让它下一轮知晓刚才那条没送达或结果未知，而不是误以为已发成功。被动记录，
   * 不立即触发回复；每条出站消息至多一条。逐条发出停在中途（前面有已发出的，或后面还有没发的）时写明前几条已经发出、不要整条
   * 重发，整条重发会让它们在群里出现两遍；resendFrom 是后面还有没发的时从哪条补起。failed 是另有确定没发出的（停在中途时不算
   * 停下的那几条）。记录带投递结果的原因、已发出的条数、结果未知的名单与这条消息的回合或调用 id，回看历史时据此标出哪条没发出
   */
  function reportUndelivered(
    msg: OutgoingMessage,
    result: { error: TextRef; sentPieces?: number },
    failed: boolean,
    resendFrom: number | undefined,
    unconfirmed: readonly TextRef[],
  ): void {
    if (msg.source !== 'agent') return;
    let content = '[投递回报] ';
    const partial = result.sentPieces !== undefined || resendFrom !== undefined;
    if (partial) {
      content +=
        `${result.sentPieces ? `前 ${result.sentPieces} 条已经发出，` : ''}` +
        `${resendFrom === undefined ? '' : `从第 ${resendFrom} 条起没有送达；要补就只补没发出的部分，`}不要整条重发。`;
    }
    if (failed) {
      content += partial
        ? '另有图片、媒体或文件未能送达对方，如确有必要可补发或改用文字说明。'
        : '你刚才发送的内容(可能包含图片、媒体或文件)未能送达对方。' +
          '如确有必要可稍后重发或改用文字说明;不必反复道歉或刷屏。';
    }
    const pending = unconfirmed.map(toSource);
    if (pending.length) {
      content += `这些已发出但没等到确认，结果未知，可能已经送达；不要重发，以免出现两份：${pending.join('、')}。`;
    }
    const note: Message = {
      role: 'system',
      kind: WellKnownKinds.OutboundDeliveryFailed,
      content,
      timestamp: Date.now(),
      metadata: {
        [WellKnownMetadataKeys.Source]: 'adapter-onebot',
        [WellKnownMetadataKeys.DeliveryError]: truncateParams(result.error, 200),
        ...(result.sentPieces ? { [WellKnownMetadataKeys.SentPieces]: result.sentPieces } : {}),
        [WellKnownMetadataKeys.Unconfirmed]: pending,
        ...(msg.turnId ? { [WellKnownMetadataKeys.TurnId]: msg.turnId } : {}),
        ...(msg.callId ? { [WellKnownMetadataKeys.CallId]: msg.callId } : {}),
      },
    };
    void Promise.resolve()
      .then(() => (messageArchive.present ? messageArchive.use.saveMessage(msg.sessionId, note) : undefined))
      .catch(e => logger.use.debug(`投递失败提示入档失败: ${e}`));
  }

  events.use.on('outbound:message', msg => {
    // 多个适配器实例只认领自己的连接（与会话路由同一判断）；离线的已知连接仍需返回明确失败。
    if (msg.delivery || !ownsAccount(msg.sessionId)) return;
    // 同步交出回执，实际发送可在后台执行，不阻塞出站旁观者。
    msg.delivery = deliverOutbound(msg);
  });

  async function deliverOutbound(msg: OutgoingMessage): Promise<OutboundDeliveryResult> {
    const errors: unknown[] = [];
    /** 已经发出、没等到确认的各项（消息按条、文件按名）：实现端可能已经收下，只能报「结果未知」，不能劝重发 */
    const unconfirmed: TextRef[] = [];
    const delivered: MessageAttachment[] = [];
    let textSent = false;
    /** 正文各条的平台消息 id */
    let messageIds: string[] = [];
    /** 正文各条与附件的消息段逐条发：共几条、已发出几条、停下那一条的错误 */
    let total = 0;
    let sentPieces = 0;
    let stopped: unknown;
    try {
      // 她的回复：正文里的媒体段与附件里的媒体（image-sender 把存储地址的标记转成的）合计有上限，多出的不读、不下载
      const plain = toPieces(msg.content ?? '', msg.markup);
      const reply = msg.markup ? capReplyMedia(plain, msg.attachments ?? [], logger.use) : undefined;
      const attachments = reply?.attachments ?? msg.attachments ?? [];
      let attachmentPieces: OutgoingPiece[] = [];
      let inlineAttachments: MessageAttachment[] = [];
      const uploads: Array<{ file: string; name: string; attachment: MessageAttachment }> = [];
      if (attachments.length) {
        // 缓存与发送仍经 storage 和受保护下载；落盘的副本只用来发，原来的地址留在 ref 上，送达之后记进历史的是它。读取与下载
        // 同时最多 MEDIA_FETCH_CONCURRENCY 个，按附件的先后排队
        const cache = createConcurrencyLimited(
          (att: MessageAttachment) =>
            cacheOneAttachment(storage, proc, att.kind, att.data, msg.sessionId, attachmentMaxBytes, logger.use),
          MEDIA_FETCH_CONCURRENCY,
        );
        await Promise.all(
          attachments.map(async att => {
            try {
              const local = await cache(att);
              if (local) {
                rememberLandedAlias(media.present ? media.use : undefined, att.kind, att.data, local);
                const address = outboundAddress(att);
                if (address) att.ref = address;
                att.data = local;
                if (att.kind === 'audio') att.mimeType = 'audio/wav';
              }
            } catch (err) {
              logger.use.debug(`OneBot 出站附件缓存异常 [${att.kind}]: ${err}`);
            }
          }),
        );
        const materialized = await materializeAttachments(attachments, storage, logger.use);
        attachmentPieces = materialized.segments.map(segment => ({ text: '', segments: [segment] }));
        inlineAttachments = materialized.inlineAttachments;
        uploads.push(...materialized.uploads);
        errors.push(...materialized.errors);
      }
      // 她回复里的媒体段在后台按先后下载，正文逐条等、等到一条发一条：前面的文字不等后面的下载
      const inlined = reply ? inlineMarkupMedia(reply.pieces, storage, logger.use) : undefined;
      const pieces = inlined?.pieces ?? plain;

      // 正文按 markup 发；附件物化出的消息段接在后面各自单独成一条，不拼成标记、不经正文媒体段的那道过滤。逐条发，一条没发成
      // 就停，后面的（含附件的消息段）不再发
      const attempt = (list: (OutgoingPiece | Promise<OutgoingPiece | undefined>)[], replyTo?: string) =>
        sendPieces(msg.sessionId, list, replyTo).catch((failure: unknown) => ({ messageIds: [], sent: 0, failure }));
      if (pieces.length) {
        logger.use.debug(`OneBot 发送消息 [${msg.sessionId}]: ${msg.content}`);
        const body = await attempt(pieces, msg.replyTo);
        messageIds = body.messageIds;
        sentPieces = body.sent;
        stopped = body.failure;
        textSent = stopped === undefined && body.sent > 0;
      }
      // 停在中途时后面的条可能还在下载：都落定了才数得出共几条、收齐去掉的原因
      if (reply?.error) errors.push(reply.error);
      if (inlined) errors.push(...(await inlined.errors));
      total = (await Promise.all(pieces)).filter(piece => piece !== undefined).length + attachmentPieces.length;
      if (attachmentPieces.length && stopped === undefined) {
        const media = await attempt(attachmentPieces, sentPieces ? undefined : msg.replyTo);
        delivered.push(...inlineAttachments.slice(0, media.sent));
        sentPieces += media.sent;
        stopped = media.failure;
      }
      if (stopped !== undefined) {
        logger.use.warn(`OneBot 发送消息失败（共 ${total} 条，已发出 ${sentPieces} 条）: ${stopped}`);
      }
      for (const { file, name, attachment } of uploads) {
        try {
          await adapter.uploadFile(msg.sessionId, file, name);
          delivered.push(attachment);
        } catch (err) {
          logger.use.warn(`OneBot 上传文件失败 [${name}]: ${err}`);
          if (err instanceof ActionUnconfirmedError) unconfirmed.push(t('unconfirmedFile', { name }));
          else errors.push(err);
        }
      }
    } catch (err) {
      // 交出回执后的所有异常都转为结果，防止后台 Promise 拒绝或调用方永远等不到。
      errors.push(err);
    }

    // 停在中途：停下那一条没等到回执的记结果未知。一条都没发出的照原因报；前面有发出或结果未知、后面还有没发的，写明从第几条起
    // 没发出，她补发时只补后面的
    const unknown = stopped instanceof ActionUnconfirmedError;
    let resendFrom: number | undefined;
    if (stopped !== undefined) {
      const from = sentPieces + (unknown ? 2 : 1);
      if (unknown) unconfirmed.unshift(t('unconfirmedMessage', { n: sentPieces + 1 }));
      if (!sentPieces && !unknown) errors.push(stopped);
      else if (from <= total) resendFrom = from;
    }
    // 回报另说的确定失败：停在中途时只算停下那几条之外的（附件、正文里的媒体、上传的文件）
    const failed = errors.length > 0;
    // 确定没发出的各条原因：接住的报错逐条取文字对象或原话。停下那一条之后的没发出：已发出的条数随 sentPieces 交出，原因只写
    // 停下那一条的原话；那一条结果未知时它在名单里，这里写从第几条起没发出
    const reasons = errors.map(textOf);
    if (resendFrom !== undefined) reasons.push(unknown ? t('notSentFrom', { from: resendFrom }) : textOf(stopped));

    if (textSent || delivered.length) {
      // 存档据此把送达的部分记进会话历史：只交成功附件的快照，失败的图片不能写成“已发送”历史。
      void events.use.emit('outbound:delivered', {
        ...msg,
        delivery: undefined,
        content: textSent ? msg.content : '',
        attachments: delivered.map(att => ({ ...att })),
      });
    }
    if (reasons.length || unconfirmed.length) {
      // 投递结果的原因：确定没发出的各条以「; 」相连成一句，与结果未知的一句并列相连
      const problems: (string | TextRef)[] = [];
      if (reasons.length) problems.push(joinReasons(reasons));
      if (unconfirmed.length) problems.push(t('unconfirmed', { items: unconfirmed }));
      const result = {
        ok: false as const,
        error: textClauses(problems),
        ...(stopped !== undefined && sentPieces ? { sentPieces } : {}),
        // 有结果未知的部分就带，不论另有没有确定没发出的：那几项可能已经送达，发起方不得整条重发
        ...(unconfirmed.length ? { unconfirmed: true as const } : {}),
      };
      reportUndelivered(msg, result, failed, resendFrom, unconfirmed);
      return result;
    }
    if (!textSent && !delivered.length) return { ok: false, error: t('nothingToSend') };
    return messageIds.length ? { ok: true, messageIds } : { ok: true };
  }

  // ----- 生命周期 -----

  events.use.on('app:ready', () => {
    for (const connConfig of connections) {
      if (!connConfig.url) {
        logger.use.warn('OneBot 连接配置缺少 url，跳过');
        continue;
      }
      connectOne(connConfig);
    }
  });

  lifecycle.use.onDispose(() => {
    selfMuted.clear();
    muteRecoveryChecked.clear();
    nicknameCache.clear();

    for (const state of states) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      stopHeartbeat(state);
      if (state.ws) {
        state.ws.removeAllListeners();
        // removeAllListeners 摘掉了 'error' 监听，而下面 terminate() 对 CONNECTING 套接字走
        // abortHandshake → process.nextTick(emit('error'))，close() 路径的套接字错误同理。
        // 无监听器的 'error' 会从 nextTick 抛成 uncaughtException，被 runtime 的处理器判为
        // 致命并结束进程——bounce 撞上握手在途即整个实例退出（脚本实测复现）。
        // 拆卸期的错误无需处理，只需有人接。
        state.ws.on('error', () => {});
        if (state.ws.readyState === 0 /* CONNECTING */) {
          state.ws.terminate();
        } else {
          state.ws.close();
        }
      }
      const settled = settlePendingActions(state.pendingActions, '适配器已停止');
      if (settled > 0) logger.use.debug(`适配器停止：拒绝 ${settled} 个在飞 action`);
    }
    states.length = 0;
  });
}

export default definePlugin({
  name: '@aalis/plugin-adapter-onebot',
  displayName: t('displayName'),
  subsystem: 'platform',
  configSchema,
  reusable: true,
  provides: [platform],
  uses,
  apply: runAdapter,
});
