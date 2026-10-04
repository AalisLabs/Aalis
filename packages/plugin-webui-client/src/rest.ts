import type { ErrorResponse } from '@aalis/api-webui';
import { useEffect, useState } from 'react';

// 管理面 REST：同源、带登录 cookie，回应按 JSON 解析。非 2xx 抛 RestError，带状态码，错误文字取服务端给的 error，
// 输入没过校验时带上逐项的问题；连不上时抛 fetch 自己的错误。回应的形状由调用方校验

type Issue = NonNullable<ErrorResponse['issues']>[number];

export class RestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 输入没过校验时逐项列出，path 是字段名 */
    readonly issues: readonly Issue[] = [],
  ) {
    super(message);
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init.headers } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(body) ? body : {};
    const issues = Array.isArray(error.issues)
      ? error.issues.filter(
          (issue): issue is Issue =>
            isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string',
        )
      : [];
    throw new RestError(
      typeof error.error === 'string' ? error.error : `${path} 回了 ${response.status}`,
      response.status,
      issues,
    );
  }
  return body;
}

export const getJson = (path: string, signal: AbortSignal) => request(path, { signal });

const send = (method: string) => (path: string, body: unknown) =>
  request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const postJson = send('POST');
export const putJson = send('PUT');
export const deleteJson = (path: string) => request(path, { method: 'DELETE' });

/**
 * 在组件里取 path：parse 校验形状（模块级的函数，不随渲染变），version 变了重取，旧的请求作废。重取时与重取失败时都留着
 * 上一次的结果（失败另给 error），换了 path 时上一次的不算；path 为 undefined 时不取
 */
export function useJson<T>(
  path: string | undefined,
  parse: (body: unknown) => T,
  version: unknown,
): { value?: T; error?: Error } {
  const [state, setState] = useState<{ path?: string; value?: T; error?: Error }>({});
  useEffect(() => {
    if (path === undefined) return;
    const controller = new AbortController();
    getJson(path, controller.signal)
      .then(parse)
      .then(
        value => setState({ path, value }),
        (error: Error) => {
          if (!controller.signal.aborted)
            setState(last => ({ path, value: last.path === path ? last.value : undefined, error }));
        },
      );
    return () => controller.abort();
  }, [path, parse, version]);
  return state.path === path ? { value: state.value, error: state.error } : {};
}
