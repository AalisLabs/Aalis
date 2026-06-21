import { type ReactNode, useCallback, useEffect, useState } from 'react';

// 应用内确认弹窗：替代原生 window.confirm（后者样式不可控、被部分浏览器节流/抑制）。
// 用法：const { confirm, dialog } = useConfirm(); 在 JSX 里渲染 {dialog}；
//   if (!(await confirm({ title, body, danger }))) return;  // 取消即 false
// Promise 化，天然适配「先 await fetch 再确认」的异步流程。

export interface ConfirmOptions {
  title: string;
  /** 正文，支持多行（CSS white-space: pre-wrap）或任意节点 */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作 → 确认按钮用 danger 配色 */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>(resolve => setPending({ ...opts, resolve })),
    [],
  );

  const settle = useCallback((v: boolean) => {
    setPending(p => {
      p?.resolve(v);
      return null;
    });
  }, []);

  // Esc 取消 / Enter 确认（仅在弹窗开启时挂载）
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
      else if (e.key === 'Enter') settle(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  const dialog = pending ? (
    <div className="confirm-overlay" onClick={() => settle(false)}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘交互由上面的 window keydown 统一处理 */}
      <div className="confirm-dialog" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="confirm-title">{pending.title}</div>
        {pending.body != null && <div className="confirm-body">{pending.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn btn-sm" onClick={() => settle(false)}>
            {pending.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${pending.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => settle(true)}
          >
            {pending.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
