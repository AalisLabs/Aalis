/**
 * HTTP 工具组 —— 网络请求能力
 *
 * 提供：
 * - http_request: 发送 HTTP 请求（GET/POST/PUT/DELETE 等）
 * - http_download: 下载文件到 storage 受控路径
 */

import type { StorageService } from '@aalis/api-storage';
import { parseUriRoot, resolveAgainstCwd } from '@aalis/api-storage';
import { type BoundTools, wrapUntrustedContent } from '@aalis/api-tools';
import type { ServiceSelection } from '@aalis/core';
import { decodeUtf8Text } from '@aalis/util-file-signature';
import { safeFetch } from '@aalis/util-network-guard';

interface HttpConfig {
  defaultTimeout: number;
  maxResponseSize: number;
  /** storage 的选择层，调用时现查：http_download 写到当时选中的那一家，不在时回错 */
  storage: Pick<ServiceSelection<StorageService>, 'present' | 'use'>;
}

/** 流式读取响应体，累计超过 maxBytes 立即中止并抛错——防无 Content-Length 时全量缓冲耗尽内存。 */
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

/** 这种编码的严格解码器（解不开就抛错）；TextDecoder 不认的编码名为 undefined */
function strictDecoder(label: string) {
  try {
    return new TextDecoder(label, { fatal: true });
  } catch {
    return undefined;
  }
}

/**
 * 按服务端声明的 charset（Content-Type 的 charset 参数）解成文本，没声明的与 TextDecoder 不认的按 UTF-8；解不开与含 NUL
 * 字节（二进制的特征）的 text 为 null。encoding 是用的编码名，解不开时写进「不是 … 文本」
 */
function decodeBody(bytes: Uint8Array, contentType: string): { text: string | null; encoding: string } {
  const declared = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? '';
  const decoder = declared ? strictDecoder(declared) : undefined;
  if (!decoder) return { text: decodeUtf8Text(bytes), encoding: 'UTF-8' };
  try {
    const text = decoder.decode(bytes);
    return { text: text.includes('\0') ? null : text, encoding: declared };
  } catch {
    return { text: null, encoding: declared };
  }
}

export function registerHttpTools(tools: BoundTools, config: HttpConfig): void {
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
              description: '请求正文（POST/PUT/PATCH 时使用），原样发出，不补请求头；要发 JSON 用 json',
            },
            json: {
              type: 'object',
              description:
                '按 JSON 发出的请求正文（POST/PUT/PATCH 时使用）；请求头里没写 Content-Type 时补 application/json。与 body 只给一个',
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
    handler: async (args, callCtx) => {
      const url = args.url as string;
      const method = ((args.method as string) || 'GET').toUpperCase();
      const headers = (args.headers as Record<string, string>) || {};
      const body = args.body as string | undefined;
      const json = args.json;
      const timeout = (args.timeout as number) || config.defaultTimeout;
      if (body !== undefined && json !== undefined) return JSON.stringify({ error: 'body 与 json 只能给一个' });
      // 执行层不核参数类型：模型常把 JSON 写成字符串交给 json，照发会再编一层、发成字符串字面量
      if (json !== undefined && (typeof json !== 'object' || json === null || Array.isArray(json))) {
        return JSON.stringify({ error: 'json 要是对象；字符串正文用 body' });
      }

      try {
        // 超时与执行器给这次调用的中止信号谁先到按谁停
        const deadline = AbortSignal.timeout(timeout);
        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: callCtx.signal ? AbortSignal.any([deadline, callCtx.signal]) : deadline,
        };

        // 字符串正文原样发出（fetch 给 text/plain;charset=UTF-8），不猜它是不是 JSON
        const payload = json !== undefined ? JSON.stringify(json) : body;
        if (payload && ['POST', 'PUT', 'PATCH'].includes(method)) {
          fetchOptions.body = payload;
          if (json !== undefined && !new Headers(headers).has('content-type')) {
            fetchOptions.headers = { ...headers, 'Content-Type': 'application/json' };
          }
        }

        const response = await safeFetch(url, fetchOptions);
        const contentType = response.headers.get('content-type') || '';
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

        // 检查响应大小：超限的不读，取消响应体，不占着连接
        if (contentLength > config.maxResponseSize) {
          await response.body?.cancel();
          return JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            error: `响应体过大 (${contentLength} 字节)，超过限制 ${config.maxResponseSize} 字节`,
            headers: Object.fromEntries(response.headers.entries()),
          });
        }

        // 流式读取并设上限：无 Content-Length 时也不会全量缓冲耗尽内存
        const bodyBuf = await readBodyCapped(response, config.maxResponseSize);
        // 是不是文本按内容判（服务端声明的类型是标签）：按声明的编码解不开的（二进制，或编码与声明的不符）只返回元信息；
        // 声明是 JSON 的美化
        const { text, encoding } = decodeBody(bodyBuf, contentType);
        let responseBody: string;
        if (text === null) {
          responseBody = `[不是 ${encoding} 文本, ${bodyBuf.byteLength} 字节, Content-Type: ${contentType}]`;
        } else if (contentType.includes('application/json')) {
          try {
            responseBody = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            responseBody = text;
          }
        } else {
          responseBody = text;
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
          body: wrapUntrustedContent(responseBody, `HTTP 响应 ${url}`),
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
    // 大文件下载可能很久：等多久由执行器的让出时限管，停只认执行器给这次调用的中止信号
    background: {},
    handler: async (args, callCtx) => {
      const url = args.url as string;
      const savePath = args.savePath as string;

      if (!config.storage.present) {
        return JSON.stringify({ error: 'HTTP 下载需要 storage 服务' });
      }
      const storage = config.storage.use;

      try {
        const response = await safeFetch(url, { signal: callCtx.signal });

        // 不下的响应体一律取消，不占着连接
        if (!response.ok) {
          await response.body?.cancel();
          return JSON.stringify({
            error: `下载失败: HTTP ${response.status} ${response.statusText}`,
          });
        }

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > config.maxResponseSize) {
          await response.body?.cancel();
          return JSON.stringify({
            error: `下载内容过大 (${contentLength} 字节)，超过限制 ${config.maxResponseSize} 字节`,
          });
        }

        // 流式读取并设上限：无 Content-Length 时也不会全量缓冲耗尽内存（超限即中止抛错）
        const buffer = await readBodyCapped(response, config.maxResponseSize);

        if (typeof savePath !== 'string' || !savePath.trim()) throw new Error('保存路径不能为空');
        const storageUri = resolveAgainstCwd(savePath, 'workspace:/');
        // 下载只准落 agent 工作区（workspace、tmp），禁止写入 data:/pluginData:/logs 等其他根
        // （防被提示注入诱导 http_download 覆盖凭据/配置文件）。
        const root = parseUriRoot(storageUri);
        if (root !== 'workspace' && root !== 'tmp') {
          throw new Error(`http_download 仅允许写入 workspace:/ 或 tmp:/，不允许 ${root}:/`);
        }
        await storage.writeFile(storageUri, buffer);

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
