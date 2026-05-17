import type { ConfigSchema, Context } from '@aalis/core';

import type { MediaService } from '@aalis/plugin-media-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';
import { getMessageName, getSenderLabel, prefixSender } from '@aalis/plugin-message-api';
import type { ArchiveNoticeOptions, MessageArchiveService } from '@aalis/plugin-message-archive-api';
import { MessageArchiveCapabilities } from '@aalis/plugin-message-archive-api';

export type {
  ArchiveIncomingResult,
  ArchiveNoticeOptions,
  MessageArchiveCapability,
  MessageArchiveCapabilityRegistry,
  MessageArchiveService,
} from '@aalis/plugin-message-archive-api';
export { MessageArchiveCapabilities } from '@aalis/plugin-message-archive-api';

export const name = '@aalis/plugin-message-archive';
export const displayName = '消息归档';
export const subsystem = 'message';
export const inject = {
  required: ['memory'],
  optional: ['media'],
};
export const provides = ['message-archive'];

export const configSchema: ConfigSchema = {
  debugLogs: {
    type: 'boolean',
    label: '归档调试日志',
    default: true,
    description: '记录图片解释完成和消息写入记忆等调试日志。',
  },
};

export const defaultConfig = {
  debugLogs: true,
};

interface PluginConfig {
  debugLogs: boolean;
}

/** 从消息文本中抽取 @提及的用户 ID 列表（平台无关：依赖各 adapter 输出统一的 <at id="X"> 标签） */
function extractMentions(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  const re = /<at(?:\s+self)?\s+id="([^"]+)">/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const id = m[1];
    if (id && id !== 'all') ids.add(id);
    m = re.exec(text);
  }
  return [...ids];
}

/** 单用户平台：无需发送者前缀（不存在多人说话歧义） */
const SINGLE_USER_PLATFORMS = new Set(['webui', 'cli']);

function buildIncomingContent(incoming: IncomingMessage): string {
  const useSenderPrefix = !SINGLE_USER_PLATFORMS.has(incoming.platform);
  let content = useSenderPrefix ? prefixSender(incoming.content, incoming.nickname, incoming.userId) : incoming.content;

  // 引用回复：把被引用消息的标签 + 内容拼到末尾，作为不可分割的上下文
  // 与图片描述、forward 摘要相同处理逻辑——把"非当前指令"的素材烘焙进归档文本，
  // 这样下一轮从 memory 拉历史时仍能看到引用关系。
  if (incoming.replyTo?.content) {
    const replyLabel = getSenderLabel(incoming.replyTo.nickname, incoming.replyTo.userId) ?? '?';
    content += `\n[引用 ${replyLabel} 的消息: ${incoming.replyTo.content}]`;
  }

  // 把 plugin-media 写入的 _attachmentDescriptions 按 attachments 顺序追加
  const attDescs = incoming._attachmentDescriptions;
  if (attDescs && attDescs.length > 0) {
    const lines = attDescs.filter((d): d is string => Boolean(d?.trim()));
    if (lines.length > 0) {
      const attachText = lines.join('\n');
      content = content ? `${content}\n${attachText}` : attachText;
    }
  }

  return content;
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: PluginConfig = {
    debugLogs: config.debugLogs !== false,
  };

  // memory 句柄会自动跟随 ctx.getService 的动态解析（用户切换 memory 偏好后下次调用即生效）
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) {
    throw new Error('message-archive 需要 memory 服务');
  }

  const service: MessageArchiveService = {
    async saveMessage(sessionId: string, message: Message, options?: { debugLabel?: string }): Promise<void> {
      await memory.saveMessage(sessionId, message);
      if (cfg.debugLogs && options?.debugLabel) {
        ctx.logger.debug(options.debugLabel);
      }
    },

    async archiveIncoming(incoming: IncomingMessage) {
      const working: IncomingMessage = {
        ...incoming,
        attachments: incoming.attachments ? incoming.attachments.map(a => ({ ...a })) : incoming.attachments,
        _attachmentDescriptions: incoming._attachmentDescriptions
          ? [...incoming._attachmentDescriptions]
          : incoming._attachmentDescriptions,
      };

      // 调用 plugin-media 一站式处理（识别 attachments 并写回 _attachmentDescriptions）
      if (working.attachments && working.attachments.length > 0 && !working._attachmentDescriptions) {
        const mediaSvc = ctx.getService<MediaService>('media');
        if (mediaSvc?.processMessage) {
          const report = await mediaSvc.processMessage(working);
          if (cfg.debugLogs && report.total > 0) {
            ctx.logger.debug(`附件识别完成: ${report.successCount}/${report.total} 个成功 | ${working.content}`);
          }
        }
      }

      const content = buildIncomingContent(working);

      // 把会话身份信息存入 metadata，供向量检索/上下文渲染等场景使用
      const meta: Record<string, unknown> = {};
      if (working.userId) meta.userId = working.userId;
      if (working.nickname) meta.nickname = working.nickname;
      if (working.platform) meta.platform = working.platform;
      if (working.groupId) meta.groupId = working.groupId;
      if (working.groupName) meta.groupName = working.groupName;
      if (working.sessionType) meta.sessionType = working.sessionType;
      // 平台侧消息 ID（如 OneBot message_id），用于"引用回复"反查归档原文
      if (working.messageId) meta.messageId = working.messageId;
      const mentions = extractMentions(content);
      if (mentions.length > 0) meta.mentions = mentions;

      const message: Message = {
        role: 'user',
        content,
        name: getMessageName(working.userId),
        timestamp: Date.now(),
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      };

      await memory.saveMessage(working.sessionId, message);

      if (cfg.debugLogs && working.attachments?.length) {
        ctx.logger.debug(
          `附件消息已写入记忆: session=${working.sessionId}, attachments=${working.attachments.length} | ${content}`,
        );
      }

      // 通知监听者：入站消息已落库（用于触发用户档案事实提取等后台任务）
      // 与 agent 是否回复无关，所有走 archiveIncoming 的消息都会发出
      ctx
        .emit('inbound:message:archived', {
          sessionId: working.sessionId,
          incoming: working,
          archivedMessage: message,
        })
        .catch(err => ctx.logger.debug(`inbound:message:archived 事件分发失败: ${err}`));

      return {
        message,
        content,
      };
    },

    async archiveNotice(opts: ArchiveNoticeOptions): Promise<Message | null> {
      const text = (opts.content ?? '').trim();
      if (!text) return null;

      const metadata: Record<string, unknown> = {
        kind: 'notice',
        noticeType: opts.noticeType,
      };
      if (opts.subType) metadata.subType = opts.subType;
      if (opts.platform) metadata.platform = opts.platform;
      if (opts.userId) metadata.userId = opts.userId;
      if (opts.targetId) metadata.targetId = opts.targetId;
      if (opts.groupId) metadata.groupId = opts.groupId;
      if (opts.operatorId) metadata.operatorId = opts.operatorId;
      if (opts.data) Object.assign(metadata, opts.data);

      const message: Message = {
        role: 'system',
        content: text,
        timestamp: opts.timestamp ?? Date.now(),
        metadata,
      };

      await memory.saveMessage(opts.sessionId, message);

      if (cfg.debugLogs) {
        ctx.logger.debug(
          `[notice 入档] session=${opts.sessionId} type=${opts.noticeType}${opts.subType ? `/${opts.subType}` : ''} | ${text}`,
        );
      }

      return message;
    },

    async findByMessageId(sessionId: string, messageId: string, scanLimit?: number): Promise<Message | null> {
      if (!messageId) return null;
      const limit = Math.max(1, Math.min(500, Math.floor(scanLimit ?? 100)));
      const history = await memory.getHistory(sessionId, limit);
      // 从最新往旧找：引用通常指向最近发的消息
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const m = history[i];
        const mid = m.metadata?.messageId;
        if (mid != null && String(mid) === messageId) return m;
      }
      return null;
    },
  };

  ctx.provide('message-archive', service, {
    capabilities: [
      MessageArchiveCapabilities.Incoming,
      MessageArchiveCapabilities.Generic,
      MessageArchiveCapabilities.Notice,
      MessageArchiveCapabilities.Lookup,
    ],
  });
}
