/**
 * 文件操作工具组
 *
 * 路径语义（与 shell 一致的 unix 心智模型）：
 * - 完整 storage URI：如 `aalis:/packages/core`、`workspace:/notes/a.md`、`tmp:/x`
 * - 相对路径：如 `packages/core`、`./a.ts`、`../plugin-tools` —— 永远基于
 *   当前 session 的 cwd 解析（由 cwd / cd 工具查询/切换）
 * - 宿主机绝对路径（如 `/Users/...`、`C:\...`）一律拒绝
 *
 * 设计动机：LLM agent 在多轮对话中经常需要"在 X 目录下查看一系列文件"，
 * 如果每次都要写完整 URI 负担大且易错；有了 cwd + 相对路径后类似人在 shell 里。
 */

import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import type { CwdState } from './cwd-state.js';
import { resolveAgainstCwd, rootOf } from './path-resolve.js';

interface FileConfig {
  maxReadSize: number;
  maxSearchBytes: number;
  maxWriteSize: number;
  allowedRoots: string[];
  /** 共享的 cwd 状态（与 cwd/cd 工具同源），决定相对路径的解析基准 */
  cwdState: CwdState;
  storage?: StorageService;
}

function getKnownRoots(config: FileConfig) {
  return config.storage?.listRoots() ?? [];
}

const ALL_ROOTS = '*';

function getAllowedRoots(config: FileConfig): string[] {
  if (config.allowedRoots.includes(ALL_ROOTS)) {
    return getKnownRoots(config)
      .filter(r => r.readable)
      .map(r => r.name);
  }
  return config.allowedRoots;
}

function allowedRootsText(config: FileConfig): string {
  const allowed = getAllowedRoots(config);
  return allowed.length ? allowed.join(', ') : '(无)';
}

/**
 * 把用户输入解析为完整 storage URI。
 *
 * 仅是 resolveAgainstCwd 的薄包装：从 cwdState 读取当前 session 的 cwd 作为基准。
 * 宿主机绝对路径的拒绝提示被加强为附带当前可用根信息，避免反复试错。
 */
function toStorageUri(input: string | undefined, config: FileConfig, sessionId: string | undefined): string {
  const cwd = config.cwdState.get(sessionId);
  try {
    return resolveAgainstCwd(input, cwd);
  } catch (err) {
    // 只在宿主绝对路径分支补充可读根提示。其余错误原样抛出。
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('宿主机绝对路径')) {
      const known =
        getKnownRoots(config)
          .map(r => r.name)
          .join(', ') || '(无)';
      throw new Error(`${message} 当前 cwd: ${cwd}。已注册根: ${known}。本工具允许根: ${allowedRootsText(config)}。`);
    }
    throw err;
  }
}

function ensureRootAllowed(uri: string, config: FileConfig): void {
  const root = rootOf(uri);
  if (!getAllowedRoots(config).includes(root)) {
    const known = getKnownRoots(config).map(r => r.name);
    const unknown = !known.includes(root);
    throw new Error(
      unknown
        ? `根 "${root}" 不存在。当前已注册根: ${known.join(', ') || '(无)'}；本工具允许: ${allowedRootsText(config)}`
        : `本工具不允许访问 ${root}:/。允许的根: ${allowedRootsText(config)}（如需放开，改 file.allowedRoots 配置；可设为 ["*"] 允许全部可读根）`,
    );
  }
}

function storagePermission(
  args: Record<string, unknown>,
  config: FileConfig,
  ctx: { sessionId: string } | undefined,
  op: 'read' | 'write' | 'delete',
): string[] {
  const uri = toStorageUri(args.path as string | undefined, config, ctx?.sessionId);
  const root = rootOf(uri);
  // 额外产出路径级权限标识，供 authority 按具体文件动态提权（如 data:/users.json）。
  return [`storage:${op}`, `storage:${root}:${op}`, `storage:path:${uri}:${op}`];
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

/**
 * 默认排除目录：扫描树时几乎从不需要进入的"噪声目录"。
 *
 * 设计动机：file_search/file_tree 走的是字典序深度优先 walk，扫到第一个含
 * node_modules 的子目录就可能把 maxSearchBytes 预算耗光，导致 `truncated: true`
 * 而真正想找的源码一行都没扫到。把这些目录默认排除是工业标准（VS Code grep、
 * ripgrep、ag 等都默认排除）。用户传 `exclude: []` 可关闭全部默认。
 */
const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/__pycache__/**',
];

/**
 * 把简单 glob 模式（支持 `**` / `*` / `?`）编译为路径级正则。
 *
 * - `**\/` → 任意层级前缀（含零层），所以 `**\/node_modules/**` 同时匹配
 *   `node_modules/x` 和 `a/b/node_modules/x`
 * - `/**` → 任意层级后缀（含零层）
 * - `**`  → 任意多段（含 `/`）
 * - `*`   → 单段内任意字符（不含 `/`）
 * - `?`   → 单段内一个字符（不含 `/`）
 *
 * 匹配的是相对扫描根的"路径"。
 */
function compileGlob(pattern: string): RegExp {
  // 使用控制字符做占位，避免与后续 *, ?, 正则元字符转义冲突
  const STAR2_SLASH = '\u0001';
  const SLASH_STAR2 = '\u0002';
  const STAR2 = '\u0003';
  let p = pattern;
  p = p.replace(/\*\*\//g, STAR2_SLASH);
  p = p.replace(/\/\*\*/g, SLASH_STAR2);
  p = p.replace(/\*\*/g, STAR2);
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/\?/g, '[^/]');
  p = p.split(STAR2_SLASH).join('(?:.*/)?');
  p = p.split(SLASH_STAR2).join('(?:/.*)?');
  p = p.split(STAR2).join('.*');
  return new RegExp(`^${p}$`);
}

function matchAnyGlob(relPath: string, patterns: readonly RegExp[]): boolean {
  for (const re of patterns) if (re.test(relPath)) return true;
  return false;
}

function resolveExcludePatterns(arg: unknown): RegExp[] {
  if (arg === undefined || arg === null) return DEFAULT_EXCLUDE_PATTERNS.map(compileGlob);
  if (!Array.isArray(arg)) return DEFAULT_EXCLUDE_PATTERNS.map(compileGlob);
  // 显式传空数组 → 关闭全部默认；其它情况只用用户值
  return (arg as unknown[]).filter((x): x is string => typeof x === 'string').map(compileGlob);
}

function resolveIncludePatterns(arg: unknown): RegExp[] | undefined {
  if (!Array.isArray(arg)) return undefined;
  const list = (arg as unknown[]).filter((x): x is string => typeof x === 'string');
  return list.length ? list.map(compileGlob) : undefined;
}

/** 从 storage URI 提取相对扫描根的 path（不含协议头与根名） */
function relPathFromRoot(rootUri: string, childUri: string): string {
  // rootUri 形如 "workspace:/packages"，childUri 形如 "workspace:/packages/core/src/foo.ts"
  if (!childUri.startsWith(rootUri)) return childUri;
  let rel = childUri.slice(rootUri.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  return rel;
}

/**
 * 递归收集目录下所有非隐藏的文件 URI（深度优先、字典序稳定）。
 *
 * 用于 file_search 在目录上的批量搜索。失败的子目录会被跳过而不抛出。
 *
 * 关键：**目录级 exclude 在 walk 时早停**，命中的目录及其子树根本不进入，
 * 这才是避免 maxSearchBytes 预算被 node_modules 等噪声目录耗尽的根本手段。
 * 同时对文件维度也应用 exclude/include 做最终过滤。
 */
async function collectFiles(
  storage: StorageService,
  rootUri: string,
  exclude: readonly RegExp[],
  include: readonly RegExp[] | undefined,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(uri: string): Promise<void> {
    const result = await storage.list(uri).catch(() => null);
    if (!result) return;
    const entries = [...result.entries]
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of entries) {
      const rel = relPathFromRoot(rootUri, entry.uri);
      if (entry.isDirectory) {
        if (matchAnyGlob(rel, exclude)) continue;
        await walk(entry.uri);
      } else {
        if (matchAnyGlob(rel, exclude)) continue;
        if (include && !matchAnyGlob(rel, include)) continue;
        out.push(entry.uri);
      }
    }
  }
  await walk(rootUri);
  return out;
}

export function registerFileTools(tools: ScopedToolService, config: FileConfig): void {
  // ==================== file_read ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_read',
        description:
          '读取受控存储中的文件。路径使用完整 storage URI（如 aalis:/packages/core/index.ts），或相对当前 cwd 的路径。' +
          '不允许读取宿主绝对路径。支持指定行范围读取大文件的部分内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
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
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'read'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
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
        const selectedLines = lines
          .slice(start, end)
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_write',
        description: '在受控存储中创建或覆盖文件。危险操作：会完全覆盖已有文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
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
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'write'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_edit',
        description: '通过唯一精确字符串替换编辑受控存储中的文件。危险操作：会修改文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
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
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'write'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_append',
        description: '向受控存储中的文件末尾追加内容。危险操作：会修改文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
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
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'write'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_delete',
        description: '删除受控存储中的文件或目录。危险操作：目录会递归删除。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件/目录路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    authority: 3,
    safety: 'dangerous',
    permissions: ['tool:file.delete', 'storage:delete'],
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'delete'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        await storage.delete(uri);
        return JSON.stringify({ uri, message: '删除成功' });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_list ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_list',
        description:
          '列出受控存储目录中的文件和子目录，支持关键词过滤、类型过滤与分页。' +
          '不传 path 默认列出当前 cwd；要查看有哪些 storage 根，调 cwd 工具获得完整根清单。' +
          '翻页：下次调用传 offset = 上次 offset + limit，直到 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '目录 storage URI（<根名>:/<路径>）或相对当前 cwd 的路径；不传则列当前 cwd',
            },
            showHidden: { type: 'boolean', description: '是否显示隐藏文件（默认 false）' },
            keyword: { type: 'string', description: '按名称子串模糊匹配（不区分大小写）' },
            type: { type: 'string', enum: ['file', 'directory'], description: '只返回指定类型' },
            limit: { type: 'number', description: '本页最多返回条数，默认 50' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.list', 'storage:read'],
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'read'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri((args.path as string | undefined) || undefined, config, callCtx.sessionId);
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
        const limit = Math.max(1, Math.floor(Number(args.limit) || 50));
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const pageItems = filtered.slice(offset, offset + limit).map(entry => ({
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
          limit,
          offset,
          returned: pageItems.length,
          has_more: offset + pageItems.length < filtered.length,
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_info',
        description: '获取受控存储中文件或目录的元信息。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.info', 'storage:read'],
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'read'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_search',
        description:
          '在受控存储中按行搜索匹配文本（内容搜索，非文件名搜索）。path 可为文件，也可为目录（目录将递归搜索所有文件并跨文件累计预算）。支持正则表达式和大小写控制。' +
          '目录搜索默认排除 node_modules / dist / build / .git / coverage / __pycache__ 等噪声目录；传 `exclude` 覆盖默认，或传 `exclude: []` 关闭全部默认。' +
          '如需按文件名/目录名查找，请使用 file_tree 的 pattern 参数。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要搜索的文件或目录的 storage URI 或相对当前 cwd 的路径' },
            pattern: { type: 'string', description: '搜索模式（纯文本或正则表达式）' },
            isRegex: { type: 'boolean', description: '模式是否为正则表达式（默认 false）' },
            ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认 true）' },
            startLine: { type: 'number', description: '从第几行开始搜索（默认 1，用于继续上次截断搜索）' },
            maxResults: { type: 'number', description: '最大返回结果数（默认 50，最多 200）' },
            maxSearchBytes: { type: 'number', description: `单次最多扫描字节数（默认/上限 ${config.maxSearchBytes}）` },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                '路径级 glob 排除模式（支持 ** / * / ?），仅目录搜索生效。例：["**/node_modules/**","**/dist/**"]。' +
                '不传 → 使用默认排除集；传 [] → 关闭默认全量搜索。',
            },
            include: {
              type: 'array',
              items: { type: 'string' },
              description: '路径级 glob 白名单，仅目录搜索生效。例：["**/*.ts","**/*.md"]。',
            },
          },
          required: ['path', 'pattern'],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.search', 'storage:read'],
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'read'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        const pattern = args.pattern as string;
        const ignoreCase = (args.ignoreCase as boolean) ?? true;
        const maxResults = Math.min((args.maxResults as number) || 50, 200);
        const startLine = Math.max(1, Math.floor(Number(args.startLine) || 1));
        const maxSearchBytes = Math.min(
          Math.max(1024, Math.floor(Number(args.maxSearchBytes) || config.maxSearchBytes)),
          config.maxSearchBytes,
        );
        const regex =
          ((args.isRegex as boolean) ?? false)
            ? new RegExp(pattern, ignoreCase ? 'i' : '')
            : new RegExp(escapeRegExp(pattern), ignoreCase ? 'i' : '');
        const excludeProvided = args.exclude !== undefined;
        const excludePatterns = resolveExcludePatterns(args.exclude);
        const includePatterns = resolveIncludePatterns(args.include);

        // 目录：递归收集所有文件并逐个搜索，预算（maxResults / maxSearchBytes）跨文件累加。
        if (info.isDirectory) {
          const files = await collectFiles(storage, uri, excludePatterns, includePatterns);
          const allMatches: Array<{ uri: string; line: number; content: string }> = [];
          let totalScannedBytes = 0;
          let totalScannedLines = 0;
          let scannedFiles = 0;
          let truncated = false;
          let nextStartFile: string | undefined;

          for (const fileUri of files) {
            scannedFiles++;
            const remainingResults = maxResults - allMatches.length;
            const remainingBytes = maxSearchBytes - totalScannedBytes;
            if (remainingResults <= 0 || remainingBytes <= 0) {
              truncated = true;
              nextStartFile = fileUri;
              break;
            }
            const r = await searchTextStream(storage, fileUri, regex, 1, remainingResults, remainingBytes).catch(
              () => null,
            );
            if (!r) continue;
            for (const m of r.matches) allMatches.push({ uri: fileUri, ...m });
            totalScannedBytes += r.scannedBytes;
            totalScannedLines += r.scannedLines;
            if (r.truncated && allMatches.length >= maxResults) {
              truncated = true;
              nextStartFile = fileUri;
              break;
            }
          }

          const advice = truncated
            ? '搜索因预算（maxResults 或 maxSearchBytes）耗尽而中断。请采取以下任一行动再查：' +
              '(1) 用更精确的 path 缩小扫描范围；' +
              '(2) 加 exclude（默认已含 node_modules/dist/.git/build/coverage 等）；' +
              '(3) 用 include 限定文件类型（如 ["**/*.ts","**/*.md"]）；' +
              '(4) 提高 maxResults / maxSearchBytes；' +
              '(5) 用返回的 nextStartFile 作为下次 path 继续。' +
              '**不要根据本次结果断言"找不到"——它可能只是被预算截断了。**'
            : undefined;

          return JSON.stringify({
            uri,
            pattern,
            isDirectory: true,
            totalFiles: files.length,
            scannedFiles,
            matches: allMatches,
            matchCount: allMatches.length,
            scannedBytes: totalScannedBytes,
            scannedLines: totalScannedLines,
            truncated,
            excludeApplied: excludeProvided ? '(user)' : '(default)',
            ...(nextStartFile ? { nextStartFile } : {}),
            ...(advice ? { advice } : {}),
          });
        }

        const result = await searchTextStream(storage, uri, regex, startLine, maxResults, maxSearchBytes);
        const advice = result.truncated
          ? '文件搜索因预算耗尽而中断。可提高 maxSearchBytes / maxResults，或用 nextStartLine 继续。' +
            '**不要据此断言"没有更多匹配"。**'
          : undefined;
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
          ...(advice ? { advice } : {}),
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_tree ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_tree',
        description:
          '递归显示受控存储目录树。用于快速了解 workspace/tmp 等安全根的布局。配合 pattern 参数可筛选目录名和文件名（支持 glob: *.ts, *scheduler* 等）。' +
          '默认排除 node_modules / dist / build / .git / coverage 等噪声目录；传 `exclude` 覆盖默认，或传 `exclude: []` 关闭全部默认（如需查看 node_modules 时）。' +
          '注意：pattern 匹配的是文件/目录名，而非文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '根目录 storage URI 或相对当前 cwd 的路径；不传则以 cwd 为根' },
            maxDepth: { type: 'number', description: '最大递归深度（默认 3，最多 10）' },
            showHidden: { type: 'boolean', description: '是否显示隐藏文件（默认 false）' },
            pattern: {
              type: 'string',
              description: '文件与目录名过滤模式（简单 glob: *.ts, *scheduler* 等）。匹配的是文件/目录名，非文件内容。',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                '路径级 glob 排除模式（支持 ** / * / ?）。例：["**/node_modules/**"]。' +
                '不传 → 使用默认排除集；传 [] → 关闭默认。',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permissions: ['tool:file.tree', 'storage:read'],
    resolvePermissions: (args, callCtx) => storagePermission(args, config, callCtx, 'read'),
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string | undefined, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const maxDepth = Math.min((args.maxDepth as number) || 3, 10);
        const showHidden = (args.showHidden as boolean) ?? false;
        const pattern = args.pattern as string | undefined;
        const excludePatterns = resolveExcludePatterns(args.exclude);
        const lines: string[] = [`${basename(uri) || `${rootOf(uri)}:/`}`];
        let totalFiles = 0;
        let totalDirs = 0;
        let excluded = 0;

        async function walk(currentUri: string, prefix: string, depth: number): Promise<void> {
          if (depth > maxDepth) return;
          const result = await storage.list(currentUri).catch(() => null);
          if (!result) return;
          const entries = result.entries
            .filter(entry => showHidden || !entry.name.startsWith('.'))
            .filter(entry => {
              const rel = relPathFromRoot(uri, entry.uri);
              if (entry.isDirectory) {
                if (matchAnyGlob(rel, excludePatterns)) {
                  excluded++;
                  return false;
                }
                return true;
              }
              if (matchAnyGlob(rel, excludePatterns)) return false;
              return !pattern || matchGlob(entry.name, pattern);
            })
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
        return JSON.stringify({
          uri,
          tree: lines.join('\n'),
          summary: `${totalDirs} 个目录，${totalFiles} 个文件${excluded ? `（已排除 ${excluded} 个噪声目录）` : ''}`,
          excludedDirs: excluded,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });
}

function matchGlob(name: string, pattern: string): boolean {
  const regexStr = escapeRegExp(pattern).replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(name);
}
