import type { PageView } from '@aalis/api-webui';
import { CircleAlert } from 'lucide-react';
import { useId } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { List, ListItem } from '../components/List';
import { pageAt, paths } from '../routes';
import { PageIcon } from './PageIcon';
import { pageName, refOf, sameRef, usePages } from './registry';

// 固定的页面：按 owner 排的顺序，只列此刻登记着、位置为插件详情的页面；所属插件停用时不出现，记录保留。
// 桌面上在图标栏里，手机上没有图标栏，列在第一层的会话列表上面。页面表或布局记录没取到时在同一处写明原因，可以重试

function usePinned(): { pinned: PageView[]; error?: Error; retry(): void } {
  const { pages, pagesError, layout, layoutError, retry } = usePages();
  const pinned =
    pages && layout
      ? layout.pinned.flatMap(ref => pages.filter(page => page.placement === 'plugin' && sameRef(ref)(refOf(page))))
      : [];
  return { pinned, error: pagesError ?? layoutError, retry };
}

export function PinnedRail() {
  const { pinned, error, retry } = usePinned();
  const open = pageAt(useLocation().pathname);
  if (pinned.length === 0 && !error) return null;
  return (
    <div className="shell-rail-pinned">
      {pinned.map(page => {
        const name = pageName(page);
        const to = paths.page(refOf(page));
        const current = open !== undefined && sameRef(open)(refOf(page));
        return (
          <Link
            key={to}
            to={to}
            className="shell-rail-item"
            aria-label={name}
            title={name}
            aria-current={current ? 'page' : undefined}
          >
            <PageIcon name={page.icon} />
            <span className="shell-rail-name" aria-hidden>
              {page.title}
            </span>
          </Link>
        );
      })}
      {error && (
        <IconButton icon={CircleAlert} label={`固定的页面没取到：${error.message}（点按重试）`} onClick={retry} />
      )}
    </div>
  );
}

export function PinnedList() {
  const { pinned, error, retry } = usePinned();
  const headingId = useId();
  if (pinned.length === 0 && !error) return null;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="section-heading session-list-heading">
        固定的页面
      </h2>
      {error && (
        <p className="session-list-note" role="alert">
          没取到：{error.message}
          <Button variant="text" onClick={retry}>
            重试
          </Button>
        </p>
      )}
      {pinned.length > 0 && (
        <List label="固定的页面">
          {pinned.map(page => (
            <ListItem
              key={paths.page(refOf(page))}
              to={paths.page(refOf(page))}
              title={
                <span className="pinned-title">
                  <PageIcon name={page.icon} />
                  {pageName(page)}
                </span>
              }
            />
          ))}
        </List>
      )}
    </section>
  );
}
