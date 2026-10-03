import type { ReactNode } from 'react';
import { EmptyState } from '../components/EmptyState';
import { SERVICE_ABSENT, useConnectionState, useSessionClient } from '../connection';

/** 会话区：会话连接停止（握手被拒）或会话服务不在时写明原因，否则照常显示 */
export function SessionGate({ children }: { children: ReactNode }) {
  const state = useConnectionState(useSessionClient());
  if (state.status === 'stopped') return <EmptyState tone="danger" title="会话连接已停止" description={state.reason} />;
  if (state.status === 'retrying' && state.code === SERVICE_ABSENT) {
    return <EmptyState title="会话服务未启用" description="提供会话协议的插件启用后，这里会自动连上。" />;
  }
  return children;
}
