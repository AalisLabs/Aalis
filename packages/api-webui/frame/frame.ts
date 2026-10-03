// 插件前端的助手，托管为 /frames/_base/frame.js。片段里的 nonce 原样读出、不清：清片段会往会话历史里加条目，
// nonce 对框架自己本来也不保密。同一页上的框架都是不透明来源、能互相发窗口消息，但只有父文档发得出来源是
// window.parent 的消息，所以只认来自它、带端口的第一个 init，之后只用这个端口。主题令牌在收到 init 的同一拍写上，
// 框架显示出来时已是宿主的配色

import type {
  FrameClient,
  FrameHello,
  FrameHostMessage,
  FrameMessage,
  FrameRequest,
  FrameSessionsChanged,
  FrameTheme,
} from '@aalis/api-webui';

/** 与 api-webui 的 FRAME_PROTOCOL_VERSION 同值：助手随 api-webui 同版本发布 */
const PROTOCOL = '1.0';
/** 发出 hello 之后等 init 的时长 */
const INIT_TIMEOUT_MS = 10_000;

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

function applyTheme({ kind, tokens }: FrameTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  root.dataset.theme = kind;
  root.style.colorScheme = kind;
}

function connected(port: MessagePort, sessionId: string | undefined): FrameClient {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const invalidated = new Set<(source?: string) => void>();
  const changed = new Set<(change: Omit<FrameSessionsChanged, 'type'>) => void>();
  let lastId = 0;

  const send = (message: FrameMessage) => port.postMessage(message);
  function request(message: Unsent<FrameRequest>): Promise<unknown> {
    lastId += 1;
    const id = lastId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ ...message, id });
    });
  }
  function listen<T>(listeners: Set<T>, listener: T): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  port.onmessage = ({ data }: MessageEvent<FrameHostMessage>) => {
    if (data.type === 'result') {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) waiting?.resolve(data.value);
      else waiting?.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
    } else if (data.type === 'theme') {
      applyTheme(data);
    } else if (data.type === 'invalidate') {
      for (const listener of invalidated) listener(data.source);
    } else if (data.type === 'sessions.changed') {
      for (const listener of changed) listener({ upserts: data.upserts, removes: data.removes });
    }
  };
  addEventListener('pagehide', () => send({ type: 'leaving' }));

  return {
    sessionId,
    data: (source, input) => request({ type: 'data', source, ...(input && { input }) }),
    action: (action, input) => request({ type: 'action', action, ...(input && { input }) }) as Promise<string | null>,
    open: async target => {
      await request({ type: 'open', target });
    },
    onInvalidate: listener => listen(invalidated, listener),
    listSessions: params => request({ type: 'sessions.list', ...params }) as ReturnType<FrameClient['listSessions']>,
    onSessionsChanged: listener => listen(changed, listener),
    abortTurn: async params => {
      await request({ type: 'turn.abort', ...params });
    },
  };
}

function handshake(): Promise<FrameClient> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeEventListener('message', onInit);
      reject(new Error('宿主没有回应握手'));
    }, INIT_TIMEOUT_MS);
    function onInit(event: MessageEvent): void {
      if (event.source !== parent || event.ports.length !== 1 || event.data?.type !== 'init') return;
      removeEventListener('message', onInit);
      clearTimeout(timer);
      const { theme, sessionId } = event.data;
      if (typeof theme?.tokens !== 'object' || theme.tokens === null) {
        reject(new Error('宿主的 init 不合格：theme 要是带 tokens 的对象'));
        return;
      }
      applyTheme(theme);
      resolve(connected(event.ports[0], sessionId));
    }
    addEventListener('message', onInit);
    const hello: FrameHello = { type: 'hello', protocol: PROTOCOL, nonce: location.hash.slice(1) };
    parent.postMessage(hello, '*');
  });
}

let connection: Promise<FrameClient> | undefined;

/** 与宿主握手，拿到这一页的连接；调多次是同一个连接 */
export function connect(): Promise<FrameClient> {
  connection ??= handshake();
  return connection;
}
