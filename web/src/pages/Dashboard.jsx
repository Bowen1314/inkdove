import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { api } from '../api/client.js';
import { EmptyState, ErrorState, PageHeader, Segmented } from '../ui/common.jsx';
import { Select } from '../ui/Select.jsx';
import { useAccounts } from '../lib/accounts.js';
import { useAuth } from '../lib/auth.jsx';
import { assigneeName } from './wa/Assignee.jsx';
import {
  AbuseCard,
  AccountsCard,
  CostCard,
  DashboardSkeleton,
  HandoffReasonsCard,
  HeatmapCard,
  KbCard,
  KpiRow,
  LeadDistributionCard,
  LeadStagesCard,
  MembersCard,
  OutreachCard,
  TrendCard,
} from './dashboard/sections.jsx';
import { DraftListCard, DraftsCard } from './dashboard/drafts.jsx';

const RANGES = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

/** 浏览器的 IANA 时区，日期分组和热力图都按它算；取不到时不带，由后端用默认时区 */
function browserTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** 按业务员筛选里表示「未分配」的值（和后端 dashboard.js 的 UNASSIGNED 一致） */
const UNASSIGNED = 'unassigned';

/**
 * 按业务员筛选的选项：全部、未分配、各成员（我排第一）。停用的成员只在他名下还有会话时列出；
 * 选中的成员不在里面了（删了）也留着，免得显示成占位符。
 */
function assigneeFilterOptions(users, me, selected) {
  const list = (users || [])
    .filter((u) => !u.disabled || u.assignedCount > 0 || u.id === selected)
    .sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : assigneeName(a).localeCompare(assigneeName(b), 'zh-CN')));
  const opts = [
    { value: '', label: '全部业务员' },
    { value: UNASSIGNED, label: '未分配' },
    ...list.map((u) => ({
      value: u.id,
      label: u.id === me?.id ? `${assigneeName(u)}（我）` : assigneeName(u),
      desc: u.disabled ? '已停用' : undefined,
    })),
  ];
  if (selected && !opts.some((o) => o.value === selected)) opts.push({ value: selected, label: '已删除的成员' });
  return opts;
}

/**
 * 看板（F12，admin）。GET /api/dashboard 一次返回全部数据；切时间段、号或业务员时重新拉，旧数据先留着、变淡，不整页闪骨架。
 * 版面从上到下按 SPEC-phase2「前端变化 → 看板」，栅格跨度按 DESIGN 第 7 节。
 * 路由外面已经包了 AdminOnly；接口自己返回 403、404 时显示错误态，不白屏。
 */
export default function Dashboard() {
  const [range, setRange] = useState('7d');
  const [accountId, setAccountId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const { accounts } = useAccounts();
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null); // 按业务员筛选的选项（GET /api/users，只有 admin 能读）
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .listUsers({ silent: true })
      .then((list) => alive && setUsers(Array.isArray(list) ? list : []))
      .catch(() => alive && setUsers([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getDashboard(
        { range, accountId: accountId || undefined, assigneeId: assigneeId || undefined, tz: browserTz() },
        { silent: true, signal: ctrl.signal },
      )
      .then((res) => {
        setData(res && typeof res === 'object' ? res : {});
        setLoading(false);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        // 旧数据是别的筛选条件下的，出错时不再显示
        setData(null);
        setError(e);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [range, accountId, assigneeId, reloadKey]);

  const accountOptions = [
    { value: '', label: '全部号码' },
    ...(accounts || []).map((a) => ({ value: a.id, label: a.name || '未命名号码' })),
  ];
  // 选中的号被删了：下拉框里也留着它，免得显示成占位符
  if (accountId && !accountOptions.some((o) => o.value === accountId)) {
    accountOptions.push({ value: accountId, label: '已删除的号码' });
  }

  const assigneeOptions = assigneeFilterOptions(users, me, assigneeId);
  // 选了业务员时各块的说明里用：「Alice」「未分配」
  const assigneeLabel = assigneeId
    ? assigneeId === UNASSIGNED
      ? '未分配'
      : assigneeOptions.find((o) => o.value === assigneeId)?.label.replace(/（我）$/, '') || '已删除的成员'
    : '';

  const header = (
    <PageHeader
      title="看板"
      actions={
        <div className="dash__filters">
          <Segmented label="时间段" options={RANGES} value={range} onChange={setRange} />
          {users?.length > 0 && (
            <Select
              className="select--auto dash__account"
              value={assigneeId}
              onChange={setAssigneeId}
              options={assigneeOptions}
              aria-label="按业务员筛选"
            />
          )}
          {accounts?.length > 0 && (
            <Select
              className="select--auto dash__account"
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              aria-label="按号筛选"
            />
          )}
        </div>
      }
    />
  );

  let body;
  if (error) {
    if (error.status === 403) {
      body = (
        <EmptyState
          fill
          icon={ShieldOff}
          title="没有权限"
          desc="看板只有管理员能看。需要的话请联系管理员。"
          action={
            <Link className="btn btn--primary" to="/">
              返回概览
            </Link>
          }
        />
      );
    } else {
      const err =
        error.status === 404 ? { message: '服务器还没有提供看板数据，请确认后台已经更新到最新版本。' } : error;
      body = <ErrorState title="看板数据加载失败" error={err} onRetry={() => setReloadKey((k) => k + 1)} />;
    }
  } else if (!data) {
    body = <DashboardSkeleton />;
  } else {
    // 知识库、成本不按业务员筛选；号码表、成员表的数字只算这个业务员的客户
    const filter = { account: !!accountId, assignee: assigneeLabel };
    body = (
      <div className={`grid-12 dash__grid${loading ? ' is-refreshing' : ''}`} aria-busy={loading || undefined}>
        <KpiRow kpi={data.kpi} accountId={accountId} assigneeId={assigneeId} />
        <TrendCard trend={data.trend} />
        <HandoffReasonsCard reasons={data.handoffReasons} />
        <KbCard kb={data.kb} filter={filter} />
        <LeadStagesCard leads={data.leads} />
        <LeadDistributionCard leads={data.leads} />
        <AccountsCard accounts={data.accounts} assignee={assigneeLabel} />
        <MembersCard members={data.members} assignee={assigneeLabel} />
        <CostCard cost={data.cost} filter={filter} />
        <AbuseCard abuse={data.abuse} />
        <OutreachCard outreach={data.outreach} />
        <HeatmapCard heatmap={data.heatmap} tz={data.range?.tz} />
        <DraftsCard drafts={data.drafts} />
        <DraftListCard range={range} accountId={accountId} assigneeId={assigneeId} tz={browserTz()} reloadKey={reloadKey} />
      </div>
    );
  }

  return (
    <div className="page dash">
      {header}
      <div className="page-body">{body}</div>
    </div>
  );
}
