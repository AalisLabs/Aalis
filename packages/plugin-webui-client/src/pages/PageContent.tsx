import type { ActionView, ComponentView, DeclarativePageView, PageRow, RowAction } from '@aalis/api-webui';
import { ArrowLeft, LoaderCircle, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useBack } from '../back';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { Menu } from '../components/Menu';
import { Table, type TableColumn } from '../components/Table';
import { Tabs } from '../components/Tabs';
import { Markdown } from '../markdown/Markdown';
import { Cell, cellText, fractionDigits, sortValue } from './cells';
import { Graph } from './Graph';
import { type ActionTarget, useActions, usePageData, usePageScope } from './scope';
import './pages.css';

// 页面内容：竖排的组件，或者标签页（选中的标签写进地址）。表格与关系图带详情时是主从：选中的一行写进地址
// （detail 是组件 id，row 是 rowKey），宽时详情在右边，窄时详情代替列表、像进了下一级，后退回到列表。
// 详情里的组件按选中行的 rowKey 取数，详情里的按钮组是作用于这一行的行动作

type Of<T extends ComponentView['type']> = Extract<ComponentView, { type: T }>;

const NO_CONTENT = '还没有内容';

export function PageContent({ page }: { page: DeclarativePageView }) {
  const [params, setParams] = useSearchParams();
  if (Array.isArray(page.content)) return <Screen components={page.content} />;
  const { tabs } = page.content;
  const current = tabs.find(tab => tab.key === params.get('tab')) ?? tabs[0];
  return (
    <Tabs
      label={page.title}
      items={tabs.map(tab => ({ key: tab.key, title: tab.title }))}
      value={current.key}
      onChange={key => setParams({ tab: key }, { replace: true })}
    >
      <Screen key={current.key} components={current.content} />
    </Tabs>
  );
}

/** 一屏：竖排的组件；详情里的一屏带着选中的那一行 */
function Screen({ components, target }: { components: readonly ComponentView[]; target?: ActionTarget }) {
  return (
    <div className="page-screen">
      {components.map((component, index) => (
        <Block key={'id' in component ? `#${component.id}` : String(index)} component={component} target={target} />
      ))}
    </div>
  );
}

function Block({ component, target }: { component: ComponentView; target?: ActionTarget }) {
  let body: ReactNode;
  if (component.type === 'table') body = <TableBlock component={component} target={target} />;
  else if (component.type === 'graph') body = <GraphBlock component={component} target={target} />;
  else if (component.type === 'info') body = <InfoBlock component={component} target={target} />;
  else if (component.type === 'markdown') body = <MarkdownBlock component={component} target={target} />;
  else body = <ActionsBlock component={component} target={target} />;
  return (
    <div className="page-block">
      {component.label && <h3 className="page-block-label">{component.label}</h3>}
      {component.description && <p className="page-block-description">{component.description}</p>}
      {body}
    </div>
  );
}

/** 取数失败：这一块写明原因，可以重试，别的块照常 */
function Failed({ label, error, retry }: { label?: string; error: Error; retry(): void }) {
  return (
    <EmptyState
      tone="danger"
      title={`${label ?? '这一块'}没取到`}
      description={error.message}
      action={<Button onClick={retry}>重试</Button>}
    />
  );
}

// ----- 主从 -----

/** 选中写进地址：从没选中到选中是新的一条历史（后退回到列表），换选一行替换这一条 */
function useSelection(componentId: string) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const goBack = useBack();
  const open = params.has('detail');
  const selected = params.get('detail') === componentId ? (params.get('row') ?? undefined) : undefined;
  const hrefOf = (rowKey: string) => {
    const next = new URLSearchParams(params);
    next.set('detail', componentId);
    next.set('row', rowKey);
    return `${pathname}?${next}`;
  };
  const closed = new URLSearchParams(params);
  closed.delete('detail');
  closed.delete('row');
  const query = closed.toString();
  const list = query ? `${pathname}?${query}` : pathname;
  return {
    selected,
    /** 选中一行的链接与是否替换当前这条历史 */
    linkOf: (rowKey: string) => ({ to: hrefOf(rowKey), replace: open }),
    select: (rowKey: string) => navigate(hrefOf(rowKey), { replace: open }),
    close: () => goBack(list),
  };
}

function MasterDetail({
  list,
  detail,
  title,
  target,
  close,
}: {
  list: ReactNode;
  detail: readonly ComponentView[];
  /** 详情的标题：选中的那一行或那个节点 */
  title: string;
  target?: ActionTarget;
  close(): void;
}) {
  const headingId = useId();
  return (
    <div className="page-master" data-open={target ? true : undefined}>
      <div className="page-master-list">{list}</div>
      {target && (
        <section className="page-detail" aria-labelledby={headingId}>
          <div className="page-detail-header">
            <span data-narrow>
              <IconButton icon={ArrowLeft} label="返回列表" onClick={close} />
            </span>
            <h3 id={headingId} className="page-detail-title">
              {title}
            </h3>
            <span data-wide>
              <IconButton icon={X} label="关闭详情" onClick={close} />
            </span>
          </div>
          <Screen key={target.rowKey} components={detail} target={target} />
        </section>
      )}
    </div>
  );
}

// ----- 表格 -----

/** 选中链接放在哪一列：先找写字的列；链接、文件与长文本本身就是控件，图片没有字，最后才用 */
const TEXTUAL = new Set([undefined, 'text', 'code', 'time', 'countdown', 'status']);

function TableBlock({ component, target }: { component: Of<'table'>; target?: ActionTarget }) {
  const { value: rows, error, retry } = usePageData('table', component.id, target?.rowKey);
  const selection = useSelection(component.id);
  const { page } = usePageScope();
  if (error) return <Failed label={component.label} error={error} retry={retry} />;
  if (!rows) return null;

  const keyOf = (row: PageRow) => String(row[component.rowKey]);
  const detail = component.detail;
  const linkColumn = detail
    ? (component.columns.find(column => column.primary && TEXTUAL.has(column.kind)) ??
      component.columns.find(column => TEXTUAL.has(column.kind)) ??
      component.columns.find(column => column.kind === 'image'))
    : undefined;
  // 窄时只留 primary 的列：都没标时留第一列，选中用的链接列总留着
  const marked = component.columns.some(column => column.primary);
  const columns: TableColumn<PageRow>[] = component.columns.map((column, index) => {
    const values = rows.map(row => row[column.key]);
    const numeric =
      (column.kind ?? 'text') === 'text' &&
      values.some(value => typeof value === 'number') &&
      values.every(value => value == null || typeof value === 'number');
    // 数字列的小数位对齐：按这一列最多的小数位补齐
    const digits = numeric
      ? values.reduce<number>((most, value) => Math.max(most, typeof value === 'number' ? fractionDigits(value) : 0), 0)
      : undefined;
    const cell = (row: PageRow) => (
      <Cell kind={column.kind} value={row[column.key]} label={column.label} digits={digits} />
    );
    return {
      key: column.key,
      label: column.label,
      primary: column.primary || column === linkColumn || (!marked && index === 0),
      numeric,
      sortValue:
        column.kind === 'image' || column.kind === 'file' ? undefined : row => sortValue(column.kind, row[column.key]),
      render:
        column === linkColumn
          ? row => (
              <Link
                {...selection.linkOf(keyOf(row))}
                className="page-select"
                aria-current={keyOf(row) === selection.selected || undefined}
              >
                {cell(row)}
              </Link>
            )
          : cell,
    };
  });
  const selectedRow = rows.find(row => keyOf(row) === selection.selected);
  const table = (
    <Table
      label={component.label ?? page.title}
      rows={rows}
      rowKey={keyOf}
      columns={columns}
      empty={component.empty ?? NO_CONTENT}
      search={row => component.columns.map(column => cellText(row[column.key])).join(' ')}
      rowActions={
        component.rowActions && component.rowActions.length > 0
          ? row => <RowActions entries={component.rowActions ?? []} target={{ rowKey: keyOf(row), row }} />
          : undefined
      }
      current={selectedRow ? selection.selected : undefined}
      onRowClick={detail ? row => selection.select(keyOf(row)) : undefined}
    />
  );
  if (!detail) return table;
  return (
    <MasterDetail
      list={table}
      detail={detail}
      title={
        selectedRow
          ? (linkColumn && TEXTUAL.has(linkColumn.kind) && cellText(selectedRow[linkColumn.key])) || keyOf(selectedRow)
          : ''
      }
      target={selectedRow ? { rowKey: keyOf(selectedRow), row: selectedRow } : undefined}
      close={selection.close}
    />
  );
}

/**
 * 一行上的动作：visibleWhen 为假的不显示。宽时第一个不是 destructive 的动作是文字按钮，其余进「更多」；
 * 窄时全部进「更多」。这一行有动作还没回来时显示「进行中」
 */
function RowActions({ entries, target }: { entries: readonly RowAction[]; target: ActionTarget }) {
  const { actions, run, busy } = useActions();
  const visible = entries
    .filter(entry => entry.visibleWhen === undefined || target.row?.[entry.visibleWhen] === true)
    .map(entry => ({ name: entry.action, action: actions[entry.action] }));
  if (visible.some(({ name }) => busy(name, target))) {
    return (
      <span className="page-row-busy" role="status" aria-label="进行中">
        <LoaderCircle aria-hidden className="spin" />
      </span>
    );
  }
  const inline = visible.find(({ action }) => action.effect !== 'destructive');
  const rest = visible.filter(entry => entry !== inline);
  const menu = (list: typeof visible) => (
    <Menu
      label="更多"
      items={list.map(({ name, action }) => ({
        label: action.label,
        danger: action.effect === 'destructive',
        onSelect: () => run(name, target),
      }))}
    />
  );
  if (!inline) return rest.length > 0 ? menu(rest) : null;
  return (
    <div className="page-row-actions">
      <span data-wide>
        <Button variant="text" onClick={() => run(inline.name, target)}>
          {inline.action.label}
        </Button>
        {rest.length > 0 && menu(rest)}
      </span>
      <span data-narrow>{menu(visible)}</span>
    </div>
  );
}

// ----- 关系图 -----

function GraphBlock({ component, target }: { component: Of<'graph'>; target?: ActionTarget }) {
  const { value: data, error, retry } = usePageData('graph', component.id, target?.rowKey);
  const selection = useSelection(component.id);
  if (error) return <Failed label={component.label} error={error} retry={retry} />;
  if (!data) return null;
  if (data.nodes.length === 0) return <p className="page-empty">{component.empty ?? NO_CONTENT}</p>;
  const selected = data.nodes.find(node => node.id === selection.selected);
  const graph = (
    <Graph
      data={data}
      nodeKinds={component.nodeKinds ?? []}
      edgeKinds={component.edgeKinds ?? []}
      spacing={component.spacing}
      selected={selected?.id}
      onSelect={component.detail ? selection.select : undefined}
    />
  );
  if (!component.detail) return graph;
  return (
    <MasterDetail
      list={graph}
      detail={component.detail}
      title={selected?.label ?? ''}
      target={selected ? { rowKey: selected.id } : undefined}
      close={selection.close}
    />
  );
}

// ----- 键值、文字与按钮组 -----

function InfoBlock({ component, target }: { component: Of<'info'>; target?: ActionTarget }) {
  const { value: items, error, retry } = usePageData('info', component.id, target?.rowKey);
  if (error) return <Failed label={component.label} error={error} retry={retry} />;
  if (!items) return null;
  return (
    <dl className="page-info">
      {items.map((item, index) => (
        <div key={`${index}:${item.label}`} className="page-info-item">
          <dt>{item.label}</dt>
          <dd data-numeric={typeof item.value === 'number' || undefined}>
            <Cell kind={item.kind} value={item.value} label={item.label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MarkdownBlock({ component, target }: { component: Of<'markdown'>; target?: ActionTarget }) {
  const { value: text, error, retry } = usePageData('markdown', component.id, target?.rowKey);
  if (error) return <Failed label={component.label} error={error} retry={retry} />;
  if (text === undefined) return null;
  return (
    <div className="page-markdown">
      <Markdown text={text} />
    </div>
  );
}

/** 一组按钮：插件页面里一律是次要按钮，destructive 是危险色字的文字按钮；详情里的作用于选中的那一行 */
function ActionsBlock({ component, target }: { component: Of<'actions'>; target?: ActionTarget }) {
  const { actions, run, busy } = useActions();
  return (
    <div className="page-actions">
      {component.actions.map(name => {
        const action: ActionView = actions[name];
        const destructive = action.effect === 'destructive';
        return (
          <Button
            key={name}
            variant={destructive ? 'text' : 'secondary'}
            danger={destructive}
            busy={busy(name, target)}
            onClick={() => run(name, target)}
          >
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}
