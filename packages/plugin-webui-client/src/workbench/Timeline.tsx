import type { SessionItem } from '@aalis/api-session-protocol';
import { Info, LoaderCircle, RotateCcw } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useBackground } from '../background/tasks';
import { Button } from '../components/Button';
import { Disclosure } from '../components/Disclosure';
import { Menu } from '../components/Menu';
import { useToast } from '../components/Toast';
import { type Approval, useConnection, useFeatures, useSessionClient } from '../connection';
import { clockTime, tokens } from '../format';
import { Markdown } from '../markdown/Markdown';
import { Attachments } from './Attachments';
import type { TimelineItem } from './live-session';
import { RewindDialog, type RewindTarget } from './Rewind';
import { awaitingApproval, displayOf, STOPPED, TOOL_ICONS, ToolCall } from './ToolCall';
import './Timeline.css';

// 时间线：条目按回合成段，同一回合的条目挨在一起，回合的结局（停止、出错、没有回复）写在段尾，回滚在段的右上角。
// 相隔超过 10 分钟的两段之间插一行时间；房间是多人对话，逐条写说话人与时间。
// 连续到 COLLAPSE_FROM 个的工具调用（夹着的思考一起）收成一行，按展示种类计数，点开才渲染里面的条目；其中有等审批、失败
// 或还在跑的（含转到后台、后台任务还在跑的），或者是还在跑的这一轮末尾那一组，不收，免得藏掉要看的东西；写给用户的正文不收。
// 什么都没做就没有回复的一轮只写一行「没有回复」，中间只隔着提问的几轮合成一行「N 轮没有回复」，房间不刷屏靠合并

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;

const TIME_GAP_MS = 10 * 60_000;
const OUTCOMES = { aborted: STOPPED, error: '这一轮出错了' } as const;
/** 连续这么多个工具调用收成一行 */
const COLLAPSE_FROM = 3;

/** 一段：一个回合的条目（turnId 相同、挨在一起），或一条不在回合里的条目 */
interface Block {
  key: string;
  turnId?: string;
  /** 回合条目：开始时带发起方，收尾时带结局；历史里没有 */
  turn?: Item<'turn'>;
  items: Exclude<TimelineItem, Item<'turn'>>[];
}

function toBlocks(items: readonly TimelineItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    const last = blocks.at(-1);
    const block =
      item.turnId !== undefined && last?.turnId === item.turnId
        ? last
        : { key: item.itemId, turnId: item.turnId, items: [] };
    if (block !== last) blocks.push(block);
    if (item.kind === 'turn') block.turn = item;
    else block.items.push(item);
  }
  return blocks;
}

const startOf = (block: Block) => (block.items[0] ?? block.turn)?.at ?? 0;
const endOf = (block: Block) => (block.items.at(-1) ?? block.turn)?.at ?? 0;

/** 什么都没做就没有回复的一轮 */
const quiet = (block: Block) => block.turn?.outcome === 'silent' && block.items.length === 0;
/** 只有提问的一段 */
const asking = (block: Block) => block.turnId === undefined && block.items.every(item => item.kind === 'user-message');

/**
 * 每段写几轮没有回复：没有回复的一轮写 1；什么都没做的几轮中间只隔着提问时并到最后一轮，前面的写 0（不显示）。
 * 不是没有回复的段为 undefined
 */
function silentCounts(blocks: readonly Block[]): Array<number | undefined> {
  const counts: Array<number | undefined> = blocks.map(block => (block.turn?.outcome === 'silent' ? 1 : undefined));
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

const KIND_NAMES = { command: '执行命令', 'file-change': '改动文件', generic: '其他' } as const;
const kindOf = (call: ToolCallItem) => displayOf(call)?.kind ?? 'generic';

function groupSummary(calls: readonly ToolCallItem[]): string {
  const counts = new Map<keyof typeof KIND_NAMES, number>();
  for (const call of calls) counts.set(kindOf(call), (counts.get(kindOf(call)) ?? 0) + 1);
  const total = calls.length;
  if (counts.size > 1) {
    return `调用了 ${total} 个工具：${[...counts].map(([kind, count]) => `${KIND_NAMES[kind]} ${count}`).join('、')}`;
  }
  const [kind] = counts.keys();
  if (kind === 'command') return `执行了 ${total} 条命令`;
  if (kind === 'file-change') return `改动了 ${total} 次文件`;
  return `调用了 ${total} 个工具`;
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

/** 一轮之前 owner 发的那条提问的文字：往前找到上一轮为止，中间隔着的通知不算 */
function promptOf(blocks: readonly Block[], index: number): string | undefined {
  for (let at = index - 1; at >= 0 && blocks[at].turnId === undefined; at--) {
    const [item] = blocks[at].items;
    if (item?.kind === 'user-message' && item.speaker.owner) return item.text || undefined;
  }
  return undefined;
}

export function Timeline(props: TimelineProps) {
  const { items, before, loadEarlier } = props;
  const blocks = useMemo(() => toBlocks(items), [items]);
  const silent = useMemo(() => silentCounts(blocks), [blocks]);
  const [rewinding, setRewinding] = useState<RewindTarget>();
  return (
    <section className="timeline" aria-label="对话">
      {before !== undefined && <Earlier load={loadEarlier} />}
      {blocks.map((block, index) => {
        if (silent[index] === 0) return null;
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
                setRewinding({ turnId: block.turnId as string, scope, prompt: promptOf(blocks, index) })
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
  const [error, setError] = useState<string>();
  return (
    <div className="timeline-earlier">
      <Button
        variant="text"
        busy={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          load()
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      >
        更早的消息
      </Button>
      {error && (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface TurnBlockProps extends TimelineProps {
  block: Block;
  last: boolean;
  /** 没有回复的轮数（合并了前面什么都没做的几轮） */
  silent?: number;
  onRewind(scope: RewindTarget['scope']): void;
}

function TurnBlock({ block, last, silent, onRewind, ...props }: TurnBlockProps) {
  const features = useFeatures();
  const { tasks } = useBackground();
  const outcome = block.turn?.outcome;
  const settled = block.turn === undefined || outcome !== undefined;
  const rewindable = features.rewind && block.turnId !== undefined && settled && !props.running && !quiet(block);
  const outcomeText =
    outcome === 'aborted' || outcome === 'error'
      ? OUTCOMES[outcome]
      : silent === undefined
        ? undefined
        : silent > 1
          ? `${silent} 轮没有回复`
          : '没有回复';
  return (
    <div className="turn">
      {rowsOf(block.items, !settled, taskId => tasks?.get(taskId)?.status === 'running').map(row =>
        'group' in row ? (
          <CallGroup key={row.group[0].itemId} group={row.group} last={last} {...props} />
        ) : (
          <Entry key={row.item.itemId} item={row.item} last={last} {...props} />
        ),
      )}
      {outcomeText && (
        <p className="turn-outcome" data-outcome={outcome}>
          {outcomeText}
        </p>
      )}
      {rewindable && (
        <div className="turn-rewind">
          <Menu
            label="回滚这一轮"
            icon={RotateCcw}
            items={[
              { label: '回滚文件改动', onSelect: () => onRewind('code') },
              { label: '回滚文件改动与这一轮对话', danger: true, onSelect: () => onRewind('code-and-chat') },
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
    case 'notice':
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

/** 说话人：owner 写「你」，房间成员写昵称，没有昵称写账号 */
function speakerName(speaker: Item<'user-message'>['speaker']): string {
  if (speaker.owner) return '你';
  return speaker.nickname || speaker.userId || speaker.platform;
}

function UserMessage({ item, room, sessionId }: { item: Item<'user-message'>; room: boolean; sessionId: string }) {
  return (
    <div className="message" data-from="user" data-room={room || undefined} title={clockTime(item.at)}>
      {room && (
        <p className="message-head">
          <span className="message-speaker">{speakerName(item.speaker)}</span>
          <time>{clockTime(item.at)}</time>
        </p>
      )}
      {item.speaker.source && <p className="message-meta">来自 {item.speaker.source}</p>}
      {item.text && <p className="message-text">{item.text}</p>}
      <Attachments attachments={item.attachments} sessionId={sessionId} />
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
    promptTokens === undefined ? undefined : `输入 ${tokens(promptTokens)}`,
    completionTokens === undefined ? undefined : `输出 ${tokens(completionTokens)}`,
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
      {streaming && <LoaderCircle className="spin message-streaming" aria-label="正在输出" />}
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
        {streaming ? '正在思考' : '思考'}
      </Disclosure>
      {open && (
        <div className="reasoning-text">
          <Markdown text={item.text} streaming={streaming} />
        </div>
      )}
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
  const [busy, setBusy] = useState(false);
  const Icon = streaming ? LoaderCircle : Info;
  return (
    <div className="notice">
      <Icon aria-hidden className={streaming ? 'spin' : undefined} />
      <div className="notice-body">
        <p>{item.text}</p>
        <Attachments attachments={item.attachments} sessionId={sessionId} />
      </div>
      {continuable && features.send && (
        <Button
          busy={busy}
          onClick={() => {
            setBusy(true);
            client
              .request('turn/continue', { sessionId })
              .catch((err: Error) => toast({ kind: 'danger', text: `继续失败：${err.message}` }))
              .finally(() => setBusy(false));
          }}
        >
          继续
        </Button>
      )}
    </div>
  );
}
