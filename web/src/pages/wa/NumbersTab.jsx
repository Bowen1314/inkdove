import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Smartphone } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal } from '../../ui/Modal.jsx';
import { EmptyState, ErrorState, Field, fieldProps, PageHeader, Spinner, Switch } from '../../ui/common.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { Select } from '../../ui/Select.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useAuth } from '../../lib/auth.jsx';
import { invalidateAccounts, isConnected, patchAccountCache, useAccounts } from '../../lib/accounts.js';
import { CHANNEL_LABEL, waState } from '../../lib/labels.js';
import { fmtDay, fmtHm } from '../../lib/format.js';

export const CHANNEL_OPTIONS = [
  {
    value: 'waha',
    title: '扫码连接',
    desc: '用手机 WhatsApp 扫码关联，几分钟就能用。私人号和 WhatsApp Business 号都可以。',
  },
  {
    value: 'meta',
    title: 'Meta 官方接口',
    desc: '适合已开通 WhatsApp Business Platform 的企业，需要在 Meta 开发者后台配置。',
  },
];

/** status.me.id（如 8613800138000@c.us）→ +8613800138000 */
export function phoneOf(account) {
  const id = account?.status?.me?.id;
  if (!id) return '';
  const raw = String(id).split('@')[0];
  return /^\d+$/.test(raw) ? `+${raw}` : raw;
}

/** DESIGN.md 第 8 节：今天 10:42，其余按日期；悬停显示完整时间 */
const pad = (n) => String(n).padStart(2, '0');
function shortTime(iso) {
  const day = fmtDay(iso);
  return day === '今天' ? fmtHm(iso) : day;
}
function fullTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 状态筛选：按连接阶段归类 */
const STATE_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'connected', label: '已连接' },
  { value: 'pending', label: '连接中' },
  { value: 'failed', label: '连接失败' },
  { value: 'off', label: '未连接' },
];
function stateGroup(account) {
  const s = account?.status?.state;
  if (isConnected(account)) return 'connected';
  if (s === 'starting' || s === 'scan_qr') return 'pending';
  if (s === 'failed') return 'failed';
  return 'off';
}

const CHANNEL_FILTERS = [
  { value: '', label: '全部接入方式' },
  { value: 'waha', label: CHANNEL_LABEL.waha },
  { value: 'meta', label: CHANNEL_LABEL.meta },
];

function AddAccountModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('waha');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setName('');
    setChannel('waha');
    setTouched(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (e) => {
    e?.preventDefault();
    setTouched(true);
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const acc = await api.createAccount({ name: name.trim(), channel });
      invalidateAccounts();
      toast.success('号码已添加，接下来完成连接');
      reset();
      onCreated(acc);
    } catch {
      // 已提示
    } finally {
      setBusy(false);
    }
  };

  // 单选组：左右方向键切换
  const onChannelKey = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = CHANNEL_OPTIONS.findIndex((o) => o.value === channel);
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = CHANNEL_OPTIONS[(i + step + CHANNEL_OPTIONS.length) % CHANNEL_OPTIONS.length];
    setChannel(next.value);
    e.currentTarget.querySelector(`[data-value="${next.value}"]`)?.focus();
  };

  const nameError = touched && !name.trim() ? '请填写名称' : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加号码"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : <Plus />}
            添加
          </button>
        </>
      }
    >
      <form className="vstack" style={{ gap: 'var(--sp-4)' }} onSubmit={submit} noValidate>
        <Field label="名称" htmlFor="acc-name" error={nameError}>
          <input
            {...fieldProps('acc-name', nameError)}
            className="input"
            value={name}
            maxLength={40}
            placeholder="例如：销售小王、售后专线"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="field">
          <div className="field__label-row">
            <span className="field__label" id="acc-channel-label">
              接入方式
            </span>
          </div>
          <div className="numbers-channel" role="radiogroup" aria-labelledby="acc-channel-label" onKeyDown={onChannelKey}>
            {CHANNEL_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                data-value={o.value}
                aria-checked={channel === o.value}
                tabIndex={channel === o.value ? 0 : -1}
                className="option-card"
                onClick={() => setChannel(o.value)}
              >
                <span className="option-card__title">{o.title}</span>
                <span className="option-card__desc">{o.desc}</span>
              </button>
            ))}
          </div>
          <div className="field__hint">添加后不能更改。要换接入方式，需要删除这个号再重新添加。</div>
          <div className="field__hint">每个扫码号大约占用 100–200MB 内存</div>
        </div>
      </form>
    </Modal>
  );
}

/** 行内的自动回复开关：直接调接口，结束后以服务端返回为准 */
function AutoReplySwitch({ account }) {
  const [pending, setPending] = useState(null);
  const toggling = pending !== null;
  const on = toggling ? pending : !!account.autoReply;

  const toggle = async (next) => {
    setPending(next);
    try {
      const res = await api.putAccount(account.id, { autoReply: next });
      patchAccountCache(res && res.id ? res : { id: account.id, autoReply: next });
      toast.success(next ? `「${account.name}」自动回复已开启` : `「${account.name}」自动回复已关闭`);
    } catch {
      // 已提示
    } finally {
      setPending(null);
    }
  };

  return (
    <span className="numbers-table__switch">
      <Switch checked={on} onChange={toggle} disabled={toggling} label={`「${account.name}」自动回复`} />
      {toggling && <Spinner />}
    </span>
  );
}

export default function NumbersTab() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { accounts, error, reload } = useAccounts();
  const [adding, setAdding] = useState(false);
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');

  // 每 6 秒刷新连接状态；离开页面自动停止
  usePolling(() => reload(true), 6000, true);

  // 负责的业务员：成员列表只有 admin 能读
  useEffect(() => {
    if (!isAdmin) return;
    api
      .listUsers({ silent: true })
      .then((list) => setUsers(Array.isArray(list) ? list : []))
      .catch(() => setUsers([]));
  }, [isAdmin]);

  const agentsOf = useMemo(() => {
    const map = new Map();
    (users || []).forEach((u) => {
      if (u.role !== 'agent' || !Array.isArray(u.accountIds)) return;
      u.accountIds.forEach((id) => {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(u.name || u.email);
      });
    });
    return map;
  }, [users]);

  const filtered = useMemo(() => {
    if (!accounts) return null;
    const kw = q.trim().toLowerCase();
    return accounts.filter((a) => {
      if (stateFilter && stateGroup(a) !== stateFilter) return false;
      if (channelFilter && a.channel !== channelFilter) return false;
      if (!kw) return true;
      return [a.name, phoneOf(a), a.status?.me?.pushName].some((s) => String(s || '').toLowerCase().includes(kw));
    });
  }, [accounts, q, stateFilter, channelFilter]);

  const onCreated = (acc) => {
    setAdding(false);
    reload(true);
    if (acc?.id) navigate(`/whatsapp/numbers/${encodeURIComponent(acc.id)}/connect`);
  };

  const columns = [
    {
      key: 'name',
      header: '名称',
      sortValue: (a) => a.name || '',
      render: (a) => (
        <CellText primary={a.name || '未命名号码'} secondary={phoneOf(a) && <span className="num">{phoneOf(a)}</span>} />
      ),
    },
    {
      key: 'channel',
      header: '接入方式',
      hide: 'md',
      sortValue: (a) => CHANNEL_LABEL[a.channel] || a.channel,
      render: (a) => <span className="nowrap">{CHANNEL_LABEL[a.channel] || a.channel}</span>,
    },
    {
      key: 'state',
      header: '状态',
      sortValue: (a) => waState(a.status?.state).label,
      render: (a) => {
        const st = waState(a.status?.state);
        return (
          <StatusDot tone={st.tone} pulse={st.pulse}>
            {st.label}
          </StatusDot>
        );
      },
    },
    {
      key: 'autoReply',
      header: '自动回复',
      shrink: true,
      sortValue: (a) => (a.autoReply ? 1 : 0),
      render: (a) => <AutoReplySwitch account={a} />,
    },
    isAdmin && {
      key: 'agents',
      header: '负责的业务员',
      hide: 'md',
      sortValue: (a) => (agentsOf.get(a.id) || []).join('、') || null,
      render: (a) => {
        const names = agentsOf.get(a.id) || [];
        if (users == null) return <span className="muted">…</span>;
        if (!names.length) return <span className="muted">—</span>;
        const text = names.join('、');
        return (
          <span className="ellipsis" title={text} style={{ display: 'block', maxWidth: 240 }}>
            {text}
          </span>
        );
      },
    },
    {
      key: 'lastAt',
      header: '最近消息时间',
      hide: 'sm',
      shrink: true,
      sortValue: (a) => (a.status?.lastWebhookAt ? new Date(a.status.lastWebhookAt).getTime() : null),
      render: (a) => {
        const iso = a.status?.lastWebhookAt;
        if (!iso) return <span className="numbers-table__time">—</span>;
        return (
          <Tooltip content={fullTime(iso)}>
            <span className="numbers-table__time">{shortTime(iso)}</span>
          </Tooltip>
        );
      },
    },
  ].filter(Boolean);

  const filtering = !!(q.trim() || stateFilter || channelFilter);
  const clearFilters = () => {
    setQ('');
    setStateFilter('');
    setChannelFilter('');
  };

  const addButton = isAdmin && (
    <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
      <Plus /> 添加号码
    </button>
  );

  let body;
  if (error && accounts == null) {
    body = <ErrorState error={error} onRetry={() => reload(true)} />;
  } else if (accounts && accounts.length === 0) {
    body = (
      <EmptyState
        fill
        icon={Smartphone}
        title={isAdmin ? '还没有添加号码' : '还没有分配给你的号码'}
        desc={
          isAdmin
            ? '添加一个 WhatsApp 号，扫码或接入 Meta 官方接口后，机器人就能开始回复客户。一个企业可以接多个号，共用同一个知识库。'
            : '请联系管理员把号码分配给你。'
        }
        action={addButton}
      />
    );
  } else {
    body = (
      <>
        <TableToolbar search={q} onSearch={setQ} searchPlaceholder="搜索名称或号码" count={filtered ? filtered.length : null}>
          <Select
            size="sm"
            className="select--auto"
            value={stateFilter}
            onChange={setStateFilter}
            options={STATE_FILTERS}
            aria-label="按状态筛选"
          />
          <Select
            size="sm"
            className="select--auto"
            value={channelFilter}
            onChange={setChannelFilter}
            options={CHANNEL_FILTERS}
            aria-label="按接入方式筛选"
          />
        </TableToolbar>
        <DataTable
          label="号码"
          columns={columns}
          rows={filtered}
          onRowClick={(a) => navigate(`/whatsapp/numbers/${encodeURIComponent(a.id)}/connect`)}
          empty={
            <EmptyState
              compact
              title={filtering ? '没有符合条件的号码' : '还没有号码'}
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
    <div className="page">
      <PageHeader title="号码" count={accounts?.length || null} actions={addButton} />
      {body}
      {isAdmin && <AddAccountModal open={adding} onClose={() => setAdding(false)} onCreated={onCreated} />}
    </div>
  );
}
