// F5 红线体检：用内置题库（redteam-cases.js）扮演客户，走和 /api/kb/ask 同一个回复引擎 decideReply
// （含 4.3 第 1–3 层和 4.4 全部规则；第 4 层会话闸门在 wa/service.js，本来就不经过），看机器人会不会自己回复。
// - 并发 2；同一时间只跑一次；
// - 不建会话、不写处理记录（decisions）、不记缺口、不计入任何会话的每日模型次数（decideReply 本身不碰这些）；
// - 模型调用用 llmScope 记成 purpose=redteam，不带号和会话；
// - 运行状态和明细存在 redteam_runs 表（db.js），每判完一题写一次，进行中 results 边跑边出；
// - 进程重启时还在 running 的标成 failed（error 写"服务重启，体检中断"）。
import { buildRedteamCases, judgeCase } from '../redteam-cases.js';
import { decideReply } from '../reply/engine.js';
import { llmScope } from '../records.js';
import { llmConfigured } from '../settings.js';
import { HttpError, mapLimit, newId, nowIso, safeJsonParse } from '../util.js';

export const REDTEAM_CONCURRENCY = 2;
/** GET /api/redteam/runs 返回最近几次 */
export const REDTEAM_LIST_LIMIT = 10;
/** 抽正常题的候选最多多少条（faq、product 条目超过这么多时先随机取这么多） */
export const LEGIT_POOL_CAP = 500;

const emptySummary = () => ({ total: 0, redlinePassed: 0, redlineFailed: 0, legitReplied: 0, legitRefused: 0 });

/** 汇总：total 是已判完的题数；红线题分守住、失守，正常题分答上、误伤 */
export function summarizeResults(results) {
  const s = emptySummary();
  for (const r of results) {
    s.total++;
    if (r.isLegit) s[r.pass ? 'legitReplied' : 'legitRefused']++;
    else s[r.pass ? 'redlinePassed' : 'redlineFailed']++;
  }
  return s;
}

/** 一道题的结果。前 11 个字段是 SPEC 的结构；code（F12 的枚举）和 sendFileIds（目录题要看带没带文件）是附加的 */
function toResult(kase, r) {
  return {
    caseId: kase.caseId,
    category: kase.category,
    lang: kase.lang,
    input: kase.input,
    history: kase.history,
    expected: kase.expected,
    decision: r.decision,
    reply: r.reply,
    reason: r.reason,
    pass: judgeCase(kase, r),
    isLegit: kase.isLegit,
    code: r.code,
    sendFileIds: r.sendFileIds || [],
  };
}

/** 对外的结构（字段顺序按 SPEC）；withResults=false 时不带明细 */
function view(run, withResults = true) {
  const out = { id: run.id, status: run.status, progress: run.progress, summary: run.summary };
  if (withResults) out.results = run.results;
  out.startedAt = run.startedAt;
  out.finishedAt = run.finishedAt ?? null;
  out.error = run.error ?? null;
  return structuredClone(out);
}

const fromRow = (r) => ({
  id: r.id,
  status: r.status,
  progress: safeJsonParse(r.progress, { done: 0, total: 0 }),
  summary: safeJsonParse(r.summary, emptySummary()),
  results: r.results === undefined ? [] : safeJsonParse(r.results, []),
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
});

/** @param {any} ctx */
export function createRedteamRunner(ctx) {
  const { db } = ctx;
  /** @type {{run: any, controller: AbortController} | null} */
  let current = null;

  db.prepare("UPDATE redteam_runs SET status = 'failed', error = '服务重启，体检中断', finished_at = ? WHERE status = 'running'").run(
    nowIso(),
  );

  // 取消或关闭之后还在路上的那一两题回来时可能库已经关了，写失败只记日志
  const persist = (run) => {
    try {
      db.prepare('UPDATE redteam_runs SET status = ?, progress = ?, summary = ?, results = ?, finished_at = ?, error = ? WHERE id = ?').run(
        run.status,
        JSON.stringify(run.progress),
        JSON.stringify(run.summary),
        JSON.stringify(run.results),
        run.finishedAt,
        run.error,
        run.id,
      );
    } catch (err) {
      ctx.log.warn(`[redteam] 保存体检进度失败：${err?.message || err}`);
    }
  };

  /** 开始一次体检，返回刚建好的 run（status 直接是 running） */
  function start() {
    if (current) throw new HttpError(409, 'job_running', '已有红线体检在运行');
    if (!llmConfigured(ctx.getSettings(), ctx.config)) {
      throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
    }
    // 正常题只从 faq、product 条目的标题里抽几道，不用读整个知识库：只取类型和标题，条目很多时先随机取 500 条再抽
    const cases = buildRedteamCases({
      entries: ctx.kb.activeTitlesOfTypes(['faq', 'product'], LEGIT_POOL_CAP),
      files: ctx.files ? ctx.files.activeFiles() : [],
    });
    const run = {
      id: newId(),
      status: 'running',
      progress: { done: 0, total: cases.length },
      summary: emptySummary(),
      results: [],
      startedAt: nowIso(),
      finishedAt: null,
      error: null,
    };
    db.prepare(
      `INSERT INTO redteam_runs(id, status, progress, summary, results, started_at, finished_at, error)
       VALUES(?, ?, ?, ?, '[]', ?, NULL, NULL)`,
    ).run(run.id, run.status, JSON.stringify(run.progress), JSON.stringify(run.summary), run.startedAt);
    const controller = new AbortController();
    current = { run, controller };
    setImmediate(() => {
      execute(run, cases, controller.signal)
        .catch((err) => {
          ctx.log.warn(`[redteam] 体检出错：${err?.message || err}`);
          if (controller.signal.aborted) return;
          Object.assign(run, { status: 'failed', error: String(err?.message || err), finishedAt: nowIso() });
          persist(run);
        })
        .finally(() => {
          if (current?.run.id === run.id) current = null;
        });
    });
    return view(run);
  }

  async function execute(run, cases, signal) {
    // 结果按题目顺序排（并发时完成顺序不定）
    const slots = new Array(cases.length).fill(null);
    let failure = null;
    await llmScope({ purpose: 'redteam', accountId: null, conversationId: null }, () =>
      mapLimit(cases, REDTEAM_CONCURRENCY, async (kase, i) => {
        if (signal.aborted || failure) return;
        let r;
        try {
          r = await decideReply(ctx, { message: kase.input, history: kase.history });
        } catch (err) {
          // 模型出错引擎自己会转人工；走到这里的是程序错误，整次体检判失败，另一路也不再出新题
          failure = failure || err;
          return;
        }
        // 取消（或关闭）之后才回来的结果不要
        if (signal.aborted || failure) return;
        slots[i] = toResult(kase, r);
        run.results = slots.filter(Boolean);
        run.progress = { done: run.results.length, total: cases.length };
        run.summary = summarizeResults(run.results);
        persist(run);
      }),
    );
    if (signal.aborted) return;
    run.finishedAt = nowIso();
    if (failure) {
      run.status = 'failed';
      run.error = String(failure?.message || failure);
      ctx.log.warn(`[redteam] 体检失败：${run.error}`);
    } else {
      run.status = 'done';
    }
    persist(run);
  }

  return {
    start,
    /** 正在跑的那次的 id，没有为 null */
    runningId: () => current?.run.id ?? null,
    /** 取消：立刻标成 cancelled；还在路上的一两题回来后丢掉，不再出新题 */
    cancel(id) {
      const exists = db.prepare('SELECT status FROM redteam_runs WHERE id = ?').get(id);
      if (!exists) throw new HttpError(404, 'not_found', '体检记录不存在');
      if (!current || current.run.id !== id) throw new HttpError(409, 'job_not_running', '这次体检已经结束');
      const { run, controller } = current;
      controller.abort();
      current = null;
      run.status = 'cancelled';
      run.finishedAt = nowIso();
      persist(run);
    },
    get(id) {
      if (current?.run.id === id) return view(current.run);
      const r = db.prepare('SELECT * FROM redteam_runs WHERE id = ?').get(id);
      return r ? view(fromRow(r)) : null;
    },
    /** 最近 10 次，不含明细（带 summary） */
    list() {
      return db
        .prepare(
          `SELECT id, status, progress, summary, started_at, finished_at, error FROM redteam_runs
           ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(REDTEAM_LIST_LIMIT)
        .map((r) => view(fromRow(r), false));
    },
    /** 关闭用：停掉当前体检（库里留 running，下次启动标成 failed） */
    abortAll() {
      current?.controller.abort();
    },
  };
}
