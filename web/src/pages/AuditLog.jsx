import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api } from '../api/client.js';
import { Drawer } from '../ui/Drawer.jsx';
import { Select } from '../ui/Select.jsx';
import { StatusDot } from '../ui/StatusDot.jsx';
import { Tooltip } from '../ui/Popover.jsx';
import { CellText, DataTable, TableToolbar } from '../ui/DataTable.jsx';
import { EmptyState, ErrorState, PageHeader, Spinner } from '../ui/common.jsx';
import { roleLabel } from '../lib/labels.js';
import { fmtClock, fmtDay, fmtFull, fmtHm } from '../lib/format.js';

/**
 * 操作日志（只有管理员能看）：谁在什么时候做了什么。日志只能看，不能改、不能删；过期的由服务端自动清。
 * GET /api/audit-logs?actorId=&type=&from=&q=&cursor= 按时间倒序，一页 50 条；往下滚到底自动加载下一页（也可以点「加载更多」）。
 * 筛选（成员、操作类型、时间、关键字）都交给服务端；改了筛选从第一页重新查。点一行打开抽屉看全部改动。
 */

const PAGE_SIZE = 50;

/** 时间范围：不用原生日期控件，给几个常用的 */
const RANGES = [
  { value: '', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '90', label: '最近 90 天' },
];
/** 时间范围 → from（ISO）。今天从本地零点算 */
function rangeFrom(range) {
  if (!range) return '';
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(Date.now() - Number(range) * 86400000).toISOString();
}

/** 完整时间带秒：2026年10月12日 14:30:05 */
const fullTime = (iso) => {
  const full = fmtFull(iso);
  return full ? `${full.split(' ')[0]} ${fmtClock(iso)}` : '—';
};

/** 表格里的时间：日志要看到几点几分，所以今天写 14:30，往前写 昨天 14:30 / 10月3日 14:30；悬停看到秒 */
function LogTime({ iso }) {
  const day = fmtDay(iso);
  if (!day) return <span className="muted">—</span>;
  return (
    <Tooltip content={fullTime(iso)}>
      <span className="nowrap num">{day === '今天' ? fmtHm(iso) : `${day} ${fmtHm(iso)}`}</span>
    </Tooltip>
  );
}

/** 操作人：名字（没有名字写邮箱）；登录失败时可能只有输入的邮箱 */
const actorName = (a) => a?.name || a?.email || '（未知）';

/** 一项改动的文字：前 → 后；密钥和长文本只有说明（已修改、已填写 N 字） */
function changeText(c) {
  if (c.from !== undefined || c.to !== undefined) return `${c.from ?? ''} → ${c.to ?? ''}${c.note ? `（${c.note}）` : ''}`;
  return c.secret ? `${c.note || '已修改'}（不记录内容）` : c.note || '已修改';
}

function Result({ log }) {
  if (log.ok) return <StatusDot tone="success">成功</StatusDot>;
  return (
    <StatusDot tone="danger" title={log.error || undefined}>
      失败
    </StatusDot>
  );
}

/* ---------- 详情抽屉 ---------- */

function LogDrawer({ log, onClose }) {
  const a = log.actor;
  return (
    <Drawer open title="操作详情" onClose={onClose}>
      <div className="vstack audit-drawer">
        <p className="audit-drawer__summary">{log.summary}</p>
        <dl className="kv">
          <dt>时间</dt>
          <dd className="num">{fullTime(log.at)}</dd>
          <dt>操作人</dt>
          <dd>
            {actorName(a)}
            {a?.name && a?.email && <span className="muted"> · {a.email}</span>}
            {a?.role && <span className="muted"> · {roleLabel(a.role)}</span>}
          </dd>
          <dt>类型</dt>
          <dd>
            {log.categoryLabel}
            <span className="muted mono"> {log.action}</span>
          </dd>
          {log.target && (
            <>
              <dt>对象</dt>
              <dd>
                {log.target.typeLabel}
                {log.target.name ? `「${log.target.name}」` : ''}
              </dd>
            </>
          )}
          <dt>结果</dt>
          <dd>
            <Result log={log} />
            {!log.ok && log.status > 0 && <span className="muted num"> · HTTP {log.status}</span>}
          </dd>
          {!log.ok && log.error && (
            <>
              <dt>原因</dt>
              <dd className="text-danger">{log.error}</dd>
            </>
          )}
          <dt>IP</dt>
          <dd className="num">{log.ip || '—'}</dd>
          <dt>设备</dt>
          <dd>{log.device || '—'}</dd>
        </dl>
        {log.changes.length > 0 && (
          <section>
            <h3 className="audit-drawer__title">改动（{log.changes.length} 项）</h3>
            <ul className="audit-changes">
              {log.changes.map((c) => (
                <li key={c.field}>
                  <div className="audit-changes__label" title={c.field}>
                    {c.label}
                  </div>
                  <div className="audit-changes__value">{changeText(c)}</div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}

/* ---------- 页面 ---------- */

export default function AuditLogPage() {
  const [items, setItems] = useState(null); // null = 加载中
  const [nextCursor, setNextCursor] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);
  const [q, setQ] = useState('');
  const [actorId, setActorId] = useState('');
  const [type, setType] = useState('');
  const [range, setRange] = useState('');
  const [members, setMembers] = useState([]);
  const [types, setTypes] = useState([]);
  const [openLog, setOpenLog] = useState(null);
  /** 每次改筛选加一，旧筛选的结果回来了直接丢掉 */
  const gen = useRef(0);
  /** 当前筛选的查询条件（翻页沿用，from 不随时间往后挪） */
  const queryRef = useRef(null);
  const sentinel = useRef(null);

  const load = useCallback(async () => {
    const my = ++gen.current;
    const query = { q: q.trim(), actorId, type, from: rangeFrom(range), limit: PAGE_SIZE };
    queryRef.current = query;
    setItems(null);
    setNextCursor(null);
    setError(null);
    setMoreError(null);
    setLoadingMore(false);
    try {
      const res = await api.listAuditLogs(query, { silent: true });
      if (gen.current !== my) return;
      setItems(Array.isArray(res?.items) ? res.items : []);
      setNextCursor(res?.nextCursor || null);
    } catch (e) {
      if (gen.current === my) setError(e);
    }
  }, [q, actorId, type, range]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const my = gen.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api.listAuditLogs({ ...queryRef.current, cursor: nextCursor }, { silent: true });
      if (gen.current !== my) return;
      setItems((prev) => [...(prev || []), ...(Array.isArray(res?.items) ? res.items : [])]);
      setNextCursor(res?.nextCursor || null);
    } catch (e) {
      if (gen.current === my) setMoreError(e);
    } finally {
      if (gen.current === my) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  // 滚到列表底部附近时自动加载下一页；加载出错后要手动点重试，不自动反复请求
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !nextCursor || moreError || loadingMore || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, moreError, loadingMore, loadMore]);

  // 筛选用的成员和操作类型，取一次
  useEffect(() => {
    let alive = true;
    api
      .listUsers({ silent: true })
      .then((list) => alive && setMembers(Array.isArray(list) ? list : []))
      .catch(() => {});
    api
      .auditLogTypes({ silent: true })
      .then((list) => alive && setTypes(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const filtering = !!(q.trim() || actorId || type || range);
  const clearFilters = () => {
    setQ('');
    setActorId('');
    setType('');
    setRange('');
  };
  const emptyAll = !error && items != null && items.length === 0 && !filtering;

  const memberOptions = [
    { value: '', label: '全部成员' },
    ...members.map((m) => ({ value: m.id, label: m.name || m.email, desc: m.name ? m.email : undefined })),
  ];
  const typeOptions = [{ value: '', label: '全部类型' }, ...types.map((x) => ({ value: x.value, label: x.label }))];

  // 窄屏隐藏：< 1280 详情、IP、设备；< 768 对象；< 640 操作人（挪到说明下面一行）
  const columns = [
    {
      key: 'at',
      header: '时间',
      shrink: true,
      render: (l) => <LogTime iso={l.at} />,
    },
    {
      key: 'actor',
      header: '操作人',
      hide: 'sm',
      render: (l) => (
        <div className="audit-page__actor">
          <CellText
            primary={<span title={l.actor?.email || undefined}>{actorName(l.actor)}</span>}
            secondary={l.actor?.role ? roleLabel(l.actor.role) : l.actor?.email && l.actor?.name ? l.actor.email : null}
          />
        </div>
      ),
    },
    {
      key: 'summary',
      header: '操作',
      fluid: true,
      render: (l) => (
        <CellText
          primary={<span title={l.summary}>{l.summary}</span>}
          secondary={
            <>
              <span className="audit-page__actor-inline">{actorName(l.actor)} · </span>
              {l.ok ? (
                l.categoryLabel
              ) : (
                <span className="text-danger" title={l.error || undefined}>
                  {l.error || '失败'}
                </span>
              )}
            </>
          }
        />
      ),
    },
    {
      key: 'target',
      header: '对象',
      hide: 'md',
      render: (l) =>
        l.target ? (
          <span className="audit-page__cell ellipsis" title={l.target.name || undefined}>
            <span className="muted">{l.target.typeLabel}</span>
            {l.target.name ? ` ${l.target.name}` : ''}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'changes',
      header: '详情',
      hide: 'xl',
      render: (l) => {
        if (!l.changes.length) return <span className="muted">—</span>;
        const text = l.changes.map((c) => `${c.label}：${changeText(c)}`).join('；');
        return (
          <span className="audit-page__cell audit-page__cell--wide ellipsis" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      key: 'ip',
      header: 'IP',
      hide: 'xl',
      shrink: true,
      render: (l) => <span className="num">{l.ip || '—'}</span>,
    },
    {
      key: 'device',
      header: '设备',
      hide: 'xl',
      render: (l) =>
        l.device ? (
          <span className="audit-page__cell ellipsis" title={l.device}>
            {l.device}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'result',
      header: '结果',
      shrink: true,
      render: (l) => <Result log={l} />,
    },
  ];

  let body;
  if (emptyAll) {
    body = <EmptyState fill icon={ScrollText} title="暂无操作记录" desc="记录成员修改设置、编辑知识库、分配会话、登录等操作。" />;
  } else {
    body = (
      <>
        <TableToolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="搜索说明、对象、IP"
          end={items && !error ? <span className="table-toolbar__count">已显示 {items.length} 条</span> : undefined}
        >
          <Select size="sm" className="select--auto" value={actorId} onChange={setActorId} options={memberOptions} aria-label="按成员筛选" />
          <Select size="sm" className="select--auto" value={type} onChange={setType} options={typeOptions} aria-label="按操作类型筛选" />
          <Select size="sm" className="select--auto" value={range} onChange={setRange} options={RANGES} aria-label="按时间筛选" />
        </TableToolbar>
        {error ? (
          <ErrorState title="操作日志加载失败" error={error} onRetry={load} />
        ) : (
          <>
            <DataTable
              label="操作日志"
              columns={columns}
              rows={items}
              rowKey={(l) => l.id}
              onRowClick={setOpenLog}
              isRowActive={(l) => l.id === openLog?.id}
              // 分页由服务端的游标做（往下滚加载更多），表格自己不再分页
              pageSize={Number.MAX_SAFE_INTEGER}
              empty={
                <EmptyState
                  compact
                  title="无符合条件的记录"
                  action={
                    <button type="button" className="btn btn--sm" onClick={clearFilters}>
                      清除筛选
                    </button>
                  }
                />
              }
            />
            {items?.length > 0 && (
              <div className="audit-page__more" ref={sentinel}>
                {nextCursor ? (
                  moreError ? (
                    <>
                      <span className="text-danger text-sm">加载失败：{moreError.message}</span>
                      <button type="button" className="btn btn--sm" onClick={loadMore}>
                        重试
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={loadMore} disabled={loadingMore}>
                      {loadingMore && <Spinner />}
                      {loadingMore ? '加载中…' : '加载更多'}
                    </button>
                  )
                ) : (
                  <span className="muted text-sm">无更早记录</span>
                )}
              </div>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <div className="page audit-page">
      <PageHeader title="操作日志" />
      {body}
      {openLog && <LogDrawer log={openLog} onClose={() => setOpenLog(null)} />}
    </div>
  );
}
