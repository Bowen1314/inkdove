// F6 客户线索：表 leads、lead_stage_history（见 db.js）。后台定时扫描提取、手动重新提取、增删改查和 CSV 导出。
// 权限（agent 只能碰自己负责的会话的线索）由路由判断，见 routes/leads.js。
import { DELETED_ACCOUNT_NAME } from '../accounts.js';
import { LEAD_STAGES, leadStageLabel } from '../codes.js';
import { llmScope } from '../records.js';
import { llmConfigured } from '../settings.js';
import { badRequest, clip, HttpError, isPlainObject, newId, notFound, nowIso, safeJsonParse } from '../util.js';
import { DAILY_LLM_LIMIT, localDay } from '../wa/service.js';
import { convLogId } from '../wa/telegram.js';

/** 后台扫描间隔 */
export const LEADS_SCAN_INTERVAL_MS = 2 * 60 * 1000;
/** 最后一条消息过去多久才提取 */
export const LEAD_QUIET_MS = 10 * 60 * 1000;
/** 提取时读最近多少条消息 */
export const LEAD_MESSAGE_COUNT = 50;
/** 一次扫描最多提取几个会话（其余的下次扫描接着来），免得一次扫描调太久模型 */
const MAX_PER_SCAN = 20;
/** 后台提取失败（模型报错、输出解析不了）的会话，多久之后再试；只记在内存里 */
const FAIL_RETRY_MS = 30 * 60 * 1000;

/** 文字字段及长度上限（模型输出超长的截断，人工改的超长返回 400） */
export const LEAD_TEXT_FIELDS = { name: 100, company: 200, country: 100, email: 200, interest: 500, quantity: 200, summary: 2000 };
/** PUT 能改的字段 */
export const LEAD_EDITABLE_FIELDS = ['name', 'company', 'country', 'email', 'interest', 'quantity', 'stage', 'summary'];
export const LEAD_STAGE_KEYS = Object.keys(LEAD_STAGES);

/**
 * 模型输出 → 线索字段：每个文字字段取字符串（数字转成字符串），去首尾空白、截断，没有的留空字符串；
 * stage 不在枚举里的按 other。输出不是对象时返回 null。
 * @param {any} out
 */
export function normalizeExtraction(out) {
  if (!isPlainObject(out)) return null;
  const r = {};
  for (const [k, max] of Object.entries(LEAD_TEXT_FIELDS)) {
    const v = out[k];
    r[k] = typeof v === 'string' ? clip(v.trim(), max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  }
  const stage = typeof out.stage === 'string' ? out.stage.trim().toLowerCase() : '';
  r.stage = LEAD_STAGE_KEYS.includes(stage) ? stage : 'other';
  return r;
}

/**
 * 后台扫描的候选会话，同时满足 F6 的三个条件：
 * 1. 上次提取（conversations.lead_seq）之后有新的客户消息。导入的历史消息（via=import）不算；
 * 2. 会话里最新的消息（按时间）早于 cutoff，也就是已经过去 10 分钟；
 * 3. 至少一条客户消息的 botDecision 是 replied、handoff、blocked，或者有人工消息：后台和 WhatsApp 转发的 operator，
 *    以及实时收到的手机回复（owner、via=phone）。导入的手机回复不算。
 */
const CANDIDATES_SQL = `SELECT c.id FROM conversations c
  WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.seq > COALESCE(c.lead_seq, 0)
                  AND m.direction = 'in' AND m.author = 'customer' AND COALESCE(m.via, '') <> 'import')
    AND (SELECT MAX(m.ts) FROM messages m WHERE m.conversation_id = c.id) <= ?
    AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND (
                  (m.direction = 'in' AND m.bot_decision IN ('replied', 'handoff', 'blocked'))
                  OR m.author = 'operator'
                  OR (m.author = 'owner' AND COALESCE(m.via, '') <> 'import')))
  ORDER BY c.updated_at DESC, c.rowid DESC`;

/** lastContactAt：会话里最新一条消息（任何一方）的时间，读的时候算 */
const LEAD_SQL = `SELECT l.*, c.contact_name, c.contact_number, a.name AS account_name,
    (SELECT MAX(m.ts) FROM messages m WHERE m.conversation_id = l.conversation_id) AS last_contact_at
  FROM leads l
  LEFT JOIN conversations c ON c.id = l.conversation_id
  LEFT JOIN accounts a ON a.id = l.account_id`;

function rowToLead(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    accountId: r.account_id ?? null,
    accountName: r.account_name ?? DELETED_ACCOUNT_NAME,
    contactNumber: r.contact_number ?? '',
    contactName: r.contact_name ?? '',
    name: r.name,
    company: r.company,
    country: r.country,
    email: r.email,
    interest: r.interest,
    quantity: r.quantity,
    stage: r.stage,
    summary: r.summary,
    manualFields: safeJsonParse(r.manual_fields, []),
    lastContactAt: r.last_contact_at ?? null,
    extractedAt: r.extracted_at ?? null,
    updatedAt: r.updated_at,
  };
}

/** q 匹配：名字、公司、国家、邮箱、意向产品、WhatsApp 昵称和号码，不区分大小写；q 是号码（可带 + 空格 - 括号）时按数字比号码 */
function matchesQuery(l, q) {
  const needle = q.toLowerCase();
  const fields = [l.name, l.company, l.country, l.email, l.interest, l.contactName, l.contactNumber];
  if (fields.some((v) => String(v || '').toLowerCase().includes(needle))) return true;
  const digits = q.replace(/[\s+\-()]/g, '');
  return /^\d+$/.test(digits) && String(l.contactNumber || '').includes(digits);
}

// ---------------- CSV ----------------
const pad = (n) => String(n).padStart(2, '0');
/** CSV 里的时间：服务器本地时间 YYYY-MM-DD HH:mm（和每日次数一样，容器可用 TZ 环境变量调整） */
function csvTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 导出的列：中文表头 → 取值 */
const CSV_COLUMNS = [
  ['名字', (l) => l.name],
  ['公司', (l) => l.company],
  ['国家', (l) => l.country],
  ['邮箱', (l) => l.email],
  // LINE 官方帐号的客户没有号码，这一列是空的；昵称是 WhatsApp 或 LINE 上的名字
  ['号码', (l) => (l.contactNumber ? `+${l.contactNumber}` : '')],
  ['昵称', (l) => l.contactName],
  ['所属号', (l) => l.accountName],
  ['意向产品', (l) => l.interest],
  ['数量', (l) => l.quantity],
  ['阶段', (l) => leadStageLabel(l.stage)],
  ['摘要', (l) => l.summary],
  ['最近联系', (l) => csvTime(l.lastContactAt)],
  ['提取时间', (l) => csvTime(l.extractedAt)],
  ['更新时间', (l) => csvTime(l.updatedAt)],
];

/**
 * 一个 CSV 单元格：先防公式注入（= + - @ 以及制表符、回车开头的，前面加单引号，Excel 就当文字），再按 RFC 4180 转义
 * （含逗号、双引号、换行的用双引号包起来，里面的双引号写两遍）。
 */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Lead[] → CSV 文本：UTF-8 BOM（Excel 直接打开不乱码）+ 中文表头，CRLF 换行 */
export function leadsToCsv(leads) {
  const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const l of leads) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(l))).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * @param {any} ctx
 */
export function createLeadStore(ctx) {
  const { db, log } = ctx;
  /** @type {Map<string, Promise<any>>} 会话 id → 正在进行的提取（同一个会话不同时提取两次） */
  const inflight = new Map();
  /** @type {Map<string, number>} 会话 id → 后台提取失败的时间 */
  const failures = new Map();
  let timer = null;
  let scanning = false;
  let closed = false;

  const getRow = (id) => db.prepare(`${LEAD_SQL} WHERE l.id = ?`).get(id);
  const get = (id) => {
    const r = getRow(id);
    return r ? rowToLead(r) : null;
  };
  const addHistory = (leadId, stage, ts) =>
    db.prepare('INSERT INTO lead_stage_history(lead_id, stage, ts) VALUES(?, ?, ?)').run(leadId, stage, ts);
  /** 提取水位只往前推：会话里到 seq 为止的客户消息都算处理过了 */
  const advanceWatermark = (convId, seq) =>
    db.prepare('UPDATE conversations SET lead_seq = MAX(COALESCE(lead_seq, 0), ?) WHERE id = ?').run(seq, convId);

  /** 最近 50 条消息（按时间，从早到晚；撤回过的不算，不进模型）和会话里最新一条消息的 seq */
  function readMessages(convId) {
    const rows = db
      .prepare(
        'SELECT author, text, attachment, ts FROM messages WHERE conversation_id = ? AND revoked_at IS NULL ORDER BY ts DESC, seq DESC LIMIT ?',
      )
      .all(convId, LEAD_MESSAGE_COUNT)
      .reverse();
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ?').get(convId).n;
    const messages = rows.map((r) => {
      const a = safeJsonParse(r.attachment, null);
      const text = a?.filename ? `[文件] ${a.filename}${r.text ? ` ${r.text}` : ''}` : r.text;
      return { author: r.author, text, ts: r.ts };
    });
    return { messages, maxSeq };
  }

  /**
   * 把提取结果写进线索（一个事务）：没有就新建，有就覆盖 manualFields 以外的字段；stage 变了（含首次）写历史；推进提取水位。
   * leadId 给了（手动重新提取）而这条线索在提取期间被删了，什么也不写，返回 null。
   */
  const save = db.transaction((conv, data, maxSeq, leadId) => {
    const now = nowIso();
    const cur = db.prepare('SELECT * FROM leads WHERE conversation_id = ?').get(conv.id);
    if (leadId && (!cur || cur.id !== leadId)) return null;
    advanceWatermark(conv.id, maxSeq);
    if (!cur) {
      const id = newId();
      db.prepare(
        `INSERT INTO leads(id, conversation_id, account_id, name, company, country, email, interest, quantity, stage, summary,
                           manual_fields, extracted_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      ).run(
        id,
        conv.id,
        conv.account_id ?? null,
        data.name,
        data.company,
        data.country,
        data.email,
        data.interest,
        data.quantity,
        data.stage,
        data.summary,
        now,
        now,
        now,
      );
      addHistory(id, data.stage, now);
      return id;
    }
    const manual = new Set(safeJsonParse(cur.manual_fields, []));
    const next = {};
    for (const k of LEAD_EDITABLE_FIELDS) next[k] = manual.has(k) ? cur[k] : data[k];
    db.prepare(
      `UPDATE leads SET name = ?, company = ?, country = ?, email = ?, interest = ?, quantity = ?, stage = ?, summary = ?,
                        extracted_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next.name, next.company, next.country, next.email, next.interest, next.quantity, next.stage, next.summary, now, now, cur.id);
    if (next.stage !== cur.stage) addHistory(cur.id, next.stage, now);
    return cur.id;
  });

  /**
   * 提取一个会话的线索，返回 Lead。计入会话每日模型次数（调用前先记上，和 service.js 的草稿一样）。
   * 超上限 429 llm_daily_limit；模型报错或输出解析不了 502 llm_error。
   */
  async function extractConversation(convId, leadId = null) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
    if (!conv) throw notFound('会话不存在');
    const today = localDay();
    const used = conv.llm_day === today ? conv.llm_calls : 0;
    if (used + 1 > DAILY_LLM_LIMIT) {
      throw new HttpError(429, 'llm_daily_limit', `这个会话今天的模型调用已到上限（${DAILY_LLM_LIMIT} 次），明天再试`);
    }
    const { messages, maxSeq } = readMessages(convId);
    db.prepare(
      'UPDATE conversations SET llm_calls = CASE WHEN llm_day = ? THEN llm_calls + 1 ELSE 1 END, llm_day = ? WHERE id = ?',
    ).run(today, today, convId);
    let out;
    try {
      out = await llmScope({ accountId: conv.account_id ?? null, conversationId: convId }, () =>
        ctx.ai.extractLead({ contactName: conv.contact_name || '', messages }),
      );
    } catch (err) {
      throw new HttpError(502, 'llm_error', `提取失败：${err?.message || err}`);
    }
    if (closed) throw new HttpError(503, 'closing', '服务正在关闭');
    const data = normalizeExtraction(out);
    if (!data) throw new HttpError(502, 'llm_error', '提取失败：模型返回的结果无法解析');
    const id = save(conv, data, maxSeq, leadId);
    if (!id) throw notFound('线索不存在');
    return get(id);
  }

  /** 同一个会话正在提取时，等那次的结果，不再调一次模型 */
  function runExtraction(convId, leadId = null) {
    const running = inflight.get(convId);
    if (running) return running;
    const p = extractConversation(convId, leadId)
      .then((lead) => {
        failures.delete(convId);
        return lead;
      })
      .finally(() => inflight.delete(convId));
    inflight.set(convId, p);
    return p;
  }

  /**
   * 后台扫描一次：leads.enabled=false 或模型没配置时什么也不做。逐个提取候选会话（最多 20 个）。
   * 超每日上限的跳过、下次再试；失败的 30 分钟内不再试。
   * @returns {Promise<{extracted:string[], limited:string[], failed:string[]}>} 会话 id（测试用）
   */
  async function scan() {
    const result = { extracted: [], limited: [], failed: [] };
    if (closed || scanning) return result;
    const s = ctx.getSettings();
    if (!s.leads?.enabled || !llmConfigured(s, ctx.config)) return result;
    scanning = true;
    try {
      const cutoff = new Date(Date.now() - LEAD_QUIET_MS).toISOString();
      const now = Date.now();
      for (const [id, at] of failures) if (now - at >= FAIL_RETRY_MS) failures.delete(id);
      const ids = db
        .prepare(CANDIDATES_SQL)
        .all(cutoff)
        .map((r) => r.id)
        .filter((id) => !failures.has(id) && !inflight.has(id));
      // 只数真正调了模型的（成功或失败）；超每日上限的不调模型，不占这次扫描的名额
      let attempts = 0;
      for (const convId of ids) {
        if (closed || attempts >= MAX_PER_SCAN) break;
        try {
          await runExtraction(convId);
          attempts++;
          result.extracted.push(convId);
        } catch (err) {
          if (closed) break;
          if (err?.code === 'llm_daily_limit') {
            result.limited.push(convId);
            continue;
          }
          attempts++;
          failures.set(convId, Date.now());
          result.failed.push(convId);
          log.warn(`[leads] 会话 ${convLogId(db, convId)} 提取客户线索失败，30 分钟后再试：${err?.message || err}`);
        }
      }
      if (result.extracted.length || result.failed.length) {
        log.info(`[leads] 提取了 ${result.extracted.length} 条客户线索，失败 ${result.failed.length} 个，超每日上限跳过 ${result.limited.length} 个`);
      }
    } finally {
      scanning = false;
    }
    return result;
  }

  return {
    scan,

    /** 开始定时扫描；intervalMs 为 0 时不启动（测试里手动调 scan） */
    start(intervalMs = LEADS_SCAN_INTERVAL_MS) {
      if (!intervalMs || timer || closed) return;
      timer = setInterval(() => {
        scan().catch((err) => log.error(`[leads] 扫描客户线索出错：${err?.stack || err}`));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },

    get,

    /**
     * @param {{accountIds?: string[]|null, assigneeId?: string|null, accountId?: string|null, stage?: string, q?: string}} f
     *   accountIds、assigneeId 是可见范围（auth.js 的 conversationScope），null 表示不限（admin）：agent 只看自己负责、
     *   而且有号权限的会话的线索，和会话的权限判断一致。按 lastContactAt 倒序
     */
    list({ accountIds = null, assigneeId = null, accountId = null, stage = '', q = '' } = {}) {
      if (stage && !LEAD_STAGE_KEYS.includes(stage)) throw badRequest(`stage 只能是 ${LEAD_STAGE_KEYS.join('、')} 之一`);
      const where = [];
      const params = [];
      if (accountId) {
        where.push('l.account_id = ?');
        params.push(accountId);
      }
      if (assigneeId !== null) {
        where.push('c.assignee_id = ?');
        params.push(assigneeId);
      }
      if (accountIds) {
        if (!accountIds.length) return [];
        where.push(`c.account_id IN (${accountIds.map(() => '?').join(', ')})`);
        params.push(...accountIds);
      }
      if (stage) {
        where.push('l.stage = ?');
        params.push(stage);
      }
      const needle = String(q || '').trim();
      // 按 lastContactAt 倒序；一样的按新建顺序倒序（sort 是稳定的，保留 SQL 的顺序）
      const sortKey = (l) => l.lastContactAt || l.updatedAt || '';
      return db
        .prepare(`${LEAD_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY l.rowid DESC`)
        .all(...params)
        .map(rowToLead)
        .filter((l) => !needle || matchesQuery(l, needle))
        .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
    },

    /**
     * 人工修改：只接受 LEAD_EDITABLE_FIELDS，传了的字段都记进 manualFields（之后重新提取不覆盖）；stage 变了写历史。
     * @returns {any} 完整的 Lead
     */
    update(id, body) {
      if (!isPlainObject(body)) throw badRequest('请求体必须是对象');
      const patch = {};
      for (const k of LEAD_EDITABLE_FIELDS) {
        const v = body[k];
        if (v === undefined) continue;
        if (typeof v !== 'string') throw badRequest(`${k} 必须是字符串`);
        if (k === 'stage') {
          if (!LEAD_STAGE_KEYS.includes(v)) throw badRequest(`stage 只能是 ${LEAD_STAGE_KEYS.join('、')} 之一`);
          patch.stage = v;
          continue;
        }
        const s = v.trim();
        if (s.length > LEAD_TEXT_FIELDS[k]) throw badRequest(`${k} 不能超过 ${LEAD_TEXT_FIELDS[k]} 个字`);
        if (k === 'email' && s && !/^[^\s@]+@[^\s@]+$/.test(s)) throw badRequest('邮箱格式不对');
        patch[k] = s;
      }
      const keys = Object.keys(patch);
      if (!keys.length) throw badRequest(`没有可修改的字段（只能改 ${LEAD_EDITABLE_FIELDS.join('、')}）`);
      db.transaction(() => {
        const cur = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
        if (!cur) throw notFound('线索不存在');
        const now = nowIso();
        const manual = [...new Set([...safeJsonParse(cur.manual_fields, []), ...keys])];
        db.prepare(
          `UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, manual_fields = ?, updated_at = ? WHERE id = ?`,
        ).run(...keys.map((k) => patch[k]), JSON.stringify(manual), now, id);
        if (patch.stage !== undefined && patch.stage !== cur.stage) addHistory(id, patch.stage, now);
      })();
      return get(id);
    },

    /** 删除线索和它的阶段历史。提取水位推到会话当前最新的消息，之后有新的客户消息才会再提取出一条新线索 */
    remove(id) {
      const cur = db.prepare('SELECT id, conversation_id FROM leads WHERE id = ?').get(id);
      if (!cur) return false;
      db.transaction(() => {
        db.prepare('DELETE FROM lead_stage_history WHERE lead_id = ?').run(id);
        db.prepare('DELETE FROM leads WHERE id = ?').run(id);
        const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages WHERE conversation_id = ?').get(cur.conversation_id).n;
        advanceWatermark(cur.conversation_id, maxSeq);
      })();
      return true;
    },

    /**
     * 立即重新提取（同步返回最新的 Lead）。不看三个触发条件，也不看 leads.enabled；照样计入会话每日模型次数。
     * 模型没配置 400 llm_not_configured，超上限 429 llm_daily_limit，模型出错 502 llm_error。
     */
    async refresh(id) {
      const cur = db.prepare('SELECT id, conversation_id FROM leads WHERE id = ?').get(id);
      if (!cur) throw notFound('线索不存在');
      if (!llmConfigured(ctx.getSettings(), ctx.config)) throw new HttpError(400, 'llm_not_configured', '还没有配置模型，请先到设置页填写');
      return runExtraction(cur.conversation_id, cur.id);
    },
  };
}
