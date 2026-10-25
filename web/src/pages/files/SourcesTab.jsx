import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, FileCode, FileSpreadsheet, FileText, Globe, Trash2, Type, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { Select } from '../../ui/Select.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { Callout, EmptyState, ErrorState, Spinner } from '../../ui/common.jsx';
import { CellText, DataTable, RowActions, TableToolbar } from '../../ui/DataTable.jsx';
import { SOURCE_KIND, SOURCE_STATUS } from '../../lib/labels.js';
import { fmtChars, fmtDay, fmtHm, fmtSize, fmtTime } from '../../lib/format.js';
import { DistillBar } from '../kb/DistillBar.jsx';
import {
  SOURCE_FORMATS_TEXT,
  SourceDropOverlay,
  SourceUploadButton,
  SourceUploadDialogs,
  SourceUploading,
  useSourceUpload,
} from './SourceUpload.jsx';

/* ---------- 小工具 ---------- */

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

function kindIcon(s) {
  if (s.kind === 'url') return Globe;
  if (s.kind === 'text') return Type;
  const ext = extOf(s.name);
  if (ext === 'xlsx' || ext === 'csv') return FileSpreadsheet;
  if (ext === 'html' || ext === 'htm') return FileCode;
  return FileText;
}

/** 名称下面那行：类型 · 大小 */
function typeLine(s) {
  const ext = s.kind === 'file' ? extOf(s.name) : '';
  const type = ext ? ext.toUpperCase() : SOURCE_KIND[s.kind] || s.kind;
  return s.kind === 'file' && s.size ? `${type} · ${fmtSize(s.size)}` : type;
}

/** 列表里的时间：今天 10:42、昨天、10月3日、2025年10月3日（DESIGN 第 8 节） */
function listTime(iso) {
  const day = fmtDay(iso);
  if (!day) return '—';
  return day === '今天' ? fmtHm(iso) : day;
}
const fullTime = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('zh-CN') : undefined;
};

function distillState(s) {
  if (s.distilledAt) return 2;
  if (s.status === 'ready') return 1;
  return 0;
}

/* ---------- 详情抽屉（预览） ---------- */

function SourceDrawer({ source, onClose, onDelete, deleting }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!source) return undefined;
    let alive = true;
    setDetail(null);
    setErr(null);
    api
      .getSource(source.id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setErr(e));
    return () => {
      alive = false;
    };
  }, [source]);

  const s = detail || source;
  const st = s ? SOURCE_STATUS[s.status] || { label: s.status, tone: 'neutral' } : null;

  return (
    <Drawer
      open={!!source}
      onClose={onClose}
      title={s?.name || '资料预览'}
      size="wide"
      footer={
        s && (
          <button type="button" className="btn btn--danger" onClick={() => onDelete(s)} disabled={deleting}>
            {deleting ? <Spinner /> : <Trash2 />}
            删除
          </button>
        )
      }
    >
      {s && (
        <div className="vstack files-page__detail">
          {s.status === 'error' && <Callout tone="danger">读取失败：{s.error || '原因未知'}</Callout>}
          <dl className="kv">
            <dt>类型</dt>
            <dd>{SOURCE_KIND[s.kind] || s.kind}</dd>
            {s.size ? (
              <>
                <dt>大小</dt>
                <dd className="num">{fmtSize(s.size)}</dd>
              </>
            ) : null}
            <dt>字数</dt>
            <dd className="num">{fmtChars(s.chars)}</dd>
            <dt>状态</dt>
            <dd>
              <StatusDot tone={st.tone}>{st.label}</StatusDot>
            </dd>
            <dt>知识库</dt>
            <dd>{s.distilledAt ? `已整理（${fmtTime(s.distilledAt)}）` : '未整理'}</dd>
            <dt>添加时间</dt>
            <dd className="num">{fullTime(s.createdAt) || '—'}</dd>
          </dl>

          <div className="files-page__preview-head">
            <h3>内容预览</h3>
          </div>
          {err ? (
            <ErrorState compact title="预览加载失败" error={err} />
          ) : !detail ? (
            <div className="files-page__preview files-page__preview--loading" aria-busy="true">
              <span className="skeleton skeleton--text" style={{ width: '92%' }} />
              <span className="skeleton skeleton--text" style={{ width: '78%' }} />
              <span className="skeleton skeleton--text" style={{ width: '85%' }} />
              <span className="skeleton skeleton--text" style={{ width: '60%' }} />
            </div>
          ) : detail.preview ? (
            <>
              <div className="files-page__preview">{detail.preview}</div>
              {detail.chars > 3000 && (
                <div className="field__hint">仅显示前 3000 字，共 {fmtChars(detail.chars)}。</div>
              )}
            </>
          ) : (
            <div className="muted">该资料无可显示的文字内容。</div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ---------- 主体 ---------- */

const KIND_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'file', label: SOURCE_KIND.file },
  { value: 'url', label: SOURCE_KIND.url },
  { value: 'text', label: SOURCE_KIND.text },
];
const STATE_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'distilled', label: '已整理' },
  { value: 'pending', label: '待整理' },
  { value: 'error', label: '读取失败' },
];

export default function SourcesTab({ header, onChanged }) {
  const confirm = useConfirm();
  const [sources, setSources] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // 抽屉里的资料
  const [deleting, setDeleting] = useState(null); // id
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listSources({ silent: true });
      setSources(list || []);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onAdded = (items) => {
    const list = (items || []).filter(Boolean);
    if (!list.length) return;
    setSources((prev) => {
      const ids = new Set(list.map((s) => s.id));
      return [...list, ...(prev || []).filter((s) => !ids.has(s.id))];
    });
    onChanged?.();
  };

  // 抽屉开着时也不接拖进来的文件（正在上传、对话框开着的情况 useSourceUpload 自己会管）
  const upload = useSourceUpload({ onAdded, dropEnabled: !open });
  const { uploading } = upload;

  const removeOne = async (s) => {
    const ok = await confirm({
      title: `删除资料「${s.name}」？`,
      message: (
        <>
          已整理出的条目<strong>保留</strong>，如需删除请前往「条目」。
        </>
      ),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setDeleting(s.id);
    try {
      await api.deleteSource(s.id);
      setSources((prev) => (prev || []).filter((x) => x.id !== s.id));
      setSelected((prev) => {
        if (!prev.has(s.id)) return prev;
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
      if (open?.id === s.id) setOpen(null);
      toast.success('已删除');
      onChanged?.();
    } catch {
      // 已提示
    } finally {
      setDeleting(null);
    }
  };

  const removeSelected = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const ok = await confirm({
      title: `删除 ${ids.length} 份资料？`,
      message: (
        <>
          已整理出的条目<strong>保留</strong>，如需删除请前往「条目」。
        </>
      ),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    const done = [];
    // 接口只有单条删除，逐条调用
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.deleteSource(id);
        done.push(id);
      } catch {
        // 已提示
      }
    }
    const gone = new Set(done);
    setSources((prev) => (prev || []).filter((x) => !gone.has(x.id)));
    setSelected(new Set(ids.filter((id) => !gone.has(id))));
    setBulkBusy(false);
    if (done.length) {
      toast.success(
        done.length === ids.length
          ? `已删除 ${done.length} 份资料`
          : `已删除 ${done.length} 份，${ids.length - done.length} 份删除失败`,
      );
      onChanged?.();
    }
  };

  const filtered = useMemo(() => {
    if (!sources) return null;
    const f = q.trim().toLowerCase();
    return sources.filter((s) => {
      if (f && !String(s.name || '').toLowerCase().includes(f)) return false;
      if (kind && s.kind !== kind) return false;
      if (state === 'distilled' && !s.distilledAt) return false;
      if (state === 'pending' && !(s.status === 'ready' && !s.distilledAt)) return false;
      if (state === 'error' && s.status !== 'error') return false;
      return true;
    });
  }, [sources, q, kind, state]);

  const columns = [
    {
      key: 'name',
      header: '名称',
      sortValue: (s) => s.name || '',
      render: (s) => {
        const Icon = kindIcon(s);
        return (
          <div className="files-page__name">
            <Icon className="files-page__type-icon" aria-hidden="true" />
            <CellText primary={<span title={s.name}>{s.name || '未命名'}</span>} secondary={typeLine(s)} />
          </div>
        );
      },
    },
    {
      key: 'status',
      header: '状态',
      sortValue: (s) => s.status,
      render: (s) => {
        const st = SOURCE_STATUS[s.status] || { label: s.status, tone: 'neutral' };
        return (
          <div className="files-page__status">
            <StatusDot tone={st.tone}>{st.label}</StatusDot>
            {s.status === 'error' && s.error && (
              <div className="table__secondary ellipsis" title={s.error}>
                {s.error}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'chars',
      header: '字数',
      align: 'num',
      hide: 'md',
      sortValue: (s) => (s.status === 'ready' ? (s.chars ?? 0) : null),
      render: (s) => (s.status === 'ready' ? fmtChars(s.chars) : '—'),
    },
    {
      key: 'distilled',
      header: '知识库',
      hide: 'sm',
      sortValue: distillState,
      render: (s) =>
        s.distilledAt ? (
          <span title={`整理于 ${fmtTime(s.distilledAt)}`}>
            <StatusDot tone="success">已整理</StatusDot>
          </span>
        ) : s.status === 'ready' ? (
          <StatusDot tone="warning">待整理</StatusDot>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'createdAt',
      header: '添加时间',
      hide: 'md',
      shrink: true,
      sortValue: (s) => s.createdAt || '',
      render: (s) => (
        <span className="muted num" title={fullTime(s.createdAt)}>
          {listTime(s.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      shrink: true,
      hide: 'sm', // 手机上点行打开抽屉，抽屉底部有删除
      render: (s) => (
        <RowActions>
          <Tooltip content="预览">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              aria-label="预览"
              onClick={() => setOpen(s)}
            >
              <Eye />
            </button>
          </Tooltip>
          <Tooltip content="删除">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm btn--danger"
              aria-label="删除"
              onClick={() => removeOne(s)}
              disabled={deleting === s.id}
            >
              {deleting === s.id ? <Spinner /> : <Trash2 />}
            </button>
          </Tooltip>
        </RowActions>
      ),
    },
  ];

  const actions = <SourceUploadButton upload={upload} primary />;

  const total = sources?.length ?? 0;

  return (
    <div className="page">
      {header(actions)}

      <div className="files-page__body">
        <DistillBar sources={sources} />

        <TableToolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="搜索资料名称"
          count={filtered ? filtered.length : undefined}
          end={uploading && <SourceUploading names={uploading} />}
          selection={{
            count: selected.size,
            onClear: () => setSelected(new Set()),
            actions: (
              <button type="button" className="btn btn--sm btn--danger" onClick={removeSelected} disabled={bulkBusy}>
                {bulkBusy ? <Spinner /> : <Trash2 />}
                删除
              </button>
            ),
          }}
        >
          <Select
            size="sm"
            className="select--auto"
            value={kind}
            onChange={setKind}
            options={KIND_OPTIONS}
            aria-label="类型"
          />
          <Select
            size="sm"
            className="select--auto"
            value={state}
            onChange={setState}
            options={STATE_OPTIONS}
            aria-label="状态"
          />
        </TableToolbar>

        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : (
          <div className="files-page__table">
            <DataTable
              label="知识库资料"
              columns={columns}
              rows={filtered}
              rowKey={(s) => s.id}
              onRowClick={setOpen}
              isRowActive={(s) => open?.id === s.id}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              defaultSort={{ key: 'createdAt', dir: 'desc' }}
              empty={
                total === 0 ? (
                  <EmptyState
                    icon={FileText}
                    title="暂无资料"
                    desc={`适用于产品手册、价格表、常见问题、售后政策、公司官网等。${SOURCE_FORMATS_TEXT}，支持拖拽上传。`}
                    action={
                      <button type="button" className="btn btn--primary" onClick={upload.pickFiles} disabled={!!uploading}>
                        <Upload />
                        上传文件
                      </button>
                    }
                  />
                ) : (
                  <EmptyState compact title="无匹配的资料" />
                )
              }
            />
          </div>
        )}

        {upload.dragging && <SourceDropOverlay />}
      </div>

      <SourceUploadDialogs upload={upload} />
      <SourceDrawer source={open} onClose={() => setOpen(null)} onDelete={removeOne} deleting={deleting === open?.id} />
    </div>
  );
}
