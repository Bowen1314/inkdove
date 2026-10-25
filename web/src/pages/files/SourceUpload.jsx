import { useRef, useState } from 'react';
import { ChevronDown, ClipboardPaste, Globe, Link2, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal } from '../../ui/Modal.jsx';
import { Menu, Tooltip } from '../../ui/Popover.jsx';
import { Field, Spinner, fieldProps } from '../../ui/common.jsx';
import { useWindowFileDrop } from '../../hooks/useWindowFileDrop.js';

/*
 * 添加知识库资料：上传文件（点选或拖进窗口）、添加网址、粘贴文本。
 * 「文件 → 知识库资料」和知识库的「条目」「整理」两个标签共用，资料都存在「文件 → 知识库资料」。
 * 用法：const upload = useSourceUpload({...})，页头放 <SourceUploadButton upload={upload} />，
 * 页面里渲染一次 <SourceUploadDialogs upload={upload} />，拖文件时显示 <SourceDropOverlay />。
 */

const MAX_FILE = 20 * 1024 * 1024;
const ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown,.html,.htm';
export const SOURCE_FORMATS_TEXT = '支持 PDF、Word、Excel、CSV、TXT、Markdown、网页文件，可多选，单个不超过 20MB';

/** 提示里怎么说资料去了哪：资料页说"下方列表"；在知识库页添加时说清楚存到了「文件 → 知识库资料」 */
function placeText(elsewhere) {
  return elsewhere
    ? { addedTo: '到「文件 → 知识库资料」', seeIn: '「文件 → 知识库资料」' }
    : { addedTo: '', seeIn: '下方列表' };
}

/* ---------- 添加网址 ---------- */

function UrlModal({ open, onClose, onAdded, elsewhere }) {
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
      const { addedTo, seeIn } = placeText(elsewhere);
      if (src?.status === 'error') toast.error(`网页读取失败，请在${seeIn}查看原因`);
      else toast.success(`网页已添加${addedTo}`);
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
            {busy ? '抓取中…' : '添加网页'}
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
          <span>同时抓取同站其他页面</span>
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
            ? '逐页抓取中，页面较多时需 1–2 分钟，请勿关闭页面。'
            : '仅支持公开网页，所有页面合并为一份资料。'}
        </div>
      </form>
    </Modal>
  );
}

/* ---------- 粘贴文本 ---------- */

function TextModal({ open, onClose, onAdded, elsewhere }) {
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
      toast.success(`文本已添加${placeText(elsewhere).addedTo}`);
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
            {busy ? '添加中…' : '添加文本'}
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
            placeholder="粘贴产品介绍、常见问答、售后说明等内容"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

/* ---------- 状态和动作 ---------- */

/**
 * onAdded(items)：新加进来的资料（含读取失败的）。
 * dropEnabled：要不要接拖进窗口的文件；正在上传、添加网址或文本的对话框开着时本来就不接。
 * elsewhere：不在资料列表旁边添加（知识库页）时为 true，提示里说清楚资料存到了哪。
 */
export function useSourceUpload({ onAdded, dropEnabled = true, elsewhere = false }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(null); // 文件名数组
  const [adding, setAdding] = useState(null); // 'url' | 'text'

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
      onAdded?.(res);
      const { addedTo, seeIn } = placeText(elsewhere);
      const failed = res.filter((s) => s.status === 'error');
      if (failed.length) {
        toast.error(`${failed.length} 个文件读取失败，请在${seeIn}查看原因`);
      } else {
        toast.success(`已添加 ${res.length} 个文件${addedTo}`);
      }
    } catch {
      // 错误已由 API 客户端提示
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 对话框、抽屉开着或正在上传时，不接拖进来的文件
  const dragging = useWindowFileDrop(dropEnabled && !uploading && !adding, handleFiles);

  return {
    fileRef,
    uploading,
    adding,
    dragging,
    elsewhere,
    onAdded,
    handleFiles,
    pickFiles: () => fileRef.current?.click(),
    setAdding,
  };
}

/* ---------- 界面 ---------- */

/**
 * "上传文件"分体按钮：主按钮选文件，右边的下拉里是"添加网址""粘贴文本"。
 * primary：资料页页头和空状态用主按钮；知识库页头的主操作是"新建条目""开始整理"，这里用次要按钮。
 * compact：窄屏（≤640）只留图标，知识库页头按钮多时用（同"测试对话"按钮）。
 */
export function SourceUploadButton({ upload, primary = false, label = '上传文件', compact = false }) {
  const tone = primary ? 'btn btn--primary' : 'btn';
  return (
    <div className={`files-page__split${compact ? ' files-page__split--compact' : ''}`}>
      <button
        type="button"
        className={tone}
        onClick={upload.pickFiles}
        disabled={!!upload.uploading}
        aria-label={compact ? label : undefined}
      >
        {upload.uploading ? <Spinner /> : <Upload />}
        {compact ? <span className="files-page__split-label">{label}</span> : label}
      </button>
      <Tooltip content="添加网址或粘贴文本">
        <span className="files-page__split-more">
          <Menu
            trigger={
              <button type="button" className={`${tone} btn--icon`} aria-label="更多添加方式">
                <ChevronDown />
              </button>
            }
            items={[
              { label: '添加网址', icon: Globe, onClick: () => upload.setAdding('url') },
              { label: '粘贴文本', icon: ClipboardPaste, onClick: () => upload.setAdding('text') },
            ]}
          />
        </span>
      </Tooltip>
    </div>
  );
}

/** 隐藏的选文件框，加"添加网址""粘贴文本"两个对话框。用了 useSourceUpload 的页面渲染一次 */
export function SourceUploadDialogs({ upload }) {
  const close = () => upload.setAdding(null);
  return (
    <>
      <input
        ref={upload.fileRef}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => upload.handleFiles(e.target.files)}
      />
      <UrlModal open={upload.adding === 'url'} onClose={close} onAdded={upload.onAdded} elsewhere={upload.elsewhere} />
      <TextModal open={upload.adding === 'text'} onClose={close} onAdded={upload.onAdded} elsewhere={upload.elsewhere} />
    </>
  );
}

/** 上传中的提示：正在上传并读取 N 个文件… */
export function SourceUploading({ names }) {
  return (
    <span className="files-page__uploading" title={names.join('、')}>
      <Spinner />
      正在上传并读取 {names.length} 个文件…
    </span>
  );
}

/** 文件拖进窗口时盖住内容区的虚线框。外层要 position: relative */
export function SourceDropOverlay() {
  return (
    <div className="drop-overlay files-page__drop" aria-hidden="true">
      <div className="files-page__drop-text">
        松开上传
        <span className="files-page__drop-hint">{SOURCE_FORMATS_TEXT}</span>
      </div>
    </div>
  );
}
