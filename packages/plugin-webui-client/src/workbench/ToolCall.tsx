import { sanitizeForCard } from '@aalis/api-approval';
import type { SessionItem } from '@aalis/api-session-protocol';
import { FilePen, LoaderCircle, SquareTerminal, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/Button';
import { type Approval, useSessionClient } from '../connection';
import { clockTime, duration } from '../format';
import { RequestError } from '../protocol/session-client';
import './ToolCall.css';

// 工具卡：一行写动作与对象、右侧写状态，点开看细节。按会话服务解析好的展示种类（display）渲染，没声明的走通用卡、
// 逐字列出参数；前端不认识任何工具名。要 owner 批准的调用，审批卡挂在这一行下面；结算后收成行上的一句。
// 卡上来自参数的文字一律经审批契约的清洗（控制符、双向控制符、零宽字符都显示出来），免得看到的和要执行的不一样

type ToolCallItem = Extract<SessionItem, { kind: 'tool-call' }>;
type Settlement = NonNullable<ToolCallItem['settlement']>;

/** 一行里命令最多显示这么多个字，完整的在细节里 */
const SUMMARY_LIMIT = 60;
/** 审批卡上命令框的行数，与 ToolCall.css 里 .approval-command 的限高一致 */
const COMMAND_ROWS = 6;
/** 审批卡上参数与 diff 框限高 20rem，按 12/18 的字号约 17 行 */
const BLOCK_ROWS = 17;
/** 估算折行时一行按这么多个等宽字算 */
const CHARS_PER_ROW = 40;

const SETTLED_BY: Record<Exclude<Settlement['source'], 'owner'>, string> = {
  absent: '没人在场',
  timeout: '等待超时',
  ineligible: '这一轮不能产生审批',
  subtask: '子任务里的审批不转交',
  'rate-limit': '审批太频繁',
  'turn-ended': '回合已结束',
  shutdown: '审批服务已停止',
};

/** 结算写成一句：结果、原因与时间 */
function settlementText({ state, source, at }: Settlement): string {
  const time = clockTime(at);
  if (state === 'approved') return `已批准 · ${time}`;
  if (source === 'owner') return `已拒绝 · ${time}`;
  return `${state === 'cancelled' ? '已撤销' : '已按拒绝'} · ${SETTLED_BY[source]} · ${time}`;
}

function summaryOf(item: ToolCallItem): string {
  const { display } = item;
  if (display?.kind === 'command') {
    const line = display.command.split('\n')[0];
    return `执行 ${sanitizeForCard(line, SUMMARY_LIMIT)}`;
  }
  if (display?.kind === 'file-change') {
    return `${display.removed === undefined ? '写入' : '修改'} ${sanitizeForCard(display.path)}`;
  }
  return `调用 ${sanitizeForCard(item.name)}`;
}

const ICONS = { command: SquareTerminal, 'file-change': FilePen } as const;

interface ToolCallProps {
  item: ToolCallItem;
  open: boolean;
  onToggle(): void;
  /** 这次调用未结的审批：推给这条连接的，或订阅快照里带来的 */
  approval?: Approval;
}

export function ToolCall({ item, open, onToggle, approval }: ToolCallProps) {
  const waiting = item.approvalId !== undefined && item.settlement === undefined;
  const Icon = item.display ? ICONS[item.display.kind] : Wrench;
  const parts = [
    item.settlement && settlementText(item.settlement),
    item.status === 'failed' && '失败',
    item.sentToRoom && '已发到群',
    item.status === 'completed' && item.durationMs !== undefined && duration(item.durationMs),
  ].filter(part => typeof part === 'string');
  const tone = waiting ? 'attention' : item.status === 'failed' ? 'danger' : undefined;
  return (
    <div className="tool-call">
      <button type="button" className="tool-line" aria-expanded={open} onClick={onToggle}>
        <Icon aria-hidden />
        <span className="tool-line-text">{summaryOf(item)}</span>
        <span className="tool-line-status" data-tone={tone}>
          {waiting ? (
            '等你批准'
          ) : item.status === 'running' ? (
            <>
              <LoaderCircle aria-hidden className="spin" />
              运行中
            </>
          ) : (
            parts.join(' · ')
          )}
        </span>
      </button>
      {open && <ToolDetails item={item} />}
      {waiting && approval && <ApprovalCard approval={approval} />}
    </div>
  );
}

/** 改动的一侧逐行加上正负号，显示前清洗；没有这一侧时没有行 */
const side = (text: string | undefined, sign: '-' | '+') =>
  text === undefined
    ? []
    : sanitizeForCard(text)
        .split('\n')
        .map(line => sign + line);

function ToolDetails({ item }: { item: ToolCallItem }) {
  const { display } = item;
  const output = item.output ?? item.result;
  return (
    <div className="tool-details">
      {display?.kind === 'command' && (
        <dl className="tool-facts">
          <dt>命令</dt>
          <dd>
            <code>{sanitizeForCard(display.command)}</code>
          </dd>
          {display.cwd !== undefined && (
            <>
              <dt>目录</dt>
              <dd>{sanitizeForCard(display.cwd)}</dd>
            </>
          )}
        </dl>
      )}
      {display?.kind === 'file-change' && (
        <>
          <p className="tool-path">{sanitizeForCard(display.path)}</p>
          <Diff lines={[...side(display.removed, '-'), ...side(display.added, '+')]} />
        </>
      )}
      {!display && <pre className="tool-output">{sanitizeForCard(JSON.stringify(item.args, null, 2))}</pre>}
      {output !== undefined && (display?.kind !== 'file-change' || item.status === 'failed') && (
        <pre className="tool-output">{output}</pre>
      )}
    </div>
  );
}

/** 改动的两侧，一行一个元素：删的以 - 开头，加的以 + 开头 */
function Diff({ lines: rows }: { lines: string[] }) {
  return (
    <pre className="tool-output tool-diff">
      {rows.map((row, index) => (
        // 行随条目整份替换，不会重排
        <span key={index} data-change={row.startsWith('-') ? 'removed' : 'added'}>
          {row}
        </span>
      ))}
    </pre>
  );
}

/** 卡上限高的框放不下时写明全长：行数超出，或按每行的字数估会折出更多行（长串空白也算） */
function Extent({ text, rows }: { text: string; rows: number }) {
  const lines = text.split('\n').length;
  const chars = [...text].length;
  if (lines <= rows && chars <= rows * CHARS_PER_ROW) return null;
  return (
    <p className="approval-meta">
      共 {lines} 行 · {chars} 字，超出的部分在框内滚动
    </p>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const client = useSessionClient();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { facts } = approval;
  const tool = sanitizeForCard(approval.tool);
  const title =
    facts.command !== undefined ? `要执行一条命令 · ${tool}` : facts.diff ? `要改动文件 · ${tool}` : `要调用 ${tool}`;
  const command = facts.command === undefined ? undefined : sanitizeForCard(facts.command);
  const patch = facts.diff?.patch === undefined ? undefined : sanitizeForCard(facts.diff.patch);
  const params =
    Object.keys(facts.params).length > 0 ? sanitizeForCard(JSON.stringify(facts.params, null, 2)) : undefined;
  const closeNote = () => {
    setNoting(false);
    setNote('');
  };

  const respond = (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(undefined);
    const reason = decision === 'deny' && note.trim() ? { note: note.trim() } : {};
    client
      .request('approval/respond', {
        approvalId: approval.id,
        decision,
        contentHash: approval.contentHash,
        ...reason,
      })
      .catch((err: Error) => {
        // 已经结算（别处先答了、超时了）：结算的推送随后就到
        if (!(err instanceof RequestError && err.reason === 'approval-settled')) setError(err.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="approval" aria-label="审批">
      <p className="approval-title">{title}</p>
      {command !== undefined && (
        <>
          <pre className="approval-command">{command}</pre>
          <Extent text={command} rows={COMMAND_ROWS} />
        </>
      )}
      {facts.cwd !== undefined && (
        <p className="approval-meta">
          目录 <span>{sanitizeForCard(facts.cwd)}</span>
        </p>
      )}
      {facts.diff && (
        <>
          <p className="approval-path">{sanitizeForCard(facts.diff.path)}</p>
          {patch === undefined ? (
            <p className="approval-meta">路径或内容疑似含密钥，只显示文件名</p>
          ) : (
            <>
              <Diff lines={patch.split('\n')} />
              <Extent text={patch} rows={BLOCK_ROWS} />
            </>
          )}
        </>
      )}
      {params !== undefined && (
        <>
          {(command !== undefined || facts.diff) && <p className="approval-meta">其他参数</p>}
          <pre className="approval-params">{params}</pre>
          <Extent text={params} rows={BLOCK_ROWS} />
        </>
      )}
      {noting ? (
        <div className="approval-note">
          <textarea
            aria-label="拒绝的理由"
            rows={2}
            value={note}
            disabled={busy}
            onChange={event => setNote(event.target.value)}
            onKeyDown={event => {
              // Esc 放弃附理由，不再交给外面（外面的 Esc 是停止这一轮）
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeNote();
            }}
          />
          <div className="approval-actions">
            <Button busy={busy} onClick={() => respond('deny')}>
              拒绝
            </Button>
            <Button variant="text" disabled={busy} onClick={closeNote}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <Button variant="primary" busy={busy} onClick={() => respond('approve')}>
            批准
          </Button>
          <Button variant="text" disabled={busy} onClick={() => respond('deny')}>
            拒绝
          </Button>
          <Button variant="text" disabled={busy} onClick={() => setNoting(true)}>
            拒绝并附理由
          </Button>
        </div>
      )}
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
