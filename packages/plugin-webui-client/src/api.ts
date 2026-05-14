/** 当前活跃会话 ID（可动态切换） */
let _activeSessionId = '__new_chat__';

/** 会话切换监听器 */
const _sessionListeners = new Set<(id: string) => void>();

export function getSessionId(): string {
  return _activeSessionId;
}

export function setSessionId(id: string): void {
  if (_activeSessionId === id) return;
  _activeSessionId = id;
  for (const fn of _sessionListeners) fn(id);
}

export function onSessionChange(fn: (id: string) => void): () => void {
  _sessionListeners.add(fn);
  return () => _sessionListeners.delete(fn);
}

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json() as Promise<T>;
}

export async function pageAction<T = unknown>(pluginName: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/page-action/${encodeURIComponent(pluginName)}/${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
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
