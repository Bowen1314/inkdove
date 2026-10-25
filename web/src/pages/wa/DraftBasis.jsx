import { useEffect, useId, useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Spinner } from '../../ui/common.jsx';
import { EntryPeek } from '../../ui/EntryRefs.jsx';
import { EntryChip, FileChip } from '../../ui/RefPreview.jsx';
import { cachedEntry, getEntries } from '../../lib/entryCache.js';
import { getFileMap } from '../../lib/files.js';

/**
 * 推荐回复、草稿卡片正文下面的「依据」：起草所依据的知识条目（draft.entryIds）和建议发送的文件（draft.fileIds），
 * 都是小标签，鼠标停上去（手机上点一下）浮出预览，业务员不用跳到知识库就能核对。条目只按 id 取这几条；
 * 「查看全文」打开条目弹窗，文件在预览里下载。
 * 给了 onSend 且有文件时，后面加"发送文件"，点了把其中能发的（没删、没停用）按顺序交给 onSend。
 * showLabel=false：只剩文件建议时（草稿已经关掉）不写「依据」。
 */
export function DraftBasis({ entryIds = [], fileIds = [], onSend, sending = false, showLabel = true }) {
  const [entries, setEntries] = useState(null);
  const [entryFailed, setEntryFailed] = useState(false);
  const [files, setFiles] = useState(null);
  const [peek, setPeek] = useState(null);
  const labelId = useId();
  const entryKey = entryIds.join(',');
  const fileKey = fileIds.join(',');

  useEffect(() => {
    if (!entryIds.length) return undefined;
    let alive = true;
    setEntryFailed(false);
    getEntries(entryIds)
      .then((m) => alive && setEntries(m))
      .catch(() => alive && setEntryFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  useEffect(() => {
    if (!fileIds.length) return undefined;
    let alive = true;
    getFileMap()
      .then((m) => alive && setFiles(m))
      .catch(() => alive && setFiles(new Map()));
    return () => {
      alive = false;
    };
  }, [fileKey]);

  if (!entryIds.length && !fileIds.length) return null;
  // undefined 加载中，null 已删除
  const entryOf = (id) => (entries?.has(id) ? entries.get(id) : cachedEntry(id));
  const fileOf = (id) => (files ? files.get(id) ?? null : undefined);
  const sendable = files ? fileIds.map((id) => files.get(id)).filter((f) => f && f.status === 'active') : [];

  return (
    <div className="draft__basis">
      {showLabel && (
        <span className="draft__basis-label" id={labelId}>
          依据
        </span>
      )}
      <ul
        className="draft__refs"
        aria-labelledby={showLabel ? labelId : undefined}
        aria-label={showLabel ? undefined : '草稿建议发送的文件'}
      >
        {entryIds.map((id) => (
          <li key={`e:${id}`}>
            <EntryChip id={id} entry={entryOf(id)} error={entryFailed} onOpenFull={setPeek} />
          </li>
        ))}
        {fileIds.map((id) => (
          <li key={`f:${id}`}>
            <FileChip file={fileOf(id)} />
          </li>
        ))}
      </ul>
      {onSend && fileIds.length > 0 && (
        <button type="button" className="btn btn--sm" onClick={() => onSend(sendable)} disabled={sending || !sendable.length}>
          {sending ? <Spinner /> : <SendHorizontal />}
          发送文件
        </button>
      )}
      <EntryPeek entryId={peek} onClose={() => setPeek(null)} />
    </div>
  );
}
