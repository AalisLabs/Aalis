import { useEffect, useState } from 'react';
import { SERVICE_ABSENT, useConnection, useConnectionState } from '../connection';
import './ConnectionBar.css';

// 主区顶部的连接状态：会话连接或管理连接断开、重连中时出现，重连上写「已恢复」两秒后收起，平时是空的。
// 会话服务不在（1013）不算断线，由会话区自己写明

const RECOVERED_MS = 2_000;

export function ConnectionBar() {
  const { session, admin, restarting } = useConnection();
  const sessionState = useConnectionState(session);
  const adminState = useConnectionState(admin);
  const lost =
    (sessionState.status === 'retrying' && sessionState.code !== SERVICE_ABSENT) || adminState.status === 'retrying';
  const healthy = sessionState.status === 'open' && adminState.status === 'open';
  const [notice, setNotice] = useState<'lost' | 'recovered'>();

  useEffect(() => {
    setNotice(current => (lost ? 'lost' : current !== 'lost' ? current : healthy ? 'recovered' : undefined));
  }, [lost, healthy]);

  useEffect(() => {
    if (notice !== 'recovered') return;
    const timer = setTimeout(() => setNotice(undefined), RECOVERED_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const [tone, text] = restarting
    ? ['warning', '正在重启，连上后自动刷新页面']
    : notice === 'lost'
      ? ['warning', '连接断开，正在重连…']
      : notice === 'recovered'
        ? ['success', '已恢复']
        : [undefined, ''];

  return (
    <div className="connection-bar" role="status" aria-label="连接状态" data-tone={tone}>
      {text}
    </div>
  );
}
