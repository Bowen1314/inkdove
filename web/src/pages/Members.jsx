import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, KeyRound, MoreHorizontal, Pencil, Plus, Power, Save, Trash2, UserPlus, Users } from 'lucide-react';
import { api } from '../api/client.js';
import { toast } from '../ui/toastBus.js';
import { Modal, useConfirm } from '../ui/Modal.jsx';
import { Drawer } from '../ui/Drawer.jsx';
import { Menu, Tooltip } from '../ui/Popover.jsx';
import { Select } from '../ui/Select.jsx';
import { DataTable, RowActions, TableToolbar } from '../ui/DataTable.jsx';
import { CopyButton, EmptyState, ErrorState, Field, PageHeader, Spinner, fieldProps } from '../ui/common.jsx';
import { StatusDot } from '../ui/StatusDot.jsx';
import { Avatar } from '../ui/Avatar.jsx';
import { AccountPicker } from '../ui/AccountPicker.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useAccounts } from '../lib/accounts.js';
import { ROLES, assignErrorText, roleLabel, userStatus } from '../lib/labels.js';
import { fmtTime } from '../lib/format.js';

/** 成员状态的筛选键：disabled > pending > active（和 userStatus 的判断顺序一致） */
const statusKey = (u) => (u?.disabled ? 'disabled' : u?.pending ? 'pending' : 'active');

const ROLE_FILTERS = [{ value: '', label: '全部角色' }, ...ROLES.map((r) => ({ value: r.value, label: r.label }))];
const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: userStatus({}).label },
  { value: 'pending', label: userStatus({ pending: true }).label },
  { value: 'disabled', label: userStatus({ disabled: true }).label },
];

/** 显示链接 + 复制按钮（邀请链接、重置链接共用） */
function LinkResult({ url, note }) {
  return (
    <div className="vstack">
      <div className="hstack">
        <input
          className="input input--mono"
          value={url || ''}
          readOnly
          onFocus={(e) => e.target.select()}
          aria-label="链接"
        />
        <CopyButton text={url || ''} size="md" />
      </div>
      <div className="field__hint">{note}</div>
    </div>
  );
}

function RolePicker({ value, onChange, idPrefix }) {
  return (
    <div className="choice-list" role="radiogroup" aria-label="角色">
      {ROLES.map((r) => (
        <label key={r.value} className="choice">
          <input
            type="radio"
            className="radio"
            name={`${idPrefix}-role`}
            value={r.value}
            checked={value === r.value}
            onChange={() => onChange(r.value)}
          />
          <span className="choice__text">
            <span>{r.label}</span>
            <span className="choice__desc">{r.desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 邀请成员：POST /api/users → {user, inviteUrl}，提交后显示链接 */
function InviteModal({ open, onClose, accounts, onInvited }) {
  const [form, setForm] = useState({ email: '', name: '', role: 'agent', accountIds: [] });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);

  useEffect(() => {
    if (open) {
      setForm({ email: '', name: '', role: 'agent', accountIds: [] });
      setTouched(false);
      setInviteUrl(null);
    }
  }, [open]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const errs = {
    email: !EMAIL_RE.test(form.email.trim()) ? '请填写正确的邮箱' : '',
    name: !form.name.trim() ? '请填写姓名' : '',
  };
  const show = (k) => (touched ? errs[k] : '');

  const submit = async (e) => {
    e?.preventDefault();
    setTouched(true);
    if (Object.values(errs).some(Boolean) || busy) return;
    setBusy(true);
    try {
      const res = await api.createUser({
        email: form.email.trim(),
        name: form.name.trim(),
        role: form.role,
        accountIds: form.role === 'agent' ? form.accountIds : [],
      });
      setInviteUrl(res?.inviteUrl || '');
      onInvited(res?.user);
    } catch {
      // 已提示
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={inviteUrl !== null ? '邀请链接已生成' : '邀请成员'}
      width={560}
      footer={
        inviteUrl !== null ? (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            完成
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" form="member-invite-form" className="btn btn--primary" disabled={busy}>
              {busy ? <Spinner /> : <UserPlus />}
              生成邀请链接
            </button>
          </>
        )
      }
    >
      {inviteUrl !== null ? (
        <div className="vstack members__stack">
          <p>
            已邀请 <span className="text-strong">{form.name.trim()}</span>（{form.email.trim()}），角色：{roleLabel(form.role)}。
          </p>
          <LinkResult url={inviteUrl} note="链接 7 天内有效，请自行发送给对方。对方设置密码后即可登录。" />
        </div>
      ) : (
        <form id="member-invite-form" className="vstack members__stack" onSubmit={submit} noValidate>
          <div className="form-grid">
            <Field label="邮箱" htmlFor="inv-email" error={show('email')}>
              <input
                {...fieldProps('inv-email', show('email'))}
                className="input"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
              />
            </Field>
            <Field label="姓名" htmlFor="inv-name2" error={show('name')}>
              <input
                {...fieldProps('inv-name2', show('name'))}
                className="input"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
          </div>
          <Field label="角色">
            <RolePicker value={form.role} onChange={(v) => set('role', v)} idPrefix="inv" />
          </Field>
          {form.role === 'agent' && (
            <Field label="负责号码" hint="业务员仅可查看和处理这些号码的会话。">
              <AccountPicker accounts={accounts} value={form.accountIds} onChange={(v) => set('accountIds', v)} />
            </Field>
          )}
          <div className="field__hint">系统不发送邮件，请自行将链接发送给对方。</div>
        </form>
      )}
    </Modal>
  );
}

/** 编辑成员（点行打开的抽屉）：PUT /api/users/:id {name?, role?, accountIds?} */
function EditDrawer({ user, self, onClose, accounts, onSaved }) {
  const [form, setForm] = useState({ name: '', role: 'agent', accountIds: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) setForm({ name: user.name || '', role: user.role || 'agent', accountIds: user.accountIds || [] });
  }, [user]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const nameErr = user && !form.name.trim() ? '请填写姓名' : '';

  const save = async (e) => {
    e?.preventDefault();
    if (!form.name.trim() || busy) return;
    setBusy(true);
    try {
      // 自己的角色不在这里改，免得把自己降成业务员后被锁在管理页面外
      const patch = self ? { name: form.name.trim() } : { name: form.name.trim(), role: form.role };
      if (!self && form.role === 'agent') patch.accountIds = form.accountIds;
      const res = await api.updateUser(user.id, patch);
      onSaved(res && res.id ? res : { ...user, ...patch });
      toast.success('已保存');
    } catch {
      // 已提示（比如 last_admin：不能降级最后一个管理员）
    } finally {
      setBusy(false);
    }
  };

  const st = userStatus(user);

  return (
    <Drawer
      open={!!user}
      onClose={onClose}
      title="编辑成员"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="member-edit-form" className="btn btn--primary" disabled={busy || !!nameErr}>
            {busy ? <Spinner /> : <Save />}
            保存
          </button>
        </>
      }
    >
      {user && (
        <form id="member-edit-form" className="vstack members__form" onSubmit={save} noValidate>
          <dl className="kv">
            <dt>邮箱</dt>
            <dd>{user.email || '—'}</dd>
            <dt>状态</dt>
            <dd>
              <StatusDot tone={st.tone}>{st.label}</StatusDot>
            </dd>
            <dt>最近登录</dt>
            <dd>{user.lastLoginAt ? fmtTime(user.lastLoginAt) : '从未登录'}</dd>
          </dl>
          <hr className="divider members__divider" />
          <Field label="姓名" htmlFor="ed-name" error={nameErr}>
            <input
              {...fieldProps('ed-name', nameErr)}
              className="input"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          {self ? (
            <Field label="角色" hint="不能修改本人角色，需由其他管理员修改。">
              <div className="members__readonly">{roleLabel(form.role)}</div>
            </Field>
          ) : (
            <Field label="角色">
              <RolePicker value={form.role} onChange={(v) => set('role', v)} idPrefix="ed" />
            </Field>
          )}
          {!self && form.role === 'agent' && (
            <Field label="负责号码">
              <AccountPicker accounts={accounts} value={form.accountIds} onChange={(v) => set('accountIds', v)} />
            </Field>
          )}
        </form>
      )}
    </Drawer>
  );
}

function AccountNames({ user, accounts }) {
  if (user.role === 'admin') return <span className="muted nowrap">全部号码</span>;
  const ids = user.accountIds || [];
  if (!ids.length) return <span className="muted nowrap">未分配</span>;
  if (accounts == null) return <span className="muted">…</span>;
  const names = ids.map((id) => accounts?.find((a) => a.id === id)?.name || '（已删除）').join('、');
  return (
    <div className="members__accts ellipsis" title={names}>
      {names}
    </div>
  );
}

/** 转交结果的一句话提示 */
function transferText({ moved = 0, skipped = 0 } = {}, fromName, toName) {
  const parts = [];
  if (moved > 0 || !skipped) parts.push(`已将 ${moved} 个客户转交给 ${toName}`);
  if (skipped > 0) parts.push(`${skipped} 个未转交：${toName} 无对应号码权限，仍由 ${fromName} 负责`);
  return parts.join('；');
}

/**
 * 转交客户：POST /api/users/:id/transfer {toUserId}。
 * mode=disable 是停用还负责客户的成员前的提示：可以先转交再停用，也可以跳过直接停用。
 */
function TransferModal({ target, users, onClose, onTransferred, onDisable }) {
  const user = target?.user;
  const disabling = target?.mode === 'disable';
  const [toId, setToId] = useState('');
  const [busy, setBusy] = useState(null); // 'transfer' | 'skip'

  useEffect(() => {
    if (target) {
      setToId('');
      setBusy(null);
    }
  }, [target]);

  const options = (users || [])
    .filter((u) => u.id !== user?.id && !u.disabled)
    .map((u) => ({ value: u.id, label: u.name || u.email, desc: roleLabel(u.role) }));
  const fromName = user ? user.name || user.email : '';
  const count = user?.assignedCount || 0;

  const submit = async (withTransfer) => {
    if (busy || (withTransfer && !toId)) return;
    setBusy(withTransfer ? 'transfer' : 'skip');
    try {
      if (withTransfer) {
        const res = await api.transferUserConversations(user.id, toId, { silent: true });
        const to = users.find((u) => u.id === toId);
        const text = transferText(res, fromName, to ? to.name || to.email : '对方');
        if (res?.skipped > 0) toast.info(text, 6000);
        else toast.success(text);
      }
    } catch (e) {
      toast.error(assignErrorText(e));
      setBusy(null);
      return;
    }
    // 先停用再刷新列表，免得刷新拿到停用前的旧数据
    const ok = disabling ? await onDisable(user) : true;
    if (withTransfer) onTransferred();
    // 只是停用失败（已提示）时留在弹窗里，可以重试或取消；转交已经做完就直接关
    if (!ok && !withTransfer) {
      setBusy(null);
      return;
    }
    onClose();
  };

  return (
    <Modal
      open={!!user}
      onClose={busy ? () => {} : onClose}
      title={disabling ? `停用「${fromName}」？` : `转交「${fromName}」的客户`}
      width={440}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>
            取消
          </button>
          {disabling && (
            <button type="button" className="btn btn--danger" onClick={() => submit(false)} disabled={!!busy}>
              {busy === 'skip' && <Spinner />}
              跳过，直接停用
            </button>
          )}
          <button
            type="button"
            className={`btn ${disabling ? 'btn--danger-solid' : 'btn--primary'}`}
            onClick={() => submit(true)}
            disabled={!!busy || !toId}
          >
            {busy === 'transfer' ? <Spinner /> : <ArrowRightLeft />}
            {disabling ? '转交并停用' : '转交'}
          </button>
        </>
      }
    >
      {user && (
        <div className="vstack members__stack">
          <p className="muted">
            {disabling
              ? `停用后对方立即退出登录，无法再登录后台。${fromName} 负责 ${count} 个客户，可先转交；未转交的客户仍归属该成员，可稍后转交。`
              : `将 ${fromName} 负责的 ${count} 个客户全部转交给其他成员。`}
          </p>
          <Field label="转给" htmlFor="tr-to" hint="对方无对应号码权限的客户不转交。">
            <Select id="tr-to" value={toId} onChange={setToId} options={options} placeholder="选择成员" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** 只有图标的"更多"按钮：Menu 的 trigger 要接 ref，Tooltip 套在外层 span 上 */
function MoreMenu({ items, disabled }) {
  return (
    <Tooltip content="更多操作">
      <span className="members__more">
        <Menu
          minWidth={160}
          items={items}
          trigger={
            <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="更多操作" disabled={disabled}>
              <MoreHorizontal />
            </button>
          }
        />
      </span>
    </Tooltip>
  );
}

export default function MembersPage() {
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const { accounts } = useAccounts();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [resetLink, setResetLink] = useState(null); // {user, url}
  const [transfer, setTransfer] = useState(null); // {user, mode: 'transfer' | 'disable'}
  const [busyId, setBusyId] = useState(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers((await api.listUsers({ silent: true })) || []);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upsert = (u) => {
    if (!u?.id) {
      load();
      return;
    }
    setUsers((prev) => {
      const list = prev || [];
      return list.some((x) => x.id === u.id) ? list.map((x) => (x.id === u.id ? { ...x, ...u } : x)) : [...list, u];
    });
  };

  /** 停用或启用，成功返回 true */
  const setDisabled = async (u, disabling) => {
    setBusyId(u.id);
    try {
      const res = await api.updateUser(u.id, { disabled: disabling });
      upsert(res && res.id ? res : { ...u, disabled: disabling });
      toast.success(disabling ? '已停用' : '已启用');
      return true;
    } catch {
      // 已提示（last_admin 等）
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleDisabled = async (u) => {
    const disabling = !u.disabled;
    if (disabling) {
      // 还负责客户：先问要不要转交（可以跳过）
      if (u.assignedCount > 0) {
        setTransfer({ user: u, mode: 'disable' });
        return;
      }
      const ok = await confirm({
        title: `停用「${u.name || u.email}」？`,
        message: '停用后对方立即退出登录，无法登录后台。可重新启用。',
        confirmText: '停用',
        danger: true,
      });
      if (!ok) return;
    }
    await setDisabled(u, disabling);
  };

  const makeResetLink = async (u) => {
    setBusyId(u.id);
    try {
      const res = await api.userResetLink(u.id);
      setResetLink({ user: u, url: res?.resetUrl || '' });
    } catch {
      // 已提示
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (u) => {
    const ok = await confirm({
      title: `删除「${u.name || u.email}」？`,
      message: `删除后对方立即退出登录，帐号无法恢复。已发送的人工消息仍保留。${
        u.assignedCount > 0 ? `其负责的 ${u.assignedCount} 个客户将变为未分配。` : ''
      }`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusyId(u.id);
    try {
      await api.deleteUser(u.id);
      setUsers((prev) => (prev || []).filter((x) => x.id !== u.id));
      toast.success('已删除');
    } catch {
      // 已提示
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(() => {
    if (!users) return null;
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        (!q || [u.name, u.email].some((v) => String(v || '').toLowerCase().includes(q))) &&
        (!roleFilter || u.role === roleFilter) &&
        (!statusFilter || statusKey(u) === statusFilter),
    );
  }, [users, search, roleFilter, statusFilter]);
  const filtering = !!(search.trim() || roleFilter || statusFilter);

  const columns = [
    {
      key: 'name',
      header: '姓名',
      sortValue: (u) => u.name || u.email || '',
      render: (u) => (
        <div className="members__person">
          <Avatar name={u.name || u.email} size="sm" />
          <div className="members__person-text">
            <div className="table__primary ellipsis">
              {u.name || '—'}
              {me?.id === u.id && <span className="members__self">（我）</span>}
            </div>
            <div className="table__secondary ellipsis members__email-sm">{u.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: '邮箱',
      hide: 'sm',
      sortValue: (u) => u.email || '',
      render: (u) => <div className="members__email ellipsis">{u.email}</div>,
    },
    {
      key: 'role',
      header: '角色',
      sortValue: (u) => roleLabel(u.role),
      render: (u) => <span className="nowrap">{roleLabel(u.role)}</span>,
    },
    {
      key: 'accounts',
      header: '负责号码',
      hide: 'md',
      render: (u) => <AccountNames user={u} accounts={accounts} />,
    },
    {
      key: 'assigned',
      header: '负责客户',
      align: 'num',
      hide: 'sm',
      sortValue: (u) => u.assignedCount ?? 0,
      render: (u) => <span className={u.assignedCount ? 'num' : 'num muted'}>{u.assignedCount ?? 0}</span>,
    },
    {
      key: 'status',
      header: '状态',
      sortValue: (u) => ['active', 'pending', 'disabled'].indexOf(statusKey(u)),
      render: (u) => {
        const st = userStatus(u);
        return <StatusDot tone={st.tone}>{st.label}</StatusDot>;
      },
    },
    {
      key: 'lastLogin',
      header: '最近登录',
      hide: 'sm',
      sortValue: (u) => u.lastLoginAt || null,
      render: (u) => <span className="muted nowrap">{u.lastLoginAt ? fmtTime(u.lastLoginAt) : '从未登录'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      shrink: true,
      render: (u) => {
        const self = me?.id === u.id;
        const busy = busyId === u.id;
        const transferItem = {
          label: '转交客户…',
          icon: ArrowRightLeft,
          disabled: !(u.assignedCount > 0),
          onClick: () => setTransfer({ user: u, mode: 'transfer' }),
        };
        return (
          <RowActions>
            {busy && (
              <span className="members__busy">
                <Spinner />
              </span>
            )}
            <Tooltip content="编辑">
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--sm"
                aria-label="编辑"
                onClick={() => setEditing(u)}
                disabled={busy}
              >
                <Pencil />
              </button>
            </Tooltip>
            <Tooltip content="生成重置密码链接">
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--sm"
                aria-label="生成重置密码链接"
                onClick={() => makeResetLink(u)}
                disabled={busy || u.disabled}
              >
                <KeyRound />
              </button>
            </Tooltip>
            {/* 自己的账号不提供停用和删除，免得把自己锁在外面 */}
            <MoreMenu
              disabled={busy}
              items={
                self
                  ? [transferItem]
                  : [
                      transferItem,
                      { label: u.disabled ? '启用' : '停用', icon: Power, onClick: () => toggleDisabled(u) },
                      'sep',
                      { label: '删除', icon: Trash2, danger: true, onClick: () => remove(u) },
                    ]
              }
            />
          </RowActions>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="成员"
        count={users ? users.length : null}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setInviting(true)}>
            <Plus /> 邀请成员
          </button>
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : (
        <>
          <TableToolbar
            search={search}
            onSearch={setSearch}
            searchPlaceholder="搜索姓名或邮箱"
            count={filtered ? filtered.length : null}
          >
            <Select
              size="sm"
              className="select--auto"
              value={roleFilter}
              onChange={setRoleFilter}
              options={ROLE_FILTERS}
              aria-label="按角色筛选"
            />
            <Select
              size="sm"
              className="select--auto"
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_FILTERS}
              aria-label="按状态筛选"
            />
          </TableToolbar>
          <DataTable
            label="成员"
            columns={columns}
            rows={filtered}
            onRowClick={setEditing}
            isRowActive={(u) => editing?.id === u.id}
            empty={
              filtering ? (
                <EmptyState compact title="无匹配的成员" />
              ) : (
                <EmptyState icon={Users} title="暂无成员" />
              )
            }
          />
        </>
      )}

      <InviteModal open={inviting} onClose={() => setInviting(false)} accounts={accounts} onInvited={upsert} />
      <EditDrawer
        user={editing}
        self={!!editing && editing.id === me?.id}
        onClose={() => setEditing(null)}
        accounts={accounts}
        onSaved={(u) => {
          upsert(u);
          setEditing(null);
        }}
      />
      <TransferModal
        target={transfer}
        users={users}
        onClose={() => setTransfer(null)}
        onTransferred={load}
        onDisable={(u) => setDisabled(u, true)}
      />
      <Modal
        open={!!resetLink}
        onClose={() => setResetLink(null)}
        title="重置密码链接"
        width={560}
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setResetLink(null)}>
            完成
          </button>
        }
      >
        {resetLink && (
          <div className="vstack members__stack">
            <p>
              发给 <span className="text-strong">{resetLink.user.name || resetLink.user.email}</span>，对方设置新密码后即可登录。
            </p>
            <LinkResult url={resetLink.url} note="链接 7 天内有效，仅可使用一次，请自行发送给对方。" />
          </div>
        )}
      </Modal>
    </div>
  );
}
