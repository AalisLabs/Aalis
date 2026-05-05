/**
 * 文件操作工具组
 *
 * 文件工具统一通过 storage 服务访问受控根目录：
 * - storage URI: workspace:/path/to/file、tmp:/run/a.txt
 * - 普通相对路径会被解释为 workspace:/...
 * - 绝对路径被拒绝，避免直接触达宿主文件系统
 */

import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { Context, StorageService } from '@aalis/core';

interface FileConfig {
  maxReadSize: number;
  maxSearchBytes: number;
  maxWriteSize: number;
  allowedRoots: string[];
  defaultRoot: string;
  storage?: StorageService;
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '');
}

function toStorageUri(input: string | undefined, config: FileConfig): string {
  const raw = (input || '').trim();
  if (!raw || raw === '.') return `${config.defaultRoot}:/`;
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error('文件工具不允许使用宿主绝对路径，请使用 workspace:/path 或相对 workspace 的路径');
  }
  if (raw.includes(':/')) return raw;
  return `${config.defaultRoot}:/${normalizePath(raw)}`;
}

function rootOf(uri: string): string {
  const idx = uri.indexOf(':/');
  if (idx <= 0) throw new Error(`存储 URI 不合法: ${uri}`);
  return uri.slice(0, idx);
}

function ensureRootAllowed(uri: string, config: FileConfig): void {
  const root = rootOf(uri);
  if (!config.allowedRoots.includes(root)) {
    throw new Error(`文件工具不允许访问 ${root}:/。当前允许: ${config.allowedRoots.join(', ')}`);
  }
}

function storagePermission(args: Record<string, unknown>, config: FileConfig, op: 'read' | 'write' | 'delete'): string[] {
  const uri = toStorageUri(args.path as string | undefined, config);
  const root = rootOf(uri);
  return [`storage:${op}`, `storage:${root}:${op}`];
}

function requireStorage(config: FileConfig): StorageService {
  if (!config.storage) throw new Error('storage 服务不可用，文件工具已进入安全停用状态');
  return config.storage;
}

async function readText(storage: StorageService, uri: string): Promise<string> {
  const data = await storage.readFile(uri, 'utf-8');
  return typeof data === 'string' ? data : data.toString('utf-8');
}

function jsonError(err: unknown): string {
  return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchTextStream(
  storage: StorageService,
  uri: string,
  regex: RegExp,
  startLine: number,
  maxResults: number,
  maxSearchBytes: number,
): Promise<{
  matches: Array<{ line: number; content: string }>;
  scannedBytes: number;
  scannedLines: number;
  truncated: boolean;
  nextStartLine?: number;
}> {
  const { stream } = await storage.createReadStream(uri);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const matches: Array<{ line: number; content: string }> = [];
  let lineNumber = 0;
  let scannedBytes = 0;
  let scannedLines = 0;
  let truncated = false;

  try {
    for await (const line of lines) {
      lineNumber++;
      if (lineNumber < startLine) continue;

      scannedLines++;
      scannedBytes += Buffer.byteLength(line, 'utf-8') + 1;
      if (regex.test(line)) matches.push({ line: lineNumber, content: line });

      if (matches.length >= maxResults || scannedBytes >= maxSearchBytes) {
        truncated = true;
        stream.destroy();
        break;
      }
    }
  } finally {
    lines.close();
  }

  return {
    matches,
    scannedBytes,
    scannedLines,
    truncated,
    ...(truncated ? { nextStartLine: lineNumber + 1 } : {}),
  };
}

export function registerFileTools(ctx: Context, config: FileConfig): void {

  // ==================== file_read ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_read',
        description:
          '读取受控存储中的文件。路径使用 workspace:/path、tmp:/path，或相对 workspace 的路径。' +
          '不允许读取宿主绝对路径。支持指定行范围读取大文件的部分内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对 workspace 的文件路径' },
            startLine: { type: 'number', description: '起始行号（从 1 开始，可选）' },
            endLine: { type: 'number', description: '结束行号（包含，可选）' },
            encoding: { type: 'string', description: '编码方式（可选，默认 utf-8；base64 读取二进制）' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.read', 'storage:read'],
    resolvePermissions: (args) => storagePermission(args, config, 'read'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        if (info.isDirectory) return JSON.stringify({ error: '路径是一个目录，请使用 file_list' });
        if (info.size > config.maxReadSize) {
          return JSON.stringify({
            error: `文件过大 (${info.size} 字节)，超过限制 ${config.maxReadSize} 字节。请使用 startLine/endLine 参数读取部分内容。`,
            size: info.size,
            uri,
          });
        }

        if ((args.encoding as string | undefined) === 'base64') {
          const buffer = await storage.readFile(uri);
          const content = Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
          return JSON.stringify({ uri, encoding: 'base64', size: info.size, content });
        }

        const content = await readText(storage, uri);
        const lines = content.split('\n');
        const totalLines = lines.length;
        const startLine = (args.startLine as number) || 1;
        const endLine = (args.endLine as number) || totalLines;
        const start = Math.max(1, startLine) - 1;
        const end = Math.min(totalLines, endLine);
        const selectedLines = lines.slice(start, end)
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join('\n');

        return JSON.stringify({
          uri,
          totalLines,
          startLine: start + 1,
          endLine: end,
          content: selectedLines,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_write ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_write',
        description: '在受控存储中创建或覆盖文件。危险操作：会完全覆盖已有文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对 workspace 的文件路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    authority: 3,
    safety: 'dangerous',
    permissions: ['tool:file.write', 'storage:write'],
    resolvePermissions: (args) => storagePermission(args, config, 'write'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        const content = args.content as string;
        if (Buffer.byteLength(content, 'utf-8') > config.maxWriteSize) {
          return JSON.stringify({ error: `内容过大，超过限制 ${config.maxWriteSize} 字节` });
        }
        await storage.writeFile(uri, content);
        const info = await storage.stat(uri);
        return JSON.stringify({ uri, size: info.size, message: '文件写入成功' });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_edit ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_edit',
        description: '通过唯一精确字符串替换编辑受控存储中的文件。危险操作：会修改文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对 workspace 的文件路径' },
            oldText: { type: 'string', description: '要被替换的原始文本（必须唯一精确匹配）' },
            newText: { type: 'string', description: '替换后的新文本' },
          },
          required: ['path', 'oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    authority: 3,
    safety: 'dangerous',
    permissions: ['tool:file.edit', 'storage:write'],
    resolvePermissions: (args) => storagePermission(args, config, 'write'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        const oldText = args.oldText as string;
        const newText = args.newText as string;
        if (!oldText) return JSON.stringify({ error: 'oldText 不能为空' });

        const raw = await readText(storage, uri);
        const content = raw.replace(/\r\n/g, '\n');
        const normalizedOld = oldText.replace(/\r\n/g, '\n');
        const firstIndex = content.indexOf(normalizedOld);
        if (firstIndex === -1) {
          return JSON.stringify({ error: '在文件中未找到 oldText。请确保文本精确匹配（包括空格和缩进）。' });
        }
        const secondIndex = content.indexOf(normalizedOld, firstIndex + normalizedOld.length);
        if (secondIndex !== -1) {
          return JSON.stringify({
            error: 'oldText 在文件中有多处匹配。请提供更多上下文以确保唯一匹配。',
            matchCount: content.split(normalizedOld).length - 1,
          });
        }

        const newContent = content.replace(normalizedOld, newText);
        if (Buffer.byteLength(newContent, 'utf-8') > config.maxWriteSize) {
          return JSON.stringify({ error: `编辑后内容过大，超过限制 ${config.maxWriteSize} 字节` });
        }
        await storage.writeFile(uri, newContent);

        const newIndex = newContent.indexOf(newText);
        const before = newContent.slice(0, newIndex).split('\n');
        const editLines = newText.split('\n');
        return JSON.stringify({
          uri,
          message: '编辑成功',
          editedLines: { start: before.length, count: editLines.length },
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_append ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_append',
        description: '向受控存储中的文件末尾追加内容。危险操作：会修改文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对 workspace 的文件路径' },
            content: { type: 'string', description: '要追加的内容' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    authority: 3,
    safety: 'dangerous',
    permissions: ['tool:file.append', 'storage:write'],
    resolvePermissions: (args) => storagePermission(args, config, 'write'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        const appendContent = args.content as string;
        let existing = '';
        try {
          existing = await readText(storage, uri);
        } catch {
          existing = '';
        }
        const content = existing + appendContent;
        if (Buffer.byteLength(content, 'utf-8') > config.maxWriteSize) {
          return JSON.stringify({ error: `追加后内容过大，超过限制 ${config.maxWriteSize} 字节` });
        }
        await storage.writeFile(uri, content);
        const info = await storage.stat(uri);
        return JSON.stringify({ uri, size: info.size, message: '内容追加成功' });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_delete ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_delete',
        description: '删除受控存储中的文件或目录。危险操作：目录会递归删除。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对 workspace 的文件/目录路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    authority: 3,
    safety: 'dangerous',
    permissions: ['tool:file.delete', 'storage:delete'],
    resolvePermissions: (args) => storagePermission(args, config, 'delete'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        await storage.delete(uri);
        return JSON.stringify({ uri, message: '删除成功' });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_list ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_list',
        description: '列出受控存储目录中的文件和子目录，支持关键词过滤、类型过滤与分页。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目录 storage URI 或相对 workspace 的路径，默认 workspace:/' },
            showHidden: { type: 'boolean', description: '是否显示隐藏文件（默认 false）' },
            keyword: { type: 'string', description: '按名称子串模糊匹配（不区分大小写）' },
            type: { type: 'string', enum: ['file', 'directory'], description: '只返回指定类型' },
            page: { type: 'number', description: '页码，从 1 开始，默认 1' },
            pageSize: { type: 'number', description: '每页条数，默认 50' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.list', 'storage:read'],
    resolvePermissions: (args) => storagePermission(args, config, 'read'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string | undefined, config);
        ensureRootAllowed(uri, config);
        const result = await storage.list(uri);
        const showHidden = (args.showHidden as boolean) ?? false;
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
        const typeFilter = typeof args.type === 'string' ? args.type : '';
        const filtered = result.entries.filter(entry => {
          if (!showHidden && entry.name.startsWith('.')) return false;
          if (typeFilter === 'file' && entry.isDirectory) return false;
          if (typeFilter === 'directory' && !entry.isDirectory) return false;
          if (keyword && !entry.name.toLowerCase().includes(keyword)) return false;
          return true;
        });
        const page = Math.max(1, Math.floor(Number(args.page) || 1));
        const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 50));
        const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
        const curPage = Math.min(page, totalPages);
        const start = (curPage - 1) * pageSize;
        const pageItems = filtered.slice(start, start + pageSize).map(entry => ({
          name: entry.name,
          uri: entry.uri,
          path: entry.path,
          type: entry.isDirectory ? 'directory' : 'file',
          size: entry.isDirectory ? undefined : entry.size,
          modified: entry.mtime,
        }));

        return JSON.stringify({
          uri,
          root: result.root.name,
          path: result.path,
          total: result.entries.length,
          matched: filtered.length,
          page: curPage,
          pageSize,
          totalPages,
          hasMore: curPage < totalPages,
          ...(keyword ? { keyword } : {}),
          ...(typeFilter ? { type: typeFilter } : {}),
          entries: pageItems,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_info ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_info',
        description: '获取受控存储中文件或目录的元信息。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对 workspace 的路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.info', 'storage:read'],
    resolvePermissions: (args) => storagePermission(args, config, 'read'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        return JSON.stringify({
          uri,
          path: info.path,
          type: info.isDirectory ? 'directory' : 'file',
          size: info.size,
          created: info.birthtime,
          modified: info.mtime,
          extension: info.ext,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_search ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_search',
        description: '在受控存储文件中搜索匹配文本行。支持正则表达式和大小写控制。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要搜索的文件 storage URI 或相对 workspace 的路径' },
            pattern: { type: 'string', description: '搜索模式（纯文本或正则表达式）' },
            isRegex: { type: 'boolean', description: '模式是否为正则表达式（默认 false）' },
            ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认 true）' },
            startLine: { type: 'number', description: '从第几行开始搜索（默认 1，用于继续上次截断搜索）' },
            maxResults: { type: 'number', description: '最大返回结果数（默认 50，最多 200）' },
            maxSearchBytes: { type: 'number', description: `单次最多扫描字节数（默认/上限 ${config.maxSearchBytes}）` },
          },
          required: ['path', 'pattern'],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.search', 'storage:read'],
    resolvePermissions: (args) => storagePermission(args, config, 'read'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        if (info.isDirectory) return JSON.stringify({ error: '路径是一个目录，请指定文件路径' });
        const pattern = args.pattern as string;
        const ignoreCase = (args.ignoreCase as boolean) ?? true;
        const maxResults = Math.min((args.maxResults as number) || 50, 200);
        const startLine = Math.max(1, Math.floor(Number(args.startLine) || 1));
        const maxSearchBytes = Math.min(
          Math.max(1024, Math.floor(Number(args.maxSearchBytes) || config.maxSearchBytes)),
          config.maxSearchBytes,
        );
        const regex = (args.isRegex as boolean) ?? false
          ? new RegExp(pattern, ignoreCase ? 'i' : '')
          : new RegExp(escapeRegExp(pattern), ignoreCase ? 'i' : '');

        const result = await searchTextStream(storage, uri, regex, startLine, maxResults, maxSearchBytes);
        return JSON.stringify({
          uri,
          pattern,
          fileSize: info.size,
          startLine,
          maxSearchBytes,
          matches: result.matches,
          matchCount: result.matches.length,
          scannedBytes: result.scannedBytes,
          scannedLines: result.scannedLines,
          truncated: result.truncated,
          ...(result.nextStartLine ? { nextStartLine: result.nextStartLine } : {}),
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_tree ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_tree',
        description: '递归显示受控存储目录树。用于快速了解 workspace/tmp 等安全根的布局。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '根目录 storage URI 或相对 workspace 的路径，默认 workspace:/' },
            maxDepth: { type: 'number', description: '最大递归深度（默认 3，最多 10）' },
            showHidden: { type: 'boolean', description: '是否显示隐藏文件（默认 false）' },
            pattern: { type: 'string', description: '文件名过滤模式（简单 glob: *.ts, *.py 等）' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.tree', 'storage:read'],
    resolvePermissions: (args) => storagePermission(args, config, 'read'),
    handler: async (args) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string | undefined, config);
        ensureRootAllowed(uri, config);
        const maxDepth = Math.min((args.maxDepth as number) || 3, 10);
        const showHidden = (args.showHidden as boolean) ?? false;
        const pattern = args.pattern as string | undefined;
        const lines: string[] = [`${basename(uri) || rootOf(uri) + ':/'}`];
        let totalFiles = 0;
        let totalDirs = 0;

        async function walk(currentUri: string, prefix: string, depth: number): Promise<void> {
          if (depth > maxDepth) return;
          const result = await storage.list(currentUri).catch(() => null);
          if (!result) return;
          const entries = result.entries
            .filter(entry => showHidden || !entry.name.startsWith('.'))
            .filter(entry => entry.isDirectory || !pattern || matchGlob(entry.name, pattern))
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            if (entry.isDirectory) {
              totalDirs++;
              lines.push(`${prefix}${connector}${entry.name}/`);
              await walk(entry.uri, childPrefix, depth + 1);
            } else {
              totalFiles++;
              lines.push(`${prefix}${connector}${entry.name}`);
            }
          }
        }

        await walk(uri, '', 1);
        return JSON.stringify({ uri, tree: lines.join('\n'), summary: `${totalDirs} 个目录，${totalFiles} 个文件` });
      } catch (err) {
        return jsonError(err);
      }
    },
  });
}

function matchGlob(name: string, pattern: string): boolean {
  const regexStr = escapeRegExp(pattern)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(name);
}
