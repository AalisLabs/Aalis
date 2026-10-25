import { sanitizeForCard } from '@aalis/api-approval';
import { BACKGROUND_TASK_NOTICE, type BackgroundTaskNoticeFacts } from '@aalis/api-tools';
import { Info, LoaderCircle, RotateCcw } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { ENDING_TONES, endingText } from '../background/Background';
import { useBackground } from '../background/tasks';
import { Button } from '../components/Button';
import { Disclosure } from '../components/Disclosure';
import { Menu } from '../components/Menu';
import { StatusText } from '../components/StatusText';
import { useToast } from '../components/Toast';
import { type Approval, useConnection, useFeatures, useSessionClient } from '../connection';
import { clockTime, compactNumber, speakerName } from '../format';
import { text, tr } from '../language';
import { Markdown } from '../markdown/Markdown';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import type { SessionItem } from '../protocol/session-client';
import { SessionsFetchError } from '../shell/SessionGate';
import { t } from '../texts';
import { Attachments } from './Attachments';
import type { TimelineItem } from './live-session';
import { RewindDialog, type RewindTarget } from './Rewind';
import { awaitingApproval, displayOf, TOOL_ICONS, ToolCall } from './ToolCall';
import './Timeline.css';

// 时间线：条目按回合成段，同一回合的条目挨在一起（被别的消息隔开时一轮分成几段），回合的结局（停止、出错、没有回复）写在这一轮
// 最后一段的末尾，回滚在段的右上角。进了一轮的输入（提问与通知）下面写它怎么进的（被点名或插话开了这一轮；并入这一轮），
// addressed 为空的开轮不写；没有输入的一轮（如空闲开话题）在第一段开头写来源。相隔超过 10 分钟的两段之间插一行时间；房间是
// 多人对话，逐条写说话人与时间。
// 连续到 COLLAPSE_FROM 个的工具调用（夹着的思考一起）收成一行，按展示种类计数，点开才渲染里面的条目；其中有等审批、失败
// 或还在跑的（含转到后台、后台任务还在跑的），或者是还在跑的这一轮最后一段末尾那一组，不收，免得藏掉要看的东西；写给用户的
// 正文不收。
// 没有回复、最后一段只有输入的一轮在输入下面只写一行「没有回复」，中间只隔着不在回合里的提问的几轮合成一行「N 轮没有回复」写在
// 最后一轮，被并掉的几轮照常显示输入，房间不刷屏靠合并。
// 后台任务的结束通知按它带的事实画成一行状态，写给模型的那句话不显示；指令的回复是一张卡，只认段落与列表，其余通知是一行

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;

/** 指令回复的通知种类：api-session-protocol 的 COMMAND_REPLY_TOPIC */
const COMMAND_REPLY = 'command-reply';
const TIME_GAP_MS = 10 * 60_000;
const OUTCOMES = { aborted: t('stopped'), error: t('turnError') };
/** 连续这么多个工具调用收成一行 */
const COLLAPSE_FROM = 3;

/** 一段：一个回合挨在一起的条目（turnId 相同），或一条不在回合里的条目 */
interface Block {
  key: string;
  turnId?: string;
  /** 这一轮的回合条目（推在哪一段都一样）：带来源，收尾时带结局；历史里没有回合记录的没有 */
  turn?: Item<'turn'>;
  /** 是这一轮的最后一段：结局写在它的末尾 */
  ending: boolean;
  /** 这一轮没有回复、只有输入（按整轮判，各段相同）：没有可回滚的 */
  idle: boolean;
  /** 这一轮没有输入时，第一段开头写的来源 */
  source?: string;
  items: Exclude<TimelineItem, Item<'turn'>>[];
}

/** 进了一轮的输入：提问与通知带进入方式 */
const isInput = (item: TimelineItem) =>
  (item.kind === 'user-message' || item.kind === 'notice') && item.entry !== undefined;

/**
 * 同一 turnId 相邻的条目成一段。回合条目不占段：实时推送里它随这一轮的第一条推出，历史里排在最后落库的那条之后，与这一轮的
 * 条目之间夹着别的消息时它单独那一段不要；这一轮没有别的条目时它自成一段
 */
function toBlocks(items: readonly TimelineItem[]): Block[] {
  const runs: Array<Pick<Block, 'key' | 'turnId' | 'items'>> = [];
  const turns = new Map<string, Item<'turn'>>();
  for (const item of items) {
    if (item.kind === 'turn') turns.set(item.turnId, item);
    const last = runs.at(-1);
    const run =
      item.turnId !== undefined && last?.turnId === item.turnId
        ? last
        : { key: item.itemId, turnId: item.turnId, items: [] };
    if (run !== last) runs.push(run);
    if (item.kind !== 'turn') run.items.push(item);
  }
  const filled = new Set(runs.flatMap(run => (run.items.length > 0 ? [run.turnId] : [])));
  const kept = runs.filter(run => run.items.length > 0 || !filled.has(run.turnId));
  const lastOf = new Map(kept.map((run, index) => [run.turnId, index]));
  const withInputs = new Set(items.filter(isInput).map(item => item.turnId));
  /** 有输入以外条目的回合 */
  const busy = new Set(items.filter(item => item.kind !== 'turn' && !isInput(item)).map(item => item.turnId));
  const opened = new Set<string>();
  return kept.map((run, index) => {
    if (run.turnId === undefined) return { ...run, ending: false, idle: false };
    const turn = turns.get(run.turnId);
    const first = !opened.has(run.turnId);
    opened.add(run.turnId);
    return {
      ...run,
      turn,
      ending: lastOf.get(run.turnId) === index,
      idle: turn?.outcome === 'silent' && !busy.has(run.turnId),
      source: first && !withInputs.has(run.turnId) ? turn?.source : undefined,
    };
  });
}

const startOf = (block: Block) => (block.items[0] ?? block.turn)?.at ?? 0;
const endOf = (block: Block) => (block.items.at(-1) ?? block.turn)?.at ?? 0;

/** 这一段末尾写的结局：只写在这一轮的最后一段 */
const outcomeOf = (block: Block) => (block.ending ? block.turn?.outcome : undefined);
/** 没有回复、这一段只有输入的一轮 */
const quiet = (block: Block) => outcomeOf(block) === 'silent' && block.items.every(isInput);
/** 只有不在回合里的提问的一段 */
const asking = (block: Block) => block.turnId === undefined && block.items.every(item => item.kind === 'user-message');

/**
 * 每段写几轮没有回复：没有回复的一轮写 1；只有输入的几轮中间只隔着不在回合里的提问时并到最后一轮，前面的写 0（不写结局，输入
 * 照常显示）。不是没有回复的段为 undefined
 */
function silentCounts(blocks: readonly Block[]): Array<number | undefined> {
  const counts: Array<number | undefined> = blocks.map(block => (outcomeOf(block) === 'silent' ? 1 : undefined));
  let previous: number | undefined;
  blocks.forEach((block, index) => {
    if (quiet(block)) {
      if (previous !== undefined) {
        counts[index] = (counts[previous] as number) + 1;
        counts[previous] = 0;
      }
      previous = index;
    } else if (!asking(block)) previous = undefined;
  });
  return counts;
}

/** 段尾写的结局：停止、出错，或没有回复（合并了几轮的写轮数，被并掉的不写） */
function outcomeLine(block: Block, silent: number | undefined): string | undefined {
  const outcome = outcomeOf(block);
  if (outcome === 'aborted' || outcome === 'error') return text(OUTCOMES[outcome]);
  if (!silent) return undefined;
  return silent > 1 ? tr('silentTurns', { count: silent }) : tr('noReply');
}

/** 段里写得出东西：有条目、要写来源或结局（刚推出回合条目、还没有条目的一轮，与被并掉的、只有回合条目的一轮写不出） */
const drawn = (block: Block, silent: number | undefined) =>
  block.items.length > 0 || block.source !== undefined || outcomeLine(block, silent) !== undefined;

type ToolCallItem = Item<'tool-call'>;
type Process = ToolCallItem | Item<'reasoning'>;

/** 一段里的一项：一个条目，或收成一行的一组工具调用与夹着的思考 */
type Row = { item: Exclude<TimelineItem, Item<'turn'>> } | { group: Process[] };

/** 收起会藏掉要看的东西；taskRunning 是转到后台的调用的任务还在跑 */
const holding = (call: ToolCallItem, taskRunning: (taskId: string) => boolean) =>
  awaitingApproval(call) ||
  call.status === 'failed' ||
  call.status === 'generating' ||
  call.status === 'running' ||
  (call.taskId !== undefined && taskRunning(call.taskId));

function rowsOf(items: Block['items'], live: boolean, taskRunning: (taskId: string) => boolean): Row[] {
  const rows: Row[] = [];
  let run: Process[] = [];
  const flush = (atEnd: boolean) => {
    const calls = run.filter(item => item.kind === 'tool-call');
    const held = calls.some(call => holding(call, taskRunning));
    if (calls.length >= COLLAPSE_FROM && !held && !(live && atEnd)) rows.push({ group: run });
    else rows.push(...run.map(item => ({ item })));
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool-call' || item.kind === 'reasoning') run.push(item);
    else {
      flush(false);
      rows.push({ item });
    }
  }
  flush(true);
  return rows;
}

const KIND_COUNTS = {
  command: 'callKindCommand',
  'file-change': 'callKindFileChange',
  generic: 'callKindOther',
} as const;
const kindOf = (call: ToolCallItem) => displayOf(call)?.kind ?? 'generic';

function groupSummary(calls: readonly ToolCallItem[]): string {
  const counts = new Map<keyof typeof KIND_COUNTS, number>();
  for (const call of calls) counts.set(kindOf(call), (counts.get(kindOf(call)) ?? 0) + 1);
  const count = calls.length;
  if (counts.size > 1) {
    return tr('callsMixed', { count, kinds: [...counts].map(([kind, n]) => t(KIND_COUNTS[kind], { count: n })) });
  }
  const [kind] = counts.keys();
  if (kind === 'command') return tr('callsCommands', { count });
  if (kind === 'file-change') return tr('callsFileChanges', { count });
  return tr('callsTools', { count });
}

/** 工具卡与思考的折叠：默认收起，「全部展开」「全部折叠」改默认并清掉逐张的设置 */
export function useFold() {
  const [all, setAll] = useState(false);
  const [single, setSingle] = useState<ReadonlyMap<string, boolean>>(new Map());
  return {
    all,
    isOpen: (itemId: string) => single.get(itemId) ?? all,
    toggle: (itemId: string) => setSingle(map => new Map(map).set(itemId, !(map.get(itemId) ?? all))),
    setAll: (open: boolean) => {
      setAll(open);
      setSingle(new Map());
    },
  };
}

type Fold = ReturnType<typeof useFold>;

interface TimelineProps {
  sessionId: string;
  /** 房间：逐条写说话人与时间 */
  room: boolean;
  items: readonly TimelineItem[];
  streaming: ReadonlySet<string>;
  /** 按 id 找这次调用未结的审批：推给这条连接的，或订阅快照里带来的 */
  approvalOf(approvalId: string): Approval | undefined;
  running: boolean;
  fold: Fold;
  before?: string;
  loadEarlier(): Promise<void>;
  /** 连对话一起回滚之后，把那一轮 owner 发的文字放回输入框 */
  restore(prompt: string): void;
  /** 打开一个后台任务的日志 */
  openLog(taskId: string): void;
}

/** 这一轮 owner 的各条输入（开轮的与插进来的）的文字，空行连起来 */
function promptOf(items: readonly TimelineItem[], turnId: string): string | undefined {
  const asked = items.flatMap(item =>
    item.kind === 'user-message' && item.turnId === turnId && item.speaker.owner && item.text ? [item.text] : [],
  );
  return asked.join('\n\n') || undefined;
}

export function Timeline(props: TimelineProps) {
  const { items, before, loadEarlier } = props;
  const { blocks, silent } = useMemo(() => {
    const all = toBlocks(items);
    const counts = silentCounts(all);
    const shown = all.flatMap((block, index) => (drawn(block, counts[index]) ? [index] : []));
    return { blocks: shown.map(index => all[index] as Block), silent: shown.map(index => counts[index]) };
  }, [items]);
  const [rewinding, setRewinding] = useState<RewindTarget>();
  return (
    <section className="timeline" aria-label={tr('conversation')}>
      {before !== undefined && <Earlier load={loadEarlier} />}
      {blocks.map((block, index) => {
        const previous = blocks[index - 1];
        const gap = !previous || startOf(block) - endOf(previous) > TIME_GAP_MS;
        return (
          <Fragment key={block.key}>
            {gap && (
              <p className="timeline-time">
                <time dateTime={new Date(startOf(block)).toISOString()}>{clockTime(startOf(block))}</time>
              </p>
            )}
            <TurnBlock
              {...props}
              block={block}
              last={index === blocks.length - 1}
              silent={silent[index]}
              onRewind={scope =>
                setRewinding({
                  turnId: block.turnId as string,
                  scope,
                  prompt: promptOf(items, block.turnId as string),
                  // 按整轮判：一轮在跑时插进来的消息把它隔成几段，回滚撤销的是整轮
                  backgrounded: items.some(
                    item => item.turnId === block.turnId && item.kind === 'tool-call' && item.taskId !== undefined,
                  ),
                })
              }
            />
          </Fragment>
        );
      })}
      <RewindDialog
        sessionId={props.sessionId}
        target={rewinding}
        restore={props.restore}
        onClose={() => setRewinding(undefined)}
      />
    </section>
  );
}

function Earlier({ load }: { load(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const run = () => {
    setBusy(true);
    setError(undefined);
    load()
      .catch((err: Error) => setError(err))
      .finally(() => setBusy(false));
  };
  return (
    <div className="timeline-earlier">
      <Button variant="text" busy={busy} onClick={run}>
        {tr('earlierMessages')}
      </Button>
      {error && <SessionsFetchError what={tr('earlierMessages')} error={error} retry={run} />}
    </div>
  );
}

interface TurnBlockProps extends TimelineProps {
  block: Block;
  last: boolean;
  /** 没有回复的轮数（合并了前面只有输入的几轮）；被并掉的为 0 */
  silent?: number;
  onRewind(scope: RewindTarget['scope']): void;
}

function TurnBlock({ block, last, silent, onRewind, ...props }: TurnBlockProps) {
  const features = useFeatures();
  const { tasks } = useBackground();
  const settled = block.turn === undefined || block.turn.outcome !== undefined;
  const rewindable = features.rewind && block.turnId !== undefined && settled && !props.running && !block.idle;
  const outcomeText = outcomeLine(block, silent);
  return (
    <div className="turn">
      {block.source !== undefined && <p className="message-meta">{tr('messageFrom', { source: block.source })}</p>}
      {rowsOf(block.items, !settled && block.ending, taskId => tasks?.get(taskId)?.status === 'running').map(row =>
        'group' in row ? (
          <CallGroup key={row.group[0].itemId} group={row.group} last={last} {...props} />
        ) : (
          <Entry key={row.item.itemId} item={row.item} last={last} {...props} />
        ),
      )}
      {outcomeText && (
        <p className="turn-outcome" data-outcome={outcomeOf(block)}>
          {outcomeText}
        </p>
      )}
      {rewindable && (
        <div className="turn-rewind">
          <Menu
            label={tr('rewindTurn')}
            icon={RotateCcw}
            items={[
              { label: tr('rewindCode'), onSelect: () => onRewind('code') },
              { label: tr('rewindCodeAndChat'), danger: true, onSelect: () => onRewind('code-and-chat') },
            ]}
          />
        </div>
      )}
    </div>
  );
}

interface EntryProps extends TimelineProps {
  item: Exclude<TimelineItem, Item<'turn'>>;
  last: boolean;
}

/** 收成一行的工具调用：点开才渲染里面的条目，开合与工具卡一样跟着「全部展开」「全部折叠」 */
function CallGroup({ group, last, ...props }: TimelineProps & { group: Process[]; last: boolean }) {
  const key = `calls/${group[0].itemId}`;
  const open = props.fold.isOpen(key);
  const calls = group.filter(item => item.kind === 'tool-call');
  const kinds = new Set(calls.map(kindOf));
  const Icon = kinds.size === 1 ? TOOL_ICONS[kindOf(calls[0])] : TOOL_ICONS.generic;
  return (
    <div className="tool-group">
      <button type="button" className="tool-line" aria-expanded={open} onClick={() => props.fold.toggle(key)}>
        <Icon aria-hidden />
        <span className="tool-line-text">{groupSummary(calls)}</span>
      </button>
      {open && (
        <div className="tool-group-items">
          {group.map(item => (
            <Entry key={item.itemId} item={item} last={last} {...props} />
          ))}
        </div>
      )}
    </div>
  );
}

function Entry({ item, last, ...props }: EntryProps) {
  const { sessionId, room, streaming, fold } = props;
  switch (item.kind) {
    case 'user-message':
      return <UserMessage item={item} room={room} sessionId={sessionId} />;
    case 'agent-message':
      return <AgentMessage item={item} room={room} sessionId={sessionId} streaming={streaming.has(item.itemId)} />;
    case 'reasoning':
      return (
        <Reasoning
          item={item}
          streaming={streaming.has(item.itemId)}
          open={fold.isOpen(item.itemId)}
          onToggle={() => fold.toggle(item.itemId)}
        />
      );
    case 'tool-call':
      return (
        <ToolCall
          item={item}
          open={fold.isOpen(item.itemId)}
          onToggle={() => fold.toggle(item.itemId)}
          approval={item.approvalId === undefined ? undefined : props.approvalOf(item.approvalId)}
          openLog={props.openLog}
        />
      );
    case 'notice': {
      if (item.topic === COMMAND_REPLY) {
        return (
          <div className="command-reply" role="note" aria-label={tr('commandReply')}>
            <Markdown text={item.text} plain />
            <Attachments attachments={item.attachments} sessionId={sessionId} />
          </div>
        );
      }
      const facts = taskNoticeFacts(item);
      if (facts) {
        return <TaskNotice facts={facts} taskId={item.noticeId} entry={entryLine(item)} openLog={props.openLog} />;
      }
      return (
        <Notice
          item={item}
          sessionId={sessionId}
          streaming={streaming.has(item.itemId)}
          continuable={item.canContinue === true && last && !props.running}
        />
      );
    }
  }
}

/**
 * 输入（提问与通知）怎么进的这一轮：被点名或插话开了这一轮（addressed 为真或假），或并入这一轮；addressed 为空的开轮（如
 * WebUI 会话里的提问）与不在回合里的没有
 */
function entryLine({ entry, addressed }: Item<'user-message' | 'notice'>): string | undefined {
  if (entry === 'joined') return tr('entryJoined');
  if (entry !== 'opened' || addressed === undefined) return undefined;
  return tr(addressed ? 'entryOpenedAddressed' : 'entryOpenedInterjection');
}

function UserMessage({ item, room, sessionId }: { item: Item<'user-message'>; room: boolean; sessionId: string }) {
  const entry = entryLine(item);
  return (
    <div className="message" data-from="user" data-room={room || undefined} title={clockTime(item.at)}>
      {room && (
        <p className="message-head">
          <span className="message-speaker">{speakerName(item.speaker)}</span>
          <time>{clockTime(item.at)}</time>
        </p>
      )}
      {item.speaker.source && <p className="message-meta">{tr('messageFrom', { source: item.speaker.source })}</p>}
      {item.text && <p className="message-text">{item.text}</p>}
      <Attachments attachments={item.attachments} sessionId={sessionId} />
      {entry && <p className="message-meta">{entry}</p>}
    </div>
  );
}

interface AgentMessageProps {
  item: Item<'agent-message'>;
  room: boolean;
  sessionId: string;
  streaming: boolean;
}

function AgentMessage({ item, room, sessionId, streaming }: AgentMessageProps) {
  const { appName } = useConnection();
  const { model, promptTokens, completionTokens } = item.model ?? {};
  const meta = [
    model,
    promptTokens === undefined ? undefined : tr('tokensIn', { count: compactNumber(promptTokens) }),
    completionTokens === undefined ? undefined : tr('tokensOut', { count: compactNumber(completionTokens) }),
    item.undelivered?.reason,
  ].filter((text): text is string => Boolean(text));
  return (
    <div
      className="message"
      data-from="agent"
      data-undelivered={item.undelivered ? '' : undefined}
      title={clockTime(item.at)}
    >
      {room && (
        <p className="message-head">
          <span className="message-speaker">{appName}</span>
          <time>{clockTime(item.at)}</time>
        </p>
      )}
      {item.text && <Markdown text={item.text} streaming={streaming} />}
      <Attachments attachments={item.attachments} sessionId={sessionId} />
      {streaming && <LoaderCircle className="spin message-streaming" aria-label={tr('writing')} />}
      {meta.length > 0 && (
        <p className="message-meta">
          {meta.map(text => (
            <span key={text}>{text}</span>
          ))}
        </p>
      )}
    </div>
  );
}

interface ReasoningProps {
  item: Item<'reasoning'>;
  streaming: boolean;
  open: boolean;
  onToggle(): void;
}

function Reasoning({ item, streaming, open, onToggle }: ReasoningProps) {
  return (
    <div className="reasoning">
      <Disclosure expanded={open} onToggle={onToggle}>
        {streaming ? tr('reasoningStreaming') : tr('reasoning')}
      </Disclosure>
      {open && (
        <div className="reasoning-text">
          <Markdown text={item.text} streaming={streaming} />
        </div>
      )}
    </div>
  );
}

/** 后台任务结束通知带的事实；不是结束通知或事实不合 api-tools 约定的形状时没有，按普通通知画 */
function taskNoticeFacts({ topic, facts }: Item<'notice'>): BackgroundTaskNoticeFacts | undefined {
  if (topic !== BACKGROUND_TASK_NOTICE || !facts) return undefined;
  const { tool, status, durationMs, exitCode } = facts;
  if (typeof tool !== 'string' || (status !== 'completed' && status !== 'failed') || typeof durationMs !== 'number') {
    return undefined;
  }
  return { tool, status, durationMs, ...(typeof exitCode === 'number' ? { exitCode } : {}) };
}

/** 结束通知：一行写工具名、结局与用时，下面写它怎么进的这一轮；登记表里还有这个任务时点开它的日志 */
function TaskNotice({
  facts,
  taskId,
  entry,
  openLog,
}: {
  facts: BackgroundTaskNoticeFacts;
  taskId?: string;
  entry?: string;
  openLog(taskId: string): void;
}) {
  const { tasks } = useBackground();
  const task = taskId === undefined ? undefined : tasks?.get(taskId);
  const ending = endingText(facts, facts.durationMs);
  return (
    <div className="task-notice">
      <button type="button" className="tool-line" disabled={!task} onClick={task && (() => openLog(task.id))}>
        <TOOL_ICONS.generic aria-hidden />
        <span className="tool-line-text">{tr('backgroundTaskNamed', { tool: sanitizeForCard(facts.tool) })}</span>
        <span className="tool-line-status" title={ending}>
          <StatusText state={ENDING_TONES[facts.status]}>{ending}</StatusText>
        </span>
      </button>
      {entry && <p className="message-meta">{entry}</p>}
    </div>
  );
}

interface NoticeProps {
  item: Item<'notice'>;
  sessionId: string;
  streaming: boolean;
  /** 工具调用达到上限、可以让她继续：只给最后一段里的，回合不在跑时 */
  continuable: boolean;
}

function Notice({ item, sessionId, streaming, continuable }: NoticeProps) {
  const client = useSessionClient();
  const features = useFeatures();
  const toast = useToast();
  const sessions = useProvider(SESSION_PROTOCOL);
  const [busy, setBusy] = useState(false);
  const Icon = streaming ? LoaderCircle : Info;
  const entry = entryLine(item);
  return (
    <div className="notice">
      <Icon aria-hidden className={streaming ? 'spin' : undefined} />
      <div className="notice-body">
        <p>{item.text}</p>
        <Attachments attachments={item.attachments} sessionId={sessionId} />
        {entry && <p className="message-meta">{entry}</p>}
      </div>
      {continuable && features.send && (
        <Button
          busy={busy}
          onClick={() => {
            setBusy(true);
            client
              .request('turn/continue', { sessionId })
              .catch((err: Error) =>
                toast({
                  kind: 'danger',
                  text: tr('actionFailed', { action: t('continueTurn'), error: err.message }),
                  source: sessions,
                }),
              )
              .finally(() => setBusy(false));
          }}
        >
          {tr('continueTurn')}
        </Button>
      )}
    </div>
  );
}
