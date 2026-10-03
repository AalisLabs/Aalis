import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import './EmptyState.css';

interface EmptyStateProps {
  /** 缺什么，或哪里没取到 */
  title: string;
  /** 怎么得到；出错时写错误原文 */
  description?: ReactNode;
  /** 最多一个操作 */
  action?: ReactNode;
  /** 区域取数失败：危险色图标，作为警示播报。语气名与颜色令牌同名 */
  tone?: 'danger';
}

/** 区域里没有内容或没取到内容时，放在内容原本的位置 */
export function EmptyState({ title, description, action, tone }: EmptyStateProps) {
  return (
    <div className="empty-state" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>
      {tone === 'danger' && <CircleAlert aria-hidden />}
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-description">{description}</p>}
      {action}
    </div>
  );
}
