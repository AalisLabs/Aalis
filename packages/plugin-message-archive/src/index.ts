import type { ConfigSchema, Context, Message } from '@aalis/core';
import type { ImageRecognitionService } from '@aalis/plugin-image-recognition-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import { getMessageName, getSenderLabel, prefixSender } from '@aalis/plugin-message-api';
import type { ArchiveNoticeOptions, MessageArchiveService } from './types.js';
import { MessageArchiveCapabilities } from './types.js';

export type {
  ArchiveIncomingResult,
  ArchiveNoticeOptions,
  MessageArchiveCapability,
  MessageArchiveCapabilityRegistry,
  MessageArchiveService,
} from './types.js';
export { MessageArchiveCapabilities } from './types.js';

export const name = '@aalis/plugin-message-archive';
export const displayName = '消息归档';
export const subsystem = 'message';
export const inject = {
  required: ['memory'],
  optional: ['image-recognition'],
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

  if (incoming.attachmentOrder && (incoming._fileDescriptions || incoming._imageDescriptions)) {
    const fileDescs = incoming._fileDescriptions ?? [];
    const imageDescs = incoming._imageDescriptions ?? [];
    let fileIndex = 0;
    let imageIndex = 0;
    const ordered: string[] = [];

    for (const type of incoming.attachmentOrder) {
      if (type === 'file' && fileIndex < fileDescs.length) {
        ordered.push(fileDescs[fileIndex++]);
      } else if (type === 'image' && imageIndex < imageDescs.length) {
        ordered.push(imageDescs[imageIndex++]);
      }
    }
    while (fileIndex < fileDescs.length) ordered.push(fileDescs[fileIndex++]);
    while (imageIndex < imageDescs.length) ordered.push(imageDescs[imageIndex++]);

    if (ordered.length > 0) {
      const attachText = ordered.join('\n');
      content = content ? `${content}\n${attachText}` : attachText;
    }
  }

  return content;
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: PluginConfig = {
    debugLogs: config.debugLogs !== false,
  };

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
        images: incoming.images ? [...incoming.images] : incoming.images,
        files: incoming.files ? [...incoming.files] : incoming.files,
        attachmentOrder: incoming.attachmentOrder ? [...incoming.attachmentOrder] : incoming.attachmentOrder,
        _imageDescriptions: incoming._imageDescriptions
          ? [...incoming._imageDescriptions]
          : incoming._imageDescriptions,
        _fileDescriptions: incoming._fileDescriptions ? [...incoming._fileDescriptions] : incoming._fileDescriptions,
        _imageRecognitionInfo: incoming._imageRecognitionInfo
          ? {
              ...incoming._imageRecognitionInfo,
              descriptions: [...incoming._imageRecognitionInfo.descriptions],
            }
          : incoming._imageRecognitionInfo,
      };

      if (working.images && working.images.length > 0 && !working._imageRecognitionInfo) {
        const irService = ctx.getService<ImageRecognitionService>('image-recognition');
        if (irService?.available && irService.enabled && irService.processMessage) {
          const context = await irService.buildContext?.(working);
          const processed = await irService.processMessage({
            content: working.content,
            images: working.images,
            context,
            attachmentOrder: working.attachmentOrder,
          });
          if (processed) {
            working.content = processed.content;
            working._imageDescriptions = processed.imageDescriptions;
            working._imageRecognitionInfo = processed.info;
            working.images = undefined;
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
      const mentions = extractMentions(content);
      if (mentions.length > 0) meta.mentions = mentions;

      const message: Message = {
        role: 'user',
        content,
        name: getMessageName(working.userId),
        timestamp: Date.now(),
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      };

      if (cfg.debugLogs && working._imageRecognitionInfo) {
        ctx.logger.debug(
          `图片解释完成: ${working._imageRecognitionInfo.successCount}/${working._imageRecognitionInfo.imageCount} 张成功 | ${content.slice(0, 200)}`,
        );
      }

      await memory.saveMessage(working.sessionId, message);

      if (cfg.debugLogs && working._imageRecognitionInfo) {
        ctx.logger.debug(
          `图片消息已写入记忆: session=${working.sessionId}, images=${working._imageRecognitionInfo.imageCount}, success=${working._imageRecognitionInfo.successCount} | ${content.slice(0, 200)}`,
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
        imageRecognitionInfo: working._imageRecognitionInfo,
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
          `[notice 入档] session=${opts.sessionId} type=${opts.noticeType}${opts.subType ? `/${opts.subType}` : ''} | ${text.slice(0, 200)}`,
        );
      }

      return message;
    },
  };

  ctx.provide('message-archive', service, {
    capabilities: [
      MessageArchiveCapabilities.Incoming,
      MessageArchiveCapabilities.Generic,
      MessageArchiveCapabilities.Notice,
    ],
  });
}
