import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, CircleStop, ListChecks, RefreshCcw, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { DataTable } from '../../ui/DataTable.jsx';
import { Callout, EmptyState, ErrorState, Spinner } from '../../ui/common.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { clearEntryCache } from '../../lib/entryCache.js';
import { JOB_MODE, JOB_STATUS, PHASES } from '../../lib/labels.js';
import { fmtClock, fmtNum, fmtTime } from '../../lib/format.js';
import { DistillStatus, useDistillActions } from './DistillBar.jsx';
import { TimeText } from '../../ui/TimeText.jsx';

const isActive = (j) => j && (j.status === 'queued' || j.status === 'running');

/** 横向阶段步骤条 */
function PhaseSteps({ job }) {
  const idx = Math.max(0, PHASES.findIndex((p) => p.value === job.phase));
  const finished = job.status === 'done';
  return (
    <ol className="steps kb-distill__steps" aria-label="整理阶段">
      {PHASES.map((p, i) => {
        let state = 'todo';
        if (finished || i < idx) state = 'done';
        else if (i === idx) {
          if (job.status === 'failed') state = 'failed';
          else if (job.status === 'cancelled') state = 'stopped';
          else if (job.status === 'queued') state = 'todo';
          else state = 'current';
        }
        const cls = [
          'steps__item',
          state === 'done' && 'is-done',
          (state === 'current' || state === 'failed' || state === 'stopped') && 'is-current',
          state === 'failed' && 'is-failed',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <li key={p.value} className={cls} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="steps__index">
              {state === 'done' ? <Check aria-hidden="true" /> : state === 'failed' ? <X aria-hidden="true" /> : i + 1}
            </span>
            <span className="kb-distill__step-label">{p.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 等宽日志框：高 320，可滚动；停在底部时有新日志自动滚到底 */
function LogView({ log }) {
  const ref = useRef(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log?.length]);

  return (
    <div className="code-box kb-log" ref={ref} onScroll={onScroll} tabIndex={0} role="log" aria-label="处理日志">
      {log?.length ? (
        log.map((l, i) => (
          <div key={i} className={`kb-log__line kb-log__line--${l.level}`}>
            <span className="kb-log__ts">{fmtClock(l.ts)}</span>
            <span className="kb-log__msg">{l.msg}</span>
          </div>
        ))
      ) : (
        <span className="muted">暂无日志</span>
      )}
    </div>
  );
}

const JOB_COLUMNS = [
  {
    key: 'mode',
    header: '方式',
    sortValue: (j) => JOB_MODE[j.mode] || j.mode,
    render: (j) => <span className="text-strong">{JOB_MODE[j.mode] || j.mode}</span>,
  },
  {
    key: 'status',
    header: '状态',
    shrink: true,
    sortValue: (j) => j.status,
    render: (j) => {
      const s = JOB_STATUS[j.status] || { label: j.status, tone: 'gray' };
      return (
        <StatusDot tone={s.tone} pulse={s.pulse}>
          {s.label}
        </StatusDot>
      );
    },
  },
  {
    key: 'startedAt',
    header: '开始时间',
    shrink: true,
    sortValue: (j) => j.startedAt || '',
    render: (j) => (j.startedAt ? <TimeText iso={j.startedAt} /> : <span className="muted">未开始</span>),
  },
  {
    key: 'stats',
    header: '结果',
    hide: 'sm',
    render: (j) => (
      <span className="muted num nowrap">
        新增 {j.stats?.entriesAdded ?? 0} · 合并 {j.stats?.entriesMerged ?? 0} · 待补充 {j.stats?.gapsFound ?? 0}
      </span>
    ),
  },
];

/** actionsSlot：页面头部右侧的位置，"全部重建""开始整理"放在那里 */
export default function DistillTab({ onChanged, actionsSlot }) {
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const jobParam = params.get('job');
  const distill = useDistillActions();
  const reloadSources = distill.reload;

  const [jobs, setJobs] = useState(null);
  const [selectedId, setSelectedId] = useState(jobParam || null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const watchingRef = useRef(false);

  const loadJobs = useCallback(async () => {
    try {
      const list = (await api.listJobs({ silent: true })) || [];
      setJobs(list);
      return list;
    } catch (e) {
      setError(e);
      return null;
    }
  }, []);

  // 初次进入：没有指定任务时，优先选正在跑的，否则选列表第一个（最近一次）
  const init = useCallback(async () => {
    setError(null);
    const list = await loadJobs();
    if (!list) return;
    if (!jobParam) {
      const pick = list.find(isActive) || list[0];
      setSelectedId(pick ? pick.id : null);
    }
  }, [loadJobs, jobParam]);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (jobParam && jobParam !== selectedId) setSelectedId(jobParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobParam]);

  // 加载选中任务的详情（含日志）
  useEffect(() => {
    if (!selectedId) return undefined;
    let alive = true;
    setJob((prev) => (prev && prev.id === selectedId ? prev : null));
    api
      .getJob(selectedId, { silent: true })
      .then((j) => alive && setJob(j))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const active = isActive(job);

  // 进行中每 1.5 秒拉一次；离开页面自动停止
  usePolling(
    async () => {
      if (!job) return;
      const j = await api.getJob(job.id, { silent: true });
      setJob(j);
    },
    1500,
    active,
  );

  // 任务从进行中变为结束：刷新统计、条目缓存、任务列表和资料的整理状态
  useEffect(() => {
    if (!job) return;
    if (active) {
      watchingRef.current = true;
      return;
    }
    if (watchingRef.current) {
      watchingRef.current = false;
      clearEntryCache();
      onChanged?.();
      loadJobs();
      reloadSources();
      if (job.status === 'done') toast.success('知识库整理完成');
      else if (job.status === 'failed') toast.error(job.error || '整理没有完成，请查看日志');
    }
  }, [active, job, onChanged, loadJobs, reloadSources]);

  const selectJob = (id) => {
    watchingRef.current = false;
    setSelectedId(id);
    setParams({ job: id }, { replace: true });
  };

  const cancel = async () => {
    const ok = await confirm({
      title: '取消这次整理？',
      message: '取消后任务会停止。之后可以在这里或「文件 → 知识库资料」里重新开始整理。',
      confirmText: '取消整理',
      cancelText: '继续整理',
      danger: true,
    });
    if (!ok || !job) return;
    setCancelling(true);
    try {
      await api.cancelJob(job.id);
      toast.info('已发送取消请求');
      const j = await api.getJob(job.id, { silent: true });
      setJob(j);
    } catch {
      // 已提示
    } finally {
      setCancelling(false);
    }
  };

  // 一份可用资料都没有时不放按钮，下面的空状态会引导去添加资料
  const headerActions =
    actionsSlot &&
    distill.readyCount > 0 &&
    createPortal(
      <>
        <button
          type="button"
          className="btn"
          onClick={() => distill.start('rebuild')}
          disabled={!!distill.distilling || active}
        >
          {distill.distilling === 'rebuild' ? <Spinner /> : <RefreshCcw />}
          全部重建
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => distill.start('incremental')}
          disabled={!!distill.distilling || active || distill.pending === 0}
        >
          {distill.distilling === 'incremental' ? <Spinner /> : <Sparkles />}
          开始整理
        </button>
      </>,
      actionsSlot,
    );

  // 资料的整理状态：一行，和文件页的 DistillBar 同样式
  const sourcesBar = (
    <div className="kb-distillbar">
      <DistillStatus pending={distill.pending} text={distill.text} />
      <div className="kb-distillbar__actions">
        <Link to="/files/sources" className="btn btn--link btn--muted btn--sm">
          管理资料
        </Link>
      </div>
    </div>
  );

  let body;
  if (error && !job) {
    body = <ErrorState error={error} onRetry={init} />;
  } else if ((jobs == null && !job) || (selectedId && !job)) {
    body = (
      <div className="page-body page-body--form kb-distill" aria-busy="true" aria-label="加载中">
        <span className="skeleton" style={{ width: 160, height: 22 }} />
        <span className="skeleton" style={{ width: '100%', height: 20 }} />
        <span className="skeleton" style={{ width: '100%', height: 6 }} />
        <span className="skeleton" style={{ width: '100%', height: 320 }} />
      </div>
    );
  } else if (!selectedId) {
    body = (
      <>
        {sourcesBar}
        <EmptyState
          fill
          icon={ListChecks}
          title="还没有整理过知识库"
          desc="先在「文件 → 知识库资料」里添加文件、网址或文本，再点「开始整理」，系统会把资料整理成知识条目。"
          action={
            <Link to="/files/sources" className="btn btn--primary">
              去添加资料
              <ArrowRight />
            </Link>
          }
        />
      </>
    );
  } else {
    const st = JOB_STATUS[job.status] || { label: job.status, tone: 'gray' };
    const phaseLabel = PHASES.find((p) => p.value === job.phase)?.label || job.phase;
    const done = job.progress?.done ?? 0;
    const total = job.progress?.total ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : job.status === 'done' ? 100 : 0;
    const indeterminate = active && total === 0;
    const others = (jobs || []).filter((j) => j.id !== job.id);
    const stats = [
      ['新增条目', job.stats?.entriesAdded ?? 0],
      ['合并重复', job.stats?.entriesMerged ?? 0],
      ['发现待补充问题', job.stats?.gapsFound ?? 0],
    ];

    body = (
      <>
        {!active && sourcesBar}
        <div className="page-body page-body--form kb-distill">
          <div className="kb-distill__head">
            <div className="kb-distill__title">
              <div className="hstack">
                <h2>{JOB_MODE[job.mode] || '整理知识库'}</h2>
                <StatusDot tone={st.tone} pulse={st.pulse}>
                  {st.label}
                </StatusDot>
              </div>
              <div className="muted text-sm">
                {job.startedAt ? `开始于 ${fmtTime(job.startedAt)}` : '等待开始'}
                {job.finishedAt ? ` · 结束于 ${fmtTime(job.finishedAt)}` : ''}
              </div>
            </div>
            {active && (
              <button type="button" className="btn btn--sm btn--danger" onClick={cancel} disabled={cancelling}>
                {cancelling ? <Spinner /> : <CircleStop />}
                取消
              </button>
            )}
          </div>

          <PhaseSteps job={job} />

          <div className="kb-distill__progress">
            <div className="kb-distill__progress-label">
              <span>
                {job.status === 'done' ? '全部完成' : job.status === 'queued' ? '排队等待中' : `当前步骤：${phaseLabel}`}
              </span>
              {total > 0 && (
                <span className="muted text-sm num">
                  {fmtNum(done)} / {fmtNum(total)}
                </span>
              )}
            </div>
            <div
              className={`progress${indeterminate ? ' kb-distill__progress--indeterminate' : ''}`}
              role="progressbar"
              aria-label="整理进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={indeterminate ? undefined : pct}
            >
              <div
                className={`progress__bar${job.status === 'failed' ? ' progress__bar--danger' : ''}`}
                style={{ width: indeterminate ? '30%' : `${pct}%` }}
              />
            </div>
          </div>

          {job.error && <Callout tone="danger">{job.error}</Callout>}

          <dl className="kb-distill__stats">
            {stats.map(([label, n]) => (
              <div key={label} className="kb-distill__stat">
                <dt className="metric__label">{label}</dt>
                <dd className="metric__value">{fmtNum(n)}</dd>
              </div>
            ))}
          </dl>

          {job.status === 'done' && (
            <div className="hstack kb-distill__links">
              <Link to="/kb/entries" className="btn btn--sm">
                查看条目
                <ArrowRight />
              </Link>
              {(job.stats?.gapsFound ?? 0) > 0 && (
                <Link to="/kb/gaps" className="btn btn--sm">
                  补充缺失的答案
                  <ArrowRight />
                </Link>
              )}
            </div>
          )}

          <section className="kb-distill__log">
            <div className="section__head">
              <h3>处理日志</h3>
              {active && (
                <span className="hstack muted text-sm">
                  <Spinner size={12} /> 实时更新中
                </span>
              )}
            </div>
            <LogView log={job.log} />
          </section>
        </div>

        {others.length > 0 && (
          <section className="kb-distill__history" aria-label="最近的整理记录">
            <h3 className="kb-distill__history-title">最近的整理记录</h3>
            <DataTable label="最近的整理记录" columns={JOB_COLUMNS} rows={others} onRowClick={(j) => selectJob(j.id)} />
          </section>
        )}
      </>
    );
  }

  return (
    <>
      {headerActions}
      {body}
    </>
  );
}
