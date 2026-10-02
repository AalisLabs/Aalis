import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import './IconButton.css';

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children' | 'className' | 'style'> {
  icon: LucideIcon;
  /** 读屏标签，也是悬停提示 */
  label: string;
  /** 按平台写好的快捷键，写进悬停提示 */
  shortcut?: string;
}

export function IconButton({ icon: Icon, label, shortcut, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className="icon-button"
      aria-label={label}
      title={shortcut ? `${label}（${shortcut}）` : label}
    >
      <Icon aria-hidden />
    </button>
  );
}
