import type { SessionSummary } from '@aalis/api-session-protocol';
import type { HostPanelTab, PageRef } from '@aalis/api-webui';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, LoaderCircle, PanelRight } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useBack } from '../back';
import { TaskLog, taskName } from '../background/Background';
import { useBackground } from '../background/tasks';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { Menu } from '../components/Menu';
import { Panel } from '../components/Panel';
import { useToast } from '../components/Toast';
import { useConnection, useFeatures, useSessionClient } from '../connection';
import { AttentionSummary } from '../health/AttentionList';
import { composing, shortcutLabel } from '../keys';
import { RequestError, unlessLost } from '../protocol/session-client';
import { paths, useSessionAddress } from '../routes';
import { useSessionActions } from '../sessions/actions';
import { BackgroundStatus, backgroundLabel } from '../sessions/status';
import { useSettingRows } from '../settings/setting-rows';
import { SessionGate } from '../shell/SessionGate';
import { Main, usePhone, useShell } from '../shell/Shell';
import { Composer, type ComposerHandle, ComposerSettings, type OutgoingAttachment } from './Composer';
import { clearSent, NEW_SESSION } from './drafts';
import { useLiveSession } from './live-session';
import { useSessionTabs } from './panel-tabs';
import { SessionPanel } from './SessionPanel';
import { Timeline, useFold } from './Timeline';
import { UsageMeter, UsageTable } from './Usage';
import './Workbench.css';

// 会话工作台：头部（标题、种类与平台、回合进行中的运行指示、后台工作数、用量、全部折叠、会话面板、更多）、时间线、
// 输入框与右侧面板。子会话的标题前写各级父会话，可以逐层退回。后台任务的日志桌面上在「后台」标签里，手机上从底部全屏弹出。
// 首页与 /new 是空白的新会话：发出第一条消息时先建会话，再打开它；桌面的首页上方是「需要处理」的摘要（手机上它在第一层）

export function NewSession() {
  const client = useSessionClient();
  const navigate = useNavigate();
  const phone = usePhone();
  // 建好了、消息没发出去时，再发用同一个会话，不另建
  const created = useRef<string>(undefined);
  const send = async (content: string, attachments: OutgoingAttachment[]) => {
    created.current ??= (await client.request('session/create', {})).session.id;
    await client.request('turn/send', { sessionId: created.current, content, attachments });
    clearSent(NEW_SESSION, content);
    navigate(paths.session(created.current));
  };
  return (
    <Main>
      <Panel title="新会话" back={paths.home} footer={<Composer sessionId={NEW_SESSION} send={send} />}>
        {!phone && <AttentionSummary />}
        <SessionGate>{null}</SessionGate>
      </Panel>
    </Main>
  );
}

export function SessionRoute() {
  const { sessionId, tab, panel } = useSessionAddress() as { sessionId: string; tab?: HostPanelTab; panel?: PageRef };
  return <SessionView key={sessionId} sessionId={sessionId} tab={tab} panel={panel} />;
}

/** 子会话的标题前写各级父会话，点哪一级回到哪一级 */
function SessionTitle({ summary }: { summary: SessionSummary }) {
  if (!summary.ancestors) return summary.title;
  return (
    <span className="session-trail">
      {summary.ancestors.map(ancestor => (
        <Fragment key={ancestor.id}>
          <Link to={paths.session(ancestor.id)}>{ancestor.title}</Link>
          <ChevronRight aria-hidden />
        </Fragment>
      ))}
      <span>{summary.title}</span>
    </span>
  );
}

/** 头部的副信息：会话种类与平台。子会话的标题前已写着各级父会话，不另写 */
function kindOf(summary: SessionSummary): string | undefined {
  if (summary.kind === 'owner') return '我的会话';
  if (summary.kind === 'task') return undefined;
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
  const composer = useRef<ComposerHandle>(null);
  const fold = useFold();
  const { summary, usage, plan } = live;
  const { tasks, error: backgroundError } = useBackground();
  const own = useMemo(
    () => [...(tasks?.values() ?? [])].filter(task => task.sessionId === sessionId),
    [tasks, sessionId],
  );
  const running = summary?.running === true;
  const background = summary?.background ?? 0;
  // 任务表没取到时也可用：头部的「后台 N」点了要落到标签上，取数的错误与重试在标签里
  const tabs = useSessionTabs(sessionId, {
    plan,
    usage,
    background: (summary?.childCount ?? 0) > 0 || own.length > 0 || background > 0 || backgroundError !== undefined,
  });
  /** 打开着日志的后台任务 */
  const [log, setLog] = useState<string>();
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
    clearSent(sessionId, content);
  };
  // 手机上用量从底部弹出；别的宽度上是面板的「用量」标签，关着时先打开
  const openUsage = () => {
    if (phone) navigate(paths.session(sessionId, 'usage'));
    else tabs.show({ host: 'usage' });
    shell.reveal('right');
  };
  const closeUsage = () => goBack(paths.session(sessionId));
  // 「后台」标签：关着时先打开
  const openBackground = () => {
    tabs.show({ host: 'background' });
    shell.reveal('right');
  };
  const openLog = (taskId: string) => {
    setLog(taskId);
    if (!phone) openBackground();
  };
  const logged = phone ? own.find(task => task.id === log) : undefined;
  const parent = summary?.ancestors?.at(-1);
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
          ...(background > 0 ? [{ label: backgroundLabel(background), onSelect: openBackground }] : []),
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
          title={summary && <SessionTitle summary={summary} />}
          meta={summary && kindOf(summary)}
          back={parent ? paths.session(parent.id) : paths.home}
          anchor="end"
          banner={summary?.kind === 'room' && `你正在以 owner 身份在「${summary.title}」发言，按群的人设和能力运行`}
          actions={
            <>
              {running && <LoaderCircle className="spin" role="img" aria-label="正在运行" />}
              {background > 0 && !phone && (
                <button type="button" className="header-meter" title="打开「后台」标签" onClick={openBackground}>
                  <BackgroundStatus count={background} />
                </button>
              )}
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
              {menu && <Menu label="更多" items={menu} dot={phone && background > 0} />}
            </>
          }
          footer={
            <Composer
              ref={composer}
              sessionId={sessionId}
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
                  restore={prompt => composer.current?.restore(prompt)}
                  openLog={openLog}
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
        summary={summary}
        plan={plan}
        usage={usage}
        settings={settings}
        tasks={own}
        log={log}
        onLog={setLog}
      />
      {phone && tab === 'usage' && usage && (
        <Dialog open title="上下文用量" onClose={closeUsage} footer={<Button onClick={closeUsage}>关闭</Button>}>
          <UsageTable usage={usage} session={summary} />
        </Dialog>
      )}
      {logged && (
        <Dialog
          open
          size="full"
          title={taskName(logged)}
          onClose={() => setLog(undefined)}
          footer={<Button onClick={() => setLog(undefined)}>关闭</Button>}
        >
          <TaskLog task={logged} />
        </Dialog>
      )}
    </>
  );
}
