// 管理面 REST 的读取：同源、带登录 cookie，回应按 JSON 解析。失败（网络、非 2xx）抛错，错误文字取服务端给的 error，
// 回应的形状由调用方校验

export async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = (body as { error?: unknown } | undefined)?.error;
    throw new Error(typeof message === 'string' ? message : `${path} 回了 ${response.status}`);
  }
  return body;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
