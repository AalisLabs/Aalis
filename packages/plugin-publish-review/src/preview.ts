import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { galleryHeaders, WORK_ID_PATTERN, WORK_IFRAME_SANDBOX, workHeaders } from '@aalis/api-publish';
import type { StorageService } from '@aalis/api-storage';
import { ITEM_ROOT, type QueueItem, type ReviewStore } from './state.js';

const SUBRESOURCE_ONLY = /\.(?:css|js|mjs|json|png|jpe?g|gif|webp|mp4|woff2)$/i;
const digest = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
const escaped = (value: string) =>
  value.replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

interface Preview {
  id: string;
  files: Map<string, { bytes: Uint8Array; type: string }>;
}

/** Ephemeral local-only review server. No preview bytes or tokens are persisted. */
export class ReviewPreviewServer {
  readonly #store: ReviewStore;
  readonly #storage: StorageService;
  readonly #signal?: AbortSignal;
  readonly #previews = new Map<string, Preview>();
  readonly #sockets = new Set<Socket>();
  #server?: Server;
  #port?: number;
  #starting?: Promise<void>;
  #closed = false;
  #sweep?: NodeJS.Timeout;

  constructor(deps: { store: ReviewStore; storage: StorageService; signal?: AbortSignal }) {
    this.#store = deps.store;
    this.#storage = deps.storage;
    this.#signal = deps.signal;
    deps.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  get active(): ReadonlyArray<{ id: string; url: string }> {
    this.prune();
    return [...this.#previews].map(([token, preview]) => ({ id: preview.id, url: this.#url(token) }));
  }

  async open(id: string): Promise<string> {
    if (this.#closed || this.#signal?.aborted) throw new Error('预览服务已停止');
    if (this.#store.failure) throw new Error(this.#store.failure);
    if (!WORK_ID_PATTERN.test(id)) throw new Error('没有这件待审核网页作品');
    const item = this.#store.data.queue[id];
    if (!item || item.state !== 'awaiting-owner' || item.kind !== 'html' || !item.outHashes)
      throw new Error('没有这件待审核网页作品');
    const files = await this.#snapshot(item);
    // A decision can complete while file reads are in flight. Never issue a token for the old item.
    if (this.#store.failure || this.#store.data.queue[id] !== item || item.state !== 'awaiting-owner')
      throw new Error('待审核作品已变更');
    await this.#listen();
    if (this.#closed || this.#signal?.aborted || this.#store.failure || this.#store.data.queue[id] !== item) {
      if (this.#previews.size === 0) this.#stop();
      throw new Error('待审核作品已变更');
    }
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    this.#previews.set(token, { id, files });
    return this.#url(token);
  }

  revoke(id: string): void {
    for (const [token, preview] of this.#previews) if (preview.id === id) this.#previews.delete(token);
    if (this.#previews.size === 0) this.#stop();
  }

  /** Removes tokens after timeout or withdrawal, including decisions made outside the WebUI. */
  prune(): void {
    for (const [token, preview] of this.#previews) {
      if (this.#store.failure || this.#store.data.queue[preview.id]?.state !== 'awaiting-owner')
        this.#previews.delete(token);
    }
    if (this.#previews.size === 0) this.#stop();
  }

  close(): void {
    this.#closed = true;
    this.#previews.clear();
    this.#stop();
  }

  async #snapshot(item: QueueItem): Promise<Preview['files']> {
    const files: Preview['files'] = new Map();
    for (const file of item.files) {
      const expected = item.outHashes?.[file.path];
      if (!expected) throw new Error('审核输出不完整，不能预览');
      const raw = await this.#storage.readFile(`${ITEM_ROOT}/${item.id}/out/${file.path}`);
      const bytes = new Uint8Array(Buffer.from(raw));
      if ((await digest(bytes)) !== expected) throw new Error('审核输出完整性核对失败，不能预览');
      files.set(file.path, { bytes, type: file.contentType });
    }
    if (!files.has('index.html')) throw new Error('网页作品缺少入口');
    return files;
  }

  #url(token: string): string {
    return `http://127.0.0.1:${this.#port}/${token}/`;
  }

  async #listen(): Promise<void> {
    if (this.#server?.listening) return;
    if (this.#starting) return this.#starting;
    this.#starting = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => this.#handle(request, response));
      this.#server = server;
      server.on('connection', socket => {
        this.#sockets.add(socket);
        socket.once('close', () => this.#sockets.delete(socket));
        socket.on('error', () => {});
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('预览监听地址不可用'));
        this.#port = address.port;
        this.#sweep = setInterval(() => this.prune(), 1000);
        this.#sweep.unref?.();
        resolve();
      });
    }).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  #stop(): void {
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = undefined;
    this.#server?.close();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#server = undefined;
    this.#port = undefined;
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    this.prune();
    const origin = `http://127.0.0.1:${this.#port}`;
    const fallback = workHeaders({ scope: 'self', frameAncestors: [origin] });
    const send = (status: number, headers: Record<string, string>, body?: Uint8Array | string) => {
      for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
      response.setHeader('Cache-Control', 'no-store');
      response.statusCode = status;
      if (body !== undefined) {
        const data = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
        response.setHeader('Content-Length', data.length);
        response.end(request.method === 'HEAD' ? undefined : data);
      } else response.end();
    };
    if (request.headers.host !== `127.0.0.1:${this.#port}`) {
      send(421, fallback);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, fallback);
      return;
    }
    const url = new URL(request.url ?? '/', origin);
    const match = /^\/([0-9a-f]{32})\/(.*)$/.exec(url.pathname);
    if (!match) {
      send(404, fallback);
      return;
    }
    const [, token, tail] = match;
    const preview = this.#previews.get(token);
    if (!preview) {
      send(404, fallback);
      return;
    }
    if (tail === '') {
      const headers = galleryHeaders({ frameOrigins: [origin] });
      headers['Content-Type'] = 'text/html; charset=utf-8';
      const title = escaped(this.#store.data.queue[preview.id]?.title ?? '作品预览');
      const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>隔离预览；作品里的脚本会运行。</p><iframe src="/${token}/w/" sandbox="${WORK_IFRAME_SANDBOX}" referrerpolicy="no-referrer" style="width:100%;height:80vh"></iframe></html>`;
      send(200, headers, html);
      return;
    }
    if (!tail.startsWith('w/')) {
      send(404, fallback);
      return;
    }
    const policy = {
      ...workHeaders({ scope: { origin, basePath: `/${token}/w/` }, frameAncestors: [origin] }),
      'Access-Control-Allow-Origin': '*',
    };
    const filePath = tail === 'w/' ? 'index.html' : tail.slice(2);
    if (filePath === 'index.html' && tail !== 'w/') {
      send(404, policy);
      return;
    }
    const file = preview.files.get(filePath);
    if (!file) {
      send(404, policy);
      return;
    }
    if (request.headers['sec-fetch-dest'] === 'document') {
      send(302, { ...policy, Location: this.#url(token) });
      return;
    }
    if (request.headers['sec-fetch-dest'] === undefined && !SUBRESOURCE_ONLY.test(filePath)) {
      send(
        200,
        { ...policy, 'Content-Type': 'text/html; charset=utf-8' },
        `<!doctype html><meta charset="utf-8"><p>请用较新的浏览器打开 ${this.#url(token)}</p>`,
      );
      return;
    }
    send(200, { ...policy, 'Content-Type': file.type }, file.bytes);
  }
}
