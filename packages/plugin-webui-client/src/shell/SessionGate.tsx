import type { ReactNode } from 'react';
import { ButtonLink } from '../components/ButtonLink';
import { EmptyState } from '../components/EmptyState';
import { FetchError } from '../components/FetchError';
import { SERVICE_ABSENT, useConnectionState, useSessionClient } from '../connection';
import { SESSION_PROTOCOL, useFindPlugin, usePlugins, useProvider } from '../plugins/list';
import { byRoot, fixLink, pluginName, statusLine, unmetText } from '../plugins/status';
import { paths } from '../routes';

/** 会话服务在不在：有提供会话协议、正在运行的插件；插件列表还没取到（在取或取数出错）时为 undefined */
export function useSessionService(): boolean | undefined {
  const { plugins } = usePlugins();
  return plugins?.some(plugin => plugin.state === 'active' && plugin.provides.includes(SESSION_PROTOCOL));
}

/**
 * 会话区：会话连接停止（握手被拒）或会话服务不在时写明原因，否则照常显示。quiet 时不写原因、什么都不显示：桌面上会话列表
 * 与主区同时在，原因只写在主区
 */
export function SessionGate({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  const state = useConnectionState(useSessionClient());
  const reason =
    state.status === 'stopped' ? (
      <EmptyState tone="danger" title="会话连接已停止" description={state.reason} />
    ) : state.status === 'retrying' && state.code === SERVICE_ABSENT ? (
      <ServiceAbsent />
    ) : undefined;
  if (!reason) return children;
  return quiet ? null : reason;
}

/**
 * 提供会话协议的插件缺服务时写它的链与根（记忆后端坏了，首页就看得到根因）；在等、失败或待配置时写它的状态与原因；停用着、
 * 启用着时写启用后自动连上。按钮与「需要处理」里它那一行同一个去处；没装时链到市场
 */
export function ServiceAbsent() {
  const { plugins } = usePlugins();
  const find = useFindPlugin();
  const provider = plugins?.find(plugin => plugin.provides.includes(SESSION_PROTOCOL));
  const description =
    provider && provider.lacking.length > 0
      ? byRoot(provider.lacking)
          .map(unmet => `${pluginName(provider.instanceId, find)} → ${unmetText(unmet, find)}`)
          .join('；')
      : provider && (provider.state === 'error' || provider.waiting.length > 0)
        ? statusLine(provider, find)
        : '提供会话协议的插件启用后，这里会自动连上。';
  const fix = provider && fixLink(provider.instanceId, provider, find);
  return (
    <EmptyState
      title="会话服务未启用"
      description={description}
      action={
        fix ? (
          <ButtonLink to={fix.to}>{fix.label}</ButtonLink>
        ) : (
          plugins && <ButtonLink to={paths.market}>去市场</ButtonLink>
        )
      }
    />
  );
}

interface SessionsFetchErrorProps {
  what: string;
  error: Error;
  retry(): void;
  stale?: boolean;
}

/** 经会话协议取的一块没取到：写成一行，「查看日志」去看提供会话协议的实例 */
export function SessionsFetchError({ what, error, retry, stale }: SessionsFetchErrorProps) {
  const sessions = useProvider(SESSION_PROTOCOL);
  return <FetchError what={what} error={error} retry={retry} stale={stale} inline source={sessions} />;
}
