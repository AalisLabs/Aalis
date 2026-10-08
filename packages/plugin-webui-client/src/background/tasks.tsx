import type { BackgroundTask, SessionNotificationParams } from '@aalis/api-session-protocol';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import { useSessionClient } from '../connection';
import { ConnectionLostError, RequestError } from '../protocol/session-client';

// 后台任务：整页一份全部会话的任务，握手（含重连后）时取 background/list，之后按 background/changed 的增量更新，
// 取数途中来的增量取完以后补上。没有后台任务登记（unsupported）时按没有任务。「后台」标签、时间线里转了后台的工具卡
// 与运行状况的「正在运行」都读它

type Change = SessionNotificationParams<'background/changed'>;

interface Background {
  /** 按任务 id；取到以前为 undefined，重取失败时留着上一次的 */
  tasks?: ReadonlyMap<string, BackgroundTask>;
  error?: Error;
  retry(): void;
}

const Context = createContext<Background | undefined>(undefined);

export function useBackground(): Background {
  const background = useContext(Context);
  if (!background) throw new Error('只能在 BackgroundProvider 里取后台任务');
  return background;
}

function apply(tasks: Map<string, BackgroundTask>, change: Change): void {
  for (const task of change.upserts) tasks.set(task.id, task);
  for (const id of change.removes) tasks.delete(id);
}

export function BackgroundProvider({ children }: { children: ReactNode }) {
  const client = useSessionClient();
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<Pick<Background, 'tasks' | 'error'>>({});

  useEffect(() => {
    let tasks: Map<string, BackgroundTask> | undefined;
    /** 取数途中收到的增量 */
    let pending: Change[] | undefined;
    /** 最近一次取数的错误：之后的增量照常套上，错误留着，直到取成功 */
    let error: Error | undefined;
    let disposed = false;
    const publish = () => setState({ tasks: tasks && new Map(tasks), error });

    async function load(): Promise<void> {
      pending = [];
      let listed: BackgroundTask[];
      try {
        listed = (await client.request('background/list', {})).tasks;
      } catch (err) {
        if (disposed) return;
        const absent = err instanceof RequestError && err.reason === 'unsupported';
        if (!absent) {
          pending = undefined;
          // 断线时等重连以后重取
          if (err instanceof ConnectionLostError) return;
          error = err as Error;
          publish();
          return;
        }
        listed = [];
      }
      if (disposed) return;
      tasks = new Map(listed.map(task => [task.id, task]));
      for (const change of pending) apply(tasks, change);
      pending = undefined;
      error = undefined;
      publish();
    }

    const offChanged = client.on('background/changed', change => {
      if (pending) pending.push(change);
      else if (tasks) {
        apply(tasks, change);
        publish();
      }
    });
    const offReady = client.onReady(() => void load());
    if (client.state.status === 'open') void load();
    return () => {
      disposed = true;
      offChanged();
      offReady();
    };
  }, [client, attempt]);

  const value = useMemo<Background>(() => ({ ...state, retry }), [state]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
