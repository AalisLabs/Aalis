import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import './Tabs.css';

interface TabsProps {
  label: string;
  items: ReadonlyArray<{ key: string; title: string }>;
  value: string;
  onChange(key: string): void;
  /** 选中标签的内容 */
  children: ReactNode;
}

/** 标签页：左右方向键切换，Home、End 到两端；只有选中的标签在 Tab 顺序里 */
export function Tabs({ label, items, value, onChange, children }: TabsProps) {
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
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
      <div role="tablist" aria-label={label} className="tabs-list">
        {items.map((item, index) => (
          <button
            key={item.key}
            ref={element => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-${item.key}`}
            aria-controls={`${id}-panel`}
            aria-selected={item.key === value}
            tabIndex={item.key === value ? 0 : -1}
            className="tabs-tab"
            onClick={() => onChange(item.key)}
            onKeyDown={event => onKeyDown(event, index)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} className="tabs-panel">
        {children}
      </div>
    </div>
  );
}
