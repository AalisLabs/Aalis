import type { ReactNode } from 'react';
import { Link } from 'react-router';
import './List.css';

/** 行首标记的读屏说法 */
export const MARKERS = { attention: '需要处理', error: '出错', unread: '未读' } as const;

export function List({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="list" aria-label={label}>
      {children}
    </ul>
  );
}

interface ListItemProps {
  to: string;
  title: ReactNode;
  /** 第二行：状态句或摘要；有它就是双行 */
  detail?: ReactNode;
  /** 右侧：时间或不正常时的状态 */
  meta?: ReactNode;
  /** 行首标记只给三种状态：需要处理（金）、出错（红）、完成未读（强调色） */
  marker?: keyof typeof MARKERS;
  current?: boolean;
  /** 行尾的「更多」菜单：悬停、选中、键盘聚焦时出现，触屏上常显，手机上不带 */
  menu?: ReactNode;
  /** 行尾常显的一个操作（停止） */
  action?: ReactNode;
  /** 挂在这一行下面、向里缩一级的子列表 */
  children?: ReactNode;
}

/** 列表的一行：整行是一个链接 */
export function ListItem({ to, title, detail, meta, marker, current, menu, action, children }: ListItemProps) {
  return (
    <li className="list-item">
      <div
        className="list-item-row"
        data-current={current || undefined}
        data-marker={marker}
        data-lines={detail ? 2 : 1}
      >
        <Link className="list-item-link" to={to} aria-current={current ? 'page' : undefined}>
          <span className="list-item-marker" aria-hidden />
          {marker && <span className="visually-hidden">{MARKERS[marker]}</span>}
          <span className="list-item-text">
            <span className="list-item-title">{title}</span>
            {detail && <span className="list-item-detail">{detail}</span>}
          </span>
          {meta && <span className="list-item-meta">{meta}</span>}
        </Link>
        {action && <div className="list-item-action">{action}</div>}
        {menu && <div className="list-item-menu">{menu}</div>}
      </div>
      {children}
    </li>
  );
}
