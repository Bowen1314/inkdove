import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, MoreHorizontal, Plus, Smartphone, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal, useConfirm } from '../../ui/Modal.jsx';
import { Callout, EmptyState, ErrorState, Field, fieldProps, PageHeader, Spinner } from '../../ui/common.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { Select } from '../../ui/Select.jsx';
import { Menu, Tooltip } from '../../ui/Popover.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useAuth } from '../../lib/auth.jsx';
import { invalidateAccounts, isConnected, patchAccountCache, useAccounts } from '../../lib/accounts.js';
import { CHANNEL_LABEL, REPLY_MODES, replyModeLabel, replyModeOf, waState } from '../../lib/labels.js';
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

// 号码配置导出 / 导入（admin）。文件格式见 README「偏离规格」，服务端还会完整校验一遍
const EXPORT_FORMAT = 'inkdove-accounts';
const EXPORT_VERSION = 1;

/** 和服务端的附件名一致：inkdove-accounts-YYYYMMDD.json（按导出时间的 UTC 日期） */
const exportFileName = (doc) => `inkdove-accounts-${String(doc.exportedAt || '').slice(0, 10).replace(/-/g, '')}.json`;

/** 本地先解析一遍，只为预览要建哪些号；格式不对直接在弹窗里提示，不上传 */
function previewImport(text) {
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (!doc || typeof doc !== 'object' || doc.format !== EXPORT_FORMAT) {
    throw new Error('这不是墨鸽导出的号码配置文件');
  }
  if (doc.version !== EXPORT_VERSION) {
    throw new Error(`不支持这个文件版本（version: ${JSON.stringify(doc.version ?? null)}），只能导入 version ${EXPORT_VERSION}`);
  }
  if (!Array.isArray(doc.accounts)) throw new Error('文件里的 accounts 不是列表');
  return doc.accounts.map((a) => ({
    name: typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : '（没有名称）',
    channel: a?.channel,
  }));
}

/** 导入弹窗：预览要新建的号 → 确认上传 → 显示新建和跳过的结果。文件和校验的错误都显示在弹窗里 */
function ImportModal({ pick, onClose, onPickAgain, onImported }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const items = pick.items || [];
  const hasWaha = items.some((a) => a.channel === 'waha');
  const hasMeta = items.some((a) => a.channel === 'meta');

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importAccounts(pick.file, { silent: true });
      setResult(res);
      if (res.created.length) toast.success(`已导入 ${res.created.length} 个号`);
      onImported();
    } catch (err) {
      setError(err?.message || '导入失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  let body;
  let footer;
  if (result) {
    body = (
      <div className="vstack" style={{ gap: 'var(--sp-3)' }}>
        <div className="numbers-import__summary">
          新建了 {result.created.length} 个号{result.skipped.length > 0 && `，跳过 ${result.skipped.length} 个`}
        </div>
        {result.skipped.length > 0 && (
          <ul className="numbers-import__list" aria-label="跳过的号">
            {result.skipped.map((s, i) => (
              <li key={i} className="numbers-import__item numbers-import__item--stack">
                <span className="numbers-import__name">{s.name}</span>
                <span className="numbers-import__reason">{s.reason}</span>
              </li>
            ))}
          </ul>
        )}
        {/* 导入时被自动调整过的号（比如没配发信方式，邮件通知被关掉了） */}
        {result.created.some((c) => c.notices?.length > 0) && (
          <ul className="numbers-import__list" aria-label="需要留意的号">
            {result.created
              .filter((c) => c.notices?.length > 0)
              .map((c) => (
                <li key={c.id} className="numbers-import__item numbers-import__item--stack">
                  <span className="numbers-import__name">{c.name}</span>
                  <span className="numbers-import__reason">{c.notices.join('；')}</span>
                </li>
              ))}
          </ul>
        )}
        {result.created.length > 0 && hasWaha && (
          <div className="field__hint">扫码接入的号还没有连接，请到各号的「连接」里重新扫码或用配对码连接。</div>
        )}
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" onClick={onClose}>
        完成
      </button>
    );
  } else if (pick.error) {
    body = (
      <div className="vstack" style={{ gap: 'var(--sp-3)' }}>
        <Callout tone="danger">{pick.error}</Callout>
        <div className="field__hint">请选择从墨鸽「号码」页导出的 .json 文件。</div>
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={onPickAgain}>
          <Upload /> 重新选择文件
        </button>
      </>
    );
  } else if (!items.length) {
    body = <div className="muted">文件里没有号码，没有可以导入的内容。</div>;
    footer = (
      <button type="button" className="btn" onClick={onClose}>
        关闭
      </button>
    );
  } else {
    body = (
      <div className="vstack" style={{ gap: 'var(--sp-3)' }}>
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="numbers-import__summary">将新建 {items.length} 个号</div>
        <ul className="numbers-import__list" aria-label="要新建的号">
          {items.map((a, i) => (
            <li key={i} className="numbers-import__item">
              <span className="numbers-import__name">{a.name}</span>
              <span className="numbers-import__channel">{CHANNEL_LABEL[a.channel] || a.channel || '—'}</span>
            </li>
          ))}
        </ul>
        {hasWaha && <div className="field__hint">扫码接入的号导入后需要重新扫码或用配对码连接。</div>}
        {hasMeta && (
          <div className="field__hint">
            Meta 号导入后回调地址会变成新地址，要到 Meta 开发者后台改一下；phoneNumberId 和已有的号重复的会跳过。
          </div>
        )}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={close} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : <Upload />}
          导入
        </button>
      </>
    );
  }

  return (
    <Modal open onClose={close} title="导入号码配置" width={560} footer={footer}>
      {body}
    </Modal>
  );
}

const MODE_OPTIONS = REPLY_MODES.map(({ value, label }) => ({ value, label }));
const modeOrder = (a) => REPLY_MODES.findIndex((m) => m.value === replyModeOf(a));

/**
 * 回复方式列。admin：行内下拉（和原来的自动回复开关一样即时生效，以服务端返回为准）；agent：只显示文字（改号的设置是 403）。
 * 下拉的选项浮层挂在 body 上，React 事件仍会冒泡到表格行，这里拦住，免得选完就打开了号详情。
 */
function ReplyModeCell({ account, editable }) {
  const [pending, setPending] = useState(null);
  const saved = replyModeOf(account);
  if (!editable) return <span className="nowrap">{replyModeLabel(saved)}</span>;

  const change = async (next) => {
    if (next === saved || pending) return;
    setPending(next);
    try {
      const res = await api.putAccount(account.id, { replyMode: next });
      patchAccountCache(res && res.id ? res : { id: account.id, replyMode: next, autoReply: next === 'auto' });
      toast.success(`「${account.name}」的回复方式已改为「${replyModeLabel(next)}」`);
    } catch {
      // 已提示
    } finally {
      setPending(null);
    }
  };

  return (
    <span className="numbers-table__mode" onClick={(e) => e.stopPropagation()}>
      <Select
        size="sm"
        className="select--auto"
        value={pending ?? saved}
        onChange={change}
        options={MODE_OPTIONS}
        placeholder="—"
        disabled={pending !== null}
        aria-label={`「${account.name}」的回复方式`}
      />
      {pending !== null && <Spinner />}
    </span>
  );
}

export default function NumbersTab() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin } = useAuth();
  const { accounts, error, reload } = useAccounts();
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importPick, setImportPick] = useState(null); // {seq, file, items?, error?}
  const fileRef = useRef(null);
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
      key: 'replyMode',
      header: '回复方式',
      shrink: true,
      sortValue: modeOrder,
      render: (a) => <ReplyModeCell account={a} editable={isAdmin} />,
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

  const exportAll = async () => {
    const ok = await confirm({
      title: '导出号码配置',
      message: `将导出全部 ${accounts?.length ?? 0} 个号的配置。\n文件里包含 Meta token、代理密码等密钥的明文，请妥善保管。`,
      confirmText: '导出',
    });
    if (!ok) return;
    setExporting(true);
    try {
      const doc = await api.exportAccounts();
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(doc);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`已导出 ${doc.accounts.length} 个号的配置`);
    } catch {
      // 已提示
    } finally {
      setExporting(false);
    }
  };

  const pickImportFile = () => fileRef.current?.click();
  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同一个文件改完再选一次也能触发
    if (!file) return;
    const seq = Date.now();
    try {
      setImportPick({ seq, file, items: previewImport(await file.text()) });
    } catch (err) {
      setImportPick({ seq, file, error: err?.message || '读取文件失败，请重新选择' });
    }
  };

  const headerActions = isAdmin && (
    <>
      <Menu
        minWidth={160}
        tooltip="导出、导入号码配置"
        trigger={
          <button type="button" className="btn btn--ghost btn--icon" aria-label="导出、导入号码配置" disabled={exporting}>
            {exporting ? <Spinner /> : <MoreHorizontal />}
          </button>
        }
        items={[
          { label: '导出配置', icon: Download, onClick: exportAll, disabled: !accounts?.length },
          { label: '导入配置', icon: Upload, onClick: pickImportFile },
        ]}
      />
      {addButton}
    </>
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
            ? '添加一个 WhatsApp 号，扫码或接入 Meta 官方接口后，客户消息会进到「会话」里，需要时让 AI 推荐回复，也可以开自动回复。一个企业可以接多个号，共用同一个知识库。'
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
      <PageHeader title="号码" count={accounts?.length || null} actions={headerActions} />
      {body}
      {isAdmin && <AddAccountModal open={adding} onClose={() => setAdding(false)} onCreated={onCreated} />}
      {isAdmin && <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onImportFile} />}
      {importPick && (
        <ImportModal
          key={importPick.seq}
          pick={importPick}
          onClose={() => setImportPick(null)}
          onPickAgain={pickImportFile}
          onImported={() => {
            invalidateAccounts();
            reload(true);
          }}
        />
      )}
    </div>
  );
}
