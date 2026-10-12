import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CircleStop, MessageSquare, Pause, Play, SearchX, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { Callout, EmptyState, ErrorState, Metric, PageHeader, Segmented, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useAuth } from '../../lib/auth.jsx';
import { isConnected, useAccounts } from '../../lib/accounts.js';
import { campaignModeLabel, skipReasonLabel } from '../../lib/labels.js';
import { countryLabel } from '../../lib/countries.js';
import { fmtFull, fmtNum } from '../../lib/format.js';
import {
  CampaignProgress,
  CampaignStatusDot,
  RECIPIENT_FILTERS,
  RECIPIENT_STATES,
  accountLabel,
  chatUrl,
  errorText,
  isUnsupported,
  recipientStateKey,
  replyRate,
  startConfirmMessage,
  statsOf,
  toCampaign,
  toRecipientPage,
  useOutreachSettings,
} from './shared.jsx';

/**
 * 外联任务详情（/outreach/:id）。DESIGN 第 7 节：上面一行指标卡片，下面两张表（各号进度、收件人）。
 * GET /api/campaigns/:id；收件人 GET /:id/recipients?status=&page=&pageSize= 服务端分页，按状态用 Segmented 筛选。
 * 发送中时每 5 秒刷新任务和当前这页收件人。操作按状态：开始 / 暂停 / 继续 / 取消（确认）/ 删除（确认，仅 draft、cancelled、done）。
 */

const PAGE_SIZE = 50;
const POLL_MS = 5000;
const DELETABLE = ['draft', 'cancelled', 'done'];

/** 号码规范化后是纯数字，前面补 +；无效号码是原文，原样显示 */
const numberText = (n) => (n == null || n === '' ? '—' : /^\d+$/.test(String(n)) ? `+${n}` : String(n));

const pctOf = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : null);

/* ---------- 各号进度 ---------- */

function PerAccountTable({ campaign, accounts }) {
  const rows = Array.isArray(campaign.perAccount) ? campaign.perAccount : [];
  const num = (key, header, hide) => ({
    key,
    header,
    align: 'num',
    hide,
    sortValue: (r) => r[key] ?? 0,
    render: (r) => fmtNum(r[key] ?? 0),
  });
  // 窄屏隐藏：< 768 失败、拒绝；< 640 分配
  const columns = [
    {
      key: 'name',
      header: '号',
      fluid: true,
      sortValue: (r) => r.accountName || '',
      render: (r) => {
        const name = r.accountName || accountLabel(campaign, accounts, r.accountId);
        const acc = accounts?.find((a) => a.id === r.accountId);
        return (
          <CellText
            primary={<span title={name}>{name}</span>}
            secondary={
              acc && !isConnected(acc) ? (
                <StatusDot tone="warning" size="sm">
                  未连接
                </StatusDot>
              ) : null
            }
          />
        );
      },
    },
    num('assigned', '分配', 'sm'),
    num('sent', '已发'),
    num('failed', '失败', 'md'),
    num('replied', '回复'),
    num('declined', '拒绝', 'md'),
    num('sentToday', '今日已发'),
  ];
  return (
    <DataTable
      label="各号进度"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.accountId}
      empty={<EmptyState compact title="还没有分配数据" />}
    />
  );
}

/* ---------- 收件人 ---------- */

function RecipientStatus({ r }) {
  const key = recipientStateKey(r);
  const st = RECIPIENT_STATES[key];
  let sub = null;
  if (key === 'failed' && r.error) sub = r.error;
  return (
    <div className="outreach-detail__status">
      <StatusDot tone={st.tone} muted={st.muted}>
        {st.label}
      </StatusDot>
      {key === 'skipped' && r.skipReason && (
        <div className="table__secondary outreach-detail__inline">{skipReasonLabel(r.skipReason)}</div>
      )}
      {sub && (
        <div className="table__secondary ellipsis outreach-detail__error" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Recipients({ campaign, accounts, refreshKey }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null); // {rows, total}
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      const my = ++seq.current;
      if (!quiet) setLoading(true);
      try {
        const res = await api.listCampaignRecipients(
          campaign.id,
          { status: filter, page, pageSize: PAGE_SIZE },
          { silent: true },
        );
        if (my !== seq.current) return;
        setData(toRecipientPage(res));
        setError(null);
      } catch (e) {
        if (my !== seq.current || e.status === 401) return;
        setError(e);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [campaign.id, filter, page],
  );

  // 换筛选或翻页：先清空再取（显示骨架）
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // 任务刷新了（轮询、暂停继续之后）：安静地刷新当前这页
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    load({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    if (data && page > pages) setPage(pages);
  }, [data, page, pages]);

  const changeFilter = (v) => {
    setFilter(v);
    setPage(1);
  };

  // 窄屏隐藏：< 768 分配的号、跳过原因、回复时间、拒绝时间；< 640 发送时间
  const columns = [
    {
      key: 'number',
      header: '号码',
      render: (r) => (
        <CellText
          primary={<span className="num">{numberText(r.number)}</span>}
          secondary={
            r.accountId ? (
              <span className="outreach-detail__inline">{accountLabel(campaign, accounts, r.accountId)}</span>
            ) : null
          }
        />
      ),
    },
    {
      key: 'account',
      header: '分配的号',
      hide: 'md',
      render: (r) =>
        r.accountId ? (
          <span className="outreach-detail__acct ellipsis">{accountLabel(campaign, accounts, r.accountId)}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'status',
      header: '状态',
      fluid: true,
      render: (r) => <RecipientStatus r={r} />,
    },
    {
      key: 'skipReason',
      header: '跳过原因',
      hide: 'md',
      shrink: true,
      render: (r) => (r.skipReason ? skipReasonLabel(r.skipReason) : <span className="muted">—</span>),
    },
    { key: 'sentAt', header: '发送时间', shrink: true, hide: 'sm', render: (r) => <TimeText iso={r.sentAt} /> },
    { key: 'repliedAt', header: '回复时间', shrink: true, hide: 'md', render: (r) => <TimeText iso={r.repliedAt} /> },
    { key: 'declinedAt', header: '拒绝时间', shrink: true, hide: 'md', render: (r) => <TimeText iso={r.declinedAt} /> },
    {
      key: 'chat',
      header: <span className="sr-only">会话</span>,
      shrink: true,
      render: (r) =>
        r.conversationId ? (
          <Tooltip content="打开会话">
            <Link className="btn btn--ghost btn--icon btn--sm" to={chatUrl(r.conversationId)} aria-label="打开会话">
              <MessageSquare />
            </Link>
          </Tooltip>
        ) : null,
    },
  ];

  const filterLabel = RECIPIENT_FILTERS.find((f) => f.value === filter)?.label;

  return (
    <section className="outreach-detail__section" aria-label="收件人">
      <h2 className="outreach-detail__section-title">收件人</h2>
      <TableToolbar count={data && !error ? total : undefined} end={loading && data ? <Spinner /> : null}>
        <div className="outreach-detail__filter">
          <Segmented label="按状态筛选" options={RECIPIENT_FILTERS} value={filter} onChange={changeFilter} />
        </div>
      </TableToolbar>
      {error ? (
        <ErrorState compact title="收件人加载失败" error={{ message: errorText(error) }} onRetry={() => load()} />
      ) : (
        <>
          <DataTable
            label="收件人"
            columns={columns}
            rows={data ? data.rows : null}
            rowKey={(r) => r.id}
            pageSize={PAGE_SIZE}
            empty={<EmptyState compact title={filter ? `没有「${filterLabel}」的收件人` : '还没有收件人'} />}
          />
          {data && pages > 1 && (
            <div className="pagination">
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE)} / {fmtNum(total)}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--icon"
                onClick={() => setPage((p) => p - 1)}
                disabled={page <= 1 || loading}
                aria-label="上一页"
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className="btn btn--sm btn--icon"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= pages || loading}
                aria-label="下一页"
              >
                <ChevronRight />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ---------- 主体 ---------- */

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin } = useAuth();
  const { accounts } = useAccounts();
  const settings = useOutreachSettings();
  const [campaign, setCampaign] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // start | pause | resume | cancel | delete
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const c = toCampaign(await api.getCampaign(id, { silent: true }));
      if (!c) throw new Error('服务端返回的任务数据不完整');
      setCampaign(c);
      setError(null);
    } catch (e) {
      if (e.status === 401) return;
      setError(e);
    }
  }, [id]);

  useEffect(() => {
    setCampaign(null);
    setError(null);
    load();
  }, [load]);

  const running = campaign?.status === 'running';
  usePolling(
    async () => {
      await load();
      setRefreshKey((k) => k + 1);
    },
    POLL_MS,
    running,
  );

  /** 操作之后：用返回的任务（有的话），再刷新一遍收件人 */
  const act = async (kind, fn, okText) => {
    if (busy) return;
    setBusy(kind);
    try {
      const c = toCampaign(await fn());
      if (c) setCampaign(c);
      else await load();
      setRefreshKey((k) => k + 1);
      if (okText) toast.success(okText);
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    const ok = await confirm({ title: '开始发送？', message: startConfirmMessage(settings), confirmText: '开始发送' });
    if (ok) act('start', () => api.startCampaign(campaign.id), '已开始发送');
  };
  const pause = () => act('pause', () => api.pauseCampaign(campaign.id), '已暂停');
  const resume = () => act('resume', () => api.resumeCampaign(campaign.id), '已继续发送');
  const cancel = async () => {
    const pending = statsOf(campaign).pending;
    const ok = await confirm({
      title: '取消这个外联任务？',
      message: `${pending > 0 ? `剩下 ${fmtNum(pending)} 个待发号码不会再发送，` : ''}已经发出的消息和会话不受影响。取消后不能恢复。`,
      confirmText: '取消任务',
      cancelText: '不取消',
      danger: true,
    });
    if (ok) act('cancel', () => api.cancelCampaign(campaign.id), '已取消');
  };
  const remove = async () => {
    const ok = await confirm({
      title: '删除这个外联任务？',
      message: `「${campaign.name || '未命名任务'}」和它的收件人记录会被删除，已经发出的消息和会话不受影响。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok || busy) return;
    setBusy('delete');
    try {
      await api.deleteCampaign(campaign.id);
      toast.success('已删除');
      navigate('/outreach', { replace: true });
    } catch {
      setBusy(null);
    }
  };

  const crumbs = [{ label: '外联', to: '/outreach' }, { label: campaign?.name || '任务详情' }];

  if (error && !campaign) {
    const notFound = error.status === 404 && !isUnsupported(error);
    return (
      <div className="page">
        <PageHeader crumbs={crumbs} />
        {notFound ? (
          <EmptyState
            fill
            icon={SearchX}
            title="这个外联任务不存在或已被删除"
            action={
              <Link className="btn btn--primary" to="/outreach">
                返回外联列表
              </Link>
            }
          />
        ) : (
          <ErrorState title="外联任务加载失败" error={{ message: errorText(error) }} onRetry={load} />
        )}
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="page">
        <PageHeader crumbs={crumbs} />
        <div className="outreach-detail__summary">
          <div className="grid-12">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="span-2">
                <span className="skeleton outreach-detail__skeleton-card" />
              </div>
            ))}
          </div>
        </div>
        <SkeletonRows rows={5} />
      </div>
    );
  }

  const s = statsOf(campaign);
  const status = campaign.status;
  const spin = (kind, Icon) => (busy === kind ? <Spinner /> : <Icon />);
  const sentToday = (Array.isArray(campaign.perAccount) ? campaign.perAccount : []).reduce(
    (n, p) => n + (p.sentToday || 0),
    0,
  );
  const offline = (Array.isArray(campaign.accountIds) ? campaign.accountIds : [])
    .map((aid) => accounts?.find((a) => a.id === aid))
    .filter((a) => a && !isConnected(a));

  const actions = (
    <>
      {DELETABLE.includes(status) && (
        <button type="button" className="btn btn--danger" onClick={remove} disabled={!!busy}>
          {spin('delete', Trash2)}
          删除
        </button>
      )}
      {(status === 'running' || status === 'paused') && (
        <button type="button" className="btn btn--danger" onClick={cancel} disabled={!!busy}>
          {spin('cancel', CircleStop)}
          取消任务
        </button>
      )}
      {status === 'running' && (
        <button type="button" className="btn" onClick={pause} disabled={!!busy}>
          {spin('pause', Pause)}
          暂停
        </button>
      )}
      {status === 'paused' && (
        <button type="button" className="btn btn--primary" onClick={resume} disabled={!!busy}>
          {spin('resume', Play)}
          继续
        </button>
      )}
      {status === 'draft' && (
        <button type="button" className="btn btn--primary" onClick={start} disabled={!!busy}>
          {spin('start', Play)}
          开始发送
        </button>
      )}
    </>
  );

  const tpl = campaign.metaTemplate?.name
    ? `${campaign.metaTemplate.name}${campaign.metaTemplate.languageCode ? ` · ${campaign.metaTemplate.languageCode}` : ''}`
    : null;

  return (
    <div className="page outreach-detail">
      <PageHeader crumbs={crumbs} meta={<CampaignStatusDot status={status} />} actions={actions} />

      <div className="outreach-detail__summary">
        {status === 'paused' && campaign.error && (
          <Callout tone="danger">
            <span className="text-strong">任务已暂停：</span>
            {campaign.error}
          </Callout>
        )}
        {(status === 'running' || status === 'paused') && offline.length > 0 && (
          <Callout tone="warning">
            {offline.map((a) => `「${a.name || '未命名号码'}」`).join('')}没有连接，连上之后才会继续发送。
          </Callout>
        )}

        <div className="outreach-detail__progress">
          <div className="outreach-detail__progress-label">
            <span>已发 / 总数</span>
            {status === 'draft' && <span className="muted text-sm">草稿还没开始发送</span>}
          </div>
          <CampaignProgress stats={s} />
        </div>

        <div className="grid-12" role="group" aria-label="外联汇总">
          <div className="span-2 outreach-metric">
            <Metric label="总数" value={fmtNum(s.total)} foot={`待发 ${fmtNum(s.pending)}`} />
          </div>
          <div className="span-2 outreach-metric">
            <Metric label="已发" value={fmtNum(s.sent)} foot={`今日 ${fmtNum(sentToday)}`} />
          </div>
          <div className="span-2 outreach-metric">
            <Metric label="回复" value={fmtNum(s.replied)} foot={`回复率 ${replyRate(s) || '—'}`} />
          </div>
          <div className="span-2 outreach-metric">
            <Metric label="拒绝" value={fmtNum(s.declined)} foot={`拒绝率 ${pctOf(s.declined, s.sent) || '—'}`} />
          </div>
          <div className="span-2 outreach-metric">
            <Metric label="失败" value={fmtNum(s.failed)} tone={s.failed > 0 ? 'danger' : undefined} />
          </div>
          <div className="span-2 outreach-metric">
            <Metric label="跳过" value={fmtNum(s.skipped)} />
          </div>
        </div>

        <dl className="kv outreach-detail__info">
          <dt>发送方式</dt>
          <dd>{campaignModeLabel(campaign.mode)}</dd>
          {isAdmin && (
            <>
              <dt>创建人</dt>
              <dd>{campaign.createdBy?.name || '—'}</dd>
            </>
          )}
          <dt>创建时间</dt>
          <dd className="num">{fmtFull(campaign.createdAt) || '—'}</dd>
          {campaign.startedAt && (
            <>
              <dt>开始时间</dt>
              <dd className="num">{fmtFull(campaign.startedAt)}</dd>
            </>
          )}
          {campaign.finishedAt && (
            <>
              <dt>结束时间</dt>
              <dd className="num">{fmtFull(campaign.finishedAt)}</dd>
            </>
          )}
          <dt>默认国家</dt>
          <dd>{countryLabel(campaign.defaultCountry)}</dd>
          {tpl && (
            <>
              <dt>Meta 模板</dt>
              <dd className="mono">{tpl}</dd>
            </>
          )}
          <dt>开场消息</dt>
          <dd className="pre-wrap">{campaign.message || <span className="muted">—</span>}</dd>
        </dl>
      </div>

      <section className="outreach-detail__section" aria-label="各号进度">
        <h2 className="outreach-detail__section-title">各号进度</h2>
        <PerAccountTable campaign={campaign} accounts={accounts} />
      </section>

      <Recipients campaign={campaign} accounts={accounts} refreshKey={refreshKey} />
    </div>
  );
}
