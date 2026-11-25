import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';
import { ErrorState } from './ErrorState';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?(row: T, index: number): ReactNode;
  className?: string;
  headerClassName?: string;
  /** 可点击排序；默认用 row[column.key]，复杂字段请提供 sortValue。 */
  sortable?: boolean;
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'center' | 'right';
  width?: string | number;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** 受控排序（可选）。不传则组件内部维护。 */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  initialSort?: SortState | null;
  dense?: boolean;
  stickyHeader?: boolean;
  footer?: ReactNode;
  className?: string;
  caption?: string;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/** 通用数据表：排序、加载骨架、错误与空状态都内置，列渲染完全由调用方决定。 */
export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  const [internalSort, setInternalSort] = useState<SortState | null>(
    props.initialSort ?? null,
  );
  const sort = props.sort === undefined ? internalSort : props.sort;

  const sortedRows = useMemo(() => {
    if (sort === null) return props.rows;
    const column = props.columns.find((item) => item.key === sort.key);
    if (column === undefined) return props.rows;
    const valueOf = (row: T): unknown =>
      column.sortValue === undefined
        ? (row as Record<string, unknown>)[column.key]
        : column.sortValue(row);
    const copy = [...props.rows];
    copy.sort((left, right) => {
      const result = compareValues(valueOf(left), valueOf(right));
      return sort.direction === 'asc' ? result : -result;
    });
    return copy;
  }, [props.rows, props.columns, sort]);

  const handleSort = (column: Column<T>): void => {
    if (column.sortable !== true) return;
    let next: SortState | null;
    if (sort === null || sort.key !== column.key) {
      next = { key: column.key, direction: 'asc' };
    } else if (sort.direction === 'asc') {
      next = { key: column.key, direction: 'desc' };
    } else {
      next = null;
    }
    if (props.onSortChange === undefined) setInternalSort(next);
    else props.onSortChange(next);
  };

  const colCount = props.columns.length;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-app-border bg-app-surface',
        props.className,
      )}
    >
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead
            className={cn(
              'bg-app-elevated/80 text-left',
              props.stickyHeader === true ? 'sticky top-0 z-10 backdrop-blur' : '',
            )}
          >
            <tr>
              {props.columns.map((column) => {
                const active = sort !== null && sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width === undefined ? undefined : { width: column.width }}
                    aria-sort={
                      active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      'whitespace-nowrap border-b border-app-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-app-muted',
                      column.align === 'right' ? 'text-right' : '',
                      column.align === 'center' ? 'text-center' : '',
                      column.headerClassName,
                    )}
                  >
                    {column.sortable === true ? (
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        className={cn(
                          'inline-flex items-center gap-1 hover:text-app-text',
                          column.align === 'right' ? 'flex-row-reverse' : '',
                        )}
                      >
                        {column.header}
                        {active ? (
                          sort?.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {props.error !== undefined ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-4">
                  <ErrorState error={props.error} onRetry={props.onRetry} />
                </td>
              </tr>
            ) : props.loading === true && props.rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-10 text-center">
                  <Spinner label="加载中…" />
                </td>
              </tr>
            ) : sortedRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-10 text-center">
                  <div className="text-app-muted">{props.empty ?? '暂无数据'}</div>
                </td>
              </tr>
            ) : (
              sortedRows.map((row, index) => (
                <tr
                  key={props.rowKey(row)}
                  onClick={
                    props.onRowClick === undefined ? undefined : () => props.onRowClick?.(row)
                  }
                  className={cn(
                    'border-b border-app-border/70 last:border-b-0',
                    props.onRowClick === undefined
                      ? ''
                      : 'cursor-pointer transition-colors hover:bg-app-elevated/60',
                    props.rowClassName?.(row),
                  )}
                >
                  {props.columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-3 text-app-text',
                        props.dense === true ? 'py-1.5' : 'py-2.5',
                        column.align === 'right' ? 'text-right' : '',
                        column.align === 'center' ? 'text-center' : '',
                        column.className,
                      )}
                    >
                      {column.render === undefined
                        ? renderDefault(row, column.key)
                        : column.render(row, index)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {props.loading === true && props.rows.length > 0 ? (
        <div className="flex items-center justify-center border-t border-app-border px-3 py-2">
          <Spinner size="sm" label="刷新中…" />
        </div>
      ) : null}
      {props.footer === undefined ? null : (
        <div className="border-t border-app-border px-3 py-2 text-xs text-app-muted">
          {props.footer}
        </div>
      )}
    </div>
  );
}

function renderDefault<T>(row: T, key: string): ReactNode {
  const value = (row as Record<string, unknown>)[key];
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '—';
}
