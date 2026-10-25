import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FolderOpen, MoreHorizontal, Pencil, Power, PowerOff, RefreshCw, Save, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { HintIcon, Menu, Tooltip } from '../../ui/Popover.jsx';
import { Select } from '../../ui/Select.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { EmptyState, ErrorState, Field, Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { CellText, DataTable, RowActions, TableToolbar } from '../../ui/DataTable.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { fmtFull, fmtNum, fmtSize, parseTags } from '../../lib/format.js';
import {
  MAX_SENDABLE_BYTES,
  SENDABLE_ACCEPT,
  SENDABLE_FORMATS_TEXT,
  UPLOAD_BATCH,
  clearFileCache,
  fileErrorText,
  fileIcon,
  fileTypeLabel,
  isSendableFile,
} from '../../lib/files.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useWindowFileDrop } from '../../hooks/useWindowFileDrop.js';

// 规格（F15 前端）点名要求的页头说明，原文保留
const INTRO = '客户索取资料时，机器人从此处选择文件发送。描述越准确，选择越准确。';
const POLL_MS = 3000;

const STATUS = {
  active: { label: '启用', tone: 'success' },
  disabled: { label: '已停用', tone: 'neutral' },
};
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '启用中' },
  { value: 'disabled', label: '已停用' },
];

/** 名称下面那行：格式 · 大小 */
const typeLine = (f) => [fileTypeLabel(f), fmtSize(f.size)].filter(Boolean).join(' · ');

const sameTags = (a, b) => (a || []).join('\n') === (b || []).join('\n');

/** 列表里的描述：生成中 / 生成失败 / 待填写 / 描述正文 */
function DescCell({ file }) {
  if (file.descriptionStatus === 'pending') {
    return (
      <span className="files-page__desc-pending">
        <Spinner />
        生成中…
      </span>
    );
  }
  if (file.description) {
    return (
      <span className="files-page__desc ellipsis" title={file.description}>
        {file.description}
      </span>
    );
  }
  if (file.descriptionStatus === 'failed') return <StatusDot tone="danger">生成失败</StatusDot>;
  return <StatusDot tone="warning">待填写</StatusDot>;
}

/* ---------- 详情抽屉：admin 编辑名称、描述、标签、状态；agent 只读 ---------- */

function FileDrawer({ file, readOnly, onClose, onSaved, onDelete, onRegenerate, busy }) {
  const [form, setForm] = useState({ name: '', description: '', tags: '', status: 'active' });
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  // 打开时的原值：保存时只提交改过的字段（提交 description 会让描述记为手写）
  const base = useRef({ name: '', description: '', tags: [], status: 'active' });

  const id = file?.id;
  useEffect(() => {
    if (!file) return;
    base.current = { name: file.name, description: file.description || '', tags: file.tags || [], status: file.status };
    setForm({ name: file.name, description: file.description || '', tags: (file.tags || []).join('，'), status: file.status });
    setTouched(false);
    // 只在换了文件时重置；轮询刷新同一个文件不能冲掉正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 描述在后台生成完（或重新生成后）：用户没动过描述框就自动填进来
  const desc = file?.description || '';
  useEffect(() => {
    if (!file) return;
    const prev = base.current.description;
    if (desc === prev) return;
    base.current = { ...base.current, description: desc };
    setForm((f) => (f.description === prev ? { ...f, description: desc } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc]);

  if (!file) return <Drawer open={false} />;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const nameErr = touched && !form.name.trim() ? '请填写名称' : null;
  const pending = file.descriptionStatus === 'pending';
  const regenerating = busy === 'describe';
  const deleting = busy === 'delete';
  const Icon = fileIcon(file);

  const save = async () => {
    setTouched(true);
    if (!form.name.trim()) return;
    const patch = {};
    const b = base.current;
    if (form.name.trim() !== b.name) patch.name = form.name.trim();
    if (form.description.trim() !== b.description.trim()) patch.description = form.description.trim();
    const tags = parseTags(form.tags);
    if (!sameTags(tags, b.tags)) patch.tags = tags;
    if (form.status !== b.status) patch.status = form.status;
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateFile(file.id, patch);
      onSaved(res);
      toast.success('已保存');
      onClose();
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  const download = (
    <a className="btn" href={api.fileDownloadUrl(file.id)} download={file.filename}>
      <Download />
      下载
    </a>
  );

  const meta = (
    <dl className="kv">
      <dt>文件名</dt>
      <dd className="files-page__filename">
        <Icon className="files-page__type-icon" aria-hidden="true" />
        <span>{file.filename}</span>
      </dd>
      <dt>格式</dt>
      <dd>{fileTypeLabel(file)}</dd>
      <dt>大小</dt>
      <dd className="num">{fmtSize(file.size) || '—'}</dd>
      <dt>发送次数</dt>
      <dd className="num">{fmtNum(file.sendCount ?? 0)}</dd>
      <dt>最近发送</dt>
      <dd className="num">{file.lastSentAt ? fmtFull(file.lastSentAt) : '未发送'}</dd>
      <dt>知识库</dt>
      <dd>
        {file.kbSourceId ? (
          readOnly ? (
            '已加入知识库资料'
          ) : (
            <Link className="link" to="/files/sources">
              已加入知识库资料
            </Link>
          )
        ) : (
          '未加入'
        )}
      </dd>
      <dt>添加时间</dt>
      <dd className="num">{fmtFull(file.createdAt) || '—'}</dd>
    </dl>
  );

  if (readOnly) {
    const st = STATUS[file.status] || { label: file.status, tone: 'neutral' };
    return (
      <Drawer
        open
        onClose={onClose}
        title={file.name}
        footer={
          <>
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
            {download}
          </>
        }
      >
        <div className="files-page__detail vstack">
          <div className="field">
            <div className="field__label">描述</div>
            {pending ? (
              <span className="files-page__desc-pending">
                <Spinner />
                生成中…
              </span>
            ) : file.description ? (
              <div className="pre-wrap">{file.description}</div>
            ) : (
              <div className="muted">暂无描述</div>
            )}
          </div>
          {file.tags?.length > 0 && (
            <div className="field">
              <div className="field__label">标签</div>
              <div className="files-page__tags">
                {file.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <div className="field__label">状态</div>
            <StatusDot tone={st.tone}>{st.label}</StatusDot>
          </div>
          <div className="files-page__meta">{meta}</div>
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="编辑文件"
      footer={
        <>
          <button
            type="button"
            className="btn btn--danger files-page__foot-start"
            onClick={() => onDelete(file)}
            disabled={deleting || saving}
          >
            {deleting ? <Spinner /> : <Trash2 />}
            删除
          </button>
          {download}
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
      <form
        className="files-page__detail vstack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="名称" htmlFor="sf-name" error={nameErr}>
          <input
            {...fieldProps('sf-name', nameErr)}
            className="input"
            value={form.name}
            maxLength={200}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field
          label="描述"
          htmlFor="sf-desc"
          hint="说明文件内容及适用场景，例如：2026 全系列产品目录，含 A/B/C 系列型号、规格和图片。"
          aside={
            pending ? (
              <span className="files-page__desc-pending">
                <Spinner />
                生成中…
              </span>
            ) : (
              <button
                type="button"
                className="btn btn--link btn--sm"
                onClick={() => onRegenerate(file)}
                disabled={regenerating || saving}
              >
                {regenerating ? <Spinner /> : <Sparkles />}
                重新生成
              </button>
            )
          }
        >
          <textarea
            id="sf-desc"
            className="textarea"
            rows={6}
            maxLength={2000}
            value={form.description}
            placeholder={pending ? '自动生成中，完成后自动填入；也可手动填写' : '暂无描述'}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <Field label="标签" htmlFor="sf-tags" hint="以逗号分隔，用于搜索，例如：目录，价格，A 系列">
          <input id="sf-tags" className="input" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
        </Field>
        <div className="files-page__switch">
          <div className="files-page__switch-text">
            <div className="field__label">状态</div>
            <div className="field__hint">
              {form.status === 'active' ? '启用：机器人可发送给客户' : '停用：机器人不发送，会话中也无法手动发送'}
            </div>
          </div>
          <Switch
            checked={form.status === 'active'}
            onChange={(on) => set('status', on ? 'active' : 'disabled')}
            label="启用文件"
          />
        </div>
        <div className="files-page__meta">{meta}</div>
      </form>
    </Drawer>
  );
}

/* ---------- 主体 ---------- */

/**
 * 文件页「产品资料（可发送）」标签（F15）。
 * admin：上传（按钮或拖到页面任意位置）、编辑、停用启用、重新生成描述、删除；agent 只能浏览和下载。
 * header(actions)：页头由 Files.jsx 给，这里把"上传文件"放进去。onChanged：勾了"同时加入知识库"时刷新资料数。
 */
export default function SendableTab({ header, onChanged }) {
  const { isAdmin } = useAuth();
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(null); // 文件名数组
  const [addToKb, setAddToKb] = useState(true);
  const [openId, setOpenId] = useState(null); // 抽屉里的文件 id（文件对象跟着列表刷新）
  const [busy, setBusy] = useState(null); // {id, action: 'describe'|'status'|'delete'}
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setFiles((await api.listFiles({}, { silent: true })) || []);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 有描述在生成时轮询，生成完自动停
  const hasPending = !!files?.some((f) => f.descriptionStatus === 'pending');
  usePolling(
    async () => {
      const list = await api.listFiles({}, { silent: true });
      if (list) setFiles(list);
    },
    POLL_MS,
    hasPending,
  );

  const replaceFile = (f) => {
    if (!f?.id) return;
    setFiles((prev) => (prev || []).map((x) => (x.id === f.id ? f : x)));
    clearFileCache();
  };

  const handleFiles = async (fileList) => {
    const all = Array.from(fileList || []);
    if (!all.length || uploading || !isAdmin) return;
    const names = (arr) => arr.map((f) => f.name).join('、');
    const bad = all.filter((f) => !isSendableFile(f));
    const big = all.filter((f) => isSendableFile(f) && f.size > MAX_SENDABLE_BYTES);
    const ok = all.filter((f) => isSendableFile(f) && f.size <= MAX_SENDABLE_BYTES);
    // 后端遇到一个不支持的格式会整批拒收，所以先在前端挑出来
    if (bad.length) toast.error(`${names(bad)} 格式不支持。${SENDABLE_FORMATS_TEXT}`);
    if (big.length) toast.error(`${names(big)} 超过 50MB，无法上传`);
    if (!ok.length) {
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(ok.map((f) => f.name));
    const added = [];
    try {
      // 后端一次最多收 20 个，分批传
      for (let i = 0; i < ok.length; i += UPLOAD_BATCH) {
        // eslint-disable-next-line no-await-in-loop
        const res = await api.uploadFiles(ok.slice(i, i + UPLOAD_BATCH), { addToKb }, { silent: true });
        added.push(...(res || []));
      }
    } catch (e) {
      toast.error(added.length ? `已上传 ${added.length} 个，其余上传失败：${fileErrorText(e)}` : fileErrorText(e));
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
    if (!added.length) return;
    const ids = new Set(added.map((f) => f.id));
    setFiles((prev) => [...added, ...(prev || []).filter((f) => !ids.has(f.id))]);
    clearFileCache();
    const toKb = added.filter((f) => f.kbSourceId).length;
    if (added.length === ok.length) {
      toast.success(`已上传 ${added.length} 个文件${toKb ? `，其中 ${toKb} 个已加入知识库资料` : ''}`);
    }
    if (toKb) onChanged?.();
  };

  // 对话框、抽屉开着或正在上传时，不接拖进来的文件；agent 不能上传
  const dragging = useWindowFileDrop(isAdmin && !uploading && !openId, handleFiles);

  const regenerate = async (f) => {
    if (f.descriptionStatus === 'manual' && f.description) {
      const ok = await confirm({
        title: '重新生成描述？',
        message: '将根据文件内容重新生成，并替换当前手动填写的描述。',
        confirmText: '重新生成',
      });
      if (!ok) return;
    }
    setBusy({ id: f.id, action: 'describe' });
    try {
      replaceFile(await api.describeFile(f.id, { silent: true }));
    } catch (e) {
      toast.error(fileErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleStatus = async (f) => {
    const next = f.status === 'active' ? 'disabled' : 'active';
    setBusy({ id: f.id, action: 'status' });
    try {
      replaceFile(await api.updateFile(f.id, { status: next }));
      toast.success(next === 'active' ? '已启用' : '已停用');
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const remove = async (f) => {
    const ok = await confirm({
      title: `删除文件「${f.name}」？`,
      message: `删除后机器人不再发送该文件，会话中已发送的文件也无法下载。${
        f.kbSourceId ? '已加入知识库的资料保留。' : ''
      }`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusy({ id: f.id, action: 'delete' });
    try {
      await api.deleteFile(f.id);
      setFiles((prev) => (prev || []).filter((x) => x.id !== f.id));
      clearFileCache();
      if (openId === f.id) setOpenId(null);
      toast.success('已删除');
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const filtered = useMemo(() => {
    if (!files) return null;
    const kw = q.trim().toLowerCase();
    return files.filter((f) => {
      if (status && f.status !== status) return false;
      if (!kw) return true;
      return [f.name, f.filename, f.description, ...(f.tags || [])].some((s) => String(s || '').toLowerCase().includes(kw));
    });
  }, [files, q, status]);

  const busyOf = (f) => (busy?.id === f.id ? busy.action : null);

  const columns = [
    {
      key: 'name',
      header: '名称',
      sortValue: (f) => f.name || '',
      render: (f) => {
        const Icon = fileIcon(f);
        return (
          <div className="files-page__name">
            <Icon className="files-page__type-icon" aria-hidden="true" />
            <CellText primary={<span title={f.filename}>{f.name || f.filename}</span>} secondary={typeLine(f)} />
          </div>
        );
      },
    },
    {
      key: 'description',
      header: '描述',
      fluid: true,
      hide: 'sm',
      render: (f) => <DescCell file={f} />,
    },
    {
      key: 'status',
      header: '状态',
      shrink: true,
      sortValue: (f) => f.status,
      render: (f) => {
        const st = STATUS[f.status] || { label: f.status, tone: 'neutral' };
        return <StatusDot tone={st.tone}>{st.label}</StatusDot>;
      },
    },
    {
      key: 'sendCount',
      header: '发送次数',
      align: 'num',
      hide: 'md',
      sortValue: (f) => f.sendCount ?? 0,
      render: (f) => fmtNum(f.sendCount ?? 0),
    },
    {
      key: 'lastSentAt',
      header: '最近发送',
      shrink: true,
      hide: 'md',
      sortValue: (f) => f.lastSentAt || null,
      render: (f) => <TimeText iso={f.lastSentAt} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      shrink: true,
      hide: 'sm', // 手机上点行打开抽屉，抽屉里有下载和其他操作
      render: (f) => {
        const b = busyOf(f);
        return (
          <RowActions>
            <Tooltip content="下载">
              <a
                className="btn btn--ghost btn--icon btn--sm"
                href={api.fileDownloadUrl(f.id)}
                download={f.filename}
                aria-label={`下载 ${f.filename}`}
              >
                <Download />
              </a>
            </Tooltip>
            {isAdmin && (
              <Menu
                tooltip="更多操作"
                minWidth={160}
                items={[
                  { label: '编辑', icon: Pencil, onClick: () => setOpenId(f.id) },
                  {
                    label: '重新生成描述',
                    icon: RefreshCw,
                    disabled: f.descriptionStatus === 'pending',
                    onClick: () => regenerate(f),
                  },
                  f.status === 'active'
                    ? { label: '停用', icon: PowerOff, onClick: () => toggleStatus(f) }
                    : { label: '启用', icon: Power, onClick: () => toggleStatus(f) },
                  'sep',
                  { label: '删除', icon: Trash2, danger: true, onClick: () => remove(f) },
                ]}
                trigger={
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="更多操作" disabled={!!b}>
                    {b ? <Spinner /> : <MoreHorizontal />}
                  </button>
                }
              />
            )}
          </RowActions>
        );
      },
    },
  ];

  const pickFiles = () => fileRef.current?.click();
  const uploadButton = (
    <button type="button" className="btn btn--primary" onClick={pickFiles} disabled={!!uploading}>
      {uploading ? <Spinner /> : <Upload />}
      上传文件
    </button>
  );

  const total = files?.length ?? 0;
  const openFile = openId ? files?.find((f) => f.id === openId) || null : null;

  return (
    <div className="page">
      {header(isAdmin ? uploadButton : null)}
      {isAdmin && (
        <input ref={fileRef} type="file" multiple accept={SENDABLE_ACCEPT} hidden onChange={(e) => handleFiles(e.target.files)} />
      )}

      <div className="files-page__body">
        <div className="files-page__intro">
          <p className="files-page__intro-text">{INTRO}</p>
          {isAdmin && (
            <div className="files-page__kb-opt">
              <label className="choice">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={addToKb}
                  disabled={!!uploading}
                  onChange={(e) => setAddToKb(e.target.checked)}
                />
                <span>同时加入知识库</span>
              </label>
              <HintIcon label="同时加入知识库的说明">
                上传时同时将文件内容存入「知识库资料」，供机器人回答问题。图片除外。
              </HintIcon>
            </div>
          )}
        </div>

        <TableToolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="搜索名称、描述或标签"
          count={filtered ? filtered.length : undefined}
          end={
            uploading && (
              <span className="files-page__uploading" title={uploading.join('、')}>
                <Spinner />
                正在上传 {uploading.length} 个文件…
              </span>
            )
          }
        >
          <Select size="sm" className="select--auto" value={status} onChange={setStatus} options={STATUS_OPTIONS} aria-label="状态" />
        </TableToolbar>

        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : (
          <div className="files-page__sendable">
            <DataTable
              label="产品资料"
              columns={columns}
              rows={filtered}
              rowKey={(f) => f.id}
              onRowClick={(f) => setOpenId(f.id)}
              isRowActive={(f) => openId === f.id}
              empty={
                total === 0 ? (
                  <EmptyState
                    icon={FolderOpen}
                    title="暂无可发送的文件"
                    desc={
                      isAdmin
                        ? `适用于产品目录、价目表、规格书、产品图片等。${SENDABLE_FORMATS_TEXT}，支持拖拽上传。`
                        : '管理员上传后显示于此。'
                    }
                    action={isAdmin && uploadButton}
                  />
                ) : (
                  <EmptyState compact title="无匹配的文件" />
                )
              }
            />
          </div>
        )}

        {dragging && (
          <div className="drop-overlay files-page__drop" aria-hidden="true">
            <div className="files-page__drop-text">
              松开上传
              <span className="files-page__drop-hint">
                {SENDABLE_FORMATS_TEXT}
                {addToKb ? '，同时加入知识库' : ''}
              </span>
            </div>
          </div>
        )}
      </div>

      <FileDrawer
        file={openFile}
        readOnly={!isAdmin}
        onClose={() => setOpenId(null)}
        onSaved={replaceFile}
        onDelete={remove}
        onRegenerate={regenerate}
        busy={openFile ? busyOf(openFile) : null}
      />
    </div>
  );
}
