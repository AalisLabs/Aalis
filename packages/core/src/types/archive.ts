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