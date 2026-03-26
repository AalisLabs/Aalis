export const SESSION_ID = 'webui-default';

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
  return res.json() as Promise<T>;
}
