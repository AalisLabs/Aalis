import type { ConfigSchema, Context } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { ToolCallContext } from '@aalis/plugin-tools-api';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-file-reader';
export const displayName = '文件读取';
export const provides = ['file-reader'];
export const inject = {
  optional: ['agent'],
};

export const configSchema: ConfigSchema = {
  maxFileSizeMB: {
    type: 'number',
    label: '最大文件大小 (MB)',
    default: 20,
    description: '允许上传的最大文件大小(MB)。超过此限制的文件将被拒绝。',
  },
  fileRetentionMinutes: {
    type: 'number',
    label: '文件保留时间 (分钟)',
    default: 60,
    description: '上传文件在内存中保留的时间，超时后自动清理。',
  },
};

export const defaultConfig = {
  maxFileSizeMB: 20,
  fileRetentionMinutes: 60,
};

// ===== 支持的文件类型 =====

/** 纯文本类 MIME → 直接 UTF-8 解码 */
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/x-sh',
]);

/** 扩展名 → MIME 映射（用于文件名推断） */
const EXT_MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/javascript',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.log': 'text/plain',
  '.sh': 'application/x-sh',
  '.py': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.h': 'text/plain',
  '.rs': 'text/plain',
  '.go': 'text/plain',
  '.rb': 'text/plain',
  '.php': 'text/plain',
  '.sql': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

// ===== 内部文件存储 =====

interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  data: Buffer;
  sessionId: string;
  uploadedAt: number;
  /** 已提取的文本缓存 */
  textCache?: string;
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const maxFileSize = ((config.maxFileSizeMB as number) ?? 20) * 1024 * 1024;
  const retentionMs = ((config.fileRetentionMinutes as number) ?? 60) * 60 * 1000;

  // 文件存储
  const fileStore = new Map<string, StoredFile>();
  let idCounter = 0;

  function generateId(): string {
    return `file_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
  }

  /** 从 base64 data URL 解码为 Buffer */
  function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  /** 根据文件名推断 MIME 类型 */
  function inferMimeType(fileName: string, providedMime?: string): string {
    if (providedMime && providedMime !== 'application/octet-stream') return providedMime;
    const ext = fileName.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && EXT_MIME_MAP[ext]) return EXT_MIME_MAP[ext];
    return providedMime || 'application/octet-stream';
  }

  /** 提取文件文本内容 */
  async function extractText(file: StoredFile): Promise<string> {
    if (file.textCache !== undefined) return file.textCache;

    let text: string;
    const mime = file.mimeType;

    if (TEXT_MIME_TYPES.has(mime) || mime.startsWith('text/')) {
      // 纯文本：直接 UTF-8 解码
      text = file.data.toString('utf-8');
    } else if (mime === 'application/pdf') {
      text = await extractPdf(file.data);
    } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      text = await extractDocx(file.data);
    } else if (mime === 'application/msword') {
      text = '[不支持旧版 .doc 格式，请转换为 .docx 后重新上传]';
    } else {
      text = `[不支持的文件格式: ${mime}]`;
    }

    file.textCache = text;
    return text;
  }

  /** PDF 文本提取 */
  async function extractPdf(buffer: Buffer): Promise<string> {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      return result.text || '[PDF 无文本内容]';
    } catch (err) {
      ctx.logger.warn('PDF 解析失败:', err);
      return '[PDF 解析失败]';
    }
  }

  /** DOCX 文本提取 */
  async function extractDocx(buffer: Buffer): Promise<string> {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '[DOCX 无文本内容]';
    } catch (err) {
      ctx.logger.warn('DOCX 解析失败:', err);
      return '[DOCX 解析失败]';
    }
  }

  /** 存储文件并返回 ID */
  function storeFile(name: string, data: Buffer, mimeType: string, sessionId: string): StoredFile {
    const id = generateId();
    const file: StoredFile = {
      id,
      name,
      mimeType,
      data,
      sessionId,
      uploadedAt: Date.now(),
    };
    fileStore.set(id, file);
    return file;
  }

  // ===== 定期清理过期文件 =====

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, file] of fileStore) {
      if (now - file.uploadedAt > retentionMs) {
        fileStore.delete(id);
      }
    }
  }, 60_000);

  ctx.on('dispose', () => {
    clearInterval(cleanupTimer);
    fileStore.clear();
  });

  // ===== 注册工具分组 =====

  ctx.registerToolGroup({
    name: 'file-reader',
    label: '文件读取',
    description: '读取用户上传的文档文件（TXT、PDF、DOCX 等）的文本内容',
  });

  // 使用 Proxy 为工具注入分组
  const toolCtx = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (tool: Parameters<Context['registerTool']>[0]) =>
          target.registerTool({ ...tool, groups: ['file-reader'] });
      }
      return Reflect.get(target, prop, target);
    },
  }) as Context;

  // ===== 注册工具：read_uploaded_file =====

  toolCtx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'read_uploaded_file',
        description:
          '读取用户上传的文件内容。支持 TXT/MD/CSV/JSON/XML/PDF/DOCX 等常见格式。' +
          '当用户上传文件并提到需要分析/阅读/总结文件内容时调用此工具。' +
          '参数 fileId 在用户上传文件时会包含在消息中（格式为 [文件: 文件名 (ID: xxx)]）。',
        parameters: {
          type: 'object',
          properties: {
            fileId: {
              type: 'string',
              description: '文件唯一标识符，从用户消息中的 [文件: ... (ID: xxx)] 获取',
            },
            maxLength: {
              type: 'number',
              description: '返回文本的最大字符数（可选，默认不限制）。对于非常大的文件，可以限制返回长度',
            },
          },
          required: ['fileId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args: Record<string, unknown>, _callCtx: ToolCallContext): Promise<string> => {
      const fileId = args.fileId as string;
      const maxLength = args.maxLength as number | undefined;

      const file = fileStore.get(fileId);
      if (!file) {
        return `错误：找不到文件 (ID: ${fileId})。文件可能已过期或不存在。`;
      }

      try {
        let text = await extractText(file);

        if (maxLength && text.length > maxLength) {
          text = `${text.slice(0, maxLength)}\n\n... [文本已截断，原始长度: ${text.length} 字符]`;
        }

        return `文件: ${file.name}\n类型: ${file.mimeType}\n大小: ${(file.data.length / 1024).toFixed(1)} KB\n\n--- 内容 ---\n${text}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`文件读取失败 (${file.name}):`, msg);
        return `错误：读取文件 "${file.name}" 失败: ${msg}`;
      }
    },
  });

  // ===== 注册工具：list_uploaded_files =====

  toolCtx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'list_uploaded_files',
        description: '列出当前会话中用户上传的所有文件。返回文件列表（含 ID、文件名、类型、大小）。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '会话 ID（可选，默认列出所有文件）',
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string> => {
      const sid = (args.sessionId as string) || callCtx.sessionId;
      const files = [...fileStore.values()].filter(f => !sid || f.sessionId === sid);

      if (files.length === 0) {
        return '当前没有已上传的文件。';
      }

      const lines = files.map(
        f => `- ${f.name} (ID: ${f.id}, 类型: ${f.mimeType}, 大小: ${(f.data.length / 1024).toFixed(1)} KB)`,
      );
      return `已上传的文件 (${files.length} 个):\n${lines.join('\n')}`;
    },
  });

  // ===== 文件附件预处理函数 =====

  async function preprocessFiles(msg: IncomingMessage, next: () => Promise<void>): Promise<void> {
    if (!msg.files || msg.files.length === 0) {
      await next();
      return;
    }

    const fileInfos: string[] = [];
    // 记录图片文件被路由到 msg.images 的数量（用于 attachmentOrder 更新）
    let routedImageCount = 0;

    for (const fileAttachment of msg.files) {
      try {
        const { buffer, mimeType: dataMime } = dataUrlToBuffer(fileAttachment.data);

        // 判断是否为图片文件
        const resolvedMime = fileAttachment.mimeType || dataMime;
        if (resolvedMime.startsWith('image/')) {
          // 图片文件 → 路由到 msg.images，由 image-recognition 中间件或多模态 LLM 处理
          if (!msg.images) msg.images = [];
          msg.images.push(fileAttachment.data);
          routedImageCount++;
          // 如果存在 attachmentOrder，将对应的 'file' 条目替换为 'image'（因为被路由到了图片队列）
          if (msg.attachmentOrder) {
            let fileIdx = 0;
            for (let i = 0; i < msg.attachmentOrder.length; i++) {
              if (msg.attachmentOrder[i] === 'file') {
                // 找到当前文件在 order 中的位置（已处理的非路由文件 + 路由图片 = fileIdx）
                if (fileIdx === fileInfos.length + routedImageCount - 1) {
                  msg.attachmentOrder[i] = 'image';
                  break;
                }
                fileIdx++;
              }
            }
          }
          ctx.logger.debug(`图片文件 ${fileAttachment.name} 已路由到 msg.images`);
          continue;
        }

        // 非图片文件：验证大小并存储
        if (buffer.length > maxFileSize) {
          fileInfos.push(
            `[文件: ${fileAttachment.name} - 超过大小限制 (${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${(maxFileSize / 1024 / 1024).toFixed(0)}MB)]`,
          );
          continue;
        }

        const mimeType = inferMimeType(fileAttachment.name, resolvedMime);
        const stored = storeFile(fileAttachment.name, buffer, mimeType, msg.sessionId);

        ctx.logger.debug(`文件已存储: ${stored.name} (ID: ${stored.id}, ${(buffer.length / 1024).toFixed(1)} KB)`);

        // 小文件自动读取内容并注入消息，大文件仅提供 ID 让模型按需调用工具
        const AUTO_INLINE_LIMIT = 30_000; // 字符
        try {
          const text = await extractText(stored);
          if (text.length <= AUTO_INLINE_LIMIT && !text.startsWith('[不支持')) {
            fileInfos.push(`[文件: ${stored.name}]\n--- 文件内容 ---\n${text}\n--- 文件内容结束 ---`);
          } else {
            fileInfos.push(`[文件: ${stored.name} (ID: ${stored.id}，大文件，使用 read_uploaded_file 工具读取内容)]`);
          }
        } catch {
          fileInfos.push(`[文件: ${stored.name} (ID: ${stored.id})]`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`文件处理失败 (${fileAttachment.name}):`, errMsg);
        fileInfos.push(`[文件: ${fileAttachment.name} - 处理失败]`);
      }
    }

    // 如果有 attachmentOrder，将文件描述存入 _fileDescriptions，交由后续统一组装
    if (msg.attachmentOrder && fileInfos.length > 0) {
      msg._fileDescriptions = fileInfos;
    } else if (fileInfos.length > 0) {
      // 无排序信息时保持原有行为：直接注入 msg.content
      const fileText = fileInfos.join('\n');
      msg.content = msg.content ? `${msg.content}\n${fileText}` : fileText;
    }

    // 清除原始文件数据（已存储到 fileStore 或路由到 images）
    msg.files = undefined;

    await next();
  }

  // 优先使用 agent.registerPreprocessor，回退到 ctx.middleware
  const agent = ctx.getService<AgentService>('agent');
  if (agent?.registerPreprocessor) {
    agent.registerPreprocessor('file-reader', preprocessFiles);
  } else {
    ctx.middleware('agent:input:before', async (data, next) => {
      await preprocessFiles(data.message, next);
    });
  }

  // 注册 file-reader 服务，供其他插件（如 WebUI）查询文件上传能力是否可用
  ctx.provide('file-reader', {
    available: true,
  });

  ctx.logger.info(
    `文件读取插件已加载 (最大 ${(maxFileSize / 1024 / 1024).toFixed(0)}MB, 保留 ${(retentionMs / 60000).toFixed(0)} 分钟)`,
  );
}
