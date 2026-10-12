import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Megaphone, Plus } from 'lucide-react';
import { api } from '../../api/client.js';
import { Select } from '../../ui/Select.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { EmptyState, ErrorState, PageHeader } from '../../ui/common.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useAuth } from '../../lib/auth.jsx';
import { useAccounts } from '../../lib/accounts.js';
import { CAMPAIGN_STATUS, campaignModeLabel } from '../../lib/labels.js';
import { fmtNum } from '../../lib/format.js';
import { CampaignProgress, CampaignStatusDot, accountLabel, errorText, replyRate, statsOf, toCampaigns } from './shared.jsx';

/**
 * 外联任务列表：GET /api/campaigns（服务端按权限过滤，agent 只看到自己建的）。
 * 搜索、状态筛选、排序都在前端做；有发送中的任务时每 10 秒刷新一次进度。点行进详情 /outreach/:id。
 */

const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  ...Object.entries(CAMPAIGN_STATUS).map(([value, s]) => ({ value, label: s.label })),
];
const STATUS_ORDER = { running: 0, paused: 1, draft: 2, done: 3, cancelled: 4 };

export default function CampaignList() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { accounts } = useAccounts();
  const [list, setList] = useState(null); // null = 加载中
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.listCampaigns({ silent: true });
      setList(toCampaigns(res));
      setError(null);
    } catch (e) {
      if (e.status === 401) return;
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const anyRunning = !!list?.some((c) => c.status === 'running');
  usePolling(load, 10000, anyRunning && !error);

  const retry = () => {
    setError(null);
    setList(null);
    load();
  };

  const filtered = useMemo(() => {
    if (!list) return null;
    const kw = q.trim().toLowerCase();
    return list.filter((c) => {
      if (status && c.status !== status) return false;
      if (!kw) return true;
      return [c.name, c.createdBy?.name].some((s) => String(s || '').toLowerCase().includes(kw));
    });
  }, [list, q, status]);

  const accountsText = (c) => {
    const ids = Array.isArray(c.accountIds) ? c.accountIds : [];
    return ids.map((id) => accountLabel(c, accounts, id)).join('、');
  };

  // 窄屏隐藏：< 1280 用到的号（挪到名称下面那行，代替模式）；< 768 创建人、拒绝；< 640 回复、创建时间
  const columns = [
    {
      key: 'name',
      header: '名称',
      fluid: true,
      sortValue: (c) => c.name || '',
      render: (c) => {
        const acct = accountsText(c);
        return (
          <CellText
            primary={<span title={c.name}>{c.name || '未命名任务'}</span>}
            secondary={
              <span className="outreach-list__sub">
                <span className="outreach-list__sub-wide">{campaignModeLabel(c.mode)}</span>
                <span className="outreach-list__sub-narrow">{acct || campaignModeLabel(c.mode)}</span>
              </span>
            }
          />
        );
      },
    },
    {
      key: 'status',
      header: '状态',
      shrink: true,
      sortValue: (c) => STATUS_ORDER[c.status] ?? 9,
      render: (c) => <CampaignStatusDot status={c.status} />,
    },
    {
      key: 'accounts',
      header: '用到的号',
      hide: 'lg',
      render: (c) => {
        const text = accountsText(c);
        return text ? (
          <span className="outreach-list__accounts ellipsis" title={text}>
            {text}
          </span>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
    {
      key: 'progress',
      header: '进度',
      shrink: true,
      sortValue: (c) => {
        const s = statsOf(c);
        return s.total ? s.sent / s.total : 0;
      },
      render: (c) => <CampaignProgress stats={statsOf(c)} label={`${c.name || ''} 发送进度`} />,
    },
    {
      key: 'replied',
      header: '回复',
      align: 'num',
      hide: 'sm',
      sortValue: (c) => statsOf(c).replied,
      render: (c) => {
        const s = statsOf(c);
        const rate = replyRate(s);
        return (
          <span>
            {fmtNum(s.replied)}
            {rate && <span className="muted"> · {rate}</span>}
          </span>
        );
      },
    },
    {
      key: 'declined',
      header: '拒绝',
      align: 'num',
      hide: 'md',
      sortValue: (c) => statsOf(c).declined,
      render: (c) => fmtNum(statsOf(c).declined),
    },
    isAdmin && {
      key: 'createdBy',
      header: '创建人',
      hide: 'md',
      shrink: true,
      sortValue: (c) => c.createdBy?.name || null,
      render: (c) => <span className="nowrap">{c.createdBy?.name || '—'}</span>,
    },
    {
      key: 'createdAt',
      header: '创建时间',
      shrink: true,
      hide: 'sm',
      sortValue: (c) => c.createdAt || null,
      render: (c) => <TimeText iso={c.createdAt} />,
    },
  ].filter(Boolean);

  const newButton = (
    <Link className="btn btn--primary" to="/outreach/new">
      <Plus />
      新建外联
    </Link>
  );

  const filtering = !!(q.trim() || status);
  const clearFilters = () => {
    setQ('');
    setStatus('');
  };

  let body;
  if (error && list == null) {
    body = <ErrorState title="外联任务加载失败" error={{ message: errorText(error) }} onRetry={retry} />;
  } else if (list && list.length === 0) {
    body = (
      <EmptyState
        fill
        icon={Megaphone}
        title="还没有外联任务"
        desc="上传一份号码文件，系统会按每日上限和对方当地时间，给每个号码发一条开场消息。"
        action={newButton}
      />
    );
  } else {
    body = (
      <>
        <TableToolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder={isAdmin ? '搜索任务名或创建人' : '搜索任务名'}
          count={filtered ? filtered.length : undefined}
        >
          <Select
            size="sm"
            className="select--auto"
            value={status}
            onChange={setStatus}
            options={STATUS_FILTERS}
            aria-label="按状态筛选"
          />
        </TableToolbar>
        <DataTable
          label="外联任务"
          columns={columns}
          rows={filtered}
          onRowClick={(c) => navigate(`/outreach/${encodeURIComponent(c.id)}`)}
          defaultSort={{ key: 'createdAt', dir: 'desc' }}
          empty={
            <EmptyState
              compact
              title={filtering ? '没有符合条件的任务' : '还没有外联任务'}
              action={
                filtering && (
                  <button type="button" className="btn btn--sm" onClick={clearFilters}>
                    清除筛选
                  </button>
                )
              }
            />
          }
        />
      </>
    );
  }

  return (
    <div className="page outreach-list">
      <PageHeader title="外联" count={list?.length || null} actions={newButton} />
      {body}
    </div>
  );
}

