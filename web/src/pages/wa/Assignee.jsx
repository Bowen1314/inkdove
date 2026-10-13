import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Select } from '../../ui/Select.jsx';
import { Spinner } from '../../ui/common.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { canUseAccount, useAuth } from '../../lib/auth.jsx';
import { ASSIGN_SKIP, assignErrorText, assignReasonLabel } from '../../lib/labels.js';

// 按客户分配：会话列表的负责人标记、会话头部的负责人选择、批量分配栏、分配记录。
// 成员列表（GET /api/users）只有 admin 能读，由 ChatsTab 拉好传进来；agent 不用这些选择器。

const BULK_MAX = 500; // POST /api/wa/conversations/assign 一次最多 500 个

export const assigneeName = (a) => a?.name || a?.email || '已删除成员';

const byName = (a, b) => assigneeName(a).localeCompare(assigneeName(b), 'zh-CN');

/**
 * 负责人下拉的选项：不分配、我、其他启用中的成员（传了 accountId 就只列对这个号有权限的）。
 * current 不在里面（已停用、或是别的原因）时补在最后并置灰，免得下拉框显示成空白。
 */
export function assigneeOptions(users, me, { accountId, current } = {}) {
  const opts = [{ value: '', label: '不分配' }];
  if (me) opts.push({ value: me.id, label: `${assigneeName(me)}（我）` });
  (users || [])
    .filter((u) => u.id !== me?.id && !u.disabled && (!accountId || canUseAccount(u, accountId)))
    .sort(byName)
    .forEach((u) => opts.push({ value: u.id, label: assigneeName(u) }));
  if (current && !opts.some((o) => o.value === current.id)) {
    opts.push({
      value: current.id,
      label: current.disabled ? `${assigneeName(current)}（已停用）` : assigneeName(current),
      disabled: true,
    });
  }
  return opts;
}

/** 会话列表的筛选（admin）：全部 / 未分配 / 按成员。停用的成员也列出来，方便找到他名下还没转交的客户 */
export function assigneeFilterOptions(users, me) {
  const list = [...(users || [])].sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : byName(a, b)));
  return [
    { value: '', label: '全部负责人' },
    { value: 'none', label: '未分配' },
    ...list.map((u) => ({
      value: u.id,
      label: u.id === me?.id ? `${assigneeName(u)}（我）` : assigneeName(u),
      desc: u.disabled ? '已停用' : undefined,
    })),
  ];
}

/** 列表每行的负责人：未分配显示标签；负责人已停用用琥珀色标签写明 */
export function AssigneeMark({ assignee }) {
  if (!assignee) return <span className="tag conv__owner">未分配</span>;
  const name = assigneeName(assignee);
  if (assignee.disabled) {
    return (
      <span className="tag tag--warning conv__owner">
        <span className="sr-only">负责人</span>
        <span className="ellipsis">{name}</span> · 已停用
      </span>
    );
  }
  return (
    <span className="conv__owner">
      <UserRound aria-hidden="true" />
      <span className="sr-only">负责人</span>
      <span className="ellipsis">{name}</span>
    </span>
  );
}

/** 会话头部的负责人：admin 可以改（PUT /api/wa/conversations/:id/assignee），agent 只读 */
export function AssigneeSelect({ conv, users, onAssigned }) {
  const { user: me } = useAuth();
  const [busy, setBusy] = useState(false);
  const current = conv.assignee || null;
  const options = assigneeOptions(users, me, { accountId: conv.accountId, current });

  const change = async (value) => {
    setBusy(true);
    try {
      const res = await api.setConversationAssignee(conv.id, value || null, { silent: true });
      onAssigned(res);
      const name = value === me?.id ? '我' : options.find((o) => o.value === value)?.label || '';
      toast.success(value ? `已分配给 ${name}` : '已取消分配');
    } catch (e) {
      toast.error(assignErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-head__assignee">
      <span className="chat-head__assignee-label" aria-hidden="true">
        负责人
      </span>
      {busy && <Spinner className="muted" />}
      <Select
        size="sm"
        className="select--auto chat-head__assignee-select"
        value={current?.id || ''}
        onChange={change}
        options={options}
        disabled={busy}
        placement="bottom-end"
        aria-label="负责人"
      />
    </div>
  );
}

/** 批量分配结果：skipped 按原因汇总成一句 */
function bulkText(updated, skipped, toName) {
  const head = toName ? `已把 ${updated} 个会话分给 ${toName}` : `已取消分配 ${updated} 个会话`;
  if (!skipped.length) return head;
  const counts = new Map();
  skipped.forEach((s) => counts.set(s.code, (counts.get(s.code) || 0) + 1));
  const detail = [...counts].map(([code, n]) => `${n} 个${ASSIGN_SKIP[code] || code}`).join('、');
  return `${head}，跳过 ${skipped.length} 个（${detail}）`;
}

/**
 * 批量分配栏（admin）：列表进入多选后换掉列表头。
 * POST /api/wa/conversations/assign，超过 500 个分批发。完成后 onAssigned(改成功的 id, 新负责人或 null)。
 */
export function BulkAssignBar({ ids, allChecked, someChecked, onToggleAll, users, onCancel, onAssigned }) {
  const { user: me } = useAuth();
  const [target, setTarget] = useState(null); // null=还没选，''=不分配
  const [busy, setBusy] = useState(false);
  const options = assigneeOptions(users, me);

  useEffect(() => {
    if (!ids.length) setTarget(null);
  }, [ids.length]);

  const submit = async () => {
    if (target == null || !ids.length || busy) return;
    setBusy(true);
    const userId = target || null;
    const to = userId ? (users || []).find((u) => u.id === userId) || (me?.id === userId ? me : null) : null;
    const done = [];
    const skipped = [];
    let updated = 0;
    let failed = false;
    try {
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const chunk = ids.slice(i, i + BULK_MAX);
        const res = await api.assignConversations(chunk, userId, { silent: true });
        updated += res?.updated || 0;
        skipped.push(...(res?.skipped || []));
        done.push(...chunk);
      }
    } catch (e) {
      failed = true;
      toast.error(assignErrorText(e));
    }
    if (done.length) {
      const text = bulkText(updated, skipped, to ? assigneeName(to) : null);
      if (!failed) {
        if (skipped.length) toast.info(text, 6000);
        else toast.success(text);
      }
      const skippedIds = new Set(skipped.map((s) => s.id));
      onAssigned(
        done.filter((id) => !skippedIds.has(id)),
        to ? { id: to.id, name: to.name, email: to.email, disabled: false } : null,
      );
    }
    setBusy(false);
  };

  return (
    <div className="bulk-assign" role="toolbar" aria-label="批量分配">
      <div className="bulk-assign__row">
        <input
          type="checkbox"
          className="checkbox"
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = !allChecked && someChecked;
          }}
          onChange={onToggleAll}
          aria-label="全选"
        />
        <span className="text-strong num">已选 {ids.length} 个</span>
        <button type="button" className="btn btn--ghost btn--sm bulk-assign__cancel" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
      <div className="bulk-assign__row">
        <Select
          size="sm"
          className="bulk-assign__select"
          value={target}
          onChange={setTarget}
          options={options}
          placeholder="分配给…"
          disabled={busy || !ids.length}
          aria-label="分配给"
        />
        <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={busy || target == null || !ids.length}>
          {busy && <Spinner />}
          分配
        </button>
      </div>
    </div>
  );
}

function historyText(r) {
  const from = r.from ? assigneeName(r.from) : null;
  const to = r.to ? assigneeName(r.to) : null;
  if (to && from) return `从 ${from} 转给 ${to}`;
  if (to) return `分配给 ${to}`;
  return from ? `取消分配（原负责人 ${from}）` : '取消分配';
}

/** 客户信息栏里的分配记录（新到旧）：GET /api/wa/conversations/:id/assignments。负责人变了就重新拉 */
export function AssignmentHistory({ conv }) {
  const [list, setList] = useState(undefined); // undefined=加载中，null=加载失败
  const id = conv.id;
  const assigneeId = conv.assignee?.id || '';
  const assignedAt = conv.assignedAt || '';

  useEffect(() => {
    let alive = true;
    api
      .listAssignments(id, { silent: true })
      .then((res) => alive && setList(Array.isArray(res) ? res : []))
      .catch(() => alive && setList(null));
    return () => {
      alive = false;
    };
  }, [id, assigneeId, assignedAt]);

  return (
    <div className="info__section">
      <h3 className="info__title">分配记录</h3>
      {list === undefined ? (
        <>
          <span className="skeleton skeleton--text" style={{ width: '70%' }} />
          <span className="skeleton skeleton--text" style={{ width: '50%' }} />
        </>
      ) : list === null ? (
        <div className="muted">分配记录加载失败</div>
      ) : list.length === 0 ? (
        <div className="muted">还没有分配过</div>
      ) : (
        <ol className="assign-log">
          {list.map((r) => (
            <li key={r.id} className="assign-log__item">
              <div>{historyText(r)}</div>
              <div className="assign-log__meta">
                <span>{r.by ? assigneeName(r.by) : '系统'}</span>
                <span>{assignReasonLabel(r.reason)}</span>
                <TimeText iso={r.at} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 会话头部给业务员看的只读负责人 */
export function AssigneeText({ assignee }) {
  return (
    <span className="chat-head__owner">
      负责人 {assignee ? assigneeName(assignee) : '未分配'}
    </span>
  );
}
