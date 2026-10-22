import type { SettingLayer } from '@aalis/api-session-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionClient } from '../connection';
import { ConnectionLostError, type SessionClient } from '../protocol/session-client';
import type { Row } from './field';

// 会话设置的各行：一个会话适用的（会话的「设置」标签与输入框旁的快捷切换共用），或会话之上的一层（设置的「会话默认」）。
// 打开时取一次，设置或宿主配置文档变了（session/config/changed）、重连后重取。调用方给的 target 要是稳定的对象

type SettingsTarget = { sessionId: string } | { layer: SettingLayer };

/**
 * 会话连接上的一次查询：打开时取一次，设置变了（session/config/changed）、重连后重取，more 另给重取的时机，retry 当即重取；
 * 新的一次作废还在路上的，断线时不报错、等重连后重取。request 与 more 要是稳定的函数，request 换了先清空再取；没有 request
 * 时不取
 */
export function useSessionQuery<T>(
  request: ((client: SessionClient) => Promise<T>) | undefined,
  more?: (load: () => void) => Array<() => void>,
): { value?: T; error?: Error; set(value: T): void; retry(): void } {
  const client = useSessionClient();
  const [state, setState] = useState<{ value?: T; error?: Error }>({});
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    let latest = 0;
    let disposed = false;
    setState({});
    reload.current = () => {};
    if (!request) return;
    const load = () => {
      const mine = ++latest;
      const stale = () => disposed || mine !== latest;
      request(client).then(
        value => {
          if (!stale()) setState({ value });
        },
        (error: Error) => {
          if (!stale() && !(error instanceof ConnectionLostError)) setState(current => ({ ...current, error }));
        },
      );
    };
    reload.current = load;
    const offs = [client.onReady(load), client.on('session/config/changed', load), ...(more?.(load) ?? [])];
    // 握手已经完成（查询在握手之后才有，如功能位定下之后）：当即取，不等下一次 onReady
    if (client.ready) load();
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  }, [client, request, more]);

  const set = useCallback((value: T) => setState({ value }), []);
  const retry = useCallback(() => reload.current(), []);
  return { ...state, set, retry };
}

/** target 没有时不取（会话设置服务不在） */
export function useSettingRows(target: SettingsTarget | undefined) {
  const client = useSessionClient();
  const request = useMemo(
    () =>
      target &&
      (async (session: SessionClient) =>
        (
          await ('sessionId' in target
            ? session.request('session/config/get', target)
            : session.request('session/config/layer/get', target))
        ).items),
    [target],
  );
  const { value: rows, error, set, retry } = useSessionQuery<Row[]>(request);

  /** 改这个会话或这一层的一项：给值即写入，null 恢复继承（全局层恢复默认）；写不进去时抛错，没落盘时交回那一句 */
  const update = useCallback(
    async (row: Pick<Row, 'plugin' | 'key'>, value: unknown) => {
      if (!target) return undefined;
      const item = { plugin: row.plugin, key: row.key, value };
      const { items, unsaved } =
        'sessionId' in target
          ? await client.request('session/config/update', { ...target, ...item })
          : await client.request('session/config/layer/update', { ...target, ...item });
      set(items);
      return unsaved;
    },
    [client, target, set],
  );

  return { rows, error, update, retry };
}
