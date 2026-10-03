import { type ReactNode, useId } from 'react';

/** 同一区域里的一组：留白加一个小标题，不加线、不加底。插件详情的各块与设置的各组用它 */
export function Block({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="page-block" aria-labelledby={headingId}>
      <h3 id={headingId} className="page-block-label">
        {title}
      </h3>
      {children}
    </section>
  );
}
