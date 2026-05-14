/**
 * WebUI WebSocket 协议 — 入站消息 zod schema。
 *
 * 入站消息来自不受信的客户端（浏览器），必须运行时校验。
 * 出站消息由服务端构造，TS 类型即可保证形状，运行时不重复校验。
 */
import { z } from 'zod';

// ----- 入站（客户端 → 服务端） -----

const AttachmentSchema = z.object({
  kind: z.enum(['image', 'audio', 'video', 'file']),
  data: z.string(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
  byteSize: z.number().optional(),
  durationSec: z.number().optional(),
});

const WSMessageSchema = z.object({
  type: z.literal('message'),
  content: z.string().optional(),
  sessionId: z.string().optional(),
  /** 统一附件列表（image/audio/video/file） */
  attachments: z.array(AttachmentSchema).optional(),
});

const WSSubscribeLogsSchema = z.object({ type: z.literal('subscribe_logs') });
const WSSubscribeSessionSchema = z.object({
  type: z.literal('subscribe_session'),
  sessionId: z.string(),
});
const WSUnsubscribeSessionSchema = z.object({
  type: z.literal('unsubscribe_session'),
  sessionId: z.string(),
});
const WSAbortSchema = z.object({
  type: z.literal('abort'),
  sessionId: z.string().optional(),
});
const WSCompressSchema = z.object({
  type: z.literal('compress'),
  sessionId: z.string().optional(),
});

/**
 * 入站消息辨识联合。**所有 WebSocket 入站消息都必须通过此 schema 校验。**
 *
 * 用法：
 * ```ts
 * const parsed = WSIncomingSchema.safeParse(JSON.parse(raw));
 * if (!parsed.success) { logger.warn('协议违规', parsed.error.issues); return; }
 * const msg = parsed.data;
 * ```
 */
export const WSIncomingSchema = z.discriminatedUnion('type', [
  WSMessageSchema,
  WSSubscribeLogsSchema,
  WSSubscribeSessionSchema,
  WSUnsubscribeSessionSchema,
  WSAbortSchema,
  WSCompressSchema,
]);

export type WSIncoming = z.infer<typeof WSIncomingSchema>;
