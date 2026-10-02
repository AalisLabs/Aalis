import type { SessionMethod, SessionMethodParams, SessionMethodResult } from '@aalis/api-session-protocol';
import { vi } from 'vitest';

/** 自动回应的处理函数：返回值作为结果；抛错时回错误，错误带 code 时作为业务错误码 */
export type FakeHandlers = {
  [M in SessionMethod]?: (params: SessionMethodParams<M>) => SessionMethodResult<M>;
};

/**
 * 假的浏览器 WebSocket：记下客户端发出的帧，由用例决定何时打开、推什么、何时断开。
 * install 换掉全局的 WebSocket，sockets 按创建先后列出每次连接
 */
export class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];

  static install(): void {
    FakeWebSocket.sockets = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  }

  /** 最近一次连接 */
  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.sockets.at(-1);
    if (!socket) throw new Error('还没有连接');
    return socket;
  }

  /** 连到这个路径的最近一次连接 */
  static at(path: string): FakeWebSocket {
    const socket = FakeWebSocket.sockets.filter(s => new URL(s.url).pathname === path).at(-1);
    if (!socket) throw new Error(`还没有连到 ${path}`);
    return socket;
  }

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  closedByClient = false;
  private handlers: FakeHandlers = {};

  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }

  /** 发出的请求有处理函数时，在下一个微任务里自动回应；没有的留着由用例自己回 */
  serve(handlers: FakeHandlers): void {
    Object.assign(this.handlers, handlers);
  }

  send(frame: string): void {
    this.sent.push(frame);
    const { id, method, params } = JSON.parse(frame) as { id?: number; method?: SessionMethod; params?: unknown };
    const handler = id === undefined || method === undefined ? undefined : this.handlers[method];
    if (!handler) return;
    queueMicrotask(() => {
      if (this.closedByClient) return;
      try {
        this.push({ jsonrpc: '2.0', id, result: (handler as (p: unknown) => unknown)(params ?? {}) });
      } catch (err) {
        const code = (err as { code?: string }).code;
        this.push({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: (err as Error).message, ...(code ? { data: { code } } : {}) },
        });
      }
    });
  }

  close(): void {
    this.closedByClient = true;
  }

  /** 发出的帧按 JSON 解析 */
  get frames(): Array<{ id?: number; method?: string; params?: Record<string, unknown> }> {
    return this.sent.map(frame => JSON.parse(frame));
  }

  /** 最近一次请求 method 的帧 */
  request(method: string): { id: number; params: Record<string, unknown> } {
    const frame = this.frames.filter(f => f.method === method).at(-1);
    if (!frame || frame.id === undefined) throw new Error(`没有发出 ${method}`);
    return { id: frame.id, params: frame.params ?? {} };
  }

  open(): void {
    this.onopen?.();
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** 回应最近一次 method 请求 */
  reply(method: string, result: unknown): void {
    this.push({ jsonrpc: '2.0', id: this.request(method).id, result });
  }

  fail(method: string, message: string, code?: string): void {
    const error = { code: -32000, message, ...(code ? { data: { code } } : {}) };
    this.push({ jsonrpc: '2.0', id: this.request(method).id, error });
  }

  notify(method: string, params: unknown): void {
    this.push({ jsonrpc: '2.0', method, params });
  }

  /** 服务端或网络断开 */
  drop(code = 1006, reason = ''): void {
    this.onclose?.({ code, reason });
  }
}
