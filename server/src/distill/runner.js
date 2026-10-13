import { fitToBudget, pickQueryTerms } from '../kb/search.js';
import { ENTRY_TYPES, normalizeTags, PROFILE_FIELDS } from '../kb/store.js';
import { clip, HttpError, mapLimit, newId, nowIso, safeJsonParse } from '../util.js';
import { llmConfigured } from '../settings.js';

const CHUNK_SIZE = 6000;
const CONSOLIDATE_BATCH = 15;
const MAX_LOG = 500;
/**
 * 画像和列问题时给模型看的条目标题：最多 200 条、每条截到 100 字（总共不超过约 2 万字）。知识库条目多时按创建时间
 * 均匀地挑，而不是只取最早的 200 条，这样各份资料、各个主题都有代表（模型只是借标题了解知识库大概有什么）
 */
export const PROMPT_TITLES = 200;
export const PROMPT_TITLE_CHARS = 100;
/** 判断问题能不能答时带的条目：总共不超过 40000 字、最多 40 条；知识库大时每个问题各检索前几条，轮流放 */
const JUDGE_CHARS = 40000;
const JUDGE_TOP_K = 40;
const JUDGE_PER_QUESTION = 10;

/** 按约 6000 字符切块，尽量在段落/行边界切 */
export function chunkText(text, size = CHUNK_SIZE) {
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  const pieces = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= size) pieces.push(para);
    else {
      let buf = '';
      for (const line of para.split('\n')) {
        if (line.length > size) {
          if (buf) pieces.push(buf);
          buf = '';
          for (let i = 0; i < line.length; i += size) pieces.push(line.slice(i, i + size));
        } else if (buf.length + line.length + 1 > size) {
          pieces.push(buf);
          buf = line;
        } else buf = buf ? `${buf}\n${line}` : line;
      }
      if (buf) pieces.push(buf);
    }
  }
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > size) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return chunks;
}

function rowToJob(r, withLog = true) {
  const job = {
    id: r.id,
    status: r.status,
    mode: r.mode,
    phase: r.phase,
    progress: safeJsonParse(r.progress, { done: 0, total: 0 }),
    stats: safeJsonParse(r.stats, { entriesAdded: 0, entriesMerged: 0, gapsFound: 0 }),
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    error: r.error ?? null,
  };
  if (withLog) job.log = safeJsonParse(r.log, []);
  return job;
}

class CancelledError extends Error {}

/** @param {any} ctx */
export function createDistillRunner(ctx) {
  const { db, kb } = ctx;
  /** @type {{job: any, controller: AbortController} | null} */
  let current = null;

  db.prepare(
    "UPDATE jobs SET status = 'failed', error = '服务重启，任务中断', finished_at = ? WHERE status IN ('queued', 'running')",
  ).run(nowIso());

  const persist = (job) => {
    db.prepare(
      `UPDATE jobs SET status=?, phase=?, progress=?, log=?, stats=?, started_at=?, finished_at=?, error=? WHERE id=?`,
    ).run(
      job.status,
      job.phase,
      JSON.stringify(job.progress),
      JSON.stringify(job.log),
      JSON.stringify(job.stats),
      job.startedAt,
      job.finishedAt,
      job.error,
      job.id,
    );
  };

  const log = (job, level, msg) => {
    job.log.push({ ts: nowIso(), level, msg });
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    persist(job);
  };

  const setPhase = (job, phase, total) => {
    job.phase = phase;
    job.progress = { done: 0, total };
    persist(job);
  };

  const tick = (job) => {
    job.progress.done++;
    persist(job);
  };

  function selectSources(mode, sourceIds) {
    if (mode === 'rebuild') {
      return db.prepare("SELECT * FROM sources WHERE status = 'ready' ORDER BY created_at, rowid").all();
    }
    if (Array.isArray(sourceIds) && sourceIds.length) {
      const ids = [...new Set(sourceIds.map(String))];
      const rows = ids.map((id) => db.prepare("SELECT * FROM sources WHERE id = ? AND status = 'ready'").get(id));
      return rows.filter(Boolean);
    }
    return db
      .prepare("SELECT * FROM sources WHERE status = 'ready' AND distilled_at IS NULL ORDER BY created_at, rowid")
      .all();
  }

  function start({ sourceIds, mode }) {
    if (mode !== 'incremental' && mode !== 'rebuild') throw new HttpError(400, 'invalid_input', 'mode 只能是 incremental 或 rebuild');
    if (sourceIds !== undefined && sourceIds !== null && !Array.isArray(sourceIds)) {
      throw new HttpError(400, 'invalid_input', 'sourceIds 必须是数组');
    }
    if (current) throw new HttpError(409, 'job_running', '已有蒸馏任务在运行');
    if (!llmConfigured(ctx.getSettings(), ctx.config)) {
      throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
    }
    const sources = selectSources(mode, sourceIds);
    if (!sources.length) throw new HttpError(400, 'nothing_to_distill', '没有可处理的资料');

    const job = {
      id: newId(),
      status: 'queued',
      mode,
      phase: 'parse',
      progress: { done: 0, total: sources.length },
      log: [],
      stats: { entriesAdded: 0, entriesMerged: 0, gapsFound: 0 },
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    db.prepare(
      `INSERT INTO jobs(id, status, mode, phase, progress, log, stats, source_ids, created_at)
       VALUES(?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    ).run(job.id, job.status, mode, job.phase, JSON.stringify(job.progress), JSON.stringify(job.stats), JSON.stringify(sources.map((s) => s.id)), nowIso());
    const controller = new AbortController();
    current = { job, controller };
    setImmediate(() => {
      run(job, sources, controller.signal)
        .catch(() => {})
        .finally(() => {
          if (current?.job.id === job.id) current = null;
        });
    });
    return job;
  }

  async function run(job, sources, signal) {
    const check = () => {
      if (signal.aborted) throw new CancelledError();
    };
    const newIds = new Set();
    try {
      job.status = 'running';
      job.startedAt = nowIso();
      log(job, 'info', `开始${job.mode === 'rebuild' ? '全部重建' : '增量蒸馏'}，共 ${sources.length} 份资料`);

      if (job.mode === 'rebuild') {
        const e = kb.deleteDistillEntries();
        // F2c：会话里客户问出来的缺口不是蒸馏产物，重建时保留
        const g = db.prepare("DELETE FROM gaps WHERE status = 'open' AND origin = 'distill'").run().changes;
        log(job, 'info', `已清空 ${e} 条蒸馏条目和 ${g} 个蒸馏发现的待处理缺口（手动、缺口、会话来源的条目和会话里问出的缺口保留）`);
      }

      // 1. parse
      setPhase(job, 'parse', sources.length);
      const chunks = [];
      for (const s of sources) {
        check();
        const parts = chunkText(s.text);
        parts.forEach((text) => chunks.push({ sourceId: s.id, sourceName: s.name, text }));
        log(job, 'info', `【解析】${s.name}：${s.chars} 字，切成 ${parts.length} 块`);
        tick(job);
      }

      // 2. extract（并发 2）
      setPhase(job, 'extract', chunks.length);
      log(job, 'info', `【抽取】共 ${chunks.length} 块，开始抽取知识条目`);
      let failed = 0;
      let lastErr = null;
      await mapLimit(chunks, 2, async (chunk, i) => {
        check();
        try {
          const items = await ctx.ai.extract({ text: chunk.text, sourceName: chunk.sourceName, signal });
          check();
          let n = 0;
          for (const it of Array.isArray(items) ? items : []) {
            const title = clip(String(it?.title ?? '').trim(), 200);
            const content = clip(String(it?.content ?? '').trim(), 5000);
            if (!title || !content) continue;
            const entry = kb.insertEntry({
              type: ENTRY_TYPES.includes(it.type) ? it.type : 'fact',
              title,
              content,
              tags: normalizeTags(Array.isArray(it.tags) ? it.tags : []),
              sourceRefs: [{ sourceId: chunk.sourceId, sourceName: chunk.sourceName, quote: clip(String(it.quote ?? ''), 300) }],
              origin: 'distill',
            });
            newIds.add(entry.id);
            n++;
          }
          log(job, 'info', `【抽取】第 ${i + 1}/${chunks.length} 块（${chunk.sourceName}）得到 ${n} 条`);
        } catch (err) {
          if (signal.aborted || err instanceof CancelledError) throw new CancelledError();
          failed++;
          lastErr = err;
          log(job, 'error', `【抽取】第 ${i + 1} 块失败：${err?.message || err}`);
        }
        tick(job);
      });
      if (chunks.length && failed === chunks.length) throw new Error(`所有片段都抽取失败：${lastErr?.message || lastErr}`);

      // 3. consolidate
      const fresh = () => [...newIds].map((id) => kb.getEntry(id)).filter(Boolean);
      const byType = new Map();
      for (const e of fresh()) {
        if (!byType.has(e.type)) byType.set(e.type, []);
        byType.get(e.type).push(e.id);
      }
      const batches = [];
      for (const ids of byType.values()) {
        for (let i = 0; i < ids.length; i += CONSOLIDATE_BATCH) batches.push(ids.slice(i, i + CONSOLIDATE_BATCH));
      }
      setPhase(job, 'consolidate', batches.length);
      log(job, 'info', `【合并】按主题分 ${batches.length} 批，与已有条目合并去重`);
      for (const batchIds of batches) {
        check();
        const batch = batchIds.map((id) => kb.getEntry(id)).filter(Boolean);
        if (batch.length) {
          // 每条新条目用全文索引找最像的 3 条已有条目（不管状态，排除本批）当合并候选，最多 30 条
          const inBatch = batch.map((e) => e.id);
          const cand = new Map();
          for (const e of batch) {
            for (const doc of kb.searchEntries(pickQueryTerms([`${e.title}\n${e.content}`]), { limit: 3, status: null, exclude: inBatch })) {
              if (cand.size < 30) cand.set(doc.id, doc);
            }
          }
          try {
            const result = await ctx.ai.consolidate({ newEntries: batch, candidates: [...cand.values()], signal });
            check();
            applyConsolidation(job, result, newIds);
          } catch (err) {
            if (signal.aborted || err instanceof CancelledError) throw new CancelledError();
            log(job, 'warn', `【合并】一批合并失败，已跳过：${err?.message || err}`);
          }
        }
        tick(job);
      }

      // 4. profile
      check();
      setPhase(job, 'profile', 1);
      log(job, 'info', '【画像】生成或更新企业画像');
      const per = Math.max(1000, Math.floor(12000 / sources.length));
      const material = sources.map((s) => `### ${s.name}\n${clip(s.text, per)}`).join('\n\n');
      try {
        const curProfile = kb.getProfile();
        const entryTitles = kb.sampleTitles(PROMPT_TITLES, PROMPT_TITLE_CHARS);
        const p = await ctx.ai.profile({ current: curProfile, material, entryTitles, signal });
        check();
        const patch = {};
        for (const f of PROFILE_FIELDS) if (typeof p?.[f] === 'string' && p[f].trim()) patch[f] = p[f].trim();
        kb.updateProfile(patch);
        log(job, 'info', `【画像】已更新${patch.companyName ? `：${patch.companyName}` : ''}`);
      } catch (err) {
        if (signal.aborted || err instanceof CancelledError) throw new CancelledError();
        log(job, 'warn', `【画像】生成失败，已跳过：${err?.message || err}`);
      }
      tick(job);

      // 5. gaps
      check();
      setPhase(job, 'gaps', 2);
      log(job, 'info', '【缺口】列出客户最可能问的 25 个问题');
      try {
        const profile = kb.getProfile();
        const entryTitles = kb.sampleTitles(PROMPT_TITLES, PROMPT_TITLE_CHARS);
        const questions = await ctx.ai.listQuestions({ profile, entryTitles, signal });
        check();
        tick(job);
        log(job, 'info', `【缺口】逐条判断知识库能否回答（${questions.length} 个问题）`);
        const results = await ctx.ai.judgeQuestions({ questions, entries: judgeEntries(questions), signal });
        check();
        let n = 0;
        for (const r of results) {
          if (r?.answerable !== false || typeof r.question !== 'string') continue;
          if (kb.addGapDedup(r.question, r.reason || '知识库里没有足够信息回答')) n++;
        }
        job.stats.gapsFound += n;
        log(job, 'info', `【缺口】新增 ${n} 个缺口`);
        tick(job);
      } catch (err) {
        if (signal.aborted || err instanceof CancelledError) throw new CancelledError();
        log(job, 'warn', `【缺口】分析失败，已跳过：${err?.message || err}`);
      }

      // done
      job.stats.entriesAdded = fresh().length;
      const now = nowIso();
      const mark = db.prepare('UPDATE sources SET distilled_at = ? WHERE id = ?');
      for (const s of sources) mark.run(now, s.id);
      job.phase = 'done';
      job.progress = { done: 1, total: 1 };
      job.status = 'done';
      job.finishedAt = nowIso();
      log(
        job,
        'info',
        `完成：新增 ${job.stats.entriesAdded} 条，合并 ${job.stats.entriesMerged} 条，发现 ${job.stats.gapsFound} 个缺口`,
      );
    } catch (err) {
      job.stats.entriesAdded = [...newIds].filter((id) => kb.getEntry(id)).length;
      job.finishedAt = nowIso();
      if (err instanceof CancelledError || signal.aborted) {
        job.status = 'cancelled';
        log(job, 'warn', '任务已取消（已生成的条目保留）');
      } else {
        job.status = 'failed';
        job.error = String(err?.message || err);
        log(job, 'error', `任务失败：${job.error}`);
      }
    }
  }

  /**
   * 判断问题能不能答时带的条目：全部 active 条目不超过 40000 字就全带（按创建时间）；超过时每个问题各检索前 10 条，
   * 按"每个问题的第 1 条、每个问题的第 2 条……"轮流排，去重后按总字数截断，最多 40 条
   */
  function judgeEntries(questions) {
    const all = kb.activeEntriesWithin(JUDGE_CHARS);
    if (all) return all;
    const lists = questions.map((q) => kb.searchEntries(pickQueryTerms([q]), { limit: JUDGE_PER_QUESTION }));
    const seen = new Set();
    const ranked = [];
    for (let i = 0; i < JUDGE_PER_QUESTION; i++) {
      for (const list of lists) {
        const e = list[i];
        if (e && !seen.has(e.id)) {
          seen.add(e.id);
          ranked.push(e);
        }
      }
    }
    return fitToBudget(ranked, JUDGE_CHARS, JUDGE_TOP_K);
  }

  function applyConsolidation(job, result, newIds) {
    for (const m of result?.merges || []) {
      const ids = [...new Set((Array.isArray(m?.ids) ? m.ids : []).map(String))];
      const group = ids.map((id) => kb.getEntry(id)).filter(Boolean);
      if (group.length < 2 || !group.some((e) => newIds.has(e.id))) continue;
      const nonDistill = group.find((e) => e.origin !== 'distill');
      const target = nonDistill || [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const refs = [];
      const seen = new Set();
      for (const e of group) {
        for (const r of e.sourceRefs) {
          const k = `${r.sourceId}|${r.quote}`;
          if (!seen.has(k)) {
            seen.add(k);
            refs.push(r);
          }
        }
      }
      const tags = normalizeTags([...group.flatMap((e) => e.tags), ...(Array.isArray(m.tags) ? m.tags : [])]);
      const patch = { sourceRefs: refs, tags };
      if (!nonDistill) {
        const title = clip(String(m.title ?? '').trim(), 200);
        const content = clip(String(m.content ?? '').trim(), 5000);
        if (title) patch.title = title;
        if (content) patch.content = content;
      }
      kb.updateEntry(target.id, patch);
      let removed = 0;
      for (const e of group) {
        if (e.id === target.id || e.origin !== 'distill') continue;
        kb.deleteEntry(e.id);
        newIds.delete(e.id);
        removed++;
      }
      job.stats.entriesMerged += removed;
    }
    for (const c of result?.conflicts || []) {
      const note = clip(String(c?.note ?? '').trim(), 300);
      if (!note) continue;
      const ids = [...new Set((Array.isArray(c?.ids) ? c.ids : []).map(String))];
      const marker = `⚠️ 资料中存在不一致：${note}`;
      for (const id of ids) {
        const e = kb.getEntry(id);
        if (e && !e.content.includes(marker)) kb.updateEntry(id, { content: `${e.content}\n\n${marker}` });
      }
      const q = String(c?.question ?? '').trim() || `资料存在不一致，需要确认：${note}`;
      if (kb.addGapDedup(q, `蒸馏时发现矛盾：${note}`)) job.stats.gapsFound++;
      log(job, 'warn', `【合并】发现不一致：${note}`);
    }
  }

  return {
    start,
    cancel(id) {
      const exists = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id);
      if (!exists) throw new HttpError(404, 'not_found', '任务不存在');
      if (!current || current.job.id !== id) throw new HttpError(409, 'job_not_running', '任务已经结束');
      current.controller.abort(new CancelledError('cancelled'));
    },
    get(id) {
      if (current?.job.id === id) return structuredClone(current.job);
      const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      return r ? rowToJob(r) : null;
    },
    list() {
      return db
        .prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 20')
        .all()
        .map((r) => rowToJob(r, false));
    },
    /** 测试/关闭用：取消当前任务 */
    abortAll() {
      current?.controller.abort(new CancelledError('shutdown'));
    },
    isRunning: () => !!current,
  };
}
