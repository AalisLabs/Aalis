// 断线重连的 WebSocket，会话连接与管理连接共用。地址由页面所在的源推出，https 的页面连 wss。
// 断开后按退避重连，网络恢复或页面回到前台时立即重试。一次也没连上就断开时查一次登录状态：
// 握手看不到 401，登录失效时重新加载页面，由服务端给出登录页。登录状态查得到（页面的请求正常）却连着几回
// 一次也没连上，多半是升级被来源校验拒了（只回裸 403，浏览器读不到）：经反向代理访问、代理没转发原始的 Host，
// 状态上标出 refused，由连接横条提示。

export type ConnectionStatus = 'connecting' | 'open' | 'retrying' | 'stopped';

/** 连接状态；断开时带关闭帧的码与原因，停止时带停止的原因；refused 见文件头 */
export interface ConnectionState {
  status: ConnectionStatus;
  code?: number;
  reason?: string;
  refused?: boolean;
}

interface SocketHandlers {
  /** 底层连接打开。返回的 Promise 落定后才算连上；被拒时不再重连，状态停在 stopped 并带上原因 */
  opened(): void | Promise<void>;
  message(text: string): void;
  /** 连上过的底层连接断开，或被关闭 */
  closed?(): void;
}

interface Socket {
  readonly state: ConnectionState;
  onState(listener: (state: ConnectionState) => void): () => void;
  /** 底层连接打开时发出一帧；没打开时不发，返回 false */
  send(text: string): boolean;
  close(): void;
}

/** 第 n 次连续失败后等多久再连；连上一次就从头算 */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const AUTH_CHECK_TIMEOUT_MS = 10_000;
/** 页面的请求正常、却连着这么多回一次也没连上，算被拒 */
const REFUSED_AFTER = 2;

/** 查登录状态，登录失效时重新加载页面；回答页面的请求通不通（查到已登录） */
function checkSignedIn(): Promise<boolean> {
  return fetch('/api/auth/status', { signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS) })
    .then(response => response.json() as Promise<{ authed?: boolean }>)
    .then(status => {
      if (status.authed === false) location.reload();
      return status.authed === true;
    })
    .catch(() => false);
}

export function openSocket(path: string, handlers: SocketHandlers): Socket {
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
  const listeners = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = { status: 'connecting' };
  /** 当前这一次连接；被替换或关闭后，旧连接的事件一律不理 */
  let current: WebSocket | undefined;
  /** 打开着的底层连接 */
  let live: WebSocket | undefined;
  let failures = 0;
  /** 连着几回一次也没连上、页面的请求却正常 */
  let refusals = 0;
  /** 第几次连接：登录状态查回来时已经在连下一次了，就不再据它改状态 */
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: ConnectionState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  function release(): void {
    current = undefined;
    if (live) {
      live = undefined;
      handlers.closed?.();
    }
  }

  function connect(): void {
    timer = undefined;
    attempt++;
    const socket = new WebSocket(url);
    current = socket;
    socket.onopen = () => {
      live = socket;
      Promise.resolve(handlers.opened()).then(
        () => {
          if (current !== socket) return;
          failures = 0;
          refusals = 0;
          setState({ status: 'open' });
        },
        (error: Error) => {
          if (current !== socket) return;
          release();
          socket.close();
          setState({ status: 'stopped', reason: error.message });
        },
      );
    };
    socket.onmessage = event => {
      if (current === socket) handlers.message(String(event.data));
    };
    socket.onclose = event => {
      if (current !== socket) return;
      const opened = live === socket;
      release();
      if (!opened) {
        const closed = attempt;
        void checkSignedIn().then(restWorks => {
          if (closed !== attempt) return;
          refusals = restWorks ? refusals + 1 : 0;
          setState({ ...state, refused: refusals >= REFUSED_AFTER });
        });
      }
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
      failures++;
      setState({ status: 'retrying', code: event.code, reason: event.reason, refused: refusals >= REFUSED_AFTER });
      timer = setTimeout(connect, delay);
    };
  }

  const retryNow = () => {
    if (timer === undefined || document.visibilityState !== 'visible') return;
    clearTimeout(timer);
    connect();
  };
  window.addEventListener('online', retryNow);
  document.addEventListener('visibilitychange', retryNow);
  connect();

  return {
    get state() {
      return state;
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(text) {
      live?.send(text);
      return live !== undefined;
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', retryNow);
      const socket = current;
      release();
      socket?.close();
    },
  };
}
