import { useId } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Metric } from '../../ui/common.jsx';
import { DataTable, CellText } from '../../ui/DataTable.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { HintIcon } from '../../ui/Popover.jsx';
import {
  DECISION_CODES,
  LEAD_STAGES,
  MEMBER_KIND,
  codeLabel,
  leadStageLabel,
  purposeLabel,
  waState,
} from '../../lib/labels.js';
import { fmtMinutes, fmtNum, fmtPct, fmtTime, fmtTokens, fmtUsd } from '../../lib/format.js';
import { DECISION_SERIES, Funnel, Heatmap, Legend, RankList, TrendChart, normalizeHeatmap } from './charts.jsx';

/**
 * 看板的各个区块。数据结构严格按 SPEC-phase2 F12「接口」：GET /api/dashboard 一次返回全部。
 * 每个字段都可能缺（后端早期版本、空库），这里一律兜底：数组用 arr()，数字用 num()，null 显示"—"。
 * 栅格跨度按 DESIGN 第 7 节「看板」。
 */

export const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const enc = encodeURIComponent;
const entryLink = (id) => (id ? `/kb/entries?edit=${enc(id)}` : undefined);
const sumBy = (list, key) => list.reduce((n, x) => n + num(x[key]), 0);

/** 卡片：H3 标题（用 h2 标签保证大纲层级），右边可放说明或链接 */
function Card({ title, span, aside, flush = false, className = '', children, busy }) {
  const id = useId();
  return (
    <section
      className={`card${flush ? ' card--flush' : ''} ${span} dash-card ${className}`}
      aria-labelledby={id}
      aria-busy={busy || undefined}
    >
      <div className="card__head">
        <h2 className="card__title" id={id}>
          {title}
        </h2>
        {aside && <div className="dash-card__aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** 卡片里的小节：Caption 标题，右边可放 link */
function Sub({ title, aside, children, className = '' }) {
  return (
    <div className={`dash-sub ${className}`}>
      <div className="dash-sub__head">
        <h3 className="dash-sub__title">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** 小号的指标：Caption 标签 + 15px 数字 + 可选的一行灰字 */
function Stat({ label, value, unit, foot, tone }) {
  return (
    <div className="dash-stat">
      <div className="dash-stat__label">{label}</div>
      <div className={`dash-stat__value num${tone ? ` text-${tone}` : ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {foot && <div className="dash-stat__foot">{foot}</div>}
    </div>
  );
}

const Empty = ({ title, desc, action }) => <EmptyState compact title={title} desc={desc} action={action} />;

/** 选了某个号时，给不按号筛选的块标一句 */
function NotFiltered({ text = '不按号筛选', help }) {
  return (
    <span className="dash-card__note">
      {text}
      {help && <HintIcon label="筛选说明">{help}</HintIcon>}
    </span>
  );
}

/* ================= 指标卡 ================= */

function MetricCell(props) {
  return (
    <div className="span-2 dash-metric">
      <Metric {...props} />
    </div>
  );
}

/** 分钟 → Metric 的 value + unit */
function minutesMetric(m) {
  if (m == null || !Number.isFinite(Number(m))) return { value: '—' };
  const n = Number(m);
  if (n < 1) return { value: '<1', unit: '分钟' };
  if (n < 60) return { value: String(Math.round(n)), unit: '分钟' };
  return { value: (n / 60).toFixed(1).replace(/\.0$/, ''), unit: '小时' };
}

export function KpiRow({ kpi = {}, accountId }) {
  const turns = kpi.turns || {};
  const replied = num(turns.replied);
  const denom = replied + num(turns.handoff) + num(turns.blocked);
  const open = kpi.openNeedsHuman;
  const median = minutesMetric(kpi.medianResponseMinutes);
  return (
    <>
      <MetricCell label="客户消息" value={kpi.inboundMessages == null ? '—' : fmtNum(kpi.inboundMessages)} />
      <MetricCell label="新客户" value={kpi.newCustomers == null ? '—' : fmtNum(kpi.newCustomers)} />
      <MetricCell
        label="自动回复率"
        value={fmtPct(kpi.autoReplyRate)}
        foot={denom > 0 ? `已回复 ${fmtNum(replied)} / ${fmtNum(denom)}` : '离题不计入'}
      />
      <MetricCell label="转人工次数" value={kpi.handoffs == null ? '—' : fmtNum(kpi.handoffs)} />
      <MetricCell
        label="待处理"
        value={open == null ? '—' : fmtNum(open)}
        tone={num(open) > 0 ? 'danger' : undefined}
        foot="实时，点开去处理"
        to={accountId ? `/whatsapp/chats?account=${enc(accountId)}` : '/whatsapp/chats'}
      />
      <MetricCell label="人工中位响应" value={median.value} unit={median.unit} foot="转人工到首次人工回复" />
    </>
  );
}

/* ================= 每日趋势 ================= */

export function TrendCard({ trend }) {
  const data = arr(trend);
  const totals = Object.fromEntries(DECISION_SERIES.map((s) => [s.key, sumBy(data, s.key)]));
  const all = Object.values(totals).reduce((a, b) => a + b, 0);
  return (
    <Card
      title="每日趋势"
      span="span-12"
      aside={all > 0 && <Legend items={DECISION_SERIES.map((s) => ({ ...s, value: fmtNum(totals[s.key]) }))} />}
    >
      {all > 0 ? <TrendChart data={data} /> : <Empty title="这段时间还没有处理记录" desc="机器人处理过客户消息后，这里按天显示结果。" />}
    </Card>
  );
}

/* ================= 转人工原因 ================= */

const isBlockedCode = (code) => Object.prototype.hasOwnProperty.call(DECISION_CODES.blocked, code);

export function HandoffReasonsCard({ reasons }) {
  const items = arr(reasons)
    .filter((r) => num(r.count) > 0)
    .sort((a, b) => num(b.count) - num(a.count))
    .map((r) => {
      const blocked = isBlockedCode(r.code);
      return {
        key: r.code,
        label: r.label || codeLabel(blocked ? 'blocked' : 'handoff', r.code),
        count: r.count,
        tone: blocked ? 'danger' : 'warning',
      };
    });
  const hasBlocked = items.some((it) => it.tone === 'danger');
  return (
    <Card
      title="转人工原因"
      span="span-6"
      aside={
        items.length > 0 && (
          <Legend
            items={[
              { key: 'handoff', label: '转人工', color: 'var(--warning-dot)' },
              ...(hasBlocked ? [{ key: 'blocked', label: '拦截', color: 'var(--danger-dot)' }] : []),
            ]}
          />
        )
      }
    >
      {items.length > 0 ? (
        <RankList items={items} label="转人工原因" />
      ) : (
        <Empty title="这段时间没有转人工" />
      )}
    </Card>
  );
}

/* ================= 知识库健康度 ================= */

export function KbCard({ kb = {}, filtered }) {
  const gaps = arr(kb.topGaps).map((g, i) => ({ key: g.gapId || `g${i}`, label: g.question, count: g.count }));
  const entries = arr(kb.topEntries).map((e, i) => ({
    key: e.entryId || `e${i}`,
    label: e.title || '未命名条目',
    count: e.count,
    to: entryLink(e.entryId),
  }));
  const files = arr(kb.topFiles).map((f, i) => ({ key: f.fileId || `f${i}`, label: f.name || '未命名文件', count: f.count }));
  const lr = kb.lastRedteam;
  const redFailed = num(lr?.redlineFailed);

  return (
    <Card title="知识库健康度" span="span-6" aside={filtered && <NotFiltered />}>
      <div className="dash-stats">
        <Stat
          label="没被用过的条目"
          value={kb.unusedEntries == null ? '—' : fmtNum(kb.unusedEntries)}
          unit={kb.activeEntries == null ? undefined : `/ ${fmtNum(kb.activeEntries)} 条启用中`}
          foot="最近 30 天一次都没被引用"
        />
        {lr ? (
          <div className="dash-stat">
            <div className="dash-stat__label">最近一次体检</div>
            <div className="dash-stat__value num">
              <span className={redFailed > 0 ? 'text-danger' : 'text-success'}>红线失守 {fmtNum(redFailed)}</span>
              <span className="dash-stat__sep" aria-hidden="true">
                ·
              </span>
              <span className="text-warning">误伤 {fmtNum(lr.legitRefused)}</span>
            </div>
            <div className="dash-stat__foot">
              {lr.finishedAt ? `${fmtTime(lr.finishedAt)} · ` : ''}
              <Link className="link" to={lr.runId ? `/kb/redteam?run=${enc(lr.runId)}` : '/kb/redteam'}>
                查看结果
              </Link>
            </div>
          </div>
        ) : (
          <div className="dash-stat">
            <div className="dash-stat__label">最近一次体检</div>
            <div className="dash-stat__value muted">还没做过</div>
            <div className="dash-stat__foot">
              <Link className="link" to="/kb/redteam">
                去体检
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="dash-split">
        <Sub
          title="答不了的问题 Top 10"
          aside={
            <Link className="btn btn--link btn--sm" to="/kb/gaps">
              去补充
            </Link>
          }
        >
          {gaps.length ? <RankList items={gaps} label="答不了的问题" unit="次" /> : <Empty title="没有答不了的问题" />}
        </Sub>
        <Sub title="最常用条目 Top 10">
          {entries.length ? <RankList items={entries} label="最常用条目" unit="次" /> : <Empty title="还没有条目被引用" />}
        </Sub>
      </div>

      <Sub
        title="发送最多的文件 Top 5"
        className="dash-sub--rule"
        aside={
          <Link className="btn btn--link btn--sm" to="/files/sendable">
            查看文件
          </Link>
        }
      >
        {files.length ? <RankList items={files} label="发送最多的文件" unit="次" /> : <Empty title="这段时间没有发过文件" />}
      </Sub>
    </Card>
  );
}

/* ================= 客户 ================= */

const FUNNEL_STAGES = ['inquiry', 'sample', 'negotiation', 'order_intent'];

export function LeadStagesCard({ leads = {} }) {
  const apiStages = arr(leads.stages);
  // 按 LEAD_STAGES 的顺序排；接口里有、前端不认识的阶段排在后面
  const known = LEAD_STAGES.map((s) => {
    const hit = apiStages.find((x) => x.stage === s.value);
    return { key: s.value, label: hit?.label || s.label, count: num(hit?.count) };
  });
  const extra = apiStages
    .filter((x) => !LEAD_STAGES.some((s) => s.value === x.stage))
    .map((x) => ({ key: x.stage, label: x.label || leadStageLabel(x.stage), count: num(x.count) }));
  const stages = [...known, ...extra];
  const total = sumBy(stages, 'count');

  const apiFunnel = arr(leads.funnel);
  const funnel = FUNNEL_STAGES.map((st) => {
    const hit = apiFunnel.find((x) => x.stage === st);
    return { stage: st, label: hit?.label || leadStageLabel(st), reached: num(hit?.reached) };
  });
  const funnelEmpty = funnel.every((s) => s.reached === 0);

  return (
    <Card title="客户阶段" span="span-6" aside={total > 0 && <span className="dash-card__note num">共 {fmtNum(total)} 人</span>}>
      {total === 0 && funnelEmpty ? (
        <Empty title="还没有客户线索" desc="客户聊过几轮后，系统会自动整理出线索和阶段。" />
      ) : (
        <>
          <Sub title="当前阶段分布">
            <RankList items={stages} label="当前阶段分布" />
          </Sub>
          <Sub
            title="漏斗"
            className="dash-sub--rule"
            aside={<span className="dash-sub__hint">到达过该阶段的人数 · 较上一阶段</span>}
          >
            {funnelEmpty ? <Empty title="还没有进入漏斗的客户" /> : <Funnel steps={funnel} />}
          </Sub>
        </>
      )}
    </Card>
  );
}

export function LeadDistributionCard({ leads = {} }) {
  const countries = arr(leads.countries).map((c, i) => ({
    key: c.code || `c${i}`,
    label: c.name || (c.code ? c.code : '未知'),
    count: c.count,
  }));
  const products = arr(leads.products).map((p, i) => ({
    key: p.entryId || `p${i}`,
    label: p.title || '未命名产品',
    count: p.count,
    to: entryLink(p.entryId),
  }));
  return (
    <Card title="客户来源和意向" span="span-6">
      {countries.length === 0 && products.length === 0 ? (
        <Empty title="还没有客户数据" />
      ) : (
        <div className="dash-split">
          <Sub title="国家 Top 10">
            {countries.length ? <RankList items={countries} label="国家" /> : <Empty title="暂无" />}
          </Sub>
          <Sub title="产品 Top 10">
            {products.length ? <RankList items={products} label="产品" unit="次" /> : <Empty title="暂无" />}
          </Sub>
        </div>
      )}
    </Card>
  );
}

/* ================= 号码表、成员表 ================= */

export function AccountsCard({ accounts }) {
  const rows = arr(accounts);
  const columns = [
    {
      key: 'name',
      header: '号码',
      fluid: true,
      sortValue: (a) => a.name || '',
      render: (a) => {
        const st = waState(a.state);
        return (
          <CellText
            primary={a.name || '未命名号码'}
            secondary={
              <StatusDot tone={st.tone} pulse={st.pulse} size="sm" muted>
                {st.label}
              </StatusDot>
            }
          />
        );
      },
    },
    {
      key: 'inbound',
      header: '客户消息',
      align: 'num',
      shrink: true,
      hide: 'sm',
      sortValue: (a) => num(a.inbound),
      render: (a) => fmtNum(a.inbound),
    },
    {
      key: 'rate',
      header: '自动回复率',
      align: 'num',
      shrink: true,
      sortValue: (a) => (a.autoReplyRate == null ? null : Number(a.autoReplyRate)),
      render: (a) => fmtPct(a.autoReplyRate),
    },
    {
      key: 'open',
      header: '待处理',
      align: 'num',
      shrink: true,
      sortValue: (a) => num(a.openNeedsHuman),
      render: (a) =>
        num(a.openNeedsHuman) > 0 ? (
          <Link className="text-danger dash-table__link" to={`/whatsapp/chats?account=${enc(a.id)}`}>
            {fmtNum(a.openNeedsHuman)}
          </Link>
        ) : (
          fmtNum(a.openNeedsHuman)
        ),
    },
  ];
  return (
    <Card title="号码" span="span-12" flush className="dash-table">
      <DataTable
        label="号码"
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        defaultSort={{ key: 'inbound', dir: 'desc' }}
        empty={<Empty title="还没有号码" />}
      />
    </Card>
  );
}

export function MembersCard({ members }) {
  const rows = arr(members);
  const isPerson = (m) => !m.kind || m.kind === 'user';
  const columns = [
    {
      key: 'name',
      header: '成员',
      fluid: true,
      sortValue: (m) => m.name || '',
      render: (m) => (
        <CellText
          primary={m.name || MEMBER_KIND[m.kind] || '未命名成员'}
          secondary={isPerson(m) ? null : '不对应具体成员'}
        />
      ),
    },
    {
      key: 'handled',
      header: '处理转人工',
      align: 'num',
      shrink: true,
      sortValue: (m) => num(m.handled),
      render: (m) => fmtNum(m.handled),
    },
    {
      key: 'median',
      header: '中位响应',
      align: 'num',
      shrink: true,
      sortValue: (m) => (m.medianResponseMinutes == null ? null : Number(m.medianResponseMinutes)),
      render: (m) => fmtMinutes(m.medianResponseMinutes),
    },
    {
      key: 'manual',
      header: '后台人工消息',
      align: 'num',
      shrink: true,
      hide: 'sm',
      sortValue: (m) => (isPerson(m) ? num(m.manualMessages) : null),
      render: (m) => (isPerson(m) ? fmtNum(m.manualMessages) : <span className="muted">—</span>),
    },
  ];
  return (
    <Card title="成员" span="span-12" flush className="dash-table">
      <DataTable
        label="成员"
        columns={columns}
        rows={rows}
        rowKey={(m) => m.userId ?? m.kind ?? m.name}
        defaultSort={{ key: 'handled', dir: 'desc' }}
        empty={<Empty title="还没有成员数据" />}
      />
    </Card>
  );
}

/* ================= 成本 ================= */

export function CostCard({ cost = {}, filtered }) {
  const rows = arr(cost.byPurpose).filter((p) => num(p.calls) > 0 || num(p.inputTokens) > 0 || num(p.outputTokens) > 0);
  const hasCost = cost.estimatedCostUsd != null;
  const anyRowCost = rows.some((p) => p.costUsd != null);
  const partial = hasCost && rows.some((p) => p.costUsd == null);
  const empty = num(cost.calls) === 0 && rows.length === 0;
  return (
    <Card
      title="成本"
      span="span-4"
      aside={
        filtered && (
          <NotFiltered
            text="部分按号筛选"
            help="和会话有关的调用（回复、审核、草稿等）按号筛选；整理知识库、红线体检这类不属于某个号的调用不筛选。"
          />
        )
      }
    >
      {empty ? (
        <Empty title="这段时间没有调用模型" />
      ) : (
        <>
          <div className="dash-stats dash-stats--3">
            <Stat label="调用次数" value={fmtNum(cost.calls)} />
            <Stat
              label="Token"
              value={fmtTokens(num(cost.inputTokens) + num(cost.outputTokens))}
              foot={`输入 ${fmtTokens(cost.inputTokens)} · 输出 ${fmtTokens(cost.outputTokens)}`}
            />
            <Stat label="估算费用" value={hasCost ? fmtUsd(cost.estimatedCostUsd) : '—'} />
          </div>
          {!hasCost && (
            <p className="dash-card__hint">
              还没配模型单价，只统计 token 数。<Link className="link" to="/settings/pricing">去填模型单价</Link>
            </p>
          )}
          {partial && <p className="dash-card__hint">部分模型没配单价，费用里没算它们。</p>}
          {rows.length > 0 && (
            <table className="table dash-mini">
              <thead>
                <tr>
                  <th scope="col">用途</th>
                  <th scope="col" className="is-num">
                    次数
                  </th>
                  <th scope="col" className="is-num">
                    Token
                  </th>
                  {anyRowCost && (
                    <th scope="col" className="is-num">
                      费用
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.purpose}>
                    <td className="dash-mini__name">{p.label || purposeLabel(p.purpose)}</td>
                    <td className="is-num">{fmtNum(p.calls)}</td>
                    <td className="is-num" title={`输入 ${fmtNum(p.inputTokens)} · 输出 ${fmtNum(p.outputTokens)}`}>
                      {/* 返回里没有用量的调用（比如语音转写）token 记 null */}
                      {p.inputTokens == null && p.outputTokens == null ? '—' : fmtTokens(num(p.inputTokens) + num(p.outputTokens))}
                    </td>
                    {anyRowCost && <td className="is-num">{fmtUsd(p.costUsd)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}

/* ================= 挡掉的白嫖 ================= */

export function AbuseCard({ abuse = {} }) {
  const offtopic = arr(abuse.offtopic)
    .filter((x) => num(x.count) > 0)
    .sort((a, b) => num(b.count) - num(a.count))
    .map((x) => ({ key: x.code, label: x.label || codeLabel('offtopic', x.code), count: x.count }));
  const blocked = arr(abuse.blocked)
    .filter((x) => num(x.count) > 0)
    .sort((a, b) => num(b.count) - num(a.count))
    .map((x) => ({ key: x.code, label: x.label || codeLabel('blocked', x.code), count: x.count, tone: 'danger' }));
  const muted = abuse.mutedConversations;
  const empty = offtopic.length === 0 && blocked.length === 0 && num(muted) === 0;
  return (
    <Card title="挡掉的白嫖" span="span-4">
      {empty ? (
        <Empty title="这段时间没有挡掉的消息" />
      ) : (
        <>
          <div className="dash-stats dash-stats--3">
            <Stat label="离题" value={fmtNum(sumBy(offtopic, 'count'))} unit="次" />
            <Stat label="拦截" value={fmtNum(sumBy(blocked, 'count'))} unit="次" />
            <Stat label="静默会话" value={muted == null ? '—' : fmtNum(muted)} unit="个" />
          </div>
          <Sub title="离题按类型">
            {offtopic.length ? <RankList items={offtopic} label="离题按类型" /> : <Empty title="没有离题消息" />}
          </Sub>
          <Sub title="拦截按原因" className="dash-sub--rule">
            {blocked.length ? <RankList items={blocked} label="拦截按原因" /> : <Empty title="没有被拦截的回复" />}
          </Sub>
        </>
      )}
    </Card>
  );
}

/* ================= 外联 ================= */

export function OutreachCard({ outreach = {} }) {
  const rows = arr(outreach.byAccount);
  const sent = num(outreach.sent);
  if (sent === 0 && rows.every((r) => num(r.sent) === 0)) {
    return (
      <Card title="外联" span="span-4">
        <Empty
          title="这段时间没有外联发送"
          action={
            <Link className="btn btn--sm" to="/outreach">
              去外联
            </Link>
          }
        />
      </Card>
    );
  }
  return (
    <Card title="外联" span="span-4">
      <div className="dash-stats dash-stats--3">
        <Stat label="发送" value={fmtNum(sent)} unit="条" />
        <Stat label="回复率" value={fmtPct(outreach.replyRate)} foot={`回复 ${fmtNum(outreach.replied)}`} />
        <Stat label="拒绝率" value={fmtPct(outreach.declineRate)} foot={`拒绝 ${fmtNum(outreach.declined)}`} />
      </div>
      {rows.length > 0 && (
        <table className="table dash-mini">
          <thead>
            <tr>
              <th scope="col">号码</th>
              <th scope="col" className="is-num">
                发送
              </th>
              <th scope="col" className="is-num">
                回复
              </th>
              <th scope="col" className="is-num">
                拒绝
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.accountId || i}>
                <td className="dash-mini__name">{r.name || '未命名号码'}</td>
                <td className="is-num">{fmtNum(r.sent)}</td>
                <td className="is-num">{fmtNum(r.replied)}</td>
                <td className="is-num">{fmtNum(r.declined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ================= 时段热力图 ================= */

export function HeatmapCard({ heatmap, tz }) {
  const grid = normalizeHeatmap(heatmap);
  const any = grid.some((row) => row.some((v) => v > 0));
  return (
    <Card title="时段热力图" span="span-12" aside={tz && <span className="dash-card__note">按 {tz} 时间</span>}>
      {any ? <Heatmap grid={grid} /> : <Empty title="这段时间没有客户消息" desc="有客户消息后，这里按星期和小时显示忙闲。" />}
    </Card>
  );
}

/* ================= 首次加载的骨架 ================= */

function SkeletonCard({ span, rows = 3 }) {
  return (
    <div className={`card ${span} dash-card`} aria-hidden="true">
      <span className="skeleton skeleton--text dash-skeleton__title" />
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton skeleton--text" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="grid-12" aria-busy="true" aria-label="加载中">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="span-2 dash-metric" aria-hidden="true">
          <div className="card">
            <span className="skeleton skeleton--text dash-skeleton__label" />
            <span className="skeleton dash-skeleton__metric" />
          </div>
        </div>
      ))}
      <SkeletonCard span="span-12" rows={6} />
      <SkeletonCard span="span-6" rows={5} />
      <SkeletonCard span="span-6" rows={5} />
    </div>
  );
}
