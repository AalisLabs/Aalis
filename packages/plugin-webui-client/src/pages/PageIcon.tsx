import { lazy, Suspense } from 'react';

// 插件页面的图标：只按 lucide 图标名查，没写或不认识的用通用图标。图标名到图标的对照表有近两千项，单独成块，
// 用到页面图标时才加载；每个图标也是用到时才加载

const IconByName = lazy(() => import('./IconByName'));

/** 加载出来之前占住图标的位置 */
export const IconPending = () => <svg className="lucide" aria-hidden />;

export function PageIcon({ name }: { name?: string }) {
  return (
    <Suspense fallback={<IconPending />}>
      <IconByName name={name} />
    </Suspense>
  );
}
