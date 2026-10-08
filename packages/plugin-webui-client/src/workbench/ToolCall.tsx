import { sanitizeForCard } from '@aalis/api-approval';
import type { SessionItem } from '@aalis/api-session-protocol';
import { FilePen, LoaderCircle, SquareTerminal, Wrench } from 'lucide-react';
import { useState } from 'react';
import { TaskFoot, TaskStatus } from '../background/Background';
import { useBackground } from '../background/tasks';
import { Button } from '../components/Button';
import { type Approval, useSessionClient } from '../connection';
import { clockTime, duration } from '../format';
import { RequestError } from '../protocol/session-client';
import './ToolCall.css';

// 工具卡：一行写动作与对象、右侧写状态，点开看细节；模型还在生成参数时只有工具名与「正在生成」，没有细节可看。
// 失败用危险色，命令有退出码的写退出码；回合停止时还没结束的写「已停止」，与回合的结局同一个说法，不用危险色。
// 按会话服务解析好的展示种类（display）渲染，没声明的与认不出的种类走通用卡、逐字列出参数；前端不认识任何工具名。
// 要 owner 批准的调用，审批卡挂在这一行下面，事实完整列出、不限高（服务端已截断并写明省略多少）；结算后收成行上的一句。
// 转到后台的调用（带 taskId）保持活的：状态与耗时取后台任务，行下面是最后一行与「输出」「停止」；登记表里找不到的
// （超出保留被清掉的）只画这次调用本身。
// 卡上来自参数的文字一律经审批契约的清洗（控制符、双向控制符、零宽字符都显示出来），免得看到的和要执行的不一样

type ToolCallItem = Extract<SessionItem, { kind: 'tool-call' }>;
type Settlement = NonNullable<ToolCallItem['settlement']>;
type Display = NonNullable<ToolCallItem['display']>;

/** 一行里命令最多显示这么多个字，完整的在细节里 */
const SUMMARY_LIMIT = 60;

/** 回合与工具调用被停止时写的字 */
export const STOPPED = '已停止';

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

/** 认得的展示：种类按加法扩展，服务端比客户端新时会发来认不出的种类，当没声明 */
export function displayOf({ display }: ToolCallItem): Display | undefined {
  return display?.kind === 'command' || display?.kind === 'file-change' ? display : undefined;
}

/** 等 owner 批准：收起会把审批卡藏起来 */
export const awaitingApproval = (item: ToolCallItem) => item.approvalId !== undefined && item.settlement === undefined;

function summaryOf(item: ToolCallItem): string {
  const display = displayOf(item);
  if (display?.kind === 'command') {
    const line = display.command.split('\n')[0];
    return `执行 ${sanitizeForCard(line, SUMMARY_LIMIT)}`;
  }
  if (display?.kind === 'file-change') {
    return `${display.removed === undefined ? '写入' : '修改'} ${sanitizeForCard(display.path)}`;
  }
  return `调用 ${sanitizeForCard(item.name)}`;
}

/** 失败写成一句：命令的退出码不为 0 时写退出码，其余写「失败」 */
function failureOf(item: ToolCallItem): string {
  const display = displayOf(item);
  return display?.kind === 'command' && (display.exitCode ?? 0) !== 0 ? `退出码 ${display.exitCode}` : '失败';
}

/** 按展示种类选的图标，没声明的是通用调用 */
export const TOOL_ICONS = { command: SquareTerminal, 'file-change': FilePen, generic: Wrench } as const;

interface ToolCallProps {
  item: ToolCallItem;
  open: boolean;
  onToggle(): void;
  /** 这次调用未结的审批：推给这条连接的，或订阅快照里带来的 */
  approval?: Approval;
  /** 打开后台任务的日志 */
  openLog(taskId: string): void;
}

export function ToolCall({ item, open, onToggle, approval, openLog }: ToolCallProps) {
  const { tasks } = useBackground();
  const task = item.taskId === undefined ? undefined : tasks?.get(item.taskId);
  const generating = item.status === 'generating';
  const waiting = awaitingApproval(item);
  const Icon = TOOL_ICONS[displayOf(item)?.kind ?? 'generic'];
  const parts = [
    item.settlement && settlementText(item.settlement),
    item.status === 'failed' && failureOf(item),
    item.status === 'aborted' && STOPPED,
    item.sentToRoom && '已发到群',
    !task && item.status === 'completed' && item.durationMs !== undefined && duration(item.durationMs),
  ].filter(part => typeof part === 'string');
  const tone = waiting ? 'attention' : item.status === 'failed' ? 'danger' : undefined;
  return (
    <div className="tool-call">
      <button
        type="button"
        className="tool-line"
        aria-expanded={generating ? undefined : open}
        disabled={generating}
        onClick={onToggle}
      >
        <Icon aria-hidden />
        <span className="tool-line-text">{summaryOf(item)}</span>
        <span className="tool-line-status" data-tone={tone}>
          {waiting ? (
            '等你批准'
          ) : generating || item.status === 'running' ? (
            <>
              <LoaderCircle aria-hidden className="spin" />
              {generating ? '正在生成' : '运行中'}
            </>
          ) : task ? (
            <>
              {parts.length > 0 && `${parts.join(' · ')} · `}
              <TaskStatus task={task} />
            </>
          ) : (
            parts.join(' · ')
          )}
        </span>
      </button>
      {task && <TaskFoot task={task} onOutput={() => openLog(task.id)} />}
      {open && !generating && <ToolDetails item={item} />}
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
  const display = displayOf(item);
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
    <pre className="tool-diff">
      {rows.map((row, index) => (
        // 行随条目整份替换，不会重排
        <span key={index} data-change={row.startsWith('-') ? 'removed' : 'added'}>
          {row}
        </span>
      ))}
    </pre>
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
      {command !== undefined && <pre className="approval-command">{command}</pre>}
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
            <Diff lines={patch.split('\n')} />
          )}
        </>
      )}
      {params !== undefined && (
        <>
          {(command !== undefined || facts.diff) && <p className="approval-meta">其他参数</p>}
          <pre className="approval-params">{params}</pre>
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
