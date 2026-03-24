/**
 * HTTP 工具组 —— 网络请求能力
 *
 * 提供：
 * - http_request: 发送 HTTP 请求（GET/POST/PUT/DELETE 等）
 * - http_download: 下载文件到本地
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@aalis/core';

interface HttpConfig {
  defaultTimeout: number;
  maxResponseSize: number;
}

export function registerHttpTools(ctx: Context, config: HttpConfig): void {

  // ==================== http_request ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'http_request',
        description:
          '发送 HTTP 请求。支持 GET、POST、PUT、DELETE、PATCH 等方法。' +
          '可用于调用 API、检查服务状态、获取网页内容等。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'HTTP(S) URL',
            },
            method: {
              type: 'string',
              description: 'HTTP 方法（默认 GET）',
            },
            headers: {
              type: 'object',
              description: '请求头（键值对）',
            },
            body: {
              type: 'string',
              description: '请求正文（POST/PUT/PATCH 时使用）',
            },
            timeout: {
              type: 'number',
              description: `请求超时毫秒数（默认 ${config.defaultTimeout}）`,
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const url = args.url as string;
      const method = ((args.method as string) || 'GET').toUpperCase();
      const headers = (args.headers as Record<string, string>) || {};
      const body = args.body as string | undefined;
      const timeout = (args.timeout as number) || config.defaultTimeout;

      // 安全检查：只允许 http/https
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return JSON.stringify({ error: '仅支持 http:// 和 https:// 协议' });
      }

      // 防止内网 SSRF：阻止请求常见内网地址
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        if (isPrivateHost(hostname)) {
          return JSON.stringify({
            error: '安全限制：不允许请求内网地址。如需访问本地服务请使用 exec 工具。',
          });
        }
      } catch {
        return JSON.stringify({ error: '无效的 URL' });
      }

      try {
        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(timeout),
        };

        if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          fetchOptions.body = body;
          if (!headers['content-type'] && !headers['Content-Type']) {
            (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
          }
        }

        const response = await fetch(url, fetchOptions);
        const contentType = response.headers.get('content-type') || '';
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

        // 检查响应大小
        if (contentLength > config.maxResponseSize) {
          return JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            error: `响应体过大 (${contentLength} 字节)，超过限制 ${config.maxResponseSize} 字节`,
            headers: Object.fromEntries(response.headers.entries()),
          });
        }

        let responseBody: string;
        if (contentType.includes('application/json')) {
          const json = await response.json();
          responseBody = JSON.stringify(json, null, 2);
        } else if (contentType.includes('text/') || contentType.includes('xml') || contentType.includes('javascript')) {
          responseBody = await response.text();
        } else {
          // 二进制内容只返回元信息
          const buffer = await response.arrayBuffer();
          responseBody = `[二进制内容, ${buffer.byteLength} 字节, Content-Type: ${contentType}]`;
        }

        // 截断过长的响应
        if (Buffer.byteLength(responseBody, 'utf-8') > config.maxResponseSize) {
          responseBody = Buffer.from(responseBody, 'utf-8')
            .subarray(0, config.maxResponseSize)
            .toString('utf-8') + '\n...[响应截断]';
        }

        return JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `请求失败: ${message}` });
      }
    },
  });

  // ==================== http_download ====================
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'http_download',
        description: '从 URL 下载文件到本地指定路径。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: '下载链接',
            },
            savePath: {
              type: 'string',
              description: '保存到的本地文件路径',
            },
            timeout: {
              type: 'number',
              description: `下载超时毫秒数（默认 ${config.defaultTimeout * 3}）`,
            },
          },
          required: ['url', 'savePath'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      const url = args.url as string;
      const savePath = args.savePath as string;
      const timeout = (args.timeout as number) || config.defaultTimeout * 3;

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return JSON.stringify({ error: '仅支持 http:// 和 https:// 协议' });
      }

      try {
        const parsed = new URL(url);
        if (isPrivateHost(parsed.hostname)) {
          return JSON.stringify({ error: '安全限制：不允许请求内网地址' });
        }
      } catch {
        return JSON.stringify({ error: '无效的 URL' });
      }

      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          return JSON.stringify({
            error: `下载失败: HTTP ${response.status} ${response.statusText}`,
          });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const resolvedPath = path.isAbsolute(savePath) ? savePath : path.resolve(process.cwd(), savePath);

        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, buffer);

        return JSON.stringify({
          path: resolvedPath,
          size: buffer.length,
          contentType: response.headers.get('content-type') || 'unknown',
          message: '下载完成',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `下载失败: ${message}` });
      }
    },
  });
}

// ===== 辅助函数 =====

function isPrivateHost(hostname: string): boolean {
  // IPv4 私有地址
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    return true;
  }

  // 172.16.0.0 - 172.31.255.255
  if (hostname.startsWith('172.')) {
    const second = parseInt(hostname.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  // 169.254.x.x (link-local)
  if (hostname.startsWith('169.254.')) return true;

  return false;
}
