import { sanitizeForCard } from '@aalis/api-approval';
import type { BackgroundTask, SessionSummary } from '@aalis/api-session-protocol';
import { ArrowLeft, CircleStop, ScrollText } from 'lucide-react';
import { type ReactNode, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { CopyButton } from '../components/CopyButton';
import { Disclosure } from '../components/Disclosure';
import { IconButton } from '../components/IconButton';
import { List, ListItem } from '../components/List';
import { StatusText } from '../components/StatusText';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { duration, tokens } from '../format';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import { paths } from '../routes';
import { useSessionList } from '../sessions/live-list';
import { SessionsFetchError } from '../shell/SessionGate';
import { usePhone } from '../shell/Shell';
import { openableLocalUrl } from './loopback';
import { useBackground } from './tasks';
import './Background.css';

// 后台工作：子会话（来自会话树）与转到后台的工具调用（来自后台任务登记）。会话面板的「后台」标签分这两组，在跑的在前、
// 结束的收进默认折叠的「已结束」；时间线里转了后台的工具卡与运行状况的「正在运行」用同样的状态与行，结束通知用同样的结局写法。
// 只画会话树与登记表推来的状态：按了停止之后等推送，不先自行标成已停止。命令种类画成等宽的一行命令，其余写工具名。
// 日志在桌面上就在标签里打开（嫌窄就拖宽面板），手机上从底部全屏弹出；都不另开地址

/** 命令放不下时中间省略，末尾留这么多个字 */
const COMMAND_TAIL = 16;
/** 日志只留末尾这么多字，同登记表里输出缓冲的大小 */
const LOG_KEEP = 64 * 1024;
/** 走着的耗时每秒更新 */
const TICK_MS = 1000;

const commandOf = (task: BackgroundTask) => (task.display?.kind === 'command' ? task.display : undefined);

/** 任务的名字：命令的第一行，别的种类是工具名 */
export const taskName = (task: BackgroundTask) =>
  sanitizeForCard(commandOf(task)?.command.split('\n')[0] ?? task.label);

/** 子会话在跑：它的回合，或它与各级子会话里有后台工作 */
const active = (session: SessionSummary) => session.running || session.background > 0;

/** 子会话结束了：不在跑，也跑完过一轮（刚建、还没开始的不算） */
const ended = (session: SessionSummary) => !active(session) && session.lastTurn !== undefined;

/** 在跑的在前（后起的在上），结束的按结束时间、晚的在上 */
function splitTasks(tasks: readonly BackgroundTask[]): [BackgroundTask[], BackgroundTask[]] {
  const running = tasks.filter(task => task.status === 'running').sort((a, b) => b.startedAt - a.startedAt);
  const ended = tasks
    .filter(task => task.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return [running, ended];
}

/** 整页一个每秒走一次的时钟：有人看着才走，各处走着的耗时同一拍更新，同一个任务在几处显示的耗时不会对不上 */
const clock = { now: Date.now(), listeners: new Set<() => void>(), timer: undefined as number | undefined };

function subscribeClock(listener: () => void): () => void {
  clock.listeners.add(listener);
  if (clock.timer === undefined) {
    clock.now = Date.now();
    clock.timer = window.setInterval(() => {
      clock.now = Date.now();
      for (const each of clock.listeners) each();
    }, TICK_MS);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size > 0) return;
    clearInterval(clock.timer);
    clock.timer = undefined;
  };
}

const useNow = () => useSyncExternalStore(subscribeClock, () => clock.now);

/** 从 since 走到此刻的耗时 */
function Elapsed({ since }: { since: number }) {
  return duration(Math.max(0, useNow() - since));
}

const ENDINGS = { completed: '完成', stopped: '已停止', aborted: '已中断' } as const;
const ENDING_TONES = { completed: undefined, failed: 'error', stopped: 'inactive', aborted: 'inactive' } as const;

/** 结束了的任务的结局 */
interface TaskEnd {
  status: Exclude<BackgroundTask['status'], 'running'>;
  exitCode?: number;
}

/** 结局写成一个词（失败的命令有退出码时写退出码），后面接用时；失败用危险色 */
export function Ending({ end: { status, exitCode }, took }: { end: TaskEnd; took?: number }) {
  const ending =
    status !== 'failed' ? ENDINGS[status] : exitCode === undefined || exitCode === 0 ? '失败' : `退出码 ${exitCode}`;
  return (
    <StatusText state={ENDING_TONES[status]}>{ending + (took === undefined ? '' : ` · ${duration(took)}`)}</StatusText>
  );
}

/** 任务的状态写成一句：在跑的转动、写走着的耗时；结束的写结局与用时 */
export function TaskStatus({ task }: { task: BackgroundTask }) {
  if (task.status === 'running') {
    return (
      <StatusText state="running">
        <Elapsed since={task.startedAt} />
      </StatusText>
    );
  }
  const took = task.endedAt === undefined ? undefined : task.endedAt - task.startedAt;
  return <Ending end={{ status: task.status, exitCode: task.exitCode }} took={took} />;
}

/** 停止按钮：不弹确认，请求在途时不能再按，失败写进 Toast；停下来的状态等推送 */
export function StopButton({ label, stop }: { label: string; stop(): Promise<unknown> }) {
  const toast = useToast();
  const sessions = useProvider(SESSION_PROTOCOL);
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      icon={CircleStop}
      label={label}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        stop()
          .catch((err: Error) => toast({ kind: 'danger', text: `停止失败：${err.message}`, source: sessions }))
          .finally(() => setBusy(false));
      }}
    />
  );
}

function StopTask({ task }: { task: BackgroundTask }) {
  const client = useSessionClient();
  return (
    <StopButton
      label={`停止「${taskName(task)}」`}
      stop={() => client.request('background/stop', { taskId: task.id })}
    />
  );
}

/** 输出的最后一行：弱化色，里面的本机网址在页面经回环地址打开时给「打开」 */
function LastLine({ line }: { line: string }) {
  const url = openableLocalUrl(line);
  return (
    <p className="task-last">
      <span>{line}</span>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer">
          打开
        </a>
      )}
    </p>
  );
}

/** 时间线里转了后台的工具卡下面一行：最后一行，「输出」与在跑时的「停止」 */
export function TaskFoot({ task, onOutput }: { task: BackgroundTask; onOutput(): void }) {
  return (
    <div className="task-foot">
      {task.lastLine !== undefined && <LastLine line={task.lastLine} />}
      <IconButton icon={ScrollText} label={`输出「${taskName(task)}」`} onClick={onOutput} />
      {task.status === 'running' && <StopTask task={task} />}
    </div>
  );
}

/**
 * 命令写成等宽的一行，放不下时中间省略（末尾留 COMMAND_TAIL 个字）；悬停看全，点开折行显示全文。
 * 拆成两段的字读屏会在中间断开，读屏名字另给全文
 */
function Command({ command }: { command: string }) {
  const [open, setOpen] = useState(false);
  const text = sanitizeForCard(command);
  const line = text.replace(/\s+/g, ' ');
  const cut = Math.max(0, line.length - COMMAND_TAIL);
  return (
    <button
      type="button"
      className="task-command"
      title={text}
      aria-label={text}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {open ? (
        text
      ) : (
        <>
          <span>{line.slice(0, cut)}</span>
          <span>{line.slice(cut)}</span>
        </>
      )}
    </button>
  );
}

/** 工作目录写最后两级，前面的省略 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

/**
 * 后台任务的一行：第一行是命令（或工具名），占满整行；第二行是状态与耗时、工作目录与动作；下面是最后一行，以及失败或
 * 中断的原因
 */
function TaskRow({ task, onOutput }: { task: BackgroundTask; onOutput?(): void }) {
  const command = commandOf(task);
  const cwd = command?.cwd === undefined ? undefined : sanitizeForCard(command.cwd);
  return (
    <li className="task">
      {command ? <Command command={command.command} /> : <span className="task-name">{taskName(task)}</span>}
      <div className="task-meta">
        <TaskStatus task={task} />
        {cwd !== undefined && (
          <span className="task-cwd" title={cwd}>
            {shortPath(cwd)}
          </span>
        )}
        <span className="task-actions">
          {onOutput && <IconButton icon={ScrollText} label={`输出「${taskName(task)}」`} onClick={onOutput} />}
          {task.status === 'running' && <StopTask task={task} />}
        </span>
      </div>
      {task.lastLine !== undefined && <LastLine line={task.lastLine} />}
      {task.reason !== undefined && (
        <p className="task-reason" data-status={task.status}>
          {task.reason}
        </p>
      )}
    </li>
  );
}

/** 子会话的状态：在跑、出错（写原因）、被停止、完成；还没跑完一轮的没有 */
function childState(session: SessionSummary): { text: string; tone?: 'running' | 'error' | 'inactive' } | undefined {
  if (active(session)) return { text: '运行中', tone: 'running' };
  if (session.error) return { text: session.reason ?? '出错', tone: 'error' };
  if (session.lastTurn?.outcome === 'aborted') return { text: '已停止', tone: 'inactive' };
  return session.lastTurn && { text: '完成' };
}

/** 子会话的一行：状态、标题、耗时（建会话到最近一轮结束，在跑的走到此刻）与 token；点行打开它，在跑的可以停 */
function ChildRow({ session, children }: { session: SessionSummary; children?: ReactNode }) {
  const client = useSessionClient();
  const state = childState(session);
  const ended = session.lastTurn?.endedAt;
  const took = active(session) ? (
    <Elapsed since={session.createdAt} />
  ) : (
    ended !== undefined && duration(ended - session.createdAt)
  );
  return (
    <ListItem
      to={paths.session(session.id)}
      title={session.title}
      detail={
        (state || took || session.tokens) && (
          <span className="child-detail">
            {state && <StatusText state={state.tone}>{state.text}</StatusText>}
            {took && <span>{took}</span>}
            {session.tokens && <span>{tokens(session.tokens.input + session.tokens.output)} token</span>}
          </span>
        )
      }
      marker={session.error ? 'error' : undefined}
      action={
        active(session) && (
          <StopButton
            label={`停止「${session.title}」`}
            stop={() =>
              Promise.all([
                client.request('turn/abort', { sessionId: session.id }),
                client.request('background/stopAll', { sessionId: session.id }),
              ])
            }
          />
        )
      }
    >
      {children}
    </ListItem>
  );
}

/** 结束的收在默认折叠的「已结束」里，没有就不出现 */
function Ended({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div>
      <Disclosure expanded={open} onToggle={() => setOpen(!open)}>
        已结束 · {count}
      </Disclosure>
      {open && children}
    </div>
  );
}

/** 一个子会话与它下面各级的子会话：有子会话的再往下取一层，在跑的在前 */
function ChildNode({ session }: { session: SessionSummary }) {
  return <ChildRow session={session}>{session.childCount > 0 && <Children parentId={session.id} />}</ChildRow>;
}

function Children({ parentId }: { parentId: string }) {
  const list = useSessionList({ parentId });
  if (list.error) return <SessionsFetchError what="子会话" error={list.error} retry={list.retry} />;
  if (!list.sessions?.length) return null;
  const rows = [...list.sessions.filter(active), ...list.sessions.filter(child => !active(child))];
  return (
    <List label="子会话">
      {rows.map(child => (
        <ChildNode key={child.id} session={child} />
      ))}
    </List>
  );
}

function ChildGroup({ session }: { session: SessionSummary }) {
  const list = useSessionList({ parentId: session.id });
  const children = list.sessions ?? [];
  const open = [...children.filter(active), ...children.filter(child => !active(child) && !ended(child))];
  const done = children.filter(ended);
  return (
    <Block title={`子会话 · ${session.childCount}`}>
      {list.error && (
        <SessionsFetchError what="子会话" error={list.error} retry={list.retry} stale={list.sessions !== undefined} />
      )}
      {open.length > 0 && (
        <List label="子会话">
          {open.map(child => (
            <ChildNode key={child.id} session={child} />
          ))}
        </List>
      )}
      <Ended count={done.length}>
        <List label="已结束的子会话">
          {done.map(child => (
            <ChildNode key={child.id} session={child} />
          ))}
        </List>
      </Ended>
    </Block>
  );
}

function TaskGroup({ tasks, onLog }: { tasks: readonly BackgroundTask[]; onLog(taskId: string): void }) {
  const [running, ended] = splitTasks(tasks);
  const row = (task: BackgroundTask) => <TaskRow key={task.id} task={task} onOutput={() => onLog(task.id)} />;
  return (
    <Block title={`工具调用 · ${tasks.length}`}>
      {running.length > 0 && <List label="在跑的工具调用">{running.map(row)}</List>}
      <Ended count={ended.length}>
        <List label="已结束的工具调用">{ended.map(row)}</List>
      </Ended>
    </Block>
  );
}

interface BackgroundTabProps {
  session: SessionSummary;
  /** 这个会话的后台任务 */
  tasks: readonly BackgroundTask[];
  /** 打开着日志的任务 */
  log?: string;
  onLog(taskId?: string): void;
}

/** 会话面板的「后台」标签：顶上「全部停止」（有在跑的才有），下面子会话与工具调用两组；桌面上日志在这里打开 */
export function BackgroundTab({ session, tasks, log, onLog }: BackgroundTabProps) {
  const client = useSessionClient();
  const toast = useToast();
  const sessions = useProvider(SESSION_PROTOCOL);
  const phone = usePhone();
  const background = useBackground();
  const [stopping, setStopping] = useState(false);
  const shown = phone ? undefined : tasks.find(task => task.id === log);
  if (shown) {
    return (
      <TaskLog
        key={shown.id}
        task={shown}
        lead={
          <>
            <IconButton icon={ArrowLeft} label="回到列表" onClick={() => onLog(undefined)} />
            <span className="task-log-title">{taskName(shown)}</span>
          </>
        }
      />
    );
  }
  return (
    <div className="background">
      {session.background > 0 && (
        <Button
          icon={CircleStop}
          busy={stopping}
          onClick={() => {
            setStopping(true);
            client
              .request('background/stopAll', { sessionId: session.id })
              .catch((err: Error) => toast({ kind: 'danger', text: `停止失败：${err.message}`, source: sessions }))
              .finally(() => setStopping(false));
          }}
        >
          全部停止
        </Button>
      )}
      {background.error && (
        <SessionsFetchError
          what="后台任务"
          error={background.error}
          retry={background.retry}
          stale={background.tasks !== undefined}
        />
      )}
      {session.childCount > 0 && <ChildGroup session={session} />}
      {tasks.length > 0 && <TaskGroup tasks={tasks} onLog={onLog} />}
    </div>
  );
}

interface LogState {
  text: string;
  /** 至今的输出总字数，下次取新增的从它开始；还没取到时没有 */
  end?: number;
  /** 前面有输出已不在缓冲里 */
  truncated: boolean;
  error?: Error;
}

/**
 * 一个任务的输出：先取缓冲里的全部，之后最后输出时间或状态变了就取新增的接在后面，只留末尾 LOG_KEEP 字。
 * 最新的在底部：停在底部时跟着走，往上翻看时不被拽走。lead 放在顶上一行的最前面
 */
export function TaskLog({ task, lead }: { task: BackgroundTask; lead?: ReactNode }) {
  const client = useSessionClient();
  const [log, setLog] = useState<LogState>({ text: '', truncated: false });
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  // 取数一个接一个：后一次从前一次取到的位置接着取
  const queue = useRef(Promise.resolve());
  const end = useRef<number>(undefined);

  useEffect(() => {
    queue.current = queue.current.then(async () => {
      try {
        const after = end.current;
        const output = await client.request('background/output', {
          taskId: task.id,
          ...(after === undefined ? {} : { after }),
        });
        end.current = output.end;
        setLog(current => {
          const text = output.truncated ? output.text : current.text + output.text;
          return {
            text: text.slice(-LOG_KEEP),
            end: output.end,
            truncated: current.truncated || output.truncated || text.length > LOG_KEEP,
          };
        });
      } catch (err) {
        setLog(current => ({ ...current, error: err as Error }));
      }
    });
  }, [client, task.id, task.lastOutputAt, task.status, attempt]);

  return (
    <div className="task-log">
      <div className="task-log-bar">
        {lead}
        <TaskStatus task={task} />
        {task.status === 'running' && <StopTask task={task} />}
        <CopyButton text={log.text} label="复制输出" />
      </div>
      {log.truncated && <p className="task-log-note">前面的输出已丢弃，只留着最后一段</p>}
      {log.error && <SessionsFetchError what="输出" error={log.error} retry={retry} stale={log.end !== undefined} />}
      {log.end !== undefined && log.text === '' && <p className="task-log-note">还没有输出</p>}
      <div className="task-log-scroll" data-anchor="end">
        <pre className="task-log-text">{log.text}</pre>
      </div>
    </div>
  );
}

/** 运行状况里一个会话下面在跑的：它在跑的后台任务，与在跑的子会话（各自再往下照样列） */
export function RunningBelow({ session }: { session: SessionSummary }) {
  const { tasks } = useBackground();
  const own = [...(tasks?.values() ?? [])].filter(task => task.sessionId === session.id && task.status === 'running');
  return (
    <>
      {own.length > 0 && (
        <List label="在跑的后台任务">
          {own.map(task => (
            <TaskRow key={task.id} task={task} />
          ))}
        </List>
      )}
      {session.childCount > 0 && <RunningChildren parentId={session.id} />}
    </>
  );
}

function RunningChildren({ parentId }: { parentId: string }) {
  const list = useSessionList({ parentId });
  if (list.error) return <SessionsFetchError what="子会话" error={list.error} retry={list.retry} />;
  const running = list.sessions?.filter(active) ?? [];
  if (running.length === 0) return null;
  return (
    <List label="在跑的子会话">
      {running.map(child => (
        <ChildRow key={child.id} session={child}>
          <RunningBelow session={child} />
        </ChildRow>
      ))}
    </List>
  );
}
