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
