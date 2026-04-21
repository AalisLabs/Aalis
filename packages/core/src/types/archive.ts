import type { IncomingMessage, Message } from './core.js';

export interface ArchiveIncomingResult {
  message: Message;
  content: string;
  imageRecognitionInfo?: IncomingMessage['_imageRecognitionInfo'];
}

export interface MessageArchiveService {
  saveMessage(sessionId: string, message: Message, options?: { debugLabel?: string }): Promise<void>;
  archiveIncoming(message: IncomingMessage): Promise<ArchiveIncomingResult>;
}

// ----- 消息归档能力声明（capability 框架）-----

export interface MessageArchiveCapabilityRegistry {
  /** 支持入站消息归档（archiveIncoming，含图片预识别） */
  Incoming: 'incoming';
  /** 支持通用消息保存（saveMessage） */
  Generic: 'generic';
}

export type MessageArchiveCapability = MessageArchiveCapabilityRegistry[keyof MessageArchiveCapabilityRegistry];

export const MessageArchiveCapabilities = {
  Incoming: 'incoming',
  Generic: 'generic',
} as const satisfies MessageArchiveCapabilityRegistry;

declare module './capabilities.js' {
  interface ServiceCapabilityMap {
    'message-archive': MessageArchiveCapability;
  }
}