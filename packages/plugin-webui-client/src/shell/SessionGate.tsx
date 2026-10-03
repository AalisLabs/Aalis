import type { ReactNode } from 'react';
import { ButtonLink } from '../components/ButtonLink';
import { EmptyState } from '../components/EmptyState';
import { SERVICE_ABSENT, useConnectionState, useSessionClient } from '../connection';
import { usePlugins } from '../plugins/list';
import { paths } from '../routes';

/** 会话协议的服务名（契约 api-session-protocol 的 sessionProtocol）：按插件列表的 provides 找提供它的插件 */
const SESSION_PROTOCOL = 'session-protocol';

/** 会话服务在不在：有提供会话协议、正在运行的插件；插件列表还没取到（在取或取数出错）时为 undefined */
export function useSessionService(): boolean | undefined {
  const { plugins } = usePlugins();
  return plugins?.some(plugin => plugin.state === 'active' && plugin.provides.includes(SESSION_PROTOCOL));
}

/** 会话区：会话连接停止（握手被拒）或会话服务不在时写明原因，否则照常显示 */
export function SessionGate({ children }: { children: ReactNode }) {
  const state = useConnectionState(useSessionClient());
  if (state.status === 'stopped') return <EmptyState tone="danger" title="会话连接已停止" description={state.reason} />;
  if (state.status === 'retrying' && state.code === SERVICE_ABSENT) return <ServiceAbsent />;
  return children;
}

/** 链到提供会话协议的插件详情，没装时链到市场 */
export function ServiceAbsent() {
  const { plugins } = usePlugins();
  const provider = plugins?.find(plugin => plugin.provides.includes(SESSION_PROTOCOL));
  return (
    <EmptyState
      title="会话服务未启用"
      description="提供会话协议的插件启用后，这里会自动连上。"
      action={
        provider ? (
          <ButtonLink to={paths.plugin(provider.instanceId)}>去插件详情</ButtonLink>
        ) : (
          plugins && <ButtonLink to={paths.market}>去市场</ButtonLink>
        )
      }
    />
  );
}
