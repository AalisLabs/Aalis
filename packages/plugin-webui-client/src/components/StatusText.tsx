import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import './StatusText.css';

/** 状态写成一句：需要处理是警告色，出错是危险色，运行中带旋转图标，停用是弱化色；正常时不上色 */
export function StatusText({
  state,
  children,
}: {
  state?: 'attention' | 'error' | 'running' | 'inactive';
  children: ReactNode;
}) {
  return (
    <span className="status-text" data-state={state}>
      {state === 'running' && <LoaderCircle aria-hidden className="spin" />}
      {children}
    </span>
  );
}
