/**
 * HTTP 工具组 —— 网络请求能力
 *
 * 提供：
 * - http_request: 发送 HTTP 请求（GET/POST/PUT/DELETE 等）
 * - http_download: 下载文件到 storage 受控路径
 */

import { lookup } from 'node:dns/promises';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { isPrivateIp, toStorageUri as toStorageUriShared } from '@aalis/plugin-tools-api';

interface HttpConfig {
  defaultTimeout: number;
  maxResponseSize: number;
  storage?: StorageService;
}

const MAX_REDIRECTS = 5;

export function registerHttpTools(tools: ScopedToolService, config: HttpConfig): void {
  // ==================== http_request ====================
  tools.register({
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
    handler: async args => {
      const url = args.url as string;
      const method = ((args.method as string) || 'GET').toUpperCase();
      const headers = (args.headers as Record<string, string>) || {};
      const body = args.body as string | undefined;
      const timeout = (args.timeout as number) || config.defaultTimeout;

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

        const response = await safeFetch(url, fetchOptions);
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
          responseBody =
            Buffer.from(responseBody, 'utf-8').subarray(0, config.maxResponseSize).toString('utf-8') +
            '\n...[响应截断]';
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
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'http_download',
        description: '从 URL 下载文件到受 storage 服务保护的路径。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: '下载链接',
            },
            savePath: {
              type: 'string',
              description:
                '保存路径。支持 storage URI（如 workspace:/downloads/a.txt、tmp:/a.txt）；相对路径会保存到 workspace:/ 下；禁止宿主机绝对路径。',
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
    handler: async args => {
      const url = args.url as string;
      const savePath = args.savePath as string;
      const timeout = (args.timeout as number) || config.defaultTimeout * 3;

      if (!config.storage) {
        return JSON.stringify({ error: 'HTTP 下载需要 storage 服务' });
      }

      try {
        const response = await safeFetch(url, {
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          return JSON.stringify({
            error: `下载失败: HTTP ${response.status} ${response.statusText}`,
          });
        }

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > config.maxResponseSize) {
          return JSON.stringify({
            error: `下载内容过大 (${contentLength} 字节)，超过限制 ${config.maxResponseSize} 字节`,
          });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > config.maxResponseSize) {
          return JSON.stringify({
            error: `下载内容过大 (${buffer.byteLength} 字节)，超过限制 ${config.maxResponseSize} 字节`,
          });
        }

        const storageUri = toStorageUriShared(savePath, { requireValue: true, errorContext: '保存路径' });
        await config.storage.writeFile(storageUri, buffer);

        return JSON.stringify({
          path: storageUri,
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

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  let current = await validatePublicHttpUrl(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current.href, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    current = await validatePublicHttpUrl(new URL(location, current).href);
  }
  throw new Error(`重定向次数超过上限 (${MAX_REDIRECTS})`);
}

async function validatePublicHttpUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http:// 和 https:// 协议');
  }
  if (await isPrivateHost(parsed.hostname)) {
    throw new Error('安全限制：不允许请求内网地址。如需访问本地服务请使用 shell 工具。');
  }
  return parsed;
}

// 含 DNS 解析的内网判定（SSRF 防护）：先做字符串级判定，再解析域名验证每个 A/AAAA 记录。
// 字符串级判定复用 plugin-tools-api 的 isPrivateIp，避免与其他插件重复造轮。
async function isPrivateHost(hostname: string): Promise<boolean> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || normalized === 'localhost') return true;

  if (isPrivateIp(normalized)) return true;

  try {
    const addresses = await lookup(normalized, { all: true, verbatim: true });
    return addresses.some(({ address }) => isPrivateIp(address));
  } catch {
    return true;
  }
}
