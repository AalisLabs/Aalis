import type { SessionSummary } from '@aalis/api-session-protocol';
import { LoaderCircle } from 'lucide-react';
import './status.css';

/** 会话的状态，要紧的在前：需要我处理、出错、完成未读、运行中。列表与房间表都按这个先后排 */
export const STATUS_ORDER = ['attention', 'error', 'unread', 'running'] as const;

/** 会话此刻最要紧的一种状态，一种状态一种表达 */
export const statusOf = (s: SessionSummary) => STATUS_ORDER.find(status => s[status]);

const TEXT = { attention: '等你批准', error: '出错', running: '运行中' } as const;

/** 写成一句的状态：需要我处理是警告色，出错是危险色，运行中带旋转图标；完成未读不写字，只靠行首标记与加粗 */
export function SessionStatus({ status }: { status: keyof typeof TEXT }) {
  return (
    <span className="session-status" data-status={status}>
      {status === 'running' && <LoaderCircle aria-hidden className="spin" />}
      {TEXT[status]}
    </span>
  );
}
