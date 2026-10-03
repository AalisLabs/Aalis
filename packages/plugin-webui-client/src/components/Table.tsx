import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from './Button';
import './Table.css';

/** 一页的行数；行数超过一页才出现搜索框与分页 */
export const TABLE_PAGE_SIZE = 50;

export interface TableColumn<Row> {
  key: string;
  label: string;
  render(row: Row): ReactNode;
  /** 给出时这一列可以排序 */
  sortValue?(row: Row): string | number;
  /** 窄时（手机、面板）仍显示的列 */
  primary?: boolean;
  /** 数字列：右对齐、等宽数字 */
  numeric?: boolean;
}

interface TableFilterField<Row> {
  key: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  matches(row: Row, value: string): boolean;
}

/** 筛选条：选中的值由调用方持有（房间表写进地址），没有值的项是「全部」 */
interface TableFilter<Row> {
  fields: ReadonlyArray<TableFilterField<Row>>;
  values: Readonly<Record<string, string>>;
  onChange(values: Record<string, string>): void;
}

/** 批量选择：选中的行由调用方持有 */
interface TableSelection<Row> {
  selected: ReadonlySet<string>;
  onChange(selected: ReadonlySet<string>): void;
  /** 这一行的复选框的读屏名字 */
  rowLabel(row: Row): string;
  /** 批量动作；keys 只含当前筛选结果里选中的行 */
  actions(keys: string[]): ReactNode;
}

interface TableProps<Row> {
  label: string;
  rows: readonly Row[];
  rowKey(row: Row): string;
  columns: ReadonlyArray<TableColumn<Row>>;
  /** 一行数据都没有时写的一句 */
  empty: string;
  /** 给出时可以搜索，按它取的文字匹配 */
  search?(row: Row): string;
  filter?: TableFilter<Row>;
  selection?: TableSelection<Row>;
  /** 行尾的操作，窄时也在 */
  rowActions?(row: Row): ReactNode;
  /** 选中看详情的行 */
  current?: string;
  /** 点一行（不是点在行里的控件上）选中它 */
  onRowClick?(row: Row): void;
}

function compare(a: string | number, b: string | number): number {
  return typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
}

/** 表格：排序、搜索、筛选与分页都在客户端做；窄时只留标了 primary 的列 */
export function Table<Row>({
  label,
  rows,
  rowKey,
  columns,
  empty,
  search,
  filter,
  selection,
  rowActions,
  current,
  onRowClick,
}: TableProps<Row>) {
  const id = useId();
  const [sort, setSort] = useState<{ key: string; descending: boolean }>();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const needle = query.trim().toLowerCase();
  const filtered = rows.filter(
    row =>
      (filter?.fields ?? []).every(field => {
        const value = filter?.values[field.key];
        return !value || field.matches(row, value);
      }) &&
      (!needle || (search as (row: Row) => string)(row).toLowerCase().includes(needle)),
  );
  const sortValue = columns.find(column => column.key === sort?.key)?.sortValue;
  const sorted =
    sort && sortValue
      ? [...filtered].sort((a, b) => compare(sortValue(a), sortValue(b)) * (sort.descending ? -1 : 1))
      : filtered;

  const pageCount = Math.max(1, Math.ceil(sorted.length / TABLE_PAGE_SIZE));
  const shownPage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(shownPage * TABLE_PAGE_SIZE, (shownPage + 1) * TABLE_PAGE_SIZE);
  // 搜索框在行数超过一页时出现；正在搜索时留着，好把搜索清掉
  const searchable = search !== undefined && (rows.length > TABLE_PAGE_SIZE || query !== '');

  const filteredKeys = filtered.map(rowKey);
  const chosen = selection ? filteredKeys.filter(key => selection.selected.has(key)) : [];
  const allChosen = filteredKeys.length > 0 && chosen.length === filteredKeys.length;

  const toggleAll = (target: TableSelection<Row>) => {
    const next = new Set(target.selected);
    for (const key of filteredKeys) {
      if (allChosen) next.delete(key);
      else next.add(key);
    }
    target.onChange(next);
  };

  const toggleRow = (target: TableSelection<Row>, key: string) => {
    const next = new Set(target.selected);
    if (!next.delete(key)) next.add(key);
    target.onChange(next);
  };

  const clearFilters = () => {
    setQuery('');
    setPage(0);
    filter?.onChange({});
  };

  return (
    <div className="table">
      {(filter || searchable) && (
        <div className="table-toolbar">
          {filter?.fields.map(field => (
            <div key={field.key} className="table-filter">
              <label htmlFor={`${id}-${field.key}`}>{field.label}</label>
              <select
                id={`${id}-${field.key}`}
                value={filter.values[field.key] ?? ''}
                onChange={event => {
                  setPage(0);
                  const { [field.key]: _, ...others } = filter.values;
                  filter.onChange(event.target.value ? { ...others, [field.key]: event.target.value } : others);
                }}
              >
                <option value="">全部</option>
                {field.options.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {searchable && (
            <input
              type="search"
              aria-label={`搜索${label}`}
              placeholder="搜索"
              value={query}
              onChange={event => {
                setPage(0);
                setQuery(event.target.value);
              }}
            />
          )}
        </div>
      )}
      {selection && chosen.length > 0 && (
        <div className="table-batch">
          <span>{`已选 ${chosen.length} 项`}</span>
          {selection.actions(chosen)}
          <Button variant="text" onClick={() => selection.onChange(new Set())}>
            取消选择
          </Button>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <caption className="visually-hidden">{label}</caption>
          <thead>
            <tr>
              {selection && (
                <th className="table-check">
                  <label>
                    <input
                      type="checkbox"
                      aria-label="全选筛选结果"
                      checked={allChosen}
                      disabled={filteredKeys.length === 0}
                      ref={element => {
                        if (element) element.indeterminate = chosen.length > 0 && !allChosen;
                      }}
                      onChange={() => toggleAll(selection)}
                    />
                  </label>
                </th>
              )}
              {columns.map(column => (
                <th
                  key={column.key}
                  scope="col"
                  data-column={column.key}
                  data-primary={column.primary || undefined}
                  data-numeric={column.numeric || undefined}
                  aria-sort={sort?.key === column.key ? (sort.descending ? 'descending' : 'ascending') : undefined}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      className="table-sort"
                      onClick={() =>
                        setSort({ key: column.key, descending: sort?.key === column.key && !sort.descending })
                      }
                    >
                      {column.label}
                      {sort?.key !== column.key ? (
                        <ArrowUpDown aria-hidden />
                      ) : sort.descending ? (
                        <ArrowDown aria-hidden />
                      ) : (
                        <ArrowUp aria-hidden />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
              {rowActions && (
                <th scope="col" className="table-actions">
                  <span className="visually-hidden">操作</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map(row => {
              const key = rowKey(row);
              const checked = selection?.selected.has(key);
              return (
                <tr
                  key={key}
                  data-selected={checked || undefined}
                  data-current={key === current || undefined}
                  data-clickable={onRowClick ? true : undefined}
                  onClick={
                    onRowClick &&
                    (event => {
                      if (!(event.target as Element).closest('a, button, input, select, textarea, label')) {
                        onRowClick(row);
                      }
                    })
                  }
                >
                  {selection && (
                    <td className="table-check">
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${selection.rowLabel(row)}`}
                          checked={checked}
                          onChange={() => toggleRow(selection, key)}
                        />
                      </label>
                    </td>
                  )}
                  {columns.map(column => (
                    <td
                      key={column.key}
                      data-column={column.key}
                      data-primary={column.primary || undefined}
                      data-numeric={column.numeric || undefined}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                  {rowActions && <td className="table-actions">{rowActions(row)}</td>}
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td className="table-empty" colSpan={columns.length + (selection ? 1 : 0) + (rowActions ? 1 : 0)}>
                  {rows.length === 0 ? (
                    empty
                  ) : (
                    <>
                      没有符合筛选的项
                      <Button variant="text" onClick={clearFilters}>
                        清除筛选
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <nav className="table-pager" aria-label="分页">
          <Button variant="text" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>
            上一页
          </Button>
          <span>{`第 ${shownPage + 1} / ${pageCount} 页`}</span>
          <Button variant="text" disabled={shownPage === pageCount - 1} onClick={() => setPage(shownPage + 1)}>
            下一页
          </Button>
        </nav>
      )}
    </div>
  );
}
