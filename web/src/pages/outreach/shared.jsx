import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { campaignStatus } from '../../lib/labels.js';
import { fmtNum } from '../../lib/format.js';

/** 外联页（F11）公用的小件：接口返回值的兼容解析、状态、进度、发送参数。 */

/** SPEC-phase2 F11「全局设置」的默认值。设置页「主动外联」区块也用这一份 */
export const OUTREACH_DEFAULTS = {
  dailyCapPerAccount: 30,
  minIntervalSeconds: 90,
  maxIntervalSeconds: 240,
  windowStart: '09:00',
  windowEnd: '20:00',
};

/** settings.outreach → 补齐默认值（后端还没有这个字段、或缺某个字段时用默认值） */
export function withOutreachDefaults(o) {
  const src = o && typeof o === 'object' ? o : {};
  const out = { ...OUTREACH_DEFAULTS };
  Object.keys(OUTREACH_DEFAULTS).forEach((k) => {
    if (src[k] != null && src[k] !== '') out[k] = src[k];
  });
  return out;
}

/** GET /api/campaigns 直接给数组；也兼容 {campaigns} / {items} */
export const toCampaigns = (res) =>
  Array.isArray(res) ? res : Array.isArray(res?.campaigns) ? res.campaigns : Array.isArray(res?.items) ? res.items : [];

/** GET /:id、start/pause/… 返回 Campaign；也兼容 {campaign} */
export const toCampaign = (res) => {
  const c = res?.campaign || res;
  return c && typeof c === 'object' && c.id ? c : null;
};

/** GET /:id/recipients → {rows, total}；兼容 {recipients} / {items} / 直接给数组 */
export function toRecipientPage(res) {
  const rows = Array.isArray(res)
    ? res
    : Array.isArray(res?.recipients)
      ? res.recipients
      : Array.isArray(res?.items)
        ? res.items
        : [];
  const total = Number.isFinite(res?.total) ? res.total : rows.length;
  return { rows, total };
}

export const statsOf = (c) => ({
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  replied: 0,
  declined: 0,
  ...(c?.stats || {}),
});

/** 回复率 = 回复数 / 已发数，保留一位小数；没发过时为 null */
export function replyRate(stats) {
  if (!stats?.sent) return null;
  return `${((stats.replied / stats.sent) * 100).toFixed(1)}%`;
}

export function CampaignStatusDot({ status, size }) {
  const st = campaignStatus(status);
  return (
    <StatusDot tone={st.tone} pulse={st.pulse} size={size}>
      {st.label}
    </StatusDot>
  );
}

/** 进度条：已发 / 总数（DESIGN：进度条右边用 Caption 显示 "132 / 300"） */
export function CampaignProgress({ stats, label = '发送进度' }) {
  const total = stats?.total || 0;
  const sent = stats?.sent || 0;
  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  return (
    <div className="outreach-progress">
      <div
        className="progress outreach-progress__bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={sent}
      >
        <div className="progress__bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="outreach-progress__text num">
        {fmtNum(sent)} / {fmtNum(total)}
      </span>
    </div>
  );
}

/**
 * 收件人状态 → 界面上的六种：待发 / 已发未回复 / 已回复 / 已拒绝 / 失败 / 跳过。
 * 拒绝优先于回复（拒绝的那条消息本身也是一次回复）。拒绝的颜色按 DESIGN「回复结果」配色用 info。
 */
export const RECIPIENT_STATES = {
  pending: { label: '待发', tone: 'warning' },
  sent: { label: '已发未回复', tone: 'neutral' },
  replied: { label: '已回复', tone: 'success' },
  declined: { label: '已拒绝', tone: 'info' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '跳过', tone: 'neutral', muted: true },
};

export function recipientStateKey(r) {
  if (r?.status === 'sent') {
    if (r.declinedAt) return 'declined';
    if (r.repliedAt) return 'replied';
    return 'sent';
  }
  return RECIPIENT_STATES[r?.status] ? r.status : 'pending';
}

/**
 * 收件人筛选（Segmented）。值直接作为 ?status= 传给后端，只用 SPEC 里 Recipient.status 的四个值；
 * 「已发」包含已回复、已拒绝的（行里再按 repliedAt / declinedAt 细分显示）
 */
export const RECIPIENT_FILTERS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待发' },
  { value: 'sent', label: '已发' },
  { value: 'failed', label: '失败' },
  { value: 'skipped', label: '跳过' },
];

/**
 * 当前生效的外联发送参数（开始发送的确认文案用）。
 * 后端在 Campaign 里带了生效中的参数（campaign.outreach，agent 也拿得到），有就优先用它；
 * 没有时 admin 读设置接口，agent 读不到设置时用默认值，known=false。
 * @param {object} [campaign] 当前的外联任务
 */
export function useOutreachSettings(campaign) {
  const { isAdmin } = useAuth();
  const [state, setState] = useState({ outreach: OUTREACH_DEFAULTS, known: false });
  useEffect(() => {
    if (!isAdmin) return undefined;
    let alive = true;
    api
      .getSettings({ silent: true })
      .then((s) => alive && setState({ outreach: withOutreachDefaults(s?.outreach), known: true }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isAdmin]);
  const fromCampaign = campaign?.outreach;
  if (fromCampaign && typeof fromCampaign === 'object') return { outreach: withOutreachDefaults(fromCampaign), known: true };
  return state;
}

/** 开始发送的确认文案（SPEC 原文）："将按每号每天最多 X 条、间隔 X–X 秒、对方当地时间 X–X 发送" */
export function startConfirmMessage({ outreach, known }) {
  const o = outreach || OUTREACH_DEFAULTS;
  const line =
    `发送规则：每个号码每天最多 ${o.dailyCapPerAccount} 条，间隔 ${o.minIntervalSeconds}–${o.maxIntervalSeconds} 秒，` +
    `对方当地时间 ${o.windowStart}–${o.windowEnd}。`;
  const tail = '每个收件人仅发送一条开场消息，不跟进；对方拒绝后不再联系。';
  return known ? `${line}\n${tail}` : `${line}（默认值，以管理员配置为准）\n${tail}`;
}

/** 号的显示名：campaign.perAccount 里的 accountName 优先，其次当前能看到的号列表 */
export function accountLabel(campaign, accounts, id) {
  const pa = Array.isArray(campaign?.perAccount) ? campaign.perAccount.find((p) => p.accountId === id) : null;
  return pa?.accountName || accounts?.find((a) => a.id === id)?.name || '已删除的号码';
}

/** 服务端还没有外联接口：404 且不是业务错误（没有 JSON，或是兜底的"接口不存在"） */
export const isUnsupported = (e) => e?.status === 404 && (e.code === 'http_404' || e.message === '接口不存在');

/** 接口错误 → 提示文字。服务端还没有外联接口时给一句明确的话 */
export function errorText(e) {
  if (isUnsupported(e)) return '服务端暂不支持外联，请升级服务端后重试';
  return e?.message || '操作失败，请稍后重试';
}

/** 会话页链接 */
export const chatUrl = (conversationId) => `/whatsapp/chats?chat=${encodeURIComponent(conversationId)}`;
