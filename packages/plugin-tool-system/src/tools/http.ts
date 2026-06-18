/**
 * HTTP 工具组 —— 网络请求能力
 *
 * 提供：
 * - http_request: 发送 HTTP 请求（GET/POST/PUT/DELETE 等）
 * - http_download: 下载文件到 storage 受控路径
 */

import type { StorageService } from '@aalis/plugin-storage-api';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { toStorageUri as toStorageUriShared } from '@aalis/plugin-tools-api';
import { safeFetch } from '@aalis/util-network-guard';

interface HttpConfig {
  defaultTimeout: number;
  maxResponseSize: number;
  storage?: StorageService;
}

/** 流式读取响应体，累计超过 maxBytes 立即中止并抛错——防无 Content-Length 时全量缓冲撑爆内存。 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`响应体过大，超过限制 ${maxBytes} 字节`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

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

        // 流式读取并设上限：无 Content-Length 时也不会全量缓冲撑爆内存
        const bodyBuf = await readBodyCapped(response, config.maxResponseSize);
        let responseBody: string;
        if (contentType.includes('application/json')) {
          try {
            responseBody = JSON.stringify(JSON.parse(bodyBuf.toString('utf-8')), null, 2);
          } catch {
            responseBody = bodyBuf.toString('utf-8');
          }
        } else if (contentType.includes('text/') || contentType.includes('xml') || contentType.includes('javascript')) {
          responseBody = bodyBuf.toString('utf-8');
        } else {
          // 二进制内容只返回元信息
          responseBody = `[二进制内容, ${bodyBuf.byteLength} 字节, Content-Type: ${contentType}]`;
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
    // 写操作：与 file_write 同形挂闸——受限 + 每次确认 + storage:write 权限，
    // 防被注入的 LLM 静默/越权地把任意内容写进 storage（如覆写 data:/users.json）。
    visibility: 'restricted',
    confirm: 'session',
    permissions: ['tool:http_download', 'storage:write'],
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

        // 流式读取并设上限：无 Content-Length 时也不会全量缓冲撑爆内存（超限即中止抛错）
        const buffer = await readBodyCapped(response, config.maxResponseSize);

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
