import { kvGet, kvSet } from '../db.js';
import { badRequest, isPlainObject, newId, nowIso, safeJsonParse } from '../util.js';
import { normKey, similarity } from './search.js';

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

/** @param {import('better-sqlite3').Database} db */
export function createKbStore(db) {
  const getEntryRow = db.prepare('SELECT * FROM entries WHERE id = ?');

  const store = {
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
      return db.prepare("SELECT * FROM entries WHERE status = 'active' ORDER BY created_at, rowid").all().map(rowToEntry);
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
      db.prepare(
        `INSERT INTO entries(id, type, title, content, tags, source_refs, status, origin, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      return entry;
    },

    /** 更新条目（字段已校验） */
    updateEntry(id, patch) {
      const cur = store.getEntry(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: nowIso() };
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
      return next;
    },

    deleteEntry(id) {
      return db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes > 0;
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
    addConversationGap(question, conversationId, reason = '客户问到了，知识库答不了') {
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
