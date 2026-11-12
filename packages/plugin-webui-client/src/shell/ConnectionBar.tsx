import { useEffect, useState } from 'react';
import { SERVICE_ABSENT, useConnection, useConnectionState } from '../connection';
import { tr } from '../language';
import './ConnectionBar.css';

// 窗口顶部的连接状态（横跨图标栏与各栏）：会话连接或管理连接断开、重连中时出现，重连上写「已恢复」两秒后收起，
// 平时是空的。会话服务不在（1013）不算断线，由会话区自己写明。连接一直被拒、页面的请求却正常时，提示检查反向代理

const RECOVERED_MS = 2_000;

export function ConnectionBar() {
  const { session, admin, serverClosed } = useConnection();
  const sessionState = useConnectionState(session);
  const adminState = useConnectionState(admin);
  const lost =
    (sessionState.status === 'retrying' && sessionState.code !== SERVICE_ABSENT) || adminState.status === 'retrying';
  const healthy = sessionState.status === 'open' && adminState.status === 'open';
  const refused = sessionState.refused === true || adminState.refused === true;
  const [notice, setNotice] = useState<'lost' | 'recovered'>();

  useEffect(() => {
    setNotice(current => (lost ? 'lost' : current !== 'lost' ? current : healthy ? 'recovered' : undefined));
  }, [lost, healthy]);

  useEffect(() => {
    if (notice !== 'recovered') return;
    const timer = setTimeout(() => setNotice(undefined), RECOVERED_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const [tone, text] = serverClosed
    ? ['warning', tr('connectionServerClosed')]
    : notice === 'lost'
      ? ['warning', refused ? tr('connectionRefused') : tr('connectionReconnecting')]
      : notice === 'recovered'
        ? ['success', tr('connectionRecovered')]
        : [undefined, ''];

  return (
    <div className="connection-bar" role="status" aria-label={tr('connectionStatus')} data-tone={tone}>
      {text}
    </div>
  );
}
