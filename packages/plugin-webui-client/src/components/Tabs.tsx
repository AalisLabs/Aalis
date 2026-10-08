import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
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
  /** 给出时选中的标签可以关：点标签列表之后的关闭按钮，或在选中的标签上按 Delete */
  onClose?(): void;
  /** 标签栏末尾，不随标签横向滚动 */
  trailing?: ReactNode;
  /** 选中标签的内容 */
  children: ReactNode;
}

/**
 * 标签页：左右方向键切换，Home、End 到两端，只有选中的标签在 Tab 顺序里。可以关闭时，标签列表之后是关闭选中标签的按钮
 * （标签列表里只能有标签），选中的标签上按 Delete 也能关。元素 id 按位置编，标签的 key 可以是任意文字
 */
export function Tabs({ label, items, value, onChange, onClose, trailing, children }: TabsProps) {
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = items.findIndex(item => item.key === value);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === 'Delete' && onClose && index === selectedIndex) {
      event.preventDefault();
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
                aria-keyshortcuts={onClose && selected ? 'Delete' : undefined}
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
          <IconButton icon={X} label={`关闭「${items[selectedIndex].title}」`} shortcut="Delete" onClick={onClose} />
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
