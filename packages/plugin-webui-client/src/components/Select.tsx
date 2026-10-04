import { ChevronDown } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopover } from './popover';
import './Select.css';

// 选择器：按钮写选中的那一项，点开是一列选项，手机上从底部弹出。选项多时顶上有过滤框，按名字过滤（模型列表可以有几百项）。
// 焦点留在过滤框或列表上，方向键移动当前项（aria-activedescendant），回车选中，Esc 关闭并把焦点还给按钮，Tab 离开时关闭

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 选项到这么多时出现过滤框 */
const FILTER_FROM = 10;

interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  /** 没选（value 不在选项里）时按钮上的字 */
  placeholder?: string;
  /** 悬停提示 */
  title?: string;
  /** 按钮的样子：缺省是与输入框一样带边框的，`bare` 不带边框（输入框旁的快捷切换） */
  variant?: 'bare';
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'data-autofocus'?: boolean;
}

export function Select({ value, options, onChange, placeholder, variant, ...rest }: SelectProps) {
  const { open, show, close, trigger, popup, layer, host } = usePopover<HTMLButtonElement>();
  const listId = useId();
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState<string>();
  const filtering = options.length >= FILTER_FROM;
  const needle = filter.trim().toLowerCase();
  const shown = needle ? options.filter(option => option.label.toLowerCase().includes(needle)) : options;
  const enabled = shown.filter(option => !option.disabled);
  const current = options.find(option => option.value === value);
  const optionId = (option: SelectOption) => `${listId}-${options.indexOf(option)}`;

  const openList = () => {
    setFilter('');
    setActive((current && !current.disabled ? current : options.find(option => !option.disabled))?.value);
    show();
  };

  // 焦点进弹层；选中的那一项可能在长列表下面，滚进视野
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLElement>(filtering ? 'input' : '[role="listbox"]')?.focus();
    popup.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [open, popup, filtering]);

  // 过滤后当前项不在结果里时，落到结果的第一项
  const activeOption = enabled.find(option => option.value === active) ?? enabled[0];

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const index = activeOption ? enabled.indexOf(activeOption) : -1;
    let next: number;
    if (event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home' && !filtering) next = 0;
    else if (event.key === 'End' && !filtering) next = enabled.length - 1;
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeOption) choose(activeOption);
      return;
    } else if (event.key === 'Escape') {
      // 拦下 Esc：对话框里的选择器关掉时，对话框不跟着关
      event.preventDefault();
      close(true);
      return;
    } else {
      if (event.key === 'Tab') close(true);
      return;
    }
    event.preventDefault();
    const target = enabled[Math.min(Math.max(next, 0), enabled.length - 1)];
    if (!target) return;
    setActive(target.value);
    document.getElementById(optionId(target))?.scrollIntoView({ block: 'nearest' });
  };

  const activeId = activeOption && optionId(activeOption);
  return (
    <>
      <button
        {...rest}
        ref={trigger}
        type="button"
        role="combobox"
        className="select"
        data-variant={variant}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={event => {
          if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
          event.preventDefault();
          openList();
        }}
      >
        <span className="select-value">{current?.label ?? placeholder}</span>
        <ChevronDown aria-hidden />
      </button>
      {layer &&
        createPortal(
          <div ref={popup} className="popover select-popup" {...layer}>
            {filtering && (
              <input
                type="search"
                aria-label="过滤"
                placeholder="过滤"
                aria-controls={listId}
                aria-activedescendant={activeId}
                value={filter}
                onChange={event => setFilter(event.target.value)}
                onKeyDown={onKeyDown}
              />
            )}
            <div
              id={listId}
              role="listbox"
              aria-label={rest['aria-label'] ?? trigger.current?.labels?.[0]?.textContent ?? undefined}
              aria-labelledby={rest['aria-labelledby']}
              tabIndex={filtering ? -1 : 0}
              aria-activedescendant={filtering ? undefined : activeId}
              onKeyDown={onKeyDown}
            >
              {shown.map(option => (
                // 选项不进 Tab 顺序：键盘经过滤框或列表的当前项选，指针直接点
                // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘在外层的列表上处理
                <div
                  key={option.value}
                  id={optionId(option)}
                  role="option"
                  tabIndex={-1}
                  className="select-option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  data-active={option === activeOption || undefined}
                  onClick={() => choose(option)}
                >
                  {option.label}
                </div>
              ))}
            </div>
            {shown.length === 0 && <p className="select-empty">没有符合的项</p>}
          </div>,
          host(),
        )}
    </>
  );
}
