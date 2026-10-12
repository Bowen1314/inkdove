import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Contact, Download, MessageSquare, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api } from '../api/client.js';
import { toast } from '../ui/toastBus.js';
import { useConfirm } from '../ui/Modal.jsx';
import { Drawer } from '../ui/Drawer.jsx';
import { Select } from '../ui/Select.jsx';
import { StatusDot } from '../ui/StatusDot.jsx';
import { TimeText } from '../ui/TimeText.jsx';
import { CellText, DataTable, TableToolbar } from '../ui/DataTable.jsx';
import { EmptyState, ErrorState, Field, Loading, PageHeader, Spinner, fieldProps } from '../ui/common.jsx';
import { useAuth } from '../lib/auth.jsx';
import { accountName, useAccounts } from '../lib/accounts.js';
import { LEAD_STAGES, leadStageLabel, leadStageTone } from '../lib/labels.js';
import { fmtFull } from '../lib/format.js';

/**
 * 客户线索（F6）。
 * 列表：GET /api/leads?q=&stage=&accountId=（服务端按权限过滤：agent 只看到自己号的线索），搜索和筛选都交给服务端，
 * 排序和分页在前端做。点行打开抽屉：编辑（PUT 只提交改过的字段）、重新提取、打开会话、删除（只有 admin）。
 * 会话页「打开客户」的链接是 /leads?lead=<id>，这里读 lead 参数打开抽屉。
 */

/** 抽屉里能改的字段（和 Lead 字段名一致；改过的字段后端记进 manualFields） */
const EDIT_FIELDS = ['name', 'company', 'country', 'email', 'interest', 'quantity', 'stage', 'summary'];
const MANUAL_HINT = '已手动修改，重新提取不会覆盖';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STAGE_OPTIONS = LEAD_STAGES.map(({ value, label }) => ({ value, label }));
const STAGE_FILTERS = [{ value: '', label: '全部阶段' }, ...STAGE_OPTIONS];
const STAGE_ORDER = Object.fromEntries(LEAD_STAGES.map((s, i) => [s.value, i]));

/** GET /api/leads 直接给数组；也兼容包一层 {leads} */
const toList = (res) => (Array.isArray(res) ? res : Array.isArray(res?.leads) ? res.leads : []);
/** PUT、refresh、GET /:id 返回的 Lead；也兼容包一层 {lead} */
const toLead = (res) => {
  const l = res?.lead || res;
  return l && typeof l === 'object' && l.id ? l : null;
};

/** 客户叫什么：提取到的名字 > WhatsApp 名字 > 号码 */
const displayName = (l) => l?.name || l?.contactName || l?.contactNumber || '未知客户';

const toForm = (l) => Object.fromEntries(EDIT_FIELDS.map((k) => [k, l?.[k] || '']));
const norm = (k, v) => (k === 'stage' ? v || '' : String(v || '').trim());

function StageTag({ stage }) {
  const tone = leadStageTone(stage);
  return <span className={`tag${tone === 'neutral' ? '' : ` tag--${tone}`}`}>{leadStageLabel(stage)}</span>;
}

/** 表格里的一段文字：空值显示 —，超长省略，悬停看全文。size 控制最大宽度 */
function TextCell({ value, size }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className={`leads-page__text${size ? ` leads-page__text--${size}` : ''} ellipsis`} title={value}>
      {value}
    </span>
  );
}

/* ---------- 详情抽屉 ---------- */

function LeadDrawer({ lead, acctName, canDelete, onClose, onUpdated, onDeleted }) {
  const confirm = useConfirm();
  const [form, setForm] = useState(() => toForm(lead));
  const [busy, setBusy] = useState(null); // 'save' | 'refresh' | 'delete'
  const [emailErr, setEmailErr] = useState(null);
  // 当前线索的原值：保存时只提交和它不同的字段（提交了的字段会被记成"手动修改"）
  const base = useRef(toForm(lead));

  // 保存或重新提取后线索变了：没动过的字段换成新值，正在改的字段保留
  const sig = `${lead.updatedAt || ''}|${lead.extractedAt || ''}|${JSON.stringify(toForm(lead))}`;
  useEffect(() => {
    const next = toForm(lead);
    const old = base.current;
    base.current = next;
    setForm((f) => Object.fromEntries(EDIT_FIELDS.map((k) => [k, f[k] !== old[k] ? f[k] : next[k]])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'email') setEmailErr(null);
  };
  const dirty = EDIT_FIELDS.some((k) => norm(k, form[k]) !== norm(k, base.current[k]));
  const manual = new Set(Array.isArray(lead.manualFields) ? lead.manualFields : []);
  const hint = (k) => (manual.has(k) ? MANUAL_HINT : undefined);
  const saving = busy === 'save';
  const refreshing = busy === 'refresh';
  const deleting = busy === 'delete';

  const save = async () => {
    if (busy) return;
    const patch = {};
    EDIT_FIELDS.forEach((k) => {
      const v = norm(k, form[k]);
      if (v !== norm(k, base.current[k])) patch[k] = v;
    });
    if (!Object.keys(patch).length) return;
    if (patch.email && !EMAIL_RE.test(patch.email)) {
      setEmailErr('邮箱格式不对');
      return;
    }
    setBusy('save');
    try {
      const res = await api.updateLead(lead.id, patch);
      // 接口没带回 Lead 时，本地合并，并把改过的字段记成手动修改
      onUpdated(
        toLead(res) || {
          ...lead,
          ...patch,
          manualFields: Array.from(new Set([...manual, ...Object.keys(patch)])),
        },
      );
      toast.success('已保存');
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy('refresh');
    try {
      const res = await api.refreshLead(lead.id);
      // 接口没带回 Lead 时，再取一次
      const next = toLead(res) || toLead(await api.getLead(lead.id, { silent: true }).catch(() => null));
      if (next) onUpdated(next);
      toast.success('已重新提取');
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    const ok = await confirm({
      title: '删除这条客户线索？',
      message: `「${displayName(lead)}」的线索删除后无法恢复，会话和聊天记录不受影响。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.deleteLead(lead.id);
      toast.success('已删除');
      onDeleted(lead.id);
    } catch {
      setBusy(null);
    }
  };

  const chatUrl = lead.conversationId ? `/whatsapp/chats?chat=${encodeURIComponent(lead.conversationId)}` : null;

  const input = (k, label, extra = {}) => (
    <Field label={label} htmlFor={`ld-${k}`} hint={hint(k)} error={k === 'email' ? emailErr : null}>
      <input
        {...fieldProps(`ld-${k}`, k === 'email' ? emailErr : null)}
        className="input"
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
        {...extra}
      />
    </Field>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      title={displayName(lead)}
      footer={
        <>
          {canDelete && (
            <button type="button" className="btn btn--danger leads-drawer__foot-start" onClick={remove} disabled={!!busy}>
              {deleting ? <Spinner /> : <Trash2 />}
              删除
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          <button type="submit" form="lead-form" className="btn btn--primary" disabled={!dirty || !!busy}>
            {saving ? <Spinner /> : <Save />}
            保存
          </button>
        </>
      }
    >
      <form
        id="lead-form"
        className="leads-drawer vstack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <dl className="kv">
          <dt>号码</dt>
          <dd className="num">{lead.contactNumber || '—'}</dd>
          {lead.contactName && (
            <>
              <dt>WhatsApp 名</dt>
              <dd>{lead.contactName}</dd>
            </>
          )}
          <dt>所属号</dt>
          <dd>{acctName || '—'}</dd>
          <dt>最近联系</dt>
          <dd className="num">{fmtFull(lead.lastContactAt) || '—'}</dd>
          <dt>提取时间</dt>
          <dd className="num">
            {refreshing ? (
              <span className="leads-drawer__busy">
                <Spinner />
                正在提取…
              </span>
            ) : (
              fmtFull(lead.extractedAt) || '还没提取过'
            )}
          </dd>
          <dt>更新时间</dt>
          <dd className="num">{fmtFull(lead.updatedAt) || '—'}</dd>
        </dl>

        <div className="leads-drawer__actions">
          {chatUrl && (
            <Link className="btn btn--sm" to={chatUrl}>
              <MessageSquare />
              打开会话
            </Link>
          )}
          <button type="button" className="btn btn--sm" onClick={refresh} disabled={!!busy}>
            {refreshing ? <Spinner /> : <RefreshCw />}
            重新提取
          </button>
        </div>

        <div className="form-grid leads-drawer__fields">
          {input('name', '名字')}
          {input('company', '公司')}
          {input('country', '国家')}
          {input('email', '邮箱', { type: 'email', autoComplete: 'off' })}
          {input('interest', '意向产品')}
          {input('quantity', '数量')}
          <Field label="阶段" htmlFor="ld-stage" hint={hint('stage')} className="field--full">
            <Select id="ld-stage" value={form.stage} onChange={(v) => set('stage', v)} options={STAGE_OPTIONS} />
          </Field>
          <Field label="摘要" htmlFor="ld-summary" hint={hint('summary')} className="field--full">
            <textarea
              id="ld-summary"
              className="textarea"
              rows={4}
              value={form.summary}
              placeholder="还没有摘要"
              onChange={(e) => set('summary', e.target.value)}
            />
          </Field>
        </div>
      </form>
    </Drawer>
  );
}

/* ---------- 主体 ---------- */

export default function Leads() {
  const { isAdmin } = useAuth();
  const { accounts } = useAccounts();
  const [params, setParams] = useSearchParams();
  const openId = params.get('lead') || null;

  const [leads, setLeads] = useState(null); // null = 加载中
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [accountId, setAccountId] = useState('');
  const [detail, setDetail] = useState(null); // 不在当前列表里的线索（比如从会话页跳过来但被筛掉了）
  const [leadsEnabled, setLeadsEnabled] = useState(null); // 只有 admin 读得到设置

  const filterKey = JSON.stringify([q.trim(), stage, accountId]);
  const latest = useRef(filterKey);

  const load = useCallback(async () => {
    const key = JSON.stringify([q.trim(), stage, accountId]);
    latest.current = key;
    try {
      const res = await api.listLeads({ q: q.trim(), stage, accountId }, { silent: true });
      if (latest.current !== key) return; // 筛选已经变了，丢掉旧结果
      setLeads(toList(res));
      setError(null);
    } catch (e) {
      if (latest.current !== key) return;
      setError(e);
    }
  }, [q, stage, accountId]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = () => {
    setError(null);
    setLeads(null);
    load();
  };

  // 自动提取开关（leads.enabled）在全局设置里，只有 admin 能读；agent 不显示这条提示
  useEffect(() => {
    if (!isAdmin) return undefined;
    let alive = true;
    api
      .getSettings({ silent: true })
      .then((s) => alive && setLeadsEnabled(s?.leads?.enabled !== false))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isAdmin]);
  const extractOff = isAdmin && leadsEnabled === false;

  const openDrawer = (id) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set('lead', id);
        return next;
      },
      { replace: true },
    );
  const closeDrawer = useCallback(
    () =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('lead');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // 要打开的线索不在当前列表里：单独取一次
  const listed = openId && leads ? leads.find((l) => l.id === openId) || null : null;
  const listSettled = leads != null || !!error;
  useEffect(() => {
    if (!openId || listed || !listSettled || detail?.id === openId) return undefined;
    let alive = true;
    api
      .getLead(openId, { silent: true })
      .then((res) => {
        if (!alive) return;
        const l = toLead(res);
        if (l && l.id === openId) setDetail(l);
        else closeDrawer();
      })
      .catch((e) => {
        if (!alive) return;
        toast.error(e.status === 404 ? '这条客户线索不存在或已被删除' : e.message);
        closeDrawer();
      });
    return () => {
      alive = false;
    };
  }, [openId, listed, listSettled, detail, closeDrawer]);

  const openLead = listed || (detail?.id === openId ? detail : null);

  const replaceLead = (l) => {
    setLeads((prev) => prev && prev.map((x) => (x.id === l.id ? l : x)));
    setDetail((d) => (d?.id === l.id ? l : d));
  };
  const removeLead = (id) => {
    setLeads((prev) => prev && prev.filter((x) => x.id !== id));
    setDetail((d) => (d?.id === id ? null : d));
    closeDrawer();
  };

  const acctOf = (l) => l.accountName || accountName(accounts, l.accountId) || '';

  /** 客户名下面那行：号码，加上所属号（所属号那列隐藏时才显示，见 leads.css） */
  const subLine = (l) => {
    const num = displayName(l) !== l.contactNumber ? l.contactNumber : '';
    const acct = acctOf(l);
    if (!num && !acct) return null;
    return (
      <>
        <span className="num">{num}</span>
        {acct && (
          <span className="leads-page__acct-inline">
            {num ? ' · ' : ''}
            {acct}
          </span>
        )}
      </>
    );
  };

  // 窄屏隐藏：< 1440 更新时间；< 1280 国家、数量、所属号；< 768 公司；< 640 意向产品
  const columns = [
    {
      key: 'contact',
      header: '客户',
      sortValue: (l) => displayName(l),
      render: (l) => (
        <div className="leads-page__contact">
          <CellText primary={<span title={displayName(l)}>{displayName(l)}</span>} secondary={subLine(l)} />
        </div>
      ),
    },
    {
      key: 'company',
      header: '公司',
      hide: 'md',
      sortValue: (l) => l.company || null,
      render: (l) => <TextCell value={l.company} />,
    },
    {
      key: 'country',
      header: '国家',
      hide: 'xl',
      sortValue: (l) => l.country || null,
      render: (l) => <TextCell value={l.country} size="sm" />,
    },
    {
      key: 'interest',
      header: '意向产品',
      fluid: true,
      hide: 'sm',
      render: (l) => <TextCell value={l.interest} size="fluid" />,
    },
    {
      key: 'quantity',
      header: '数量',
      hide: 'xl',
      render: (l) => <TextCell value={l.quantity} size="sm" />,
    },
    {
      key: 'stage',
      header: '阶段',
      shrink: true,
      sortValue: (l) => STAGE_ORDER[l.stage] ?? 99,
      render: (l) => <StageTag stage={l.stage} />,
    },
    {
      key: 'account',
      header: '所属号',
      hide: 'xl',
      sortValue: (l) => acctOf(l) || null,
      render: (l) => <TextCell value={acctOf(l)} />,
    },
    {
      key: 'lastContactAt',
      header: '最近联系',
      shrink: true,
      sortValue: (l) => l.lastContactAt || null,
      render: (l) => <TimeText iso={l.lastContactAt} />,
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      shrink: true,
      hide: '2xl',
      sortValue: (l) => l.updatedAt || null,
      render: (l) => <TimeText iso={l.updatedAt} />,
    },
  ];

  const filtering = !!(q.trim() || stage || accountId);
  const clearFilters = () => {
    setQ('');
    setStage('');
    setAccountId('');
  };
  // 一条线索都没有（不是被筛掉的）：整页空状态，不显示工具栏
  const emptyAll = !error && leads != null && leads.length === 0 && !filtering;

  const accountOptions = [
    { value: '', label: '全部号码' },
    ...(accounts || []).map((a) => ({ value: a.id, label: a.name || '未命名号码' })),
  ];

  const settingsLink = (
    <Link className="btn btn--primary" to="/settings/leads">
      去设置里打开
    </Link>
  );

  let body;
  if (emptyAll) {
    body = (
      <EmptyState
        fill
        icon={Contact}
        title="还没有客户线索"
        desc={
          extractOff
            ? '自动提取客户线索已关闭。打开后，客户聊过几轮，系统会自动整理出线索。'
            : '客户聊过几轮后，系统会自动整理出线索。'
        }
        action={extractOff && settingsLink}
      />
    );
  } else {
    body = (
      <>
        <TableToolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="搜索名字、公司、号码"
          count={leads && !error ? leads.length : undefined}
          end={
            <a className="btn btn--sm" href={api.leadsExportUrl({ q: q.trim(), stage, accountId })} download>
              <Download />
              导出 CSV
            </a>
          }
        >
          <Select
            size="sm"
            className="select--auto"
            value={stage}
            onChange={setStage}
            options={STAGE_FILTERS}
            aria-label="按阶段筛选"
          />
          {accounts?.length > 1 && (
            <Select
              size="sm"
              className="select--auto"
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              aria-label="按号筛选"
            />
          )}
        </TableToolbar>
        {error ? (
          <ErrorState title="客户线索加载失败" error={error} onRetry={retry} />
        ) : (
          <DataTable
            label="客户线索"
            columns={columns}
            rows={leads}
            rowKey={(l) => l.id}
            onRowClick={(l) => openDrawer(l.id)}
            isRowActive={(l) => l.id === openId}
            defaultSort={{ key: 'lastContactAt', dir: 'desc' }}
            empty={
              <EmptyState
                compact
                title="没有符合条件的客户"
                action={
                  <button type="button" className="btn btn--sm" onClick={clearFilters}>
                    清除筛选
                  </button>
                }
              />
            }
          />
        )}
      </>
    );
  }

  return (
    <div className="page leads-page">
      <PageHeader
        title="客户"
        meta={
          extractOff &&
          !emptyAll && (
            <span className="leads-page__off">
              <StatusDot size="sm" muted>
                自动提取已关闭
              </StatusDot>
              <Link className="link text-sm" to="/settings/leads">
                去设置里打开
              </Link>
            </span>
          )
        }
      />
      {body}

      {openId &&
        (openLead ? (
          <LeadDrawer
            key={openLead.id}
            lead={openLead}
            acctName={acctOf(openLead)}
            canDelete={isAdmin}
            onClose={closeDrawer}
            onUpdated={replaceLead}
            onDeleted={removeLead}
          />
        ) : (
          <Drawer open title="客户" onClose={closeDrawer}>
            <Loading />
          </Drawer>
        ))}
    </div>
  );
}
