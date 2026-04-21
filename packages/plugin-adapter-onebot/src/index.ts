import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Context, ConfigSchema, PlatformAdapter, PlatformConnection } from '@aalis/core';
import type { MessageArchiveService, PersonaService } from '@aalis/core';
import type {
  OneBotConnectionConfig,
  OneBotProtocol,
  OneBotRawEvent,
  OneBotActionResponse,
  NormalizedNoticeEvent,
} from './types.js';
import { OneBotV11 } from './v11.js';
import { OneBotV12 } from './v12.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-adapter-onebot';
export const displayName = 'OneBot 适配器';
export const inject = {
  optional: ['llm', 'commands', 'message-archive', 'persona'],
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
    description: '启用后，文本将按标点符号自动拆分为多条消息发送，模拟真人发送习惯',
    fields: {
      enabled: { type: 'boolean', label: '启用', description: '是否启用消息分条发送', default: false },
      delayPerChar: { type: 'number', label: '每字延迟 (ms)', description: '按下一条消息的字数计算延迟，单位毫秒/字', default: 50 },
      maxDelay: { type: 'number', label: '最大延迟 (ms)', description: '分条消息之间的最大延迟上限（毫秒）', default: 3000 },
    },
  },
  chatFlow: {
    label: '聊天流控',
    description: '控制群聊中 AI 回复的触发频率，支持固定间隔和动态活跃度评分两种模式',
    fields: {
      enabled: { type: 'boolean', label: '启用', description: '是否启用聊天流控（仅对群聊生效）', default: false },
      intervalMode: {
        type: 'select',
        label: '间隔模式',
        options: [
          { label: '固定消息条数', value: 'fixed' },
          { label: '动态活跃度评分', value: 'dynamic' },
          { label: '满足任一即触发', value: 'both' },
        ],
        default: 'both',
      },
      fixedInterval: { type: 'number', label: '固定间隔（条）', default: 5, description: '固定模式下每收到 N 条消息触发一次回复。' },
      activityScoreLower: { type: 'number', label: '活跃度下限阈值', default: 0.3, description: '长时间无回复后的触发阈值，越低越容易触发。' },
      activityScoreUpper: { type: 'number', label: '活跃度上限阈值', default: 0.85, description: '刚回复后的触发阈值，越高越不容易再次触发。' },
      activityDecayMinutes: { type: 'number', label: '阈值衰减时间（分钟）', default: 10, description: '回复后阈值从上限衰减回下限所需时间。' },
      scoreDecayMinutes: { type: 'number', label: '发言指数衰减时间（分钟）', default: 0, description: '无人发言后，累积的发言指数线性衰减到 0 所需时间。0 = 不衰减。' },
      triggerOnAt: { type: 'boolean', label: '@ 触发', default: true, description: '消息中包含 @bot 时立刻触发回复。' },
      triggerNames: { type: 'string', label: '触发词 / 昵称', default: '', description: '消息中出现这些词时立刻触发回复，逗号分隔（自动包含人设名称）。' },
      cooldownSeconds: { type: 'number', label: '冷却时间（秒）', default: 10, description: 'AI 回复后的冷却时间。' },
      enableIdleTrigger: { type: 'boolean', label: '空闲主动触发', default: false, description: '长时间无人说话时 AI 是否主动发起话题。' },
      idleTriggerMinutes: { type: 'number', label: '空闲间隔（分钟）', default: 180 },
      idleTriggerStyle: {
        type: 'select',
        label: '空闲重试风格',
        options: [
          { label: '指数退避', value: 'exponential' },
          { label: '固定间隔', value: 'fixed' },
        ],
        default: 'exponential',
      },
      idleTriggerMaxMinutes: { type: 'number', label: '空闲最大间隔（分钟）', default: 1440 },
      idleTriggerJitter: { type: 'boolean', label: '空闲抖动', default: true },
      idleTriggerPrompt: { type: 'textarea', label: '空闲触发提示词', default: '', description: '空闲触发时发送给 Agent 的系统提示。留空使用默认提示。' },
      muteKeywords: { type: 'string', label: '禁言关键词', default: '', description: '逗号分隔。' },
      muteTimeSeconds: { type: 'number', label: '禁言时长（秒）', default: 60 },
      rateLimitWindow: { type: 'number', label: '限速窗口（秒）', default: 0, description: '防 DDoS：在该时间窗口内最多回复 rateLimitMaxReplies 次。0 = 不限速。' },
      rateLimitMaxReplies: { type: 'number', label: '窗口内最大回复次数', default: 10, description: '防 DDoS：限速窗口内允许的最大回复次数。' },
    },
  },
};

export const defaultConfig = {
  connections: [] as OneBotConnectionConfig[],
  splitMessage: {
    enabled: false,
    delayPerChar: 50,
    maxDelay: 3000,
  },
  chatFlow: {
    enabled: false,
    intervalMode: 'both' as const,
    fixedInterval: 5,
    activityScoreLower: 0.3,
    activityScoreUpper: 0.85,
    activityDecayMinutes: 10,
    scoreDecayMinutes: 0,
    triggerOnAt: true,
    triggerNames: '',
    cooldownSeconds: 10,
    enableIdleTrigger: false,
    idleTriggerMinutes: 180,
    idleTriggerStyle: 'exponential' as const,
    idleTriggerMaxMinutes: 1440,
    idleTriggerJitter: true,
    idleTriggerPrompt: '',
    muteKeywords: '',
    muteTimeSeconds: 60,
    rateLimitWindow: 0,
    rateLimitMaxReplies: 10,
  },
};

// ===== 内部类型 =====

/** 单个 WebSocket 连接状态 */
interface ConnectionState {
  config: OneBotConnectionConfig;
  ws?: WebSocket;
  status: 'online' | 'offline' | 'connecting';
  selfId?: string;
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

// ===== 聊天流控类型 =====

/** 聊天流控配置（解析后） */
interface ChatFlowConfig {
  enabled: boolean;
  intervalMode: 'fixed' | 'dynamic' | 'both';
  fixedInterval: number;
  activityScoreLower: number;
  activityScoreUpper: number;
  activityDecayMinutes: number;
  scoreDecayMinutes: number;
  triggerOnAt: boolean;
  triggerNames: string[];
  cooldownSeconds: number;
  enableIdleTrigger: boolean;
  idleTriggerMinutes: number;
  idleTriggerStyle: 'exponential' | 'fixed';
  idleTriggerMaxMinutes: number;
  idleTriggerJitter: boolean;
  idleTriggerPrompt: string;
  muteKeywords: string[];
  muteTimeSeconds: number;
  rateLimitWindow: number;
  rateLimitMaxReplies: number;
}

/** 每个 session 的流控状态 */
interface FlowSessionState {
  messageCount: number;
  lastReplyTime: number;
  lastMessageTime: number;
  activityScore: number;
  cooldownUntil: number;
  mutedUntil: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleBackoff: number;
  userInteractions: Map<string, { count: number; lastTime: number }>;
  /** 滑动窗口内的回复时间戳（用于防 DDoS 限速） */
  replyTimestamps: number[];
}

/** 空闲触发标识 */
const IDLE_TRIGGER_MARKER = '__chat_flow_idle_trigger__';

function parseStringList(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  if (typeof val === 'string' && val.trim()) {
    return val.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function resolveChatFlowConfig(raw: Record<string, unknown>): ChatFlowConfig {
  return {
    enabled: (raw.enabled as boolean) ?? false,
    intervalMode: (raw.intervalMode as ChatFlowConfig['intervalMode']) ?? 'both',
    fixedInterval: (raw.fixedInterval as number) ?? 5,
    activityScoreLower: (raw.activityScoreLower as number) ?? 0.3,
    activityScoreUpper: (raw.activityScoreUpper as number) ?? 0.85,
    activityDecayMinutes: (raw.activityDecayMinutes as number) ?? 10,
    scoreDecayMinutes: (raw.scoreDecayMinutes as number) ?? 0,
    triggerOnAt: (raw.triggerOnAt as boolean) ?? true,
    triggerNames: parseStringList(raw.triggerNames),
    cooldownSeconds: (raw.cooldownSeconds as number) ?? 10,
    enableIdleTrigger: (raw.enableIdleTrigger as boolean) ?? false,
    idleTriggerMinutes: (raw.idleTriggerMinutes as number) ?? 180,
    idleTriggerStyle: (raw.idleTriggerStyle as ChatFlowConfig['idleTriggerStyle']) ?? 'exponential',
    idleTriggerMaxMinutes: (raw.idleTriggerMaxMinutes as number) ?? 1440,
    idleTriggerJitter: (raw.idleTriggerJitter as boolean) ?? true,
    idleTriggerPrompt: (raw.idleTriggerPrompt as string) || '',
    muteKeywords: parseStringList(raw.muteKeywords),
    muteTimeSeconds: (raw.muteTimeSeconds as number) ?? 60,
    rateLimitWindow: (raw.rateLimitWindow as number) ?? 0,
    rateLimitMaxReplies: (raw.rateLimitMaxReplies as number) ?? 10,
  };
}

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
  const rewritten = text.replace(/\[图片\]/g, () => {
    const path = localPaths[idx++];
    return path ? `[图片 | ref:${path}]` : '[图片]';
  });

  return { text: rewritten, localPaths };
}

// ===== 协议版本实例 =====
const protocolV11 = new OneBotV11();
const protocolV12 = new OneBotV12();

// ===== 重连配置 =====
const RECONNECT_INTERVAL = 5000;
const ACTION_TIMEOUT = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 15000;

// ===== 消息分条逻辑 =====

/**
 * 按标点符号（中英文逗号、句号、问号、叹号、分号、顿号、换行等）
 * 将文本拆分为多条消息。XML 标记（<at>、<image> 等）保持与相邻文本在一起。
 * 只拆分纯文本部分，不在 XML 标记中间切割。
 */
function splitMessageByPunctuation(content: string): string[] {
  // 如果内容很短或只有 XML 标记，不拆分
  if (content.length <= 10) return [content];

  // 识别所有 XML 标记的位置，拆分时不切割它们
  const xmlTagRegex = /<(?:at(?:\s+self)?)\s*>[^<]*<\/at>|<face\s+id=["'][^"']*["']\s*\/>|<image\s+url=["'][^"']*["']\s*\/>|<reply\s+id=["'][^"']*["']\s*\/>/g;

  // 将内容拆分为「标记区」和「纯文本区」交替的 token
  interface Token { type: 'text' | 'tag'; value: string }
  const tokens: Token[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = xmlTagRegex.exec(content)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ type: 'text', value: content.slice(lastIdx, m.index) });
    }
    tokens.push({ type: 'tag', value: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < content.length) {
    tokens.push({ type: 'text', value: content.slice(lastIdx) });
  }

  // 在文本 token 内部按标点拆分
  const splitRegex = /(?<=[。！？；\n，、,.!?;])/;
  const pieces: string[] = [];
  let current = '';

  for (const token of tokens) {
    if (token.type === 'tag') {
      current += token.value;
    } else {
      const parts = token.value.split(splitRegex);
      for (let i = 0; i < parts.length; i++) {
        current += parts[i];
        // 在标点后断开，但最后一段不断开（等后续 token 追加）
        if (i < parts.length - 1 && current.trim()) {
          pieces.push(current);
          current = '';
        }
      }
    }
  }
  if (current.trim()) {
    pieces.push(current);
  }

  // 去除每段尾部标点，过滤空段，合并过短段落
  const trailingPunctuation = /[。！？；，、,.!?;\s]+$/;
  const result: string[] = [];
  for (const piece of pieces) {
    // 去除尾部标点符号
    const cleaned = piece.replace(trailingPunctuation, '').trim();
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
  const splitCfg = (config.splitMessage ?? {}) as { enabled?: boolean; delayPerChar?: number; maxDelay?: number };
  const splitEnabled = splitCfg.enabled === true;
  const splitDelayPerChar = Math.max(0, splitCfg.delayPerChar ?? 50);
  const splitMaxDelay = Math.max(0, splitCfg.maxDelay ?? 3000);

  // 聊天流控配置
  const flowCfg = resolveChatFlowConfig((config.chatFlow ?? {}) as Record<string, unknown>);

  if (connections.length === 0) {
    ctx.logger.info('OneBot 适配器未配置任何连接');
  }

  if (flowCfg.enabled) {
    ctx.logger.info(`聊天流控已启用 (模式: ${flowCfg.intervalMode}, 间隔: ${flowCfg.fixedInterval}条, 阈值: ${flowCfg.activityScoreLower}~${flowCfg.activityScoreUpper})`);
  }

  const states: ConnectionState[] = [];

  // ===== 用户昵称缓存（userId → nickname，从每条消息的 sender 信息累积） =====
  const nicknameCache = new Map<string, string>();

  // ===== 聊天流控状态管理 =====

  const flowSessions = new Map<string, FlowSessionState>();

  function getFlowSession(sessionId: string): FlowSessionState {
    let state = flowSessions.get(sessionId);
    if (!state) {
      state = {
        messageCount: 0,
        lastReplyTime: 0,
        lastMessageTime: 0,
        activityScore: 0,
        cooldownUntil: 0,
        mutedUntil: 0,
        idleTimer: null,
        idleBackoff: 1,
        userInteractions: new Map(),
        replyTimestamps: [],
      };
      flowSessions.set(sessionId, state);
    }
    return state;
  }

  // ── 从 persona 获取 bot 名称用于触发检测 ──

  function getBotNames(): string[] {
    const names = [...flowCfg.triggerNames];
    const persona = ctx.getService<PersonaService>('persona');
    if (persona) {
      const personaName = persona.getPersonaName();
      if (personaName && !names.includes(personaName)) names.push(personaName);
      const nickNames = persona.getNickNames?.() ?? [];
      for (const nn of nickNames) {
        if (nn && !names.includes(nn)) names.push(nn);
      }
    }
    return names;
  }

  // ── 即时触发检测 ──

  function checkImmediateTrigger(content: string): boolean {
    if (flowCfg.triggerOnAt) {
      if (/<at self[\s>][^]*?<\/at>/.test(content) ||
          /\[CQ:at,qq=\d+\]/.test(content) ||
          /@\S+/.test(content)) {
        return true;
      }
    }
    const names = getBotNames();
    for (const name of names) {
      if (name && content.includes(name)) return true;
    }
    return false;
  }

  // ── 禁言检测 ──

  function checkMuteKeyword(content: string): boolean {
    for (const keyword of flowCfg.muteKeywords) {
      if (content.includes(keyword)) return true;
    }
    const persona = ctx.getService<PersonaService>('persona');
    const personaMuteKw = persona?.getMuteKeywords?.() ?? [];
    for (const keyword of personaMuteKw) {
      if (content.includes(keyword)) return true;
    }
    return false;
  }

  // ── 动态阈值计算 ──

  function getCurrentThreshold(fState: FlowSessionState): number {
    if (fState.lastReplyTime === 0) return flowCfg.activityScoreLower;
    const elapsed = Date.now() - fState.lastReplyTime;
    const decayMs = flowCfg.activityDecayMinutes * 60 * 1000;
    const factor = Math.max(0, 1 - elapsed / decayMs);
    return flowCfg.activityScoreLower + (flowCfg.activityScoreUpper - flowCfg.activityScoreLower) * factor;
  }

  /**
   * 将 activityScore 按距离上次消息的时间进行线性衰减（原地修改）。
   * scoreDecayMinutes=0 时不衰减。
   */
  function applyScoreDecay(fState: FlowSessionState): void {
    if (flowCfg.scoreDecayMinutes <= 0 || fState.activityScore <= 0 || fState.lastMessageTime === 0) return;
    const elapsed = Date.now() - fState.lastMessageTime;
    const decayMs = flowCfg.scoreDecayMinutes * 60 * 1000;
    const factor = Math.max(0, 1 - elapsed / decayMs);
    fState.activityScore *= factor;
    // 低于极小值直接归零，避免浮点残余
    if (fState.activityScore < 0.001) fState.activityScore = 0;
  }

  function calculateScoreIncrement(fState: FlowSessionState, userId?: string): number {
    const base = 1.0 / Math.max(1, flowCfg.fixedInterval);
    let userWeight = 1.0;
    if (userId) {
      const interaction = fState.userInteractions.get(userId);
      if (interaction) {
        userWeight = 1.0 + 0.5 * Math.min(interaction.count / 10, 1.0);
      }
    }
    return base * userWeight;
  }

  // ── 触发判定 ──

  function shouldTrigger(fState: FlowSessionState): boolean {
    const fixedOk = fState.messageCount >= flowCfg.fixedInterval;
    const dynamicOk = fState.activityScore >= getCurrentThreshold(fState);
    switch (flowCfg.intervalMode) {
      case 'fixed':   return fixedOk;
      case 'dynamic': return dynamicOk;
      case 'both':    return fixedOk || dynamicOk;
      default:        return fixedOk;
    }
  }

  // ── 防 DDoS 限速 ──

  /**
   * 检查是否超过限速上限。返回 true 表示已限速（不应回复）。
   * 同时清理过期的时间戳并在通过时记录本次回复。
   */
  function checkRateLimit(fState: FlowSessionState, sessionId: string): boolean {
    if (flowCfg.rateLimitWindow <= 0 || flowCfg.rateLimitMaxReplies <= 0) return false;
    const windowMs = flowCfg.rateLimitWindow * 1000;
    const now = Date.now();
    // 清除窗口外的旧时间戳
    fState.replyTimestamps = fState.replyTimestamps.filter(t => now - t < windowMs);
    if (fState.replyTimestamps.length >= flowCfg.rateLimitMaxReplies) {
      ctx.logger.info(
        `[限速] session=${sessionId} | ${flowCfg.rateLimitWindow}s 内已回复 ${fState.replyTimestamps.length}/${flowCfg.rateLimitMaxReplies} 次，拒绝触发`,
      );
      return true;
    }
    return false;
  }

  /** 记录一次回复（限速窗口计数） */
  function recordReply(fState: FlowSessionState): void {
    fState.replyTimestamps.push(Date.now());
  }

  // ── 触发后重置 ──

  function resetAfterTrigger(fState: FlowSessionState): void {
    fState.messageCount = 0;
    fState.activityScore = 0;
    fState.lastReplyTime = Date.now();
  }

  // ── 保存缓冲消息到记忆 ──

  async function saveBufferedMessage(sessionId: string, content: string, nickname?: string, userId?: string, images?: string[]): Promise<void> {
    const archive = ctx.getService<MessageArchiveService>('message-archive');
    if (!archive) return;
    try {
      await archive.archiveIncoming({
        content,
        sessionId,
        platform: 'onebot',
        userId,
        nickname,
        images,
      });
    } catch (err) {
      ctx.logger.warn(`保存缓冲消息失败: ${err}`);
    }
  }

  // ── 空闲触发 ──

  function scheduleIdleTrigger(fState: FlowSessionState, sessionId: string, platform: string): void {
    clearIdleTimer(fState);
    if (!flowCfg.enableIdleTrigger) return;

    let delayMs: number;
    if (flowCfg.idleTriggerStyle === 'exponential') {
      delayMs = Math.min(
        flowCfg.idleTriggerMinutes * fState.idleBackoff * 60 * 1000,
        flowCfg.idleTriggerMaxMinutes * 60 * 1000,
      );
    } else {
      delayMs = flowCfg.idleTriggerMinutes * 60 * 1000;
    }

    if (flowCfg.idleTriggerJitter) {
      const jitter = delayMs * (0.1 * (Math.random() * 2 - 1));
      delayMs = Math.max(60_000, delayMs + jitter);
    }

    fState.idleTimer = setTimeout(async () => {
      try {
        ctx.logger.info(`空闲触发: session=${sessionId} (退避 x${fState.idleBackoff})`);
        if (flowCfg.idleTriggerStyle === 'exponential') {
          fState.idleBackoff = Math.min(fState.idleBackoff * 2, 64);
        }
        await ctx.emit('message:received', {
          content: IDLE_TRIGGER_MARKER,
          sessionId,
          platform,
        });
        scheduleIdleTrigger(fState, sessionId, platform);
      } catch (err) {
        ctx.logger.warn(`空闲触发执行失败: ${err}`);
      }
    }, delayMs);

    ctx.logger.debug(`空闲触发已调度: session=${sessionId}, ${Math.round(delayMs / 60_000)}分钟后`);
  }

  function clearIdleTimer(fState: FlowSessionState): void {
    if (fState.idleTimer) {
      clearTimeout(fState.idleTimer);
      fState.idleTimer = null;
    }
  }

  // ── debug 日志：展示消息计数和发言指数 ──

  function logFlowStatus(sessionId: string, fState: FlowSessionState, label: string): void {
    const threshold = getCurrentThreshold(fState);
    ctx.logger.debug(
      `[流控] ${label} | session=${sessionId} | ` +
      `消息计数=${fState.messageCount}/${flowCfg.fixedInterval} | ` +
      `发言指数=${fState.activityScore.toFixed(3)} (阈值=${threshold.toFixed(3)}, 范围=${flowCfg.activityScoreLower}~${flowCfg.activityScoreUpper})`
    );
  }

  // ── 流控核心判定：返回 true 表示放行，false 表示拦截 ──

  async function handleFlowControl(
    sessionId: string,
    content: string,
    sessionType: string | undefined,
    userId?: string,
    nickname?: string,
    images?: string[],
  ): Promise<boolean> {
    // 只对群聊启用流控
    if (!flowCfg.enabled || sessionType !== 'group') return true;

    // 空闲触发消息直接放行（替换内容在 middleware 层处理不到，这里直接返回 true）
    if (content === IDLE_TRIGGER_MARKER) return true;

    const fState = getFlowSession(sessionId);
    const now = Date.now();

    // 先对发言指数做时间衰减（基于上一条消息到现在的间隔）
    applyScoreDecay(fState);

    // 更新用户交互记录
    if (userId) {
      const prev = fState.userInteractions.get(userId) ?? { count: 0, lastTime: 0 };
      fState.userInteractions.set(userId, { count: prev.count + 1, lastTime: now });
    }
    fState.lastMessageTime = now;

    // 禁言检测
    if (checkMuteKeyword(content)) {
      fState.mutedUntil = now + flowCfg.muteTimeSeconds * 1000;
      fState.messageCount = 0;
      fState.activityScore = 0;
      ctx.logger.info(`禁言触发: session=${sessionId}, ${flowCfg.muteTimeSeconds}秒`);
      logFlowStatus(sessionId, fState, '禁言 → 计数器归零');
      await saveBufferedMessage(sessionId, content, nickname, userId, images);
      scheduleIdleTrigger(fState, sessionId, 'onebot');
      return false;
    }

    // 仍在禁言中
    if (now < fState.mutedUntil) {
      logFlowStatus(sessionId, fState, '禁言中');
      await saveBufferedMessage(sessionId, content, nickname, userId, images);
      return false;
    }

    // 仍在冷却中
    if (now < fState.cooldownUntil) {
      fState.messageCount++;
      fState.activityScore += calculateScoreIncrement(fState, userId);
      logFlowStatus(sessionId, fState, '冷却中');
      await saveBufferedMessage(sessionId, content, nickname, userId, images);
      scheduleIdleTrigger(fState, sessionId, 'onebot');
      return false;
    }

    // 即时触发（@、名字）
    if (checkImmediateTrigger(content)) {
      // 防 DDoS：即使被 @ 也要检查限速
      if (checkRateLimit(fState, sessionId)) {
        fState.messageCount++;
        fState.activityScore += calculateScoreIncrement(fState, userId);
        logFlowStatus(sessionId, fState, '即时触发 → 限速拦截');
        await saveBufferedMessage(sessionId, content, nickname, userId, images);
        scheduleIdleTrigger(fState, sessionId, 'onebot');
        return false;
      }
      ctx.logger.debug(`即时触发 (@ / 名字): session=${sessionId}`);
      resetAfterTrigger(fState);
      recordReply(fState);
      fState.idleBackoff = 1;
      logFlowStatus(sessionId, fState, '即时触发 → 计数器归零');
      scheduleIdleTrigger(fState, sessionId, 'onebot');
      return true;
    }

    // 累加计数和评分
    fState.messageCount++;
    fState.activityScore += calculateScoreIncrement(fState, userId);

    // 间隔触发判定
    if (shouldTrigger(fState)) {
      // 防 DDoS：检查限速
      if (checkRateLimit(fState, sessionId)) {
        logFlowStatus(sessionId, fState, '间隔触发 → 限速拦截');
        await saveBufferedMessage(sessionId, content, nickname, userId, images);
        scheduleIdleTrigger(fState, sessionId, 'onebot');
        return false;
      }
      logFlowStatus(sessionId, fState, '间隔触发 → 计数器归零');
      resetAfterTrigger(fState);
      recordReply(fState);
      fState.idleBackoff = 1;
      scheduleIdleTrigger(fState, sessionId, 'onebot');
      return true;
    }

    // 未触发，缓冲消息
    logFlowStatus(sessionId, fState, '未触发');
    await saveBufferedMessage(sessionId, content, nickname, userId, images);
    scheduleIdleTrigger(fState, sessionId, 'onebot');
    return false;
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

  /** 获取引用消息的内容 */
  async function fetchReplyMessage(state: ConnectionState, messageId: string): Promise<{
    content?: string; userId?: string; nickname?: string;
  } | null> {
    try {
      const data = await sendAction(state, 'get_msg', {
        message_id: Number(messageId) || messageId,
      }) as Record<string, unknown>;
      const message = Array.isArray(data.message) ? data.message : [];
      const sender = data.sender as Record<string, unknown> | undefined;
      // 提取纯文本内容
      let content = '';
      for (const seg of message) {
        const s = seg as Record<string, unknown>;
        if (s.type === 'text') content += String((s.data as Record<string, unknown>)?.text ?? '');
      }
      return {
        content: content || (data.raw_message as string) || undefined,
        userId: data.user_id != null ? String(data.user_id) : undefined,
        nickname: (sender?.card as string) || (sender?.nickname as string) || undefined,
      };
    } catch {
      return null;
    }
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

    getConnections(): PlatformConnection[] {
      return states.map(s => ({
        id: `onebot:${s.selfId ?? s.config.url}`,
        platform: 'onebot',
        selfId: s.selfId,
        status: s.status,
        detail: {
          url: s.config.url,
          protocol: s.protocol?.version ?? 'unknown',
        },
      }));
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

      const state = states.find(s => s.selfId === parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws || !state.protocol) {
        ctx.logger.warn(`OneBot 连接不可用: selfId=${parsed.selfId}`);
        return;
      }

      // 消息分条发送（指令回复等短消息可跳过）
      const pieces = (splitEnabled && !options?.skipSplit) ? splitMessageByPunctuation(content) : [content];

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

      const state = states.find(s => s.selfId === parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws) {
        throw new Error(`OneBot 连接不可用: selfId=${parsed.selfId}`);
      }

      return sendAction(state, action, params);
    },
  };

  ctx.provide('platform', adapter, { capabilities: ['onebot'] });

  // ----- 连接管理 -----

  function connectOne(connConfig: OneBotConnectionConfig): ConnectionState {
    const state: ConnectionState = {
      config: connConfig,
      status: 'offline',
      selfId: connConfig.selfId,
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
    ws.on('unexpected-response', (req, res) => {
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

    // 2. 获取 self info
    if (!state.selfId) {
      try {
        const action = state.protocol.getSelfInfoAction();
        const data = await sendAction(state, action, {});
        const selfId = state.protocol.parseSelfInfo(data);
        if (selfId) {
          state.selfId = selfId;
          ctx.logger.info(`OneBot self_id: ${state.selfId} (via ${action})`);
        }
      } catch (err) {
        ctx.logger.debug(`获取 self info 失败: ${err}`);
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

    const sessionId = makeSessionId(
      event.selfId, event.detailType,
      event.userId, event.groupId, event.guildId, event.channelId,
    );

    ctx.logger.debug(`OneBot[${state.protocol.version}] 收到消息 [${event.detailType}] ${event.userId ?? '?'}: ${event.text}`);

    // 指令处理
    const parsed = ctx.commands?.parseCommand(event.text);
    if (parsed) {
      ctx.commands!.execute(parsed.name, {
        sessionId,
        platform: 'onebot',
        userId: event.userId,
        args: parsed.args,
        raw: parsed.raw,
      }).then((result) => {
        if (result) {
          adapter.sendMessage(sessionId, result, { skipSplit: true }).catch(err => {
            ctx.logger.warn(`OneBot 指令回复失败: ${err}`);
          });
        }
      }).catch(err => {
        ctx.logger.warn(`OneBot 指令执行失败: ${err}`);
      });
      return;
    }

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

      // 流控判定：返回 false 表示拦截（消息已缓冲到记忆）
      const shouldEmit = await handleFlowControl(sessionId, event.text, sessionType, event.userId, event.nickname, event.images);
      if (!shouldEmit) return;

      ctx.emit('message:received', {
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
      });
    })().catch(err => {
      ctx.logger.warn(`OneBot 消息处理异常: ${err}`);
    });
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
          ctx.emit('message:received', {
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
          ctx.emit('message:received', {
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

    // 群文件上传 → 转化为 message:received
    if (notice.noticeType === 'group_upload' && notice.groupId) {
      const selfId = notice.selfId;
      const sessionId = makeSessionId(selfId, 'group', notice.userId, notice.groupId);
      const fileName = notice.data?.fileName ?? '未知文件';
      const content = `[文件上传: ${notice.userId} 上传了 ${fileName}]`;

      ctx.emit('message:received', {
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

  ctx.middleware('llm-call:before', async (data, next) => {
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

  ctx.on('message:send', (msg) => {
    if (!msg.sessionId.startsWith('onebot:')) return;
    if (!msg.content?.trim()) {
      ctx.logger.debug(`OneBot 跳过空消息 [${msg.sessionId}]`);
      return;
    }
    ctx.logger.debug(`OneBot 发送消息 [${msg.sessionId}]: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);

    // 流控：设置冷却、重置退避
    if (flowCfg.enabled) {
      const fState = flowSessions.get(msg.sessionId);
      if (fState) {
        if (flowCfg.cooldownSeconds > 0) {
          fState.cooldownUntil = Date.now() + flowCfg.cooldownSeconds * 1000;
        }
        fState.idleBackoff = 1;
        scheduleIdleTrigger(fState, msg.sessionId, 'onebot');
      }
    }

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
    // 清理流控定时器
    for (const [, fState] of flowSessions) {
      clearIdleTimer(fState);
    }
    flowSessions.clear();

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
