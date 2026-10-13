import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FolderOpen, Paperclip, Search, SendHorizontal, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal } from '../../ui/Modal.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { EmptyState, ErrorState, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { fmtSize } from '../../lib/format.js';
import { fileErrorText, fileIcon, fileTypeLabel, getFileMap } from '../../lib/files.js';

// 会话页里和产品资料库（F15）有关的部分：消息里的文件卡片、草稿附带的文件、"发送文件"按钮和选择弹窗。

const metaLine = (f) => [fileTypeLabel(f), fmtSize(f.size)].filter(Boolean).join(' · ');

/** 带 attachment 的消息：文件卡片（图标、文件名、格式和大小），点击下载 */
export function AttachmentCard({ attachment }) {
  const Icon = fileIcon(attachment);
  const name = attachment.filename || '文件';
  return (
    <a
      className="msg__file"
      href={api.fileDownloadUrl(attachment.fileId)}
      download={name}
      aria-label={`下载文件 ${name}`}
      title="点击下载"
    >
      <Icon aria-hidden="true" />
      <span className="msg__file-body">
        <span className="msg__file-name">{name}</span>
        <span className="msg__file-meta">{metaLine(attachment)}</span>
      </span>
      <Download className="msg__file-dl" aria-hidden="true" />
    </a>
  );
}

/**
 * 草稿附带的文件（draft.fileIds）：只有 id，名字从文件列表里查；点一下可以下载看看。
 * 给了 onSend 时旁边加"发送这些文件"按钮，点了把其中能发的（没删、没停用）按顺序交给 onSend。
 */
export function DraftFiles({ fileIds, onSend, sending = false }) {
  const [map, setMap] = useState(null);
  const key = fileIds.join(',');

  useEffect(() => {
    let alive = true;
    getFileMap()
      .then((m) => alive && setMap(m))
      .catch(() => alive && setMap(new Map()));
    return () => {
      alive = false;
    };
  }, [key]);

  const list = (
    <ul className="draft__files" aria-label="草稿附带的文件">
      {fileIds.map((id) => {
        const f = map?.get(id);
        if (!f) {
          return (
            <li key={id} className="draft__file is-missing">
              {map ? '文件已删除' : <Spinner />}
            </li>
          );
        }
        const Icon = fileIcon(f);
        return (
          <li key={id}>
            <a
              className="draft__file"
              href={api.fileDownloadUrl(f.id)}
              download={f.filename}
              title={f.description || f.filename}
              aria-label={`下载文件 ${f.name}`}
            >
              <Icon aria-hidden="true" />
              <span className="draft__file-name">{f.name}</span>
              <span className="draft__file-meta">{f.status === 'active' ? metaLine(f) : '已停用'}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
  if (!onSend) return list;
  const sendable = map ? fileIds.map((id) => map.get(id)).filter((f) => f && f.status === 'active') : [];
  return (
    <div className="draft__files-row">
      {list}
      <button type="button" className="btn btn--sm" onClick={() => onSend(sendable)} disabled={sending || !sendable.length}>
        {sending ? <Spinner /> : <SendHorizontal />}
        发送这些文件
      </button>
    </div>
  );
}

/**
 * 按顺序逐个发文件（权限同手动回复）。每发出一个调一次 onSent(msg)；中途失败（接口报错，或消息记为发送失败）就停，
 * 提示是哪个文件。全部发出返回 true。
 * @param {{convId:string, files:{id:string, name:string}[], onSent:(msg:any) => void}} p
 */
export async function sendFilesInOrder({ convId, files, onSent }) {
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const rest = files.length - i - 1 > 0 ? '，后面的文件没有发' : '';
    let msg;
    try {
      msg = await api.sendFile(convId, f.id, undefined, { silent: true });
    } catch (e) {
      toast.error(`「${f.name}」没发出去：${fileErrorText(e)}${rest}`);
      return false;
    }
    onSent(msg);
    // 发送失败的消息照样记下来（气泡下面有原因），这里只提示是哪个、停在这里
    if (msg?.status === 'failed') {
      toast.error(`「${f.name}」发送失败${msg.error ? `：${msg.error}` : ''}${rest}`);
      return false;
    }
  }
  return true;
}

/* ---------- 选择文件发送 ---------- */

function SendFileModal({ open, conv, manual, onClose, onSent }) {
  const { isAdmin } = useAuth();
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setFiles(null);
    try {
      // 停用的文件后端不让发，只列启用的
      setFiles((await api.listFiles({ status: 'active' }, { silent: true })) || []);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setPicked(null);
    load();
  }, [open, load]);

  const shown = useMemo(() => {
    if (!files) return null;
    const kw = q.trim().toLowerCase();
    if (!kw) return files;
    return files.filter((f) =>
      [f.name, f.filename, f.description, ...(f.tags || [])].some((s) => String(s || '').toLowerCase().includes(kw)),
    );
  }, [files, q]);

  const send = async (id = picked) => {
    if (!id || sending) return;
    setSending(true);
    try {
      // 发送失败（status=failed）时消息照样记下来，气泡下面会显示原因，和发文字一样不另弹提示
      const msg = await api.sendFile(conv.id, id, undefined, { silent: true });
      onSent(msg);
    } catch (e) {
      toast.error(fileErrorText(e));
    } finally {
      setSending(false);
    }
  };

  const close = () => {
    if (!sending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="发送文件"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={sending}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => send()} disabled={!picked || sending}>
            {sending ? <Spinner /> : <SendHorizontal />}
            发送
          </button>
        </>
      }
    >
      <div className="file-pick">
        <div className="input-group">
          <Search className="input-group__icon" aria-hidden="true" />
          <input
            className="input"
            type="search"
            placeholder="搜索名称、描述或标签"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索文件"
            autoFocus
          />
          {q && (
            <button type="button" className="input-group__clear" onClick={() => setQ('')} aria-label="清空搜索">
              <X size={13} />
            </button>
          )}
        </div>

        <div className="file-pick__list">
          {error ? (
            <ErrorState compact title="文件列表加载失败" error={error} onRetry={load} />
          ) : shown == null ? (
            <SkeletonRows rows={3} />
          ) : files.length === 0 ? (
            <EmptyState
              compact
              icon={FolderOpen}
              title="还没有可发送的文件"
              desc={
                isAdmin ? (
                  <Link className="link" to="/files/sendable">
                    去「文件」页上传
                  </Link>
                ) : (
                  '请管理员在「文件」页上传。'
                )
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState compact title="没有匹配的文件" />
          ) : (
            <div role="listbox" aria-label="可发送的文件">
              {shown.map((f) => {
                const Icon = fileIcon(f);
                const on = picked === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`file-pick__item${on ? ' is-selected' : ''}`}
                    onClick={() => setPicked(f.id)}
                    onDoubleClick={() => send(f.id)}
                    disabled={sending}
                  >
                    <Icon className="file-pick__icon" aria-hidden="true" />
                    <span className="file-pick__body">
                      <span className="file-pick__name">{f.name}</span>
                      <span className="file-pick__meta">
                        {metaLine(f)}
                        {f.description ? ` · ${f.description}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 人工回复的号没有机器人可暂停 */}
        {!conv.botPaused && !manual && <div className="field__hint">发送后机器人会暂停这个会话。</div>}
      </div>
    </Modal>
  );
}

/** 输入框旁边的"发送文件"按钮（权限同手动回复，agent 也能用）。manual：人工回复的号 */
export function SendFileButton({ conv, manual = false, onSent, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="发送文件">
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          aria-label="发送文件"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          <Paperclip />
        </button>
      </Tooltip>
      <SendFileModal
        open={open}
        conv={conv}
        manual={manual}
        onClose={() => setOpen(false)}
        onSent={(msg) => {
          setOpen(false);
          onSent(msg);
        }}
      />
    </>
  );
}
