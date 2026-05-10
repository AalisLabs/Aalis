import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Context, ConfigSchema, PlatformAdapter, PlatformConnection } from '@aalis/core';
import type { ImageRecognitionService, LLMService, MemoryService, FlowControlService } from '@aalis/core';
import type { MessageArchiveService } from '@aalis/plugin-message-archive';
import { parseModelRef } from '@aalis/core';
import type {
  OneBotConnectionConfig,
  OneBotProtocol,
  OneBotRawEvent,
  OneBotActionResponse,
  NormalizedRequestEvent,
} from './types.js';
import { collectForwardSegments, segmentsToText } from './types.js';
import { expandForward, buildEnvelope } from './forward.js';
import { OneBotV11 } from './v11.js';
import { OneBotV12 } from './v12.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-adapter-onebot';
export const displayName = 'OneBot 适配器';
export const inject = {
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
      delayPerChar: { type: 'number', label: '每字延迟 (ms)', description: '按下一条消息的字数计算延迟，单位毫秒/字', default: 50 },
      maxDelay: { type: 'number', label: '最大延迟 (ms)', description: '分条消息之间的最大延迟上限（毫秒）', default: 3000 },
      patterns: {
        type: 'multiselect',
        label: '切割模式',
        description: '在匹配到这些字符串的位置之后进行切割。每一项是一个完整的字符串：单字符（如 。）就在该字符后切；多字符（如 ". "、".\\n"）则要整段匹配到才切。支持转义：\\n=换行，\\t=制表符，\\r=回车，\\\\=反斜杠。',
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
      enabled: { type: 'boolean', label: '启用自动展开', default: true, description: '关闭后保留原始占位符，由 LLM 自行决定是否调工具读取。' },
      maxDepth: { type: 'number', label: '嵌套深度上限', default: 3, description: '递归展开嵌套合并转发的最大层数（顶层=1）。' },
      maxNodesPerLevel: { type: 'number', label: '单层节点上限', default: 30, description: '每层最多展开多少条节点。超过部分会被截断。' },
      imageRecognition: { type: 'boolean', label: '识别内部图片', default: true, description: '把转发内的图片送入 image-recognition 服务转写为文字描述。需要该服务可用。' },
      summarize: { type: 'boolean', label: '生成摘要', default: true, description: '展开后调用 LLM 生成一段摘要，作为消息正文进入对话/记忆/向量库；原文保留在缓存。' },
      summaryModel: { type: 'select', label: '摘要模型', default: '', dynamicOptions: 'llm', description: '留空使用默认 LLM 服务的默认模型；选定后通过 LLMRouter 路由到对应 provider。建议挑便宜/快的模型。' },
      summaryMaxChars: { type: 'number', label: '摘要最大字数', default: 400, description: '提示给摘要模型的目标长度上限。' },
    },
  },
  reply: {
    label: '引用消息处理',
    description: '收到引用回复时如何展开被引用消息链',
    fields: {
      maxDepth: { type: 'number', label: '引用链深度上限', default: 5, description: '递归获取被引用消息的最大层数。1 = 只读取直接引用；2 = 继续读取直接引用所引用的消息，依此类推。' },
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
    summarize: true,
    summaryModel: '',
    summaryMaxChars: 400,
  },
  reply: {
    maxDepth: 5,
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
  pendingActions: Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
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
function makeSessionId(selfId: string, detailType: string, userId?: string, groupId?: string, guildId?: string, channelId?: string): string {
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

// ===== 图片下载缓存 =====

/** 下载图片到本地缓存，返回相对路径（如 data/images/...）。失败返回 null */
async function downloadAndCacheImage(url: string, sessionId: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());

    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);

    const contentType = response.headers.get('content-type') ?? '';
    let ext = 'jpg';
    if (contentType.includes('png')) ext = 'png';
    else if (contentType.includes('gif')) ext = 'gif';
    else if (contentType.includes('webp')) ext = 'webp';

    const safeSessionId = sessionId.replace(/[:/\\]/g, '_');
    const dirRel = `data/images/${safeSessionId}`;
    const dirAbs = resolve(process.cwd(), dirRel);
    await mkdir(dirAbs, { recursive: true });

    const filename = `${hash}.${ext}`;
    await writeFile(resolve(dirAbs, filename), buffer);

    return `${dirRel}/${filename}`;
  } catch {
    return null;
  }
}

/**
 * 下载所有图片并替换文本中的 [图片] 标记为 [图片 | ref:path]。
 * 返回 { text: 替换后文本, localPaths: 本地路径数组（与 images 一一对应） }
 */
async function cacheImagesAndRewriteText(
  text: string,
  images: string[],
  sessionId: string,
): Promise<{ text: string; localPaths: (string | null)[] }> {
  const localPaths = await Promise.all(
    images.map(url => downloadAndCacheImage(url, sessionId)),
  );

  let idx = 0;
  let rewritten = text.replace(/\[图片\]/g, () => {
    const path = localPaths[idx++];
    return path ? `[图片 | ref:${path}]` : '[图片]';
  });

  const remaining = localPaths.slice(idx).map(path => path ? `[图片 | ref:${path}]` : '[图片]');
  if (remaining.length > 0) rewritten += remaining.join('');

  return { text: rewritten, localPaths };
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
function splitMessageByPunctuation(content: string, patterns: string[]): string[] {
  if (content.length <= 10 || patterns.length === 0) return [content];

  // 识别 XML 标记位置，拆分时不切割它们
  const xmlTagRegex = /<(?:at(?:\s+self)?)\s*>[^<]*<\/at>|<face\s+id=["'][^"']*["']\s*\/>|<image\s+url=["'][^"']*["']\s*\/>|<reply\s+id=["'][^"']*["']\s*\/>/g;

  interface Token { type: 'text' | 'tag'; value: string }
  const tokens: Token[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = xmlTagRegex.exec(content)) !== null) {
    if (m.index > lastIdx) tokens.push({ type: 'text', value: content.slice(lastIdx, m.index) });
    tokens.push({ type: 'tag', value: m[0] });
    lastIdx = m.index + m[0].length;
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
      if (trimmed !== cur) { cur = trimmed; changed = true; }
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

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const connections: OneBotConnectionConfig[] = Array.isArray(config.connections)
    ? config.connections as OneBotConnectionConfig[]
    : [];

  // 消息分条配置
  const splitCfg = (config.splitMessage ?? {}) as { enabled?: boolean; delayPerChar?: number; maxDelay?: number; patterns?: unknown };
  const splitEnabled = splitCfg.enabled === true;
  const splitDelayPerChar = Math.max(0, splitCfg.delayPerChar ?? 50);
  const splitMaxDelay = Math.max(0, splitCfg.maxDelay ?? 3000);
  const splitPatterns = resolveSplitPatterns(
    splitCfg.patterns ?? ['。', '！', '？', '.', '!', '?', '\\n'],
  );

  // 聊天流控配置已迁移至 plugin-flow-control / plugin-trigger-policy。

  // 合并转发处理配置
  const fwdRaw = (config.forward ?? {}) as Record<string, unknown>;
  const forwardCfg = {
    enabled: fwdRaw.enabled !== false,
    maxDepth: typeof fwdRaw.maxDepth === 'number' ? Math.max(1, Math.floor(fwdRaw.maxDepth)) : 3,
    maxNodesPerLevel: typeof fwdRaw.maxNodesPerLevel === 'number' ? Math.max(1, Math.floor(fwdRaw.maxNodesPerLevel)) : 30,
    imageRecognition: fwdRaw.imageRecognition !== false,
    summarize: fwdRaw.summarize !== false,
    summaryModel: typeof fwdRaw.summaryModel === 'string' ? fwdRaw.summaryModel.trim() : '',
    summaryMaxChars: typeof fwdRaw.summaryMaxChars === 'number' ? Math.max(80, Math.floor(fwdRaw.summaryMaxChars)) : 400,
  };

  // 引用消息处理配置
  const replyRaw = (config.reply ?? {}) as Record<string, unknown>;
  const replyCfg = {
    maxDepth: typeof replyRaw.maxDepth === 'number' ? Math.max(1, Math.floor(replyRaw.maxDepth)) : 5,
  };

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

  function shouldSuppressInviteCardMessage(event: { selfId: string; detailType: string; userId?: string; text: string }): boolean {
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

  function noteSessionMeta(sessionId: string, sessionType: string, opts?: { groupName?: string; partnerNickname?: string }): void {
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
      const data = await sendAction(state, 'get_group_member_info', {
        group_id: Number(groupId) || groupId,
        user_id: Number(selfId) || selfId,
        no_cache: true,
      }) as Record<string, unknown>;
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
      ctx.logger.debug(`[禁言恢复] session=${sessionId} shut_up_timestamp 查询失败: ${err instanceof Error ? err.message : String(err)}`);
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
      const data = await sendAction(state, 'get_group_info', {
        group_id: Number(groupId) || groupId,
      }) as Record<string, unknown>;
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

  /** 获取用户昵称（群聊优先取群名片，私聊取陌生人昵称） */
  async function resolveNickname(state: ConnectionState, userId?: string, groupId?: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      if (groupId) {
        const data = await sendAction(state, 'get_group_member_info', {
          group_id: Number(groupId) || groupId,
          user_id: Number(userId) || userId,
        }) as Record<string, unknown>;
        return (data.card as string) || (data.nickname as string) || undefined;
      }
      const data = await sendAction(state, 'get_stranger_info', {
        user_id: Number(userId) || userId,
      }) as Record<string, unknown>;
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

  async function fetchReplyMessage(state: ConnectionState, messageId: string, depth = 0, seen = new Set<string>()): Promise<{
    content?: string; userId?: string; nickname?: string;
  } | null> {
    if (depth >= replyCfg.maxDepth || seen.has(messageId)) return null;
    seen.add(messageId);
    try {
      const data = await sendAction(state, 'get_msg', {
        message_id: Number(messageId) || messageId,
      }) as Record<string, unknown>;
      const segments = Array.isArray(data.message)
        ? (data.message as import('./types.js').OneBotMessageSegment[])
        : [];
      const sender = data.sender as Record<string, unknown> | undefined;
      const nickname = (sender?.card as string) || (sender?.nickname as string) || undefined;

      // 1. 用与主流程同款渲染器把所有段转成可读文本
      let content = segments.length > 0
        ? segmentsToText(segments, state.selfId)
        : ((data.raw_message as string) ?? '');

      const nestedReplyId = findReplySegmentId(segments);
      if (nestedReplyId) {
        const nested = await fetchReplyMessage(state, nestedReplyId, depth + 1, seen);
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
        const ir = ctx.getService<ImageRecognitionService>('image-recognition');
        if (ir?.lookupDescription) {
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
              const desc = ir.lookupDescription!(url);
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

  // ===== 合并转发自动展开 =====

  /**
   * 合并转发原文缓存：id → 完整原文 / 摘要 / 元信息。
   *
   * 收到一条带 forward 段的消息时，立即递归拉取原文、做图像识别、生成摘要，
   * 并把完整原文写入此缓存（也会同步到 MemoryService.saveMetadata 做持久化），
   * 这样：
   *   1) LLM 在对话上下文里看到的是"信封 + 摘要"，不被超长原文淹没；
   *   2) 想看细节时调 onebot_get_forward_msg 工具直接命中缓存/持久化层；
   *   3) 摘要会随 inbound:message 进入历史归档与向量库，被语义召回。
   *
   * 内存缓存 1h TTL；持久化由 memory metadata 兜底（如果实现支持）。
   */
  interface ForwardEntry {
    fullText: string;
    summary: string | null;
    count: number;
    participants: string[];
    expandedAt: number;
  }
  const forwardCache = new Map<string, { entry: ForwardEntry; expiresAt: number }>();
  const FORWARD_CACHE_TTL_MS = 60 * 60 * 1000;
  const FORWARD_METADATA_NS = 'onebot:forward';

  function getCachedForward(id: string): ForwardEntry | undefined {
    const c = forwardCache.get(id);
    if (!c) return undefined;
    if (c.expiresAt < Date.now()) {
      forwardCache.delete(id);
      return undefined;
    }
    return c.entry;
  }

  function setCachedForward(id: string, entry: ForwardEntry): void {
    forwardCache.set(id, { entry, expiresAt: Date.now() + FORWARD_CACHE_TTL_MS });
    // 同步持久化（best-effort，不阻塞主流程）
    const memory = ctx.getService<MemoryService>('memory');
    if (memory?.saveMetadata) {
      memory.saveMetadata(FORWARD_METADATA_NS, id, entry as unknown as Record<string, unknown>)
        .catch((err: unknown) => ctx.logger.debug(`forward metadata 持久化失败 id=${id}: ${err}`));
    }
  }

  /** 从持久化层加载（缓存未命中时尝试） */
  async function loadPersistedForward(id: string): Promise<ForwardEntry | undefined> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getMetadata) return undefined;
    try {
      const data = await memory.getMetadata(FORWARD_METADATA_NS, id);
      if (data && typeof data === 'object' && typeof (data as { fullText?: unknown }).fullText === 'string') {
        return data as unknown as ForwardEntry;
      }
    } catch (err) {
      ctx.logger.debug(`forward metadata 读取失败 id=${id}: ${err}`);
    }
    return undefined;
  }

  /**
   * 拉取一条合并转发的内容，依次尝试多种参数键。
   * 不同 OneBot 实现接受的字段不同：标准为 id，NapCat/Lagrange 部分版本接受
   * message_id / res_id / m_resid。
   */
  async function fetchForwardOnce(state: ConnectionState, id: string): Promise<unknown | null> {
    const attempts: Array<Record<string, unknown>> = [
      { id },
      { message_id: id },
      { res_id: id },
      { m_resid: id },
    ];
    let lastErr: unknown;
    for (const params of attempts) {
      try {
        return await sendAction(state, 'get_forward_msg', params);
      } catch (err) {
        lastErr = err;
        continue;
      }
    }
    ctx.logger.debug(`get_forward_msg 全部参数尝试失败 id=${id}: ${lastErr}`);
    return null;
  }

  /** 用 LLM 给一段 forward 原文生成摘要；失败/未配置则返回 null。 */
  async function summarizeForward(
    text: string,
    hint: { count: number; participants: string[] },
  ): Promise<string | null> {
    if (!forwardCfg.summarize) return null;

    // 走默认 'llm' 服务（router）；summaryModel 可以是复合 ref `<contextId>::<modelId>`
    const llm = ctx.getService<LLMService>('llm');
    const summaryRef = parseModelRef(forwardCfg.summaryModel || undefined);
    if (!llm || typeof llm.chat !== 'function') {
      ctx.logger.debug('forward 摘要：无可用 LLM 服务，跳过');
      return null;
    }

    // 控制输入长度，避免触发 context 上限
    const inputLimit = 8000;
    const trimmedInput = text.length > inputLimit
      ? text.slice(0, inputLimit) + '\n…（原文已截断）'
      : text;

    const sys = '你是消息摘要助手。给定一段聊天合并转发的原始内容，用简体中文输出一段不超过指定字数的摘要：\n'
      + '- 概括话题主线、关键事实、参与人态度；\n'
      + '- 如果原文包含请求、指令、待执行事项、希望机器人代发/转告/评价的内容，必须保留具体任务、目标对象/群聊、要表达的观点和可引用原话；\n'
      + '- 涉及图片识别结果时，把视觉信息也写进来；\n'
      + '- 不要逐条复述、不要使用列表、不要寒暄、不要解释自己；\n'
      + '- 控制在目标字数以内，重要细节保留，无关寒暄略去。';
    const userPrompt = `合并转发包含 ${hint.count} 条消息，主要参与人：${hint.participants.join(', ') || '未知'}。\n目标字数：≤${forwardCfg.summaryMaxChars} 字。\n\n原文：\n${trimmedInput}`;

    try {
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        // 摘要为纯抽取任务，关闭 reasoning 避免 thinking tokens 吞噬输出预算。
        think: false,
        // 中文按 1 字 ≈ 1 token 估算，再留 50% 余量；并设 800 token 下限兜底。
        maxTokens: Math.max(800, Math.ceil(forwardCfg.summaryMaxChars * 1.5)),
        ...(summaryRef.provider ? { provider: summaryRef.provider } : {}),
        ...(summaryRef.model ? { model: summaryRef.model } : {}),
      });
      const out = (resp.content ?? '').trim();
      if (!out) {
        ctx.logger.debug(`forward 摘要返回空内容: model=${forwardCfg.summaryModel || 'default'}, chars=${forwardCfg.summaryMaxChars}`);
        return null;
      }
      return out;
    } catch (err) {
      ctx.logger.warn(`forward 摘要生成失败: ${err}`);
      return null;
    }
  }

  /**
   * 把 event.text 中所有 <forward id="X">[合并转发消息]</forward> 占位符
   * 替换为"信封文本"（含摘要）；完整原文写入 forwardCache + memory metadata。
   *
   * 优先使用消息段里随帧带来的 inline content（部分 NapCat 版本会内嵌），
   * 这种情况下顶层无需走网络。
   */
  async function expandForwardsInText(
    state: ConnectionState,
    text: string,
    rawSegments: import('./types.js').OneBotMessageSegment[] | undefined,
  ): Promise<string> {
    if (!forwardCfg.enabled) return text;
    if (!text.includes('<forward id=')) return text;

    // 收集 message 段中已自带 inline content 的 forward
    const inlineMap = new Map<string, unknown[]>();
    if (rawSegments && Array.isArray(rawSegments)) {
      for (const f of collectForwardSegments(rawSegments)) {
        if (f.inlineNodes && f.inlineNodes.length > 0) inlineMap.set(f.id, f.inlineNodes);
      }
    }

    const idRe = /<forward id="([^"]+)">\[合并转发消息\]<\/forward>/g;
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(text)) !== null) ids.add(m[1]);
    if (ids.size === 0) return text;

    const irService = forwardCfg.imageRecognition
      ? ctx.getService<ImageRecognitionService>('image-recognition')
      : undefined;
    const recognizeImage = irService?.available && irService.describe
      ? (src: string) => irService.describe!(src)
      : undefined;

    const envelopeMap = new Map<string, string>();
    for (const id of ids) {
      // 1) 命中内存缓存
      let entry = getCachedForward(id);
      // 2) 命中持久化（重启后场景）
      if (!entry) {
        const persisted = await loadPersistedForward(id);
        if (persisted) {
          setCachedForward(id, persisted);
          entry = persisted;
        }
      }
      if (entry) {
        envelopeMap.set(id, buildEnvelope(
          { id, count: entry.count, participants: entry.participants, fullText: entry.fullText, truncatedDepth: false, truncatedNodes: false },
          entry.summary,
        ));
        continue;
      }

      // 3) 递归展开
      try {
        const expanded = await expandForward(id, inlineMap.get(id) ?? null, {
          fetchForward: (childId: string) => fetchForwardOnce(state, childId),
          recognizeImage,
          maxDepth: forwardCfg.maxDepth,
          maxNodesPerLevel: forwardCfg.maxNodesPerLevel,
          imageRecognitionEnabled: forwardCfg.imageRecognition,
        });

        if (!expanded.fullText.trim()) {
          envelopeMap.set(
            id,
            `<forward id="${id}">[合并转发消息：协议端无法读取（可能已过期/不在当前会话作用域）]</forward>`,
          );
          continue;
        }

        // 4) 摘要（best-effort）
        const summary = await summarizeForward(expanded.fullText, {
          count: expanded.count,
          participants: expanded.participants,
        });

        // 5) 入缓存 + 持久化
        const stored: ForwardEntry = {
          fullText: expanded.fullText,
          summary,
          count: expanded.count,
          participants: expanded.participants,
          expandedAt: Date.now(),
        };
        setCachedForward(id, stored);

        // 成功路径可观测：摘要预览 + 节点数 / 参与人 / 是否截断 / 摘要长度
        const previewSrc = summary ?? expanded.fullText;
        const preview = previewSrc.length > 80 ? previewSrc.slice(0, 80) + '…' : previewSrc;
        const truncFlag = (expanded.truncatedDepth || expanded.truncatedNodes) ? ' [truncated]' : '';
        ctx.logger.debug(
          `forward 展开完成 id=${id} count=${expanded.count} participants=[${expanded.participants.join(',')}]`
          + ` summary=${summary ? `${summary.length}字` : 'null'}${truncFlag} preview="${preview.replace(/\n/g, ' ')}"`,
        );

        envelopeMap.set(id, buildEnvelope(expanded, summary));
      } catch (err) {
        ctx.logger.warn(`forward 展开失败 id=${id}: ${err}`);
        envelopeMap.set(
          id,
          `<forward id="${id}">[合并转发消息：展开过程出错]</forward>`,
        );
      }
    }

    return text.replace(idRe, (raw, id: string) => envelopeMap.get(id) ?? raw);
  }


  // ----- Action 发送 -----

  function sendAction(
    state: ConnectionState,
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
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

  // ----- 版本自动检测 -----

  async function detectProtocol(state: ConnectionState): Promise<OneBotProtocol> {
    // 策略: 先尝试 v11 的 get_version_info，成功则为 v11
    // 失败则尝试 v12 的 get_version，成功则为 v12
    // 都失败则默认 v11（更常见）
    try {
      const data = await sendAction(state, 'get_version_info', {});
      const info = data as Record<string, unknown>;
      const protoVer = String(info?.protocol_version ?? '');
      ctx.logger.info(`OneBot 版本检测: get_version_info 成功 (protocol_version=${protoVer}, app=${info?.app_name ?? 'unknown'})`);
      // 有些实现可能报 v12 但走的 v11 接口，以接口可用性为准
      return protocolV11;
    } catch {
      // get_version_info 不可用，尝试 v12
    }

    try {
      const data = await sendAction(state, 'get_version', {});
      const info = data as Record<string, unknown>;
      ctx.logger.info(`OneBot 版本检测: get_version 成功 (impl=${info?.impl ?? 'unknown'}, onebot_version=${info?.onebot_version ?? '?'})`);
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
          : state.status !== 'online' ? `状态=${state.status}` : !state.ws ? 'ws 为空' : '协议未初始化';
        ctx.logger.warn(`OneBot 连接不可用: selfId=${parsed.selfId} (${reason})`);
        return;
      }

      // 消息分条发送（指令回复等短消息可跳过）
      const pieces = (splitEnabled && !options?.skipSplit) ? splitMessageByPunctuation(content, splitPatterns) : [content];

      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i].trim();
        if (!piece) continue;

        const { action, params } = state.protocol.buildSendMessage({
          detailType: parsed.detailType,
          targetId: parsed.targetId,
          content: piece,
        });

        await sendAction(state, action, params);

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
    handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string>;
    handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string>;
  };

  ctx.provide('platform', adapter, { capabilities: ['onebot'] });

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
      headers['Authorization'] = `Bearer ${state.config.accessToken}`;
    }

    const ws = new WebSocket(state.config.url, { headers });
    state.ws = ws;

    // 诊断：捕获 unexpected-response（服务器返回非 101 时触发，且不会触发 error）
    ws.on('unexpected-response', (_req, res) => {
      ctx.logger.warn(`OneBot unexpected-response: status=${res.statusCode}, headers=${JSON.stringify(res.headers)}`);
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => { ctx.logger.warn(`OneBot unexpected-response body: ${body.slice(0, 500)}`); });
    });

    // 连接超时：如果 WS 握手在 CONNECT_TIMEOUT 内未完成，主动关闭并触发重连
    const connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ctx.logger.warn(`OneBot 连接超时 (${CONNECT_TIMEOUT / 1000}s): ${state.config.url}, readyState=${ws.readyState}`);
        ws.terminate();
      }
    }, CONNECT_TIMEOUT);

    ws.on('upgrade', (res) => {
      ctx.logger.debug(`OneBot WS upgrade: status=${res.statusCode}`);
    });

    ws.on('open', () => {
      clearTimeout(connectTimer);
      state.status = 'online';
      state.lastPong = Date.now();
      ctx.logger.info(`OneBot 已连接: ${state.config.url}`);

      // 客户端心跳：定期 ping，检测待机后的死连接
      stopHeartbeat(state);
      ws.on('pong', () => { state.lastPong = Date.now(); });
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

    ws.on('message', (raw) => {
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

    ws.on('error', (err) => {
      clearTimeout(connectTimer);
      ctx.logger.warn(`OneBot 连接错误: ${err.message}, code=${(err as NodeJS.ErrnoException).code}, readyState=${ws.readyState}`);
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
    if (!event) return;

    // 更新 selfId
    if (event.selfId !== 'unknown' && !state.selfId) {
      state.selfId = event.selfId;
    }

    if (shouldSuppressInviteCardMessage(event)) {
      ctx.logger.debug(`OneBot[${state.protocol.version}] 忽略重复入群邀请 JSON 卡片: userId=${event.userId}`);
      return;
    }

    const sessionId = makeSessionId(
      event.selfId, event.detailType,
      event.userId, event.groupId, event.guildId, event.channelId,
    );

    ctx.logger.debug(`OneBot[${state.protocol.version}] 收到消息 [${event.detailType}] ${event.userId ?? '?'}: ${event.text}`);

    // 注：指令解析已迁移到 plugin-commands 的 inbound:command 相位；
    // 适配器只负责将原始消息送入 inbound:message 总线，由 gateway 链路统一拦截。

    const sessionType = event.detailType === 'group' ? 'group'
      : event.detailType === 'private' ? 'private'
      : event.detailType === 'channel' ? 'channel'
      : undefined;

    // 异步获取群信息、引用消息，并执行流控判定
    (async () => {
      let groupName: string | undefined;
      let replyTo: { messageId: string; content?: string; userId?: string; nickname?: string } | undefined;

      // 下载并缓存图片，替换文本中的 [图片] 为 [图片 | ref:path]
      if (event.images && event.images.length > 0) {
        const { text: rewritten } = await cacheImagesAndRewriteText(
          event.text, event.images, sessionId,
        );
        event.text = rewritten;
        // images 保持原始 URL，供中间件/多模态模型使用（当前请求内仍有效）
      }

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
        const reply = await fetchReplyMessage(state, event.replyToMessageId);
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

      ctx.emit('inbound:message', {
        content: event.text,
        sessionId,
        platform: 'onebot',
        userId: event.userId,
        nickname: event.nickname,
        images: event.images,
        sessionType,
        groupName,
        groupId: event.groupId,
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
    if (!req) return;

    const requestLabel = req.requestType === 'group' ? `${req.requestType}/${req.subType}` : req.requestType;
    const requestGroupId = req.requestType === 'group' ? req.groupId : '-';
    ctx.logger.info(`OneBot[${state.protocol.version}] 请求事件: ${requestLabel}, userId=${req.userId}, groupId=${requestGroupId}`);

    if (req.requestType === 'friend') {
      // 存储待处理的好友请求 flag
      pendingFriendRequests.set(req.userId, { flag: req.flag, selfId: req.selfId });

      // 将请求包装为合成消息，交由 agent 决策（以私聊会话形式发送）
      const sessionId = makeSessionId(req.selfId, 'private', req.userId);
      const commentPart = req.comment ? `，验证信息："${req.comment}"` : '';
      const content = `[系统通知] 用户 ${req.userId} 向我发出了好友申请${commentPart}。请决定是否同意，调用 onebot_handle_friend_request 工具处理（user_id="${req.userId}"）。`;

      ctx.emit('inbound:message', {
        content,
        sessionId,
        platform: 'onebot',
        userId: req.userId,
        sessionType: 'private',
      }).catch((err: unknown) => ctx.logger.warn(`请求事件处理失败: ${err}`));

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
        content = `[系统通知] 用户 ${req.userId} 邀请我加入${groupPart}${commentPart}。请决定是否接受邀请，调用 onebot_handle_group_request 工具处理（user_id="${req.userId}", group_id="${req.groupId}"）。`;
      } else {
        // sub_type === 'add': 有人申请加入 bot 管理的群（bot 是管理员）
        const gsId = makeSessionId(req.selfId, 'group', undefined, req.groupId);
        content = `[系统通知] 用户 ${req.userId} 申请加入${groupPart}${commentPart}。请决定是否同意，调用 onebot_handle_group_request 工具处理（user_id="${req.userId}", group_id="${req.groupId}"）。`;
        ctx.emit('inbound:message', {
          content,
          sessionId: gsId,
          platform: 'onebot',
          userId: req.userId,
          sessionType: 'group',
          groupId: req.groupId,
        }).catch((err: unknown) => ctx.logger.warn(`群申请事件处理失败: ${err}`));
        return;
      }

      ctx.emit('inbound:message', {
        content,
        sessionId,
        platform: 'onebot',
        userId: req.userId,
        sessionType: 'private',
      }).catch((err: unknown) => ctx.logger.warn(`邀请事件处理失败: ${err}`));
    }
  }

  function handleNoticeEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const notice = state.protocol.parseNoticeEvent(raw, fallbackSelfId);
    if (!notice) return;

    // 过滤高频无用通知（输入状态等）
    if (notice.noticeType === 'notify' && notice.subType === 'input_status') return;

    ctx.logger.debug(`OneBot[${state.protocol.version}] 通知事件: ${notice.noticeType}${notice.subType ? `/${notice.subType}` : ''}`);

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
        const isLift =
          notice.noticeType === 'group_member_unban' || notice.subType === 'lift_ban';
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
          const targetLabel = isSelf ? '我' : (targetNick ? `${targetNick}(${notice.userId})` : (notice.userId ?? '某人'));
          const verb = isLift ? '解除了禁言' : `禁言了 ${duration > 0 ? duration + ' 秒' : '若干时间'}`;
          const untilTs = isLift ? 0 : (duration > 0 ? Date.now() + duration * 1000 : 0);
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
    if (notice.noticeType === 'group_increase' || notice.noticeType === 'group_decrease' ||
        notice.noticeType === 'group_member_increase' || notice.noticeType === 'group_member_decrease') {
      if (!notice.groupId) return;
      const isJoin = notice.noticeType === 'group_increase' || notice.noticeType === 'group_member_increase';
      const sessionId = makeSessionId(notice.selfId, 'group', undefined, notice.groupId);
      const operatorId = notice.data?.operatorId as string | undefined;
      const isSelf = notice.userId != null && notice.userId === notice.selfId;
      (async () => {
        const userNick = await resolveNickname(state, notice.userId, notice.groupId);
        const opNick = await resolveNickname(state, operatorId, notice.groupId);
        const userLabel = isSelf ? '我' : (userNick ? `${userNick}(${notice.userId})` : (notice.userId ?? '某人'));
        const opLabel = opNick ? `${opNick}(${operatorId})` : operatorId;
        let action: string;
        if (isJoin) {
          action = notice.subType === 'invite' && opLabel ? `被 ${opLabel} 邀请加入了群` : '加入了群';
        } else {
          if (notice.subType === 'kick' && opLabel) action = `被 ${opLabel} 移出群聊`;
          else if (notice.subType === 'kick_me') action = `被 ${opLabel ?? '管理员'} 移出群聊`;
          else action = '退出了群聊';
        }
        const content = `[notice/${notice.noticeType}${notice.subType ? '/' + notice.subType : ''}] ${userLabel} ${action}`;
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
      const isSet = notice.subType === 'set' || notice.subType === 'unban' /* spurious */ ;
      (async () => {
        const userNick = await resolveNickname(state, notice.userId, notice.groupId);
        const userLabel = isSelf ? '我' : (userNick ? `${userNick}(${notice.userId})` : (notice.userId ?? '某人'));
        const action = notice.subType === 'set' ? '被设置为管理员'
                      : notice.subType === 'unset' ? '被取消管理员' : '管理员状态变化';
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
        ctx.logger.info(`OneBot 实现: ${meta.version.impl ?? 'unknown'} v${meta.version.version ?? '?'} (onebot ${meta.version.onebot_version ?? '?'})`);
      }
    } else if (meta.subType === 'heartbeat') {
      // 心跳事件不输出日志
    } else if (meta.subType === 'status_update') {
      ctx.logger.debug(`OneBot[${state.protocol.version}] 状态更新事件`);
    }
  }

  // ----- 群聊时间感知提示 + 特殊事件触发上下文 -----
  // 群聊中多人消息平铺在历史中，注入提示帮助模型关注时间线
  // 特殊事件（如戳一戳、文件上传）触发时注入说明，让模型知道触发原因
  const noticePatterns: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /^\[戳一戳:/, hint: '这条消息不是用户手动输入的文字，而是一个「戳一戳」互动事件——有人戳了你。请根据戳一戳的情境做出自然、俏皮的反应，而不是直接回复消息内容。' },
    { pattern: /^\[文件上传:/, hint: '这条消息不是用户手动输入的文字，而是一个文件上传通知事件。' },
  ];

  ctx.middleware('agent:llm:before', async (data, next) => {
    if (data.sessionId?.includes(':group:')) {
      // 在最后一条用户消息前插入时间感知提示
      let lastUserIdx = -1;
      for (let i = data.messages.length - 1; i >= 0; i--) {
        if (data.messages[i].role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx > 0) {
        data.messages.splice(lastUserIdx, 0, {
          role: 'system',
          content: '注意：以上是群聊的历史消息记录，包含多位群友的发言。'
            + '请留意消息的时间先后顺序，优先关注近期的对话内容和上下文。',
          metadata: { source: 'platform' },
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
              metadata: { source: 'platform' },
            });
            break;
          }
        }
      }
    }

    await next();
  });

  // ----- 监听消息回复事件 -----

  ctx.on('outbound:message', (msg) => {
    if (!msg.sessionId.startsWith('onebot:')) return;
    if (!msg.content?.trim()) {
      ctx.logger.debug(`OneBot 跳过空消息 [${msg.sessionId}]`);
      return;
    }
    ctx.logger.debug(`OneBot 发送消息 [${msg.sessionId}]: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);

    // 冷却 / 退避 / idle 调度由 plugin-flow-control 自行处理（监听 outbound:message）

    adapter.sendMessage(msg.sessionId, msg.content, { skipSplit: msg.source !== 'agent' }).catch(err => {
      ctx.logger.warn(`OneBot 发送消息失败: ${err}`);
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

  ctx.on('dispose', () => {
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
