import type { ConfigSchema, Context } from '@aalis/core';
import type { FlowControlService } from '@aalis/plugin-flow-control-api';
import type { MediaService } from '@aalis/plugin-media-api';
import { AttachmentRefKind, formatAttachmentRef, getSenderLabel, type Message } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import type { PlatformAdapter, PlatformConnection } from '@aalis/plugin-platform-api';
import { createProcessGateway } from '@aalis/plugin-process-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import WebSocket from 'ws';
import {
  cacheAttachmentBuffer,
  detectExtensionFromBuffer,
  loadAttachmentBuffer,
  transcodeAudioBufferToWav,
} from './attachment-cache.js';
import { renderAttachmentsAsContentMarkers } from './attachments.js';
import { extractSentMessageId, SentMessageTracker } from './sent-messages.js';
import type {
  NormalizedRequestEvent,
  OneBotActionResponse,
  OneBotConnectionConfig,
  OneBotProtocol,
  OneBotRawEvent,
} from './types.js';
import '@aalis/plugin-agent-api';
import { createForwardExpander, DEFAULT_FORWARD_SUMMARY_PROMPT, type ForwardConfig } from './forward-expand.js';
import { segmentsToText } from './types.js';
import { OneBotV11 } from './v11.js';

/**
 * 从原始配置对象中解析出 forward 子配置。
 */
function parseForwardConfig(config: Record<string, unknown>): ForwardConfig {
  const fwdRaw = (config.forward ?? {}) as Record<string, unknown>;
  return {
    enabled: fwdRaw.enabled !== false,
    maxDepth: typeof fwdRaw.maxDepth === 'number' ? Math.max(1, Math.floor(fwdRaw.maxDepth)) : 3,
    maxNodesPerLevel:
      typeof fwdRaw.maxNodesPerLevel === 'number' ? Math.max(1, Math.floor(fwdRaw.maxNodesPerLevel)) : 30,
    imageRecognition: fwdRaw.imageRecognition !== false,
    imageRecognitionConcurrency:
      typeof fwdRaw.imageRecognitionConcurrency === 'number'
        ? Math.max(1, Math.floor(fwdRaw.imageRecognitionConcurrency))
        : 8,
    summarize: fwdRaw.summarize !== false,
    summaryLLM:
      fwdRaw.summaryLLM &&
      typeof fwdRaw.summaryLLM === 'object' &&
      (fwdRaw.summaryLLM as { provider?: unknown }).provider &&
      (fwdRaw.summaryLLM as { model?: unknown }).model
        ? (fwdRaw.summaryLLM as { provider: string; model: string })
        : undefined,
    summaryMaxChars:
      typeof fwdRaw.summaryMaxChars === 'number' ? Math.max(80, Math.floor(fwdRaw.summaryMaxChars)) : 600,
    summaryInputLimit:
      typeof fwdRaw.summaryInputLimit === 'number' ? Math.max(0, Math.floor(fwdRaw.summaryInputLimit)) : 8000,
    summaryPrompt: typeof fwdRaw.summaryPrompt === 'string' ? fwdRaw.summaryPrompt : '',
  };
}

import { OneBotV12 } from './v12.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-adapter-onebot';
export const displayName = 'OneBot 适配器';
export const subsystem = 'platform';
export const inject = {
  required: ['storage', 'process'],
  optional: ['llm', 'commands', 'message-archive', 'persona', 'flow-control'],
};
export const provides = ['platform'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  connections: {
    type: 'array',
    label: '连接列表',
    description: '配置一个或多个 OneBot WebSocket 连接',
    items: {
      url: { type: 'string', label: 'WebSocket 地址', required: true, description: '如 ws://127.0.0.1:8080' },
      accessToken: { type: 'string', label: '鉴权 Token', secret: true, description: '可选，与 OneBot 实现端一致' },
      selfId: { type: 'string', label: '机器人 ID', description: '可选，连接后自动获取' },
      protocol: {
        type: 'string',
        label: '协议版本',
        description: '选择 OneBot 协议版本：v11、v12 或 auto（自动检测）',
        default: 'auto',
      },
    },
    default: [],
  },
  splitMessage: {
    label: '消息分条发送',
    description: '启用后，文本将按选中的符号自动拆分为多条消息发送，模拟真人发送习惯',
    fields: {
      enabled: { type: 'boolean', label: '启用', description: '是否启用消息分条发送', default: false },
      delayPerChar: {
        type: 'number',
        label: '每字延迟 (ms)',
        description: '按下一条消息的字数计算延迟，单位毫秒/字',
        default: 50,
      },
      maxDelay: {
        type: 'number',
        label: '最大延迟 (ms)',
        description: '分条消息之间的最大延迟上限（毫秒）',
        default: 3000,
      },
      patterns: {
        type: 'multiselect',
        label: '切割模式',
        description:
          '在匹配到这些字符串的位置之后进行切割。每一项是一个完整的字符串：单字符（如 。）就在该字符后切；多字符（如 ". "、".\\n"）则要整段匹配到才切。支持转义：\\n=换行，\\t=制表符，\\r=回车，\\\\=反斜杠。',
        allowCustom: true,
        options: [
          { label: '。 中文句号', value: '。' },
          { label: '！ 中文感叹号', value: '！' },
          { label: '？ 中文问号', value: '？' },
          { label: '； 中文分号', value: '；' },
          { label: '， 中文逗号', value: '，' },
          { label: '、 顿号', value: '、' },
          { label: '. 英文句号', value: '.' },
          { label: '. ␣ 英文句号+空格（避免小数点误拆）', value: '. ' },
          { label: '! 英文感叹号', value: '!' },
          { label: '? 英文问号', value: '?' },
          { label: '; 英文分号', value: ';' },
          { label: ', 英文逗号', value: ',' },
          { label: ', ␣ 英文逗号+空格（避免 1,000 误拆）', value: ', ' },
          { label: '↵ 换行 (\\n)', value: '\\n' },
          { label: '⇥ 制表符 (\\t)', value: '\\t' },
          { label: '␣ 空格', value: ' ' },
        ],
        default: ['。', '！', '？', '.', '!', '?', '\\n'],
      },
    },
  },
  forward: {
    label: '合并转发处理',
    description: '收到 <forward> 消息时如何展开、是否调用图像识别、是否调用 LLM 生成摘要',
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用自动展开',
        default: true,
        description: '关闭后保留原始占位符，由 LLM 自行决定是否调工具读取。',
      },
      maxDepth: {
        type: 'number',
        label: '嵌套深度上限',
        default: 3,
        description: '递归展开嵌套合并转发的最大层数（顶层=1）。',
      },
      maxNodesPerLevel: {
        type: 'number',
        label: '单层节点上限',
        default: 30,
        description: '每层最多展开多少条节点。超过部分会被截断。',
      },
      imageRecognition: {
        type: 'boolean',
        label: '识别内部图片',
        default: true,
        description: '把转发内的图片送入 media 服务转写为文字描述。需要该服务可用。',
      },
      imageRecognitionConcurrency: {
        type: 'number',
        label: '图片识别并发上限',
        default: 8,
        description: '同一条合并转发内允许同时进行的图片识别任务数。过高可能压垮上游模型；过低会拖慢长转发展开。',
      },
      summarize: {
        type: 'boolean',
        label: '生成摘要',
        default: true,
        description: '展开后调用 LLM 生成一段摘要，作为消息正文进入对话/记忆/向量库；原文保留在缓存。',
      },
      summaryLLM: {
        type: 'llm-ref',
        label: '摘要模型',
        description: '留空使用默认 LLM 服务；指定后按 (provider, model) 精确定位。建议挑便宜/快的模型。',
      },
      summaryMaxChars: {
        type: 'number',
        label: '摘要最大字数',
        default: 600,
        description: '提示给摘要模型的目标长度上限。模型被允许超出 10% 以保留多人互动结构。',
      },
      summaryInputLimit: {
        type: 'number',
        label: '摘要原文输入上限（字符）',
        default: 8000,
        description:
          '喂给摘要模型的原文输入上限；原文超过则前段截断。设为 0 表示不截断（注意超长文本会增加摘要成本）。',
      },
      summaryPrompt: {
        type: 'textarea',
        label: '摘要 system prompt（高级，留空使用内置）',
        default: '',
        description: `留空使用内置默认 prompt（专为保留多人互动结构调优过）。填入非空内容则完全覆盖默认 prompt。\n\n内置默认 prompt 如下，可作为撰写参考：\n\n${DEFAULT_FORWARD_SUMMARY_PROMPT}`,
      },
    },
  },
  reply: {
    label: '引用消息处理',
    description: '收到引用回复时如何展开被引用消息链',
    fields: {
      maxDepth: {
        type: 'number',
        label: '引用链深度上限',
        default: 5,
        description: '递归获取被引用消息的最大层数。1 = 只读取直接引用；2 = 继续读取直接引用所引用的消息，依此类推。',
      },
    },
  },
  attachmentCache: {
    label: '附件本地缓存',
    description:
      '入站 / 出站的 image / audio / video / file 统一缓存到 data/{kind}s/{session}/，与图片目录布局一致，便于人工归档与多轮工具复用',
    fields: {
      maxBytes: {
        type: 'number',
        label: '单文件大小上限 (Byte)',
        default: 10 * 1024 * 1024,
        description: '超过此尺寸的附件不落盘，保留原 URL（典型场景：长视频）。默认 10 MiB。',
      },
    },
  },
};

export const defaultConfig = {
  connections: [] as OneBotConnectionConfig[],
  splitMessage: {
    enabled: false,
    delayPerChar: 50,
    maxDelay: 3000,
    patterns: ['。', '！', '？', '.', '!', '?', '\\n'] as string[],
  },
  forward: {
    enabled: true,
    maxDepth: 3,
    maxNodesPerLevel: 30,
    imageRecognition: true,
    imageRecognitionConcurrency: 8,
    summarize: true,
    summaryMaxChars: 600,
    summaryPrompt: '',
  },
  reply: {
    maxDepth: 5,
  },
  attachmentCache: {
    maxBytes: 10 * 1024 * 1024,
  },
};

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
      resolve: (data: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
}

// ===== 聊天流控类型（已迁移）=====
//
// 旧的 ChatFlowConfig / FlowSessionState / 流控函数已抽出到独立插件：
//   - @aalis/plugin-flow-control   （计数 / 冷却 / 限速 / idle 调度）
//   - @aalis/plugin-trigger-policy （@/名字检测 + 间隔/评分判定）
// 适配器只保留两个最小桥接：
//   - 群禁言事件 → ctx.getService<FlowControlService>('flow-control').setMuted()
//   - shut_up_timestamp 启动恢复 → 同上
// 其他路径全部走 inbound:command/flow/trigger/dispatch 生命周期相位。

// ===== 工具函数 =====

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
    targetId = `${guildId ?? 'unknown'}:${channelId ?? 'unknown'}`;
  } else {
    targetId = 'unknown';
  }
  return `onebot:${selfId}:${detailType}:${targetId}`;
}

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
// 历史上只有 image 落盘到 data/images/，audio/video/file 直接传 URL；
// 现统一到 data/{kind}s/{session}/{hash}.{ext}，便于人工归档、跨轮工具复用、
// 多模态历史回放。详见 ./attachment-cache.ts。

/** 占位符 → AttachmentRefKind 映射（与 v11/v12 segmentsToText 的输出对齐） */
const KIND_PLACEHOLDER: Record<'image' | 'audio' | 'video' | 'file', { placeholder: string; ref: AttachmentRefKind }> =
  {
    image: { placeholder: '[图片]', ref: AttachmentRefKind.Image },
    audio: { placeholder: '[语音]', ref: AttachmentRefKind.Audio },
    video: { placeholder: '[视频]', ref: AttachmentRefKind.Video },
    file: { placeholder: '[文件]', ref: AttachmentRefKind.File },
  };

/**
 * 把单个附件下载（必要时转码）后落盘，返回相对路径。失败返回 null。
 * - audio：先 ffmpeg → 16kHz mono WAV，再以 .wav 入库（用户期望转码后存储，
 *   方便后续 LLM 反复分析；同时避免下游每次重转码）。
 * - 其他 kind：原样落盘，扩展名按 magic header 推断。
 */
async function cacheOneAttachment(
  storage: import('@aalis/plugin-storage-api').StorageService,
  proc: import('@aalis/plugin-process-api').ProcessService,
  kind: 'image' | 'audio' | 'video' | 'file',
  source: string,
  sessionId: string,
  maxBytes: number,
  logger: Context['logger'],
): Promise<string | null> {
  const buf = await loadAttachmentBuffer(storage, proc, source, maxBytes);
  if (!buf) return null;
  if (kind === 'audio') {
    const inExt = detectExtensionFromBuffer(buf, 'bin');
    const wav = await transcodeAudioBufferToWav(proc, storage, buf, inExt);
    if (!wav) {
      logger.warn(`OneBot 音频转 WAV 失败 (in=${inExt}, size=${buf.byteLength}B)，保留原 URL`);
      return null;
    }
    return await cacheAttachmentBuffer(storage, wav, 'audio', sessionId, 'wav', maxBytes);
  }
  const ext = detectExtensionFromBuffer(buf, kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'bin');
  return await cacheAttachmentBuffer(storage, buf, kind, sessionId, ext, maxBytes);
}

/**
 * 把 text 中所有 [图片]/[语音]/[视频]/[文件] 占位按 attachments 顺序替换为
 * `[xxx | ref:data/...]`。落盘失败的占位保持原样。
 */
function rewritePlaceholdersWithRefs(
  text: string,
  attachments: ReadonlyArray<{ kind: 'image' | 'audio' | 'video' | 'file' }>,
  localPaths: ReadonlyArray<string | null>,
): string {
  // 按 kind 分桶维护游标
  const cursors: Record<'image' | 'audio' | 'video' | 'file', number> = { image: 0, audio: 0, video: 0, file: 0 };
  const slotsByKind: Record<'image' | 'audio' | 'video' | 'file', (string | null)[]> = {
    image: [],
    audio: [],
    video: [],
    file: [],
  };
  attachments.forEach((a, i) => {
    slotsByKind[a.kind].push(localPaths[i]);
  });

  let out = text;
  for (const kind of ['image', 'audio', 'video', 'file'] as const) {
    const { placeholder, ref } = KIND_PLACEHOLDER[kind];
    const pattern = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(pattern, 'g'), () => {
      const slot = slotsByKind[kind][cursors[kind]++];
      return slot ? formatAttachmentRef({ kind: ref, ref: slot }) : placeholder;
    });
    // 占位符比 attachments 少时：把多出的 ref 追加到末尾，确保不丢
    const remaining = slotsByKind[kind].slice(cursors[kind]);
    for (const slot of remaining) {
      if (slot) out += formatAttachmentRef({ kind: ref, ref: slot });
    }
  }
  return out;
}

// ===== 协议版本实例 =====
const protocolV11 = new OneBotV11();
const protocolV12 = new OneBotV12();

// ===== 重连配置 =====
const RECONNECT_INTERVAL = 5000;
const ACTION_TIMEOUT = 30000;
const INVITE_CARD_SUPPRESS_WINDOW = 2 * 60 * 1000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 15000;

// ===== 消息分条逻辑 =====

/**
 * 解析「切割模式列表」：每项是一个字符串，按 JS 风格解码转义序列
 * （\\n→换行、\\t→制表符、\\r→回车、\\\\→反斜杠）。空串与重复项被忽略。
 */
function resolveSplitPatterns(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
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
    if (!cleaned) continue;
    // 纯文本过短则合并到上一条
    const textOnly = cleaned.replace(/<[^>]+>/g, '').trim();
    if (textOnly.length < 4 && result.length > 0) {
      result[result.length - 1] += cleaned;
    } else {
      result.push(cleaned);
    }
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

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const storage = createStorageGateway(ctx);
  const proc = createProcessGateway(ctx);
  const connections: OneBotConnectionConfig[] = Array.isArray(config.connections)
    ? (config.connections as OneBotConnectionConfig[])
    : [];

  // 消息分条配置
  const splitCfg = (config.splitMessage ?? {}) as {
    enabled?: boolean;
    delayPerChar?: number;
    maxDelay?: number;
    patterns?: unknown;
  };
  const splitEnabled = splitCfg.enabled === true;
  const splitDelayPerChar = Math.max(0, splitCfg.delayPerChar ?? 50);
  const splitMaxDelay = Math.max(0, splitCfg.maxDelay ?? 3000);
  const splitPatterns = resolveSplitPatterns(splitCfg.patterns ?? ['。', '！', '？', '.', '!', '?', '\\n']);

  // 聊天流控配置已迁移至 plugin-flow-control / plugin-trigger-policy。

  // 合并转发处理配置。
  const forwardCfg = parseForwardConfig(config);

  // 引用消息处理配置
  const replyRaw = (config.reply ?? {}) as Record<string, unknown>;
  const replyCfg = {
    maxDepth: typeof replyRaw.maxDepth === 'number' ? Math.max(1, Math.floor(replyRaw.maxDepth)) : 5,
  };

  // 附件落盘上限（image / audio / video / file 共用同一阈值）
  const attCacheRaw = (config.attachmentCache ?? {}) as Record<string, unknown>;
  const attachmentMaxBytes =
    typeof attCacheRaw.maxBytes === 'number' && attCacheRaw.maxBytes > 0 ? attCacheRaw.maxBytes : 10 * 1024 * 1024;

  if (connections.length === 0) {
    ctx.logger.info('OneBot 适配器未配置任何连接');
  }

  const states: ConnectionState[] = [];

  // ===== 用户昵称缓存（userId → nickname，从每条消息的 sender 信息累积） =====
  const nicknameCache = new Map<string, string>();

  // ===== 待处理请求（好友/入群）=====
  // key: userId（好友请求）或 `${userId}:${groupId}`（群请求）
  const pendingFriendRequests = new Map<string, { flag: string; selfId: string }>();
  const pendingGroupRequests = new Map<string, { flag: string; subType: string; selfId: string }>();
  const pendingInviteCardSuppressions = new Map<string, number>();

  function inviteCardSuppressionKey(selfId: string, userId: string): string {
    return `${selfId}:${userId}`;
  }

  function rememberInviteCardSuppression(req: NormalizedRequestEvent): void {
    if (req.requestType !== 'group' || req.subType !== 'invite') return;
    pendingInviteCardSuppressions.set(
      inviteCardSuppressionKey(req.selfId, req.userId),
      Date.now() + INVITE_CARD_SUPPRESS_WINDOW,
    );
  }

  function shouldSuppressInviteCardMessage(event: {
    selfId: string;
    detailType: string;
    userId?: string;
    text: string;
  }): boolean {
    if (event.detailType !== 'private' || !event.userId || event.text.trim() !== '[JSON卡片]') return false;

    const key = inviteCardSuppressionKey(event.selfId, event.userId);
    const pending = pendingInviteCardSuppressions.get(key);
    if (!pending) return false;

    if (pending < Date.now()) {
      pendingInviteCardSuppressions.delete(key);
      return false;
    }

    pendingInviteCardSuppressions.delete(key);
    return true;
  }

  // ===== 桥接：会话元数据 + 平台 notice 入档 + 自禁言桥接 =====
  //
  // 流控/触发判定均已迁移；适配器只保留以下三类辅助：
  //  1. sessionMeta —— advisor.listSessionCandidates 提供 hint
  //  2. archivePlatformNotice —— 平台事件入档
  //  3. recoverSelfMute / 群禁言 notice → flow-control.setMuted（由 flow-control 插件实际暂停触发）

  /** 会话级元数据（仅用于 listSessionCandidates 时给 advisor 提供 hint） */
  const sessionMeta = new Map<string, { sessionType: string; groupName?: string; partnerNickname?: string }>();

  function noteSessionMeta(
    sessionId: string,
    sessionType: string,
    opts?: { groupName?: string; partnerNickname?: string },
  ): void {
    const prev = sessionMeta.get(sessionId);
    sessionMeta.set(sessionId, {
      sessionType,
      groupName: opts?.groupName ?? prev?.groupName,
      partnerNickname: opts?.partnerNickname ?? prev?.partnerNickname,
    });
  }

  /** 自禁言记录（sessionId → untilTs，毫秒），用于 adapter.getSelfMutes() */
  const selfMuted = new Map<string, number>();
  /** 已通过 shut_up_timestamp 完成恢复检查的会话集合 */
  const muteRecoveryChecked = new Set<string>();
  /** 机器人自身近期发出消息记录，支撑 adapter.getSentMessages() / 撤回自己发的消息 */
  const sentTracker = new SentMessageTracker();

  function setSelfMute(sessionId: string, durationSec: number, platform = 'onebot'): void {
    const flow = ctx.getService<FlowControlService>('flow-control');
    if (durationSec > 0) {
      selfMuted.set(sessionId, Date.now() + durationSec * 1000);
      flow?.setMuted(sessionId, durationSec, platform);
    } else {
      selfMuted.delete(sessionId);
      flow?.setMuted(sessionId, 0);
    }
  }

  // ── 平台 notice 入档 ──

  async function archivePlatformNotice(opts: {
    sessionId: string;
    noticeType: string;
    subType?: string;
    content: string;
    userId?: string;
    targetId?: string;
    groupId?: string;
    operatorId?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const archive = ctx.getService<MessageArchiveService>('message-archive');
    if (!archive?.archiveNotice) return;
    try {
      await archive.archiveNotice({
        sessionId: opts.sessionId,
        noticeType: opts.noticeType,
        subType: opts.subType,
        content: opts.content,
        platform: 'onebot',
        userId: opts.userId,
        targetId: opts.targetId,
        groupId: opts.groupId,
        operatorId: opts.operatorId,
        data: opts.data,
        timestamp: Date.now(),
      });
    } catch (err) {
      ctx.logger.warn(`notice 入档失败 (${opts.noticeType}): ${err}`);
    }
  }

  // ── 通过 selfId 反查连接 ──

  function findStateBySelfId(selfId: string | undefined): ConnectionState | undefined {
    if (!selfId) return undefined;
    const target = String(selfId);
    return states.find(s => s.selfId != null && String(s.selfId) === target);
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
        ctx.logger.info(
          `[禁言恢复] session=${sessionId} 检测到 shut_up_timestamp=${ts}，剩余 ${remainSec}s，已恢复禁言状态`,
        );
        await archivePlatformNotice({
          sessionId,
          noticeType: 'group_ban',
          subType: 'recovered',
          content: `[notice/group_ban/recovered] 检测到我在该群仍处于禁言状态，剩余约 ${remainSec} 秒（重启/重连后从 shut_up_timestamp 恢复）`,
          targetId: selfId,
          groupId,
          data: { duration: remainSec, until: ts * 1000 },
        });
      }
    } catch (err) {
      // 静默失败：可能是协议端不支持或群已退出
      ctx.logger.debug(
        `[禁言恢复] session=${sessionId} shut_up_timestamp 查询失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ----- 群信息缓存 -----

  interface GroupInfo {
    name: string;
    memberCount?: number;
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
        memberCount: data.member_count != null ? Number(data.member_count) : undefined,
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
      ctx.logger.debug(
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
   * - 嵌套 forward：调用 expandForwardsInText 展开为信封+摘要
   * - 图片：仅在描述缓存命中时注入识别结果，未命中保留 `[图片]` 占位符
   *   （主消息流的图片识别会自动写缓存，因此先发图、后被引用的常见路径能复用）
   */
  function findReplySegmentId(segments: import('./types.js').OneBotMessageSegment[]): string | undefined {
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
      const archive = ctx.getService<MessageArchiveService>('message-archive');
      if (archive?.findByMessageId) {
        try {
          const archived = await archive.findByMessageId(sessionId, messageId);
          if (archived) {
            const meta = (archived.metadata ?? {}) as Record<string, unknown>;
            const userId = meta.userId != null ? String(meta.userId) : undefined;
            const nickname = meta.nickname != null ? String(meta.nickname) : undefined;
            // 归档正文带 `[nick(id)]: ` 前缀（prefixSender 的产物），引用渲染层会再加发送者标签，
            // 这里剥掉首行前缀避免重复。
            let body = archived.content ?? '';
            const label = getSenderLabel(nickname, userId);
            if (label && body.startsWith(`[${label}]: `)) {
              body = body.slice(`[${label}]: `.length);
            }
            return { content: body || undefined, userId, nickname };
          }
        } catch (err) {
          ctx.logger.debug(`引用消息归档反查失败: ${err}`);
        }
      }
    }

    try {
      const data = (await sendAction(state, 'get_msg', {
        message_id: Number(messageId) || messageId,
      })) as Record<string, unknown>;
      const segments = Array.isArray(data.message) ? (data.message as import('./types.js').OneBotMessageSegment[]) : [];
      const sender = data.sender as Record<string, unknown> | undefined;
      const nickname = (sender?.card as string) || (sender?.nickname as string) || undefined;

      // 1. 用与主流程同款渲染器把所有段转成可读文本
      let content = segments.length > 0 ? segmentsToText(segments, state.selfId) : ((data.raw_message as string) ?? '');

      const nestedReplyId = findReplySegmentId(segments);
      if (nestedReplyId) {
        const nested = await fetchReplyMessage(state, nestedReplyId, sessionId, depth + 1, seen);
        if (nested?.content) {
          const nestedLabel = nested.nickname || nested.userId || '?';
          content += `\n[该引用消息又引用 ${nestedLabel} 的消息: ${nested.content}]`;
        }
      }

      // 2. 嵌套合并转发：展开为信封 + 摘要（命中现有 forward 缓存即零开销）
      if (content.includes('<forward id=')) {
        try {
          content = await expandForwardsInText(state, content, segments);
        } catch (err) {
          ctx.logger.debug(`引用消息中的合并转发展开失败: ${err}`);
        }
      }

      // 3. 引用消息中的图片：仅查描述缓存复用，不主动触发视觉模型
      if (content.includes('[图片]')) {
        const media = ctx.getService<MediaService>('media');
        if (media?.lookupDescription) {
          const imageUrls: string[] = [];
          for (const seg of segments) {
            const s = seg as unknown as Record<string, unknown>;
            if (s.type === 'image') {
              const url = (s.data as Record<string, unknown>)?.url;
              if (typeof url === 'string') imageUrls.push(url);
            }
          }
          if (imageUrls.length > 0) {
            let urlIdx = 0;
            content = content.replace(/\[图片\]/g, () => {
              const url = imageUrls[urlIdx++];
              if (!url) return '[图片]';
              const desc = media.lookupDescription(url);
              return desc ? `[图片: ${desc}]` : '[图片]';
            });
          }
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
    ctx,
    forwardCfg,
    sendAction,
  });
  const { getCachedForward, setCachedForward, loadPersistedForward, fetchForwardOnce, expandForwardsInText } =
    forwardExpander;

  // ----- Action 发送 -----

  function sendAction(state: ConnectionState, action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket 未连接'));
        return;
      }

      const echo = nextEcho();
      const timer = setTimeout(() => {
        state.pendingActions.delete(echo);
        reject(new Error(`Action ${action} 超时`));
      }, ACTION_TIMEOUT);

      state.pendingActions.set(echo, { resolve, reject, timer });

      const payload = JSON.stringify({ action, params, echo });
      state.ws.send(payload);
    });
  }

  // 发送类 action 的瞬时失败重试(超时 / NapCat 内核未确认多为瞬时)。
  // 重试在传输层、不经过 agent —— 故不会触发对同一条内容的重新评论。
  // 注意:NapCat sendMsg 超时偶有「已发出但未确认」的情况,重试可能导致重复消息;
  // 这里权衡后选择「至少送达一次」(宁可偶发重复,也不要静默丢失)。
  const SEND_MAX_RETRIES = 2;
  const SEND_RETRY_DELAY_MS = 1000;
  async function sendActionWithRetry(
    state: ConnectionState,
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
      try {
        return await sendAction(state, action, params);
      } catch (err) {
        lastErr = err;
        if (attempt < SEND_MAX_RETRIES) {
          ctx.logger.warn(
            `OneBot ${action} 发送失败(第 ${attempt + 1}/${SEND_MAX_RETRIES + 1} 次),${SEND_RETRY_DELAY_MS}ms 后重试: ${err}`,
          );
          await new Promise(r => setTimeout(r, SEND_RETRY_DELAY_MS));
        }
      }
    }
    throw lastErr;
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
      ctx.logger.info(
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
      ctx.logger.info(
        `OneBot 版本检测: get_version 成功 (impl=${info?.impl ?? 'unknown'}, onebot_version=${info?.onebot_version ?? '?'})`,
      );
      return protocolV12;
    } catch {
      // 也不可用
    }

    ctx.logger.warn('OneBot 版本自动检测失败，默认使用 v11 协议');
    return protocolV11;
  }

  // ----- PlatformAdapter 实现 -----

  const adapter: PlatformAdapter = {
    adapterName: 'OneBot',
    platform: 'onebot',
    sessionTypes: ['group', 'private'],

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

    getSelfIdentity(sessionId?: string) {
      const parsed = sessionId ? parseSessionId(sessionId) : null;
      const state = parsed
        ? findStateBySelfId(parsed.selfId)
        : states.find(s => s.status === 'online' && (s.selfId || s.selfNickname));
      if (!state || (!state.selfId && !state.selfNickname)) return undefined;
      return {
        platform: 'onebot',
        selfId: state.selfId,
        nickname: state.selfNickname,
      };
    },

    isReady(): boolean {
      return states.some(s => s.status === 'online');
    },

    async sendMessage(sessionId: string, content: string, options?: { skipSplit?: boolean }): Promise<void> {
      const parsed = parseSessionId(sessionId);
      if (!parsed) {
        ctx.logger.warn(`无法解析 sessionId: ${sessionId}`);
        return;
      }

      const state = findStateBySelfId(parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws || !state.protocol) {
        const knownIds = states.map(s => `${s.selfId ?? '?'}(${s.status})`).join(', ') || '无';
        const reason = !state
          ? `未找到对应连接（已知: ${knownIds}）`
          : state.status !== 'online'
            ? `状态=${state.status}`
            : !state.ws
              ? 'ws 为空'
              : '协议未初始化';
        ctx.logger.warn(`OneBot 连接不可用: selfId=${parsed.selfId} (${reason})`);
        return;
      }

      // 消息分条发送（指令回复等短消息可跳过）
      const punctPieces =
        splitEnabled && !options?.skipSplit ? splitMessageByPunctuation(content, splitPatterns) : [content];
      // 进一步拆出 <image .../>：图片始终独立成条，不与文本粘连。
      const pieces = punctPieces.flatMap(p => splitImageOut(p));

      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i].trim();
        if (!piece) continue;

        const { action, params } = state.protocol.buildSendMessage({
          detailType: parsed.detailType,
          targetId: parsed.targetId,
          content: piece,
        });

        const sendResult = await sendActionWithRetry(state, action, params);
        // 记录发出消息的 message_id，支撑「撤回自己发的消息」（每分条各自独立的 id）
        const sentId = extractSentMessageId(sendResult);
        if (sentId) sentTracker.record(sessionId, sentId, piece, Date.now());

        // 按下一条消息的字数计算延迟
        if (i < pieces.length - 1) {
          const nextPiece = pieces[i + 1];
          const charCount = nextPiece ? nextPiece.replace(/<[^>]+>/g, '').length : 0;
          const delay = Math.min(charCount * splitDelayPerChar, splitMaxDelay);
          if (delay > 0) {
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    },

    async callAction(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
      const parsed = parseSessionId(sessionId);
      if (!parsed) throw new Error(`无法解析 sessionId: ${sessionId}`);

      const state = findStateBySelfId(parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws) {
        throw new Error(`OneBot 连接不可用: selfId=${parsed.selfId}`);
      }

      // 合并转发：优先走缓存（消息到达时已抓过一次），失败再依次尝试多种参数键。
      if (action === 'get_forward_msg') {
        const id = String(params.id ?? params.message_id ?? params.res_id ?? params.m_resid ?? '');
        if (id) {
          // 内存缓存
          let entry = getCachedForward(id);
          // 持久化兜底（重启后场景）
          if (!entry) {
            const persisted = await loadPersistedForward(id);
            if (persisted) {
              setCachedForward(id, persisted);
              entry = persisted;
            }
          }
          if (entry) {
            // 返回完整原文 + 摘要（如果有）。工具层会优先使用 fullText 渲染。
            return {
              __aalisForwardEntry: true,
              fullText: entry.fullText,
              summary: entry.summary,
              count: entry.count,
              participants: entry.participants,
            };
          }
          const data = await fetchForwardOnce(state, id);
          if (data) return data;
          throw new Error('get_forward_msg 失败：所有参数键（id/message_id/res_id/m_resid）均无法取得内容');
        }
      }

      return sendAction(state, action, params);
    },

    /**
     * 非标准扩展：主动发送消息前的限速校验 + 计数。
     *
     * 委托 plugin-flow-control 的 isRateLimited / recordReply。
     * 若 flow-control 未加载或会话不存在，默认放行（不限速）。
     */
    checkAndRecordProactiveSend(sessionId: string): { allowed: boolean; reason?: string } {
      const flow = ctx.getService<FlowControlService>('flow-control');
      if (!flow) return { allowed: true };
      if (flow.isRateLimited(sessionId)) {
        return {
          allowed: false,
          reason: '已达限速上限（由 flow-control 决定）',
        };
      }
      flow.recordReply(sessionId, 'onebot');
      return { allowed: true };
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

    /** 处理好友请求：approve=true 同意，remark 为备注（同意时有效） */
    async handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string> {
      const pending = pendingFriendRequests.get(userId);
      if (!pending) return `未找到来自 ${userId} 的好友申请（可能已过期或已处理）`;
      const state = findStateBySelfId(pending.selfId);
      if (!state || state.status !== 'online') return '连接不可用，无法处理请求';
      await sendAction(state, 'set_friend_add_request', {
        flag: pending.flag,
        approve,
        remark: remark ?? '',
      });
      pendingFriendRequests.delete(userId);
      return approve
        ? `已同意 ${userId} 的好友申请${remark ? `，备注: ${remark}` : ''}`
        : `已拒绝 ${userId} 的好友申请`;
    },

    /** 处理群请求（加群申请或入群邀请）：approve=true 同意，reason 为拒绝理由 */
    async handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string> {
      const key = `${userId}:${groupId}`;
      const pending = pendingGroupRequests.get(key);
      if (!pending) return `未找到来自 ${userId} 关于群 ${groupId} 的请求（可能已过期或已处理）`;
      const state = findStateBySelfId(pending.selfId);
      if (!state || state.status !== 'online') return '连接不可用，无法处理请求';
      await sendAction(state, 'set_group_add_request', {
        flag: pending.flag,
        sub_type: pending.subType,
        approve,
        reason: reason ?? '',
      });
      pendingGroupRequests.delete(key);
      const typeLabel = pending.subType === 'invite' ? '入群邀请' : '加群申请';
      return approve
        ? `已同意 ${userId} 的${typeLabel}（群 ${groupId}）`
        : `已拒绝 ${userId} 的${typeLabel}（群 ${groupId}）${reason ? `，理由: ${reason}` : ''}`;
    },
  } as PlatformAdapter & {
    getSelfMutes(): Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }>;
    getSentMessages(sessionId: string, limit?: number): Array<{ messageId: string; ts: number; preview: string }>;
    forgetSentMessage(sessionId: string, messageId: string): void;
    handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string>;
    handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string>;
  };

  ctx.provide('platform', adapter, {
    capabilities: ['onebot', 'text', 'image', 'voice', 'forward', 'group-chat', 'private-chat', 'call-action'],
  });

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
    if (ctx.disposed) return;

    state.status = 'connecting';
    ctx.logger.info(`正在连接 OneBot: ${state.config.url} (协议: ${state.protocol?.version ?? '待检测'})`);

    const headers: Record<string, string> = {};
    if (state.config.accessToken) {
      headers.Authorization = `Bearer ${state.config.accessToken}`;
    }

    const ws = new WebSocket(state.config.url, { headers });
    state.ws = ws;

    // 诊断：捕获 unexpected-response（服务器返回非 101 时触发，且不会触发 error）
    ws.on('unexpected-response', (_req, res) => {
      ctx.logger.warn(`OneBot unexpected-response: status=${res.statusCode}, headers=${JSON.stringify(res.headers)}`);
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        ctx.logger.warn(`OneBot unexpected-response body: ${body}`);
      });
    });

    // 连接超时：如果 WS 握手在 CONNECT_TIMEOUT 内未完成，主动关闭并触发重连
    const connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ctx.logger.warn(
          `OneBot 连接超时 (${CONNECT_TIMEOUT / 1000}s): ${state.config.url}, readyState=${ws.readyState}`,
        );
        ws.terminate();
      }
    }, CONNECT_TIMEOUT);

    ws.on('upgrade', res => {
      ctx.logger.debug(`OneBot WS upgrade: status=${res.statusCode}`);
    });

    ws.on('open', () => {
      clearTimeout(connectTimer);
      state.status = 'online';
      state.lastPong = Date.now();
      ctx.logger.info(`OneBot 已连接: ${state.config.url}`);

      // 客户端心跳：定期 ping，检测待机后的死连接
      stopHeartbeat(state);
      ws.on('pong', () => {
        state.lastPong = Date.now();
      });
      state.heartbeatTimer = setInterval(() => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - state.lastPong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
          ctx.logger.warn(`OneBot 心跳超时，主动断开: ${state.config.url}`);
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
              pending.reject(new Error(`OneBot action 失败: ${resp.message ?? resp.retcode}`));
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
          ctx.logger.debug(
            `OneBot[${state.protocol.version}] 跳过未识别事件类型: post_type=${ident}, keys=[${Object.keys(ev).slice(0, 12).join(',')}]`,
          );
        }
      } catch (err) {
        ctx.logger.debug('OneBot 消息解析失败:', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(connectTimer);
      state.status = 'offline';
      state.ws = undefined;
      stopHeartbeat(state);
      for (const [, pending] of state.pendingActions) {
        clearTimeout(pending.timer);
        pending.reject(new Error('连接已关闭'));
      }
      state.pendingActions.clear();

      ctx.logger.warn(`OneBot 连接断开: ${state.config.url}，${RECONNECT_INTERVAL / 1000}s 后重连`);
      scheduleReconnect(state);
    });

    ws.on('error', err => {
      clearTimeout(connectTimer);
      ctx.logger.warn(
        `OneBot 连接错误: ${err.message}, code=${(err as NodeJS.ErrnoException).code}, readyState=${ws.readyState}`,
      );
    });
  }

  async function onConnected(state: ConnectionState): Promise<void> {
    // 1. 如果协议未确定（auto），先检测
    if (!state.protocol) {
      try {
        state.protocol = await detectProtocol(state);
        ctx.logger.info(`OneBot 协议版本: ${state.protocol.version} (${state.config.url})`);
      } catch (err) {
        ctx.logger.warn(`OneBot 协议检测异常: ${err}，默认使用 v11`);
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
          ctx.logger.info(`OneBot self_id: ${state.selfId ?? '?'}${namePart} (via ${action})`);
        }
      } catch (err) {
        ctx.logger.debug(`获取 self info 失败: ${err}`);
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
    if (ctx.disposed) return;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    ctx.logger.info(`OneBot 将在 ${RECONNECT_INTERVAL / 1000}s 后尝试重连: ${state.config.url}`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      ctx.logger.info(`OneBot 正在重试连接: ${state.config.url}`);
      doConnect(state);
    }, RECONNECT_INTERVAL);
  }

  // ----- 事件处理 -----

  function handleMessageEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    // 从 sender 信息累积昵称缓存（在解析消息前，以便 at 标签能查到昵称）
    const sender = (raw.sender ?? raw.user) as Record<string, unknown> | undefined;
    const rawUserId = raw.user_id != null ? String(raw.user_id) : undefined;
    if (rawUserId && sender) {
      const nick = (sender.card as string) || (sender.nickname as string);
      if (nick) nicknameCache.set(rawUserId, nick);
    }

    const fallbackSelfId = state.selfId ?? 'unknown';
    const event = state.protocol.parseMessageEvent(raw, fallbackSelfId, nicknameCache);
    if (!event) {
      // 解析器把消息丢弃（通常是文本为空），打日志暴露原始段类型以便诊断
      const segs = Array.isArray(raw.message)
        ? (raw.message as Array<{ type?: string }>).map(s => String(s?.type ?? '?')).filter(Boolean)
        : [];
      const rawText = typeof raw.raw_message === 'string' ? raw.raw_message : '';
      ctx.logger.debug(
        `OneBot[${state.protocol.version}] 消息事件被解析器丢弃（text 为空）: post_type=${String(raw.post_type ?? raw.type ?? '?')}, message_type=${String(raw.message_type ?? raw.detail_type ?? '?')}, segments=[${segs.join(',')}], raw_message=${rawText}`,
      );
      return;
    }

    // 更新 selfId
    if (event.selfId !== 'unknown' && !state.selfId) {
      state.selfId = event.selfId;
    }

    if (shouldSuppressInviteCardMessage(event)) {
      ctx.logger.debug(`OneBot[${state.protocol.version}] 忽略重复入群邀请 JSON 卡片: userId=${event.userId}`);
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

    ctx.logger.debug(
      `OneBot[${state.protocol.version}] 收到消息 [${event.detailType}] ${event.userId ?? '?'}: ${event.text}`,
    );

    // 注：指令解析已迁移到 plugin-commands 的 inbound:command 相位；
    // 适配器只负责将原始消息送入 inbound:message 总线，由 gateway 链路统一拦截。

    const sessionType =
      event.detailType === 'group'
        ? 'group'
        : event.detailType === 'private'
          ? 'private'
          : event.detailType === 'channel'
            ? 'channel'
            : undefined;

    // 异步获取群信息、引用消息，并执行流控判定
    (async () => {
      let groupName: string | undefined;
      let replyTo: { messageId: string; content?: string; userId?: string; nickname?: string } | undefined;

      // ----- 统一附件落盘 -----
      // 所有 image / audio / video / file 统一缓存到 data/{kind}s/{session}/，
      // 让历史回放、跨轮工具调用、人工归档使用同一份目录布局。
      //
      // 特别地：
      //  - audio：先调 OneBot get_record 把 QQ silk 转成可解码格式（NapCat 等
      //    实现常忽略 out_format 参数，返回 amr 原文），随后本地 ffmpeg
      //    强制转 16kHz mono WAV 再落盘，下游 LLM 直接消费。
      //  - 落盘失败的项保留原 URL，文本占位也维持 [图片]/[语音]/... 原样。
      const atts = event.attachments ?? [];
      const localPaths: (string | null)[] = await Promise.all(
        atts.map(async att => {
          try {
            if (att.kind === 'audio' && state) {
              // get_record 把 silk → mp3/amr，返回 base64 / url / file 任一
              const fileRef = att.name ?? att.url;
              let source = att.url;
              if (fileRef) {
                try {
                  const data = (await sendAction(state, 'get_record', {
                    file: fileRef,
                    out_format: 'mp3',
                  })) as { file?: string; url?: string; base64?: string } | undefined;
                  if (data?.base64) source = `data:audio/mpeg;base64,${data.base64}`;
                  else if (data?.url) source = String(data.url);
                  else if (data?.file) source = `file://${data.file}`;
                  ctx.logger.debug(
                    `OneBot get_record 完成 (file=${fileRef}, ` +
                      `kind=${data?.base64 ? 'base64' : data?.url ? 'url' : data?.file ? 'file' : 'empty'})`,
                  );
                } catch (err) {
                  ctx.logger.debug(`OneBot get_record 转换失败 (file=${fileRef}): ${err}`);
                }
              }
              return await cacheOneAttachment(
                storage,
                proc,
                'audio',
                source,
                sessionId,
                attachmentMaxBytes,
                ctx.logger,
              );
            }
            return await cacheOneAttachment(
              storage,
              proc,
              att.kind,
              att.url,
              sessionId,
              attachmentMaxBytes,
              ctx.logger,
            );
          } catch (err) {
            ctx.logger.debug(`OneBot 附件缓存异常 [${att.kind}]: ${err}`);
            return null;
          }
        }),
      );

      // 把 [图片]/[语音]/[视频]/[文件] 占位重写为 [xxx | ref:data/...]
      if (atts.length > 0) event.text = rewritePlaceholdersWithRefs(event.text, atts, localPaths);

      // 主动展开合并转发：把 <forward id="X">[合并转发消息]</forward> 替换为可读文本，
      // 这样 LLM 不必再调用工具，且展开后的内容会随 inbound:message 进入历史归档。
      if (event.text.includes('<forward id=')) {
        try {
          event.text = await expandForwardsInText(state, event.text, event.message);
        } catch (err) {
          ctx.logger.debug(`合并转发自动展开失败: ${err}`);
        }
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
      // 由 plugin-flow-control / plugin-trigger-policy 在 inbound:flow / inbound:trigger 相位
      // 决定是否吞噬、归档、或继续派发给 agent。
      // 启动后/重连后通过 shut_up_timestamp 懒查询恢复禁言状态（每会话一次）
      if (sessionType === 'group') {
        void recoverSelfMuteIfNeeded(sessionId);
      }

      // 记录会话元数据（advisor.listSessionCandidates 用）
      if (sessionType) {
        noteSessionMeta(sessionId, sessionType, {
          groupName,
          partnerNickname: sessionType === 'private' ? event.nickname : undefined,
        });
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

      ctx.emit('inbound:message', {
        content: event.text,
        sessionId,
        platform: 'onebot',
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
        groupId: event.groupId,
        senderRole: event.senderRole,
        senderTitle: event.senderTitle,
        selfRole,
        selfTitle,
        replyTo,
        // triggerType 由 trigger-policy 在 inbound:trigger 相位中填充
      });
    })().catch(err => {
      ctx.logger.warn(`OneBot 消息处理异常: ${err}`);
    });
  }

  // ===== 请求事件处理（加好友 / 加群 / 邀请入群）=====

  function handleRequestEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const req: NormalizedRequestEvent | null = state.protocol.parseRequestEvent(raw, fallbackSelfId);
    if (!req) {
      ctx.logger.debug(
        `OneBot[${state.protocol.version}] 跳过未识别 request: request_type=${String(raw.request_type ?? raw.detail_type ?? '?')}, sub_type=${String(raw.sub_type ?? '?')}`,
      );
      return;
    }

    const requestLabel = req.requestType === 'group' ? `${req.requestType}/${req.subType}` : req.requestType;
    const requestGroupId = req.requestType === 'group' ? req.groupId : '-';
    ctx.logger.info(
      `OneBot[${state.protocol.version}] 请求事件: ${requestLabel}, userId=${req.userId}, groupId=${requestGroupId}`,
    );

    if (req.requestType === 'friend') {
      // 存储待处理的好友请求 flag
      pendingFriendRequests.set(req.userId, { flag: req.flag, selfId: req.selfId });

      // 将请求包装为合成消息，交由 agent 决策（以私聊会话形式发送）
      const sessionId = makeSessionId(req.selfId, 'private', req.userId);
      const commentPart = req.comment ? `，验证信息："${req.comment}"` : '';
      const content = `[系统通知] 用户 ${req.userId} 向我发出了好友申请${commentPart}。请决定是否同意，调用 onebot_handle_friend_request 工具处理（user_id="${req.userId}"）。`;

      ctx
        .emit('inbound:message', {
          content,
          sessionId,
          platform: 'onebot',
          userId: req.userId,
          sessionType: 'private',
        })
        .catch((err: unknown) => ctx.logger.warn(`请求事件处理失败: ${err}`));
    } else if (req.requestType === 'group') {
      const key = `${req.userId}:${req.groupId}`;
      pendingGroupRequests.set(key, { flag: req.flag, subType: req.subType, selfId: req.selfId });
      rememberInviteCardSuppression(req);

      // 被邀请入群：以私聊形式通知（bot 还没在群里，无法发群消息）
      const sessionId = makeSessionId(req.selfId, 'private', req.userId);
      const groupPart = `群 ${req.groupId}`;
      const commentPart = req.comment ? `，备注："${req.comment}"` : '';

      let content: string;
      if (req.subType === 'invite') {
        content = `[系统通知] 用户 ${req.userId} 邀请我加入${groupPart}${commentPart}。请决定是否接受邀请，调用 onebot_handle_group_invite 工具处理（user_id="${req.userId}", group_id="${req.groupId}"）。`;
      } else {
        // sub_type === 'add': 有人申请加入 bot 管理的群（bot 是管理员）
        const gsId = makeSessionId(req.selfId, 'group', undefined, req.groupId);
        content = `[系统通知] 用户 ${req.userId} 申请加入${groupPart}${commentPart}。请决定是否同意，调用 onebot_approve_join_request 工具处理（user_id="${req.userId}", group_id="${req.groupId}"）。`;
        ctx
          .emit('inbound:message', {
            content,
            sessionId: gsId,
            platform: 'onebot',
            userId: req.userId,
            sessionType: 'group',
            groupId: req.groupId,
          })
          .catch((err: unknown) => ctx.logger.warn(`群申请事件处理失败: ${err}`));
        return;
      }

      ctx
        .emit('inbound:message', {
          content,
          sessionId,
          platform: 'onebot',
          userId: req.userId,
          sessionType: 'private',
        })
        .catch((err: unknown) => ctx.logger.warn(`邀请事件处理失败: ${err}`));
    }
  }

  function handleNoticeEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const notice = state.protocol.parseNoticeEvent(raw, fallbackSelfId);
    if (!notice) {
      ctx.logger.debug(
        `OneBot[${state.protocol.version}] 跳过未识别 notice: notice_type=${String(raw.notice_type ?? raw.detail_type ?? '?')}, sub_type=${String(raw.sub_type ?? '?')}`,
      );
      return;
    }

    // 过滤高频无用通知（输入状态等）
    if (notice.noticeType === 'notify' && notice.subType === 'input_status') return;

    ctx.logger.debug(
      `OneBot[${state.protocol.version}] 通知事件: ${notice.noticeType}${notice.subType ? `/${notice.subType}` : ''}`,
    );

    // 戳一戳 → 仅在目标是 bot 时触发 agent 回复
    if (notice.noticeType === 'poke') {
      const selfId = notice.selfId;
      const targetIsBot = notice.targetId === selfId;

      if (notice.groupId) {
        // 群聊 poke：只有被戳的是 bot 才回复
        if (!targetIsBot) {
          ctx.logger.debug(`群聊戳一戳: ${notice.userId} → ${notice.targetId}（非 bot，忽略）`);
          return;
        }
        (async () => {
          const nick = await resolveNickname(state, notice.userId, notice.groupId);
          const who = nick ? `${nick}(${notice.userId})` : notice.userId;
          const content = `[戳一戳: ${who} 戳了你]`;
          const sessionId = makeSessionId(selfId, 'group', notice.userId, notice.groupId);
          ctx.emit('inbound:message', {
            content,
            sessionId,
            platform: 'onebot',
            userId: notice.userId,
            nickname: nick,
            sessionType: 'group',
            groupId: notice.groupId,
            noticeType: 'poke',
          });
        })().catch(err => ctx.logger.warn(`poke 处理异常: ${err}`));
      } else if (notice.userId) {
        // 私聊 poke：始终回复
        (async () => {
          const nick = await resolveNickname(state, notice.userId);
          const who = nick ? `${nick}(${notice.userId})` : notice.userId;
          const content = `[戳一戳: ${who} 戳了你]`;
          const sessionId = makeSessionId(selfId, 'private', notice.userId);
          ctx.emit('inbound:message', {
            content,
            sessionId,
            platform: 'onebot',
            userId: notice.userId,
            nickname: nick,
            sessionType: 'private',
            noticeType: 'poke',
          });
        })().catch(err => ctx.logger.warn(`poke 处理异常: ${err}`));
      }
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
            ctx.logger.info(`[禁言解除] session=${sessionId} 操作者=${operatorId ?? 'unknown'}`);
          } else {
            // 时长未知时按 60s 兜底（旧 flowCfg.muteTimeSeconds 默认值）
            const dur = duration > 0 ? duration : 60;
            setSelfMute(sessionId, dur);
            ctx.logger.info(
              `[被禁言] session=${sessionId} 时长=${dur}s 操作者=${operatorId ?? 'unknown'}，` +
                `已通知 flow-control 暂停该群触发`,
            );
          }
        }

        // notice 入档（自己 / 他人都记录，便于 agent 感知群内动态）
        (async () => {
          const opNick = await resolveNickname(state, operatorId, notice.groupId);
          const targetNick = isSelf ? '我' : await resolveNickname(state, notice.userId, notice.groupId);
          const opLabel = opNick ? `${opNick}(${operatorId})` : (operatorId ?? '管理员');
          const targetLabel = isSelf
            ? '我'
            : targetNick
              ? `${targetNick}(${notice.userId})`
              : (notice.userId ?? '某人');
          const verb = isLift ? '解除了禁言' : `禁言了 ${duration > 0 ? `${duration} 秒` : '若干时间'}`;
          const untilTs = isLift ? 0 : duration > 0 ? Date.now() + duration * 1000 : 0;
          const untilLabel = untilTs > 0 ? `（解禁于 ${new Date(untilTs).toISOString()}）` : '';
          const content = `[notice/group_ban${isLift ? '/lift' : ''}] ${opLabel} 把 ${targetLabel} ${verb}${untilLabel}`;
          await archivePlatformNotice({
            sessionId,
            noticeType: notice.noticeType,
            subType: notice.subType,
            content,
            userId: notice.userId,
            targetId: notice.userId,
            groupId: notice.groupId,
            operatorId,
            data: { duration, isSelf, isLift, untilTs },
          });
        })().catch(err => ctx.logger.warn(`group_ban 入档异常: ${err}`));
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
        const userLabel = userNick ? `${userNick}(${notice.userId})` : (notice.userId ?? '某人');
        const opLabel = opNick ? `${opNick}(${operatorId})` : operatorId;
        const content = isGroup
          ? `[notice/group_recall] ${opLabel && opLabel !== userLabel ? `${opLabel} 撤回了 ${userLabel} 的消息` : `${userLabel} 撤回了一条消息`}${messageId ? `（msg=${messageId}）` : ''}`
          : `[notice/friend_recall] ${userLabel} 撤回了一条私聊消息${messageId ? `（msg=${messageId}）` : ''}`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          content,
          userId: notice.userId,
          groupId: notice.groupId,
          operatorId,
          data: { messageId },
        });
      })().catch(err => ctx.logger.warn(`recall 入档异常: ${err}`));
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
        const userLabel = isSelf ? '我' : userNick ? `${userNick}(${notice.userId})` : (notice.userId ?? '某人');
        const opLabel = opNick ? `${opNick}(${operatorId})` : operatorId;
        let action: string;
        if (isJoin) {
          action = notice.subType === 'invite' && opLabel ? `被 ${opLabel} 邀请加入了群` : '加入了群';
        } else {
          if (notice.subType === 'kick' && opLabel) action = `被 ${opLabel} 移出群聊`;
          else if (notice.subType === 'kick_me') action = `被 ${opLabel ?? '管理员'} 移出群聊`;
          else action = '退出了群聊';
        }
        const content = `[notice/${notice.noticeType}${notice.subType ? `/${notice.subType}` : ''}] ${userLabel} ${action}`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          subType: notice.subType,
          content,
          userId: notice.userId,
          groupId: notice.groupId,
          operatorId,
          data: { isSelf },
        });
      })().catch(err => ctx.logger.warn(`group_member 变动 入档异常: ${err}`));
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
        const userLabel = isSelf ? '我' : userNick ? `${userNick}(${notice.userId})` : (notice.userId ?? '某人');
        const action =
          notice.subType === 'set' ? '被设置为管理员' : notice.subType === 'unset' ? '被取消管理员' : '管理员状态变化';
        const content = `[notice/group_admin/${notice.subType ?? 'change'}] ${userLabel} ${action}`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          subType: notice.subType,
          content,
          userId: notice.userId,
          groupId: notice.groupId,
          data: { isSelf, isSet },
        });
      })().catch(err => ctx.logger.warn(`group_admin 入档异常: ${err}`));
      return;
    }

    // 好友添加
    if (notice.noticeType === 'friend_add' || notice.noticeType === 'friend_increase') {
      if (!notice.userId) return;
      const sessionId = makeSessionId(notice.selfId, 'private', notice.userId);
      (async () => {
        const userNick = await resolveNickname(state, notice.userId);
        const userLabel = userNick ? `${userNick}(${notice.userId})` : notice.userId;
        const content = `[notice/${notice.noticeType}] ${userLabel} 成为了我的好友`;
        await archivePlatformNotice({
          sessionId,
          noticeType: notice.noticeType,
          content,
          userId: notice.userId,
        });
      })().catch(err => ctx.logger.warn(`friend_add 入档异常: ${err}`));
      return;
    }

    // 群文件上传 → 转化为 inbound:message
    if (notice.noticeType === 'group_upload' && notice.groupId) {
      const selfId = notice.selfId;
      const sessionId = makeSessionId(selfId, 'group', notice.userId, notice.groupId);
      const fileName = notice.data?.fileName ?? '未知文件';
      const content = `[文件上传: ${notice.userId} 上传了 ${fileName}]`;

      ctx.emit('inbound:message', {
        content,
        sessionId,
        platform: 'onebot',
        userId: notice.userId,
        sessionType: 'group',
        groupId: notice.groupId,
        noticeType: 'group_upload',
      });
      return;
    }
  }

  function handleMetaEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const meta = state.protocol.parseMetaEvent(raw);

    if (meta.subType === 'connect' || meta.subType === 'lifecycle') {
      ctx.logger.debug(`OneBot[${state.protocol.version}] meta 事件: ${meta.subType}`);
      if (meta.selfId && !state.selfId) {
        state.selfId = meta.selfId;
        ctx.logger.info(`OneBot self_id (via meta): ${state.selfId}`);
      }
      if (meta.version) {
        ctx.logger.info(
          `OneBot 实现: ${meta.version.impl ?? 'unknown'} v${meta.version.version ?? '?'} (onebot ${meta.version.onebot_version ?? '?'})`,
        );
      }
    } else if (meta.subType === 'heartbeat') {
      // 心跳事件不输出日志
    } else if (meta.subType === 'status_update') {
      ctx.logger.debug(`OneBot[${state.protocol.version}] 状态更新事件`);
    } else {
      ctx.logger.debug(`OneBot[${state.protocol.version}] 跳过未识别 meta 事件: sub_type=${meta.subType ?? '?'}`);
    }
  }

  // ----- 群聊时间感知提示 + 特殊事件触发上下文 -----
  // 群聊中多人消息平铺在历史中，注入提示帮助模型关注时间线
  // 特殊事件（如戳一戳、文件上传）触发时注入说明，让模型知道触发原因
  const noticePatterns: Array<{ pattern: RegExp; hint: string }> = [
    {
      pattern: /^\[戳一戳:/,
      hint: '这条消息不是用户手动输入的文字，而是一个「戳一戳」互动事件——有人戳了你。请根据戳一戳的情境做出自然、俏皮的反应，而不是直接回复消息内容。',
    },
    { pattern: /^\[文件上传:/, hint: '这条消息不是用户手动输入的文字，而是一个文件上传通知事件。' },
  ];

  ctx.middleware('agent:llm:before', async (data, next) => {
    if (data.sessionId?.includes(':group:')) {
      // 在最后一条用户消息前插入时间感知提示
      let lastUserIdx = -1;
      for (let i = data.messages.length - 1; i >= 0; i--) {
        if (data.messages[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx > 0) {
        data.messages.splice(lastUserIdx, 0, {
          role: 'system',
          content:
            '注意：以上是群聊的历史消息记录，包含多位群友的发言。' +
            '请留意消息的时间先后顺序，优先关注近期的对话内容和上下文。',
          metadata: { injector: 'platform' },
        });
      }
    }

    // 特殊事件触发上下文：检查最后一条用户消息是否为非文本事件
    if (data.sessionId?.startsWith('onebot:')) {
      const lastMsg = data.messages[data.messages.length - 1];
      if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string') {
        // 去掉发送者前缀后匹配事件模式
        const bare = lastMsg.content.replace(/^\[[^\]]*\]:\s*/, '');
        for (const { pattern, hint } of noticePatterns) {
          if (pattern.test(bare)) {
            // 在用户消息前插入事件说明
            data.messages.splice(data.messages.length - 1, 0, {
              role: 'system',
              content: hint,
              metadata: { injector: 'platform' },
            });
            break;
          }
        }
      }
    }

    await next();
  });

  // ----- 监听消息回复事件 -----

  ctx.on('outbound:message', async msg => {
    if (!msg.sessionId.startsWith('onebot:')) return;

    // 把结构化 attachments 渲染为 <image url="base64://..."/> 标记，
    // 远程 URL / 本地文件统一编码为 base64 通过 WS 隧道发送，避免 daemon
    // 与 Aalis 不在同一文件系统时（典型：Docker 部署）发生 ENOENT
    let content = msg.content ?? '';
    if (msg.attachments?.length) {
      // 出站附件也统一落盘 data/{kind}s/{session}/ —— 让 agent 自己发出去的
      // 图/音/视频能进入后续历史回放与归档检索，行为与入站对称。
      // 落盘失败（超大 / 无法解码）不阻塞发送，保留原 data 继续走 renderer。
      await Promise.all(
        msg.attachments.map(async att => {
          try {
            const local = await cacheOneAttachment(
              storage,
              proc,
              att.kind,
              att.data,
              msg.sessionId,
              attachmentMaxBytes,
              ctx.logger,
            );
            if (local) {
              // cacheAttachmentBuffer 返回相对路径 "data/images/..."，
              // 转为 storage URI "data:/images/..."，让 renderAttachmentsAsContentMarkers
              // 走 storage.readFile 读回 buffer，而非兜底成无法访问的相对 file://
              att.data = local.replace(/^([^/]+)\//, '$1:/');
              if (att.kind === 'audio') att.mimeType = 'audio/wav';
            }
          } catch (err) {
            ctx.logger.debug(`OneBot 出站附件缓存异常 [${att.kind}]: ${err}`);
          }
        }),
      );

      try {
        const markers = await renderAttachmentsAsContentMarkers(msg.attachments, storage, ctx.logger);
        if (markers) content = content ? `${content}\n${markers}` : markers;
      } catch (err) {
        ctx.logger.warn(`OneBot 渲染附件失败: ${err}`);
      }
    }

    if (!content.trim()) {
      ctx.logger.debug(`OneBot 跳过空消息 [${msg.sessionId}]`);
      return;
    }
    ctx.logger.debug(`OneBot 发送消息 [${msg.sessionId}]: ${content}`);

    // 冷却 / 退避 / idle 调度由 plugin-flow-control 自行处理（监听 outbound:message）

    adapter.sendMessage(msg.sessionId, content, { skipSplit: msg.source !== 'agent' }).catch(err => {
      ctx.logger.warn(`OneBot 发送消息失败(已重试): ${err}`);
      // 反馈给 agent:多次重试仍失败 → 写一条系统提示进会话记忆,让 agent 下一轮知晓
      // 「刚才那条(可能含图片)没送达」,而不是误以为已发成功。被动记录,不立即触发回复。
      if (msg.source === 'agent') {
        const archive = ctx.getService<MessageArchiveService>('message-archive');
        const note: Message = {
          role: 'system',
          kind: 'outbound-delivery-failed',
          content:
            '[投递回报] 你刚才发送的内容(可能包含图片/媒体)经多次重试仍未能送达对方。' +
            '如确有必要可稍后重发或改用文字说明;不必反复道歉或刷屏。',
          timestamp: Date.now(),
          metadata: { source: 'adapter-onebot', error: String(err) },
        };
        archive?.saveMessage(msg.sessionId, note).catch(e => ctx.logger.debug(`投递失败提示入档失败: ${e}`));
      }
    });
  });

  // ----- 生命周期 -----

  ctx.on('ready', () => {
    for (const connConfig of connections) {
      if (!connConfig.url) {
        ctx.logger.warn('OneBot 连接配置缺少 url，跳过');
        continue;
      }
      connectOne(connConfig);
    }
  });

  ctx.onDispose(() => {
    selfMuted.clear();
    muteRecoveryChecked.clear();

    for (const state of states) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      stopHeartbeat(state);
      if (state.ws) {
        state.ws.removeAllListeners();
        if (state.ws.readyState === 0 /* CONNECTING */) {
          state.ws.terminate();
        } else {
          state.ws.close();
        }
      }
      for (const [, pending] of state.pendingActions) {
        clearTimeout(pending.timer);
      }
    }
    states.length = 0;
  });
}
