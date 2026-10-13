// 操作日志的读写：写一行、按条件倒序分页查、过期清理。表结构见 db.js；哪些接口记、怎么描述见 audit/actions.js，
// 接到请求上的中间件见 audit/middleware.js。日志只能由服务端写，接口只读，不能改、不能删。
import { badRequest } from '../util.js';
import { CATEGORIES, TARGET_TYPES } from './actions.js';
import { clipText, MAX_CHANGES } from './diff.js';

/** 过期清理多久跑一次 */
export const AUDIT_CLEANUP_INTERVAL_MS = 24 * 3600 * 1000;
/** 启动后多久第一次清理（不拖慢启动） */
const FIRST_CLEANUP_DELAY_MS = 60 * 1000;
/** 清理时一次删多少行（老库第一次清理可能很多，分批删，不长时间锁库） */
const CLEANUP_BATCH = 5000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
const DAY_MS = 24 * 3600 * 1000;

/** 游标：最后一行的 (at, seq)，base64url 编码 */
const encodeCursor = (at, seq) => Buffer.from(JSON.stringify([at, seq])).toString('base64url');
function decodeCursor(s) {
  try {
    const v = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1])) return v;
  } catch {
    /* 下面报错 */
  }
  throw badRequest('cursor 不对，请从第一页重新查', 'invalid_cursor');
}

/** LIKE 的通配符转义（用 \ 作转义符） */
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function rowToEntry(r) {
  let changes = [];
  try {
    changes = JSON.parse(r.changes);
  } catch {
    /* 存坏了按没有 */
  }
  return {
    id: String(r.seq),
    at: r.at,
    actor: r.actor_id || r.actor_name || r.actor_email ? { id: r.actor_id, name: r.actor_name, email: r.actor_email, role: r.actor_role } : null,
    action: r.action,
    category: r.category,
    categoryLabel: CATEGORIES[r.category] || r.category,
    summary: r.summary,
    target: r.target_type
      ? { type: r.target_type, typeLabel: TARGET_TYPES[r.target_type] || r.target_type, id: r.target_id, name: r.target_name }
      : null,
    changes: Array.isArray(changes) ? changes : [],
    ok: !!r.ok,
    status: r.status,
    error: r.error,
    ip: r.ip,
  };
}

/**
 * @param {{db: import('better-sqlite3').Database, log: any}} ctx
 * @param {{retentionDays: number, now?: () => number}} o now 是测试用的时钟
 */
export function createAuditLog(ctx, { retentionDays, now = Date.now }) {
  const { db, log } = ctx;
  const insert = db.prepare(
    `INSERT INTO audit_logs(at, actor_id, actor_name, actor_email, actor_role, action, category, summary,
       target_type, target_id, target_name, changes, ok, status, error, ip)
     VALUES(@at, @actorId, @actorName, @actorEmail, @actorRole, @action, @category, @summary,
       @targetType, @targetId, @targetName, @changes, @ok, @status, @error, @ip)`,
  );
  let firstTimer = null;
  let timer = null;

  const store = {
    /**
     * 写一行。
     * @param {{
     *   at?: string, actor?: {id?:string|null, name?:string, email?:string, role?:string|null}|null,
     *   action: string, summary: string, target?: {type:string, id?:string|null, name?:string|null}|null,
     *   changes?: any[], ok: boolean, status: number, error?: string|null, ip?: string|null,
     * }} e
     */
    record(e) {
      const action = String(e.action);
      const t = e.target || null;
      const changes = (Array.isArray(e.changes) ? e.changes : []).slice(0, MAX_CHANGES);
      insert.run({
        at: e.at || new Date(now()).toISOString(),
        actorId: e.actor?.id || null,
        actorName: clipText(e.actor?.name || '', 100),
        actorEmail: clipText(e.actor?.email || '', 200),
        actorRole: e.actor?.role || null,
        action,
        category: action.split('.')[0],
        summary: clipText(e.summary || action, 300),
        targetType: t?.type || null,
        targetId: t?.id != null ? clipText(t.id, 200) : null,
        targetName: t?.name != null && t.name !== '' ? clipText(t.name, 200) : null,
        changes: JSON.stringify(changes),
        ok: e.ok ? 1 : 0,
        status: Number.isInteger(e.status) ? e.status : 0,
        error: e.error ? clipText(e.error, 300) : null,
        ip: e.ip ? clipText(e.ip, 64) : null,
      });
    },

    /**
     * 按时间倒序查一页。type 是类型（category，例如 account）或具体的操作（action，例如 account.update）；
     * from、to 是 ISO 时间（含 from、不含 to）；q 在说明、对象名称、操作人名字和邮箱、改动、IP 里找（不分大小写）；
     * cursor 是上一页给的 nextCursor。返回 {items, nextCursor}，没有下一页时 nextCursor 为 null。
     * @param {{actorId?:string, type?:string, from?:string, to?:string, q?:string, cursor?:string, limit?:number}} f
     */
    list(f = {}) {
      const where = [];
      const args = [];
      if (f.actorId) {
        where.push('actor_id = ?');
        args.push(f.actorId);
      }
      if (f.type) {
        where.push(f.type.includes('.') ? 'action = ?' : 'category = ?');
        args.push(f.type);
      }
      if (f.from) {
        where.push('at >= ?');
        args.push(f.from);
      }
      if (f.to) {
        where.push('at < ?');
        args.push(f.to);
      }
      if (f.q) {
        const like = `%${likeEscape(f.q)}%`;
        where.push(
          `(summary LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\'
            OR actor_email LIKE ? ESCAPE '\\' OR changes LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')`,
        );
        args.push(like, like, like, like, like, like);
      }
      if (f.cursor) {
        const [at, seq] = decodeCursor(f.cursor);
        where.push('(at, seq) < (?, ?)');
        args.push(at, seq);
      }
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, f.limit || DEFAULT_PAGE_SIZE));
      const rows = db
        .prepare(`SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, seq DESC LIMIT ?`)
        .all(...args, limit + 1);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return { items: page.map(rowToEntry), nextCursor: more && last ? encodeCursor(last.at, last.seq) : null };
    },

    /** 删掉超过保留天数的日志，返回删了几行 */
    cleanup() {
      const cutoff = new Date(now() - retentionDays * DAY_MS).toISOString();
      const del = db.prepare('DELETE FROM audit_logs WHERE seq IN (SELECT seq FROM audit_logs WHERE at < ? ORDER BY at LIMIT ?)');
      let total = 0;
      for (;;) {
        const n = del.run(cutoff, CLEANUP_BATCH).changes;
        total += n;
        if (n < CLEANUP_BATCH) break;
      }
      if (total) log.info(`[audit] 清掉了 ${total} 条超过 ${retentionDays} 天的操作日志`);
      return total;
    },

    /** 开始定时清理：启动 1 分钟后清一次，之后每 intervalMs 一次；为 0 时不启动（测试里手动调 cleanup） */
    start(intervalMs = AUDIT_CLEANUP_INTERVAL_MS) {
      if (!intervalMs || timer || firstTimer) return;
      const run = () => {
        try {
          store.cleanup();
        } catch (err) {
          log.error(`[audit] 清理操作日志出错：${err?.stack || err}`);
        }
      };
      firstTimer = setTimeout(run, Math.min(FIRST_CLEANUP_DELAY_MS, intervalMs));
      firstTimer.unref?.();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (timer) clearInterval(timer);
      firstTimer = null;
      timer = null;
    },
  };
  return store;
}

/**
 * GET /api/audit-logs 的查询参数 → list() 的条件。不合法的回 400。
 * @param {Record<string, any>} q req.query
 */
export function parseAuditQuery(q) {
  const one = (name) => {
    const v = q[name];
    if (v === undefined || v === '') return '';
    if (typeof v !== 'string') throw badRequest(`${name} 只能给一个`, 'invalid_input');
    return v;
  };
  const time = (name) => {
    const v = one(name);
    if (!v) return '';
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw badRequest(`${name} 不是合法的时间`, 'invalid_time');
    return new Date(t).toISOString();
  };
  const type = one('type');
  if (type && !/^[a-z_]+(\.[a-z_]+)?$/.test(type)) throw badRequest('type 不对', 'invalid_input');
  const actorId = one('actorId');
  if (actorId.length > 100) throw badRequest('actorId 太长', 'invalid_input');
  const qText = one('q').trim();
  if (qText.length > 200) throw badRequest('关键字太长，最多 200 个字', 'invalid_input');
  const limitRaw = one('limit');
  let limit = DEFAULT_PAGE_SIZE;
  if (limitRaw) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw badRequest(`limit 必须是 1–${MAX_PAGE_SIZE} 的整数`, 'invalid_input');
  }
  return { actorId, type, from: time('from'), to: time('to'), q: qText, cursor: one('cursor'), limit };
}
