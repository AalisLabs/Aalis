import type { ReactNode } from 'react';
import { Link } from 'react-router';
import './Button.css';

/** 去别处的按钮：样子与 Button 的次要或文字按钮相同，本身是链接（能在新标签页打开、读屏念作链接） */
export function ButtonLink({
  to,
  variant = 'secondary',
  children,
}: {
  to: string;
  variant?: 'secondary' | 'text';
  children: ReactNode;
}) {
  return (
    <Link className="button" data-variant={variant} to={to}>
      <span className="button-label">{children}</span>
    </Link>
  );
}
