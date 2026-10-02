import type { SessionItem } from '@aalis/api-session-protocol';
import { FileText, Info, LoaderCircle, RotateCcw } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { Disclosure } from '../components/Disclosure';
import { Menu } from '../components/Menu';
import { useToast } from '../components/Toast';
import { type Approval, useFeatures, useSessionClient } from '../connection';
import { clockTime } from '../format';
import { Markdown } from '../markdown/Markdown';
import { isWebUrl, mediaUrl } from '../media';
import type { TimelineItem } from './live-session';
import { RewindDialog, type RewindTarget } from './Rewind';
import { ToolCall } from './ToolCall';
import './Timeline.css';

// 时间线：条目按回合成段，同一回合的条目挨在一起，回合的结局（停止、出错）写在段尾，回滚在段的右上角。
// 相隔超过 10 分钟的两段之间插一行时间；房间是多人对话，逐条写说话人与时间

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;
type Attachment = Item<'user-message'>['attachments'][number];

const TIME_GAP_MS = 10 * 60_000;
const OUTCOMES = { aborted: '已停止', error: '这一轮出错了' } as const;

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
}

export function Timeline(props: TimelineProps) {
  const { items, before, loadEarlier } = props;
  const blocks = useMemo(() => toBlocks(items), [items]);
  const [rewinding, setRewinding] = useState<RewindTarget>();
  return (
    <section className="timeline" aria-label="对话">
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
            <TurnBlock {...props} block={block} last={index === blocks.length - 1} onRewind={setRewinding} />
          </Fragment>
        );
      })}
      <RewindDialog sessionId={props.sessionId} target={rewinding} onClose={() => setRewinding(undefined)} />
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
        size="sm"
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
  onRewind(target: RewindTarget): void;
}

function TurnBlock({ block, last, onRewind, ...props }: TurnBlockProps) {
  const features = useFeatures();
  const outcome = block.turn?.outcome;
  const settled = block.turn === undefined || outcome !== undefined;
  const rewindable = features.rewind && block.turnId !== undefined && settled && !props.running;
  const outcomeText = outcome === 'aborted' || outcome === 'error' ? OUTCOMES[outcome] : undefined;
  return (
    <div className="turn">
      {block.items.map(item => (
        <Entry key={item.itemId} item={item} last={last} {...props} />
      ))}
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
              { label: '回滚文件改动', onSelect: () => onRewind({ turnId: block.turnId as string, scope: 'code' }) },
              {
                label: '回滚文件改动与这一轮对话',
                danger: true,
                onSelect: () => onRewind({ turnId: block.turnId as string, scope: 'code-and-chat' }),
              },
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
  const model = item.model?.model;
  return (
    <div
      className="message"
      data-from="agent"
      data-undelivered={item.undelivered ? '' : undefined}
      title={clockTime(item.at)}
    >
      {item.text && <Markdown text={item.text} streaming={streaming} />}
      <Attachments attachments={item.attachments} sessionId={sessionId} />
      {streaming && <LoaderCircle className="spin message-streaming" aria-label="正在输出" />}
      {(model || room || item.undelivered) && (
        <p className="message-meta">
          {room && <time>{clockTime(item.at)}</time>}
          {model && <span>{model}</span>}
          {item.undelivered && <span>{item.undelivered.reason}</span>}
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
          size="sm"
          busy={busy}
          onClick={() => {
            setBusy(true);
            client
              .request('turn/continue', { sessionId })
              .catch((err: Error) => toast({ kind: 'error', text: `继续失败：${err.message}` }))
              .finally(() => setBusy(false));
          }}
        >
          继续
        </Button>
      )}
    </div>
  );
}

/** 附件：图片、音频、视频按媒体地址取，外站图片经图片代理；文件按会话服务签发的句柄下载，没有句柄的只写名字 */
function Attachments({ attachments, sessionId }: { attachments: readonly Attachment[]; sessionId: string }) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((attachment, index) => (
        // 附件随条目整份替换，不会重排
        <AttachmentView key={index} attachment={attachment} sessionId={sessionId} />
      ))}
    </div>
  );
}

function AttachmentView({ attachment, sessionId }: { attachment: Attachment; sessionId: string }) {
  const { kind, src, name } = attachment;
  const media = src === undefined ? undefined : mediaUrl(src);
  if (kind === 'image' && src !== undefined && (media || isWebUrl(src))) {
    const url = media ?? `/api/proxy/image?${new URLSearchParams({ url: src })}`;
    return <img className="attachment-image" src={url} alt={name ?? '图片'} loading="lazy" />;
  }
  // biome-ignore lint/a11y/useMediaCaption: 会话里收发的音视频没有字幕文件可配
  if (kind === 'audio' && media) return <audio className="attachment-media" controls src={media} />;
  // biome-ignore lint/a11y/useMediaCaption: 同上
  if (kind === 'video' && media) return <video className="attachment-media" controls src={media} />;
  if (kind === 'file' && src !== undefined) {
    return (
      <a
        className="attachment-file"
        href={`/api/session-file?${new URLSearchParams({ sessionId, handle: src })}`}
        download={name ?? true}
      >
        <FileText aria-hidden />
        {name ?? '文件'}
      </a>
    );
  }
  if (src !== undefined && isWebUrl(src)) {
    return (
      <a className="attachment-file" href={src} target="_blank" rel="noopener noreferrer">
        <FileText aria-hidden />
        {name ?? src}
      </a>
    );
  }
  return (
    <span className="attachment-file">
      <FileText aria-hidden />
      {name ?? src ?? '附件'}
    </span>
  );
}
