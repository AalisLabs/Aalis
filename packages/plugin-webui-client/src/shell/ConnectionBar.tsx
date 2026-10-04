import { useEffect, useState } from 'react';
import { SERVICE_ABSENT, useConnection, useConnectionState } from '../connection';
import './ConnectionBar.css';

// 窗口顶部的连接状态（横跨图标栏与各栏）：会话连接或管理连接断开、重连中时出现，重连上写「已恢复」两秒后收起，
// 平时是空的。会话服务不在（1013）不算断线，由会话区自己写明。连接一直被拒、页面的请求却正常时，提示检查反向代理

const RECOVERED_MS = 2_000;

export function ConnectionBar() {
  const { session, admin, restarting } = useConnection();
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

  const [tone, text] = restarting
    ? ['warning', '正在重启，连上后自动刷新页面']
    : notice === 'lost'
      ? [
          'warning',
          refused
            ? '连接一直被服务端拒绝，页面的其他请求却正常：经反向代理访问时，检查代理是否转发了原始的 Host 请求头'
            : '连接断开，正在重连…',
        ]
      : notice === 'recovered'
        ? ['success', '已恢复']
        : [undefined, ''];

  return (
    <div className="connection-bar" role="status" aria-label="连接状态" data-tone={tone}>
      {text}
    </div>
  );
}
