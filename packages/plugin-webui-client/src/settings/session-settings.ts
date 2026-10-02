import type { SettingRow } from '@aalis/api-session-protocol';
import { useCallback, useEffect, useState } from 'react';
import { useSessionClient } from '../connection';
import { ConnectionLostError } from '../protocol/session-client';

// 一个会话适用的设置项：打开时取一次，插件启停或别处改了设置（session/config/changed）、重连后重取。
// 会话的「设置」标签与输入框旁的快捷切换共用这一份

export function useSessionSettings(sessionId: string) {
  const client = useSessionClient();
  const [state, setState] = useState<{ rows?: SettingRow[]; error?: Error }>({});

  useEffect(() => {
    let latest = 0;
    let disposed = false;
    const load = () => {
      const mine = ++latest;
      const stale = () => disposed || mine !== latest;
      client.request('session/config/get', { sessionId }).then(
        ({ items }) => {
          if (!stale()) setState({ rows: items });
        },
        (error: Error) => {
          // 断线时等重连以后重取
          if (!stale() && !(error instanceof ConnectionLostError)) setState(current => ({ ...current, error }));
        },
      );
    };
    const offs = [client.onReady(load), client.on('session/config/changed', load)];
    if (client.state.status === 'open') load();
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  }, [client, sessionId]);

  /** 改本会话的覆盖：给值即写入，null 恢复继承；写不进去时抛错 */
  const update = useCallback(
    async (key: string, value: unknown) => {
      const { items } = await client.request('session/config/update', { sessionId, patch: { [key]: value } });
      setState({ rows: items });
    },
    [client, sessionId],
  );

  return { ...state, update };
}
