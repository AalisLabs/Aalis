import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { Context, ConfigSchema, ImageRecognitionService, MessageArchiveService, PlatformAdapter, ToolCallContext } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-onebot-tools';
export const displayName = 'OneBot 工具';
export const inject = {
  optional: ['platform'],
};

export const configSchema: ConfigSchema = {
  groupManagement: {
    label: '群管理工具',
    fields: {
      enabled: { type: 'boolean', label: '启用群管理工具', default: true, description: '禁言、踢人、设置群名片、撤回消息等' },
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
  messaging: {
    label: '主动发送消息',
    fields: {
      enabled: { type: 'boolean', label: '启用主动发送', default: true, description: '允许 agent 向任意私聊 / 群聊主动发送消息（用于代为转达、跨会话通知等场景）' },
      allowCrossSession: { type: 'boolean', label: '允许跨会话发送', default: true, description: '关闭后只能向当前会话发送（等价于普通回复，几乎没有意义，仅作降权开关）' },
    },
  },
};

export const defaultConfig = {
  groupManagement: { enabled: true },
  groupInfo: { enabled: true },
  account: { enabled: true },
  interaction: { enabled: true },
  messaging: { enabled: true, allowCrossSession: true },
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
  return ctx.getPlatforms().find(
    a => a.platform === 'onebot' && typeof a.callAction === 'function',
  );
}

/** 检查工具调用是否来自 OneBot 群聊 */
function requireGroupSession(callCtx: ToolCallContext): { selfId: string; groupId: string } {
  const parsed = parseOneBotSession(callCtx.sessionId);
  if (!parsed || parsed.detailType !== 'group') {
    throw new Error('此工具仅在 OneBot 群聊中可用');
  }
  return { selfId: parsed.selfId, groupId: parsed.targetId };
}

function requireOneBotSession(callCtx: ToolCallContext): { selfId: string; detailType: string; targetId: string } {
  const parsed = parseOneBotSession(callCtx.sessionId);
  if (!parsed) throw new Error('此工具仅在 OneBot 会话中可用');
  return parsed;
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
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const params: Record<string, unknown> = {};
    for (const part of match[1].split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      params[part.slice(0, eq)] = part.slice(eq + 1)
        .replace(/&amp;/g, '&')
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&#44;/g, ',');
    }
    const source = imageSourceFromSegment(params);
    if (source) refs.push({ source, label: '[图片]', segment: params });
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
  const node = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  if (node.type === 'node' && node.data && typeof node.data === 'object') {
    return node.data as Record<string, unknown>;
  }
  return node;
}

function getForwardNodeContent(item: unknown): unknown {
  const node = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  const nodeData = getForwardNodeData(item);
  return nodeData.content ?? node.content ?? nodeData.message ?? node.message;
}

function collectForwardImageRefs(data: unknown, limit: number): ForwardImageRef[] {
  return getForwardMessages(data)
    .slice(0, limit)
    .flatMap(item => extractImageRefsFromContent(getForwardNodeContent(item)));
}

async function resolveForwardImageSource(ctx: Context, callCtx: ToolCallContext, ref: ForwardImageRef): Promise<string> {
  if (/^(https?:|data:)/i.test(ref.source)) return ref.source;

  try {
    const imageData = await callAction(ctx, callCtx, 'get_image', { file: ref.source }) as Record<string, unknown>;
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

async function recognizeForwardImages(ctx: Context, callCtx: ToolCallContext, data: unknown, limit: number): Promise<ForwardFormatContext> {
  const refs = collectForwardImageRefs(data, limit);
  const imageDescriptions = new Map<string, string>();
  if (refs.length === 0) return { imageDescriptions };

  const irService = ctx.getService<ImageRecognitionService>('image-recognition');
  if (!irService?.available || !irService.describe) {
    ctx.logger.debug(`合并转发包含 ${refs.length} 张图片，但 image-recognition 服务不可用`);
    return { imageDescriptions };
  }

  const seen = new Set<string>();
  for (const ref of refs) {
    const key = imageRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const imageSource = await resolveForwardImageSource(ctx, callCtx, ref);
      const description = await irService.describe(imageSource);
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

  return content.map(seg => {
    if (!seg || typeof seg !== 'object') return String(seg ?? '');
    const segment = seg as { type?: string; data?: Record<string, unknown> };
    const data = segment.data ?? {};
    switch (segment.type) {
      case 'text': return String(data.text ?? '');
      case 'at': return data.qq === 'all' ? '@全体成员' : `@${String(data.qq ?? '')}`;
      case 'image': {
        const source = imageSourceFromSegment(data);
        const desc = source ? context?.imageDescriptions.get(imageRefKey({ source, label: '[图片]', segment: data })) : undefined;
        return desc ? `[图片: ${desc}]` : '[图片]';
      }
      case 'face': return `[表情:${String(data.id ?? '')}]`;
      case 'reply': return '';
      case 'forward': return data.id ? `[合并转发:${String(data.id)}]` : '[合并转发]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'share': return `[分享:${String(data.title ?? '')}]`;
      case 'json': return '[JSON卡片]';
      case 'xml': return '[XML卡片]';
      default: return segment.type ? `[${segment.type}]` : '';
    }
  }).join('');
}

function formatCqMessageContent(content: string, context?: ForwardFormatContext): string {
  let imageIndex = 0;
  return content.replace(/\[CQ:image,([^\]]+)\]/g, (raw) => {
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
    const node = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const nodeData = getForwardNodeData(item);
    const sender = node.sender && typeof node.sender === 'object'
      ? node.sender as Record<string, unknown>
      : undefined;
    const name = String(nodeData.nickname ?? sender?.nickname ?? nodeData.name ?? nodeData.user_id ?? sender?.user_id ?? `节点${index + 1}`);
    const userId = nodeData.user_id ?? nodeData.uin ?? sender?.user_id;
    const prefix = userId != null ? `${name}(${String(userId)})` : name;
    const rawContent = getForwardNodeContent(item);
    const content = typeof rawContent === 'string'
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
    return await callAction(ctx, callCtx, 'get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: true,
    }) as Record<string, unknown>;
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

export function apply(ctx: Context, config: Record<string, unknown>): void {
  // 创建带分组标记的 Context 代理，所有通过此代理注册的工具自动归入 'onebot' 组
  const groupedCtx = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (tool: Parameters<Context['registerTool']>[0]) =>
          target.registerTool({ ...tool, groups: ['onebot'] });
      }
      return Reflect.get(target, prop, target);
    },
  }) as Context;

  // 仅当 OneBot 平台可用时才注册工具
  // 使用 ready 事件确保平台已加载
  ctx.on('ready', () => {
    if (!ctx.getPlatformNames().includes('onebot')) {
      ctx.logger.info('未检测到 OneBot 平台，跳过 OneBot 工具注册');
      return;
    }

    ctx.logger.info('检测到 OneBot 平台，开始注册 OneBot 工具');

    // 注册工具分组
    ctx.registerToolGroup({
      name: 'onebot',
      label: 'OneBot 工具',
      description: 'QQ 群管理、群信息查询、消息交互等 OneBot 平台工具',
    });

    const cfg = {
      groupManagement: { enabled: true, ...(config.groupManagement as Record<string, unknown> ?? {}) },
      groupInfo: { enabled: true, ...(config.groupInfo as Record<string, unknown> ?? {}) },
      account: { enabled: true, ...(config.account as Record<string, unknown> ?? {}) },
      interaction: { enabled: true, ...(config.interaction as Record<string, unknown> ?? {}) },
      messaging: { enabled: true, allowCrossSession: true, ...(config.messaging as Record<string, unknown> ?? {}) },
    };

    if (cfg.groupManagement.enabled) registerGroupManagementTools(groupedCtx);
    if (cfg.groupInfo.enabled) registerGroupInfoTools(groupedCtx);
    if (cfg.account.enabled) registerAccountTools(groupedCtx);
    if (cfg.interaction.enabled) registerInteractionTools(groupedCtx);
    if (cfg.messaging.enabled) registerMessagingTools(groupedCtx, !!cfg.messaging.allowCrossSession);
    registerRequestTools(groupedCtx);
  });
}

// ===== 群管理工具 =====

function registerGroupManagementTools(ctx: Context): void {

  // ---- 群禁言（单人）----
  ctx.registerTool({
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
          return shutUp <= now
            ? `已解除 ${args.user_id} 的禁言`
            : `解除禁言指令已发送，但用户仍在禁言中`;
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
  ctx.registerTool({
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
  ctx.registerTool({
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
  ctx.registerTool({
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
      const groupId = args.group_id ? String(args.group_id) : (session.detailType === 'group' ? session.targetId : '');
      if (!groupId) return '请提供 group_id，或在要退出的群聊中调用此工具';

      await callAction(ctx, callCtx, 'set_group_leave', {
        group_id: Number(groupId),
        is_dismiss: false,
      });
      return `已退出群 ${groupId}`;
    },
  });

  // ---- 设置群名片 ----
  ctx.registerTool({
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
  ctx.registerTool({
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
  ctx.registerTool({
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
  ctx.registerTool({
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
      return args.enable
        ? `已将 ${args.user_id} 设为管理员`
        : `已取消 ${args.user_id} 的管理员`;
    },
  });

  // ---- 撤回消息 ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_delete_msg',
        description: '撤回一条消息（群聊或私聊均可）。需要 message_id（来自历史消息或事件）。机器人对他人消息的撤回需要管理员权限。',
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

function registerGroupInfoTools(ctx: Context): void {

  // ---- 查看合并转发 ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_forward_msg',
        description: '读取合并转发消息内容。收到 <forward id="...">[合并转发消息]</forward> 时，用其中的 id 调用本工具。',
        parameters: {
          type: 'object',
          properties: {
            forward_id: { type: 'string', description: '合并转发消息 ID，即 forward 消息段 data.id' },
            limit: { type: 'number', description: '最多返回多少条节点，默认 30' },
          },
          required: ['forward_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      requireOneBotSession(callCtx);
      const forwardId = String(args.forward_id);
      const limit = Math.max(1, Math.min(100, typeof args.limit === 'number' ? Math.floor(args.limit) : 30));

      // 适配器的 callAction 已对 get_forward_msg 做了多参数键回退（id/message_id/res_id/m_resid）
      // 并维护了一份接收时即抓取的缓存。这里直接调用即可。
      let data: unknown;
      try {
        data = await callAction(ctx, callCtx, 'get_forward_msg', { id: forwardId });
      } catch (err) {
        return `合并转发读取失败：${err instanceof Error ? err.message : String(err)}。该转发可能已在协议端过期，或当前 OneBot 实现不支持跨会话读取。`;
      }

      // 适配器在缓存命中时返回 { __aalisForwardInline: '...已渲染的内联文本...' }，
      // 这是已经按 <forward id="..."> 包裹好的可读文本，直接回给 LLM 即可。
      if (data && typeof data === 'object' && '__aalisForwardInline' in (data as Record<string, unknown>)) {
        return String((data as Record<string, unknown>).__aalisForwardInline);
      }

      const formatContext = await recognizeForwardImages(ctx, callCtx, data, limit);
      return formatForwardMessage(data, limit, formatContext);
    },
  });

  // ---- 获取群信息 ----
  ctx.registerTool({
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
  ctx.registerTool({
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
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_member_list',
        description: '查询当前群的成员列表，支持按昵称/群名片/QQ号关键词搜索、按角色筛选、分页返回。大群（数百上千人）务必使用 keyword 或 role 过滤，避免一次拉取过多数据。',
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
  ctx.registerTool({
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
            group_id: { type: 'string', description: '可选。指定群号。缺省时查当前会话所在群（私聊时缺省会报错，请显式传入）。' },
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
        info = await adapter.callAction(probeSessionId, 'get_group_member_info', {
          group_id: Number(groupId),
          user_id: Number(selfId),
          no_cache: true,
        }) as Record<string, unknown>;
      } catch (err) {
        return JSON.stringify({ available: false, reason: `查询失败: ${err instanceof Error ? err.message : String(err)}` });
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
  ctx.registerTool({
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
      const adapter = findOneBotAdapter(ctx) as (PlatformAdapter & {
        getSelfMutes?: () => Array<{ selfId: string; groupId: string; untilTs: number; remainingSec: number }>;
      }) | undefined;
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

  ctx.logger.info('OneBot 群信息查询工具已注册');
}

// ===== 账号 / 好友 / 群列表查询工具 =====

function registerAccountTools(ctx: Context): void {

  // ---- 群列表 ----
  ctx.registerTool({
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
      const list = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];

      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));

      const all = list.map(g => ({
        group_id: g.group_id,
        group_name: String(g.group_name ?? ''),
        member_count: g.member_count,
        max_member_count: g.max_member_count,
      }));
      const filtered = keyword
        ? all.filter(g => `${g.group_id} ${g.group_name}`.toLowerCase().includes(keyword))
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
        groups: items,
      });
    },
  });

  // ---- 好友列表 ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_friend_list',
        description:
          '获取机器人的好友列表（OneBot v11: get_friend_list）。' +
          '支持按昵称/备注/QQ号关键词搜索、分页返回。',
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
      const list = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];

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
  ctx.registerTool({
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
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_login_info',
        description: '显式查询当前 OneBot 连接的登录账号信息（QQ 号、昵称）。仅在用户要求核实账号、诊断连接或需要最新平台返回值时使用。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async (_args, callCtx) => {
      const data = await callAction(ctx, callCtx, 'get_login_info', {});
      return JSON.stringify(data);
    },
  });

  // ---- 删除好友 ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_delete_friend',
        description: '删除指定 QQ 好友。适用于私聊持续骚扰、辱骂、垃圾消息等不希望继续保持好友关系的场景。该接口是 go-cqhttp/NapCat 等 OneBot v11 实现的常见扩展。',
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
      const userId = args.user_id ? String(args.user_id) : (session.detailType === 'private' ? session.targetId : '');
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

function registerInteractionTools(ctx: Context): void {

  // ---- 戳一戳 ----
  ctx.registerTool({
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

  // ---- 群打卡 ----
  ctx.registerTool({
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

// ===== 主动发送消息工具 =====
//
// OneBot v11/v12 官方协议参考（onebot.dev）：
//   v11 send_private_msg: { user_id: int64, message: msg, auto_escape?: bool }
//   v11 send_group_msg:   { group_id: int64, message: msg, auto_escape?: bool }
//   v12 send_message:     { detail_type: 'private'|'group'|'channel', user_id?, group_id?, ... , message: segment[] }
// 适配器内部已封装 buildSendMessage()，按已连接协议版本自动选择上述 action。
// 这里只需调用 adapter.sendMessage(targetSessionId, content)。

/** 适配器上的非标准限速闸门（OneBot 适配器提供） */
interface OneBotProactiveRateGate {
  checkAndRecordProactiveSend?(sessionId: string): { allowed: boolean; reason?: string };
}

function registerMessagingTools(ctx: Context, allowCrossSession: boolean): void {

  // ---- 主动发送消息（任意私聊 / 群聊）----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_send_message',
        description:
          '向指定 QQ 用户（私聊）或 QQ 群（群聊）主动发送消息。该工具为通用出站通道，' +
          '适用于任何需要向“当前会话以外”发消息的场景，包括但不限于：' +
          '(1) 用户让你向另一人/另一群转告信息；' +
          '(2) 你自主决定向某位好友打招呼、问候、分享、提醒；' +
          '(3) 向某个群发布公告 / 结果 / 总结；' +
          '(4) 任何你判断合适的跨会话主动联系。\n' +
          '不需要用户明示“转告”才能调用。但调用前请确认 target_id 准确无误。\n' +
          '消息体支持纯文本，也支持 Aalis 标准富文本标记：<at qq="123"/>、<image url="..."/>、<reply id="..."/>、<face id="..."/>。\n' +
          '限制：发送目标用户必须是 bot 已加好友的人；发送目标群必须是 bot 所在的群。' +
          '频率受限于适配器的 chat-flow 限速设置（防 DDoS），如被限速会在返回值中告知。',
        parameters: {
          type: 'object',
          properties: {
            target_type: {
              type: 'string',
              enum: ['private', 'group'],
              description: 'private = 私聊（向某个 QQ 号），group = 群聊（向某个群号）',
            },
            target_id: {
              type: 'string',
              description: '目标 QQ 号（私聊）或群号（群聊）',
            },
            content: {
              type: 'string',
              description: '要发送的消息内容（纯文本或带富文本标记）',
            },
          },
          required: ['target_type', 'target_id', 'content'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const targetType = String(args.target_type ?? '').toLowerCase();
      const targetId = String(args.target_id ?? '').trim();
      const content = String(args.content ?? '');

      if (targetType !== 'private' && targetType !== 'group') {
        return `参数错误：target_type 必须为 'private' 或 'group'，收到 '${args.target_type}'`;
      }
      if (!targetId) return '参数错误：target_id 不能为空';
      if (!content.trim()) return '参数错误：content 不能为空';

      const current = requireOneBotSession(callCtx);

      // 跨会话开关：若关闭，仅允许向当前会话发送（等价于普通回复）
      if (!allowCrossSession) {
        if (current.detailType !== targetType || current.targetId !== targetId) {
          return '操作被拒绝：跨会话主动发送已在配置中关闭，仅允许向当前会话发送';
        }
      }

      const adapter = findOneBotAdapter(ctx);
      if (!adapter?.sendMessage) {
        throw new Error('OneBot 适配器不可用或不支持 sendMessage');
      }

      // 复用当前会话所属的 selfId（即 bot 自身），构造目标 sessionId
      const targetSessionId = `onebot:${current.selfId}:${targetType}:${targetId}`;

      // 限速闸门：复用 chat-flow 的滑动窗口限速，防止 prompt injection 导致群发/骚扰
      const gate = (adapter as PlatformAdapter & OneBotProactiveRateGate).checkAndRecordProactiveSend;
      if (typeof gate === 'function') {
        const verdict = gate.call(adapter, targetSessionId);
        if (!verdict.allowed) {
          return `发送被限速拦截：${verdict.reason ?? '超出限速阈值'}`;
        }
      }

      try {
        await adapter.sendMessage(targetSessionId, content);
      } catch (err) {
        return `发送失败：${(err as Error).message}`;
      }

      // 写入目标会话记忆，让 bot 在后续对话中能记得自己刚说过什么
      const archive = ctx.getService<MessageArchiveService>('message-archive');
      if (archive?.saveMessage) {
        try {
          await archive.saveMessage(targetSessionId, {
            role: 'assistant',
            content,
            timestamp: Date.now(),
            metadata: {
              source: 'proactive',
              originSessionId: callCtx.sessionId,
            },
          });
        } catch (err) {
          ctx.logger.warn(`主动发送写入目标会话记忆失败: ${err}`);
        }
      }

      const targetLabel = targetType === 'private' ? `用户 ${targetId}` : `群 ${targetId}`;
      ctx.logger.info(`[主动发送] selfId=${current.selfId} -> ${targetLabel}: ${content.slice(0, 60)}${content.length > 60 ? '...' : ''}`);
      return `已向${targetLabel}发送消息`;
    },
  });

  ctx.logger.info('OneBot 主动发送消息工具已注册');
}

// ===== 请求处理工具（好友申请 / 群请求）=====

function registerRequestTools(ctx: Context): void {
  /** 找到支持 handleFriendRequest 的 OneBot 适配器 */
  function findRequestAdapter(ctx: Context): PlatformAdapter & {
    handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string>;
    handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string>;
  } | undefined {
    const adapter = ctx.getPlatforms().find(
      a => a.platform === 'onebot' && typeof (a as unknown as Record<string, unknown>).handleFriendRequest === 'function',
    );
    return adapter as typeof adapter & {
      handleFriendRequest(userId: string, approve: boolean, remark?: string): Promise<string>;
      handleGroupRequest(userId: string, groupId: string, approve: boolean, reason?: string): Promise<string>;
    };
  }

  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_handle_friend_request',
        description: '处理 QQ 好友申请，同意或拒绝。仅在收到好友申请通知后才有效。',
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
    handler: async (args) => {
      const adapter = findRequestAdapter(ctx);
      if (!adapter) return '未找到支持请求处理的 OneBot 适配器';
      return adapter.handleFriendRequest(
        String(args.user_id),
        !!args.approve,
        args.remark ? String(args.remark) : undefined,
      );
    },
  });

  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_handle_group_request',
        description: '处理 QQ 群请求：包括「有人申请加入 bot 管理的群」和「他人邀请 bot 入群」两种情况，同意或拒绝。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '发起请求的用户 QQ 号' },
            group_id: { type: 'string', description: '相关群号' },
            approve: { type: 'boolean', description: 'true = 同意，false = 拒绝' },
            reason: { type: 'string', description: '拒绝理由（拒绝时有效，可选）' },
          },
          required: ['user_id', 'group_id', 'approve'],
        },
      },
    },
    handler: async (args) => {
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
