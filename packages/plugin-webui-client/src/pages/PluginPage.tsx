import type { PageRef, PageView } from '@aalis/api-webui';
import { CircleAlert, Pin, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { Panel } from '../components/Panel';
import { useToast } from '../components/Toast';
import { paths } from '../routes';
import { Main } from '../shell/Shell';
import { PageContent } from './PageContent';
import { instanceName, refOf, sameRef, usePages } from './registry';
import { PageScope, usePageVersion } from './scope';

// 打开一个页面：标题栏写标题（多实例插件另写实例名）与手动刷新，位置为插件详情的页面另有「固定」。页面取数在打开时、
// 手动刷新与管理连接重连后整页重取。地址里的页面不在页面表里（所属插件停用）时显示占位，页面重新登记后自动回到原页

export function PluginPage() {
  const { instance, pageKey } = useParams() as { instance: string; pageKey: string };
  const ref: PageRef = { instance, pageKey };
  const { pages, pagesError, retry } = usePages();
  const page = pages?.find(view => view.placement === 'plugin' && sameRef(ref)(refOf(view)));
  return (
    <Main>
      {page ? (
        <OpenPage key={paths.page(refOf(page))} page={page} />
      ) : (
        <Missing error={pagesError} retry={retry} loading={!pages} />
      )}
    </Main>
  );
}

function Missing({ error, retry, loading }: { error?: Error; retry(): void; loading: boolean }) {
  let body: ReactNode = null;
  if (error) {
    body = (
      <EmptyState
        tone="danger"
        title="页面没取到"
        description={error.message}
        action={<Button onClick={retry}>重试</Button>}
      />
    );
  } else if (!loading) {
    body = <EmptyState title="这个页面所属的插件已停用" description="插件重新启用后会自动回到这里。" />;
  }
  return (
    <Panel title="页面" back={paths.home}>
      {body}
    </Panel>
  );
}

function OpenPage({ page }: { page: PageView }) {
  const [version, refresh] = usePageVersion();
  return (
    <Panel
      title={page.title}
      meta={instanceName(page.instance)}
      back={paths.home}
      actions={
        <>
          <IconButton icon={RotateCw} label="刷新" onClick={refresh} />
          <PinButton page={page} />
        </>
      }
    >
      <PageScope page={page} version={version}>
        <PageContent page={page} />
      </PageScope>
    </Panel>
  );
}

/** 固定到图标栏：再按一次取消；布局记录没取到时写明原因，点它重试 */
function PinButton({ page }: { page: PageView }) {
  const { layout, layoutError, retry, changeLayout } = usePages();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!layout) {
    return layoutError ? (
      <IconButton icon={CircleAlert} label={`布局记录没取到：${layoutError.message}（点按重试）`} onClick={retry} />
    ) : null;
  }
  const ref = refOf(page);
  const pinned = layout.pinned.some(sameRef(ref));
  return (
    <IconButton
      icon={Pin}
      label="固定到图标栏"
      aria-pressed={pinned}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        changeLayout({ op: pinned ? 'unpin' : 'pin', page: ref })
          .catch((err: Error) => toast({ kind: 'danger', text: `${pinned ? '取消固定' : '固定'}失败：${err.message}` }))
          .finally(() => setBusy(false));
      }}
    />
  );
}
