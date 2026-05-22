import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ConfigSchema, Context } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import { useAgent } from '@aalis/plugin-agent-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ToolCallContext } from '@aalis/plugin-tools-api';
import { toolsWithGroups, useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-file-reader';
export const displayName = '文件读取';
export const subsystem = 'tools';
export const provides = ['file-reader'];
export const inject = {
  required: ['storage'],
  optional: ['agent', 'memory'],
};

export const configSchema: ConfigSchema = {
  maxFileSizeMB: {
    type: 'number',
    label: '最大文件大小 (MB)',
    default: 20,
    description: '允许上传的最大文件大小(MB)。超过此限制的文件将被拒绝。',
  },
  autoInlineLimit: {
    type: 'number',
    label: '自动 inline 阈值（字符）',
    default: 100000,
    description:
      '提取出的文本长度若 ≤ 此值，则直接 inline 到附件描述里（模型无需调工具即可看到全文）；否则只挂 ID，由模型按需用 read_uploaded_file 拉取。',
  },
  toolDefaultMaxLength: {
    type: 'number',
    label: 'read_uploaded_file 默认截断',
    default: 50000,
    description:
      'read_uploaded_file 工具未显式传 maxLength 时使用的默认截断字符数，避免把超大文档一次喂进 LLM 上下文导致爆 token。',
  },
  retentionDays: {
    type: 'number',
    label: '保留天数',
    default: 30,
    description: '上传文件保留的最长天数，超过即清理（按文件 mtime）。0 表示不按时间清理。',
  },
  lruMaxTotalMB: {
    type: 'number',
    label: '磁盘总量上限 (MB)',
    default: 500,
    description: '上传文件总目录占用超过该上限时，按 mtime 由旧到新淘汰直到回落到上限以下。0 表示不限。',
  },
  fileRetentionMinutes: {
    type: 'number',
    label: '【已弃用】内存保留时间 (分钟)',
    default: 0,
    description: '旧版兼容字段，不再使用——现在所有文件都持久化到 pluginData。',
  },
};

export const defaultConfig = {
  maxFileSizeMB: 20,
  autoInlineLimit: 100000,
  toolDefaultMaxLength: 50000,
  retentionDays: 30,
  lruMaxTotalMB: 500,
  fileRetentionMinutes: 0,
};

// ===== 支持的文件类型 =====

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

// ===== 存储布局 =====

const ROOT_URI = 'pluginData:/file-reader';

/** 元信息 sidecar（与文件同目录、同名 + .meta.json） */
interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sessionId: string;
  uploadedAt: number;
  /** 已提取文本（小文件提取后顺手缓存，避免每次都重复 parse） */
  textCache?: string;
}

interface FileEntry extends FileMeta {
  /** 数据文件 URI */
  dataUri: string;
  /** 元信息 sidecar URI */
  metaUri: string;
}

// ===== 工具名常量（硬编码，避免运行期改名） =====

const TOOL_READ = 'read_uploaded_file';
const TOOL_LIST = 'list_uploaded_files';
const TOOL_DELETE = 'delete_uploaded_file';

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const maxFileSize = ((config.maxFileSizeMB as number) ?? 20) * 1024 * 1024;
  const autoInlineLimit = (config.autoInlineLimit as number) ?? 100000;
  const toolDefaultMaxLength = (config.toolDefaultMaxLength as number) ?? 50000;
  const retentionDays = (config.retentionDays as number) ?? 30;
  const lruMaxTotalBytes = ((config.lruMaxTotalMB as number) ?? 500) * 1024 * 1024;

  const _storage = ctx.getService<StorageService>('storage');
  if (!_storage) {
    ctx.logger.error('storage 服务不可用，file-reader 无法启动');
    return;
  }
  const storage: StorageService = _storage;

  // 启动时确保根目录存在（写一个 placeholder 然后立即删——避免目录不存在导致 list 失败）
  try {
    await storage.list(ROOT_URI);
  } catch {
    // 目录不存在，写入再删除一个 placeholder 触发自动建目录
    try {
      await storage.writeFile(`${ROOT_URI}/.keep`, '');
    } catch (err) {
      ctx.logger.warn('初始化 file-reader 根目录失败:', err);
    }
  }

  // 内存索引：fileId → FileEntry（启动时从磁盘恢复，运行期与磁盘双写）
  const index = new Map<string, FileEntry>();

  function dataUri(sessionId: string, id: string, ext: string): string {
    return `${ROOT_URI}/${sessionId}/${id}${ext}`;
  }
  function metaUri(sessionId: string, id: string): string {
    return `${ROOT_URI}/${sessionId}/${id}.meta.json`;
  }

  async function persistMeta(meta: FileMeta): Promise<FileEntry> {
    const ext = path.extname(meta.name) || '';
    const entry: FileEntry = {
      ...meta,
      dataUri: dataUri(meta.sessionId, meta.id, ext),
      metaUri: metaUri(meta.sessionId, meta.id),
    };
    await storage.writeFile(entry.metaUri, JSON.stringify(meta, null, 2));
    index.set(entry.id, entry);
    return entry;
  }

  async function loadMeta(uri: string): Promise<FileMeta | null> {
    try {
      const buf = await storage.readFile(uri);
      const text = typeof buf === 'string' ? buf : buf.toString('utf-8');
      return JSON.parse(text) as FileMeta;
    } catch (err) {
      ctx.logger.debug(`加载 meta 失败 ${uri}:`, err);
      return null;
    }
  }

  /** 启动时从磁盘恢复 index */
  async function restoreIndex(): Promise<void> {
    try {
      const rootList = await storage.list(ROOT_URI).catch(() => null);
      if (!rootList) return;
      let restored = 0;
      for (const sessionDir of rootList.entries) {
        if (!sessionDir.isDirectory) continue;
        const list = await storage.list(sessionDir.uri).catch(() => null);
        if (!list) continue;
        for (const e of list.entries) {
          if (!e.name.endsWith('.meta.json')) continue;
          const meta = await loadMeta(e.uri);
          if (!meta) continue;
          const ext = path.extname(meta.name) || '';
          index.set(meta.id, {
            ...meta,
            dataUri: dataUri(meta.sessionId, meta.id, ext),
            metaUri: e.uri,
          });
          restored++;
        }
      }
      if (restored > 0) ctx.logger.info(`已从磁盘恢复 ${restored} 个上传文件`);
    } catch (err) {
      ctx.logger.warn('恢复文件索引失败:', err);
    }
  }

  /** sha256(content) 前 16 hex → 内容寻址，重传同一文件秒命中 */
  function hashId(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  }

  function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  function inferMimeType(fileName: string, providedMime?: string): string {
    if (providedMime && providedMime !== 'application/octet-stream') return providedMime;
    const ext = fileName.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && EXT_MIME_MAP[ext]) return EXT_MIME_MAP[ext];
    return providedMime || 'application/octet-stream';
  }

  // ===== 文本提取 =====

  async function extractTextFromBuffer(data: Buffer, mime: string): Promise<string> {
    if (TEXT_MIME_TYPES.has(mime) || mime.startsWith('text/')) {
      return data.toString('utf-8');
    }
    if (mime === 'application/pdf') return extractPdf(data);
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return extractDocx(data);
    }
    if (mime === 'application/msword') return '[不支持旧版 .doc 格式，请转换为 .docx 后重新上传]';
    return `[不支持的文件格式: ${mime}]`;
  }

  async function extractText(entry: FileEntry): Promise<string> {
    if (entry.textCache !== undefined) return entry.textCache;
    let buf: Buffer;
    try {
      const raw = await storage.readFile(entry.dataUri);
      buf = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : raw;
    } catch (err) {
      ctx.logger.warn(`读取文件失败 ${entry.dataUri}:`, err);
      return '[文件读取失败]';
    }
    const text = await extractTextFromBuffer(buf, entry.mimeType);
    // 文本小于 inline 阈值时缓存到 meta，避免每次 PDF/DOCX 都重新解析
    if (text.length <= autoInlineLimit) {
      entry.textCache = text;
      await storage
        .writeFile(entry.metaUri, JSON.stringify({ ...entry, dataUri: undefined, metaUri: undefined }, null, 2))
        .catch((err: unknown) => ctx.logger.debug('更新 textCache 失败:', err));
    }
    return text;
  }

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

  // ===== 存储 / 删除 =====

  async function storeFile(name: string, data: Buffer, mimeType: string, sessionId: string): Promise<FileEntry> {
    const id = hashId(data);
    // 已存在则直接复用（同一内容，仅刷新 uploadedAt）
    const existing = index.get(id);
    if (existing && existing.sessionId === sessionId) {
      existing.uploadedAt = Date.now();
      await storage
        .writeFile(existing.metaUri, JSON.stringify({ ...existing, dataUri: undefined, metaUri: undefined }, null, 2))
        .catch((err: unknown) => ctx.logger.debug('刷新 mtime 失败:', err));
      return existing;
    }
    const meta: FileMeta = {
      id,
      name,
      mimeType,
      size: data.length,
      sessionId,
      uploadedAt: Date.now(),
    };
    const ext = path.extname(name) || '';
    const targetUri = dataUri(sessionId, id, ext);
    await storage.writeFile(targetUri, data);
    return persistMeta(meta);
  }

  async function deleteFile(fileId: string): Promise<boolean> {
    const entry = index.get(fileId);
    if (!entry) return false;
    try {
      await storage.delete(entry.dataUri).catch((err: unknown) => ctx.logger.debug('删除数据文件失败:', err));
      await storage.delete(entry.metaUri).catch((err: unknown) => ctx.logger.debug('删除 meta 失败:', err));
    } finally {
      index.delete(fileId);
    }
    return true;
  }

  async function deleteSessionFiles(sessionId: string): Promise<number> {
    const targets = [...index.values()].filter(e => e.sessionId === sessionId);
    for (const e of targets) await deleteFile(e.id);
    // 顺带把空目录删掉（list 可能为空，storage.delete 对空目录通常 OK；失败忽略）
    await storage.delete(`${ROOT_URI}/${sessionId}`).catch(() => undefined);
    return targets.length;
  }

  // ===== retention / LRU 清理 =====

  async function runCleanup(): Promise<void> {
    const now = Date.now();
    const all = [...index.values()].sort((a, b) => a.uploadedAt - b.uploadedAt); // 由旧到新

    // 1. 按保留天数清理
    if (retentionDays > 0) {
      const cutoff = now - retentionDays * 86_400_000;
      for (const e of all) {
        if (e.uploadedAt < cutoff) {
          ctx.logger.debug(`retention 淘汰: ${e.name} (uploaded ${new Date(e.uploadedAt).toISOString()})`);
          await deleteFile(e.id);
        }
      }
    }
    // 2. 按总量 LRU 淘汰（再次扫，从 index 里取剩余）
    if (lruMaxTotalBytes > 0) {
      const remaining = [...index.values()].sort((a, b) => a.uploadedAt - b.uploadedAt);
      let total = remaining.reduce((s, e) => s + e.size, 0);
      for (const e of remaining) {
        if (total <= lruMaxTotalBytes) break;
        ctx.logger.debug(
          `LRU 淘汰: ${e.name} (${(e.size / 1024).toFixed(1)} KB, total=${(total / 1024 / 1024).toFixed(1)}MB)`,
        );
        await deleteFile(e.id);
        total -= e.size;
      }
    }
  }

  // ===== 死链兜底：从 memory 历史里反查同 fileId 的工具调用结果 =====

  async function findCachedToolResult(fileId: string, sessionId?: string): Promise<string | null> {
    if (!sessionId) return null;
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getHistory) return null;
    try {
      const history = await memory.getHistory(sessionId, 200);
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role !== 'tool') continue;
        const content = typeof m.content === 'string' ? m.content : '';
        // 兜底匹配：tool result 文本里包含该 fileId 且形如本插件输出（含"文件:"+"--- 内容 ---"）
        if (content.includes(fileId) && content.includes('--- 内容 ---')) {
          return content;
        }
      }
    } catch (err) {
      ctx.logger.debug('memory 反查失败:', err);
    }
    return null;
  }

  // ===== 初始化阶段：恢复索引 + 起一次清理 =====

  await restoreIndex();
  await runCleanup().catch((err: unknown) => ctx.logger.warn('初次清理失败:', err));

  const cleanupTimer = setInterval(
    () => {
      runCleanup().catch((err: unknown) => ctx.logger.warn('定时清理失败:', err));
    },
    60 * 60 * 1000, // 每小时跑一次
  );

  ctx.onDispose(() => {
    clearInterval(cleanupTimer);
    index.clear();
  });

  // session 删除时联动清理该 session 的所有文件
  ctx.on('session:deleted', async (...args: unknown[]) => {
    const sessionId = args[0] as string;
    const n = await deleteSessionFiles(sessionId).catch(() => 0);
    if (n > 0) ctx.logger.info(`session:deleted ${sessionId} → 已清理 ${n} 个上传文件`);
  });

  // ===== 工具注册 =====

  const baseTools = useToolService(ctx);
  baseTools.registerGroup({
    name: 'file-reader',
    label: '文件读取',
    description: '读取用户上传的文档文件（TXT、PDF、DOCX 等）的文本内容',
  });
  const toolTools = toolsWithGroups(baseTools, ['file-reader']);

  toolTools.register({
    definition: {
      type: 'function',
      function: {
        name: TOOL_READ,
        description:
          '读取用户上传的文件内容。支持 TXT/MD/CSV/JSON/XML/PDF/DOCX 等常见格式。' +
          '当用户上传文件并提到需要分析/阅读/总结文件内容时调用此工具。' +
          '参数 fileId 在用户上传文件时会包含在消息中（格式为 [文件: 文件名 (ID: xxx)]）。' +
          '注意：若附件描述中已经直接给出"--- 文件内容 ---"全文，则不需要再调用本工具——你已经看到全文。',
        parameters: {
          type: 'object',
          properties: {
            fileId: {
              type: 'string',
              description: '文件唯一标识符，从用户消息中的 [文件: ... (ID: xxx)] 获取',
            },
            maxLength: {
              type: 'number',
              description: `返回文本的最大字符数。不传时默认 ${toolDefaultMaxLength}，避免一次喂入超长内容爆 token。`,
            },
          },
          required: ['fileId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string> => {
      const fileId = args.fileId as string;
      const maxLength = (args.maxLength as number | undefined) ?? toolDefaultMaxLength;
      const entry = index.get(fileId);
      if (!entry) {
        // 死链兜底：查 memory 是否有该 fileId 的旧 tool result
        const cached = await findCachedToolResult(fileId, callCtx.sessionId);
        if (cached) {
          ctx.logger.debug(`fileId=${fileId} 在 index 中缺失，已用历史 tool result 兜底`);
          if (maxLength && cached.length > maxLength) {
            return `${cached.slice(0, maxLength)}\n\n... [文本已截断，原始长度: ${cached.length} 字符]`;
          }
          return cached;
        }
        return `错误：找不到文件 (ID: ${fileId})。文件可能已被删除。请用 list_uploaded_files 查看当前可用文件。`;
      }
      try {
        let text = await extractText(entry);
        if (maxLength && text.length > maxLength) {
          text = `${text.slice(0, maxLength)}\n\n... [文本已截断，原始长度: ${text.length} 字符；可通过 maxLength 参数请求更多]`;
        }
        return `文件: ${entry.name}\n类型: ${entry.mimeType}\n大小: ${(entry.size / 1024).toFixed(1)} KB\n\n--- 内容 ---\n${text}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`文件读取失败 (${entry.name}):`, msg);
        return `错误：读取文件 "${entry.name}" 失败: ${msg}`;
      }
    },
  });

  toolTools.register({
    definition: {
      type: 'function',
      function: {
        name: TOOL_LIST,
        description: '列出当前会话中用户上传的所有文件。返回文件列表（含 ID、文件名、类型、大小、上传时间）。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '会话 ID（可选，默认列出当前会话；显式传 "*" 列出所有会话）',
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string> => {
      const sidArg = args.sessionId as string | undefined;
      const sid = sidArg === '*' ? undefined : (sidArg ?? callCtx.sessionId);
      const files = [...index.values()].filter(f => !sid || f.sessionId === sid);
      if (files.length === 0) return '当前没有已上传的文件。';
      const lines = files
        .sort((a, b) => b.uploadedAt - a.uploadedAt)
        .map(
          f =>
            `- ${f.name} (ID: ${f.id}, 类型: ${f.mimeType}, 大小: ${(f.size / 1024).toFixed(1)} KB, 上传于 ${new Date(f.uploadedAt).toLocaleString()})`,
        );
      return `已上传的文件 (${files.length} 个):\n${lines.join('\n')}`;
    },
  });

  toolTools.register({
    definition: {
      type: 'function',
      function: {
        name: TOOL_DELETE,
        description:
          '删除一个之前上传的文件（同时清理元数据与磁盘文件）。' +
          '⚠️ 危险操作：仅在用户明确要求删除文件时调用，否则保留。',
        parameters: {
          type: 'object',
          properties: {
            fileId: {
              type: 'string',
              description: '要删除的文件 ID',
            },
          },
          required: ['fileId'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const fileId = args.fileId as string;
      const entry = index.get(fileId);
      if (!entry) return `文件不存在或已被删除 (ID: ${fileId})。`;
      const ok = await deleteFile(fileId);
      return ok ? `已删除文件: ${entry.name} (ID: ${fileId})` : `删除失败 (ID: ${fileId})`;
    },
    safety: 'dangerous',
  });

  // ===== 附件预处理 =====

  async function preprocessFiles(msg: IncomingMessage, next: () => Promise<void>): Promise<void> {
    if (!msg.attachments || msg.attachments.length === 0) {
      await next();
      return;
    }
    const attDescs: (string | undefined)[] = msg._attachmentDescriptions ? [...msg._attachmentDescriptions] : [];
    while (attDescs.length < msg.attachments.length) attDescs.push(undefined);

    let touched = false;
    for (let i = 0; i < msg.attachments.length; i++) {
      const att = msg.attachments[i];
      if (att.kind !== 'file') continue;
      const fileName = att.name ?? `file-${i}`;
      try {
        // 复用已存的：data 字段若是 aalis-file:// 引用，则直接拿 index 里的条目
        if (att.data.startsWith('aalis-file://')) {
          const id = att.data.slice('aalis-file://'.length);
          const entry = index.get(id);
          if (entry) {
            attDescs[i] = await buildAttachmentDesc(entry);
            touched = true;
            continue;
          }
        }

        const { buffer, mimeType: dataMime } = dataUrlToBuffer(att.data);
        const resolvedMime = att.mimeType || dataMime;

        if (buffer.length > maxFileSize) {
          attDescs[i] =
            `[文件: ${fileName} - 超过大小限制 (${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${(maxFileSize / 1024 / 1024).toFixed(0)}MB)]`;
          touched = true;
          continue;
        }

        const mimeType = inferMimeType(fileName, resolvedMime);
        const entry = await storeFile(fileName, buffer, mimeType, msg.sessionId);
        ctx.logger.debug(`文件已存储: ${entry.name} (ID: ${entry.id}, ${(buffer.length / 1024).toFixed(1)} KB)`);

        attDescs[i] = await buildAttachmentDesc(entry);
        // 替换原始 data 为 ID 引用，避免下游链路重复携带大 buffer
        msg.attachments[i] = { ...att, data: `aalis-file://${entry.id}` };
        touched = true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`文件处理失败 (${fileName}):`, errMsg);
        attDescs[i] = `[文件: ${fileName} - 处理失败]`;
        touched = true;
      }
    }

    if (touched) msg._attachmentDescriptions = attDescs;
    await next();
  }

  /** 根据 entry 生成给 LLM 的附件描述：
   *   - 小文件（≤ autoInlineLimit）：直接 inline 全文，**不暴露 ID** —— 避免模型多此一举调工具
   *   - 大文件：只给文件名/类型 + ID，提示用 read_uploaded_file 拉取
   */
  async function buildAttachmentDesc(entry: FileEntry): Promise<string> {
    try {
      const text = await extractText(entry);
      if (!text.startsWith('[不支持') && !text.startsWith('[PDF 无') && text.length <= autoInlineLimit) {
        return `[文件: ${entry.name}]\n--- 文件内容 ---\n${text}\n--- 文件内容结束 ---`;
      }
      return `[文件: ${entry.name} (ID: ${entry.id}，${(entry.size / 1024).toFixed(1)} KB)\n说明：内容较长，请用 ${TOOL_READ}(fileId="${entry.id}") 工具按需读取，可传 maxLength 控制返回长度。]`;
    } catch {
      return `[文件: ${entry.name} (ID: ${entry.id})]`;
    }
  }

  // ===== 注册到 agent =====

  const agent = ctx.getService<AgentService>('agent');
  if (agent && !agent.registerPreprocessor) {
    ctx.middleware('agent:input:before', async (data, next) => {
      await preprocessFiles(data.message, next);
    });
  } else {
    useAgent(ctx).registerPreprocessor('file-reader', preprocessFiles);
  }

  // ===== 暴露 file-reader 服务 =====

  ctx.provide('file-reader', {
    available: true,
    /** 给 webui-server / 其他插件查文件清单用 */
    listFiles(sessionId?: string): FileMeta[] {
      return [...index.values()]
        .filter(e => !sessionId || e.sessionId === sessionId)
        .map(({ dataUri: _du, metaUri: _mu, ...meta }) => meta)
        .sort((a, b) => b.uploadedAt - a.uploadedAt);
    },
    /** 拿到文件本地路径（webui 下载端用） */
    async resolveLocalPath(fileId: string): Promise<string | null> {
      const entry = index.get(fileId);
      if (!entry) return null;
      if (!storage.resolveLocalPath) return null;
      return storage.resolveLocalPath(entry.dataUri, 'read');
    },
    getMeta(fileId: string): FileMeta | null {
      const e = index.get(fileId);
      if (!e) return null;
      const { dataUri: _du, metaUri: _mu, ...meta } = e;
      return meta;
    },
    deleteFile,
  });

  ctx.logger.info(
    `文件读取插件已加载 (最大 ${(maxFileSize / 1024 / 1024).toFixed(0)}MB, autoInline=${autoInlineLimit} 字符, 保留 ${retentionDays} 天, LRU=${(lruMaxTotalBytes / 1024 / 1024).toFixed(0)}MB, 已恢复 ${index.size} 个文件)`,
  );
}
