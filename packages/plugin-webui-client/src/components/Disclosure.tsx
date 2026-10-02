import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import './Disclosure.css';

/** 展开或收起下面一段内容的一行：箭头加文字，字号与颜色跟着所在的地方 */
export function Disclosure({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button type="button" className="disclosure" aria-expanded={expanded} onClick={onToggle}>
      <Chevron aria-hidden />
      {children}
    </button>
  );
}
