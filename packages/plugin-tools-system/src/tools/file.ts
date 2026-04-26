/**
 * 文件操作工具组
 *
 * 参考 internal-framework 的 read / write / edit 工具与我自身的文件工具，提供：
 * - file_read: 读取文件内容（支持行范围、编码）
 * - file_write: 创建或覆盖文件（自动创建目录）
 * - file_edit: 精确字符串替换编辑
 * - file_append: 追加内容到文件末尾
 * - file_list: 列出目录内容
 * - file_info: 获取文件/目录的元信息
 * - file_search: 在文件中搜索文本（grep 风格）
 * - file_tree: 递归显示目录树结构
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, type Stats } from 'node:fs';
import type { Context } from '@aalis/core';

interface FileConfig {
  cwd: string;
  maxReadSize: number;
  maxWriteSize: number;
}

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function registerFileTools(ctx: Context, config: FileConfig): void {

  // ==================== file_read ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_read',
        description:
          '读取文件的内容。支持指定行范围以读取大文件的部分内容。' +
          '对于二进制文件返回 base64 编码或提示。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于工作目录的路径）',
            },
            startLine: {
              type: 'number',
              description: '起始行号（从 1 开始，可选）',
            },
            endLine: {
              type: 'number',
              description: '结束行号（包含，可选）',
            },
            encoding: {
              type: 'string',
              description: '编码方式（可选，默认 utf-8，可用 base64 读取二进制文件）',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const filePath = resolvePath(args.path as string, config.cwd);
      const encoding = (args.encoding as BufferEncoding) || 'utf-8';

      try {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          return JSON.stringify({ error: '路径是一个目录，请使用 file_list' });
        }
        if (stat.size > config.maxReadSize) {
          return JSON.stringify({
            error: `文件过大 (${stat.size} 字节)，超过限制 ${config.maxReadSize} 字节。请使用 startLine/endLine 参数读取部分内容。`,
            size: stat.size,
          });
        }

        if (encoding === 'base64') {
          const buffer = await fs.readFile(filePath);
          return JSON.stringify({
            path: filePath,
            encoding: 'base64',
            size: stat.size,
            content: buffer.toString('base64'),
          });
        }

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        const startLine = (args.startLine as number) || 1;
        const endLine = (args.endLine as number) || totalLines;
        const start = Math.max(1, startLine) - 1;
        const end = Math.min(totalLines, endLine);

        const selectedLines = lines.slice(start, end);
        const result = selectedLines
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join('\n');

        return JSON.stringify({
          path: filePath,
          totalLines,
          startLine: start + 1,
          endLine: end,
          content: result,
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_write ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_write',
        description:
          '创建或覆盖文件。如果目标目录不存在会自动创建。' +
          '警告：会完全覆盖已有文件内容。如需部分修改请使用 file_edit。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径',
            },
            content: {
              type: 'string',
              description: '要写入的内容',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const filePath = resolvePath(args.path as string, config.cwd);
      const content = args.content as string;

      if (Buffer.byteLength(content, 'utf-8') > config.maxWriteSize) {
        return JSON.stringify({
          error: `内容过大，超过限制 ${config.maxWriteSize} 字节`,
        });
      }

      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        const stat = await fs.stat(filePath);
        return JSON.stringify({
          path: filePath,
          size: stat.size,
          message: '文件写入成功',
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_edit ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_edit',
        description:
          '通过精确的字符串替换来编辑文件。找到 oldText 并替换为 newText。' +
          'oldText 必须在文件中唯一匹配。建议包含足够的上下文行以确保唯一匹配。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径',
            },
            oldText: {
              type: 'string',
              description: '要被替换的原始文本（必须精确匹配，包括缩进和换行）',
            },
            newText: {
              type: 'string',
              description: '替换后的新文本',
            },
          },
          required: ['path', 'oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const filePath = resolvePath(args.path as string, config.cwd);
      const oldText = args.oldText as string;
      const newText = args.newText as string;

      try {
        const content = await fs.readFile(filePath, 'utf-8');

        // 检查唯一匹配
        const firstIndex = content.indexOf(oldText);
        if (firstIndex === -1) {
          return JSON.stringify({
            error: '在文件中未找到 oldText。请确保文本精确匹配（包括空格和缩进）。',
          });
        }

        const secondIndex = content.indexOf(oldText, firstIndex + 1);
        if (secondIndex !== -1) {
          return JSON.stringify({
            error: 'oldText 在文件中有多处匹配。请提供更多上下文以确保唯一匹配。',
            matchCount: content.split(oldText).length - 1,
          });
        }

        const newContent = content.replace(oldText, newText);
        await fs.writeFile(filePath, newContent, 'utf-8');

        // 返回编辑区域附近的上下文
        const newIndex = newContent.indexOf(newText);
        const before = newContent.slice(0, newIndex).split('\n');
        const editLines = newText.split('\n');
        const startLine = before.length;

        return JSON.stringify({
          path: filePath,
          message: '编辑成功',
          editedLines: { start: startLine, count: editLines.length },
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_append ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_append',
        description: '将内容追加到文件末尾。如果文件不存在则创建。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径',
            },
            content: {
              type: 'string',
              description: '要追加的内容',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const filePath = resolvePath(args.path as string, config.cwd);
      const content = args.content as string;

      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, content, 'utf-8');
        const stat = await fs.stat(filePath);
        return JSON.stringify({
          path: filePath,
          size: stat.size,
          message: '内容追加成功',
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_list ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_list',
        description: '列出目录中的文件和子目录，支持名称关键词过滤、类型过滤与分页。大目录（上千个条目）务必使用 keyword 或 分页参数，避免一次返回过多数据。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '目录路径（可选，默认工作目录）',
            },
            showHidden: {
              type: 'boolean',
              description: '是否显示隐藏文件（以 . 开头，默认 false）',
            },
            keyword: {
              type: 'string',
              description: '可选：按名称子串模糊匹配（不区分大小写）',
            },
            type: {
              type: 'string',
              enum: ['file', 'directory', 'symlink'],
              description: '可选：只返回指定类型',
            },
            page: { type: 'number', description: '页码，从 1 开始，默认 1' },
            pageSize: { type: 'number', description: '每页条数，默认 50（可自行设定）' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const dirPath = resolvePath((args.path as string) || '.', config.cwd);

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const showHidden = (args.showHidden as boolean) ?? false;
        const items: Array<{ name: string; type: string; size?: number; modified?: string }> = [];

        for (const entry of entries) {
          if (!showHidden && entry.name.startsWith('.')) continue;
          try {
            const fullPath = path.join(dirPath, entry.name);
            const stat = await fs.stat(fullPath);
            items.push({
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
              size: entry.isDirectory() ? undefined : stat.size,
              modified: stat.mtime.toISOString(),
            });
          } catch {
            items.push({
              name: entry.name,
              type: 'unknown',
            });
          }
        }

        const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
        const typeFilter = typeof args.type === 'string' ? args.type : '';
        const filtered = items.filter(it => {
          if (typeFilter && it.type !== typeFilter) return false;
          if (keyword && !it.name.toLowerCase().includes(keyword)) return false;
          return true;
        });

        const page = Math.max(1, Math.floor(Number(args.page) || 1));
        const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 50));
        const total = items.length;
        const matched = filtered.length;
        const totalPages = Math.max(1, Math.ceil(matched / pageSize));
        const curPage = Math.min(page, totalPages);
        const start = (curPage - 1) * pageSize;
        const pageItems = filtered.slice(start, start + pageSize);

        return JSON.stringify({
          path: dirPath,
          total,
          matched,
          page: curPage,
          pageSize,
          totalPages,
          hasMore: curPage < totalPages,
          ...(keyword ? { keyword } : {}),
          ...(typeFilter ? { type: typeFilter } : {}),
          entries: pageItems,
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_info ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_info',
        description: '获取文件或目录的详细元信息（大小、权限、修改时间等）。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件或目录路径',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const filePath = resolvePath(args.path as string, config.cwd);

      try {
        const stat = await fs.stat(filePath);
        const isFile = stat.isFile();

        const info: Record<string, unknown> = {
          path: filePath,
          type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
          size: stat.size,
          permissions: `0o${(stat.mode & 0o777).toString(8)}`,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
        };

        if (isFile) {
          const ext = path.extname(filePath).toLowerCase();
          info.extension = ext;
          // 粗略的行数统计
          if (stat.size < config.maxReadSize && isTextExtension(ext)) {
            const content = await fs.readFile(filePath, 'utf-8');
            info.lineCount = content.split('\n').length;
          }
        }

        if (stat.isSymbolicLink()) {
          info.target = await fs.readlink(filePath);
        }

        return JSON.stringify(info);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_search ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_search',
        description:
          '在文件中搜索匹配的文本行（类似 grep）。支持正则表达式和大小写控制。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '要搜索的文件路径',
            },
            pattern: {
              type: 'string',
              description: '搜索模式（纯文本或正则表达式）',
            },
            isRegex: {
              type: 'boolean',
              description: '模式是否为正则表达式（默认 false）',
            },
            ignoreCase: {
              type: 'boolean',
              description: '是否忽略大小写（默认 true）',
            },
            maxResults: {
              type: 'number',
              description: '最大返回结果数（默认 50）',
            },
          },
          required: ['path', 'pattern'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const filePath = resolvePath(args.path as string, config.cwd);
      const pattern = args.pattern as string;
      const isRegex = (args.isRegex as boolean) ?? false;
      const ignoreCase = (args.ignoreCase as boolean) ?? true;
      const maxResults = Math.min((args.maxResults as number) || 50, 200);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const matches: Array<{ line: number; content: string }> = [];

        let regex: RegExp;
        if (isRegex) {
          regex = new RegExp(pattern, ignoreCase ? 'i' : '');
        } else {
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          regex = new RegExp(escaped, ignoreCase ? 'i' : '');
        }

        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            matches.push({ line: i + 1, content: lines[i] });
          }
        }

        return JSON.stringify({
          path: filePath,
          pattern,
          matches,
          matchCount: matches.length,
          truncated: matches.length >= maxResults,
        });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  });

  // ==================== file_tree ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'file_tree',
        description:
          '递归显示目录的树形结构。用于快速了解项目布局。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '根目录路径（可选，默认工作目录）',
            },
            maxDepth: {
              type: 'number',
              description: '最大递归深度（默认 3）',
            },
            showHidden: {
              type: 'boolean',
              description: '是否显示隐藏文件（默认 false）',
            },
            pattern: {
              type: 'string',
              description: '文件名过滤模式（简单 glob: *.ts, *.py 等）',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const dirPath = resolvePath((args.path as string) || '.', config.cwd);
      const maxDepth = Math.min((args.maxDepth as number) || 3, 10);
      const showHidden = (args.showHidden as boolean) ?? false;
      const pattern = args.pattern as string | undefined;

      const lines: string[] = [];
      let totalFiles = 0;
      let totalDirs = 0;

      async function walk(dir: string, prefix: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;

        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
        if (!entries) return;

        const filtered = entries.filter(e => showHidden || !String(e.name).startsWith('.'));
        const sorted = filtered.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return String(a.name).localeCompare(String(b.name));
        });

        for (let i = 0; i < sorted.length; i++) {
          const entry = sorted[i];
          const isLast = i === sorted.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = prefix + (isLast ? '    ' : '│   ');

          if (entry.isDirectory()) {
            totalDirs++;
            lines.push(`${prefix}${connector}${String(entry.name)}/`);
            await walk(path.join(dir, String(entry.name)), childPrefix, depth + 1);
          } else {
            if (pattern && !matchGlob(String(entry.name), pattern)) continue;
            totalFiles++;
            lines.push(`${prefix}${connector}${String(entry.name)}`);
          }
        }
      }

      lines.push(path.basename(dirPath) + '/');
      await walk(dirPath, '', 1);

      return JSON.stringify({
        path: dirPath,
        tree: lines.join('\n'),
        summary: `${totalDirs} 个目录，${totalFiles} 个文件`,
      });
    },
  });
}

// ===== 辅助函数 =====

function isTextExtension(ext: string): boolean {
  const textExts = new Set([
    '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
    '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
    '.java', '.c', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh',
    '.toml', '.ini', '.cfg', '.conf', '.env', '.log', '.csv',
    '.sql', '.vue', '.svelte', '.astro',
  ]);
  return textExts.has(ext);
}

function matchGlob(name: string, pattern: string): boolean {
  // 简单 glob 匹配：支持 * 和 ?
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(name);
}
