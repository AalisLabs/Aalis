import { media } from '@aalis/api-media';
import {
  callPlatformAction,
  getPlatformAdapters,
  getPlatformNames,
  type PlatformAdapter,
  platform as platformService,
  resolvePlatformBySession,
} from '@aalis/api-platform';
import { type SessionHistoryReadResult, sessionHistory } from '@aalis/api-session-history';
import { sessionManager, TAKE_UNKNOWN, takeFrom } from '@aalis/api-session-manager';
import type { BoundTools, ToolCallContext } from '@aalis/api-tools';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, events, logger, optional } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { toSource } from '@aalis/schema-i18n';
import { t } from './texts.js';

// ===== 插件元数据 =====

const configSchema = defineConfig({
  groupManagement: {
    label: t('groupManagementLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('groupManagementEnabledLabel'),
        default: true,
        description: t('groupManagementEnabledDescription'),
      },
    },
  },
  groupInfo: {
    label: t('groupInfoLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('groupInfoEnabledLabel'),
        default: true,
        description: t('groupInfoEnabledDescription'),
      },
    },
  },
  account: {
    label: t('accountLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('accountEnabledLabel'),
        default: true,
        description: t('accountEnabledDescription'),
      },
    },
  },
  interaction: {
    label: t('interactionLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('interactionEnabledLabel'),
        default: true,
        description: t('interactionEnabledDescription'),
      },
    },
  },
  sessionHistory: {
    label: t('sessionHistoryLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('sessionHistoryEnabledLabel'),
        default: true,
        description: t('sessionHistoryEnabledDescription'),
      },
      maxLimit: {
        type: 'number',
        label: t('maxLimitLabel'),
        default: 100,
        description: t('maxLimitDescription'),
      },
      defaultLimit: {
        type: 'number',
        label: t('defaultLimitLabel'),
        default: 20,
        description: t('defaultLimitDescription'),
      },
    },
  },
});

// ===== 能力声明 =====

const uses = {
  tools: optional(tools),
  platform: optional(platformService),
  media: optional(media),
  sessionHistory: optional(sessionHistory),
  /**
   * onebot_get_msg 取到的消息所在的会话、onebot_recall_self 的目标会话与 onebot_get_forward_msg 取的转发收到它的会话按它的
   * 规则判（takeFrom）；不在时只能取当前会话里的
   */
  sessionManager: optional(sessionManager),
  events,
  logger,
  config,
};
type Caps = BoundOf<typeof uses>;

/** 平台适配器引用：工具的平台动作全部按会话 id 里的账号路由到所属的 OneBot 实例 */
type PlatformRef = Caps['platform'];
/** 绝大多数工具只需要平台适配器与日志 */
type ToolCaps = Pick<Caps, 'platform' | 'logger'>;
/** 群管理另有撤回自己发的消息：目标会话按会话管理的规则判 */
type GroupManagementCaps = ToolCaps & Pick<Caps, 'sessionManager'>;
/** 合并转发展开还要识别其中的图片 */
type ForwardCaps = Pick<Caps, 'platform' | 'logger' | 'media'>;
/** 群信息查询另有按 id 取消息：取到的消息所在的会话按会话管理的规则判 */
type GroupInfoCaps = ForwardCaps & Pick<Caps, 'sessionManager'>;

// ===== 辅助函数 =====

/** 从 sessionId 解析 OneBot 连接信息 */
function parseOneBotSession(sessionId: string): { selfId: string; detailType: string; targetId: string } | null {
  const parts = sessionId.split(':');
  if (parts[0] !== 'onebot' || parts.length < 4) return null;
  return {
    selfId: parts[1],
    detailType: parts[2],
    targetId: parts.slice(3).join(':'),
  };
}

/** 每个用到机器人账号的工具都带的 self_id 参数 */
const SELF_ID_PARAM = {
  type: 'string',
  description: '机器人账号（QQ 号）。在 OneBot 会话里可以省，用这个会话的账号；不在 OneBot 会话里且有多个账号时必填',
};

/**
 * 本次调用用哪个机器人账号：写明的 self_id；否则当前 OneBot 会话的账号；都没有时汇总各 OneBot 实例的已知账号（不论在不在线），
 * 恰好一个才用它，多个时报错列出账号、要求写明。子任务会话不算 OneBot 会话，账号不从根会话推
 */
function resolveSelfId(platform: PlatformRef, callCtx: ToolCallContext, args: Record<string, unknown>): string {
  const fromArgs = args.self_id != null && String(args.self_id).trim() ? String(args.self_id).trim() : '';
  if (fromArgs) return fromArgs;
  const parsed = parseOneBotSession(callCtx.sessionId);
  if (parsed?.selfId) return parsed.selfId;
  const known = new Map(
    getPlatformAdapters(platform)
      .filter(a => a.platform === 'onebot')
      .flatMap(a => a.getConnections())
      .flatMap(c => (c.selfId ? [[c.selfId, c.status] as const] : [])),
  );
  if (known.size === 1) return [...known.keys()][0];
  if (known.size === 0) throw new Error('未找到 OneBot 账号');
  const listed = [...known].map(([selfId, status]) => `${selfId}(${status})`).join('、');
  throw new Error(`有 ${known.size} 个 OneBot 账号：${listed}，请用 self_id 写明用哪个`);
}

/**
 * 解析"目标群"：args.group_id 优先；否则当前会话必须在 OneBot 群里。
 * 不再限制工具必须在群会话上下文中调用。
 */
function resolveGroupTarget(
  platform: PlatformRef,
  callCtx: ToolCallContext,
  args: Record<string, unknown>,
): { selfId: string; groupId: string } {
  const argGroupId = args.group_id != null && String(args.group_id).trim() ? String(args.group_id).trim() : '';
  const selfId = resolveSelfId(platform, callCtx, args);
  if (argGroupId) return { selfId, groupId: argGroupId };
  const parsed = parseOneBotSession(callCtx.sessionId);
  if (parsed?.detailType === 'group' && parsed.targetId) {
    return { selfId, groupId: parsed.targetId };
  }
  throw new Error('未提供 group_id，且当前不在 OneBot 群会话中。请在参数中显式传入 group_id。');
}

function buildOneBotSessionId(selfId: string, detailType: string, targetId: string): string {
  return `onebot:${selfId}:${detailType}:${targetId}`;
}

/**
 * get_msg 取到的消息所在的会话：群按群号，私聊按对端账号（发送者不是机器人自己时就是发送者）。她自己发的私聊消息与没给这些
 * 字段的实现端拼不出，为 undefined
 */
function sessionOfMessage(selfId: string, data: Record<string, unknown> | null): string | undefined {
  const sender = data?.sender as Record<string, unknown> | undefined;
  if (data?.message_type === 'group' && data.group_id != null) {
    return buildOneBotSessionId(selfId, 'group', String(data.group_id));
  }
  if (data?.message_type === 'private' && sender?.user_id != null && String(sender.user_id) !== selfId) {
    return buildOneBotSessionId(selfId, 'private', String(sender.user_id));
  }
  return undefined;
}

/**
 * 机器人账号的合成会话 id。路由与适配器都只看 id 里的 selfId（路由找到账号所属的实例，适配器定位它的连接），
 * 与目标会话类型无关。
 */
function selfSessionId(selfId: string): string {
  return buildOneBotSessionId(selfId, 'internal', '0');
}

/** 调用 OneBot 协议 action：selfId 决定走哪个机器人账号，经平台路由发到账号所属实例的连接 */
async function callAction(
  platform: PlatformRef,
  selfId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return callPlatformAction(platform, selfSessionId(selfId), action, params);
}

/** 适配器的动作失败：实现端回「不支持该动作」时带 unsupported（OneBot 适配器按协议的返回码标） */
type OneBotActionFailure = Error & { unsupported?: boolean };

/**
 * 按顺序调候选动作名，只有实现端回不支持该动作时才换下一个；其余错误（超时、没权限、对方不在群）原样抛出，不换个动作再做
 * 一次。戳一戳的动作名各实现端不同：NapCat 是 group_poke、friend_poke 与 send_poke，没有 send_group_poke，群里在 NapCat 上
 * 只有 group_poke 一个，后面的候选留给别的实现端
 */
async function callFirstSupported(
  platform: PlatformRef,
  selfId: string,
  actions: readonly string[],
  params: Record<string, unknown>,
): Promise<unknown> {
  const [action, ...rest] = actions;
  try {
    return await callAction(platform, selfId, action, params);
  } catch (err) {
    if (rest.length === 0 || (err as OneBotActionFailure).unsupported !== true) throw err;
    return callFirstSupported(platform, selfId, rest, params);
  }
}

interface ForwardImageRef {
  source: string;
  segment: Record<string, unknown>;
}

interface ForwardFormatContext {
  imageDescriptions: Map<string, string>;
}

function imageRefKey(ref: ForwardImageRef): string {
  return `${ref.source}|${JSON.stringify(ref.segment)}`;
}

function imageSourceFromSegment(data: Record<string, unknown>): string {
  const direct = data.url ?? data.file;
  return direct == null ? '' : String(direct);
}

function extractCqImageRefs(content: string): ForwardImageRef[] {
  const refs: ForwardImageRef[] = [];
  const re = /\[CQ:image,([^\]]+)\]/g;
  let match: RegExpExecArray | null = re.exec(content);
  while (match !== null) {
    const params: Record<string, unknown> = {};
    for (const part of match[1].split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      params[part.slice(0, eq)] = part
        .slice(eq + 1)
        .replace(/&amp;/g, '&')
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&#44;/g, ',');
    }
    const source = imageSourceFromSegment(params);
    if (source) refs.push({ source, segment: params });
    match = re.exec(content);
  }
  return refs;
}

function extractImageRefsFromContent(content: unknown): ForwardImageRef[] {
  if (typeof content === 'string') return extractCqImageRefs(content);
  if (!Array.isArray(content)) return [];

  const refs: ForwardImageRef[] = [];
  for (const seg of content) {
    if (!seg || typeof seg !== 'object') continue;
    const segment = seg as { type?: string; data?: Record<string, unknown> };
    if (segment.type !== 'image') continue;
    const data = segment.data ?? {};
    const source = imageSourceFromSegment(data);
    if (source) refs.push({ source, segment: data });
  }
  return refs;
}

/** 合并转发的节点：data 本身、data.messages 或 data.message 是数组；都不是时返回格式认不出，为 undefined */
function getForwardMessages(data: unknown): unknown[] | undefined {
  const root = data as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(root)) return root;
  if (Array.isArray((root as Record<string, unknown> | null)?.messages)) {
    return (root as Record<string, unknown>).messages as unknown[];
  }
  if (Array.isArray((root as Record<string, unknown> | null)?.message)) {
    return (root as Record<string, unknown>).message as unknown[];
  }
  return undefined;
}

function getForwardNodeData(item: unknown): Record<string, unknown> {
  const node = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  if (node.type === 'node' && node.data && typeof node.data === 'object') {
    return node.data as Record<string, unknown>;
  }
  return node;
}

function getForwardNodeContent(item: unknown): unknown {
  const node = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  const nodeData = getForwardNodeData(item);
  return nodeData.content ?? node.content ?? nodeData.message ?? node.message;
}

function collectForwardImageRefs(data: unknown, limit: number): ForwardImageRef[] {
  return (getForwardMessages(data) ?? [])
    .slice(0, limit)
    .flatMap(item => extractImageRefsFromContent(getForwardNodeContent(item)));
}

/** 消息段里能当来源读的：网址，或 `data:` 后面紧跟 MIME 类型的 base64 data URL（与 onebot 适配器的 segmentSource 同一条规则） */
const SEGMENT_SOURCE = /^(?:https?:\/\/|data:[\w.+-]+\/[\w.+-]+(?:;[^;,]*)*;base64,)/i;

/**
 * 转发里一张图交给识图的来源。图片段里写的只认网址与 base64 的 data URL；别的（文件名、本机路径、像存储地址的串）只当
 * get_image 的 file 参数，读的是实现端交回的地址（自己发起的请求的应答），段里写的不读：群友能给文件起名。交回的地址原样
 * 交给识图，由 media 按文件头认；换不出地址的为 undefined，这张图不识别
 */
async function resolveForwardImageSource(
  caps: ForwardCaps,
  selfId: string,
  ref: ForwardImageRef,
): Promise<string | undefined> {
  if (SEGMENT_SOURCE.test(ref.source)) return ref.source;
  const { platform, logger } = caps;

  try {
    const imageData = (await callAction(platform, selfId, 'get_image', { file: ref.source })) as Record<
      string,
      unknown
    >;
    const resolvedSource = imageData.url ?? imageData.file;
    return typeof resolvedSource === 'string' ? resolvedSource : undefined;
  } catch (err) {
    logger.use.debug(`get_image 解析转发图片失败 (${ref.source}): ${err}`);
    return undefined;
  }
}

/** signal 是这次工具调用的，交给识图 */
async function recognizeForwardImages(
  caps: ForwardCaps,
  selfId: string,
  data: unknown,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<ForwardFormatContext> {
  const refs = collectForwardImageRefs(data, limit);
  const imageDescriptions = new Map<string, string>();
  if (refs.length === 0) return { imageDescriptions };

  const { logger, media } = caps;
  if (!media.present) {
    logger.use.debug(`合并转发包含 ${refs.length} 张图片，但 media 服务不可用`);
    return { imageDescriptions };
  }
  const mediaService = media.use;

  const seen = new Set<string>();
  for (const ref of refs) {
    const key = imageRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const imageSource = await resolveForwardImageSource(caps, selfId, ref);
      if (!imageSource) continue;
      const description = await mediaService.describeImage(imageSource, { signal });
      if (description) imageDescriptions.set(key, description);
    } catch (err) {
      // 中止时后面的图不再识别，也不把缺了描述的正文当结果交出：抛中止原因
      signal?.throwIfAborted();
      logger.use.debug(`合并转发图片识别失败 (${ref.source}): ${err}`);
    }
  }

  return { imageDescriptions };
}

function formatMessageContent(content: unknown, context?: ForwardFormatContext): string {
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

  return content
    .map(seg => {
      if (!seg || typeof seg !== 'object') return String(seg ?? '');
      const segment = seg as { type?: string; data?: Record<string, unknown> };
      const data = segment.data ?? {};
      switch (segment.type) {
        case 'text':
          return String(data.text ?? '');
        case 'at':
          return data.qq === 'all' ? '@全体成员' : `@${String(data.qq ?? '')}`;
        case 'image': {
          const source = imageSourceFromSegment(data);
          const desc = source ? context?.imageDescriptions.get(imageRefKey({ source, segment: data })) : undefined;
          return desc ? `[图片: ${desc}]` : '[图片]';
        }
        case 'face':
          return `[表情:${String(data.id ?? '')}]`;
        case 'reply':
          return '';
        case 'forward':
          return data.id ? `[合并转发:${String(data.id)}]` : '[合并转发]';
        case 'record':
          return '[语音]';
        case 'video':
          return '[视频]';
        case 'share':
          return `[分享:${String(data.title ?? '')}]`;
        case 'json':
          return '[JSON卡片]';
        case 'xml':
          return '[XML卡片]';
        default:
          return segment.type ? `[${segment.type}]` : '';
      }
    })
    .join('');
}

function formatCqMessageContent(content: string, context?: ForwardFormatContext): string {
  let imageIndex = 0;
  return content.replace(/\[CQ:image,([^\]]+)\]/g, raw => {
    const refs = extractCqImageRefs(raw);
    const ref = refs[0];
    if (!ref) return '[图片]';
    imageIndex++;
    const desc = context?.imageDescriptions.get(imageRefKey(ref));
    return desc ? `[图片${imageIndex > 1 ? imageIndex : ''}: ${desc}]` : '[图片]';
  });
}

function formatForwardMessage(data: unknown, limit: number, context?: ForwardFormatContext): string {
  const rawMessages = getForwardMessages(data);
  if (!rawMessages) throw new Error('合并转发的返回格式认不出');
  if (!rawMessages.length) return '合并转发内容为空';

  const messages = rawMessages.slice(0, limit);
  const lines = messages.map((item, index) => {
    const node = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const nodeData = getForwardNodeData(item);
    const sender =
      node.sender && typeof node.sender === 'object' ? (node.sender as Record<string, unknown>) : undefined;
    const name = String(
      nodeData.nickname ??
        sender?.nickname ??
        nodeData.name ??
        nodeData.user_id ??
        sender?.user_id ??
        `节点${index + 1}`,
    );
    const userId = nodeData.user_id ?? nodeData.uin ?? sender?.user_id;
    const prefix = userId != null ? `${name}(${String(userId)})` : name;
    const rawContent = getForwardNodeContent(item);
    const content =
      typeof rawContent === 'string'
        ? formatCqMessageContent(rawContent, context)
        : formatMessageContent(rawContent, context);
    return `${index + 1}. ${prefix}: ${content || '[空消息]'}`;
  });

  const header = `合并转发共 ${rawMessages.length} 条${rawMessages.length > messages.length ? `，以下显示前 ${messages.length} 条` : ''}:`;
  return `${header}\n${lines.join('\n')}`;
}

// ===== 权限检查辅助 =====

const ROLE_LEVEL: Record<string, number> = { owner: 3, admin: 2, member: 1 };

function roleLevel(role: string): number {
  return ROLE_LEVEL[role] ?? 0;
}

/** 查询群成员信息，失败时抛出适配器的原话 */
async function getGroupMemberInfo(
  platform: PlatformRef,
  selfId: string,
  groupId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  return (await callAction(platform, selfId, 'get_group_member_info', {
    group_id: Number(groupId),
    user_id: Number(userId),
    no_cache: true,
  })) as Record<string, unknown> | null;
}

/**
 * 机器人在群里的角色够不够做这个管理操作，不够时抛错。取不到机器人自身信息或其中没有角色时放过检查：真不够权限时实现端的
 * 返回码会报出来。目标成员的信息或角色取不到（查询失败，或实现端回成功却没给）时报错，不当成普通成员
 */
async function assertAdminPermission(
  platform: PlatformRef,
  selfId: string,
  groupId: string,
  targetUserId?: string,
  requireOwner?: boolean,
): Promise<void> {
  const selfInfo = await getGroupMemberInfo(platform, selfId, groupId, selfId).catch(() => null);
  if (!selfInfo?.role) return;

  const selfRole = String(selfInfo.role);

  if (requireOwner && selfRole !== 'owner') {
    throw new Error(`操作失败：此操作仅群主可执行（当前角色：${selfRole}）`);
  }
  if (selfRole === 'member') {
    throw new Error(`操作失败：机器人不是管理员（当前角色：${selfRole}），无法执行管理操作`);
  }

  if (targetUserId) {
    const targetInfo = await getGroupMemberInfo(platform, selfId, groupId, targetUserId).catch((err: unknown) => {
      throw new Error(
        `操作失败：无法获取用户 ${targetUserId} 的信息：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (!targetInfo) throw new Error(`操作失败：无法获取用户 ${targetUserId} 的信息：实现端没给成员信息`);
    if (!targetInfo.role) throw new Error(`操作失败：无法获取用户 ${targetUserId} 的信息：实现端没给成员角色`);
    const targetRole = String(targetInfo.role);
    if (roleLevel(targetRole) >= roleLevel(selfRole)) {
      const targetLabel = targetRole === 'owner' ? '群主' : '管理员';
      throw new Error(`操作失败：无法对${targetLabel}执行此操作（机器人角色：${selfRole}，目标角色：${targetRole}）`);
    }
  }
}

// ===== 插件入口 =====

/**
 * OneBot 工具按职责语义拆成三组（彼此互不重叠）：
 * - onebot-daily：只读查询 + 日常低风险互动（戳一戳、点赞）
 * - onebot-group：群务管理（禁言/踢人/撤回/改群名/设管理员/群打卡/审批加群申请 等）
 * - onebot-personal：影响 bot 账号本身的人际关系（退群/删好友/处理好友申请/接受入群邀请）
 */
interface OneBotToolBundle {
  daily: BoundTools;
  group: BoundTools;
  personal: BoundTools;
}

export default definePlugin({
  name: '@aalis/plugin-tool-onebot',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  uses,
  apply(caps) {
    const { tools, events, logger, platform } = caps;
    const cfg = parseConfig(configSchema, caps.config.use, logger.use);
    const bundle: OneBotToolBundle = {
      daily: withToolGroups(tools.use, ['onebot-daily']),
      group: withToolGroups(tools.use, ['onebot-group']),
      personal: withToolGroups(tools.use, ['onebot-personal']),
    };

    const maxLimit = Math.max(1, Math.min(1000, cfg.sessionHistory.maxLimit || 100));
    const defaultLimitRaw = Math.max(1, Math.floor(cfg.sessionHistory.defaultLimit || 20));
    const historyCfg: OneBotSessionHistoryConfig = { maxLimit, defaultLimit: Math.min(defaultLimitRaw, maxLimit) };

    // 仅当 OneBot 平台可用时才注册工具。platform 是可选的多提供者服务，OneBot 适配器可能晚于
    // app:ready 上线（WebUI 启用、市场热装、启动失败后修好），且作为非胜者上线时 follow 不触发：
    // 故在 app:ready 与每次 platform 提供者注册时各判一次，出现 onebot 即注册，之后不再重复。
    // 平台离场不反注册：工具调用时找不到 OneBot 连接本就会报错。
    let toolsRegistered = false;
    const registerToolsOnce = (): void => {
      if (toolsRegistered || !getPlatformNames(platform).includes('onebot')) return;
      toolsRegistered = true;

      logger.use.info('检测到 OneBot 平台，开始注册 OneBot 工具');

      // 注册工具分组：按职责语义切分，彼此不重叠
      tools.use.registerGroup({
        name: 'onebot-daily',
        label: t('dailyGroup'),
        summary: t('dailyGroupSummary'),
        description: '只读查询（群信息/成员/好友列表/历史/登录信息）+ 日常低风险互动（戳一戳、好友赞）',
      });
      tools.use.registerGroup({
        name: 'onebot-group',
        label: t('groupGroup'),
        summary: t('groupGroupSummary'),
        description: '群务管理：禁言/全员禁言/踢人/撤回消息/设置群名片/改群名/设管理员/群打卡/审批加群申请 等',
      });
      tools.use.registerGroup({
        name: 'onebot-personal',
        label: t('personalGroup'),
        summary: t('personalGroupSummary'),
        description: '影响 bot 账号本身的人际关系：退群、删好友、处理好友申请、接受/拒绝入群邀请',
      });

      if (cfg.groupManagement.enabled) registerGroupManagementTools(caps, bundle);
      if (cfg.groupInfo.enabled) registerGroupInfoTools(caps, bundle);
      if (cfg.account.enabled) registerAccountTools(caps, bundle);
      if (cfg.interaction.enabled) registerInteractionTools(caps, bundle);
      if (cfg.sessionHistory.enabled) registerSessionHistoryTools(caps, bundle, historyCfg);
      registerRequestTools(caps, bundle);
    };
    events.use.on('app:ready', () => {
      registerToolsOnce();
      if (!toolsRegistered) logger.use.info('未检测到 OneBot 平台，暂不注册 OneBot 工具（平台上线后自动补注册）');
    });
    events.use.on('service:changed', name => {
      if (name === platformService.name) registerToolsOnce();
    });
  },
});

// ===== 群管理工具 =====

function registerGroupManagementTools(caps: GroupManagementCaps, bundle: OneBotToolBundle): void {
  const { platform, logger, sessionManager } = caps;
  const { group, personal } = bundle;
  // ---- 群禁言（单人）----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_group_ban',
        description: '在QQ群中禁言指定用户。duration 为 0 表示解除禁言。可传 group_id 跨群操作；不传则默认当前群。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要禁言的用户QQ号' },
            duration: { type: 'number', description: '禁言时长（秒），0 = 解除禁言，默认 60' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);
      const duration = typeof args.duration === 'number' ? args.duration : 60;

      await assertAdminPermission(platform, selfId, groupId, String(args.user_id));

      await callAction(platform, selfId, 'set_group_ban', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        duration,
      });

      // 验证禁言是否生效：查不到成员信息时照报已发出指令、写明无法验证
      const info = await getGroupMemberInfo(platform, selfId, groupId, String(args.user_id)).catch(() => null);
      if (info && 'shut_up_timestamp' in info) {
        const shutUp = Number(info.shut_up_timestamp);
        const now = Math.floor(Date.now() / 1000);
        if (duration === 0) {
          if (shutUp > now) throw new Error('解除禁言指令已发送，但用户仍在禁言中');
          return `已解除 ${args.user_id} 的禁言`;
        }
        if (shutUp <= now) throw new Error('禁言操作未生效（API 返回成功但禁言状态未变化），请检查机器人实际权限');
        return `已禁言 ${args.user_id}，时长 ${duration} 秒`;
      }

      return duration === 0
        ? `已解除 ${args.user_id} 的禁言`
        : `已禁言 ${args.user_id}，时长 ${duration} 秒（无法验证是否生效）`;
    },
  });

  // ---- 全群禁言 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_group_whole_ban',
        description: '开启/关闭全群禁言。可传 group_id 跨群操作；不传则默认当前群。',
        parameters: {
          type: 'object',
          properties: {
            enable: { type: 'boolean', description: 'true = 开启全群禁言，false = 关闭' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['enable'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);

      await assertAdminPermission(platform, selfId, groupId);

      await callAction(platform, selfId, 'set_group_whole_ban', {
        group_id: Number(groupId),
        enable: !!args.enable,
      });
      return args.enable ? '已开启全群禁言' : '已关闭全群禁言';
    },
  });

  // ---- 踢人 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_group_kick',
        description: '将指定用户踢出群聊。可传 group_id 跨群操作；不传则默认当前群。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要踢出的用户QQ号' },
            reject_add_request: { type: 'boolean', description: '是否拒绝此人再次加群，默认 false' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);

      await assertAdminPermission(platform, selfId, groupId, String(args.user_id));

      await callAction(platform, selfId, 'set_group_kick', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        reject_add_request: !!args.reject_add_request,
      });
      return `已将 ${args.user_id} 踢出群 ${groupId}`;
    },
  });

  // ---- 主动退群 ----
  personal.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_leave_group',
        description: '让机器人主动退出指定 QQ 群。适用于群内持续骚扰、无意义刷屏或不希望继续参与的场景。不会解散群。',
        parameters: {
          type: 'object',
          properties: {
            group_id: { type: 'string', description: '要退出的群号；在群聊中可省略，默认当前群' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const argGroupId = args.group_id != null && String(args.group_id).trim() ? String(args.group_id).trim() : '';
      const selfId = resolveSelfId(platform, callCtx, args);
      const parsed = parseOneBotSession(callCtx.sessionId);
      const groupId = argGroupId || (parsed?.detailType === 'group' ? parsed.targetId : '');
      if (!groupId) throw new Error('请提供 group_id，或在要退出的群聊中调用此工具');

      await callAction(platform, selfId, 'set_group_leave', {
        group_id: Number(groupId),
        is_dismiss: false,
      });
      return `已退出群 ${groupId}`;
    },
  });

  // ---- 设置群名片 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_set_group_card',
        description: '设置指定用户在群中的名片（群昵称）。可传 group_id 跨群操作。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '用户QQ号' },
            card: { type: 'string', description: '新的群名片，空字符串表示取消' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id', 'card'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);

      await assertAdminPermission(platform, selfId, groupId);

      await callAction(platform, selfId, 'set_group_card', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        card: String(args.card ?? ''),
      });
      return `已设置 ${args.user_id} 的群名片为: ${args.card || '(空)'}`;
    },
  });

  // ---- 设置群名 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_set_group_name',
        description: '修改群名称。可传 group_id 跨群操作。',
        parameters: {
          type: 'object',
          properties: {
            group_name: { type: 'string', description: '新的群名称' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['group_name'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);

      await assertAdminPermission(platform, selfId, groupId);

      await callAction(platform, selfId, 'set_group_name', {
        group_id: Number(groupId),
        group_name: String(args.group_name),
      });
      return `已将群 ${groupId} 的名称修改为: ${args.group_name}`;
    },
  });

  // ---- 设置专属头衔 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_set_group_special_title',
        description: '设置群成员专属头衔（仅群主可用）。可传 group_id 跨群操作。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '用户QQ号' },
            special_title: { type: 'string', description: '专属头衔，空字符串表示取消' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id', 'special_title'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);

      await assertAdminPermission(platform, selfId, groupId, undefined, true);

      await callAction(platform, selfId, 'set_group_special_title', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        special_title: String(args.special_title ?? ''),
        duration: -1,
      });
      return `已设置 ${args.user_id} 的专属头衔为: ${args.special_title || '(空)'}`;
    },
  });

  // ---- 设置管理员 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_set_group_admin',
        description: '设置/取消群管理员（仅群主可用）。可传 group_id 跨群操作。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '用户QQ号' },
            enable: { type: 'boolean', description: 'true = 设为管理员，false = 取消管理员' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id', 'enable'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);

      await assertAdminPermission(platform, selfId, groupId, undefined, true);

      await callAction(platform, selfId, 'set_group_admin', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        enable: !!args.enable,
      });
      return args.enable ? `已将 ${args.user_id} 设为管理员` : `已取消 ${args.user_id} 的管理员`;
    },
  });

  // ---- 撤回消息 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_delete_msg',
        description:
          '撤回一条消息（群聊或私聊均可）。需要 message_id（来自历史消息或事件）。机器人对他人消息的撤回需要管理员权限。',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: '要撤回的消息 ID' },
            self_id: SELF_ID_PARAM,
          },
          required: ['message_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      // 不限制必须是群聊；只要能找到可用的 OneBot 账号即可
      const selfId = resolveSelfId(platform, callCtx, args);
      await callAction(platform, selfId, 'delete_msg', {
        message_id: Number(args.message_id),
      });
      return `已撤回消息 ${args.message_id}`;
    },
  });

  // ---- 撤回机器人自己发的消息 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_recall_self',
        description:
          '撤回机器人自己最近发送的消息——无需 message_id（适配器已记录 bot 近期发出的消息）。' +
          '默认撤回最近 1 条；一条回复被拆成多条发出时可用 count 一次撤回最近 N 条。' +
          '可用 group_id 或 user_id 指定目标会话，缺省为当前会话。' +
          '注意：QQ 通常只允许撤回约 2 分钟内的消息，过期会失败。撤回他人消息请用 onebot_delete_msg。',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'number', description: '撤回最近多少条机器人消息（默认 1，上限 10）' },
            group_id: { type: 'string', description: '可选：目标群号。不传则用当前会话。' },
            user_id: { type: 'string', description: '可选：目标私聊 QQ 号。不传则用当前会话。' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const argGroupId = args.group_id != null && String(args.group_id).trim() ? String(args.group_id).trim() : '';
      const argUserId = args.user_id != null && String(args.user_id).trim() ? String(args.user_id).trim() : '';
      let targetSessionId: string;
      if (argGroupId) targetSessionId = buildOneBotSessionId(selfId, 'group', argGroupId);
      else if (argUserId) targetSessionId = buildOneBotSessionId(selfId, 'private', argUserId);
      else {
        const parsed = parseOneBotSession(callCtx.sessionId);
        if (!parsed) throw new Error('当前不在 OneBot 会话中，请用 group_id 或 user_id 指定要撤回的目标会话。');
        targetSessionId = callCtx.sessionId;
      }
      // 目标会话逐个参与者过会话管理的规则（同 onebot_get_msg）：不放行时在读发出记录之前报错，不撤回，报错里没有她在那里说的话
      const verdict = await callCtx.approveFor(who =>
        takeFrom(sessionManager, callCtx.sessionId, targetSessionId, who),
      );
      if (!verdict.ok) throw new Error(toSource(verdict.reason));

      // 发出记录在发消息的那个实例里：按目标会话路由
      const adapter = (await resolvePlatformBySession(platform, targetSessionId))?.use as
        | (PlatformAdapter & {
            getSentMessages?: (
              sessionId: string,
              limit?: number,
            ) => Array<{ messageId: string; ts: number; preview: string }>;
            forgetSentMessage?: (sessionId: string, messageId: string) => void;
          })
        | undefined;
      if (!adapter?.getSentMessages) {
        throw new Error(
          '未找到支持记录自身发出消息的 OneBot 适配器（getSentMessages 不在平台契约内，第三方适配器可不提供）。如已知 message_id 可改用 onebot_delete_msg。',
        );
      }

      const count = Math.max(1, Math.min(10, Math.floor(Number(args.count) || 1)));
      const recent = adapter.getSentMessages(targetSessionId, 10); // 新→旧
      if (recent.length === 0) {
        throw new Error('没有可撤回的记录：机器人近期未在该会话发送消息，或已超出记录时窗（约 30 分钟）。');
      }
      const targets = recent.slice(0, count);
      const recalled: string[] = [];
      const failed: string[] = [];
      for (const t of targets) {
        try {
          await callAction(platform, selfId, 'delete_msg', { message_id: Number(t.messageId) || t.messageId });
          adapter.forgetSentMessage?.(targetSessionId, t.messageId);
          recalled.push(t.preview ? `「${t.preview}」` : `msg=${t.messageId}`);
        } catch (err) {
          failed.push(
            `${t.preview ? `「${t.preview}」` : `msg=${t.messageId}`}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (recalled.length === 0) {
        throw new Error(`撤回失败：${failed.join('；')}`);
      }
      let msg = `已撤回机器人发送的 ${recalled.length} 条消息：${recalled.join('、')}`;
      if (failed.length > 0) msg += `；另有 ${failed.length} 条撤回失败：${failed.join('；')}`;
      return msg;
    },
  });

  logger.use.info('OneBot 群管理工具已注册');
}

// ===== 群信息查询工具 =====

function registerGroupInfoTools(caps: GroupInfoCaps, bundle: OneBotToolBundle): void {
  const { platform, logger, sessionManager } = caps;
  const { daily } = bundle;
  // ---- 查看合并转发 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_forward_msg',
        description:
          '读取合并转发消息内容（OneBot v11 标准 get_forward_msg）。收到 <forward id="...">[合并转发消息]</forward> 时，把尖括号里的 id 字符串作为参数 id 传入。',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '合并转发 ID（forward 消息段的 data.id），与 OneBot v11 标准参数名一致',
            },
            limit: { type: 'number', description: '最多返回多少条节点，默认 30' },
            self_id: SELF_ID_PARAM,
          },
          required: ['id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      if (!args.id) throw new Error('参数错误：缺少 id（合并转发 ID）。请使用 <forward id="..."> 中的 id 字符串。');
      const forwardId = String(args.id);
      const limit = Math.max(1, Math.min(100, typeof args.limit === 'number' ? Math.floor(args.limit) : 30));

      const readFailed = (err: unknown) =>
        new Error(`合并转发读取失败：${err instanceof Error ? err.message : String(err)}`);
      // 适配器的 callAction 维护了一份接收时即抓取并展开（含摘要与图像识别）的缓存，每个收到的转发都记着收到它的会话。
      let data: unknown;
      try {
        data = await callAction(platform, selfId, 'get_forward_msg', { id: forwardId });
      } catch (err) {
        throw readFailed(err);
      }

      // 适配器交回收到这条转发的会话：展开过的连同 ForwardEntry 形状（fullText / summary / 元信息与截断标志），没展开过的连同
      // 按 id 现拉的办法。收到它的会话逐个参与者过会话管理的规则（同 onebot_get_msg），几处之一过得了就行，过了才拉；没记会话的
      // （从没收到过的、别的适配器交回的原始数据）按判不出拒绝
      const reply = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const recorded = reply.__aalisForwardEntry === true || reply.__aalisForwardReceipt === true;
      const sessionIds = recorded && Array.isArray(reply.sessionIds) ? reply.sessionIds.map(String) : [];
      const verdict =
        sessionIds.length === 0
          ? { ok: false as const, reason: TAKE_UNKNOWN }
          : await callCtx.approveFor(who => {
              const verdicts = sessionIds.map(id => takeFrom(sessionManager, callCtx.sessionId, id, who));
              return verdicts.find(v => v.ok) ?? verdicts[0];
            });
      if (!verdict.ok) throw new Error(toSource(verdict.reason));

      // 展开过的直接返回原文给 LLM，无需再做协议端结构解析
      if (reply.__aalisForwardEntry === true) {
        const entry = reply as {
          fullText: string;
          summary: string | null;
          count: number;
          participants: string[];
          unlisted?: number;
          truncatedDepth?: boolean;
          truncatedNodes?: boolean;
        };
        const cut = [entry.truncatedDepth && '嵌套超深', entry.truncatedNodes && '节点超限'].filter(Boolean);
        // 参与人与入站信封同一写法：条目只列前 8 个，没列出的人数另记
        const participants = [...entry.participants, ...(entry.unlisted ? [`...(+${entry.unlisted} 人未列出)`] : [])];
        const header =
          `合并转发共 ${entry.count} 条，参与人：${participants.join(', ') || '未知'}` +
          (cut.length ? `，已截断（${cut.join('、')}）` : '');
        const summaryLine = entry.summary ? `\n摘要：${entry.summary}\n` : '\n';
        return `${header}${summaryLine}\n原文：\n${entry.fullText}`;
      }
      // 没展开过的：过了判定才按 id 现拉
      try {
        data = await (reply.fetch as () => Promise<unknown>)();
      } catch (err) {
        throw readFailed(err);
      }
      const formatContext = await recognizeForwardImages(caps, selfId, data, limit, callCtx.signal);
      return formatForwardMessage(data, limit, formatContext);
    },
  });

  // ---- 获取群信息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_info',
        description: '获取指定群的基本信息（群名、人数等）。可传 group_id 跨群查询；不传则默认当前群。',
        parameters: {
          type: 'object',
          properties: {
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);
      const data = await callAction(platform, selfId, 'get_group_info', {
        group_id: Number(groupId),
      });
      return JSON.stringify(data);
    },
  });

  // ---- 获取群成员信息（user_id 可缺省查自身）----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_member_info',
        description:
          '获取群成员详细信息（昵称、群名片、角色、禁言状态等）。不传 user_id 时查询机器人自身。可传 group_id 跨群查询。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '可选：要查询的用户 QQ 号。缺省查询机器人自身。' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);
      const userId = args.user_id ? String(args.user_id) : selfId;
      const data = await callAction(platform, selfId, 'get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: true,
      });
      return JSON.stringify(data);
    },
  });

  // ---- 获取群成员列表（支持搜索 + 分页）----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_member_list',
        description:
          '查询群的成员列表，支持按昵称/群名片/QQ号关键词搜索、按角色筛选、分页返回。大群（数百上千人）务必使用 keyword 或 role 过滤，避免一次拉取过多数据。可传 group_id 跨群查询。翻页：下次调用传 offset = 上次 offset + limit，直到 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按昵称、群名片或 QQ 号子串模糊匹配（不区分大小写）' },
            role: { type: 'string', enum: ['owner', 'admin', 'member'], description: '可选：按成员角色筛选' },
            limit: { type: 'number', description: '本页最多返回条数，默认 30' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);
      const data = await callAction(platform, selfId, 'get_group_member_list', {
        group_id: Number(groupId),
      });
      const list = Array.isArray(data) ? data : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const roleFilter = typeof args.role === 'string' ? args.role : '';
      // 上限封顶，避免超大 limit 把整张列表灌进 LLM 上下文（token 浪费）。
      const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 30)));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));

      // 精简 + 过滤
      const all = list.map((m: Record<string, unknown>) => ({
        user_id: m.user_id,
        nickname: String(m.nickname ?? ''),
        card: String(m.card ?? ''),
        role: String(m.role ?? 'member'),
      }));
      const filtered = all.filter(m => {
        if (roleFilter && m.role !== roleFilter) return false;
        if (keyword) {
          const hay = `${m.user_id} ${m.nickname} ${m.card}`.toLowerCase();
          if (!hay.includes(keyword)) return false;
        }
        return true;
      });

      const total = filtered.length;
      const items = filtered.slice(offset, offset + limit);

      return JSON.stringify({
        groupTotal: all.length,
        matched: total,
        limit,
        offset,
        returned: items.length,
        has_more: offset + items.length < total,
        ...(keyword ? { keyword } : {}),
        ...(roleFilter ? { role: roleFilter } : {}),
        members: items,
      });
    },
  });

  // ---- 查询自身在当前群是否被禁言 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_self_mute_status',
        description:
          '查询机器人自身的禁言状态。默认查当前群；可传 group_id 跨群查询（也可用于在私聊中查某个群是否被禁言）。' +
          '当历史记忆里出现 [notice/group_ban] 提示时，可调用此工具确认当前实时状态再决定是否发言。',
        parameters: {
          type: 'object',
          properties: {
            group_id: {
              type: 'string',
              description: '可选。指定群号。缺省时查当前会话所在群（私聊时缺省会报错，请显式传入）。',
            },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const argGroupId = args.group_id != null && String(args.group_id).trim() ? String(args.group_id).trim() : '';
      const selfId = resolveSelfId(platform, callCtx, args);
      const parsed = parseOneBotSession(callCtx.sessionId);
      let groupId = argGroupId;
      if (!groupId) {
        if (parsed?.detailType !== 'group') throw new Error('当前不在群聊中，请显式传入 group_id');
        groupId = parsed.targetId;
      }
      let info: Record<string, unknown> | null = null;
      try {
        info = (await callAction(platform, selfId, 'get_group_member_info', {
          group_id: Number(groupId),
          user_id: Number(selfId),
          no_cache: true,
        })) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`查询失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!info) throw new Error('无法获取群成员信息');
      const ts = Number(info.shut_up_timestamp ?? 0);
      const nowSec = Math.floor(Date.now() / 1000);
      const muted = ts > nowSec;
      return JSON.stringify({
        muted,
        shutUpTimestamp: ts,
        untilIso: muted ? new Date(ts * 1000).toISOString() : null,
        remainingSeconds: muted ? ts - nowSec : 0,
        groupId,
        selfId,
      });
    },
  });

  // ---- 列出所有当前被禁言的群（基于内存事件快照，跨会话可用） ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_list_self_mutes',
        description:
          '列出机器人自身当前被禁言的所有群（基于已收到的禁言事件 + 启动后从 shut_up_timestamp 恢复的状态快照）。' +
          '可在任何会话（包括私聊）调用，用于自查"我目前在哪些群里被禁言、还剩多久"。' +
          '支持 limit/offset 翻页（默认按剩余时间倒序，最近会过期的在最前）。' +
          '注意：未收到事件且未触发过的群可能不在列表中，最权威的方式仍是 onebot_get_self_mute_status(group_id)。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最多返回多少条，默认 30，上限 200' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
          },
          required: [],
        },
      },
    },
    handler: async args => {
      // getSelfMutes 不在平台契约内；每个实例只记自己账号的禁言，汇总所有实例
      type SelfMuteAdapter = PlatformAdapter & {
        getSelfMutes(): Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }>;
      };
      const supporting = getPlatformAdapters(platform).filter(
        (a): a is SelfMuteAdapter =>
          a.platform === 'onebot' && typeof (a as Partial<SelfMuteAdapter>).getSelfMutes === 'function',
      );
      if (supporting.length === 0) {
        throw new Error(
          '未找到支持记录自身禁言状态的 OneBot 适配器（getSelfMutes 不在平台契约内，第三方适配器可不提供）',
        );
      }
      const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit) || 30)));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const mutes = supporting.flatMap(a => a.getSelfMutes()).sort((a, b) => a.remainingSec - b.remainingSec);
      const total = mutes.length;
      const sliced = mutes.slice(offset, offset + limit);
      return JSON.stringify({
        total,
        offset,
        limit,
        count: sliced.length,
        hasMore: offset + sliced.length < total,
        mutes: sliced.map(m => ({
          selfId: m.selfId,
          groupId: m.groupId,
          untilIso: new Date(m.untilTs).toISOString(),
          remainingSeconds: m.remainingSec,
        })),
      });
    },
  });

  // ---- 获取消息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_msg',
        description:
          '按 message_id 获取单条消息的完整内容（包括发送者、消息段等）。可用于回溯查看历史中的某条消息，或在收到撤回通知后查看被撤回的内容。消息所在的会话按会话管理的跨会话规则判（默认不取别人私聊里的消息）。',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: '消息 ID' },
            self_id: SELF_ID_PARAM,
          },
          required: ['message_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      if (!args.message_id) throw new Error('参数错误：缺少 message_id');
      let data: Record<string, unknown> | null;
      try {
        data = (await callAction(platform, selfId, 'get_msg', {
          message_id: Number(args.message_id),
        })) as Record<string, unknown> | null;
      } catch (err) {
        throw new Error(`获取消息失败：${err instanceof Error ? err.message : String(err)}`);
      }
      // 取到的消息按所在的窗口拼出会话 id 过规则：拼不出（她自己发的私聊消息、实现端不给字段）的按判不出拒绝
      const target = sessionOfMessage(selfId, data);
      // 逐个参与者过会话管理的规则：有人过不了（某个参与者自己私聊里的）时发一道参与者审批，由过得了的人批
      const verdict =
        target === undefined
          ? { ok: false as const, reason: TAKE_UNKNOWN }
          : await callCtx.approveFor(who => takeFrom(sessionManager, callCtx.sessionId, target, who));
      if (!verdict.ok) throw new Error(toSource(verdict.reason));
      return JSON.stringify(data);
    },
  });

  // ---- 获取群荣誉信息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_honor_info',
        description: '获取指定群的荣誉信息（龙王、群聊之火、群聊炽焰、冒尖小春笋、快乐之源）。可传 group_id 跨群查询。',
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['talkative', 'performer', 'legend', 'strong_newbie', 'emotion', 'all'],
              description:
                '荣誉类型：talkative=龙王, performer=群聊之火, legend=群聊炽焰, strong_newbie=冒尖小春笋, emotion=快乐之源, all=全部。默认 all。',
            },
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);
      const honorType = typeof args.type === 'string' ? args.type : 'all';
      const data = await callAction(platform, selfId, 'get_group_honor_info', {
        group_id: Number(groupId),
        type: honorType,
      });
      return JSON.stringify(data);
    },
  });

  logger.use.info('OneBot 群信息查询工具已注册');
}

// ===== 账号 / 好友 / 群列表查询工具 =====

function registerAccountTools(caps: ToolCaps, bundle: OneBotToolBundle): void {
  const { platform, logger } = caps;
  const { daily, personal } = bundle;
  // ---- 群列表 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_list',
        description:
          '获取机器人加入的所有群列表（OneBot v11: get_group_list）。' +
          '支持按群名/群号关键词搜索、分页返回。' +
          '可在任何会话调用（包括私聊），用于查询「我在哪些群」。' +
          '翻页：下次调用传 offset = 上次 offset + limit，直到 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按群名或群号子串模糊匹配（不区分大小写）' },
            limit: { type: 'number', description: '本页最多返回条数，默认 30' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const data = await callAction(platform, selfId, 'get_group_list', {});
      const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      // 上限封顶，避免超大 limit 把整张列表灌进 LLM 上下文（token 浪费）。
      const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 30)));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));

      const all = list.map(g => ({
        group_id: g.group_id,
        group_name: String(g.group_name ?? ''),
        member_count: g.member_count,
        max_member_count: g.max_member_count,
      }));
      const filtered = keyword ? all.filter(g => `${g.group_id} ${g.group_name}`.toLowerCase().includes(keyword)) : all;

      const total = filtered.length;
      const items = filtered.slice(offset, offset + limit);

      return JSON.stringify({
        accountTotal: all.length,
        matched: total,
        limit,
        offset,
        returned: items.length,
        has_more: offset + items.length < total,
        ...(keyword ? { keyword } : {}),
        groups: items,
      });
    },
  });

  // ---- 好友列表 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_friend_list',
        description:
          '获取机器人的好友列表（OneBot v11: get_friend_list）。' +
          '支持按昵称/备注/QQ号关键词搜索、分页返回。' +
          '翻页：下次调用传 offset = 上次 offset + limit，直到 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按昵称、备注或 QQ 号子串模糊匹配（不区分大小写）' },
            limit: { type: 'number', description: '本页最多返回条数，默认 30' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const data = await callAction(platform, selfId, 'get_friend_list', {});
      const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      // 上限封顶，避免超大 limit 把整张列表灌进 LLM 上下文（token 浪费）。
      const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 30)));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));

      const all = list.map(f => ({
        user_id: f.user_id,
        nickname: String(f.nickname ?? ''),
        remark: String(f.remark ?? ''),
      }));
      const filtered = keyword
        ? all.filter(f => `${f.user_id} ${f.nickname} ${f.remark}`.toLowerCase().includes(keyword))
        : all;

      const total = filtered.length;
      const items = filtered.slice(offset, offset + limit);

      return JSON.stringify({
        accountTotal: all.length,
        matched: total,
        limit,
        offset,
        returned: items.length,
        has_more: offset + items.length < total,
        ...(keyword ? { keyword } : {}),
        friends: items,
      });
    },
  });

  // ---- 陌生人 / 任意 QQ 号信息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_stranger_info',
        description:
          '查询任意 QQ 号的公开资料（OneBot v11: get_stranger_info）。' +
          '不需要对方是好友或同群。常用于私聊会话或跨群查人。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要查询的 QQ 号' },
            no_cache: { type: 'boolean', description: '是否跳过缓存强制刷新，默认 false' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const data = await callAction(platform, selfId, 'get_stranger_info', {
        user_id: Number(args.user_id),
        no_cache: !!args.no_cache,
      });
      return JSON.stringify(data);
    },
  });

  // ---- 机器人自身账号信息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_login_info',
        description:
          '显式查询当前 OneBot 连接的登录账号信息（QQ 号、昵称）。仅在用户要求核实账号、诊断连接或需要最新平台返回值时使用。',
        parameters: { type: 'object', properties: { self_id: SELF_ID_PARAM }, required: [] },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const data = await callAction(platform, selfId, 'get_login_info', {});
      return JSON.stringify(data);
    },
  });

  // ---- 删除好友 ----
  personal.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_delete_friend',
        description:
          '删除指定 QQ 好友。适用于私聊持续骚扰、辱骂、垃圾消息等不希望继续保持好友关系的场景。该接口是 go-cqhttp/NapCat 等 OneBot v11 实现的常见扩展。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要删除的好友 QQ 号；在私聊中可省略，默认当前对话用户' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const argUserId = args.user_id != null && String(args.user_id).trim() ? String(args.user_id).trim() : '';
      const selfId = resolveSelfId(platform, callCtx, args);
      const parsed = parseOneBotSession(callCtx.sessionId);
      const userId = argUserId || (parsed?.detailType === 'private' ? parsed.targetId : '');
      if (!userId) throw new Error('请提供 user_id，或在要删除的好友私聊中调用此工具');

      await callAction(platform, selfId, 'delete_friend', {
        user_id: Number(userId),
      });
      return `已删除好友 ${userId}`;
    },
  });

  logger.use.info('OneBot 账号 / 好友 / 群列表查询工具已注册');
}

// ===== 特殊交互工具 =====

function registerInteractionTools(caps: ToolCaps, bundle: OneBotToolBundle): void {
  const { platform, logger } = caps;
  const { daily, group } = bundle;
  // ---- 戳一戳 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_poke',
        description: '戳一戳（双击头像效果）。群聊默认戳当前群里指定用户；私聊默认戳对方（user_id 可省）。',
        parameters: {
          type: 'object',
          properties: {
            user_id: {
              type: 'string',
              description: '要戳的用户QQ号。群聊必填；私聊省略则戳当前对话对方。',
            },
            group_id: {
              type: 'string',
              description: '可选：目标群号。群聊省略则使用当前群；如显式传值则跨群操作。',
            },
            self_id: SELF_ID_PARAM,
          },
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const parsed = parseOneBotSession(callCtx.sessionId);
      const argGroupId = args.group_id != null && String(args.group_id).trim() ? String(args.group_id).trim() : '';
      const argUserId = args.user_id != null && String(args.user_id).trim() ? String(args.user_id).trim() : '';

      // 1) 群聊场景：显式 group_id 或当前是群会话
      const groupId = argGroupId || (parsed?.detailType === 'group' ? parsed.targetId : '');
      if (groupId) {
        if (!argUserId) {
          throw new Error('群聊戳一戳必须显式提供 user_id（要戳的对象）。');
        }
        await callFirstSupported(platform, selfId, ['group_poke', 'send_group_poke'], {
          group_id: Number(groupId),
          user_id: Number(argUserId),
        });
        return `已在群 ${groupId} 戳了 ${argUserId} 一下`;
      }

      // 2) 私聊场景：从 user_id 或当前私聊会话对方取目标
      const userId = argUserId || (parsed?.detailType === 'private' ? parsed.targetId : '');
      if (!userId) {
        throw new Error('无法判断戳一戳目标：当前不在 OneBot 会话内，请显式传入 group_id+user_id 或 user_id。');
      }
      await callFirstSupported(platform, selfId, ['friend_poke', 'send_poke'], { user_id: Number(userId) });
      return `已戳了 ${userId} 一下`;
    },
  });

  // ---- 发送好友赞 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_send_like',
        description:
          '给指定 QQ 用户发送好友赞（每个好友每天最多 10 次）。低成本的社交互动，适用于表达友好、打招呼等场景。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要赞的用户 QQ 号' },
            times: { type: 'number', description: '赞的次数，默认 1，每天每个好友最多 10 次' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const selfId = resolveSelfId(platform, callCtx, args);
      const times = Math.min(10, Math.max(1, typeof args.times === 'number' ? Math.floor(args.times) : 1));
      await callAction(platform, selfId, 'send_like', {
        user_id: Number(args.user_id),
        times,
      });
      return `已给 ${args.user_id} 发送了 ${times} 次赞`;
    },
  });

  // ---- 群打卡 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_send_group_sign',
        description: '在群聊中打卡签到。可传 group_id 跨群操作。',
        parameters: {
          type: 'object',
          properties: {
            group_id: { type: 'string', description: '可选：目标群号。不传则使用当前群会话的群号。' },
            self_id: SELF_ID_PARAM,
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = resolveGroupTarget(platform, callCtx, args);
      await callAction(platform, selfId, 'send_group_sign', {
        group_id: Number(groupId),
      });
      return '打卡成功';
    },
  });

  logger.use.info('OneBot 特殊交互工具已注册');
}

/** 平台专属历史工具：查历史服务 + 平台适配器解析 selfId */
type HistoryToolCaps = Pick<Caps, 'platform' | 'logger' | 'sessionHistory'>;

interface OneBotSessionHistoryConfig {
  maxLimit: number;
  defaultLimit: number;
}

function registerSessionHistoryTools(
  caps: HistoryToolCaps,
  bundle: OneBotToolBundle,
  cfg: OneBotSessionHistoryConfig,
): void {
  const { platform, logger, sessionHistory } = caps;
  const { daily } = bundle;
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_resolve_session_id',
        description: '把 OneBot 群号或 QQ 号解析成 Aalis 内部 sessionId。用于确认目标会话 ID，不读取历史。',
        parameters: {
          type: 'object',
          properties: {
            target_type: {
              type: 'string',
              enum: ['group', 'private'],
              description: 'group = 群聊，private = 私聊',
            },
            target_id: { type: 'string', description: '群号或 QQ 号' },
            self_id: SELF_ID_PARAM,
          },
          required: ['target_type', 'target_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const targetType = String(args.target_type ?? '').toLowerCase();
      const targetId = String(args.target_id ?? '').trim();
      if (targetType !== 'group' && targetType !== 'private') {
        throw new Error(`target_type 必须为 group 或 private，收到 ${args.target_type}`);
      }
      if (!targetId) throw new Error('target_id 不能为空');
      const selfId = resolveSelfId(platform, callCtx, args);
      return JSON.stringify({
        ok: true,
        sessionId: buildOneBotSessionId(selfId, targetType, targetId),
        selfId,
        targetType,
        targetId,
      });
    },
  });

  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_session_history',
        description: [
          '按 QQ 群号或 QQ 号读取对应 OneBot 会话最近若干条历史消息。',
          '适用场景：用户明确要求你回忆某个群/私聊最近说过什么，或需要核实另一个 OneBot 会话的原文上下文。',
          '能读哪些会话按会话管理的跨会话规则（默认不读别人的私聊）；如需语义搜索历史，请优先使用 memory_recall。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            target_type: {
              type: 'string',
              enum: ['group', 'private'],
              description: 'group = 群聊（target_id 为群号），private = 私聊（target_id 为 QQ 号）',
            },
            target_id: { type: 'string', description: '群号或 QQ 号' },
            limit: {
              type: 'number',
              description: `读取最近多少条，默认 ${cfg.defaultLimit}，最多 ${cfg.maxLimit}`,
            },
            self_id: SELF_ID_PARAM,
          },
          required: ['target_type', 'target_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const targetType = String(args.target_type ?? '').toLowerCase();
      const targetId = String(args.target_id ?? '').trim();
      if (targetType !== 'group' && targetType !== 'private') {
        throw new Error(`target_type 必须为 group 或 private，收到 ${args.target_type}`);
      }
      if (!targetId) throw new Error('target_id 不能为空');

      const selfId = resolveSelfId(platform, callCtx, args);

      if (!sessionHistory.present) throw new Error('session-history 服务不可用，请启用 @aalis/plugin-tool-session');
      const history = sessionHistory.use;

      const limit = Math.max(1, Math.min(cfg.maxLimit, Math.floor(Number(args.limit) || cfg.defaultLimit)));
      const sessionId = buildOneBotSessionId(selfId, targetType, targetId);

      let result: SessionHistoryReadResult;
      try {
        // 能不能读由 session-history 服务按会话管理的规则判（带这次调用的授权身份）。
        // includeArchived 故意不暴露：archived 是 memory 内部细节，被 summary 替代的老消息
        // 默认就不该再翻原文（会与 summary 内容双重计费）。如需考古应另起独立工具。
        result = await history.getHistory({ sessionId, limit }, callCtx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.use.warn(`onebot_get_session_history 失败 (${sessionId}): ${message}`);
        throw new Error(`读取 OneBot 会话历史失败: ${message}`);
      }
      if ('error' in result) throw new Error(result.error);
      return JSON.stringify({
        ...result,
        sessionId,
        selfId,
        targetType,
        targetId,
      });
    },
  });

  logger.use.info('OneBot 会话历史工具已注册');
}

// ===== 请求处理工具（好友申请 / 群请求）=====

/** 能处理好友申请与群请求的 OneBot 适配器（非标准扩展，不在平台契约内）：申请按收到它的账号与申请类型认 */
type RequestAdapter = PlatformAdapter & {
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

function registerRequestTools(caps: ToolCaps, bundle: OneBotToolBundle): void {
  const { platform, logger } = caps;
  const { group, personal } = bundle;
  /**
   * 处理申请的账号与 OneBot 适配器：申请挂在收到它的实例上，按当前会话（或 self_id）的账号路由。
   * 申请的通知注入在收到它的账号的会话里，在那里调用即落到对的实例与账号
   */
  async function requestHandler(
    callCtx: ToolCallContext,
    args: Record<string, unknown>,
  ): Promise<{ selfId: string; adapter: RequestAdapter }> {
    const selfId = resolveSelfId(platform, callCtx, args);
    const adapter = (await resolvePlatformBySession(platform, selfSessionId(selfId)))?.use as
      | Partial<RequestAdapter>
      | undefined;
    if (typeof adapter?.handleFriendRequest !== 'function') throw new Error('未找到支持请求处理的 OneBot 适配器');
    return { selfId, adapter: adapter as RequestAdapter };
  }

  /** 两个群请求工具各认自己的申请类型：用审批加群申请的工具批不了入群邀请，反之亦然 */
  const handleGroupRequest =
    (subType: 'add' | 'invite') => async (args: Record<string, unknown>, callCtx: ToolCallContext) => {
      const { selfId, adapter } = await requestHandler(callCtx, args);
      return adapter.handleGroupRequest(
        selfId,
        subType,
        String(args.user_id),
        String(args.group_id),
        !!args.approve,
        args.reason ? String(args.reason) : undefined,
      );
    };

  personal.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_handle_friend_request',
        description: '处理 QQ 好友申请（别人加 bot 为好友），同意或拒绝。仅在收到好友申请通知后才有效。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '发起好友申请的用户 QQ 号' },
            approve: { type: 'boolean', description: 'true = 同意，false = 拒绝' },
            remark: { type: 'string', description: '同意后添加的备注（可选）' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id', 'approve'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, adapter } = await requestHandler(callCtx, args);
      return adapter.handleFriendRequest(
        selfId,
        String(args.user_id),
        !!args.approve,
        args.remark ? String(args.remark) : undefined,
      );
    },
  });

  // 群相关请求拆成两个工具，对应 OneBot v11 set_group_add_request 的两种 sub_type：
  // - approve_join_request: sub_type=add 「别人申请加入 bot 管理的群」 → 群务
  // - handle_group_invite:  sub_type=invite 「别人邀请 bot 加入群」 → 个人/私聊
  // 底层共用同一个适配器方法，各自把要处理的申请类型交给它，类型不符就报错。
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_approve_join_request',
        description:
          '审批「有人申请加入 bot 管理的群」的入群请求（OneBot v11 set_group_add_request, sub_type=add）。同意或拒绝。仅在收到加群申请通知后才有效。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '申请加群的用户 QQ 号' },
            group_id: { type: 'string', description: '相关群号' },
            approve: { type: 'boolean', description: 'true = 同意加群，false = 拒绝' },
            reason: { type: 'string', description: '拒绝理由（拒绝时有效，可选）' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id', 'group_id', 'approve'],
        },
      },
    },
    handler: handleGroupRequest('add'),
  });

  personal.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_handle_group_invite',
        description:
          '处理「别人邀请 bot 加入某个群」的邀请（OneBot v11 set_group_add_request, sub_type=invite）。同意 = 接受加群；拒绝 = 不入群。仅在收到入群邀请通知后才有效。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '邀请发起人的 QQ 号' },
            group_id: { type: 'string', description: '被邀请加入的群号' },
            approve: { type: 'boolean', description: 'true = 接受邀请并加入群，false = 拒绝' },
            reason: { type: 'string', description: '拒绝理由（拒绝时有效，可选）' },
            self_id: SELF_ID_PARAM,
          },
          required: ['user_id', 'group_id', 'approve'],
        },
      },
    },
    handler: handleGroupRequest('invite'),
  });

  logger.use.info('OneBot 请求处理工具已注册');
}
