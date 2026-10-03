import { LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import './Button.css';

interface ButtonProps extends Omit<ComponentProps<'button'>, 'className' | 'style'> {
  /** 主要：每个区域最多一个；次要：并列的其他操作；文字：低频或退一步的操作 */
  variant?: 'primary' | 'secondary' | 'text';
  /** 危险操作：主要按钮换成危险底（只在确认框里用），其余用危险色字 */
  danger?: boolean;
  /** 进行中：不可点，文案与宽度不变 */
  busy?: boolean;
  icon?: LucideIcon;
}

export function Button({
  variant = 'secondary',
  danger,
  busy,
  icon: Icon,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const spinner = <LoaderCircle aria-hidden className="spin" />;
  return (
    <button
      {...rest}
      type={type}
      className="button"
      data-variant={variant}
      data-danger={danger || undefined}
      data-busy={busy ? (Icon ? 'icon' : 'overlay') : undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {Icon && (busy ? spinner : <Icon aria-hidden />)}
      <span className="button-label">{children}</span>
      {busy && !Icon && <span className="button-overlay">{spinner}</span>}
    </button>
  );
}
