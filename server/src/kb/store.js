import { ENTRIES_FTS_DDL, kvGet, kvSet } from '../db.js';
import { badRequest, clip, isPlainObject, newId, nowIso, safeJsonParse } from '../util.js';
import { contextLength, entryIndexText, ftsMatchQuery, normKey, similarity } from './search.js';

export const ENTRY_TYPES = ['faq', 'product', 'policy', 'fact'];
export const ENTRY_STATUSES = ['active', 'disabled'];
export const GAP_STATUSES = ['open', 'answered', 'dismissed'];
export const ENTRY_ORIGINS = ['distill', 'manual', 'gap', 'conversation'];
/** F2c：和已有 open 缺口的二元组 Jaccard 相似度达到这个值，视为同一个问题，只把 count 加 1 */
export const GAP_MERGE_SIMILARITY = 0.6;
export const PROFILE_FIELDS = ['companyName', 'summary', 'offerings', 'contact', 'hours', 'languages', 'other'];

export function rowToEntry(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    tags: safeJsonParse(r.tags, []),
    sourceRefs: safeJsonParse(r.source_refs, []),
    status: r.status,
    origin: r.origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToGap(r) {
  return {
    id: r.id,
    question: r.question,
    reason: r.reason,
    status: r.status,
    origin: r.origin || 'distill',
    conversationId: r.conversation_id ?? null,
    count: r.count ?? 1,
    createdAt: r.created_at,
  };
}

/** 规范化 tags：字符串数组，去重，最多 12 个 */
export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  let list = tags;
  if (typeof list === 'string') list = list.split(/[,，、\n]+/);
  if (!Array.isArray(list)) throw badRequest('tags 必须是字符串数组');
  const out = [];
  for (const t of list) {
    if (typeof t !== 'string' && typeof t !== 'number') continue;
    const v = String(t).trim().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 12);
}

/**
 * 全文索引的版本：切词规则（kb/search.js 的 tokenize、entryIndexText）或索引表结构改了就加 1，下次启动整个重建。
 * 存在 kv 的 entries_fts_version。2：entries_fts 改成 contentless，索引对应的条目版本挪到 entries_fts_state
 */
export const ENTRY_INDEX_VERSION = 2;

/**
 * 整个重建全文索引：删掉两张索引表重建，按 rowid 分批读条目、一个事务里写完。返回写了多少条。
 * @param {import('better-sqlite3').Database} db
 */
export function rebuildEntryIndex(db) {
  let n = 0;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS entries_fts; DROP TABLE IF EXISTS entries_fts_state;');
    db.exec(ENTRIES_FTS_DDL);
    const page = db.prepare('SELECT rowid AS rid, id, title, content, tags, updated_at FROM entries WHERE rowid > ? ORDER BY rowid LIMIT 500');
    const put = db.prepare('INSERT INTO entries_fts(rowid, body) VALUES(?, ?)');
    const putState = db.prepare('INSERT INTO entries_fts_state(entry_rowid, entry_id, updated_at) VALUES(?, ?, ?)');
    for (let last = 0; ; ) {
      const rows = page.all(last);
      if (!rows.length) break;
      for (const r of rows) {
        put.run(r.rid, entryIndexText({ title: r.title, content: r.content, tags: safeJsonParse(r.tags, []) }));
        putState.run(r.rid, r.id, r.updated_at);
      }
      n += rows.length;
      last = rows[rows.length - 1].rid;
    }
    // 批量写完合并一下索引段，之后查得快些
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('optimize')");
    kvSet(db, 'entries_fts_version', ENTRY_INDEX_VERSION);
  })();
  return n;
}

/**
 * 启动自检：索引记的条目版本（entries_fts_state）和条目逐行对一遍（rowid、id、updated_at 都要相同，条数也要相同），
 * 全文索引的行数、索引版本也要对。对不上就整个重建，日志写一行。为的是发现「旧版本写了条目但没更新索引」：回滚到不认识
 * 索引的版本用一阵再升级回来，那段时间加的、改的（内容或状态，都会改 updated_at）、删的条目都会对不上。
 * 索引版本不对（新装第一次启动、索引结构改过）时也整个重建；条目和索引都是空的就不写日志。
 * @param {import('better-sqlite3').Database} db
 * @param {{info: Function}} [log] 不传就不写日志
 * @returns {{rebuilt: boolean, entries: number}}
 */
export function ensureEntryIndex(db, log) {
  const c = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM entries) AS entries,
              (SELECT COUNT(*) FROM entries_fts) AS indexed,
              (SELECT COUNT(*) FROM entries_fts_state) AS states,
              (SELECT COUNT(*) FROM entries e JOIN entries_fts_state s
                 ON s.entry_rowid = e.rowid AND s.entry_id = e.id AND s.updated_at = e.updated_at) AS matched`,
    )
    .get();
  const versionOk = kvGet(db, 'entries_fts_version', null) === ENTRY_INDEX_VERSION;
  if (versionOk && c.entries === c.indexed && c.entries === c.states && c.entries === c.matched) return { rebuilt: false, entries: c.entries };
  const started = Date.now();
  const n = rebuildEntryIndex(db);
  if (c.entries || c.indexed || c.states) {
    log?.info?.(
      `[kb] 知识库全文索引和条目对不上（条目 ${c.entries} 条，索引 ${c.indexed} 条，一致 ${c.matched} 条${versionOk ? '' : '，索引版本不对'}），已重建 ${n} 条，用时 ${Date.now() - started}ms`,
    );
  }
  return { rebuilt: true, entries: n };
}

/**
 * 创建时总是先做一次全文索引自检（ensureEntryIndex），对不上就重建。
 * 条目变了（增、改、删、整理资料时批量删）会在事务提交之后通知 onChange 登记的回调（向量检索的后台计算用）：
 * {type:'insert'|'update', entry} / {type:'delete', id} / {type:'bulk_delete'}。
 * @param {import('better-sqlite3').Database} db
 * @param {{log?: {info: Function, warn: Function}}} [opts] log：自检重建、检索出错时写日志，不传就不写
 */
export function createKbStore(db, { log } = {}) {
  ensureEntryIndex(db, log);
  /** @type {Set<(ev:any) => void>} */
  const listeners = new Set();
  const emit = (ev) => {
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch (err) {
        log?.warn?.(`[kb] 条目变动的回调出错：${err?.message || err}`);
      }
    }
  };
  const deleteVectors = db.prepare("DELETE FROM embeddings WHERE kind = 'entry' AND ref_id = ?");
  const getEntryRow = db.prepare('SELECT * FROM entries WHERE id = ?');
  const rowidOf = db.prepare('SELECT rowid FROM entries WHERE id = ?').pluck();
  const ftsDelete = db.prepare('DELETE FROM entries_fts WHERE rowid = ?');
  const ftsInsert = db.prepare('INSERT INTO entries_fts(rowid, body) VALUES(?, ?)');
  const stateDelete = db.prepare('DELETE FROM entries_fts_state WHERE entry_rowid = ?');
  const stateUpsert = db.prepare('INSERT OR REPLACE INTO entries_fts_state(entry_rowid, entry_id, updated_at) VALUES(?, ?, ?)');
  /**
   * 条目写进全文索引，和改 entries 在同一个事务里调。一定先删掉同一 rowid 的旧行再插：contentless 表插重复的 rowid
   * 不报错，会留下两份，旧内容的词还能查到（删一个不存在的 rowid 没关系）
   */
  const indexEntry = (rowid, e) => {
    ftsDelete.run(rowid);
    ftsInsert.run(rowid, entryIndexText(e));
    stateUpsert.run(rowid, e.id, e.updatedAt);
  };
  const activeInOrder = db.prepare("SELECT * FROM entries WHERE status = 'active' ORDER BY created_at, rowid");
  const activeTitlesInOrder = db.prepare("SELECT title FROM entries WHERE status = 'active' ORDER BY created_at, rowid").pluck();
  const countActive = db.prepare("SELECT COUNT(*) FROM entries WHERE status = 'active'").pluck();

  const store = {
    /**
     * 登记条目变动的回调，返回取消登记的函数。回调在写库的事务提交之后同步调用，出错只记日志
     * @param {(ev:any) => void} fn
     */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    getEntry(id) {
      const r = getEntryRow.get(id);
      return r ? rowToEntry(r) : null;
    },

    listEntries({ q, type, status } = {}) {
      const where = [];
      const params = [];
      if (type) {
        where.push('type = ?');
        params.push(type);
      }
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      if (q && String(q).trim()) {
        for (const term of String(q).trim().split(/\s+/).slice(0, 8)) {
          const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
          where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
          params.push(like, like, like);
        }
      }
      const sql = `SELECT * FROM entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, rowid DESC`;
      return db.prepare(sql).all(...params).map(rowToEntry);
    },

    activeEntries() {
      return activeInOrder.all().map(rowToEntry);
    },

    /** active 条目有几条 */
    countActive() {
      return countActive.get();
    },

    /**
     * 按 id 取条目，顺序和 ids 一样，不存在的（或状态不对的）跳过
     * @param {string[]} ids
     * @param {{status?:string|null}} [o] status：只要这个状态的，null 是不管状态
     */
    entriesByIds(ids, { status = 'active' } = {}) {
      if (!ids.length) return [];
      const rows = db
        .prepare(`SELECT * FROM entries WHERE id IN (SELECT value FROM json_each(?))${status ? ' AND status = ?' : ''}`)
        .all(...(status ? [JSON.stringify(ids), status] : [JSON.stringify(ids)]));
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id)).filter(Boolean).map(rowToEntry);
    },

    /**
     * 全部 active 条目按提示词里的字数（contextLength）加起来不超过 limitChars 时，按创建时间返回全部；超过返回 null。
     * 按创建时间一条条读，一超就停，不会为了判断把整个知识库读出来。
     * @param {number} limitChars
     * @returns {any[]|null}
     */
    activeEntriesWithin(limitChars) {
      const out = [];
      let total = 0;
      for (const r of activeInOrder.iterate()) {
        const e = rowToEntry(r);
        total += contextLength(e);
        if (total > limitChars) return null;
        out.push(e);
      }
      return out;
    },

    /**
     * 全文检索：按 FTS5 的 bm25 从相关到不相关，分数相同的按创建时间。terms 是切好、限好量的词（kb/search.js 的
     * pickQueryTerms），没有词返回空。状态按 entries 表过滤（不靠索引）。
     * @param {string[]} terms
     * @param {{limit?:number, status?:string|null, exclude?:Iterable<string>}} [o]
     *   status：只要这个状态的，null 是不管状态；exclude：不要这些 id
     * @returns {any[]}
     */
    searchEntries(terms, { limit = 60, status = 'active', exclude = [] } = {}) {
      if (!terms.length || limit <= 0) return [];
      const where = [];
      const params = [ftsMatchQuery(terms)];
      if (status) {
        where.push('e.status = ?');
        params.push(status);
      }
      const skip = [...exclude];
      if (skip.length) {
        where.push('e.id NOT IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(skip));
      }
      let rowids;
      try {
        // 先只按索引排好、取 rowid（不读条目内容），再把选中的几十条整行读出来
        rowids = db
          .prepare(
            `SELECT e.rowid FROM (SELECT rowid, bm25(entries_fts) AS score FROM entries_fts WHERE entries_fts MATCH ?) f
             JOIN entries e ON e.rowid = f.rowid${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
             ORDER BY f.score, e.created_at, e.rowid LIMIT ?`,
          )
          .pluck()
          .all(...params, limit);
      } catch (err) {
        log?.warn?.(`[kb] 全文检索出错，按没有命中处理：${err?.message || err}`);
        return [];
      }
      if (!rowids.length) return [];
      const rows = db.prepare('SELECT rowid AS rid, * FROM entries WHERE rowid IN (SELECT value FROM json_each(?))').all(JSON.stringify(rowids));
      const byRowid = new Map(rows.map((r) => [r.rid, r]));
      return rowids.map((rid) => byRowid.get(rid)).filter(Boolean).map(rowToEntry);
    },

    /**
     * active 条目的标题样本：不超过 n 条时全给（按创建时间），超过时按创建时间均匀地挑 n 条，每条截到 maxLen 字。
     * 只读标题，不读内容。
     * @param {number} n
     * @param {number} [maxLen]
     * @returns {string[]}
     */
    sampleTitles(n, maxLen = 100) {
      const total = countActive.get();
      if (!total || n <= 0) return [];
      const want = new Set(Array.from({ length: Math.min(n, total) }, (_, i) => Math.floor((i * total) / Math.min(n, total))));
      const out = [];
      let i = 0;
      for (const t of activeTitlesInOrder.iterate()) {
        if (want.has(i)) out.push(clip(String(t ?? ''), maxLen));
        i++;
        if (out.length >= want.size) break;
      }
      return out;
    },

    /**
     * 指定类型的 active 条目的类型和标题（F5 红线体检抽正常题用）。不超过 cap 条时全给（按创建时间），超过时随机取 cap 条。
     * @param {string[]} types
     * @param {number} [cap]
     * @returns {{type:string, title:string}[]}
     */
    activeTitlesOfTypes(types, cap = 500) {
      const where = `status = 'active' AND type IN (SELECT value FROM json_each(?))`;
      const t = JSON.stringify(types);
      const n = db.prepare(`SELECT COUNT(*) FROM entries WHERE ${where}`).pluck().get(t);
      const order = n <= cap ? 'ORDER BY created_at, rowid' : 'ORDER BY random() LIMIT ?';
      return db.prepare(`SELECT type, title FROM entries WHERE ${where} ${order}`).all(...(n <= cap ? [t] : [t, cap]));
    },

    /**
     * @param {{type:string,title:string,content:string,tags?:string[],sourceRefs?:any[],status?:string,origin:string}} e
     */
    insertEntry(e) {
      const now = nowIso();
      const entry = {
        id: newId(),
        type: ENTRY_TYPES.includes(e.type) ? e.type : 'fact',
        title: e.title,
        content: e.content,
        tags: normalizeTags(e.tags),
        sourceRefs: Array.isArray(e.sourceRefs) ? e.sourceRefs : [],
        status: ENTRY_STATUSES.includes(e.status) ? e.status : 'active',
        origin: e.origin,
        createdAt: now,
        updatedAt: now,
      };
      db.transaction(() => {
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO entries(id, type, title, content, tags, source_refs, status, origin, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.id,
            entry.type,
            entry.title,
            entry.content,
            JSON.stringify(entry.tags),
            JSON.stringify(entry.sourceRefs),
            entry.status,
            entry.origin,
            now,
            now,
          );
        indexEntry(lastInsertRowid, entry);
      })();
      emit({ type: 'insert', entry });
      return entry;
    },

    /** 更新条目（字段已校验）。改状态也走这里，索引里的 updated_at 跟着变 */
    updateEntry(id, patch) {
      const cur = store.getEntry(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: nowIso() };
      db.transaction(() => {
        db.prepare(
          `UPDATE entries SET type=?, title=?, content=?, tags=?, source_refs=?, status=?, updated_at=? WHERE id=?`,
        ).run(
          next.type,
          next.title,
          next.content,
          JSON.stringify(next.tags),
          JSON.stringify(next.sourceRefs),
          next.status,
          next.updatedAt,
          id,
        );
        indexEntry(rowidOf.get(id), next);
      })();
      emit({ type: 'update', entry: next });
      return next;
    },

    /** 删条目，连同全文索引和向量 */
    deleteEntry(id) {
      const ok = db.transaction(() => {
        const rowid = rowidOf.get(id);
        if (rowid === undefined) return false;
        ftsDelete.run(rowid);
        stateDelete.run(rowid);
        deleteVectors.run(id);
        return db.prepare('DELETE FROM entries WHERE rowid = ?').run(rowid).changes > 0;
      })();
      if (ok) emit({ type: 'delete', id });
      return ok;
    },

    /** 全部重建前删掉所有蒸馏出来的条目（连同索引和向量），返回删了几条 */
    deleteDistillEntries() {
      const n = db.transaction(() => {
        db.prepare("DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries WHERE origin = 'distill')").run();
        db.prepare("DELETE FROM entries_fts_state WHERE entry_rowid IN (SELECT rowid FROM entries WHERE origin = 'distill')").run();
        db.prepare("DELETE FROM embeddings WHERE kind = 'entry' AND ref_id IN (SELECT id FROM entries WHERE origin = 'distill')").run();
        return db.prepare("DELETE FROM entries WHERE origin = 'distill'").run().changes;
      })();
      if (n) emit({ type: 'bulk_delete' });
      return n;
    },

    stats() {
      const count = (sql, ...p) => db.prepare(sql).get(...p).n;
      const byType = { faq: 0, product: 0, policy: 0, fact: 0 };
      for (const r of db.prepare('SELECT type, COUNT(*) n FROM entries GROUP BY type').all()) {
        if (r.type in byType) byType[r.type] = r.n;
      }
      const last = db
        .prepare("SELECT MAX(finished_at) t FROM jobs WHERE status = 'done'")
        .get().t;
      return {
        entries: count('SELECT COUNT(*) n FROM entries'),
        activeEntries: count("SELECT COUNT(*) n FROM entries WHERE status = 'active'"),
        byType,
        openGaps: count("SELECT COUNT(*) n FROM gaps WHERE status = 'open'"),
        sources: count('SELECT COUNT(*) n FROM sources'),
        lastDistilledAt: last || null,
      };
    },

    // ---- gaps ----
    getGap(id) {
      const r = db.prepare('SELECT * FROM gaps WHERE id = ?').get(id);
      return r ? rowToGap(r) : null;
    },

    /** F2c：默认按被问到的次数倒序，次数相同的新的在前 */
    listGaps(status) {
      const order = 'ORDER BY count DESC, created_at DESC, rowid DESC';
      const rows = status
        ? db.prepare(`SELECT * FROM gaps WHERE status = ? ${order}`).all(status)
        : db.prepare(`SELECT * FROM gaps ${order}`).all();
      return rows.map(rowToGap);
    },

    /**
     * 新增缺口；与 open/dismissed 的缺口去重（相同或高度相似的问题不重复加）。
     * @returns {object|null} 新缺口；重复则返回 null
     */
    addGapDedup(question, reason) {
      const q = String(question || '').trim().slice(0, 500);
      if (!q) return null;
      const existing = db.prepare("SELECT question FROM gaps WHERE status IN ('open', 'dismissed')").all();
      const key = normKey(q);
      for (const g of existing) {
        if (normKey(g.question) === key || similarity(g.question, q) >= 0.7) return null;
      }
      const gap = {
        id: newId(),
        question: q,
        reason: String(reason || '').slice(0, 1000),
        status: 'open',
        origin: 'distill',
        conversationId: null,
        count: 1,
        createdAt: nowIso(),
      };
      db.prepare(
        "INSERT INTO gaps(id, question, reason, status, origin, conversation_id, count, created_at) VALUES(?, ?, ?, ?, 'distill', NULL, 1, ?)",
      ).run(gap.id, gap.question, gap.reason, gap.status, gap.createdAt);
      return gap;
    },

    /**
     * F2c：会话里答不了的问题进缺口。和现有 open 缺口按二元组 Jaccard 比较，≥0.6 视为同一问题，只把 count 加 1；
     * 否则新建一条 origin=conversation 的缺口。每次命中都在 gap_hits 记一行（看板按时间段统计用）。
     * @returns {{gap: object, merged: boolean}|null}
     */
    addConversationGap(question, conversationId, reason = '客户提问，知识库无法回答') {
      const q = String(question || '').trim().slice(0, 500);
      if (!q) return null;
      const now = nowIso();
      let best = null;
      for (const g of db.prepare("SELECT id, question FROM gaps WHERE status = 'open'").all()) {
        const sim = normKey(g.question) === normKey(q) ? 1 : similarity(g.question, q);
        if (sim >= GAP_MERGE_SIMILARITY && (!best || sim > best.sim)) best = { id: g.id, sim };
      }
      let merged = false;
      let id;
      if (best) {
        id = best.id;
        merged = true;
        db.prepare('UPDATE gaps SET count = count + 1 WHERE id = ?').run(id);
      } else {
        id = newId();
        db.prepare(
          "INSERT INTO gaps(id, question, reason, status, origin, conversation_id, count, created_at) VALUES(?, ?, ?, 'open', 'conversation', ?, 1, ?)",
        ).run(id, q, String(reason).slice(0, 1000), conversationId || null, now);
      }
      db.prepare('INSERT INTO gap_hits(gap_id, conversation_id, ts) VALUES(?, ?, ?)').run(id, conversationId || null, now);
      return { gap: store.getGap(id), merged };
    },

    setGapStatus(id, status) {
      db.prepare('UPDATE gaps SET status = ? WHERE id = ?').run(status, id);
      return store.getGap(id);
    },

    // ---- profile ----
    getProfile() {
      const p = kvGet(db, 'profile', null) || {};
      const out = {};
      for (const f of PROFILE_FIELDS) out[f] = typeof p[f] === 'string' ? p[f] : '';
      out.updatedAt = p.updatedAt || null;
      return out;
    },

    updateProfile(patch) {
      if (!isPlainObject(patch)) throw badRequest('请求体必须是对象');
      const cur = store.getProfile();
      for (const f of PROFILE_FIELDS) {
        if (patch[f] === undefined) continue;
        if (typeof patch[f] !== 'string') throw badRequest(`${f} 必须是字符串`);
        cur[f] = patch[f].slice(0, 20000);
      }
      cur.updatedAt = nowIso();
      kvSet(db, 'profile', cur);
      return cur;
    },
  };
  return store;
}
