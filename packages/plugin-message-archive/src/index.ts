import type {
  Context,
  ConfigSchema,
  IncomingMessage,
  Message,
  MemoryService,
  MessageArchiveService,
} from '@aalis/core';
import { prefixSender, getMessageName } from '@aalis/core';

export const name = '@aalis/plugin-message-archive';
export const displayName = '消息归档';
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

interface ImageProcessResult {
  content: string;
  imageDescriptions?: string[];
  info: {
    imageCount: number;
    successCount: number;
    descriptions: string[];
    transformedContent: string;
  };
}

interface ImageRecognitionService {
  available: boolean;
  enabled: boolean;
  processMessage?: (input: { content: string; images: string[]; attachmentOrder?: Array<'image' | 'file'> }) => Promise<ImageProcessResult | null>;
}

function buildIncomingContent(incoming: IncomingMessage): string {
  let content = prefixSender(incoming.content, incoming.nickname, incoming.userId);

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
        _imageDescriptions: incoming._imageDescriptions ? [...incoming._imageDescriptions] : incoming._imageDescriptions,
        _fileDescriptions: incoming._fileDescriptions ? [...incoming._fileDescriptions] : incoming._fileDescriptions,
        _imageRecognitionInfo: incoming._imageRecognitionInfo ? {
          ...incoming._imageRecognitionInfo,
          descriptions: [...incoming._imageRecognitionInfo.descriptions],
        } : incoming._imageRecognitionInfo,
      };

      if (working.images && working.images.length > 0 && !working._imageRecognitionInfo) {
        const irService = ctx.getService<ImageRecognitionService>('image-recognition');
        if (irService?.available && irService.enabled && irService.processMessage) {
          const processed = await irService.processMessage({
            content: working.content,
            images: working.images,
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
      const message: Message = {
        role: 'user',
        content,
        name: getMessageName(working.userId),
        timestamp: Date.now(),
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

      return {
        message,
        content,
        imageRecognitionInfo: working._imageRecognitionInfo,
      };
    },
  };

  ctx.provide('message-archive', service, {
    capabilities: ['incoming', 'generic'],
  });
}