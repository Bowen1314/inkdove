import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, Maximize2 } from 'lucide-react';
import { api } from '../api/client.js';
import { useAnchoredPosition, useDismiss } from './overlay.js';
import { StatusDot } from './StatusDot.jsx';
import { Spinner } from './common.jsx';
import { entryTypeLabel } from '../lib/labels.js';
import { fileIcon, fileTypeLabel, isImageMime } from '../lib/files.js';
import { fmtSize } from '../lib/format.js';

// 引用（知识条目、要发的文件）的悬停预览：会话页推荐卡片的「依据」、机器人消息「依据 N 条知识」的列表共用。

const OPEN_DELAY = 300;
/** 从标签移到浮层要经过中间几像素的空隙，晚一点关，移进浮层就不关了 */
const CLOSE_DELAY = 150;
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function mergeRefs(...refs) {
  return (el) => {
    for (const r of refs) {
      if (typeof r === 'function') r(el);
      else if (r) r.current = el;
    }
  };
}

/** 在别的浮层里用时，在预览里按鼠标不算点了外面那层（不然按下就把外层连同预览一起关掉，按钮的 click 收不到） */
const stopDismiss = (e) => e.stopPropagation();

/**
 * 预览浮层。trigger 是一个按钮元素，会被注入悬停、点击和 aria 属性；children(close) 是浮层内容，
 * close(true) 关掉并把焦点还给 trigger（接着打开弹窗时，弹窗关掉后焦点能回到这里）。
 * - 鼠标停在 trigger 上约 300ms 浮出；移进浮层里不关（可以滚动、点按钮），都移开后收起；
 * - pin（默认）：点 trigger 固定打开（手机没有悬停，点一下出预览，点外面关），再点一下关；用键盘（回车、空格）打开时
 *   焦点移进浮层，Tab 走出浮层就关，Esc 关闭并把焦点还给 trigger；
 * - pin=false：点 trigger 走它自己的 onClick（比如打开弹窗），预览只跟着悬停。
 * 浮层渲染在 body 上，不超出视口；放在别的浮层里也能用（见 stopDismiss）。
 */
export function RefPreview({ trigger, label, children, placement = 'top-start', pin = true }) {
  const [mode, setMode] = useState(null); // null | 'hover' | 'pinned'
  const open = mode !== null;
  const anchorRef = useRef(null);
  const floatRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const focusInside = useRef(false);
  const id = useId();
  const pos = useAnchoredPosition(open, anchorRef, floatRef, placement);

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  useEffect(() => clearTimers, []);

  const close = (restoreFocus = false) => {
    clearTimers();
    setMode(null);
    if (restoreFocus) anchorRef.current?.focus();
  };
  // Esc 时焦点在浮层里的，还给 trigger
  useDismiss(open, [anchorRef, floatRef], (why) => close(why === 'escape' && !!floatRef.current?.contains(document.activeElement)));

  // 键盘打开：等定好位置，把焦点放到浮层里第一个按钮上（没有就放在浮层上）
  useEffect(() => {
    if (mode !== 'pinned' || !focusInside.current) return undefined;
    focusInside.current = false;
    const t = setTimeout(() => {
      const el = floatRef.current;
      (el?.querySelector(FOCUSABLE) || el)?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [mode]);

  const hoverIn = (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closeTimer.current);
    if (open) return;
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setMode((m) => m || 'hover'), OPEN_DELAY);
  };
  const hoverOut = (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setMode((m) => (m === 'hover' ? null : m)), CLOSE_DELAY);
  };
  const panelIn = (e) => {
    if (e.pointerType === 'mouse') clearTimeout(closeTimer.current);
  };

  /** Tab 走到浮层最后一个之后、Shift+Tab 走到第一个之前：关掉，焦点回到 trigger（往后走时浏览器接着走到 trigger 后面那个） */
  const onPanelKeyDown = (e) => {
    if (e.key !== 'Tab' || !floatRef.current) return;
    const items = Array.from(floatRef.current.querySelectorAll(FOCUSABLE));
    const active = document.activeElement;
    if (e.shiftKey ? active === floatRef.current || active === items[0] : !items.length || active === items[items.length - 1]) {
      if (e.shiftKey) e.preventDefault();
      close(true);
    }
  };

  const triggerEl = cloneElement(trigger, {
    ref: mergeRefs(anchorRef, trigger.ref),
    'aria-expanded': pin ? open : undefined,
    'aria-haspopup': pin ? 'dialog' : undefined,
    'aria-controls': open ? id : undefined,
    onPointerEnter: (e) => {
      trigger.props.onPointerEnter?.(e);
      hoverIn(e);
    },
    onPointerLeave: (e) => {
      trigger.props.onPointerLeave?.(e);
      hoverOut(e);
    },
    onClick: (e) => {
      trigger.props.onClick?.(e);
      if (!pin || mode === 'pinned') {
        close();
        return;
      }
      clearTimers();
      focusInside.current = e.detail === 0;
      setMode('pinned');
    },
  });

  return (
    <>
      {triggerEl}
      {open &&
        createPortal(
          <div
            id={id}
            ref={floatRef}
            className="ref-preview"
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            style={pos}
            onPointerEnter={panelIn}
            onPointerLeave={hoverOut}
            onMouseDown={stopDismiss}
            onTouchStart={stopDismiss}
            onKeyDown={onPanelKeyDown}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 条目预览的内容：类型、状态（停用的标出来）、标题、正文（长的在框里滚动）、标签，底部「查看全文」。
 * entry：undefined 加载中，null 已删除；error：加载失败。onOpenFull 打开完整的条目弹窗（EntryPeek）
 */
export function EntryPreviewBody({ entry, error = false, onOpenFull }) {
  if (entry === undefined) {
    return <div className="ref-preview__state">{error ? '条目加载失败，请稍后再试' : <><Spinner /> 加载中…</>}</div>;
  }
  if (entry === null) return <div className="ref-preview__state">这个条目已被删除</div>;
  return (
    <>
      <div className="ref-preview__meta">
        <span className="tag">{entryTypeLabel(entry.type)}</span>
        {entry.status !== 'active' && (
          <StatusDot tone="neutral" size="sm">
            已停用
          </StatusDot>
        )}
      </div>
      <div className="ref-preview__title">{entry.title}</div>
      <div className="ref-preview__body">{entry.content}</div>
      {entry.tags?.length > 0 && (
        <div className="ref-preview__tags">
          {entry.tags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      )}
      {onOpenFull && (
        <div className="ref-preview__actions">
          <button type="button" className="btn btn--sm" onClick={onOpenFull}>
            <Maximize2 />
            查看全文
          </button>
        </div>
      )}
    </>
  );
}

/** 文件预览的内容：图片缩略图、名称、文件名、格式和大小、说明，底部「下载」。file：undefined 加载中，null 已删除 */
export function FilePreviewBody({ file }) {
  if (file === undefined) {
    return (
      <div className="ref-preview__state">
        <Spinner /> 加载中…
      </div>
    );
  }
  if (file === null) return <div className="ref-preview__state">这个文件已被删除</div>;
  const desc = String(file.description || '').trim();
  return (
    <>
      {isImageMime(file.mime) && <img className="ref-preview__img" src={api.fileDownloadUrl(file.id)} alt={file.name} />}
      <div className="ref-preview__meta">
        <span className="tag">{fileTypeLabel(file)}</span>
        {file.size != null && <span className="muted text-sm num">{fmtSize(file.size)}</span>}
        {file.status !== 'active' && (
          <StatusDot tone="neutral" size="sm">
            已停用
          </StatusDot>
        )}
      </div>
      <div className="ref-preview__title">{file.name}</div>
      {file.filename && file.filename !== file.name && <div className="ref-preview__sub">{file.filename}</div>}
      <div className="ref-preview__body">
        {desc || <span className="muted">{file.descriptionStatus === 'pending' ? '说明生成中…' : '没有说明'}</span>}
      </div>
      <div className="ref-preview__actions">
        <a className="btn btn--sm" href={api.fileDownloadUrl(file.id)} download={file.filename || file.name}>
          <Download />
          下载
        </a>
      </div>
    </>
  );
}

/**
 * 条目小标签：标题，停用的标「已停用」，删掉的显示「已删除的条目」；悬停或点击出预览，「查看全文」交给 onOpenFull(id)。
 * entry：undefined 加载中，null 已删除
 */
export function EntryChip({ id, entry, error = false, onOpenFull }) {
  const off = !!entry && entry.status !== 'active';
  const text = entry === undefined ? (error ? '条目加载失败' : '加载中…') : entry === null ? '已删除的条目' : entry.title;
  return (
    <RefPreview
      label={entry ? `知识条目：${entry.title}` : '知识条目'}
      trigger={
        <button type="button" className={`ref-chip${!entry || off ? ' is-muted' : ''}`}>
          <FileText aria-hidden="true" />
          <span className="ref-chip__name">{text}</span>
          {off && <span className="ref-chip__meta">已停用</span>}
        </button>
      }
    >
      {(close) => (
        <EntryPreviewBody
          entry={entry}
          error={error}
          onOpenFull={() => {
            close(true);
            onOpenFull(id);
          }}
        />
      )}
    </RefPreview>
  );
}

/** 文件小标签：类型图标、名称、格式和大小（停用的标「已停用」）；悬停或点击出预览。file：undefined 加载中，null 已删除 */
export function FileChip({ file }) {
  const Icon = file ? fileIcon(file) : FileText;
  const meta = file ? (file.status === 'active' ? [fileTypeLabel(file), fmtSize(file.size)].filter(Boolean).join(' · ') : '已停用') : '';
  return (
    <RefPreview
      label={file ? `文件：${file.name}` : '文件'}
      trigger={
        <button type="button" className={`ref-chip${!file || file.status !== 'active' ? ' is-muted' : ''}`}>
          <Icon aria-hidden="true" />
          <span className="ref-chip__name">{file === undefined ? '加载中…' : file === null ? '文件已删除' : file.name}</span>
          {meta && <span className="ref-chip__meta">{meta}</span>}
        </button>
      }
    >
      {() => <FilePreviewBody file={file} />}
    </RefPreview>
  );
}
