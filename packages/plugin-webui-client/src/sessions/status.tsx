import type { SessionSummary } from '@aalis/api-session-protocol';
import { StatusText } from '../components/StatusText';

/** 会话的状态，要紧的在前：需要我处理、出错、完成未读、运行中。列表与房间表都按这个先后排 */
export const STATUS_ORDER = ['attention', 'error', 'unread', 'running'] as const;

/** 会话此刻最要紧的一种状态，一种状态一种表达 */
export const statusOf = (s: SessionSummary) => STATUS_ORDER.find(status => s[status]);

const TEXT = { attention: '等你批准', error: '出错', running: '运行中' } as const;

/** 写成一句的状态；完成未读不写字，只靠行首标记与加粗 */
export function SessionStatus({ status }: { status: keyof typeof TEXT }) {
  return <StatusText state={status}>{TEXT[status]}</StatusText>;
}
