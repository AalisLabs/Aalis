import type { SessionSummary } from '@aalis/api-session-protocol';
import type { HostPanelTab, PageRef } from '@aalis/api-webui';
import { ChevronsDownUp, ChevronsUpDown, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useBack } from '../back';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { Menu } from '../components/Menu';
import { Panel } from '../components/Panel';
import { useToast } from '../components/Toast';
import { useConnection, useFeatures, useSessionClient } from '../connection';
import { composing, shortcutLabel } from '../keys';
import { RequestError, unlessLost } from '../protocol/session-client';
import { paths, useSessionAddress } from '../routes';
import { useSessionActions } from '../sessions/actions';
import { useSettingRows } from '../settings/setting-rows';
import { SessionGate } from '../shell/SessionGate';
import { Main, usePhone, useShell } from '../shell/Shell';
import { Composer, ComposerSettings, type OutgoingAttachment } from './Composer';
import { useLiveSession } from './live-session';
import { useSessionTabs } from './panel-tabs';
import { SessionPanel } from './SessionPanel';
import { Timeline, useFold } from './Timeline';
import { UsageMeter, UsageTable } from './Usage';

// 会话工作台：头部（标题、种类与平台、用量、全部折叠、会话面板、更多）、时间线、输入框与右侧面板。
// 首页与 /new 是空白的新会话：发出第一条消息时先建会话，再打开它

export function NewSession() {
  const client = useSessionClient();
  const navigate = useNavigate();
  // 建好了、消息没发出去时，再发用同一个会话，不另建
  const created = useRef<string>(undefined);
  const send = async (content: string, attachments: OutgoingAttachment[]) => {
    created.current ??= (await client.request('session/create', {})).session.id;
    await client.request('turn/send', { sessionId: created.current, content, attachments });
    navigate(paths.session(created.current));
  };
  return (
    <Main>
      <Panel title="新会话" back={paths.home} footer={<Composer send={send} />}>
        <SessionGate>{null}</SessionGate>
      </Panel>
    </Main>
  );
}

export function SessionRoute() {
  const { sessionId, tab, panel } = useSessionAddress() as { sessionId: string; tab?: HostPanelTab; panel?: PageRef };
  return <SessionView key={sessionId} sessionId={sessionId} tab={tab} panel={panel} />;
}

function kindOf(summary: SessionSummary): string {
  if (summary.kind === 'owner') return '我的会话';
  if (summary.kind === 'task') return '子任务';
  return [summary.audience === 'private' ? '私聊' : '群', summary.platform].filter(Boolean).join(' · ');
}

function SessionView({ sessionId, tab, panel }: { sessionId: string; tab?: HostPanelTab; panel?: PageRef }) {
  const client = useSessionClient();
  const { approvals } = useConnection();
  const features = useFeatures();
  const phone = usePhone();
  const shell = useShell();
  const navigate = useNavigate();
  const goBack = useBack();
  const actions = useSessionActions();
  const toast = useToast();
  const live = useLiveSession(sessionId);
  const settings = useSettingRows(useMemo(() => ({ sessionId }), [sessionId]));
  const fold = useFold();
  const { summary, usage, plan } = live;
  const tabs = useSessionTabs(sessionId, { plan, usage });
  const running = summary?.running === true;
  const turnId = live.items.findLast(item => item.kind === 'turn' && item.outcome === undefined)?.turnId;

  const stop = useCallback(() => {
    client.request('turn/abort', { sessionId, ...(turnId === undefined ? {} : { turnId }) }).catch((err: Error) => {
      // 这一轮已经结束了
      if (err instanceof RequestError && err.reason === 'expected-turn-mismatch') return;
      toast({ kind: 'danger', text: `停止失败：${err.message}` });
    });
  }, [client, sessionId, turnId, toast]);

  // Esc 停止正在跑的一轮；弹层（对话框、菜单、抽屉）先拦下自己的 Esc
  useEffect(() => {
    if (!running) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || composing(event)) return;
      if (event.target instanceof Element && event.target.closest('dialog')) return;
      event.preventDefault();
      stop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [running, stop]);

  // 看着会话时，她的回复不算未读（只有「我的」区有未读）
  const unread = summary?.unread === true;
  useEffect(() => {
    if (!unread) return;
    const markSeen = () => {
      if (document.visibilityState === 'visible') client.request('session/markSeen', { sessionId }).catch(unlessLost);
    };
    markSeen();
    document.addEventListener('visibilitychange', markSeen);
    return () => document.removeEventListener('visibilitychange', markSeen);
  }, [client, sessionId, unread]);

  if (live.removed) return <Navigate to={paths.home} replace />;

  const send = async (content: string, attachments: OutgoingAttachment[]) => {
    await client.request('turn/send', { sessionId, content, attachments });
  };
  // 手机上用量从底部弹出；别的宽度上是面板的「用量」标签，关着时先打开
  const openUsage = () => {
    if (phone) navigate(paths.session(sessionId, 'usage'));
    else tabs.show({ host: 'usage' });
    shell.reveal('right');
  };
  const closeUsage = () => goBack(paths.session(sessionId));
  const compress = () =>
    client
      .request('session/compress', { sessionId })
      .catch((err: Error) => toast({ kind: 'danger', text: `压缩失败：${err.message}` }));

  const foldLabel = fold.all ? '全部折叠' : '全部展开';
  const toggleFold = () => fold.setAll(!fold.all);
  // 手机的顶栏右边只放用量与「更多」，全部展开与会话面板收进「更多」
  const menu = summary && [
    ...(phone
      ? [
          { label: foldLabel, onSelect: toggleFold },
          // 标签都关了时停在面板上，从「+」打开
          { label: '会话面板', onSelect: () => navigate(tabs.pathOf((tabs.bar[0] ?? tabs.add[0]).ref)) },
        ]
      : []),
    { label: '改名', onSelect: () => actions.rename(summary) },
    summary.archived
      ? { label: '恢复', onSelect: () => actions.unarchive([summary]) }
      : { label: '归档', onSelect: () => actions.archive([summary]) },
    ...(features.compress ? [{ label: '压缩对话', onSelect: () => void compress() }] : []),
    { label: '删除', danger: true, onSelect: () => actions.remove([summary]) },
  ];

  return (
    <>
      <Main>
        <Panel
          title={summary?.title ?? ''}
          meta={summary && kindOf(summary)}
          back={paths.home}
          anchor="end"
          banner={summary?.kind === 'room' && `你正在以 owner 身份在「${summary.title}」发言，按群的人设和能力运行`}
          actions={
            <>
              {usage && <UsageMeter usage={usage} onOpen={openUsage} />}
              {!phone && (
                <>
                  <IconButton
                    icon={fold.all ? ChevronsDownUp : ChevronsUpDown}
                    label={foldLabel}
                    onClick={toggleFold}
                  />
                  <IconButton
                    icon={PanelRight}
                    label="会话面板"
                    shortcut={shortcutLabel('toggleRight')}
                    onClick={() => shell.toggle('right')}
                  />
                </>
              )}
              {menu && <Menu label="更多" items={menu} />}
            </>
          }
          footer={
            <Composer
              send={send}
              onStop={running ? stop : undefined}
              switches={
                settings.rows && (
                  <ComposerSettings
                    rows={settings.rows}
                    update={settings.update}
                    settingsPath={paths.session(sessionId, 'settings')}
                    openSettings={() => {
                      tabs.show({ host: 'settings' });
                      shell.reveal('right');
                    }}
                  />
                )
              }
            />
          }
        >
          <SessionGate>
            {live.error ? (
              <EmptyState
                tone="danger"
                title="会话没能打开"
                description={live.error.message}
                action={<Button onClick={live.retry}>重试</Button>}
              />
            ) : (
              summary && (
                <Timeline
                  sessionId={sessionId}
                  room={summary.kind === 'room'}
                  items={live.items}
                  streaming={live.streaming}
                  approvalOf={id => approvals.get(id) ?? live.approvals.get(id)}
                  running={running}
                  fold={fold}
                  before={live.before}
                  loadEarlier={live.loadEarlier}
                />
              )
            )}
          </SessionGate>
        </Panel>
      </Main>
      <SessionPanel
        sessionId={sessionId}
        tabs={tabs}
        tab={tab}
        panel={panel}
        plan={plan}
        usage={usage}
        settings={settings}
      />
      {phone && tab === 'usage' && usage && (
        <Dialog open title="上下文用量" onClose={closeUsage} footer={<Button onClick={closeUsage}>关闭</Button>}>
          <UsageTable usage={usage} />
        </Dialog>
      )}
    </>
  );
}
