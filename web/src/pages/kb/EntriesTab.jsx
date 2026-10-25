import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Building2, FileText, Pencil, Plus, Save, Search, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { Select } from '../../ui/Select.jsx';
import { DataTable, CellText, TableToolbar } from '../../ui/DataTable.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { EmptyState, ErrorState, Field, Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { EntryPeek } from '../../ui/EntryRefs.jsx';
import { clearEntryCache } from '../../lib/entryCache.js';
import { ENTRY_ORIGIN, ENTRY_STATUS, ENTRY_TYPES, entryTypeLabel } from '../../lib/labels.js';
import { fmtTime, parseTags } from '../../lib/format.js';
import { DistillBar, useDistillActions } from './DistillBar.jsx';
import {
  SourceDropOverlay,
  SourceUploadButton,
  SourceUploadDialogs,
  SourceUploading,
  useSourceUpload,
} from '../files/SourceUpload.jsx';

/* ---------- 企业画像（标签「企业画像」） ---------- */

const PROFILE_FIELDS = [
  { key: 'companyName', label: '公司名称', placeholder: '例如：深圳某某电子有限公司' },
  { key: 'summary', label: '公司简介', multiline: true, placeholder: '一两句话概述主营业务' },
  { key: 'offerings', label: '产品与服务', multiline: true, placeholder: '主要产品、服务范围' },
  { key: 'contact', label: '联系方式', multiline: true, placeholder: '电话、邮箱、地址等' },
  { key: 'hours', label: '营业时间', placeholder: '例如：周一至周六 9:00–18:00（北京时间）' },
  { key: 'languages', label: '服务语言', placeholder: '例如：中文、英文、西班牙语' },
  { key: 'other', label: '其他说明', multiline: true, placeholder: '机器人需了解的其他信息' },
];

/** 左边标签、右边值；点"编辑"后就地变成表单，改动后出现保存栏。readOnly（业务员）没有编辑入口。 */
export function ProfileTab({ readOnly }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null); // null = 查看中
  const [saving, setSaving] = useState(false);
  const editing = draft != null;

  const load = useCallback(async () => {
    setError(null);
    try {
      setProfile((await api.getProfile({ silent: true })) || {});
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = () => {
    const d = {};
    PROFILE_FIELDS.forEach((f) => {
      d[f.key] = profile?.[f.key] || '';
    });
    setDraft(d);
  };

  const changed = () => {
    const patch = {};
    if (!draft) return patch;
    PROFILE_FIELDS.forEach((f) => {
      if ((draft[f.key] || '') !== (profile?.[f.key] || '')) patch[f.key] = draft[f.key];
    });
    return patch;
  };
  const dirty = editing && Object.keys(changed()).length > 0;

  const save = async () => {
    const patch = changed();
    if (!Object.keys(patch).length) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      const res = await api.putProfile(patch);
      setProfile(res && typeof res === 'object' && 'companyName' in res ? res : { ...profile, ...patch });
      setDraft(null);
      toast.success('已保存');
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="page-body page-body--form">
        <ErrorState error={error} onRetry={load} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="page-body page-body--form" aria-busy="true" aria-label="加载中">
        <span className="skeleton" style={{ width: 120, height: 20 }} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="settings-row">
            <span className="skeleton skeleton--text" style={{ width: '50%' }} />
            <span className="skeleton skeleton--text" style={{ width: `${50 + i * 10}%` }} />
          </div>
        ))}
      </div>
    );
  }

  const filled = PROFILE_FIELDS.filter((f) => profile[f.key]).length;

  return (
    <div className={`page-body page-body--form kb-profile${editing ? '' : ' kb-profile--view'}`}>
      <SettingsSection
        as={editing ? 'form' : 'section'}
        onSubmit={
          editing
            ? (e) => {
                e.preventDefault();
                save();
              }
            : undefined
        }
        title="企业画像"
        desc={profile.updatedAt ? `更新于 ${fmtTime(profile.updatedAt)}` : null}
        actions={
          !readOnly &&
          (editing ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft(null)} disabled={saving}>
              取消
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={startEdit}>
              <Pencil />
              编辑
            </button>
          ))
        }
      >
        {!editing && filled === 0 ? (
          <EmptyState
            compact
            icon={Building2}
            title="暂无企业画像"
            desc={readOnly ? null : '蒸馏知识库时自动生成，也可点击「编辑」手动填写。'}
          />
        ) : (
          PROFILE_FIELDS.map((f) => (
            <SettingsRow key={f.key} label={f.label} htmlFor={editing ? `pf-${f.key}` : undefined}>
              {editing ? (
                f.multiline ? (
                  <textarea
                    id={`pf-${f.key}`}
                    className="textarea"
                    rows={3}
                    value={draft[f.key]}
                    placeholder={f.placeholder}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    id={`pf-${f.key}`}
                    className="input"
                    value={draft[f.key]}
                    placeholder={f.placeholder}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                )
              ) : profile[f.key] ? (
                <div className="pre-wrap">{profile[f.key]}</div>
              ) : (
                <span className="muted">未填写</span>
              )}
            </SettingsRow>
          ))
        )}
        {editing && <SaveBar dirty={dirty} saving={saving} onDiscard={() => setDraft(null)} />}
      </SettingsSection>
    </div>
  );
}

/* ---------- 条目编辑抽屉（480） ---------- */

const EMPTY_ENTRY = { type: 'faq', title: '', content: '', tags: [], status: 'active' };

function EntryDrawer({ entry, onClose, onSaved, onDeleted }) {
  const confirm = useConfirm();
  const isNew = !entry?.id;
  const [form, setForm] = useState(EMPTY_ENTRY);
  const [tagText, setTagText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setForm({
      type: entry.type || 'faq',
      title: entry.title || '',
      content: entry.content || '',
      status: entry.status || 'active',
    });
    setTagText((entry.tags || []).join('，'));
    setTouched(false);
  }, [entry]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const titleErr = touched && !form.title.trim() ? '请填写标题' : null;
  const contentErr = touched && !form.content.trim() ? '请填写内容' : null;

  const save = async () => {
    setTouched(true);
    if (!form.title.trim() || !form.content.trim()) return;
    const payload = {
      type: form.type,
      title: form.title.trim(),
      content: form.content.trim(),
      tags: parseTags(tagText),
      status: form.status,
    };
    setSaving(true);
    try {
      const res = isNew ? await api.createEntry(payload) : await api.updateEntry(entry.id, payload);
      onSaved(res && res.id ? res : { ...entry, ...payload }, isNew);
      toast.success(isNew ? '条目已添加' : '条目已保存');
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `删除条目「${entry.title}」？`,
      message: '删除后机器人不再使用该条目，且无法恢复。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.deleteEntry(entry.id);
      onDeleted(entry.id);
      toast.success('条目已删除');
    } catch {
      // 已提示
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Drawer
      open={!!entry}
      onClose={onClose}
      title={isNew ? '新增知识条目' : '编辑知识条目'}
      footer={
        <>
          {!isNew && (
            <button type="button" className="btn btn--danger" style={{ marginRight: 'auto' }} onClick={remove} disabled={deleting || saving}>
              {deleting ? <Spinner /> : <Trash2 />}
              删除
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={saving || deleting}>
            {saving ? <Spinner /> : <Save />}
            保存
          </button>
        </>
      }
    >
      {entry && (
        <form
          className="kb-entry"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="类型" htmlFor="en-type">
            <Select id="en-type" value={form.type} onChange={(v) => set('type', v)} options={ENTRY_TYPES} />
          </Field>
          <Field label="标题" htmlFor="en-title" error={titleErr}>
            <input
              {...fieldProps('en-title', titleErr)}
              className="input"
              value={form.title}
              placeholder={form.type === 'faq' ? '以客户提问的形式填写，例如：最低起订量是多少？' : '例如：A100 型号蓝牙耳机'}
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>
          <Field label="内容" htmlFor="en-content" error={contentErr} hint="内容需完整、可独立理解，保留具体数字、型号、价格和条件。">
            <textarea
              {...fieldProps('en-content', contentErr)}
              className="textarea"
              rows={8}
              value={form.content}
              onChange={(e) => set('content', e.target.value)}
            />
          </Field>
          <Field label="标签" htmlFor="en-tags" hint="以逗号分隔，用于搜索，例如：价格，批发，耳机">
            <input id="en-tags" className="input" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </Field>
          <div className="kb-entry__switch">
            <div className="kb-entry__switch-text">
              <div className="field__label">状态</div>
              <div className="field__hint">{form.status === 'active' ? '启用：机器人使用该条目' : '停用：机器人不使用该条目'}</div>
            </div>
            <Switch checked={form.status === 'active'} onChange={(on) => set('status', on ? 'active' : 'disabled')} label="启用条目" />
          </div>

          {!isNew && (
            <div className="kb-entry__meta">
              <div className="muted text-sm">
                {ENTRY_ORIGIN[entry.origin] || entry.origin} · 创建于 {fmtTime(entry.createdAt)} · 更新于 {fmtTime(entry.updatedAt)}
              </div>
              <h3 className="peek__refs-title">来源引用</h3>
              {entry.sourceRefs?.length > 0 ? (
                entry.sourceRefs.map((r, i) => (
                  <div key={i} className="peek__ref">
                    <div className="hstack text-strong">
                      <FileText size={14} className="muted" aria-hidden="true" /> {r.sourceName || '未知资料'}
                    </div>
                    {r.quote && <blockquote className="peek__quote">{r.quote}</blockquote>}
                  </div>
                ))
              ) : (
                <div className="muted text-sm">该条目无关联资料。</div>
              )}
            </div>
          )}
        </form>
      )}
    </Drawer>
  );
}

/* ---------- 条目列表 ---------- */

const TYPE_OPTIONS = [{ value: '', label: '全部类型' }, ...ENTRY_TYPES];
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '启用中' },
  { value: 'disabled', label: '已停用' },
];
const BULK_DONE = { enable: '已启用', disable: '已停用', delete: '已删除' };
const NO_SOURCES = []; // 业务员不拉资料列表

/**
 * readOnly：业务员只能浏览，点行是只读查看，没有新建、编辑、删除、批量操作，也不能上传资料。
 * actionsSlot：页面头部右侧的位置，"上传文件"和"新建条目"放在那里。
 * 管理员可以直接上传资料（存到「文件 → 知识库资料」）。传完不自动整理（整理要调模型），
 * 有新资料还没整理时表格上方出现整理状态条，平时不显示。
 */
export default function EntriesTab({ onChanged, readOnly = false, actionsSlot }) {
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const editParam = params.get('edit');

  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [peekId, setPeekId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState(null);
  const reqRef = useRef(0);
  const query = q.trim();

  const distill = useDistillActions(readOnly ? NO_SOURCES : undefined);
  // 条目抽屉开着时也不接拖进来的文件；业务员不接
  const upload = useSourceUpload({
    onAdded: distill.reload,
    dropEnabled: !readOnly && !editing && !peekId,
    elsewhere: true,
  });

  const load = useCallback(async () => {
    const my = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listEntries({ q: query, type, status }, { silent: true });
      if (my === reqRef.current) setEntries(list || []);
    } catch (e) {
      if (my === reqRef.current) setError(e);
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, [query, type, status]);

  useEffect(() => {
    load();
  }, [load]);

  // 列表变了，去掉已经不在列表里的选中项
  useEffect(() => {
    if (!entries) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(entries.map((e) => e.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const clearFilters = () => {
    setQ('');
    setType('');
    setStatus('');
  };

  // 从其他页面跳来编辑指定条目（?edit=<id>）
  useEffect(() => {
    if (!editParam || !entries) return;
    const found = entries.find((e) => e.id === editParam);
    if (found) {
      if (readOnly) setPeekId(found.id);
      else setEditing(found);
    } else if (!query && !type && !status) toast.info('条目不存在，可能已被删除');
    else {
      clearFilters();
      return;
    }
    const next = new URLSearchParams(params);
    next.delete('edit');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam, entries]);

  const onSaved = (saved, isNew) => {
    setEntries((prev) => {
      const list = prev || [];
      return isNew ? [saved, ...list] : list.map((e) => (e.id === saved.id ? saved : e));
    });
    setEditing(null);
    clearEntryCache();
    onChanged?.();
  };

  const onDeleted = (id) => {
    setEntries((prev) => (prev || []).filter((e) => e.id !== id));
    setEditing(null);
    clearEntryCache();
    onChanged?.();
  };

  // 批量：前端逐条调用单条接口
  const runBulk = async (kind) => {
    const list = (entries || []).filter((e) => selected.has(e.id));
    if (!list.length) return;
    if (kind === 'delete') {
      const ok = await confirm({
        title: `删除选中的 ${list.length} 个条目？`,
        message: '删除后机器人不再使用这些条目，且无法恢复。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
    }
    setBulk(kind);
    let done = 0;
    for (const e of list) {
      try {
        if (kind === 'delete') await api.deleteEntry(e.id);
        else {
          const want = kind === 'enable' ? 'active' : 'disabled';
          if (e.status !== want) await api.updateEntry(e.id, { status: want });
        }
        done += 1;
      } catch {
        // 单条失败已提示，继续下一条
      }
    }
    setBulk(null);
    if (done) toast.success(`${BULK_DONE[kind]} ${done} 个条目`);
    setSelected(new Set());
    clearEntryCache();
    onChanged?.();
    load();
  };

  const openRow = (e) => (readOnly ? setPeekId(e.id) : setEditing(e));
  const filtering = !!(query || type || status);

  const columns = useMemo(
    () => [
      {
        key: 'title',
        header: '标题',
        fluid: true,
        sortValue: (e) => e.title,
        render: (e) => <CellText primary={e.title} secondary={String(e.content || '').replace(/\s+/g, ' ')} />,
      },
      {
        key: 'type',
        header: '类型',
        shrink: true,
        hide: 'md',
        sortValue: (e) => entryTypeLabel(e.type),
        render: (e) => <span className="tag">{entryTypeLabel(e.type)}</span>,
      },
      {
        key: 'status',
        header: '状态',
        shrink: true,
        sortValue: (e) => e.status,
        render: (e) => {
          const st = ENTRY_STATUS[e.status] || { label: e.status, tone: 'gray' };
          return <StatusDot tone={st.tone}>{st.label}</StatusDot>;
        },
      },
      {
        key: 'sources',
        header: '来源数',
        align: 'num',
        shrink: true,
        hide: 'sm',
        sortValue: (e) => e.sourceRefs?.length || 0,
        render: (e) => e.sourceRefs?.length || 0,
      },
      {
        key: 'updatedAt',
        header: '更新时间',
        shrink: true,
        hide: 'sm',
        sortValue: (e) => e.updatedAt || '',
        render: (e) => <TimeText iso={e.updatedAt} />,
      },
    ],
    [],
  );

  const emptyNode = filtering ? (
    <EmptyState
      icon={Search}
      title="无符合条件的条目"
      desc="请更换关键词或清除筛选条件。"
      action={
        <button type="button" className="btn" onClick={clearFilters}>
          清除筛选
        </button>
      }
    />
  ) : (
    <EmptyState
      icon={FileText}
      title="知识库暂无条目"
      desc={readOnly ? '管理员蒸馏知识库后，此处显示机器人回复所依据的条目。' : '上传资料并蒸馏后自动生成条目，也可手动新建。'}
      action={
        !readOnly && (
          <div className="hstack">
            <SourceUploadButton upload={upload} primary label="上传资料" />
            <button type="button" className="btn" onClick={() => setEditing({ ...EMPTY_ENTRY })}>
              <Plus />
              新建条目
            </button>
          </div>
        )
      }
    />
  );

  return (
    <>
      {!readOnly &&
        actionsSlot &&
        createPortal(
          <>
            <SourceUploadButton upload={upload} compact />
            <button type="button" className="btn btn--primary" onClick={() => setEditing({ ...EMPTY_ENTRY })}>
              <Plus />
              新建条目
            </button>
          </>,
          actionsSlot,
        )}

      {!readOnly && distill.pending > 0 && <DistillBar sources={distill.sources} showSourcesLink />}

      <TableToolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="搜索标题、内容或标签"
        count={entries ? entries.length : null}
        end={
          upload.uploading ? (
            <SourceUploading names={upload.uploading} />
          ) : loading && entries ? (
            <Spinner className="muted" />
          ) : null
        }
        selection={
          readOnly
            ? null
            : {
                count: selected.size,
                onClear: () => setSelected(new Set()),
                actions: (
                  <>
                    <button type="button" className="btn btn--sm" onClick={() => runBulk('enable')} disabled={!!bulk}>
                      {bulk === 'enable' && <Spinner />}
                      启用
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => runBulk('disable')} disabled={!!bulk}>
                      {bulk === 'disable' && <Spinner />}
                      停用
                    </button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => runBulk('delete')} disabled={!!bulk}>
                      {bulk === 'delete' ? <Spinner /> : <Trash2 />}
                      删除
                    </button>
                  </>
                ),
              }
        }
      >
        <Select size="sm" className="select--auto" value={type} onChange={setType} options={TYPE_OPTIONS} aria-label="类型筛选" />
        <Select size="sm" className="select--auto" value={status} onChange={setStatus} options={STATUS_OPTIONS} aria-label="状态筛选" />
      </TableToolbar>

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : (
        <DataTable
          label="知识条目"
          columns={columns}
          rows={entries}
          onRowClick={openRow}
          isRowActive={(e) => editing?.id === e.id}
          selectable={!readOnly}
          selected={selected}
          onSelectedChange={setSelected}
          empty={emptyNode}
        />
      )}

      {upload.dragging && <SourceDropOverlay />}

      {!readOnly && <EntryDrawer entry={editing} onClose={() => setEditing(null)} onSaved={onSaved} onDeleted={onDeleted} />}
      {!readOnly && <SourceUploadDialogs upload={upload} />}
      {readOnly && <EntryPeek entryId={peekId} onClose={() => setPeekId(null)} />}
    </>
  );
}
