import type { Features, SessionNotificationParams } from '@aalis/api-session-protocol';
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { AdminClient } from './protocol/admin-client';
import { trackPresence } from './protocol/presence';
import type { SessionClient } from './protocol/session-client';
import type { ConnectionState } from './protocol/socket';

// 页面的两条连接：会话协议与管理面。整页只开一次，由入口创建后交给这里；在场上报跟着会话连接。
// 应用重启时管理连接先收到 app.restarting、随后断开，重连上以后页面整页重新加载（前端可能换了新版本）；
// client.reload 表示活跃的前端换了，立即重新加载。
// 功能位取自握手与 features/changed，应用名取自握手（握手之前是页面自带的标题）。推给这条连接、还没结算的审批按 id
// 记着：服务端只把结算推给拿到过审批的连接，所以连接断开时清空，重连并重报在场后服务端会再推

export type Approval = SessionNotificationParams<'approval/requested'>['approval'];

interface Connection {
  session: SessionClient;
  admin: AdminClient;
  /** 收到 app.restarting，等管理连接重连上以后重新加载 */
  restarting: boolean;
  /** 握手之前全是 false */
  features: Features;
  /** 标签页标题与房间里她的回复用它 */
  appName: string;
  /** 推给这条连接、还没结算的审批 */
  approvals: ReadonlyMap<string, Approval>;
}

const NO_FEATURES: Features = { send: false, rewind: false, compress: false };

const Context = createContext<Connection | undefined>(undefined);

export function useConnection(): Connection {
  const connection = useContext(Context);
  if (!connection) throw new Error('只能在 ConnectionProvider 里取连接');
  return connection;
}

export const useSessionClient = () => useConnection().session;
export const useFeatures = () => useConnection().features;

/** 会话服务不在时 /session 以这个关闭码断开，客户端照常重连，直到服务回来 */
export const SERVICE_ABSENT = 1013;

export function useConnectionState(client: SessionClient | AdminClient): ConnectionState {
  return useSyncExternalStore(
    listener => client.onState(listener),
    () => client.state,
  );
}

/** 会话服务用不了：会话连接已停止，或服务不在 */
export function useSessionless(): boolean {
  const state = useConnectionState(useSessionClient());
  return state.status === 'stopped' || (state.status === 'retrying' && state.code === SERVICE_ABSENT);
}

export function ConnectionProvider({
  session,
  admin,
  children,
}: {
  session: SessionClient;
  admin: AdminClient;
  children: ReactNode;
}) {
  const [restarting, setRestarting] = useState(false);
  const [features, setFeatures] = useState(NO_FEATURES);
  const [appName, setAppName] = useState(() => document.title);
  const [approvals, setApprovals] = useState<ReadonlyMap<string, Approval>>(new Map());

  useEffect(() => trackPresence(session), [session]);

  useEffect(() => {
    const offs = [
      session.onReady(init => {
        setFeatures(init.features);
        setAppName(init.appName);
      }),
      session.on('features/changed', ({ features: next }) => setFeatures(next)),
      session.on('approval/requested', ({ approval }) => setApprovals(map => new Map(map).set(approval.id, approval))),
      session.on('approval/settled', ({ approvalId }) =>
        setApprovals(map => {
          const next = new Map(map);
          next.delete(approvalId);
          return next;
        }),
      ),
      session.onState(state => {
        if (state.status !== 'open') setApprovals(new Map());
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [session]);

  useEffect(() => {
    const offs = [
      admin.on('client.reload', () => location.reload()),
      admin.on('app.restarting', () => setRestarting(true)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);

  useEffect(() => {
    if (!restarting) return;
    return admin.onReconnect(() => location.reload());
  }, [admin, restarting]);

  return (
    <Context.Provider value={{ session, admin, restarting, features, appName, approvals }}>{children}</Context.Provider>
  );
}
