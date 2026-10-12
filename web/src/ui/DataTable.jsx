import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { SkeletonRows } from './common.jsx';

const PAGE_SIZE = 50;

/**
 * 表格工具栏：左边搜索 + 筛选（children），右边数量和次要操作（end）。
 * selection 有值（{count, actions, onClear}）时换成批量操作栏。
 */
export function TableToolbar({ search, onSearch, searchPlaceholder = '搜索', children, count, end, selection }) {
  const [text, setText] = useState(search || '');
  useEffect(() => setText(search || ''), [search]);
  useEffect(() => {
    if (!onSearch || text === (search || '')) return undefined;
    const t = setTimeout(() => onSearch(text), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  if (selection?.count > 0) {
    return (
      <div className="table-toolbar table-toolbar--selection" role="toolbar" aria-label="批量操作">
        <span className="text-strong num">已选 {selection.count} 条</span>
        {selection.actions}
        <div className="table-toolbar__end">
          <button type="button" className="btn btn--ghost btn--sm" onClick={selection.onClear}>
            取消选择
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="table-toolbar">
      {onSearch && (
        <div className="input-group table-toolbar__search">
          <Search className="input-group__icon" aria-hidden="true" />
          <input
            className="input input--sm"
            type="search"
            value={text}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(e) => setText(e.target.value)}
          />
          {text && (
            <button type="button" className="input-group__clear" onClick={() => setText('')} aria-label="清空搜索">
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {children}
      {(count != null || end) && (
        <div className="table-toolbar__end">
          {count != null && <span className="table-toolbar__count">共 {count} 条</span>}
          {end}
        </div>
      )}
    </div>
  );
}

function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
}

/**
 * 数据表：前端排序、分页、多选、整行点击、可展开行。
 *
 * columns: [{
 *   key, header, render(row) → node,
 *   sortValue?(row) → 可排序时给值, align?: 'num', shrink?: bool,
 *   hide?: 'md' | 'sm'   // 窄于 768 / 640 时隐藏
 * }]
 * rows: 数组；null 表示加载中（显示骨架）
 * rowKey(row), onRowClick(row), isRowActive(row)
 * selectable + selected(Set of keys) + onSelectedChange(Set)
 * renderExpanded(row) + expandedKey：展开某一行
 * defaultSort: {key, dir: 'asc'|'desc'}
 * empty: 没有数据时显示的节点
 */
export function DataTable({
  columns,
  rows,
  rowKey = (r) => r.id,
  onRowClick,
  isRowActive,
  selectable = false,
  selected,
  onSelectedChange,
  renderExpanded,
  expandedKey,
  defaultSort,
  empty,
  pageSize = PAGE_SIZE,
  label,
}) {
  const [sort, setSort] = useState(defaultSort || null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!rows) return null;
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const out = [...rows].sort((a, b) => compare(col.sortValue(a), col.sortValue(b)));
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort, columns]);

  const total = sorted?.length || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > pages - 1) setPage(0);
  }, [page, pages]);
  const visible = sorted ? sorted.slice(page * pageSize, (page + 1) * pageSize) : null;

  const toggleSort = (key) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return defaultSort || null;
    });
  };

  const visibleKeys = (visible || []).map(rowKey);
  const allChecked = selectable && visibleKeys.length > 0 && visibleKeys.every((k) => selected?.has(k));
  const someChecked = selectable && visibleKeys.some((k) => selected?.has(k));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allChecked) visibleKeys.forEach((k) => next.delete(k));
    else visibleKeys.forEach((k) => next.add(k));
    onSelectedChange(next);
  };
  const toggleOne = (k) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onSelectedChange(next);
  };

  const colCount = columns.length + (selectable ? 1 : 0);
  const cellClass = (c) =>
    [c.align === 'num' && 'is-num', c.shrink && 'is-shrink', c.fluid && 'is-fluid', c.hide && `hide-${c.hide}`].filter(Boolean).join(' ') || undefined;

  if (rows == null) return <SkeletonRows rows={5} />;

  return (
    <>
      <div className="table-wrap">
        <table className="table" aria-label={label}>
          <thead>
            <tr>
              {selectable && (
                <th className="is-check">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = !allChecked && someChecked;
                    }}
                    onChange={toggleAll}
                    aria-label="全选本页"
                  />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined;
                return (
                  <th key={c.key} className={cellClass(c)} aria-sort={ariaSort} scope="col">
                    {c.sortValue ? (
                      <button type="button" className="table__sort" data-active={active} onClick={() => toggleSort(c.key)}>
                        {c.header}
                        {active ? sort.dir === 'asc' ? <ArrowUp /> : <ArrowDown /> : <ChevronsUpDown />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {total === 0 ? (
              <tr className="table__empty">
                <td colSpan={colCount}>{empty}</td>
              </tr>
            ) : (
              visible.map((row) => {
                const k = rowKey(row);
                const expanded = renderExpanded && expandedKey === k;
                const cls = [
                  onRowClick && 'table__row--clickable',
                  (selected?.has(k) || isRowActive?.(row)) && 'is-selected',
                  expanded && 'is-expanded',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <Fragment key={k}>
                    <tr
                      className={cls || undefined}
                      tabIndex={onRowClick ? 0 : undefined}
                      aria-expanded={renderExpanded ? !!expanded : undefined}
                      onClick={
                        onRowClick
                          ? (e) => {
                              // 行里的按钮、链接、输入框自己处理点击
                              if (e.target.closest('button, a, input, select, textarea, label')) return;
                              onRowClick(row);
                            }
                          : undefined
                      }
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
                            }
                          : undefined
                      }
                    >
                      {selectable && (
                        <td className="is-check">
                          <input
                            type="checkbox"
                            className="checkbox"
                            checked={!!selected?.has(k)}
                            onChange={() => toggleOne(k)}
                            aria-label="选择这一行"
                          />
                        </td>
                      )}
                      {columns.map((c) => (
                        <td key={c.key} className={cellClass(c)}>
                          {c.render(row)}
                        </td>
                      ))}
                    </tr>
                    {expanded && (
                      <tr className="table__expanded">
                        <td colSpan={colCount}>{renderExpanded(row)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pagination">
          <span>
            {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} / {total}
          </span>
          <button
            type="button"
            className="btn btn--sm btn--icon"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 0}
            aria-label="上一页"
          >
            <ChevronLeft />
          </button>
          <button
            type="button"
            className="btn btn--sm btn--icon"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= pages - 1}
            aria-label="下一页"
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </>
  );
}

/** 表格里"主文字 + 下面一行灰字"的单元格 */
export function CellText({ primary, secondary }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="table__primary ellipsis">{primary}</div>
      {secondary && <div className="table__secondary ellipsis">{secondary}</div>}
    </div>
  );
}

/** 行操作：桌面端悬停时出现 */
export function RowActions({ children }) {
  return <div className="table__actions">{children}</div>;
}
