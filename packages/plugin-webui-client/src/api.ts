/** 当前活跃会话 ID（可动态切换）。
 *  持久化到 localStorage，使每个浏览器/客户端各自记住自己的会话，刷新后保持，
 *  且与其他客户端互不干扰（多人隔离）。'__new_chat__' 表示未选中任何会话。 */
const SESSION_STORAGE_KEY = 'aalis:activeSessionId';

function loadInitialSessionId(): string {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY) || '__new_chat__';
  } catch {
    return '__new_chat__';
  }
}

let _activeSessionId = loadInitialSessionId();

/** 会话切换监听器 */
const _sessionListeners = new Set<(id: string) => void>();

export function getSessionId(): string {
  return _activeSessionId;
}

export function setSessionId(id: string): void {
  if (_activeSessionId === id) return;
  _activeSessionId = id;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    /* quota / 隐私模式：退化为内存态 */
  }
  for (const fn of _sessionListeners) fn(id);
}

export function onSessionChange(fn: (id: string) => void): () => void {
  _sessionListeners.add(fn);
  return () => _sessionListeners.delete(fn);
}

/**
 * 会话失效统一处理：401 ⇒ 当前浏览器无有效 cookie（过期/被清/换浏览器），
 * 跳回 '/' 让服务端中间件返回登录页，而不是让组件吃到 {error:'unauthenticated'}
 * 后白屏。返回 true 表示已触发跳转，调用方应中止后续处理。
 *
 * 服务端对未鉴权的 '/' 返回的是登录页 HTML（非 SPA），不会再发 api() 调用，
 * 故不会与缓存的 SPA 形成回跳环。
 */
export function redirectToLoginOn401(status: number): boolean {
  if (status !== 401) return false;
  window.location.replace('/');
  return true;
}

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (redirectToLoginOn401(res.status)) throw new Error('会话已失效，正在跳转登录');
  return res.json() as Promise<T>;
}

export async function pageAction<T = unknown>(pluginName: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/page-action/${encodeURIComponent(pluginName)}/${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (redirectToLoginOn401(res.status)) throw new Error('会话已失效，正在跳转登录');
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string }).error || '请求失败');
  return (json as { ok: boolean; data: T }).data;
}

/**
 * 把外部图片 URL 包装成走服务端代理的本地 URL，规避第三方站点 hotlink/referer/CORS 限制。
 * - http(s):// → /api/proxy/image?url=<encoded>
 * - data: / blob: / base64 / 已是 /api/... 的本地路径 → 原样返回
 * - file:// → 浏览器无法直接加载，原样返回（让 alt 显示）
 */
export function proxiedMediaUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return `/api/proxy/image?url=${encodeURIComponent(raw)}`;
  }
  return raw;
}
