import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { ConfigSchema, Context } from '@aalis/core';
import type { MediaService } from '@aalis/plugin-media-api';
import { getPlatformAdapters, getPlatformNames, type PlatformAdapter } from '@aalis/plugin-platform-api';
import type { AccessChecker, SessionHistoryService } from '@aalis/plugin-tool-session-api';
import type { ScopedToolService, ToolCallContext } from '@aalis/plugin-tools-api';
import { toolsWithGroups, useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-tool-session-api';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-onebot';
export const displayName = 'OneBot 工具';
export const subsystem = 'tools';
export const inject = {
  optional: ['platform', 'session-history'],
};

export const configSchema: ConfigSchema = {
  groupManagement: {
    label: '群管理工具',
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用群管理工具',
        default: true,
        description: '禁言、踢人、设置群名片、撤回消息等',
      },
    },
  },
  groupInfo: {
    label: '群信息查询',
    fields: {
      enabled: { type: 'boolean', label: '启用群信息查询', default: true, description: '查询群/成员信息' },
    },
  },
  account: {
    label: '账号与好友',
    fields: {
      enabled: { type: 'boolean', label: '启用账号与好友查询', default: true, description: '群列表、好友列表等' },
    },
  },
  interaction: {
    label: '特殊交互',
    fields: {
      enabled: { type: 'boolean', label: '启用特殊交互', default: true, description: '戳一戳、群打卡等' },
    },
  },
  sessionHistory: {
    label: '会话历史读取',
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用 OneBot 会话历史读取',
        default: true,
        description: '允许按群号/QQ 号读取对应 OneBot 会话的近期历史',
      },
      maxLimit: {
        type: 'number',
        label: '单次最多读取条数上限',
        default: 100,
        description: 'agent 传入的 limit 参数会被截断到该上限。',
      },
      defaultLimit: {
        type: 'number',
        label: '默认读取条数（agent 不传 limit 时）',
        default: 20,
        description: '不能超过 maxLimit。',
      },
      allowGroupReadPrivate: {
        type: 'boolean',
        label: '允许群聊读取私聊历史',
        default: false,
        description: '在群会话中调用历史读取工具时，是否允许目标是某个私聊。',
      },
      allowCrossSelf: {
        type: 'boolean',
        label: '允许跨机器人账号读取',
        default: false,
        description: '不同 selfId 之间跨读。多账号部署才需要。',
      },
      allowCrossGroup: {
        type: 'boolean',
        label: '允许群聊读取其他群聊历史',
        default: true,
        description: '群会话 → 另一个群会话。默认允许（便于跨群取上下文）。',
      },
      allowCrossPrivate: {
        type: 'boolean',
        label: '允许私聊读取其他私聊历史',
        default: false,
        description: '私聊会话 → 另一个 QQ 的私聊。默认拒绝（隐私敏感）。',
      },
      includeArchivedDefault: { type: 'boolean', label: '默认包含已归档消息', default: false },
    },
  },
};

export const defaultConfig = {
  groupManagement: { enabled: true },
  groupInfo: { enabled: true },
  account: { enabled: true },
  interaction: { enabled: true },
  sessionHistory: {
    enabled: true,
    maxLimit: 100,
    defaultLimit: 20,
    allowGroupReadPrivate: false,
    allowCrossSelf: false,
    allowCrossGroup: true,
    allowCrossPrivate: false,
    includeArchivedDefault: false,
  },
};

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

/** 从上下文中找到支持 callAction 的 OneBot 平台适配器 */
function findOneBotAdapter(ctx: Context): PlatformAdapter | undefined {
  return getPlatformAdapters(ctx).find(a => a.platform === 'onebot' && typeof a.callAction === 'function');
}

/** 检查工具调用是否来自 OneBot 群聊 */
function requireGroupSession(callCtx: ToolCallContext): { selfId: string; groupId: string } {
  const parsed = parseOneBotSession(callCtx.sessionId);
  if (!parsed || parsed.detailType !== 'group') {
    throw new Error(
      '此工具仅在 OneBot 群聊会话上下文中可用。若你当前在私聊/其他会话下需要对某个群操作，请改用 ' +
        'delegate_to_session({target_session_id: "onebot:<selfId>:group:<群号>", task: "...", wait_for_result: true})；' +
        '不知道 sessionId 可先调用 onebot_resolve_session_id 转换。',
    );
  }
  return { selfId: parsed.selfId, groupId: parsed.targetId };
}

function requireOneBotSession(callCtx: ToolCallContext): { selfId: string; detailType: string; targetId: string } {
  const parsed = parseOneBotSession(callCtx.sessionId);
  if (!parsed) throw new Error('此工具仅在 OneBot 会话中可用');
  return parsed;
}

function buildOneBotSessionId(selfId: string, detailType: string, targetId: string): string {
  return `onebot:${selfId}:${detailType}:${targetId}`;
}

async function callAction(
  ctx: Context,
  callCtx: ToolCallContext,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const adapter = findOneBotAdapter(ctx);
  if (!adapter?.callAction) throw new Error('OneBot 适配器不可用或不支持 callAction');
  return adapter.callAction(callCtx.sessionId, action, params);
}

function imageMimeFromPath(path: string): string {
  const ext = extname(path.split('?')[0]).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

async function localImageToDataUri(path: string): Promise<string | null> {
  const filePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    const buf = await readFile(filePath);
    return `data:${imageMimeFromPath(filePath)};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

interface ForwardImageRef {
  source: string;
  label: string;
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
    if (source) refs.push({ source, label: '[图片]', segment: params });
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
    if (source) refs.push({ source, label: '[图片]', segment: data });
  }
  return refs;
}

function getForwardMessages(data: unknown): unknown[] {
  const root = data as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(root)) return root;
  if (Array.isArray((root as Record<string, unknown> | null)?.messages)) {
    return (root as Record<string, unknown>).messages as unknown[];
  }
  if (Array.isArray((root as Record<string, unknown> | null)?.message)) {
    return (root as Record<string, unknown>).message as unknown[];
  }
  return [];
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
  return getForwardMessages(data)
    .slice(0, limit)
    .flatMap(item => extractImageRefsFromContent(getForwardNodeContent(item)));
}

async function resolveForwardImageSource(
  ctx: Context,
  callCtx: ToolCallContext,
  ref: ForwardImageRef,
): Promise<string> {
  if (/^(https?:|data:)/i.test(ref.source)) return ref.source;

  try {
    const imageData = (await callAction(ctx, callCtx, 'get_image', { file: ref.source })) as Record<string, unknown>;
    const resolvedSource = imageData.url ?? imageData.file ?? ref.source;
    if (typeof resolvedSource === 'string') {
      if (/^(https?:|data:)/i.test(resolvedSource)) return resolvedSource;
      const dataUri = await localImageToDataUri(resolvedSource);
      if (dataUri) return dataUri;
      return resolvedSource;
    }
  } catch (err) {
    ctx.logger.debug(`get_image 解析转发图片失败 (${ref.source}): ${err}`);
  }

  const dataUri = await localImageToDataUri(ref.source);
  return dataUri ?? ref.source;
}

async function recognizeForwardImages(
  ctx: Context,
  callCtx: ToolCallContext,
  data: unknown,
  limit: number,
): Promise<ForwardFormatContext> {
  const refs = collectForwardImageRefs(data, limit);
  const imageDescriptions = new Map<string, string>();
  if (refs.length === 0) return { imageDescriptions };

  const mediaSvc = ctx.getService<MediaService>('media');
  if (!mediaSvc?.describeImage) {
    ctx.logger.debug(`合并转发包含 ${refs.length} 张图片，但 media 服务不可用`);
    return { imageDescriptions };
  }

  const seen = new Set<string>();
  for (const ref of refs) {
    const key = imageRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const imageSource = await resolveForwardImageSource(ctx, callCtx, ref);
      const description = await mediaSvc.describeImage(imageSource);
      if (description) imageDescriptions.set(key, description);
    } catch (err) {
      ctx.logger.debug(`合并转发图片识别失败 (${ref.source}): ${err}`);
    }
  }

  return { imageDescriptions };
}

function formatMessageContent(content: unknown, context?: ForwardFormatContext): string {
  if (typeof content === 'string') return content;
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
          const desc = source
            ? context?.imageDescriptions.get(imageRefKey({ source, label: '[图片]', segment: data }))
            : undefined;
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
  return lines.length > 0 ? `${header}\n${lines.join('\n')}` : '合并转发内容为空或当前 OneBot 实现返回格式无法识别';
}

// ===== 权限检查辅助 =====

const ROLE_LEVEL: Record<string, number> = { owner: 3, admin: 2, member: 1 };

function roleLevel(role: string): number {
  return ROLE_LEVEL[role] ?? 0;
}

/** 查询群成员信息（失败返回 null） */
async function getGroupMemberInfo(
  ctx: Context,
  callCtx: ToolCallContext,
  groupId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return (await callAction(ctx, callCtx, 'get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: true,
    })) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 检查管理操作权限，返回错误消息（null 表示通过或无法验证） */
async function checkAdminPermission(
  ctx: Context,
  callCtx: ToolCallContext,
  selfId: string,
  groupId: string,
  targetUserId?: string,
  requireOwner?: boolean,
): Promise<string | null> {
  const selfInfo = await getGroupMemberInfo(ctx, callCtx, groupId, selfId);
  if (!selfInfo) return null; // 无法获取自身信息，跳过权限检查

  const selfRole = String(selfInfo.role ?? 'member');

  if (requireOwner && selfRole !== 'owner') {
    return `操作失败：此操作仅群主可执行（当前角色：${selfRole}）`;
  }
  if (selfRole === 'member') {
    return `操作失败：机器人不是管理员（当前角色：${selfRole}），无法执行管理操作`;
  }

  if (targetUserId) {
    const targetInfo = await getGroupMemberInfo(ctx, callCtx, groupId, targetUserId);
    if (!targetInfo) {
      return `操作失败：无法获取用户 ${targetUserId} 的信息，该用户可能不在群中`;
    }
    const targetRole = String(targetInfo.role ?? 'member');
    if (roleLevel(targetRole) >= roleLevel(selfRole)) {
      const targetLabel = targetRole === 'owner' ? '群主' : '管理员';
      return `操作失败：无法对${targetLabel}执行此操作（机器人角色：${selfRole}，目标角色：${targetRole}）`;
    }
  }

  return null;
}

// ===== 插件入口 =====

/**
 * OneBot 工具按职责语义拆成三组（彼此互不重叠）：
 * - onebot-daily：只读查询 + 日常低风险互动（戳一戳、点赞）
 * - onebot-group：群务管理（禁言/踢人/撤回/改群名/设管理员/群打卡/审批加群申请 等）
 * - onebot-personal：影响 bot 账号本身的人际关系（退群/删好友/处理好友申请/接受入群邀请）
 */
interface OneBotToolBundle {
  daily: ScopedToolService;
  group: ScopedToolService;
  personal: ScopedToolService;
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const tools = useToolService(ctx);
  const bundle: OneBotToolBundle = {
    daily: toolsWithGroups(tools, ['onebot-daily']),
    group: toolsWithGroups(tools, ['onebot-group']),
    personal: toolsWithGroups(tools, ['onebot-personal']),
  };

  // 仅当 OneBot 平台可用时才注册工具
  // 使用 ready 事件确保平台已加载
  ctx.on('ready', () => {
    if (!getPlatformNames(ctx).includes('onebot')) {
      ctx.logger.info('未检测到 OneBot 平台，跳过 OneBot 工具注册');
      return;
    }

    ctx.logger.info('检测到 OneBot 平台，开始注册 OneBot 工具');

    // 注册工具分组：按职责语义切分，彼此不重叠
    tools.registerGroup({
      name: 'onebot-daily',
      label: 'OneBot 只读与日常',
      description: '只读查询（群信息/成员/好友列表/历史/登录信息）+ 日常低风险互动（戳一戳、好友赞）',
    });
    tools.registerGroup({
      name: 'onebot-group',
      label: 'OneBot 群务',
      description: '群务管理：禁言/全员禁言/踢人/撤回消息/设置群名片/改群名/设管理员/群打卡/审批加群申请 等',
    });
    tools.registerGroup({
      name: 'onebot-personal',
      label: 'OneBot 个人/私聊',
      description: '影响 bot 账号本身的人际关系：退群、删好友、处理好友申请、接受/拒绝入群邀请',
    });

    const cfg = {
      groupManagement: { enabled: true, ...((config.groupManagement as Record<string, unknown>) ?? {}) },
      groupInfo: { enabled: true, ...((config.groupInfo as Record<string, unknown>) ?? {}) },
      account: { enabled: true, ...((config.account as Record<string, unknown>) ?? {}) },
      interaction: { enabled: true, ...((config.interaction as Record<string, unknown>) ?? {}) },
      sessionHistory: {
        enabled: true,
        maxLimit: 100,
        defaultLimit: 20,
        allowGroupReadPrivate: false,
        allowCrossSelf: false,
        allowCrossGroup: true,
        allowCrossPrivate: false,
        includeArchivedDefault: false,
        ...((config.sessionHistory as Record<string, unknown>) ?? {}),
      },
    };

    if (cfg.groupManagement.enabled) registerGroupManagementTools(ctx, bundle);
    if (cfg.groupInfo.enabled) registerGroupInfoTools(ctx, bundle);
    if (cfg.account.enabled) registerAccountTools(ctx, bundle);
    if (cfg.interaction.enabled) registerInteractionTools(ctx, bundle);
    if (cfg.sessionHistory.enabled) {
      const maxLimit = Math.max(1, Math.min(1000, Number(cfg.sessionHistory.maxLimit) || 100));
      const defaultLimitRaw = Math.max(1, Math.floor(Number(cfg.sessionHistory.defaultLimit) || 20));
      const historyCfg: OneBotSessionHistoryConfig = {
        maxLimit,
        defaultLimit: Math.min(defaultLimitRaw, maxLimit),
        allowGroupReadPrivate: cfg.sessionHistory.allowGroupReadPrivate === true,
        allowCrossSelf: cfg.sessionHistory.allowCrossSelf === true,
        allowCrossGroup: cfg.sessionHistory.allowCrossGroup !== false,
        allowCrossPrivate: cfg.sessionHistory.allowCrossPrivate === true,
        includeArchivedDefault: cfg.sessionHistory.includeArchivedDefault === true,
      };
      registerSessionHistoryTools(ctx, bundle, historyCfg);
      registerOneBotHistoryAccessChecker(ctx, historyCfg);
    }
    registerRequestTools(ctx, bundle);
  });
}

// ===== 群管理工具 =====

function registerGroupManagementTools(ctx: Context, bundle: OneBotToolBundle): void {
  const { group, personal } = bundle;
  // ---- 群禁言（单人）----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_group_ban',
        description: '在QQ群中禁言指定用户。duration 为 0 表示解除禁言。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要禁言的用户QQ号' },
            duration: { type: 'number', description: '禁言时长（秒），0 = 解除禁言，默认 60' },
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);
      const duration = typeof args.duration === 'number' ? args.duration : 60;

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId, String(args.user_id));
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_ban', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        duration,
      });

      // 验证禁言是否生效
      const info = await getGroupMemberInfo(ctx, callCtx, groupId, String(args.user_id));
      if (info && 'shut_up_timestamp' in info) {
        const shutUp = Number(info.shut_up_timestamp);
        const now = Math.floor(Date.now() / 1000);
        if (duration === 0) {
          return shutUp <= now ? `已解除 ${args.user_id} 的禁言` : `解除禁言指令已发送，但用户仍在禁言中`;
        } else {
          return shutUp > now
            ? `已禁言 ${args.user_id}，时长 ${duration} 秒`
            : `禁言操作未生效（API 返回成功但禁言状态未变化），请检查机器人实际权限`;
        }
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
        description: '开启/关闭全群禁言。',
        parameters: {
          type: 'object',
          properties: {
            enable: { type: 'boolean', description: 'true = 开启全群禁言，false = 关闭' },
          },
          required: ['enable'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId);
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_whole_ban', {
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
        description: '将指定用户踢出群聊。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要踢出的用户QQ号' },
            reject_add_request: { type: 'boolean', description: '是否拒绝此人再次加群，默认 false' },
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId, String(args.user_id));
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_kick', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        reject_add_request: !!args.reject_add_request,
      });
      return `已将 ${args.user_id} 踢出群聊`;
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
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const session = requireOneBotSession(callCtx);
      const groupId = args.group_id ? String(args.group_id) : session.detailType === 'group' ? session.targetId : '';
      if (!groupId) return '请提供 group_id，或在要退出的群聊中调用此工具';

      await callAction(ctx, callCtx, 'set_group_leave', {
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
        description: '设置指定用户在群中的名片（群昵称）。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '用户QQ号' },
            card: { type: 'string', description: '新的群名片，空字符串表示取消' },
          },
          required: ['user_id', 'card'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId);
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_card', {
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
        description: '修改群名称。',
        parameters: {
          type: 'object',
          properties: {
            group_name: { type: 'string', description: '新的群名称' },
          },
          required: ['group_name'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId);
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_name', {
        group_id: Number(groupId),
        group_name: String(args.group_name),
      });
      return `已将群名修改为: ${args.group_name}`;
    },
  });

  // ---- 设置专属头衔 ----
  group.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_set_group_special_title',
        description: '设置群成员专属头衔（仅群主可用）。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '用户QQ号' },
            special_title: { type: 'string', description: '专属头衔，空字符串表示取消' },
          },
          required: ['user_id', 'special_title'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId, undefined, true);
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_special_title', {
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
        description: '设置/取消群管理员（仅群主可用）。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '用户QQ号' },
            enable: { type: 'boolean', description: 'true = 设为管理员，false = 取消管理员' },
          },
          required: ['user_id', 'enable'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);

      const permError = await checkAdminPermission(ctx, callCtx, selfId, groupId, undefined, true);
      if (permError) return permError;

      await callAction(ctx, callCtx, 'set_group_admin', {
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
          },
          required: ['message_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      // 不限制必须是群聊；私聊也可撤回机器人自己发出的消息
      const parsed = parseOneBotSession(callCtx.sessionId);
      if (!parsed) throw new Error('此工具仅在 OneBot 会话中可用');
      await callAction(ctx, callCtx, 'delete_msg', {
        message_id: Number(args.message_id),
      });
      return `已撤回消息 ${args.message_id}`;
    },
  });

  ctx.logger.info('OneBot 群管理工具已注册');
}

// ===== 群信息查询工具 =====

function registerGroupInfoTools(ctx: Context, bundle: OneBotToolBundle): void {
  const { daily } = bundle;
  // ---- 查看合并转发 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_forward_msg',
        description:
          '读取合并转发消息内容（OneBot v11 标准 get_forward_msg）。收到 <forward id="...">[合并转发消息]</forward> 时，必须把尖括号里的 id 字符串作为参数 id 传入；不要使用 message_id、forward_id、res_id 或 m_resid。',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '合并转发 ID（forward 消息段的 data.id），与 OneBot v11 标准参数名一致',
            },
            limit: { type: 'number', description: '最多返回多少条节点，默认 30' },
          },
          required: ['id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      requireOneBotSession(callCtx);
      if (!args.id)
        return '参数错误：缺少 id（合并转发 ID）。请使用 <forward id="..."> 中的 id 字符串，不要使用 message_id。';
      const forwardId = String(args.id);
      const limit = Math.max(1, Math.min(100, typeof args.limit === 'number' ? Math.floor(args.limit) : 30));

      // 适配器的 callAction 已对 get_forward_msg 做了多参数键回退（id/message_id/res_id/m_resid）
      // 并维护了一份接收时即抓取并展开（含摘要与图像识别）的缓存。
      let data: unknown;
      try {
        data = await callAction(ctx, callCtx, 'get_forward_msg', { id: forwardId });
      } catch (err) {
        return `合并转发读取失败：${err instanceof Error ? err.message : String(err)}。该转发可能已在协议端过期，或当前 OneBot 实现不支持跨会话读取。`;
      }

      // 适配器在缓存命中时返回 ForwardEntry 形状（含 fullText / summary / 元信息）。
      // 此时直接返回原文给 LLM，无需再做协议端结构解析。
      if (data && typeof data === 'object' && (data as Record<string, unknown>).__aalisForwardEntry) {
        const entry = data as { fullText: string; summary: string | null; count: number; participants: string[] };
        const header = `合并转发共 ${entry.count} 条，参与人：${entry.participants.join(', ') || '未知'}`;
        const summaryLine = entry.summary ? `\n摘要：${entry.summary}\n` : '\n';
        return `${header}${summaryLine}\n原文：\n${entry.fullText}`;
      }

      const formatContext = await recognizeForwardImages(ctx, callCtx, data, limit);
      return formatForwardMessage(data, limit, formatContext);
    },
  });

  // ---- 获取群信息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_info',
        description: '获取当前群的基本信息（群名、人数等）。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async (_args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      const data = await callAction(ctx, callCtx, 'get_group_info', {
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
        description: '获取群成员详细信息（昵称、群名片、角色、禁言状态等）。不传 user_id 时查询机器人自身。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '可选：要查询的用户 QQ 号。缺省查询机器人自身。' },
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { selfId, groupId } = requireGroupSession(callCtx);
      const userId = args.user_id ? String(args.user_id) : selfId;
      const data = await callAction(ctx, callCtx, 'get_group_member_info', {
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
          '查询当前群的成员列表，支持按昵称/群名片/QQ号关键词搜索、按角色筛选、分页返回。大群（数百上千人）务必使用 keyword 或 role 过滤，避免一次拉取过多数据。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按昵称、群名片或 QQ 号子串模糊匹配（不区分大小写）' },
            role: { type: 'string', enum: ['owner', 'admin', 'member'], description: '可选：按成员角色筛选' },
            page: { type: 'number', description: '页码，从 1 开始，默认 1' },
            pageSize: { type: 'number', description: '每页条数，默认 30（可自行设定，请根据需要的数据量方式判断）' },
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      const data = await callAction(ctx, callCtx, 'get_group_member_list', {
        group_id: Number(groupId),
      });
      const list = Array.isArray(data) ? data : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const roleFilter = typeof args.role === 'string' ? args.role : '';
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));

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
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const curPage = Math.min(page, totalPages);
      const start = (curPage - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize);

      return JSON.stringify({
        groupTotal: all.length,
        matched: total,
        page: curPage,
        pageSize,
        totalPages,
        hasMore: curPage < totalPages,
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
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const parsed = parseOneBotSession(callCtx.sessionId);
      if (!parsed) throw new Error('此工具仅在 OneBot 会话中可用');
      const selfId = parsed.selfId;
      let groupId = args.group_id ? String(args.group_id) : '';
      if (!groupId) {
        if (parsed.detailType !== 'group') {
          return JSON.stringify({ available: false, reason: '当前不在群聊中，请显式传入 group_id' });
        }
        groupId = parsed.targetId;
      }
      // 跨群查询时，构造一个目标群的临时 sessionId 以复用 callAction
      const probeSessionId = `onebot:${selfId}:group:${groupId}`;
      const adapter = findOneBotAdapter(ctx);
      if (!adapter?.callAction) return JSON.stringify({ available: false, reason: 'OneBot 适配器不可用' });
      let info: Record<string, unknown> | null = null;
      try {
        info = (await adapter.callAction(probeSessionId, 'get_group_member_info', {
          group_id: Number(groupId),
          user_id: Number(selfId),
          no_cache: true,
        })) as Record<string, unknown>;
      } catch (err) {
        return JSON.stringify({
          available: false,
          reason: `查询失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!info) return JSON.stringify({ available: false, reason: '无法获取群成员信息' });
      const ts = Number(info.shut_up_timestamp ?? 0);
      const nowSec = Math.floor(Date.now() / 1000);
      const muted = ts > nowSec;
      return JSON.stringify({
        available: true,
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
          '注意：未收到事件且未触发过的群可能不在列表中，最权威的方式仍是 onebot_get_self_mute_status(group_id)。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async () => {
      const adapter = findOneBotAdapter(ctx) as
        | (PlatformAdapter & {
            getSelfMutes?: () => Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }>;
          })
        | undefined;
      if (!adapter?.getSelfMutes) {
        return JSON.stringify({ supported: false, reason: '当前 OneBot 适配器版本不支持 getSelfMutes' });
      }
      const mutes = adapter.getSelfMutes();
      return JSON.stringify({
        supported: true,
        count: mutes.length,
        mutes: mutes.map(m => ({
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
          '按 message_id 获取单条消息的完整内容（包括发送者、消息段等）。可用于回溯查看历史中的某条消息，或在收到撤回通知后查看被撤回的内容。不限定会话类型，群聊和私聊消息均可查询。',
        parameters: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: '消息 ID' },
          },
          required: ['message_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      requireOneBotSession(callCtx);
      if (!args.message_id) return '参数错误：缺少 message_id';
      try {
        const data = await callAction(ctx, callCtx, 'get_msg', {
          message_id: Number(args.message_id),
        });
        return JSON.stringify(data);
      } catch (err) {
        return `获取消息失败：${err instanceof Error ? err.message : String(err)}。该消息可能已过期或不在当前 OneBot 实现的作用域内。`;
      }
    },
  });

  // ---- 获取群荣誉信息 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_honor_info',
        description:
          '获取当前群的荣誉信息（龙王、群聊之火、群聊炽焰、冒尖小春笋、快乐之源）。可用于感知群内活跃成员、话题引导等。',
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['talkative', 'performer', 'legend', 'strong_newbie', 'emotion', 'all'],
              description:
                '荣誉类型：talkative=龙王, performer=群聊之火, legend=群聊炽焰, strong_newbie=冒尖小春笋, emotion=快乐之源, all=全部。默认 all。',
            },
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      const honorType = typeof args.type === 'string' ? args.type : 'all';
      const data = await callAction(ctx, callCtx, 'get_group_honor_info', {
        group_id: Number(groupId),
        type: honorType,
      });
      return JSON.stringify(data);
    },
  });

  ctx.logger.info('OneBot 群信息查询工具已注册');
}

// ===== 账号 / 好友 / 群列表查询工具 =====

function registerAccountTools(ctx: Context, bundle: OneBotToolBundle): void {
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
          '可在任何会话调用（包括私聊），用于查询「我在哪些群」。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按群名或群号子串模糊匹配（不区分大小写）' },
            page: { type: 'number', description: '页码，从 1 开始，默认 1' },
            pageSize: { type: 'number', description: '每页条数，默认 30' },
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const data = await callAction(ctx, callCtx, 'get_group_list', {});
      const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));

      const all = list.map(g => ({
        group_id: g.group_id,
        group_name: String(g.group_name ?? ''),
        member_count: g.member_count,
        max_member_count: g.max_member_count,
      }));
      const filtered = keyword ? all.filter(g => `${g.group_id} ${g.group_name}`.toLowerCase().includes(keyword)) : all;

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const curPage = Math.min(page, totalPages);
      const start = (curPage - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize);

      return JSON.stringify({
        accountTotal: all.length,
        matched: total,
        page: curPage,
        pageSize,
        totalPages,
        hasMore: curPage < totalPages,
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
          '获取机器人的好友列表（OneBot v11: get_friend_list）。' + '支持按昵称/备注/QQ号关键词搜索、分页返回。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按昵称、备注或 QQ 号子串模糊匹配（不区分大小写）' },
            page: { type: 'number', description: '页码，从 1 开始，默认 1' },
            pageSize: { type: 'number', description: '每页条数，默认 30' },
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const data = await callAction(ctx, callCtx, 'get_friend_list', {});
      const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));

      const all = list.map(f => ({
        user_id: f.user_id,
        nickname: String(f.nickname ?? ''),
        remark: String(f.remark ?? ''),
      }));
      const filtered = keyword
        ? all.filter(f => `${f.user_id} ${f.nickname} ${f.remark}`.toLowerCase().includes(keyword))
        : all;

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const curPage = Math.min(page, totalPages);
      const start = (curPage - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize);

      return JSON.stringify({
        accountTotal: all.length,
        matched: total,
        page: curPage,
        pageSize,
        totalPages,
        hasMore: curPage < totalPages,
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
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const data = await callAction(ctx, callCtx, 'get_stranger_info', {
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
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async (_args, callCtx) => {
      const data = await callAction(ctx, callCtx, 'get_login_info', {});
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
          },
          required: [],
        },
      },
    },
    handler: async (args, callCtx) => {
      const session = requireOneBotSession(callCtx);
      const userId = args.user_id ? String(args.user_id) : session.detailType === 'private' ? session.targetId : '';
      if (!userId) return '请提供 user_id，或在要删除的好友私聊中调用此工具';

      await callAction(ctx, callCtx, 'delete_friend', {
        user_id: Number(userId),
      });
      return `已删除好友 ${userId}`;
    },
  });

  ctx.logger.info('OneBot 账号 / 好友 / 群列表查询工具已注册');
}

// ===== 特殊交互工具 =====

function registerInteractionTools(ctx: Context, bundle: OneBotToolBundle): void {
  const { daily, group } = bundle;
  // ---- 戳一戳 ----
  daily.register({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_poke',
        description: '在群聊中戳一戳指定用户（双击头像效果）。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要戳的用户QQ号' },
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      // 不同 OneBot 实现的戳一戳 API 可能不同，依次尝试
      try {
        await callAction(ctx, callCtx, 'group_poke', {
          group_id: Number(groupId),
          user_id: Number(args.user_id),
        });
      } catch {
        // NapCat 等实现使用不同的 action 名
        await callAction(ctx, callCtx, 'send_group_poke', {
          group_id: Number(groupId),
          user_id: Number(args.user_id),
        });
      }
      return `已戳了 ${args.user_id} 一下`;
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
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      requireOneBotSession(callCtx);
      const times = Math.min(10, Math.max(1, typeof args.times === 'number' ? Math.floor(args.times) : 1));
      await callAction(ctx, callCtx, 'send_like', {
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
        description: '在群聊中打卡签到。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async (_args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      await callAction(ctx, callCtx, 'send_group_sign', {
        group_id: Number(groupId),
      });
      return '打卡成功';
    },
  });

  ctx.logger.info('OneBot 特殊交互工具已注册');
}

interface OneBotSessionHistoryConfig {
  maxLimit: number;
  defaultLimit: number;
  allowGroupReadPrivate: boolean;
  allowCrossSelf: boolean;
  allowCrossGroup: boolean;
  allowCrossPrivate: boolean;
  includeArchivedDefault: boolean;
}

/**
 * 把 OneBot 的细粒度访问规则注册到 session-history 服务。
 * 通用工具 session_get_history 和平台专属工具 onebot_get_session_history
 * 调用 service 时都会走这条规则链 —— 不存在绕过路径。
 */
function registerOneBotHistoryAccessChecker(ctx: Context, cfg: OneBotSessionHistoryConfig): void {
  ctx.on('ready', () => {
    const historyService = ctx.getService<SessionHistoryService>('session-history');
    if (!historyService?.registerAccessChecker) {
      ctx.logger.debug('session-history 服务未提供 registerAccessChecker, 跳过 OneBot 访问规则注册');
      return;
    }
    const checker: AccessChecker = {
      platform: 'onebot',
      check({ currentSessionId, targetSessionId }) {
        const target = parseOneBotSession(targetSessionId);
        if (!target) return undefined; // 不是合法 onebot 目标, 不表态
        const current = parseOneBotSession(currentSessionId);
        // 跨平台调用（current 不是 onebot）走默认放行: session-history scope 已粗筛
        if (!current) return undefined;

        if (current.selfId !== target.selfId && !cfg.allowCrossSelf) {
          return { decision: 'deny', reason: '当前 OneBot 配置不允许跨机器人账号读取会话历史' };
        }
        if (current.detailType === 'group' && target.detailType === 'private' && !cfg.allowGroupReadPrivate) {
          return { decision: 'deny', reason: '当前 OneBot 配置不允许从群聊读取私聊历史' };
        }
        if (
          current.detailType === 'group' &&
          target.detailType === 'group' &&
          current.targetId !== target.targetId &&
          !cfg.allowCrossGroup
        ) {
          return { decision: 'deny', reason: '当前 OneBot 配置不允许跨群读取其他群历史' };
        }
        if (
          current.detailType === 'private' &&
          target.detailType === 'private' &&
          current.targetId !== target.targetId &&
          !cfg.allowCrossPrivate
        ) {
          return { decision: 'deny', reason: '当前 OneBot 配置不允许跨私聊读取其他私聊历史' };
        }
        return undefined;
      },
    };
    const dispose = historyService.registerAccessChecker(checker);
    ctx.on('dispose', dispose);
    ctx.logger.info('OneBot 会话历史访问规则已注册到 session-history');
  });
}

function registerSessionHistoryTools(ctx: Context, bundle: OneBotToolBundle, cfg: OneBotSessionHistoryConfig): void {
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
            self_id: { type: 'string', description: '机器人账号。可选，默认使用当前 OneBot 会话的 selfId' },
          },
          required: ['target_type', 'target_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const current = requireOneBotSession(callCtx);
      const targetType = String(args.target_type ?? '').toLowerCase();
      const targetId = String(args.target_id ?? '').trim();
      if (targetType !== 'group' && targetType !== 'private') {
        return JSON.stringify({ error: `target_type 必须为 group 或 private，收到 ${args.target_type}` });
      }
      if (!targetId) return JSON.stringify({ error: 'target_id 不能为空' });
      const selfId = args.self_id ? String(args.self_id).trim() : current.selfId;
      if (!selfId) return JSON.stringify({ error: '无法确定 self_id' });
      if (!cfg.allowCrossSelf && selfId !== current.selfId) {
        return JSON.stringify({
          error: '当前配置不允许跨机器人账号解析会话',
          currentSelfId: current.selfId,
          requestedSelfId: selfId,
        });
      }
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
          '默认禁止从群聊读取私聊历史；如需语义搜索历史，请优先使用 memory_recall。',
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
            self_id: { type: 'string', description: '机器人账号。可选，默认使用当前 OneBot 会话的 selfId' },
            include_archived: { type: 'boolean', description: '是否包含已归档消息。默认使用插件配置。' },
          },
          required: ['target_type', 'target_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const current = requireOneBotSession(callCtx);
      const targetType = String(args.target_type ?? '').toLowerCase();
      const targetId = String(args.target_id ?? '').trim();
      if (targetType !== 'group' && targetType !== 'private') {
        return JSON.stringify({ error: `target_type 必须为 group 或 private，收到 ${args.target_type}` });
      }
      if (!targetId) return JSON.stringify({ error: 'target_id 不能为空' });

      const selfId = args.self_id ? String(args.self_id).trim() : current.selfId;
      if (!selfId) return JSON.stringify({ error: '无法确定 self_id' });

      const history = ctx.getService<SessionHistoryService>('session-history');
      if (!history)
        return JSON.stringify({
          error: 'session-history 服务不可用，请启用 @aalis/plugin-tool-session',
        });

      const limit = Math.max(1, Math.min(cfg.maxLimit, Math.floor(Number(args.limit) || cfg.defaultLimit)));
      const includeArchived =
        typeof args.include_archived === 'boolean' ? args.include_archived : cfg.includeArchivedDefault;
      const sessionId = buildOneBotSessionId(selfId, targetType, targetId);

      try {
        // 访问控制（跨账号/群读私/跨群/跨私）由 session-history 服务统一执行，
        // OneBot 的规则已通过 registerOneBotHistoryAccessChecker 注册。
        const result = await history.getHistory({ sessionId, limit, includeArchived }, callCtx);
        return JSON.stringify({
          ...result,
          sessionId,
          selfId,
          targetType,
          targetId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`onebot_get_session_history 失败 (${sessionId}): ${message}`);
        return JSON.stringify({ error: `读取 OneBot 会话历史失败: ${message}` });
      }
    },
  });

  ctx.logger.info('OneBot 会话历史工具已注册');
}

// ===== 请求处理工具（好友申请 / 群请求）=====

function registerRequestTools(ctx: Context, bundle: OneBotToolBundle): void {
  const { group, personal } = bundle;
  /** 找到支持 handleFriendRequest 的 OneBot 适配器 */
  function findRequestAdapter(ctx: Context):
    | (PlatformAdapter & {
        handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string>;
        handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string>;
      })
    | undefined {
    const adapter = getPlatformAdapters(ctx).find(
      a =>
        a.platform === 'onebot' && typeof (a as unknown as Record<string, unknown>).handleFriendRequest === 'function',
    );
    return adapter as typeof adapter & {
      handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string>;
      handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string>;
    };
  }

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
          },
          required: ['user_id', 'approve'],
        },
      },
    },
    handler: async args => {
      const adapter = findRequestAdapter(ctx);
      if (!adapter) return '未找到支持请求处理的 OneBot 适配器';
      return adapter.handleFriendRequest(
        String(args.user_id),
        !!args.approve,
        args.remark ? String(args.remark) : undefined,
      );
    },
  });

  // 群相关请求拆成两个工具，对应 OneBot v11 set_group_add_request 的两种 sub_type：
  // - approve_join_request: sub_type=add 「别人申请加入 bot 管理的群」 → 群务
  // - handle_group_invite:  sub_type=invite 「别人邀请 bot 加入群」 → 个人/私聊
  // 底层共用同一个适配器方法（pendingGroupRequests 内部已记录 subType），区别在于语义与权限归属。
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
          },
          required: ['user_id', 'group_id', 'approve'],
        },
      },
    },
    handler: async args => {
      const adapter = findRequestAdapter(ctx);
      if (!adapter) return '未找到支持请求处理的 OneBot 适配器';
      return adapter.handleGroupRequest(
        String(args.user_id),
        String(args.group_id),
        !!args.approve,
        args.reason ? String(args.reason) : undefined,
      );
    },
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
          },
          required: ['user_id', 'group_id', 'approve'],
        },
      },
    },
    handler: async args => {
      const adapter = findRequestAdapter(ctx);
      if (!adapter) return '未找到支持请求处理的 OneBot 适配器';
      return adapter.handleGroupRequest(
        String(args.user_id),
        String(args.group_id),
        !!args.approve,
        args.reason ? String(args.reason) : undefined,
      );
    },
  });

  ctx.logger.info('OneBot 请求处理工具已注册');
}
