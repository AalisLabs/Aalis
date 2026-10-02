import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useBack } from '../back';
import './Panel.css';

interface PanelProps {
  title: ReactNode;
  /** 标题前的图标 */
  icon?: LucideIcon;
  /** 标题旁的副信息，弱化色 */
  meta?: ReactNode;
  /** 头部右侧的图标按钮，最多三个，其余进「更多」 */
  actions?: ReactNode;
  /** 上一层的地址：手机上一层占满一屏，头部左边是回上一层的按钮 */
  back?: string;
  /** 头部下面常显的一条提示，不随正文滚动 */
  banner?: ReactNode;
  /** 正文下面常显的部分，不随正文滚动 */
  footer?: ReactNode;
  /** 正文贴着底部：停在底部时新内容出现在视野里，往上翻看时不被拽走 */
  anchor?: 'end';
  children: ReactNode;
}

function Back({ to }: { to: string }) {
  const goBack = useBack();
  return (
    <button type="button" className="panel-back" aria-label="返回" title="返回" onClick={() => goBack(to)}>
      <ArrowLeft aria-hidden />
    </button>
  );
}

/** 一栏：固定高度的头部，下面是可滚动的正文 */
export function Panel({ title, icon: Icon, meta, actions, back, banner, footer, anchor, children }: PanelProps) {
  const titleId = useId();
  return (
    <section className="panel" aria-labelledby={titleId}>
      <header className="panel-header">
        {back !== undefined && <Back to={back} />}
        {Icon && <Icon aria-hidden />}
        <h2 id={titleId} className="panel-title">
          {title}
        </h2>
        {meta && <span className="panel-meta">{meta}</span>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {banner && <p className="panel-banner">{banner}</p>}
      <div className="panel-body" data-anchor={anchor}>
        {anchor ? <div className="panel-content">{children}</div> : children}
      </div>
      {footer}
    </section>
  );
}
