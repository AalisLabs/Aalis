import {
  type ActionView,
  FRAME_PROTOCOL_VERSION,
  FRAME_REQUIRED_CAPABILITY,
  type FrameErrorCode,
  type FrameHostMessage,
  type FrameInit,
  type FrameOpenRequest,
  type FramePageView,
  type FrameRequest,
  type FrameTheme,
  parseFrameHello,
  parseFrameMessage,
  THEME_TOKENS,
  type ThemeToken,
} from '@aalis/api-webui';
import type { AdminClient } from '../protocol/admin-client';
import { ConnectionLostError, INVALID_PARAMS, RequestError, type SessionClient } from '../protocol/session-client';
import { getJson, isRecord, postJson, RestError } from '../rest';

// 插件前端的消息通道，宿主一侧。先在窗口上等框架的 hello，核过来源窗口、nonce 与主版本，交给框架一个专用端口，
// 之后只走这个端口。框架发来的每条消息先过 api-webui 的校验函数；实例、页面与会话面板的会话一律取挂载时的值；
// 宿主数据能力按页面申请的放行；外链与 destructive 动作要用户在宿主对话框里确认，同一时刻只一个，连续被取消到上限就卸载。
// 卸载只有一个出口：关端口、撤监听、在途的结果不再转回、清计时器

/** 在途请求最多几个，超了回 busy */
const FRAME_MAX_PENDING = 8;
/** 每秒最多收几条消息，超了卸载 */
const FRAME_MESSAGES_PER_SECOND = 200;
/** 第一次 load 之后多久没有合格的 hello 就算没有响应：模块脚本在 load 之前就下载并执行完了，慢网不会被误判 */
const FRAME_HANDSHAKE_TIMEOUT_MS = 10_000;
/** 同一个框架的宿主对话框连续被取消几次就卸载它 */
const FRAME_DIALOG_REFUSALS_MAX = 3;

/** 停止显示的原因：没有响应、离开了给它的地址、消息太多、反复弹确认、协议的主版本不同 */
export type FrameStop = { reason: 'timeout' | 'left' | 'flood' | 'refused' } | { reason: 'version'; protocol: string };

/** 要用户在宿主对话框里拍板的事：destructive 动作（连同这次的输入），或打开一个外站地址 */
export type FrameQuestion =
  | { kind: 'action'; action: ActionView; input?: Record<string, unknown> }
  | { kind: 'open'; url: string };

interface FrameHost {
  page: FramePageView;
  /** 会话面板的会话 */
  sessionId?: string;
  session: SessionClient;
  admin: AdminClient;
  /** 交出了 init，可以显示框架 */
  ready(): void;
  /** 停止显示：调用时通道已经拆掉 */
  stop(stop: FrameStop): void;
  /** 弹宿主对话框：用户确认为 true，取消为 false */
  ask(question: FrameQuestion): Promise<boolean>;
  openSession(sessionId: string): void;
  /** 经过宿主对话框的动作，结果与失败另用 Toast 告诉用户 */
  report(kind: 'success' | 'danger', text: string): void;
}

/** 回给框架的失败 */
class FrameFailure extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const enc = encodeURIComponent;
const major = (version: string) => Number(version.split('.')[0]);

function readTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(THEME_TOKENS.map(token => [token, style.getPropertyValue(token).trim()]));
  return {
    kind: style.getPropertyValue('color-scheme').trim() === 'light' ? 'light' : 'dark',
    tokens: tokens as Record<ThemeToken, string>,
  };
}

const sameTheme = (a: FrameTheme, b: FrameTheme) =>
  a.kind === b.kind && THEME_TOKENS.every(token => a.tokens[token] === b.tokens[token]);

/** 输入要能写成 JSON：服务端收的是 JSON，确认框里列的也是写成 JSON 之后的值 */
function jsonInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(input));
  } catch {
    throw new FrameFailure('invalid', '输入要能写成 JSON');
  }
}

/** 转发失败时回给框架的错误码与原因 */
function failureOf(err: unknown): { code: FrameErrorCode; message: string } {
  if (err instanceof FrameFailure) return { code: err.code, message: err.message };
  if (err instanceof RestError) {
    const { status, message } = err;
    // 数据源的输入在查询串里，太长时请求行被代理或 Node 拒收
    if (status === 414 || status === 431) return { code: 'invalid', message: '输入太长' };
    if (status === 400) return { code: 'invalid', message };
    if (status === 404) return { code: 'not-found', message };
    if (status === 503) return { code: 'unavailable', message };
    return { code: 'failed', message };
  }
  if (err instanceof ConnectionLostError) return { code: 'unavailable', message: err.message };
  if (err instanceof RequestError) {
    if (err.reason === 'not-found') return { code: 'not-found', message: err.message };
    return { code: err.code === INVALID_PARAMS ? 'invalid' : 'failed', message: err.message };
  }
  return { code: 'failed', message: (err as Error).message };
}

/**
 * 挂上一个框架：iframe 已在文档里，地址片段里是 nonce。只认一次合格的 hello；第一次 load 之后开始等握手，
 * 第二次 load 说明框架离开了给它的地址。返回卸载
 */
export function mountFrame(iframe: HTMLIFrameElement, nonce: string, host: FrameHost): () => void {
  let loads = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeChannel: (() => void) | undefined;
  let mounted = true;

  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    window.removeEventListener('message', onHello);
    iframe.removeEventListener('load', onLoad);
    clearTimeout(timer);
    closeChannel?.();
  }

  function stop(why: FrameStop): void {
    if (!mounted) return;
    unmount();
    host.stop(why);
  }

  function onHello(event: MessageEvent): void {
    const frame = iframe.contentWindow;
    if (frame === null || event.source !== frame || event.origin !== 'null') return;
    const hello = parseFrameHello(event.data);
    if (!hello.ok || hello.message.nonce !== nonce) return;
    window.removeEventListener('message', onHello);
    clearTimeout(timer);
    const { protocol } = hello.message;
    if (major(protocol) !== major(FRAME_PROTOCOL_VERSION)) {
      stop({ reason: 'version', protocol });
      return;
    }
    closeChannel = openChannel(frame, host, stop);
    host.ready();
  }

  function onLoad(): void {
    loads += 1;
    if (loads > 1) stop({ reason: 'left' });
    else if (!closeChannel) timer = setTimeout(() => stop({ reason: 'timeout' }), FRAME_HANDSHAKE_TIMEOUT_MS);
  }

  window.addEventListener('message', onHello);
  iframe.addEventListener('load', onLoad);
  return unmount;
}

/** 建专用端口随 init 交给框架，之后按消息转发。返回拆掉通道 */
function openChannel(frame: Window, host: FrameHost, stop: (stop: FrameStop) => void): () => void {
  const { page, sessionId, session, admin } = host;
  const base = `/api/pages/${enc(page.instance)}/${enc(page.key)}`;
  const closed = new AbortController();
  const { port1: port, port2 } = new MessageChannel();
  let pending = 0;
  let asking = false;
  let refusals = 0;
  let second = Number.NEGATIVE_INFINITY;
  let inSecond = 0;
  let theme = readTheme();

  // 关了的端口不再投递：卸载之后在途请求的结果自然转不回去
  const post = (message: FrameHostMessage) => port.postMessage(message);
  const invalidate = (source?: string) =>
    post(source === undefined ? { type: 'invalidate' } : { type: 'invalidate', source });
  const allowed = (type: keyof typeof FRAME_REQUIRED_CAPABILITY) => {
    const needed = FRAME_REQUIRED_CAPABILITY[type];
    return needed === null || page.frame.host.includes(needed);
  };

  /** REST 连不上时 fetch 抛它自己的错误，对到 unavailable */
  const rest = <T>(call: () => Promise<T>): Promise<T> =>
    call().catch((err: unknown) => {
      throw err instanceof RestError ? err : new FrameFailure('unavailable', '连不上服务端');
    });

  /** 会话协议的转发：会话连接没连上（会话服务不在或断线）时不等 */
  const protocol = <T>(call: () => Promise<T>): Promise<T> => {
    if (session.state.status !== 'open') throw new FrameFailure('unavailable', '会话服务没有连上');
    return call();
  };

  async function throughDialog(question: FrameQuestion): Promise<void> {
    if (asking) throw new FrameFailure('denied', '这个页面已经开着一个宿主对话框');
    asking = true;
    const confirmed = await host.ask(question);
    asking = false;
    if (confirmed) {
      refusals = 0;
      return;
    }
    refusals += 1;
    if (refusals >= FRAME_DIALOG_REFUSALS_MAX) stop({ reason: 'refused' });
    throw new FrameFailure('cancelled', '用户取消了');
  }

  async function data(source: string, input?: Record<string, unknown>): Promise<unknown> {
    const query = new URLSearchParams();
    if (sessionId !== undefined) query.set('sessionId', sessionId);
    if (input !== undefined) query.set('input', JSON.stringify(input));
    const search = query.toString();
    const path = `${base}/data/${enc(source)}${search ? `?${search}` : ''}`;
    const body = await rest(() => getJson(path, closed.signal));
    if (!isRecord(body) || !('data' in body)) throw new Error('取回的数据不是 { data } 的形状');
    return body.data;
  }

  async function action(name: string, input?: Record<string, unknown>): Promise<string | null> {
    const actions = page.actions ?? {};
    if (!Object.hasOwn(actions, name)) throw new FrameFailure('not-found', `这一页没有动作 ${name}`);
    const declared = actions[name];
    const confirmed = declared.effect === 'destructive';
    if (confirmed) await throughDialog({ kind: 'action', action: declared, input });
    const body = {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(input === undefined ? {} : { input }),
    };
    try {
      const reply = await rest(() => postJson(`${base}/actions/${enc(name)}`, body));
      const message = isRecord(reply) && typeof reply.message === 'string' ? reply.message : null;
      if (confirmed && message !== null) host.report('success', message);
      return message;
    } catch (err) {
      if (confirmed) host.report('danger', `${declared.label}失败：${failureOf(err).message}`);
      throw err;
    }
  }

  async function open(target: FrameOpenRequest['target']): Promise<null> {
    if ('session' in target) {
      host.openSession(target.session);
      return null;
    }
    const url = new URL(target.url);
    if (url.origin === location.origin) throw new FrameFailure('invalid', '宿主自己的地址不经外链打开');
    await throughDialog({ kind: 'open', url: url.href });
    return null;
  }

  async function handle(request: FrameRequest): Promise<unknown> {
    switch (request.type) {
      case 'data':
        return data(request.source, jsonInput(request.input));
      case 'action':
        return action(request.action, jsonInput(request.input));
      case 'open':
        return open(request.target);
      case 'sessions.list': {
        const { type, id, ...params } = request;
        const { groups, ...result } = await protocol(() => session.request('sessions/list', params));
        return result;
      }
      case 'turn.abort': {
        const { type, id, ...params } = request;
        await protocol(() => session.request('turn/abort', params));
        return null;
      }
    }
  }

  function receive(value: unknown): void {
    const parsed = parseFrameMessage(value);
    if (!parsed.ok) {
      if (parsed.id !== undefined) {
        post({ type: 'result', id: parsed.id, ok: false, error: { code: 'invalid', message: parsed.problem } });
      }
      return;
    }
    const message = parsed.message;
    if (message.type === 'leaving') {
      stop({ reason: 'left' });
      return;
    }
    const { id } = message;
    if (!allowed(message.type)) {
      const needed = FRAME_REQUIRED_CAPABILITY[message.type];
      post({ type: 'result', id, ok: false, error: { code: 'denied', message: `这个页面没有申请 ${needed}` } });
      return;
    }
    if (pending >= FRAME_MAX_PENDING) {
      const error = { code: 'busy' as const, message: `在途的请求已有 ${FRAME_MAX_PENDING} 个` };
      post({ type: 'result', id, ok: false, error });
      return;
    }
    pending += 1;
    handle(message)
      .then(
        result => post({ type: 'result', id, ok: true, value: result }),
        (err: unknown) => post({ type: 'result', id, ok: false, error: failureOf(err) }),
      )
      .finally(() => {
        pending -= 1;
      });
  }

  port.onmessage = (event: MessageEvent) => {
    const now = performance.now();
    if (now - second >= 1_000) {
      second = now;
      inSecond = 0;
    }
    inSecond += 1;
    if (inSecond > FRAME_MESSAGES_PER_SECOND) stop({ reason: 'flood' });
    else receive(event.data);
  };

  const observer = new MutationObserver(() => {
    const next = readTheme();
    if (sameTheme(next, theme)) return;
    theme = next;
    post({ type: 'theme', ...next });
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const offs = [
    admin.on('page.invalidate', event => {
      if (event.instance !== page.instance || event.pageKey !== page.key) return;
      if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
      invalidate(event.componentId);
    }),
    admin.onReconnect(() => invalidate()),
    session.onReady(() => invalidate()),
  ];
  if (allowed('sessions.changed')) {
    offs.push(
      session.on('sessions/changed', ({ upserts, removes }) => post({ type: 'sessions.changed', upserts, removes })),
    );
  }

  const init: FrameInit = {
    type: 'init',
    protocol: FRAME_PROTOCOL_VERSION,
    experimental: true,
    ...(sessionId === undefined ? {} : { sessionId }),
    theme,
  };
  frame.postMessage(init, '*', [port2]);

  return () => {
    closed.abort();
    port.onmessage = null;
    port.close();
    observer.disconnect();
    for (const off of offs) off();
  };
}
