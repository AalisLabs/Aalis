import type { ReactNode } from 'react';
import { Link } from 'react-router';
import './Button.css';

/** 去别处的按钮：样子与 Button 相同，本身是链接（能在新标签页打开、读屏念作链接） */
export function ButtonLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="button" data-variant="secondary" to={to}>
      <span className="button-label">{children}</span>
    </Link>
  );
}
