import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Pencil } from 'lucide-react';
import { Modal } from './Modal.jsx';
import { StatusDot } from './StatusDot.jsx';
import { Spinner } from './common.jsx';
import { cachedEntry, getEntries, getEntry } from '../lib/entryCache.js';
import { useAuth } from '../lib/auth.jsx';
import { ENTRY_ORIGIN, ENTRY_STATUS, entryTypeLabel } from '../lib/labels.js';
import { fmtTime } from '../lib/format.js';
import { EntryPreviewBody, RefPreview } from './RefPreview.jsx';

/** 查看单个条目（只读）；admin 可跳到条目页编辑，agent 没有"去编辑"按钮 */
export function EntryPeek({ entryId, onClose }) {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [entry, setEntry] = useState(undefined); // undefined=加载中, null=不存在
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!entryId) return undefined;
    let alive = true;
    // 缓存里有（比如刚在预览里看过）就先显示，再按 id 取一遍
    setEntry(cachedEntry(entryId));
    setErr(null);
    getEntry(entryId)
      .then((e) => alive && setEntry(e))
      .catch((e) => alive && setErr(e));
    return () => {
      alive = false;
    };
  }, [entryId]);

  const st = entry ? ENTRY_STATUS[entry.status] : null;

  return (
    <Modal
      open={!!entryId}
      onClose={onClose}
      title="引用的知识条目"
      width={560}
      footer={
        entry && isAdmin ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                onClose();
                navigate(`/kb/entries?edit=${encodeURIComponent(entry.id)}`);
              }}
            >
              <Pencil /> 编辑
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      {err ? (
        <div className="text-danger">条目加载失败：{err.message}</div>
      ) : entry === undefined ? (
        <div className="hstack muted">
          <Spinner /> 加载中…
        </div>
      ) : entry === null ? (
        <div className="muted">条目已删除或不存在。</div>
      ) : (
        <div className="peek">
          <div className="peek__meta">
            <span className="tag">{entryTypeLabel(entry.type)}</span>
            {st && <StatusDot tone={st.tone} size="sm">{st.label}</StatusDot>}
            <span className="muted text-sm">{ENTRY_ORIGIN[entry.origin] || entry.origin}</span>
            <span className="muted text-sm">更新于 {fmtTime(entry.updatedAt)}</span>
          </div>
          <h3 className="peek__title">{entry.title}</h3>
          <div className="peek__content">{entry.content}</div>
          {entry.tags?.length > 0 && (
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 4 }}>
              {entry.tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </div>
          )}
          {entry.sourceRefs?.length > 0 && (
            <div className="peek__refs">
              <h3 className="peek__refs-title">来源</h3>
              {entry.sourceRefs.map((r, i) => (
                <div key={i} className="peek__ref">
                  <div className="hstack text-strong">
                    <FileText size={14} className="muted" /> {r.sourceName || '未知资料'}
                  </div>
                  {r.quote && <blockquote className="peek__quote">{r.quote}</blockquote>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * 一组被引用条目的标题链接（只按 id 取这几条），鼠标停上去在旁边浮出预览，点开查看详情。
 * 传了 onOpen(id) 就交给调用方打开（放在浮层里用时，弹窗要渲染在浮层外面）；不传就在这里渲染 EntryPeek。
 */
export function EntryRefs({ ids, onOpen }) {
  const [map, setMap] = useState(null);
  const [failed, setFailed] = useState(false);
  const [peek, setPeek] = useState(null);
  const key = (ids || []).join(',');

  useEffect(() => {
    if (!ids?.length) return undefined;
    let alive = true;
    setFailed(false);
    getEntries(ids)
      .then((m) => alive && setMap(m))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!ids?.length) return <span className="muted">无引用知识条目</span>;

  const open = (id) => (onOpen ? onOpen(id) : setPeek(id));
  return (
    <>
      <ul className="ref-list">
        {ids.map((id) => {
          // undefined 加载中，null 已删除
          const e = map?.has(id) ? map.get(id) : cachedEntry(id);
          const off = !!e && e.status !== 'active';
          return (
            <li key={id}>
              <RefPreview
                pin={false}
                placement="right-start"
                label={e ? `知识条目：${e.title}` : '知识条目'}
                trigger={
                  <button type="button" className="ref-list__item" onClick={() => open(id)}>
                    <FileText aria-hidden="true" />
                    <span className={`ellipsis${e ? '' : ' muted'}`}>
                      {e === undefined ? (failed ? '条目加载失败' : '加载中…') : e === null ? '已删除的条目' : e.title}
                    </span>
                    {off && <span className="ref-list__meta">已停用</span>}
                  </button>
                }
              >
                {(close) => (
                  <EntryPreviewBody
                    entry={e}
                    error={failed}
                    onOpenFull={() => {
                      close(true);
                      open(id);
                    }}
                  />
                )}
              </RefPreview>
            </li>
          );
        })}
      </ul>
      {!onOpen && <EntryPeek entryId={peek} onClose={() => setPeek(null)} />}
    </>
  );
}
