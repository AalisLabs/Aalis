import { type CSSProperties, useEffect, useRef, useState } from 'react';
import './popover.css';

// 按钮弹出的一层（菜单、选择器）：读按钮的位置放在它下方，按钮在视口下部时向上弹出。弹层挂在 body 上，不被滚动区与容器
// 裁掉；按钮在打开着的模态对话框里时挂在对话框里，对话框外面的东西点不到。点在外面、滚动与改窗口大小时关闭。
// 这是样式规则里唯一用脚本定位的地方

interface Placement {
  left: number;
  right: number;
  width: number;
  /** 向下弹出时是按钮的下边，向上弹出时是按钮上边到视口底的距离 */
  edge: number;
  up: boolean;
}

export function usePopover<T extends HTMLElement>() {
  const [placement, setPlacement] = useState<Placement>();
  const trigger = useRef<T>(null);
  const popup = useRef<HTMLDivElement>(null);
  const open = placement !== undefined;

  const show = () => {
    const rect = (trigger.current as T).getBoundingClientRect();
    const up = rect.bottom > window.innerHeight * 0.6;
    setPlacement({
      left: rect.left,
      right: window.innerWidth - rect.right,
      width: rect.width,
      edge: up ? window.innerHeight - rect.top : rect.bottom,
      up,
    });
  };

  const close = (refocus: boolean) => {
    setPlacement(undefined);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) setPlacement(undefined);
    };
    const dismiss = () => setPlacement(undefined);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  const style =
    placement &&
    ({
      '--popover-left': `${placement.left}px`,
      '--popover-right': `${placement.right}px`,
      '--popover-width': `${placement.width}px`,
      '--popover-edge': `${placement.edge}px`,
    } as CSSProperties);

  return {
    open,
    show,
    close,
    trigger,
    popup,
    /** 弹层的属性：位置写成 CSS 变量，方向写在 data-placement；弹层另带 popover 类 */
    layer: style && { style, 'data-placement': placement?.up ? 'up' : 'down' },
    /** 弹层挂在哪：打开着的模态对话框里，或 body */
    host: () => trigger.current?.closest('dialog[open]') ?? document.body,
  };
}
