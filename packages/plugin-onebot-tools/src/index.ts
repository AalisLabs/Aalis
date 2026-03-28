import type { Context, ConfigSchema, PlatformAdapter, ToolCallContext } from '@aalis/core';

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
      enabled: { type: 'boolean', label: '启用群管理工具', default: true, description: '禁言、踢人、设置群名片等' },
    },
  },
  groupInfo: {
    label: '群信息查询',
    fields: {
      enabled: { type: 'boolean', label: '启用群信息查询', default: true, description: '查询群/成员信息' },
    },
  },
  interaction: {
    label: '特殊交互',
    fields: {
      enabled: { type: 'boolean', label: '启用特殊交互', default: true, description: '戳一戳等' },
    },
  },
};

export const defaultConfig = {
  groupManagement: { enabled: true },
  groupInfo: { enabled: true },
  interaction: { enabled: true },
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
      interaction: { enabled: true, ...(config.interaction as Record<string, unknown> ?? {}) },
    };

    if (cfg.groupManagement.enabled) registerGroupManagementTools(groupedCtx);
    if (cfg.groupInfo.enabled) registerGroupInfoTools(groupedCtx);
    if (cfg.interaction.enabled) registerInteractionTools(groupedCtx);
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
    safety: 'dangerous',
    authority: 3,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      const duration = typeof args.duration === 'number' ? args.duration : 60;
      await callAction(ctx, callCtx, 'set_group_ban', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        duration,
      });
      return duration === 0
        ? `已解除 ${args.user_id} 的禁言`
        : `已禁言 ${args.user_id}，时长 ${duration} 秒`;
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
    safety: 'dangerous',
    authority: 3,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
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
    safety: 'dangerous',
    authority: 4,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      await callAction(ctx, callCtx, 'set_group_kick', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        reject_add_request: !!args.reject_add_request,
      });
      return `已将 ${args.user_id} 踢出群聊`;
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
    safety: 'dangerous',
    authority: 3,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
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
    safety: 'dangerous',
    authority: 3,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
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
    safety: 'dangerous',
    authority: 4,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
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
    safety: 'dangerous',
    authority: 4,
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
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

  ctx.logger.info('OneBot 群管理工具已注册');
}

// ===== 群信息查询工具 =====

function registerGroupInfoTools(ctx: Context): void {

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

  // ---- 获取群成员信息 ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_member_info',
        description: '获取指定群成员的详细信息（昵称、群名片、角色等）。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要查询的用户QQ号' },
          },
          required: ['user_id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      const data = await callAction(ctx, callCtx, 'get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(args.user_id),
        no_cache: true,
      });
      return JSON.stringify(data);
    },
  });

  // ---- 获取群成员列表 ----
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'onebot_get_group_member_list',
        description: '获取当前群的全部成员列表。注意：大群可能返回数据量很大。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async (_args, callCtx) => {
      const { groupId } = requireGroupSession(callCtx);
      const data = await callAction(ctx, callCtx, 'get_group_member_list', {
        group_id: Number(groupId),
      });
      const list = Array.isArray(data) ? data : [];
      // 精简输出，只保留关键字段
      const summary = list.map((m: Record<string, unknown>) => ({
        user_id: m.user_id,
        nickname: m.nickname,
        card: m.card,
        role: m.role,
      }));
      return JSON.stringify(summary);
    },
  });

  ctx.logger.info('OneBot 群信息查询工具已注册');
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
