import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ClipboardPaste,
  Eye,
  FileCode,
  FileSpreadsheet,
  FileText,
  Globe,
  Link2,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal, useConfirm } from '../../ui/Modal.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { Menu, Tooltip } from '../../ui/Popover.jsx';
import { Select } from '../../ui/Select.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { Callout, EmptyState, ErrorState, Field, Spinner, fieldProps } from '../../ui/common.jsx';
import { CellText, DataTable, RowActions, TableToolbar } from '../../ui/DataTable.jsx';
import { SOURCE_KIND, SOURCE_STATUS } from '../../lib/labels.js';
import { fmtChars, fmtDay, fmtHm, fmtSize, fmtTime } from '../../lib/format.js';
import { DistillBar } from '../kb/DistillBar.jsx';

const MAX_FILE = 20 * 1024 * 1024;
const ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown,.html,.htm';
const FORMATS_TEXT = '支持 PDF、Word、Excel、CSV、TXT、Markdown、网页文件，可多选，单个不超过 20MB';

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

/* ---------- 添加网址 ---------- */

function UrlModal({ open, onClose, onAdded }) {
  const [url, setUrl] = useState('');
  const [crawl, setCrawl] = useState(false);
  const [maxPages, setMaxPages] = useState(10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const openRef = useRef(open);
  openRef.current = open;

  const reset = () => {
    setUrl('');
    setCrawl(false);
    setMaxPages(10);
    setErr('');
  };

  const close = () => {
    if (!busy) reset();
    onClose();
  };

  const submit = async (e) => {
    e.preventDefault();
    let u = url.trim();
    if (!u || busy) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
      // eslint-disable-next-line no-new
      new URL(u);
    } catch {
      setErr('网址格式不正确，例如 https://www.example.com/about');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const n = Math.min(30, Math.max(1, Number(maxPages) || 10));
      const src = await api.addUrlSource({ url: u, crawl, maxPages: n });
      onAdded([src]);
      if (src?.status === 'error') toast.error('网页没能读取，可在下方列表查看原因');
      else toast.success('网页已添加');
      reset();
      // 抓取期间用户可能已经关掉对话框、又打开了别的
      if (openRef.current) onClose();
    } catch {
      // 已提示
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加网址"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            取消
          </button>
          <button type="submit" form="files-url-form" className="btn btn--primary" disabled={!url.trim() || busy}>
            {busy ? <Spinner /> : <Globe />}
            {busy ? '正在抓取…' : '添加网页'}
          </button>
        </>
      }
    >
      <form id="files-url-form" className="files-page__form" onSubmit={submit} noValidate>
        <Field label="网页地址" htmlFor="src-url" error={err}>
          <div className="input-group">
            <Link2 className="input-group__icon" aria-hidden="true" />
            <input
              {...fieldProps('src-url', err)}
              className="input"
              placeholder="https://www.example.com/products"
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                if (err) setErr('');
              }}
              inputMode="url"
              spellCheck={false}
            />
          </div>
        </Field>
        <label className="choice">
          <input
            type="checkbox"
            className="checkbox"
            checked={crawl}
            disabled={busy}
            onChange={(e) => setCrawl(e.target.checked)}
          />
          <span>同时抓取同一网站的其他页面</span>
        </label>
        <label className={`files-page__pages${crawl ? '' : ' is-disabled'}`}>
          最多
          <input
            className="input input--sm num"
            style={{ width: 72 }}
            type="number"
            min={1}
            max={30}
            value={maxPages}
            disabled={!crawl || busy}
            onChange={(e) => setMaxPages(e.target.value)}
          />
          页（最多 30）
        </label>
        <div className="field__hint">
          {busy && crawl
            ? '正在逐页抓取，页面多时可能需要一两分钟，请不要关闭页面。'
            : '只能添加公开访问的网页，所有页面会合并成一份资料。'}
        </div>
      </form>
    </Modal>
  );
}

/* ---------- 粘贴文本 ---------- */

function TextModal({ open, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const src = await api.addTextSource({
        name: name.trim() || `粘贴的文本 ${new Date().toLocaleString('zh-CN')}`,
        text,
      });
      onAdded([src]);
      toast.success('文本已添加');
      setName('');
      setText('');
      onClose();
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
      title="粘贴文本"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="files-text-form" className="btn btn--primary" disabled={!text.trim() || busy}>
            {busy ? <Spinner /> : <ClipboardPaste />}
            {busy ? '正在添加…' : '添加文本'}
          </button>
        </>
      }
    >
      <form id="files-text-form" className="files-page__form" onSubmit={submit} noValidate>
        <Field label="标题" htmlFor="src-name">
          <input
            id="src-name"
            className="input"
            placeholder="例如：退换货政策、2026 年价格表"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </Field>
        <Field
          label="内容"
          htmlFor="src-text"
          aside={<span className="muted text-sm num">{text.length.toLocaleString('zh-CN')} 字</span>}
        >
          <textarea
            id="src-text"
            className="textarea"
            rows={8}
            placeholder="把产品介绍、常见问答、售后说明等内容粘贴到这里"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
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
            <dd>{s.distilledAt ? `已整理（${fmtTime(s.distilledAt)}）` : '尚未整理进知识库'}</dd>
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
            <div className="muted">这份资料没有可显示的文字内容。</div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ---------- 拖文件到页面任意位置上传 ---------- */

/**
 * 文件拖进窗口时返回 true（显示"松开上传"），松开时把文件交给 onFiles。
 * 有对话框或抽屉开着（含确认框）、或 enabled=false 时不接文件，但仍拦住浏览器默认的"打开文件"。
 */
function useWindowFileDrop(enabled, onFiles) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ enabled, onFiles });
  latest.current = { enabled, onFiles };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const active = () => latest.current.enabled && !document.querySelector('.modal-layer, .drawer-layer');
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (active()) setDragging(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = active() ? 'copy' : 'none';
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (active()) latest.current.onFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    if (!enabled) setDragging(false);
  }, [enabled]);

  return dragging && enabled;
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
  const fileRef = useRef(null);
  const [sources, setSources] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(null); // 文件名数组
  const [adding, setAdding] = useState(null); // 'url' | 'text'
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

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length || uploading) return;
    const tooBig = files.filter((f) => f.size > MAX_FILE);
    const ok = files.filter((f) => f.size <= MAX_FILE);
    if (tooBig.length) {
      toast.error(`${tooBig.map((f) => f.name).join('、')} 超过 20MB，无法上传`);
    }
    if (!ok.length) return;
    setUploading(ok.map((f) => f.name));
    try {
      const res = (await api.uploadSources(ok)) || [];
      onAdded(res);
      const failed = res.filter((s) => s.status === 'error');
      if (failed.length) {
        toast.error(`${failed.length} 个文件没能读取，可在下方列表查看原因`);
      } else {
        toast.success(`已添加 ${res.length} 个文件`);
      }
    } catch {
      // 错误已由 API 客户端提示
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 对话框、抽屉开着或正在上传时，不接拖进来的文件
  const dragging = useWindowFileDrop(!uploading && !adding && !open, handleFiles);

  const removeOne = async (s) => {
    const ok = await confirm({
      title: '删除这份资料？',
      message: (
        <>
          将删除「{s.name}」。已经从它整理出的知识条目<strong>会保留</strong>，如需删除请到"条目"里操作。
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
          已经从这些资料整理出的知识条目<strong>会保留</strong>，如需删除请到"条目"里操作。
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
          : `已删除 ${done.length} 份，${ids.length - done.length} 份没删掉`,
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

  const pickFiles = () => fileRef.current?.click();

  const actions = (
    <div className="files-page__split">
      <button type="button" className="btn btn--primary" onClick={pickFiles} disabled={!!uploading}>
        {uploading ? <Spinner /> : <Upload />}
        上传文件
      </button>
      <Tooltip content="添加网址或粘贴文本">
        <span className="files-page__split-more">
          <Menu
            trigger={
              <button type="button" className="btn btn--primary btn--icon" aria-label="更多添加方式">
                <ChevronDown />
              </button>
            }
            items={[
              { label: '添加网址', icon: Globe, onClick: () => setAdding('url') },
              { label: '粘贴文本', icon: ClipboardPaste, onClick: () => setAdding('text') },
            ]}
          />
        </span>
      </Tooltip>
    </div>
  );

  const total = sources?.length ?? 0;

  return (
    <div className="page">
      {header(actions)}
      <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => handleFiles(e.target.files)} />

      <div className="files-page__body">
        <DistillBar sources={sources} />

        <TableToolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="搜索资料名称"
          count={filtered ? filtered.length : undefined}
          end={
            uploading && (
              <span className="files-page__uploading" title={uploading.join('、')}>
                <Spinner />
                正在上传并读取 {uploading.length} 个文件…
              </span>
            )
          }
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
                    title="还没有资料"
                    desc={`产品手册、价格表、常见问题、售后政策、公司官网都可以。${FORMATS_TEXT}，也可以直接把文件拖进来。`}
                    action={
                      <button type="button" className="btn btn--primary" onClick={pickFiles} disabled={!!uploading}>
                        <Upload />
                        上传文件
                      </button>
                    }
                  />
                ) : (
                  <EmptyState compact title="没有匹配的资料" />
                )
              }
            />
          </div>
        )}

        {dragging && (
          <div className="drop-overlay files-page__drop" aria-hidden="true">
            <div className="files-page__drop-text">
              松开上传
              <span className="files-page__drop-hint">{FORMATS_TEXT}</span>
            </div>
          </div>
        )}
      </div>

      <UrlModal open={adding === 'url'} onClose={() => setAdding(null)} onAdded={onAdded} />
      <TextModal open={adding === 'text'} onClose={() => setAdding(null)} onAdded={onAdded} />
      <SourceDrawer source={open} onClose={() => setOpen(null)} onDelete={removeOne} deleting={deleting === open?.id} />
    </div>
  );
}
