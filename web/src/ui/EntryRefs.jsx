import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Pencil } from 'lucide-react';
import { Modal } from './Modal.jsx';
import { StatusDot } from './StatusDot.jsx';
import { Spinner } from './common.jsx';
import { getEntryMap } from '../lib/entryCache.js';
import { useAuth } from '../lib/auth.jsx';
import { ENTRY_ORIGIN, ENTRY_STATUS, entryTypeLabel } from '../lib/labels.js';
import { fmtTime } from '../lib/format.js';

/** 查看单个条目（只读）；admin 可跳到条目页编辑，agent 没有"去编辑"按钮 */
export function EntryPeek({ entryId, onClose }) {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [entry, setEntry] = useState(undefined); // undefined=加载中, null=不存在
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!entryId) return undefined;
    let alive = true;
    setEntry(undefined);
    setErr(null);
    getEntryMap()
      .then((map) => alive && setEntry(map.get(entryId) || null))
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
              <Pencil /> 去编辑
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
        <div className="muted">这个条目已被删除，或暂时找不到。</div>
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
 * 一组被引用条目的标题链接，点开查看详情。
 * 传了 onOpen(id) 就交给调用方打开（放在浮层里用时，弹窗要渲染在浮层外面）；不传就在这里渲染 EntryPeek。
 */
export function EntryRefs({ ids, onOpen }) {
  const [map, setMap] = useState(null);
  const [peek, setPeek] = useState(null);

  useEffect(() => {
    if (!ids?.length) return undefined;
    let alive = true;
    getEntryMap()
      .then((m) => alive && setMap(m))
      .catch(() => alive && setMap(new Map()));
    return () => {
      alive = false;
    };
  }, [ids]);

  if (!ids?.length) return <span className="muted">没有引用知识条目</span>;

  return (
    <>
      <ul className="ref-list">
        {ids.map((id) => {
          const e = map?.get(id);
          return (
            <li key={id}>
              <button type="button" className="ref-list__item" onClick={() => (onOpen ? onOpen(id) : setPeek(id))}>
                <FileText aria-hidden="true" />
                <span className="ellipsis">{map ? (e ? e.title : '已删除的条目') : '加载中…'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!onOpen && <EntryPeek entryId={peek} onClose={() => setPeek(null)} />}
    </>
  );
}
