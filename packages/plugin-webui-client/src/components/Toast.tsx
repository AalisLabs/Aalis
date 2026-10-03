import { Check, CircleAlert, Info, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import './Toast.css';

// Toast 只回报用户自己操作的结果；插件与后台事件不弹 Toast，走「需要处理」

interface ToastInput {
  /** 语气：与颜色令牌同名 */
  kind: 'success' | 'danger' | 'info';
  text: string;
  /** 撤销一类的后续操作 */
  action?: { label: string; run(): void };
}

const LIMIT = 3;
const DURATION_MS = 4_000;
const ACTION_DURATION_MS = 8_000;
const ICONS = { success: Check, danger: CircleAlert, info: Info };

const ShowToast = createContext<(toast: ToastInput) => void>(() => {
  throw new Error('Toast 只能在 ToastProvider 里弹出');
});

/** 弹一条 Toast：成功与信息 4 秒后消失，带动作的 8 秒，出错的不自动消失 */
export const useToast = () => useContext(ShowToast);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<ToastInput & { id: number }>>([]);
  const nextId = useRef(0);
  const show = useCallback((toast: ToastInput) => {
    const id = ++nextId.current;
    setToasts(list => [...list, { ...toast, id }].slice(-LIMIT));
  }, []);
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(toast => toast.id !== id)), []);
  // 鼠标停在通知上或键盘聚焦其中时全部暂停计时，离开后各自接着剩下的时间
  const [paused, setPaused] = useState(false);

  return (
    <ShowToast.Provider value={show}>
      {children}
      <section
        className="toasts"
        aria-label="通知"
        aria-live="polite"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} paused={paused} onDismiss={dismiss} />
        ))}
      </section>
    </ShowToast.Provider>
  );
}

interface ToastItemProps {
  toast: ToastInput & { id: number };
  paused: boolean;
  onDismiss(id: number): void;
}

function ToastItem({ toast, paused, onDismiss }: ToastItemProps) {
  const remaining = useRef(
    toast.kind === 'danger' ? Number.POSITIVE_INFINITY : toast.action ? ACTION_DURATION_MS : DURATION_MS,
  );
  const Icon = ICONS[toast.kind];

  useEffect(() => {
    if (paused || remaining.current === Number.POSITIVE_INFINITY) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, onDismiss, toast.id]);

  return (
    <div className="toast" data-kind={toast.kind} role={toast.kind === 'danger' ? 'alert' : undefined}>
      <Icon aria-hidden />
      <p className="toast-text">{toast.text}</p>
      {toast.action && (
        <Button
          variant="text"
          onClick={() => {
            toast.action?.run();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <IconButton icon={X} label="关闭" onClick={() => onDismiss(toast.id)} />
    </div>
  );
}
