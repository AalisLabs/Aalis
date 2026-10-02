import { type SessionClient, unlessLost } from './session-client';

// 在场上报：页面可见、且最近 10 分钟有键盘或指针活动算在场（服务端看最近一次为真的上报在不在 10 分钟内）。
// 有活动时按需报在场，转到后台即报不在场。重连后若仍算在场就立即重报，否则一次闪断后要等下一次输入才被判在场，
// 这期间推来的审批会按「没人在场」结算。服务端从上报的时刻算 10 分钟，所以报在场之后，到最近一次活动满 10 分钟时
// 还没有新活动就报不在场，在场不会比真实的活动多撑。打开页面本身不算活动。

export const PRESENCE_WINDOW_MS = 10 * 60_000;
/** 持续有活动时，距这条连接上次报在场满这么久才再报，保证最近一次上报总在服务端的窗口之内 */
const REFRESH_MS = 60_000;
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const;

export function trackPresence(client: SessionClient): () => void {
  let lastActivity = Number.NEGATIVE_INFINITY;
  /** 这条连接上最近一次报在场的时刻；报过不在场或换了连接后为空 */
  let reportedAt: number | undefined;
  /** 报在场之后，到最近一次活动满 10 分钟的那一刻 */
  let lapse: ReturnType<typeof setTimeout> | undefined;

  const visible = () => document.visibilityState === 'visible';
  const recentlyActive = () => visible() && Date.now() - lastActivity <= PRESENCE_WINDOW_MS;

  function report(active: boolean): void {
    reportedAt = active ? Date.now() : undefined;
    clearTimeout(lapse);
    if (active) arm();
    client.request('presence/update', { active }).catch(unlessLost);
  }

  function arm(): void {
    const lapsed = () => {
      // 连接断了：服务端已不算这条连接在场，重连时重新判
      if (client.state.status !== 'open') return;
      if (recentlyActive()) arm();
      else report(false);
    };
    lapse = setTimeout(lapsed, lastActivity + PRESENCE_WINDOW_MS - Date.now() + 1);
  }

  const onActivity = () => {
    lastActivity = Date.now();
    if (!visible() || client.state.status !== 'open') return;
    if (reportedAt === undefined || lastActivity - reportedAt >= REFRESH_MS) report(true);
  };

  const onVisibility = () => {
    if (client.state.status !== 'open') return;
    if (!visible()) report(false);
    else if (recentlyActive()) report(true);
  };

  const offReady = client.onReady(() => {
    reportedAt = undefined;
    clearTimeout(lapse);
    if (recentlyActive()) report(true);
  });
  for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onActivity, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    clearTimeout(lapse);
    offReady();
    for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onActivity, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
