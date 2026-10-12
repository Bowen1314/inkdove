import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, MoreHorizontal, Pencil, Plus, Power, Save, Trash2, UserPlus, Users } from 'lucide-react';
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
import { ROLES, roleLabel, userStatus } from '../lib/labels.js';
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
    name: !form.name.trim() ? '请填写名字' : '',
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
          <LinkResult url={inviteUrl} note="链接 7 天内有效，请自己发给对方。对方打开后设置密码，就能登录。" />
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
            <Field label="名字" htmlFor="inv-name2" error={show('name')}>
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
            <Field label="负责的号" hint="业务员只能看到和处理这些号的会话。之后也可以再改。">
              <AccountPicker accounts={accounts} value={form.accountIds} onChange={(v) => set('accountIds', v)} />
            </Field>
          )}
          <div className="field__hint">系统不会发邮件。生成链接后，请自己发给对方。</div>
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
  const nameErr = user && !form.name.trim() ? '请填写名字' : '';

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
          <Field label="名字" htmlFor="ed-name" error={nameErr}>
            <input
              {...fieldProps('ed-name', nameErr)}
              className="input"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          {self ? (
            <Field label="角色" hint="不能修改自己的角色。需要的话请另一位管理员来改。">
              <div className="members__readonly">{roleLabel(form.role)}</div>
            </Field>
          ) : (
            <Field label="角色">
              <RolePicker value={form.role} onChange={(v) => set('role', v)} idPrefix="ed" />
            </Field>
          )}
          {!self && form.role === 'agent' && (
            <Field label="负责的号">
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

  const toggleDisabled = async (u) => {
    const disabling = !u.disabled;
    if (disabling) {
      const ok = await confirm({
        title: `停用「${u.name || u.email}」？`,
        message: '停用后对方立即退出登录，不能再登录后台。之后可以重新启用。',
        confirmText: '停用',
        danger: true,
      });
      if (!ok) return;
    }
    setBusyId(u.id);
    try {
      const res = await api.updateUser(u.id, { disabled: disabling });
      upsert(res && res.id ? res : { ...u, disabled: disabling });
      toast.success(disabling ? '已停用' : '已启用');
    } catch {
      // 已提示（last_admin 等）
    } finally {
      setBusyId(null);
    }
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
      message: '删除后对方立即退出登录，账号不能恢复。对方发过的人工消息仍会保留。',
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
      header: '名字',
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
      header: '负责的号',
      hide: 'md',
      render: (u) => <AccountNames user={u} accounts={accounts} />,
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
            {!self && (
              <MoreMenu
                disabled={busy}
                items={[
                  { label: u.disabled ? '启用' : '停用', icon: Power, onClick: () => toggleDisabled(u) },
                  'sep',
                  { label: '删除', icon: Trash2, danger: true, onClick: () => remove(u) },
                ]}
              />
            )}
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
            searchPlaceholder="搜索名字或邮箱"
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
                <EmptyState compact title="没有匹配的成员" />
              ) : (
                <EmptyState icon={Users} title="还没有成员" />
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
              发给 <span className="text-strong">{resetLink.user.name || resetLink.user.email}</span>，对方打开后设置新密码就能登录。
            </p>
            <LinkResult url={resetLink.url} note="链接 7 天内有效，只能用一次，请自己发给对方。" />
          </div>
        )}
      </Modal>
    </div>
  );
}
