import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import './Disclosure.css';

/**
 * 展开或收起下面一段内容的一行：箭头加文字，字号与颜色跟着所在的地方。label 是读屏名，看得到的字分不清是哪一个时给
 * （如带上它属于哪一项）
 */
export function Disclosure({
  expanded,
  onToggle,
  label,
  children,
}: {
  expanded: boolean;
  onToggle(): void;
  label?: string;
  children: ReactNode;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button type="button" className="disclosure" aria-label={label} aria-expanded={expanded} onClick={onToggle}>
      <Chevron aria-hidden />
      {children}
    </button>
  );
}
