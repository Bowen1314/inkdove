import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, EyeOff, Save } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { DataTable, CellText, TableToolbar } from '../../ui/DataTable.jsx';
import { Select } from '../../ui/Select.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { EmptyState, ErrorState, Field, Spinner } from '../../ui/common.jsx';
import { clearEntryCache } from '../../lib/entryCache.js';
import { TimeText } from '../../ui/TimeText.jsx';

const ORIGIN_LABEL = { conversation: '来自会话', distill: '蒸馏时发现' };
const ORIGIN_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'conversation', label: '来自会话' },
  { value: 'distill', label: '蒸馏时发现' },
];

/** F2c：来自会话的缺口带次数；整理时发现的缺口只有被客户再问到（count>1）才显示次数 */
function countOf(gap) {
  const count = Number(gap.count) || 0;
  return count > 0 && (gap.origin === 'conversation' || count > 1) ? count : null;
}

const chatLink = (gap) => `/whatsapp/chats?${new URLSearchParams({ chat: gap.conversationId }).toString()}`;
const fromChat = (gap) => gap.origin === 'conversation' && !!gap.conversationId;

function OriginCell({ gap }) {
  if (!gap.origin) return <span className="muted">—</span>;
  return (
    <span className="hstack nowrap">
      <span>{ORIGIN_LABEL[gap.origin] || gap.origin}</span>
      {fromChat(gap) && (
        <Link to={chatLink(gap)} className="btn btn--link btn--sm">
          打开会话
        </Link>
      )}
    </span>
  );
}

/** 展开行：填答案生成条目，或忽略 */
function GapAnswer({ gap, value, onChange, busy, onSubmit, onDismiss }) {
  const id = `gap-answer-${gap.id}`;
  const count = countOf(gap);
  return (
    <div className="kb-gap">
      <div className="kb-gap__meta">
        <TimeText iso={gap.createdAt} />
        {count != null && <span>客户问过 {count} 次</span>}
        {fromChat(gap) && (
          <Link to={chatLink(gap)} className="btn btn--link btn--sm">
            打开会话
          </Link>
        )}
      </div>
      <Field label="答案" htmlFor={id}>
        <textarea
          id={id}
          className="textarea"
          rows={3}
          autoFocus
          placeholder="填写答案，保存后生成一条常见问答供机器人使用。"
          value={value}
          disabled={!!busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </Field>
      <div className="kb-gap__actions">
        <Tooltip content="该问题无需回答">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss} disabled={!!busy}>
            {busy === 'dismiss' ? <Spinner /> : <EyeOff />}
            忽略
          </button>
        </Tooltip>
        <button type="button" className="btn btn--primary btn--sm" onClick={onSubmit} disabled={!value.trim() || !!busy}>
          {busy === 'answer' ? <Spinner /> : <Save />}
          生成条目
        </button>
      </div>
    </div>
  );
}

export default function GapsTab({ onChanged }) {
  const [gaps, setGaps] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [origin, setOrigin] = useState('');
  const [openId, setOpenId] = useState(null);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(null); // {id, kind: 'answer'|'dismiss'}

  const load = useCallback(async () => {
    setError(null);
    try {
      setGaps((await api.listGaps('open', { silent: true })) || []);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = (id) => {
    setGaps((prev) => (prev || []).filter((g) => g.id !== id));
    setAnswers(({ [id]: _drop, ...rest }) => rest);
    setOpenId((cur) => (cur === id ? null : cur));
    onChanged?.();
  };

  const submit = async (gap) => {
    const answer = (answers[gap.id] || '').trim();
    if (!answer || busy) return;
    setBusy({ id: gap.id, kind: 'answer' });
    try {
      await api.answerGap(gap.id, answer);
      toast.success('已加入知识库');
      clearEntryCache();
      remove(gap.id);
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (gap) => {
    if (busy) return;
    setBusy({ id: gap.id, kind: 'dismiss' });
    try {
      await api.dismissGap(gap.id);
      toast.info('已忽略');
      remove(gap.id);
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  // F2c 的 count / origin / conversationId：后端有就显示，没有就不出现这一列
  const hasCount = (gaps || []).some((g) => g.count != null);
  const hasOrigin = (gaps || []).some((g) => !!g.origin);

  const shown = useMemo(() => {
    if (!gaps) return null;
    const f = q.trim().toLowerCase();
    return gaps.filter(
      (g) =>
        (!origin || g.origin === origin) &&
        (!f || [g.question, g.reason].some((v) => String(v || '').toLowerCase().includes(f))),
    );
  }, [gaps, q, origin]);

  const columns = useMemo(
    () =>
      [
        {
          key: 'question',
          header: '问题',
          fluid: true,
          sortValue: (g) => g.question,
          render: (g) => <CellText primary={g.question} secondary={g.reason} />,
        },
        hasCount && {
          key: 'count',
          header: '客户问过',
          align: 'num',
          shrink: true,
          hide: 'sm',
          sortValue: (g) => Number(g.count) || 0,
          render: (g) => {
            const n = countOf(g);
            return n != null ? `${n} 次` : <span className="muted">—</span>;
          },
        },
        hasOrigin && {
          key: 'origin',
          header: '来源',
          shrink: true,
          hide: 'md',
          sortValue: (g) => ORIGIN_LABEL[g.origin] || g.origin || '',
          render: (g) => <OriginCell gap={g} />,
        },
        {
          key: 'createdAt',
          header: '时间',
          shrink: true,
          hide: 'md',
          sortValue: (g) => g.createdAt || '',
          render: (g) => <TimeText iso={g.createdAt} />,
        },
      ].filter(Boolean),
    [hasCount, hasOrigin],
  );

  if (error) return <ErrorState error={error} onRetry={load} />;

  const filtering = !!(q.trim() || origin);

  return (
    <>
      <TableToolbar search={q} onSearch={setQ} searchPlaceholder="搜索问题" count={shown ? shown.length : null}>
        {hasOrigin && (
          <Select size="sm" className="select--auto" value={origin} onChange={setOrigin} options={ORIGIN_OPTIONS} aria-label="来源筛选" />
        )}
      </TableToolbar>
      <DataTable
        label="待补充的问题"
        columns={columns}
        rows={shown}
        onRowClick={(g) => setOpenId((cur) => (cur === g.id ? null : g.id))}
        expandedKey={openId}
        renderExpanded={(g) => (
          <GapAnswer
            gap={g}
            value={answers[g.id] || ''}
            onChange={(v) => setAnswers((prev) => ({ ...prev, [g.id]: v }))}
            busy={busy?.id === g.id ? busy.kind : null}
            onSubmit={() => submit(g)}
            onDismiss={() => dismiss(g)}
          />
        )}
        empty={
          filtering ? (
            <EmptyState title="无匹配的问题" />
          ) : (
            <EmptyState
              icon={CheckCircle2}
              title="暂无待补充的问题"
              desc="此处列出蒸馏时发现的缺口，以及客户提问但资料中无答案的问题。"
            />
          )
        }
      />
    </>
  );
}
