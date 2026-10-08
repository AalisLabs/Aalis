import { type ReactNode, useEffect, useId, useRef } from 'react';
import './Dialog.css';

interface DialogProps {
  open: boolean;
  title: string;
  /** Esc 经它交给调用方，由调用方关掉 */
  onClose(): void;
  /** 确认框窄，带表单的宽；full 在手机上占满全屏，正文是一块自己滚动的区域（日志） */
  size?: 'confirm' | 'form' | 'full';
  /** 按钮行：「取消」在左，确认的动作在右。打开时焦点落在标了 data-autofocus 的元素上 */
  footer?: ReactNode;
  children: ReactNode;
}

/** 模态对话框：浏览器负责焦点圈在框内、背景不可操作，关闭后焦点回到打开它的元素 */
export function Dialog({ open, title, onClose, size = 'confirm', footer, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current as HTMLDialogElement;
    if (!open) {
      dialog.close();
      return;
    }
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      data-size={size}
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
