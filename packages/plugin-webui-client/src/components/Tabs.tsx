import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { closeTabKey } from '../keys';
import { IconButton } from './IconButton';
import './Tabs.css';

interface TabItem {
  key: string;
  title: string;
}

interface TabsProps {
  label: string;
  items: readonly TabItem[];
  /** 选中的标签；不在 items 里时没有选中的，也没有内容区 */
  value: string;
  onChange(key: string): void;
  /** 给出时选中的标签可以关：点标签列表之后的关闭按钮，或在选中的标签上按 Delete（Mac 上也认 Backspace） */
  onClose?(): void;
  /** 标签栏末尾，不随标签横向滚动 */
  trailing?: ReactNode;
  /** 选中标签的内容 */
  children: ReactNode;
}

/**
 * 标签页：左右方向键切换，Home、End 到两端，只有选中的标签在 Tab 顺序里。可以关闭时，标签列表之后是关闭选中标签的按钮
 * （标签列表里只能有标签），选中的标签上按 Delete（Mac 上也认 Backspace）也能关，关掉后焦点交给新选中的标签。
 * 元素 id 按位置编，标签的 key 可以是任意文字
 */
export function Tabs({ label, items, value, onChange, onClose, trailing, children }: TabsProps) {
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = items.findIndex(item => item.key === value);
  const closeKey = closeTabKey();

  // 按键关掉的标签：它从列表里消失时按着键的元素没了，焦点掉到页面上，交给新选中的标签。关闭可能要等写入回来，
  // 这期间焦点已被移走的不抢
  const closedByKey = useRef<string>(undefined);
  useEffect(() => {
    const closed = closedByKey.current;
    if (closed === undefined || items.some(item => item.key === closed)) return;
    closedByKey.current = undefined;
    if (document.activeElement === document.body) tabs.current[selectedIndex]?.focus();
  });

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (onClose && index === selectedIndex && closeKey.matches(event.key)) {
      event.preventDefault();
      closedByKey.current = items[index].key;
      onClose();
      return;
    }
    let target: number;
    if (event.key === 'ArrowRight') target = index + 1;
    else if (event.key === 'ArrowLeft') target = index - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = items.length - 1;
    else return;
    event.preventDefault();
    const next = (target + items.length) % items.length;
    onChange(items[next].key);
    tabs.current[next]?.focus();
  };

  return (
    <div className="tabs">
      <div className="header-bar tabs-bar">
        <div role="tablist" aria-label={label} className="tabs-list">
          {items.map((item, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={item.key}
                ref={element => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`${id}-${index}`}
                aria-controls={`${id}-panel`}
                aria-selected={selected}
                aria-keyshortcuts={onClose && selected ? closeKey.aria : undefined}
                tabIndex={selected ? 0 : -1}
                className="tabs-tab"
                onClick={() => onChange(item.key)}
                onKeyDown={event => onKeyDown(event, index)}
              >
                {item.title}
              </button>
            );
          })}
        </div>
        {onClose && selectedIndex >= 0 && (
          <IconButton
            icon={X}
            label={`关闭「${items[selectedIndex].title}」`}
            shortcut={closeKey.label}
            onClick={onClose}
          />
        )}
        {trailing}
      </div>
      {selectedIndex >= 0 && (
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${selectedIndex}`} className="tabs-panel">
          {children}
        </div>
      )}
    </div>
  );
}
