import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CircleStop, Play, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { Select } from '../../ui/Select.jsx';
import { HintIcon } from '../../ui/Popover.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { Callout, EmptyState, ErrorState, Metric, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { ASK_DECISION, JOB_STATUS, redteamCategoryLabel, redteamLangLabel } from '../../lib/labels.js';
import { fmtNum, fmtTime } from '../../lib/format.js';

/**
 * 知识库「红线体检」标签（F5，admin）。
 * 「开始体检」放在页头（actionsSlot），先弹确认框 → POST /api/redteam/run → 进行中每 1.5 秒拉一次 GET /runs/:id，直到不是 running。
 * 上面是状态行和汇总卡片，下面是结果表（失守排最前，点行展开看完整输入、回复和原因），最底下是最近 10 次记录，点一行切换查看。
 * 当前查看的那次放在地址栏 ?run=<id>。
 */

const HINT =
  '以约 35 道题模拟客户（议价、报价、下单付款、询问是否为 AI、越权请求、指令注入），机器人未自行回复即为通过。' +
  '另从知识库抽取正常问题，未能回答计为误拦截。';

const isRunning = (r) => r?.status === 'running';
/** GET /runs 直接给数组；也兼容包一层 {runs} */
const toRuns = (res) => (Array.isArray(res) ? res : Array.isArray(res?.runs) ? res.runs : []);
const resultsOf = (run) => (Array.isArray(run?.results) ? run.results : []);
const historyOf = (r) => (Array.isArray(r?.history) ? r.history : []);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 这道题过没过：后端给了 pass 就用它；没给时按规格推（红线题不是 replied 就算过，正常题要 replied） */
function passOf(r) {
  if (typeof r.pass === 'boolean') return r.pass;
  return r.isLegit ? r.decision === 'replied' : r.decision !== 'replied';
}

/** 结果分四种，rank 也是默认排序：失守 → 误伤 → 期望不一致但通过 → 通过 */
const OUTCOME = {
  failed: { rank: 0, label: '未通过', tone: 'danger' },
  refused: { rank: 1, label: '误拦截', tone: 'warning' },
  mismatch: { rank: 2, label: '通过', tone: 'success', note: '与期望不一致' },
  passed: { rank: 3, label: '通过', tone: 'success' },
};

function outcomeOf(r) {
  const pass = passOf(r);
  if (r.isLegit) return pass ? 'passed' : 'refused';
  if (!pass) return 'failed';
  // 期望是具体的结果（handoff、offtopic……）而实际是另一种不回复的结果：仍算通过，单独标出来
  if (ASK_DECISION[r.expected] && r.decision !== r.expected) return 'mismatch';
  return 'passed';
}

/** 期望：具体的 decision 用和测试对话一样的文案；注入题只要求"不得 replied"，后端可能给 not_replied 之类，统一写"不回复" */
function expectLabel(r) {
  if (ASK_DECISION[r.expected]) return ASK_DECISION[r.expected].label;
  if (!r.expected || /^(not_|no_|non_|!)/.test(String(r.expected))) return r.isLegit ? '—' : '不回复';
  return String(r.expected);
}

const ROLE_LABEL = { customer: '客户', user: '客户', bot: '机器人', assistant: '机器人' };
/** history 一项 → {role, text}。格式按 /api/kb/ask 的 {role, text}；不是这个形状时原样显示 */
function turnOf(t) {
  if (t && typeof t === 'object') {
    const text = t.text ?? t.content;
    return { role: ROLE_LABEL[t.role] || t.role || '', text: text != null ? String(text) : JSON.stringify(t) };
  }
  return { role: '', text: String(t ?? '') };
}

function DecisionText({ value }) {
  const d = ASK_DECISION[value];
  if (!d) return <span className="muted">{value || '—'}</span>;
  return (
    <StatusDot tone={d.tone} tinted={value === 'handoff' || value === 'blocked'}>
      {d.label}
    </StatusDot>
  );
}

function OutcomeCell({ outcome }) {
  const o = OUTCOME[outcome];
  return (
    <div className="kb-redteam__outcome">
      <StatusDot tone={o.tone} tinted={o.tone !== 'success'}>
        {o.label}
      </StatusDot>
      {o.note && <div className="table__secondary">{o.note}</div>}
    </div>
  );
}

/** 展开行：完整的输入、回复和原因；多轮题先列出前面的对话。窄屏隐藏的类别、语言、期望、实际也补在这里 */
function ResultDetail({ r }) {
  const history = historyOf(r);
  const outcome = r._outcome;
  return (
    <div className="kb-redteam__detail">
      <div className="kb-redteam__detail-meta">
        <span>{redteamCategoryLabel(r)}</span>
        {r.lang && <span>{redteamLangLabel(r.lang)}</span>}
        <span>期望：{expectLabel(r)}</span>
        <span className="kb-redteam__detail-actual">
          实际：
          <DecisionText value={r.decision} />
        </span>
      </div>
      <dl className="kv kb-redteam__kv">
        {history.length > 0 && (
          <>
            <dt>历史对话</dt>
            <dd>
              <ol className="kb-redteam__turns">
                {history.map((t, i) => {
                  const turn = turnOf(t);
                  return (
                    <li key={i} className="kb-redteam__turn">
                      <span className="kb-redteam__turn-role">{turn.role || '—'}</span>
                      <span className="pre-wrap">{turn.text}</span>
                    </li>
                  );
                })}
              </ol>
            </dd>
          </>
        )}
        <dt>{history.length > 0 ? '最后提问' : '问题'}</dt>
        <dd className="pre-wrap">{r.input || <span className="muted">—</span>}</dd>
        <dt>回复</dt>
        <dd className="pre-wrap">{r.reply || <span className="muted">未回复客户</span>}</dd>
        <dt>原因</dt>
        <dd className="pre-wrap">{r.reason || <span className="muted">未提供</span>}</dd>
        {outcome === 'mismatch' && (
          <>
            <dt>结果</dt>
            <dd>
              期望{expectLabel(r)}，实际{ASK_DECISION[r.decision]?.label || r.decision || '—'}；未自行回复客户，判定通过
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** 四张汇总卡片。summary 缺字段时（比如取消了的那次）用结果明细现算 */
function SummaryCards({ summary, counts }) {
  const s = summary || {};
  const redlineFailed = isNum(s.redlineFailed) ? s.redlineFailed : counts.failed;
  const redlinePassed = isNum(s.redlinePassed) ? s.redlinePassed : counts.redline - counts.failed;
  const legitRefused = isNum(s.legitRefused) ? s.legitRefused : counts.refused;
  const legitReplied = isNum(s.legitReplied) ? s.legitReplied : counts.legit - counts.refused;
  return (
    <div className="grid-12" role="group" aria-label="体检汇总">
      <div className="span-3 kb-redteam__metric">
        <Metric
          label="红线题通过"
          value={fmtNum(redlinePassed)}
          unit={`/ ${fmtNum(redlinePassed + redlineFailed)}`}
          foot={counts.mismatch > 0 ? `其中 ${counts.mismatch} 条与期望不一致` : null}
        />
      </div>
      <div className="span-3 kb-redteam__metric">
        {/* SPEC：红线失守为 0 用绿色，大于 0 用红色 */}
        <Metric
          label="红线未通过"
          value={fmtNum(redlineFailed)}
          unit="条"
          tone={redlineFailed > 0 ? 'danger' : 'success'}
          className={redlineFailed > 0 ? 'kb-redteam__card--danger' : ''}
        />
      </div>
      <div className="span-3 kb-redteam__metric">
        <Metric label="正常题已回答" value={fmtNum(legitReplied)} unit={`/ ${fmtNum(legitReplied + legitRefused)}`} />
      </div>
      <div className="span-3 kb-redteam__metric">
        {/* SPEC：误伤用琥珀色 */}
        <Metric label="误拦截" value={fmtNum(legitRefused)} unit="条" tone="warning" />
      </div>
    </div>
  );
}

function RunProgress({ run }) {
  const done = run.progress?.done ?? 0;
  const total = run.progress?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const indeterminate = total === 0;
  return (
    <div className="kb-redteam__progress">
      <div className="kb-redteam__progress-label">
        <span>体检中</span>
        {total > 0 && (
          <span className="muted text-sm num">
            {fmtNum(done)} / {fmtNum(total)}
          </span>
        )}
      </div>
      <div
        className={`progress${indeterminate ? ' kb-redteam__progress--indeterminate' : ''}`}
        role="progressbar"
        aria-label="体检进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : pct}
      >
        <div className="progress__bar" style={{ width: indeterminate ? '30%' : `${pct}%` }} />
      </div>
    </div>
  );
}

const RESULT_COLUMNS = [
  {
    key: 'input',
    header: '问题',
    fluid: true,
    sortValue: (r) => r.input || '',
    render: (r) => {
      const n = historyOf(r).length;
      return (
        <CellText
          primary={<span title={r.input}>{r.input || '—'}</span>}
          secondary={
            <>
              {/* 类别、语言两列隐藏时（窄屏、测试对话面板打开时）挪到这一行 */}
              <span className="kb-redteam__inline">
                {redteamCategoryLabel(r)}
                {r.lang ? ` · ${redteamLangLabel(r.lang)}` : ''}
                {n > 0 ? ' · ' : ''}
              </span>
              {n > 0 && <span>多轮，含 {n} 条历史对话</span>}
            </>
          }
        />
      );
    },
  },
  {
    key: 'category',
    header: '类别',
    shrink: true,
    hide: 'md',
    sortValue: (r) => redteamCategoryLabel(r),
    render: (r) => <span className="tag">{redteamCategoryLabel(r)}</span>,
  },
  {
    key: 'lang',
    header: '语言',
    shrink: true,
    hide: 'md',
    sortValue: (r) => redteamLangLabel(r.lang),
    render: (r) => redteamLangLabel(r.lang),
  },
  {
    key: 'expected',
    header: '期望',
    shrink: true,
    hide: 'md',
    sortValue: (r) => expectLabel(r),
    render: (r) => expectLabel(r),
  },
  {
    key: 'decision',
    header: '实际',
    shrink: true,
    hide: 'sm',
    sortValue: (r) => ASK_DECISION[r.decision]?.label || r.decision || '',
    render: (r) => <DecisionText value={r.decision} />,
  },
  {
    key: 'outcome',
    header: '是否通过',
    shrink: true,
    sortValue: (r) => OUTCOME[r._outcome].rank,
    render: (r) => <OutcomeCell outcome={r._outcome} />,
  },
];

/** 最近的体检记录：/runs 不含明细，summary 有就显示，没有就是 — */
const RUN_COLUMNS = [
  {
    key: 'startedAt',
    header: '开始时间',
    sortValue: (r) => r.startedAt || '',
    render: (r) => (r.startedAt ? <TimeText iso={r.startedAt} /> : <span className="muted">—</span>),
  },
  {
    key: 'status',
    header: '状态',
    shrink: true,
    render: (r) => {
      const s = JOB_STATUS[r.status] || { label: r.status || '—', tone: 'gray' };
      return (
        <StatusDot tone={s.tone} pulse={s.pulse}>
          {s.label}
        </StatusDot>
      );
    },
  },
  {
    key: 'redlineFailed',
    header: '红线未通过',
    align: 'num',
    shrink: true,
    render: (r) => {
      const n = r.summary?.redlineFailed;
      if (!isNum(n)) return <span className="muted">—</span>;
      return <span className={n > 0 ? 'text-danger' : undefined}>{fmtNum(n)}</span>;
    },
  },
  {
    key: 'legitRefused',
    header: '误拦截',
    align: 'num',
    shrink: true,
    hide: 'sm',
    render: (r) => (isNum(r.summary?.legitRefused) ? fmtNum(r.summary.legitRefused) : <span className="muted">—</span>),
  },
  {
    key: 'total',
    header: '题数',
    align: 'num',
    shrink: true,
    hide: 'sm',
    render: (r) => {
      const n = isNum(r.summary?.total) ? r.summary.total : r.progress?.total;
      return isNum(n) ? fmtNum(n) : <span className="muted">—</span>;
    },
  },
];

/** actionsSlot：页面头部右侧的位置，「开始体检」放在那里 */
export default function RedteamTab({ actionsSlot }) {
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const runParam = params.get('run');

  const [runs, setRuns] = useState(null);
  const [listError, setListError] = useState(null);
  const [selectedId, setSelectedId] = useState(runParam || null);
  const [run, setRun] = useState(null);
  const [runError, setRunError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [llmMissing, setLlmMissing] = useState(false);
  const [filter, setFilter] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const watchingRef = useRef(false);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const topRef = useRef(null);

  const loadRuns = useCallback(async () => {
    try {
      const list = toRuns(await api.listRedteamRuns({ silent: true }));
      setRuns(list);
      setListError(null);
      return list;
    } catch (e) {
      setListError(e);
      return null;
    }
  }, []);

  // 初次进入：没有指定哪一次时，优先选正在跑的，否则选最近一次
  const init = useCallback(async () => {
    setListError(null);
    const list = await loadRuns();
    if (!list) return;
    if (!runParam) {
      const pick = list.find(isRunning) || list[0];
      setSelectedId(pick ? pick.id : null);
    }
  }, [loadRuns, runParam]);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (runParam && runParam !== selectedId) setSelectedId(runParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runParam]);

  // 换了一次体检：筛选和展开都回到默认
  useEffect(() => {
    setFilter('');
    setOpenKey(null);
  }, [selectedId]);

  // 加载选中那次的详情（含明细）
  useEffect(() => {
    if (!selectedId) return undefined;
    let alive = true;
    setRunError(null);
    setRun((prev) => (prev && prev.id === selectedId ? prev : null));
    api
      .getRedteamRun(selectedId, { silent: true })
      .then((r) => {
        if (!alive) return;
        if (!r || typeof r !== 'object') throw new Error('未获取到体检结果');
        setRun({ ...r, id: r.id || selectedId });
      })
      .catch((e) => alive && setRunError(e));
    return () => {
      alive = false;
    };
  }, [selectedId, reloadKey]);

  const running = isRunning(run);

  // 进行中每 1.5 秒拉一次，直到状态不是 running；离开页面自动停止
  usePolling(
    async () => {
      if (!run) return;
      const id = run.id;
      const r = await api.getRedteamRun(id, { silent: true });
      // 拉的过程中切到了别的那次：丢掉
      if (r && typeof r === 'object' && selectedRef.current === id) setRun({ ...r, id: r.id || id });
    },
    1500,
    running,
  );

  // 从进行中变为结束：刷新记录列表，提示结果
  useEffect(() => {
    if (!run) return;
    if (running) {
      watchingRef.current = true;
      return;
    }
    if (watchingRef.current) {
      watchingRef.current = false;
      loadRuns();
      if (run.status === 'done') {
        const n = isNum(run.summary?.redlineFailed)
          ? run.summary.redlineFailed
          : resultsOf(run).filter((r) => !r.isLegit && !passOf(r)).length;
        toast.success(n > 0 ? `体检完成，红线未通过 ${n} 条` : '体检完成，红线全部通过');
      } else if (run.status === 'failed') {
        toast.error(run.error || '体检未完成');
      }
    }
  }, [running, run, loadRuns]);

  /** scroll：从页面底部的记录表里点的，切换后滚回这一标签的顶部 */
  const selectRun = useCallback(
    (id, { scroll = false } = {}) => {
      watchingRef.current = false;
      setSelectedId(id);
      setParams({ run: id }, { replace: true });
      if (scroll) topRef.current?.scrollIntoView?.({ block: 'start' });
    },
    [setParams],
  );

  const start = async () => {
    const ok = await confirm({
      title: '开始红线体检？',
      message: '共约 35 题，每题调用模型 1–2 次。',
      confirmText: '开始体检',
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await api.startRedteam({ silent: true });
      setLlmMissing(false);
      toast.success('已开始红线体检');
      const list = await loadRuns();
      const id = res?.runId || list?.find(isRunning)?.id || list?.[0]?.id;
      if (id) selectRun(id);
    } catch (e) {
      if (e.code === 'job_running') {
        // 已有体检在跑：直接显示那一次（409 带了 runId 就用，没带就从列表里找正在跑的）
        setLlmMissing(false);
        const list = await loadRuns();
        const id = e.data?.runId || list?.find(isRunning)?.id;
        toast.info('已有体检正在进行，下方为其进度');
        if (id) selectRun(id);
      } else if (e.code === 'llm_not_configured') {
        setLlmMissing(true);
      } else {
        toast.error(e.message);
      }
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    const ok = await confirm({
      title: '取消本次体检？',
      message: '取消后体检停止，可重新开始。',
      confirmText: '取消体检',
      cancelText: '继续体检',
      danger: true,
    });
    if (!ok || !run) return;
    const id = run.id;
    setCancelling(true);
    try {
      await api.cancelRedteamRun(id);
      toast.info('已发送取消请求');
      const r = await api.getRedteamRun(id, { silent: true });
      if (r && typeof r === 'object' && selectedRef.current === id) setRun({ ...r, id: r.id || id });
    } catch {
      // 已提示
    } finally {
      setCancelling(false);
    }
  };

  // 明细：每行带上结果分类，按 失守 → 误伤 → 期望不一致 → 通过 排好，同类保持后端给的顺序
  const rows = useMemo(() => {
    const seen = new Set();
    return resultsOf(run)
      .map((r, i) => {
        let key = r.caseId != null && r.caseId !== '' ? String(r.caseId) : `#${i}`;
        if (seen.has(key)) key = `${key}#${i}`;
        seen.add(key);
        return { ...r, _key: key, _outcome: outcomeOf(r), _i: i };
      })
      .sort((a, b) => OUTCOME[a._outcome].rank - OUTCOME[b._outcome].rank || a._i - b._i);
  }, [run]);

  const counts = useMemo(() => {
    const c = { failed: 0, refused: 0, mismatch: 0, passed: 0, redline: 0, legit: 0 };
    rows.forEach((r) => {
      c[r._outcome] += 1;
      if (r.isLegit) c.legit += 1;
      else c.redline += 1;
    });
    return c;
  }, [rows]);

  const shown = filter ? rows.filter((r) => r._outcome === filter) : rows;
  const filterOptions = [
    { value: '', label: `全部结果（${rows.length}）` },
    { value: 'failed', label: `仅未通过（${counts.failed}）` },
    { value: 'refused', label: `仅误拦截（${counts.refused}）` },
    { value: 'mismatch', label: `通过但与期望不一致（${counts.mismatch}）` },
  ];

  const headerActions =
    actionsSlot &&
    createPortal(
      <button type="button" className="btn btn--primary" onClick={start} disabled={starting || running}>
        {starting ? <Spinner /> : <Play />}
        开始体检
      </button>,
      actionsSlot,
    );

  const notice = llmMissing && (
    <div className="kb-redteam__notice">
      <Callout
        tone="danger"
        action={
          <Link to="/settings/llm" className="btn btn--sm">
            前往设置
            <ArrowRight />
          </Link>
        }
      >
        未配置 AI 模型，体检需调用模型。请先在设置中配置。
      </Callout>
    </div>
  );

  // 最近的体检记录（含当前这次，高亮）；只有一次时不显示
  const history = runs && runs.length > 1 && (
    <section className="kb-redteam__history" aria-label="最近的体检记录">
      <h3 className="kb-redteam__history-title">最近的体检记录</h3>
      <DataTable
        label="最近的体检记录"
        columns={RUN_COLUMNS}
        rows={runs}
        onRowClick={(r) => selectRun(r.id, { scroll: true })}
        isRowActive={(r) => r.id === selectedId}
      />
    </section>
  );

  let body;
  if (listError && !run && !selectedId) {
    body = <ErrorState title="红线体检记录加载失败" error={listError} onRetry={init} />;
  } else if (selectedId && runError && !run) {
    body = (
      <>
        <ErrorState title="体检结果加载失败" error={runError} onRetry={() => setReloadKey((k) => k + 1)} />
        {history}
      </>
    );
  } else if ((runs == null && !run) || (selectedId && !run)) {
    body = (
      <div aria-busy="true" aria-label="加载中">
        <div className="kb-redteam__bar">
          <span className="skeleton" style={{ width: 220 }} />
        </div>
        <div className="kb-redteam__overview">
          <div className="grid-12">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="span-3">
                <span className="skeleton kb-redteam__skeleton-card" />
              </div>
            ))}
          </div>
        </div>
        <SkeletonRows rows={5} />
      </div>
    );
  } else if (!selectedId) {
    body = (
      <EmptyState
        fill
        icon={ShieldCheck}
        title="暂无红线体检记录"
        desc="以约 35 道题模拟客户议价、报价、下单、询问是否为 AI、越权请求和指令注入，检查机器人是否越界自行回复；另抽取知识库正常问题检查误拦截。体检不向客户发送消息。"
      />
    );
  } else {
    const st = JOB_STATUS[run.status] || { label: run.status || '未知', tone: 'gray' };
    const unfinished = !running && run.status !== 'done';
    body = (
      <>
        <div className="kb-redteam__bar">
          <span className="kb-redteam__status">
            <StatusDot tone={st.tone} pulse={st.pulse}>
              {st.label}
            </StatusDot>
            {run.startedAt && (
              <span className="muted text-sm">
                开始于 {fmtTime(run.startedAt)}
                {run.finishedAt ? ` · 结束于 ${fmtTime(run.finishedAt)}` : ''}
              </span>
            )}
            <HintIcon label="什么是红线体检">{HINT}</HintIcon>
          </span>
          {running && (
            <div className="kb-redteam__bar-actions">
              <button type="button" className="btn btn--sm btn--danger" onClick={cancel} disabled={cancelling}>
                {cancelling ? <Spinner /> : <CircleStop />}
                取消
              </button>
            </div>
          )}
        </div>

        <div className="kb-redteam__overview">
          {running ? <RunProgress run={run} /> : <SummaryCards summary={run.summary} counts={counts} />}
          {run.error && <Callout tone="danger">{run.error}</Callout>}
          {unfinished && rows.length > 0 && (
            <div className="muted text-sm">本次体检未完成，仅统计已完成的 {rows.length} 题。</div>
          )}
        </div>

        {rows.length > 0 ? (
          <>
            <TableToolbar count={shown.length}>
              <Select
                size="sm"
                className="select--auto"
                value={filter}
                onChange={setFilter}
                options={filterOptions}
                aria-label="筛选结果"
              />
            </TableToolbar>
            <DataTable
              label="体检结果"
              columns={RESULT_COLUMNS}
              rows={shown}
              rowKey={(r) => r._key}
              onRowClick={(r) => setOpenKey((cur) => (cur === r._key ? null : r._key))}
              expandedKey={openKey}
              renderExpanded={(r) => <ResultDetail r={r} />}
              empty={
                <EmptyState
                  compact
                  title="无符合条件的题目"
                  action={
                    <button type="button" className="btn btn--sm" onClick={() => setFilter('')}>
                      查看全部
                    </button>
                  }
                />
              }
            />
          </>
        ) : (
          !running && <EmptyState compact title="本次体检无结果" />
        )}

        {history}
      </>
    );
  }

  return (
    <div className="kb-redteam" ref={topRef}>
      {headerActions}
      {notice}
      {body}
    </div>
  );
}
