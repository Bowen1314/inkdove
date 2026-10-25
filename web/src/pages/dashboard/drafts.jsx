import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookPlus, MessageSquare } from 'lucide-react';
import { api } from '../../api/client.js';
import { ErrorState, Spinner } from '../../ui/common.jsx';
import { HintIcon } from '../../ui/Popover.jsx';
import { Select } from '../../ui/Select.jsx';
import { fmtNum, fmtPct, fmtTime } from '../../lib/format.js';
import { SaveToKbModal } from '../wa/SaveToKbModal.jsx';
import { Legend, TrendChart } from './charts.jsx';
import { Card, Empty, Stat, Sub, arr } from './sections.jsx';

/**
 * 看板的「推荐回复」：每份推荐回复、转人工草稿最后怎么样了（GET /api/dashboard 的 drafts），
 * 和「改得多 / 没用的推荐」列表（GET /api/dashboard/drafts，自己分页拉）。判定规则见 server/src/reply/draft-outcomes.js。
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const enc = encodeURIComponent;

export const DRAFT_OUTCOME_LABELS = {
  used: '直接采用',
  edited: '修改后发送',
  own: '人工撰写',
  dismissed: '已关闭',
  replaced: '已替换',
  unsent: '未发送',
};
const OUTCOME_TONE = { used: 'success', edited: 'warning' };
const UNUSED_KEYS = ['dismissed', 'replaced', 'unsent', 'own'];

/** 趋势图堆叠顺序从下到上 */
const DRAFT_SERIES = [
  { key: 'used', label: '直接采用', color: 'var(--success-dot)' },
  { key: 'edited', label: '修改后发送', color: 'var(--warning-dot)' },
  { key: 'unused', label: '未采用', color: 'var(--danger-dot)' },
  { key: 'pending', label: '待定', color: 'var(--neutral-dot)' },
];

const RULES = (
  <>
    以人工发出的第一条文字消息与草稿比对：仅改动标点、空格或仅填写【待你确认】的计为直接采用；改动少于 75% 计为修改后发送；其余计为人工撰写。
    点击 × 关闭、换一条、起草后 24 小时内未发送（或被机器人、手机端回复、客户新消息清除）均计为未采用。未满 24 小时的不计入比率。
  </>
);

/* ================= 汇总 ================= */

export function DraftsCard({ drafts }) {
  const d = drafts || {};
  const outcomes = d.outcomes || {};
  const total = num(d.total);
  const trend = arr(d.trend);
  const totals = Object.fromEntries(DRAFT_SERIES.map((s) => [s.key, trend.reduce((n, x) => n + num(x[s.key]), 0)]));
  const kinds = arr(d.byKind).filter((k) => num(k.total) > 0);
  const versions = arr(d.byVersion);
  const files = d.files || {};
  return (
    <Card
      title="推荐回复"
      span="span-12"
      aside={
        <span className="dash-card__note">
          判定规则
          <HintIcon label="推荐回复的判定规则">{RULES}</HintIcon>
        </span>
      }
    >
      {total === 0 ? (
        <Empty title="所选时间段内无推荐回复和转人工草稿" desc="统计会话中点击「推荐回复」生成的草稿及机器人转人工时起草的草稿。" />
      ) : (
        <>
          <div className="dash-stats">
            <Stat
              label="直接采用"
              value={fmtPct(d.usedRate)}
              tone="success"
              foot={`${fmtNum(outcomes.used)} 条`}
            />
            <Stat
              label="修改后发送"
              value={fmtPct(d.editedRate)}
              foot={`${fmtNum(outcomes.edited)} 条${d.avgEditRatio == null ? '' : ` · 平均改动 ${fmtPct(d.avgEditRatio)}`}`}
            />
            <Stat
              label="未采用"
              value={fmtPct(d.unusedRate)}
              foot={UNUSED_KEYS.map((k) => `${DRAFT_OUTCOME_LABELS[k]} ${fmtNum(outcomes[k])}`).join(' · ')}
            />
            <Stat
              label="待定"
              value={fmtNum(d.pending)}
              unit="条"
              foot="起草未满 24 小时，不计入比率"
            />
            {num(files.suggested) > 0 && (
              <Stat label="建议文件发送数" value={fmtNum(files.sent)} unit={`/ ${fmtNum(files.suggested)} 个`} />
            )}
          </div>

          <Sub
            title="每日起草量"
            className="dash-sub--wrap"
            aside={<Legend items={DRAFT_SERIES.map((s) => ({ ...s, value: fmtNum(totals[s.key]) }))} />}
          >
            <TrendChart data={trend} series={DRAFT_SERIES} label="每日推荐回复起草量及结果" />
          </Sub>

          <Sub title="按类型" className="dash-sub--rule">
            <div className="dash-scroll">
              <table className="table dash-mini dash-drafts__table">
                <thead>
                  <tr>
                    <th scope="col">类型</th>
                    <th scope="col" className="is-num">
                      起草
                    </th>
                    <th scope="col" className="is-num">
                      直接采用
                    </th>
                    <th scope="col" className="is-num">
                      修改后发送
                    </th>
                    <th scope="col" className="is-num">
                      未采用
                    </th>
                    <th scope="col" className="is-num dash-hide-sm">
                      待定
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {kinds.map((k) => (
                    <tr key={k.kind}>
                      <td className="dash-mini__name">{k.label || k.kind}</td>
                      <td className="is-num">{fmtNum(k.total)}</td>
                      <td className="is-num">{fmtPct(k.usedRate)}</td>
                      <td className="is-num">{fmtPct(k.editedRate)}</td>
                      <td className="is-num">{fmtPct(k.unusedRate)}</td>
                      <td className="is-num dash-hide-sm">{fmtNum(k.pending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sub>

          <Sub
            title="按模型和提示词版本"
            className="dash-sub--rule"
            aside={d.currentPromptVersion && <span className="dash-sub__hint">当前版本 {d.currentPromptVersion}</span>}
          >
            <div className="dash-scroll">
              <table className="table dash-mini dash-drafts__table">
                <thead>
                  <tr>
                    <th scope="col">模型 · 版本</th>
                    <th scope="col" className="is-num">
                      起草
                    </th>
                    <th scope="col" className="is-num">
                      直接采用
                    </th>
                    <th scope="col" className="is-num">
                      修改后发送
                    </th>
                    <th scope="col" className="is-num">
                      未采用
                    </th>
                    <th scope="col" className="is-num dash-hide-sm">
                      平均改动
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={`${v.kind}|${v.model}|${v.promptVersion}`}>
                      <td className="dash-mini__name" title={`${v.firstAt ? fmtTime(v.firstAt) : ''} – ${v.lastAt ? fmtTime(v.lastAt) : ''}`}>
                        <span className="dash-drafts__kind">{v.label || v.kind}</span>
                        {v.model || '未记录模型'} · {v.promptVersion}
                        {v.promptVersion === d.currentPromptVersion && <span className="tag tag--info dash-drafts__current">当前</span>}
                      </td>
                      <td className="is-num">{fmtNum(v.total)}</td>
                      <td className="is-num">{fmtPct(v.usedRate)}</td>
                      <td className="is-num">{fmtPct(v.editedRate)}</td>
                      <td className="is-num">{fmtPct(v.unusedRate)}</td>
                      <td className="is-num dash-hide-sm">{fmtPct(v.avgEditRatio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sub>
        </>
      )}
    </Card>
  );
}

/* ================= 文字对比 ================= */

const TODO_RE = /【待你确认[^】]*】/g;
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const PIECE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]|[\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+/gu;
/** 超过这么多个词不做逐词对比（避免卡界面），两边原样显示 */
const DIFF_MAX = 800;

/** 文字切成片段：词（和后端一样，中日泰等一个字一个词）、占位、其余（标点空白）；词带比较用的 key */
function pieces(text, { placeholders = false } = {}) {
  const out = [];
  const push = (s) => {
    for (const m of s.matchAll(PIECE_RE)) {
      const t = m[0];
      const isWord = DENSE.test(t) || /^[\p{L}\p{N}\p{M}]+$/u.test(t);
      out.push({ text: t, key: isWord ? t.normalize('NFKC').toLowerCase() : null });
    }
  };
  const s = String(text || '');
  if (!placeholders) {
    push(s);
    return out;
  }
  let last = 0;
  for (const m of s.matchAll(TODO_RE)) {
    push(s.slice(last, m.index));
    out.push({ text: m[0], key: null, todo: true });
    last = m.index + m[0].length;
  }
  push(s.slice(last));
  return out;
}

/** 两边的词做最长公共子序列，标出草稿里删掉的（del）和发出时加上的（ins） */
function diffPieces(draft, sent) {
  const a = pieces(draft, { placeholders: true });
  const b = pieces(sent);
  const ai = a.map((p, i) => (p.key ? i : -1)).filter((i) => i >= 0);
  const bi = b.map((p, i) => (p.key ? i : -1)).filter((i) => i >= 0);
  if (ai.length > DIFF_MAX || bi.length > DIFF_MAX) return { a, b, compared: false };
  const n = ai.length;
  const m = bi.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[ai[i]].key === b[bi[j]].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keepA = new Set();
  const keepB = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[ai[i]].key === b[bi[j]].key) {
      keepA.add(ai[i++]);
      keepB.add(bi[j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return {
    a: a.map((p, k) => ({ ...p, mark: p.key && !keepA.has(k) ? 'del' : null })),
    b: b.map((p, k) => ({ ...p, mark: p.key && !keepB.has(k) ? 'ins' : null })),
    compared: true,
  };
}

function Marked({ parts }) {
  return parts.map((p, k) =>
    p.todo ? (
      <mark key={k} className="dash-draft__todo">
        {p.text}
      </mark>
    ) : p.mark === 'del' ? (
      <del key={k} className="dash-draft__del">
        {p.text}
      </del>
    ) : p.mark === 'ins' ? (
      <ins key={k} className="dash-draft__ins">
        {p.text}
      </ins>
    ) : (
      <span key={k}>{p.text}</span>
    ),
  );
}

/* ================= 列表 ================= */

const FILTERS = [
  { value: 'all', label: '已修改和未采用（不含未发送）' },
  { value: 'edited', label: '修改后发送' },
  { value: 'own', label: '人工撰写' },
  { value: 'dismissed', label: '已关闭' },
  { value: 'replaced', label: '已替换' },
  { value: 'unsent', label: '未发送' },
];

function DraftItem({ item, onSaveToKb }) {
  const sent = item.sentText != null && item.sentText !== '';
  const diff = useMemo(() => (sent ? diffPieces(item.text, item.sentText) : null), [item.text, item.sentText, sent]);
  const who = item.contactName || (item.contactNumber ? `+${item.contactNumber}` : '客户');
  const tone = OUTCOME_TONE[item.outcome];
  return (
    <li className="dash-draft">
      <div className="dash-draft__head">
        <span className={`tag${tone ? ` tag--${tone}` : ''}`}>{item.outcomeLabel || DRAFT_OUTCOME_LABELS[item.outcome] || item.outcome}</span>
        {item.editRatio != null && (item.outcome === 'edited' || item.outcome === 'own') && (
          <span className="dash-draft__meta num">改动 {fmtPct(item.editRatio)}</span>
        )}
        <span className="dash-draft__who" title={who}>
          {who}
        </span>
        <span className="dash-draft__meta">
          {item.kindLabel}
          {item.followUp ? '（跟进）' : ''}
          {item.accountName ? ` · ${item.accountName}` : ''} · {fmtTime(item.createdAt)}
        </span>
      </div>
      <div className="dash-draft__cols">
        <div className="dash-draft__col">
          <div className="dash-draft__label">客户提问</div>
          <div className="dash-draft__text dash-draft__text--muted">{item.question || '—'}</div>
        </div>
        <div className="dash-draft__col">
          <div className="dash-draft__label">AI 草稿</div>
          <div className="dash-draft__text">{diff ? <Marked parts={diff.a} /> : item.text || <span className="muted">（仅文件）</span>}</div>
        </div>
        <div className="dash-draft__col">
          <div className="dash-draft__label">
            实际发出
            {item.sentMessage?.revoked && <span className="tag dash-draft__revoked">已撤回</span>}
          </div>
          <div className="dash-draft__text">
            {diff ? <Marked parts={diff.b} /> : <span className="muted">未发送该草稿</span>}
          </div>
        </div>
      </div>
      {(arr(item.entries).length > 0 || arr(item.files).length > 0) && (
        <div className="dash-draft__refs">
          {arr(item.entries).length > 0 && <span className="dash-draft__label">引用的条目</span>}
          {arr(item.entries).map((e) =>
            e.deleted ? (
              <span key={e.id} className="tag">
                已删除的条目
              </span>
            ) : (
              <Link key={e.id} className="link dash-draft__ref" to={`/kb/entries?edit=${enc(e.id)}`} title={e.title || ''}>
                {e.title || '未命名条目'}
              </Link>
            ),
          )}
          {arr(item.files).length > 0 && <span className="dash-draft__label">建议的文件</span>}
          {arr(item.files).map((f) => (
            <span key={f.id} className={`tag${f.sent ? ' tag--success' : ''}`} title={f.sent ? '已发送' : '未发送'}>
              {f.deleted ? '已删除的文件' : f.name || '未命名文件'}
              {f.sent ? ' · 已发' : ''}
            </span>
          ))}
        </div>
      )}
      <div className="dash-draft__actions">
        {item.conversationExists && (
          <Link className="btn btn--sm" to={`/whatsapp/chats?chat=${enc(item.conversationId)}`}>
            <MessageSquare aria-hidden="true" />
            打开会话
          </Link>
        )}
        {item.sentMessage?.canSaveToKb && (
          <button type="button" className="btn btn--sm" onClick={() => onSaveToKb(item)}>
            <BookPlus aria-hidden="true" />
            存入知识库
          </button>
        )}
      </div>
    </li>
  );
}

export function DraftListCard({ range, accountId, assigneeId, tz, reloadKey }) {
  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const [kbItem, setKbItem] = useState(null);

  const query = { range, accountId: accountId || undefined, assigneeId: assigneeId || undefined, tz, filter };

  useEffect(() => {
    const ctrl = new AbortController();
    setState('loading');
    setError(null);
    api
      .getDashboardDrafts(query, { silent: true, signal: ctrl.signal })
      .then((res) => {
        setItems(arr(res?.items));
        setNextCursor(res?.nextCursor || null);
        setState('ready');
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setItems([]);
        setNextCursor(null);
        setError(e);
        setState('error');
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, accountId, assigneeId, tz, filter, reloadKey, retry]);

  const loadMore = async () => {
    if (!nextCursor || more) return;
    setMore(true);
    try {
      const res = await api.getDashboardDrafts({ ...query, cursor: nextCursor });
      const seen = new Set(items.map((x) => x.id));
      setItems((prev) => [...prev, ...arr(res?.items).filter((x) => !seen.has(x.id))]);
      setNextCursor(res?.nextCursor || null);
    } catch {
      // 已提示
    } finally {
      setMore(false);
    }
  };

  let body;
  if (state === 'error') {
    body = <ErrorState compact title="列表加载失败" error={error} onRetry={() => setRetry((k) => k + 1)} />;
  } else if (state === 'loading' && items.length === 0) {
    body = (
      <div className="dash-drafts__loading">
        <Spinner />
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <Empty
        title={filter === 'all' ? '所选时间段内无已修改或未采用的推荐' : `所选时间段内无「${FILTERS.find((f) => f.value === filter)?.label}」的推荐`}
        desc="不含直接采用的推荐。"
      />
    );
  } else {
    body = (
      <>
        <ol className={`dash-drafts__list${state === 'loading' ? ' is-refreshing' : ''}`} aria-label="改动较大和未采用的推荐">
          {items.map((item) => (
            <DraftItem key={item.id} item={item} onSaveToKb={setKbItem} />
          ))}
        </ol>
        {nextCursor && (
          <div className="dash-drafts__more">
            <button type="button" className="btn btn--sm" onClick={loadMore} disabled={more}>
              {more && <Spinner />}
              加载更多
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <Card
      title="改动较大 / 未采用的推荐"
      span="span-12"
      aside={
        <Select
          className="select--auto"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={FILTERS}
          aria-label="按结果筛选"
        />
      }
    >
      {body}
      <SaveToKbModal
        conv={kbItem ? { contactName: kbItem.contactName, contactNumber: kbItem.contactNumber } : null}
        convId={kbItem?.conversationId}
        message={kbItem ? { id: kbItem.sentMessage.id, text: kbItem.sentText } : null}
        question={kbItem?.question || ''}
        onClose={() => setKbItem(null)}
      />
    </Card>
  );
}
