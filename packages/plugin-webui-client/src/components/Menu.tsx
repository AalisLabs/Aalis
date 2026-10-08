import { Ellipsis, type LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';
import { usePopover } from './popover';
import './Menu.css';

interface MenuItem {
  label: string;
  /** 同一个菜单里可能同名的项给一个不重的标识 */
  id?: string;
  onSelect(): void;
  /** 危险操作用危险色字 */
  danger?: boolean;
}

interface MenuProps {
  /** 按钮的读屏标签，也是菜单的名字 */
  label: string;
  items: readonly MenuItem[];
  icon?: LucideIcon;
  /** 按钮上的一个点：收在菜单里的项有事在进行（手机头部的「后台 N」） */
  dot?: boolean;
}

/**
 * 「更多」菜单：图标按钮弹出一列操作，与按钮右边对齐；手机上从底部弹出。
 * 方向键在项之间移动，Esc 关闭并把焦点还给按钮，Tab 离开时关闭，点在外面关闭
 */
export function Menu({ label, items, icon = Ellipsis, dot }: MenuProps) {
  const { open, show, close, trigger, popup, layer, host } = usePopover<HTMLButtonElement>();
  const menuId = useId();

  useEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, popup]);

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    show();
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const entries = [...(popup.current as HTMLDivElement).querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else if (event.key === 'Escape') {
      // 拦下 Esc：对话框里的菜单关掉时，对话框不跟着关
      event.preventDefault();
      close(true);
      return;
    } else {
      // Tab 照常移动焦点：先把焦点还给按钮，下一个焦点就是按钮之后的元素
      if (event.key === 'Tab') close(true);
      return;
    }
    event.preventDefault();
    entries[(next + entries.length) % entries.length].focus();
  };

  return (
    <>
      <IconButton
        ref={trigger}
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-dot={dot || undefined}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onTriggerKeyDown}
      />
      {layer &&
        createPortal(
          <div
            ref={popup}
            id={menuId}
            role="menu"
            aria-label={label}
            className="popover menu"
            {...layer}
            onKeyDown={onMenuKeyDown}
          >
            {items.map(item => (
              <button
                key={item.id ?? item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                data-danger={item.danger || undefined}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          host(),
        )}
    </>
  );
}
