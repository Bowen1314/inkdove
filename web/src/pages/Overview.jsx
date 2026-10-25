import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { Callout, EmptyState, ErrorState, Metric, PageHeader, SkeletonRows, Spinner } from '../ui/common.jsx';
import { CellText, DataTable } from '../ui/DataTable.jsx';
import { StatusDot } from '../ui/StatusDot.jsx';
import { Avatar } from '../ui/Avatar.jsx';
import { Tooltip } from '../ui/Popover.jsx';
import { ENTRY_TYPES, waState, CHANNEL_LABEL, noNumberName, replyModeLabel, replyModeOf } from '../lib/labels.js';
import { fmtNum, fmtShortTime, fmtTime } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { isConnected, useAccounts } from '../lib/accounts.js';
import { setPendingCount } from '../lib/inboxCount.js';
import Assistant from './overview/Assistant.jsx';

function settle(p) {
  return p.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

const convName = (c) => c?.contactName || c?.contactNumber || noNumberName(c?.channel) || c?.id || '未知联系人';
const chatLink = (id) => `/whatsapp/chats?${new URLSearchParams({ chat: id })}`;

/** 指标卡外面套一层栅格格子（Metric 自己不接 className） */
function MetricCell({ loading, ...props }) {
  return (
    <div className="span-3 ov-metric">
      <Metric {...props} value={loading ? <span className="skeleton ov-metric__skeleton" /> : props.value} />
    </div>
  );
}

/** 「开始使用」清单：三行，全部完成后整块不渲染 */
function GettingStarted({ steps }) {
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <section className="card span-12" aria-labelledby="ov-guide-title">
      <div className="card__head">
        <h2 className="card__title" id="ov-guide-title">
          开始使用
        </h2>
        <span className="muted text-sm num">
          <span className="sr-only">已完成 </span>
          {done} / {steps.length}
        </span>
      </div>
      <ol className="ov-guide__list">
        {steps.map((s) => (
          <li key={s.key} className={`ov-guide__item${s.done ? ' is-done' : ''}`}>
            <span className="ov-guide__check" aria-hidden="true">
              {s.done && <Check />}
            </span>
            <span className="ov-guide__title">
              {s.title}
              <span className="sr-only">{s.done ? '（已完成）' : '（未完成）'}</span>
            </span>
            <Link to={s.to} className={`btn btn--link${s.done ? ' btn--muted' : ''}`}>
              {s.done ? '查看' : s.action}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 「待你处理」：最近 5 条 needsHuman 的会话，点行打开会话 */
function PendingCard({ convs, error, onRetry }) {
  const navigate = useNavigate();
  const columns = [
    {
      key: 'who',
      header: '客户',
      render: (c) => (
        <div className="ov-pending__who">
          <Avatar name={c.contactName || c.contactNumber} size="sm" />
          <CellText primary={convName(c)} secondary={c.contactName && c.contactNumber ? c.contactNumber : null} />
        </div>
      ),
    },
    {
      key: 'preview',
      header: '最近消息',
      hide: 'md',
      render: (c) => (
        <div className="ov-pending__preview ellipsis muted">
          {c.lastMessage ? (
            <>
              {c.lastMessage.direction === 'out' && '我方：'}
              {c.lastMessage.text}
            </>
          ) : (
            '暂无消息'
          )}
        </div>
      ),
    },
    {
      key: 'acct',
      header: '所属号码',
      hide: 'sm',
      render: (c) => <span className="muted nowrap">{c.accountName || '—'}</span>,
    },
    {
      key: 'time',
      header: '时间',
      align: 'num',
      shrink: true,
      render: (c) => {
        const ts = c.lastMessage?.ts || c.updatedAt;
        return (
          <span className="muted" title={fmtTime(ts)}>
            {fmtShortTime(ts)}
          </span>
        );
      },
    },
  ];

  return (
    <section className="card card--flush span-8 ov-pending" aria-labelledby="ov-pending-title">
      <div className="card__head">
        <h2 className="card__title" id="ov-pending-title">
          待处理
        </h2>
        <Link to="/whatsapp/chats" className="btn btn--link">
          查看全部
        </Link>
      </div>
      {error ? (
        <ErrorState compact title="会话加载失败" error={error} onRetry={onRetry} />
      ) : (
        <DataTable
          label="待处理"
          columns={columns}
          rows={convs}
          onRowClick={(c) => navigate(chatLink(c.id))}
          empty={<EmptyState compact title="暂无待处理会话" />}
        />
      )}
    </section>
  );
}

/** 号码列表：圆点状态、名字、回复方式 */
function NumbersCard({ accounts, healthAccounts, isAdmin, loading, className }) {
  // 号码列表优先用 /api/accounts（带 replyMode）；拿不到时退回 health 里的 accounts（不知道回复方式）
  const list =
    accounts ||
    (healthAccounts
      ? healthAccounts.map((a) => ({ id: a.id, name: a.name, channel: a.channel, status: { state: a.state }, replyMode: undefined }))
      : null);

  let body;
  if (!list && loading) {
    body = <SkeletonRows rows={3} />;
  } else if (!list) {
    body = <EmptyState compact title="暂时无法获取" />;
  } else if (list.length === 0) {
    body = isAdmin ? (
      <EmptyState
        compact
        title="暂未添加号码"
        action={
          <Link to="/whatsapp/numbers" className="btn btn--sm">
            添加号码
          </Link>
        }
      />
    ) : (
      <EmptyState compact title="暂无分配的号码" desc="请联系管理员。" />
    );
  } else {
    body = (
      <ul className="ov-numbers__list">
        {list.map((a) => {
          const st = waState(a.status?.state);
          return (
            <li key={a.id} className="ov-numbers__row">
              <div className="ov-numbers__main">
                <Link to={`/whatsapp/numbers/${encodeURIComponent(a.id)}`} className="ov-numbers__name ellipsis">
                  {a.name || '未命名号码'}
                </Link>
                <div className="ov-numbers__meta">
                  <StatusDot tone={st.tone} pulse={st.pulse} size="sm">
                    {st.label}
                  </StatusDot>
                  <span className="muted text-sm ellipsis">· {CHANNEL_LABEL[a.channel] || a.channel}</span>
                </div>
              </div>
              {replyModeOf(a) && <span className="muted text-sm nowrap">{replyModeLabel(replyModeOf(a))}</span>}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className={`card ov-numbers ${className}`} aria-labelledby="ov-numbers-title">
      <div className="card__head">
        <h2 className="card__title" id="ov-numbers-title">
          {isAdmin ? '号码' : '我负责的号码'}
        </h2>
        <Link to="/whatsapp/chats" className="btn btn--link">
          查看会话
        </Link>
      </div>
      {body}
    </section>
  );
}

/** 条目分类：每类一行细条形图；底部附资料数和上次整理时间 */
function TypesCard({ stats, loading }) {
  const byType = stats?.byType || {};
  const typeTotal = ENTRY_TYPES.reduce((n, t) => n + (byType[t.value] || 0), 0);

  let body;
  if (!stats && loading) body = <SkeletonRows rows={4} />;
  else if (!stats) body = <EmptyState compact title="暂时无法获取统计数据" />;
  else if (typeTotal === 0) {
    body = <EmptyState compact title="知识库为空" desc="上传并蒸馏资料后，显示各类条目数量。" />;
  } else {
    body = (
      <ul className="ov-types__list">
        {ENTRY_TYPES.map((t) => {
          const n = byType[t.value] || 0;
          return (
            <li key={t.value} className="ov-types__row">
              <span className="ov-types__label">{t.label}</span>
              <div className="progress" aria-hidden="true">
                <div className="progress__bar" style={{ width: `${(n / typeTotal) * 100}%` }} />
              </div>
              <span className="ov-types__num num">{fmtNum(n)}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="card span-12 ov-types" aria-labelledby="ov-types-title">
      <div className="card__head">
        <h2 className="card__title" id="ov-types-title">
          条目分类
        </h2>
        <Link to="/kb/entries" className="btn btn--link">
          查看全部
        </Link>
      </div>
      {body}
      {stats && (
        <div className="ov-types__foot text-sm muted">
          <Link to="/files/sources" className="link">
            知识库资料 {fmtNum(stats.sources)} 份
          </Link>
          <span aria-hidden="true">·</span>
          <span>
            上次蒸馏：
            <Link to="/kb/distill" className="link">
              {stats.lastDistilledAt ? fmtTime(stats.lastDistilledAt) : '未蒸馏'}
            </Link>
          </span>
        </div>
      )}
    </section>
  );
}

export default function Overview() {
  const { isAdmin } = useAuth();
  const { accounts, reload: reloadAccounts } = useAccounts();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // 知识库统计只给 admin 看（权限表里 agent 只能浏览条目和画像）
  const load = useCallback(async () => {
    setLoading(true);
    const [stats, health, convs] = await Promise.all([
      isAdmin ? settle(api.kbStats({ silent: true })) : Promise.resolve({ ok: false }),
      settle(api.health({ silent: true })),
      isAdmin ? settle(api.listConversations({}, { silent: true })) : Promise.resolve({ ok: false }),
    ]);
    if (convs.ok) setPendingCount(convs.value || []);
    setData({ stats, health, convs });
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = () => {
    load();
    reloadAccounts();
  };

  const header = (
    <PageHeader
      title="概览"
      actions={
        <Tooltip content="刷新">
          <button type="button" className="btn btn--ghost btn--icon" onClick={refresh} disabled={loading} aria-label="刷新">
            {loading ? <Spinner /> : <RefreshCw />}
          </button>
        </Tooltip>
      }
    />
  );

  const stats = data?.stats.ok ? data.stats.value : null;
  const health = data?.health.ok ? data.health.value : null;
  const allFailed = !!data && (isAdmin ? !stats : true) && !health && !accounts;
  const first = !data; // 首次加载：按页面结构画骨架

  const llmReady = !!health?.llmConfigured;
  const kbReady = !!(stats && stats.sources > 0 && stats.lastDistilledAt);
  const accountList = accounts || health?.accounts?.map((a) => ({ ...a, status: { state: a.state } })) || [];
  const waReady = accountList.some(isConnected);
  const steps = [
    { key: 'llm', title: '配置 AI 模型', done: llmReady, to: '/settings', action: '前往设置' },
    { key: 'kb', title: '上传资料并蒸馏知识库', done: kbReady, to: '/files/sources', action: '上传资料' },
    { key: 'wa', title: '添加一个号码', done: waReady, to: '/whatsapp/numbers', action: '添加号码' },
  ];

  const convList = data?.convs.ok ? data.convs.value || [] : null;
  const pending = convList
    ? convList
        .filter((c) => c.needsHuman)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    : null;
  const connectedCount = accountList.filter(isConnected).length;

  return (
    <div className="page">
      {header}
      <div className="page-body">
        {allFailed && (
          <div className="ov-callout">
            <Callout tone="danger">无法连接服务器，请稍后点击「刷新」重试。</Callout>
          </div>
        )}

        <div className="grid-12">
          {isAdmin && !first && <GettingStarted steps={steps} />}

          <Assistant />

          {isAdmin && (
            <>
              <MetricCell
                loading={first}
                label="知识条目"
                value={stats ? fmtNum(stats.entries) : '—'}
                foot={stats ? `启用中 ${fmtNum(stats.activeEntries)} 条` : first ? null : '暂时无法获取'}
                to="/kb/entries"
              />
              <MetricCell
                loading={first}
                label="待补充问题"
                value={
                  stats ? <span className={stats.openGaps > 0 ? 'text-danger' : undefined}>{fmtNum(stats.openGaps)}</span> : '—'
                }
                foot={stats ? (stats.openGaps > 0 ? '客户提问但资料中无答案' : '暂无待补充问题') : null}
                to="/kb/gaps"
              />
              <MetricCell
                loading={first}
                label="待处理"
                value={pending ? <span className={pending.length > 0 ? 'text-danger' : undefined}>{fmtNum(pending.length)}</span> : '—'}
                to="/whatsapp/chats"
              />
              <MetricCell
                loading={first && !accounts}
                label="在线号码"
                value={fmtNum(connectedCount)}
                unit={`/ ${fmtNum(accountList.length)}`}
                to="/whatsapp/numbers"
              />

              <PendingCard
                convs={first ? null : pending ? pending.slice(0, 5) : null}
                error={!first && !data.convs.ok ? data.convs.error : null}
                onRetry={refresh}
              />
            </>
          )}

          <NumbersCard
            accounts={accounts}
            healthAccounts={health?.accounts}
            isAdmin={isAdmin}
            loading={first || loading}
            className={isAdmin ? 'span-4 ov-numbers--side' : 'span-12'}
          />

          {isAdmin && <TypesCard stats={stats} loading={first} />}
        </div>
      </div>
    </div>
  );
}
