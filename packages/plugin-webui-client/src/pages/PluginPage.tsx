import type { PageRef, PageView } from '@aalis/api-webui';
import { CircleAlert, Pin, RotateCw } from 'lucide-react';
import { useReducer, useState } from 'react';
import { useParams } from 'react-router';
import { ButtonLink } from '../components/ButtonLink';
import { EmptyState } from '../components/EmptyState';
import { FetchError } from '../components/FetchError';
import { IconButton } from '../components/IconButton';
import { Panel } from '../components/Panel';
import { useToast } from '../components/Toast';
import { FramePage } from '../frame/FramePage';
import { useHost } from '../plugins/list';
import { paths } from '../routes';
import { Main } from '../shell/Shell';
import { PageContent } from './PageContent';
import { instanceName, refOf, sameRef, usePages } from './registry';
import { PageScope } from './scope';

// 打开一个页面：标题栏写标题（多实例插件另写实例名）与手动刷新，位置为插件详情的页面另有「固定」。声明式页面在打开时、
// 手动刷新与管理连接重连后整页重取；插件前端的手动刷新是重新挂载。地址里的页面不在页面表里（所属插件停用）时显示占位，
// 页面重新登记后自动回到原页

export function PluginPage() {
  const { instance, pageKey } = useParams() as { instance: string; pageKey: string };
  const ref: PageRef = { instance, pageKey };
  const { pages } = usePages();
  const page = pages?.find(view => view.placement === 'plugin' && sameRef(ref)(refOf(view)));
  return (
    <Main>
      {page ? (
        <OpenPage key={paths.page(refOf(page))} page={page} />
      ) : (
        <Panel title="页面" back={paths.home}>
          <PageMissing instance={instance} />
        </Panel>
      )}
    </Main>
  );
}

/** 地址里的页面不在页面表里：页面表没取到时写原因、可以重试，取到了是所属插件停用了；还在取时什么都不显示 */
export function PageMissing({ instance }: { instance: string }) {
  const { pages, pagesError, retry } = usePages();
  const host = useHost();
  if (pagesError) return <FetchError what="页面" error={pagesError} retry={retry} source={host} />;
  return pages ? <PageGone instance={instance} /> : null;
}

/** 页面所属的插件停用了：主区与会话面板里同一个占位，链到插件详情 */
export function PageGone({ instance }: { instance: string }) {
  return (
    <EmptyState
      title="这个页面所属的插件已停用"
      description="插件重新启用后会自动回到这里。"
      action={<ButtonLink to={paths.plugin(instance)}>去插件详情</ButtonLink>}
    />
  );
}

function OpenPage({ page }: { page: PageView }) {
  const [reloads, reload] = useReducer((n: number) => n + 1, 0);
  return (
    <Panel
      title={page.title}
      meta={instanceName(page.instance)}
      back={paths.home}
      actions={
        <>
          <IconButton icon={RotateCw} label="刷新" onClick={reload} />
          <PinButton page={page} />
        </>
      }
    >
      {page.frame ? (
        <FramePage page={page} reloads={reloads} reload={reload} />
      ) : (
        <PageScope page={page} version={reloads}>
          <PageContent page={page} />
        </PageScope>
      )}
    </Panel>
  );
}

/** 固定到图标栏：再按一次取消；布局记录没取到时写明原因，点它重试 */
function PinButton({ page }: { page: PageView }) {
  const { layout, layoutError, retry, changeLayout } = usePages();
  const toast = useToast();
  const host = useHost();
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
          .catch((err: Error) =>
            toast({ kind: 'danger', text: `${pinned ? '取消固定' : '固定'}失败：${err.message}`, source: host }),
          )
          .finally(() => setBusy(false));
      }}
    />
  );
}
