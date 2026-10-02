import type { ReactNode } from 'react';
import './Badge.css';

interface BadgeProps {
  /** 需要处理用警告色，其余不上色 */
  tone?: 'neutral' | 'attention';
  /** 数字是计数，其余是标签（例如设置的来源） */
  children: ReactNode;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span className="badge" data-tone={tone} data-count={typeof children === 'number' || undefined}>
      {children}
    </span>
  );
}
