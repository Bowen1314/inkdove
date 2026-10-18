// F11 主动外联：任务和收件人（表见 db.js）、上传号码的预检和分配、每个号一个的发送循环、外联对象的回复和拒绝。
// 每个号码只发一条开场消息，不做任何跟进。权限（agent 只能看和操作自己建的任务）由路由判断，见 routes/campaigns.js；
// 选号的权限（agent 只能选分配给自己的号）在 create 里判断。
import crypto from 'node:crypto';
import { DELETED_ACCOUNT_NAME } from '../accounts.js';
import { canAccessAccount, forbidden } from '../auth.js';
import { quoteWords } from '../blockwords/store.js';
import { campaignStatusLabel } from '../codes.js';
import { badRequest, clip, HttpError, newId, safeJsonParse } from '../util.js';
import { localDay } from '../wa/service.js';
import { createWahaClient } from '../wa/waha.js';
import { inWindow, mainTimezone, parsePhoneLine, supportedCountry } from './phone.js';

/** 后台检查一遍有没有能发的（窗口打开了、过了零点、号连上了）的间隔 */
export const OUTREACH_TICK_MS = 60_000;
export const MAX_FILE_BYTES = 1024 * 1024;
/** 号码行（不算空行和 # 开头的行）上限 */
export const MAX_NUMBER_LINES = 10_000;
export const MAX_MESSAGE_CHARS = 4096;
const MAX_NAME_CHARS = 100;
/** 同一个号在同一个任务里连续失败几次后自动暂停任务 */
export const FAILS_TO_PAUSE = 3;
export const CAMPAIGN_MODES = ['single', 'pooled'];
/** 预检时判断的跳过原因（not_on_whatsapp 在发送时判断） */
export const PRECHECK_SKIP_REASONS = ['invalid', 'duplicate', 'blocklisted', 'notify_number', 'already_contacted'];
export const RECIPIENT_STATUSES = ['pending', 'sent', 'failed', 'skipped'];
const MAX_PAGE_SIZE = 200;

const iso = (ms) => new Date(ms).toISOString();

function rowToRecipient(r) {
  return {
    id: r.id,
    number: r.number,
    accountId: r.account_id ?? null,
    status: r.status,
    skipReason: r.skip_reason ?? null,
    sentAt: r.sent_at ?? null,
    error: r.error ?? null,
    repliedAt: r.replied_at ?? null,
    declinedAt: r.declined_at ?? null,
    conversationId: r.conversation_id ?? null,
  };
}

/** multipart 的 accountIds：JSON 数组字符串（也接受已经是数组的），去重 */
function parseAccountIds(v) {
  let list = v;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      throw badRequest('accountIds 必须是 JSON 数组');
    }
  }
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x)) throw badRequest('accountIds 必须是号 id 的数组');
  return [...new Set(list)];
}

const textField = (v, field, max) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest(`${field} 必须是字符串`);
  const s = v.trim();
  if (s.length > max) throw badRequest(`${field} 太长，最多 ${max} 个字符`);
  return s;
};

/** 洗牌（Fisher–Yates） */
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * @param {any} ctx 需要 db、log、accounts、getSettings、config、wa（sendCampaignMessage、getStatus）
 * @param {{now?: () => number, intervalMs?: () => number}} [opts]
 *   now：时钟（毫秒），判断发送窗口、每天的发送量和记时间都用它，测试里注入；
 *   intervalMs：两条之间等多久，默认在设置的 [min, max] 秒之间随机，测试里注入成 0
 */
export function createOutreach(ctx, opts = {}) {
  const { db, log, accounts } = ctx;
  const now = opts.now || Date.now;
  const settings = () => ctx.getSettings().outreach;
  const intervalMs =
    opts.intervalMs ||
    (() => {
      const o = settings();
      return Math.round((o.minIntervalSeconds + Math.random() * (o.maxIntervalSeconds - o.minIntervalSeconds)) * 1000);
    });
  // 查号接口单独建一个 WAHA 客户端（无状态）；发消息走 ctx.wa，登记回声、写会话和消息
  const waha = createWahaClient(ctx.config);

  /** @type {Map<string, {rerun:boolean, promise:Promise<void>|null}>} 号 id → 正在跑的发送循环（同一个号同时只有一个） */
  const loops = new Map();
  /** @type {Map<string, number>} `${campaignId}|${accountId}` → 连续失败次数（只记在内存里） */
  const fails = new Map();
  const abort = new AbortController();
  let timer = null;
  let closed = false;
  /** 等一段时间；关闭时立刻中断。等完就把监听去掉（发几千条也不会在 signal 上越积越多） */
  const wait = (ms) =>
    new Promise((resolve, reject) => {
      if (abort.signal.aborted) return reject(abort.signal.reason);
      const onAbort = () => {
        clearTimeout(t);
        reject(abort.signal.reason);
      };
      const t = setTimeout(() => {
        abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });

  const getRow = (id) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  const statusOf = (id) => db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id)?.status ?? null;

  // ---------------- 视图 ----------------
  /** 任务 → 对外视图。stats、perAccount 读的时候聚合；perAccount.sentToday 是这个任务今天（服务器本地日期）在这个号上发的数 */
  function view(c) {
    const accountIds = safeJsonParse(c.account_ids, []);
    const today = localDay(new Date(now()));
    const agg = db
      .prepare(
        `SELECT account_id, status, COUNT(*) n,
           SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) replied,
           SUM(CASE WHEN declined_at IS NOT NULL THEN 1 ELSE 0 END) declined,
           SUM(CASE WHEN sent_day = ? THEN 1 ELSE 0 END) today
         FROM campaign_recipients WHERE campaign_id = ? GROUP BY account_id, status`,
      )
      .all(today, c.id);
    const stats = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0, replied: 0, declined: 0 };
    const per = new Map(
      accountIds.map((id) => [
        id,
        { accountId: id, accountName: accounts.get(id)?.name ?? DELETED_ACCOUNT_NAME, assigned: 0, sent: 0, failed: 0, replied: 0, declined: 0, sentToday: 0 },
      ]),
    );
    for (const a of agg) {
      stats.total += a.n;
      if (stats[a.status] !== undefined) stats[a.status] += a.n;
      stats.replied += a.replied;
      stats.declined += a.declined;
      const p = a.account_id ? per.get(a.account_id) : null;
      if (!p) continue;
      p.assigned += a.n;
      if (a.status === 'sent') p.sent += a.n;
      if (a.status === 'failed') p.failed += a.n;
      p.replied += a.replied;
      p.declined += a.declined;
      p.sentToday += a.today;
    }
    return {
      id: c.id,
      name: c.name,
      createdBy: { id: c.created_by_id ?? null, name: c.created_by_name },
      createdAt: c.created_at,
      mode: c.mode,
      accountIds,
      message: c.message,
      metaTemplate: { name: c.meta_template_name, languageCode: c.meta_template_language },
      defaultCountry: c.default_country,
      status: c.status,
      error: c.error ?? null,
      stats,
      perAccount: [...per.values()],
      startedAt: c.started_at ?? null,
      finishedAt: c.finished_at ?? null,
      // 生效中的外联参数（agent 读不到设置；开始发送的确认文案用）
      outreach: { ...settings() },
    };
  }

  // ---------------- 预检用的号码集合 ----------------
  /** 联系过的号码：任何一个号有会话的（包括导入的已有聊天、只有机主手机消息的），以及以前的外联任务发出过的 */
  function contactedNumbers() {
    const set = new Set();
    for (const r of db.prepare('SELECT contact_number, chat_id FROM conversations').iterate()) {
      if (r.contact_number) set.add(r.contact_number);
      const chat = String(r.chat_id || '');
      const m = /^(\d+)@c\.us$/.exec(chat);
      if (m) set.add(m[1]);
      else if (/^\d+$/.test(chat)) set.add(chat); // Meta 的 chat id 就是号码
    }
    for (const r of db.prepare("SELECT DISTINCT number FROM campaign_recipients WHERE status = 'sent'").iterate()) set.add(r.number);
    return set;
  }

  /** 单个号码联系过没有（发送前再查一遍用） */
  function isContacted(number) {
    if (db.prepare("SELECT 1 FROM campaign_recipients WHERE number = ? AND status = 'sent' LIMIT 1").get(number)) return true;
    return !!db
      .prepare('SELECT 1 FROM conversations WHERE contact_number = ? OR chat_id = ? OR chat_id = ? LIMIT 1')
      .get(number, `${number}@c.us`, number);
  }

  /** 所有号的通知号码（不管 WhatsApp 通知开没开） */
  const notifyNumbers = () => new Set(accounts.list().map((a) => a.notify?.whatsapp?.number).filter(Boolean));

  // ---------------- 新建和预检 ----------------
  /**
   * 新建任务（draft）并预检。号码文件里每个号码行存一个收件人：格式不对、重复的，以及在黑名单里、是通知号码、联系过的，
   * 直接记 skipped；其余的按 mode 分给号（创建时定死，之后不变），status=pending。
   * @param {any} user 当前用户
   * @param {{buffer:Buffer, originalname:string}|undefined} file
   * @param {Record<string, any>} body multipart 的文字字段
   * @returns {{campaign:any, preview:{valid:number, invalidLines:{line:number, raw:string}[], skipped:Record<string, number>}}}
   */
  function create(user, file, body) {
    const b = body || {};
    const name = textField(b.name, 'name', 1000);
    if (!name) throw badRequest('请填写任务名称', 'name_required');
    if ([...name].length > MAX_NAME_CHARS) throw badRequest(`任务名称最多 ${MAX_NAME_CHARS} 个字`);
    const mode = b.mode;
    if (!CAMPAIGN_MODES.includes(mode)) throw badRequest('mode 只能是 single 或 pooled');
    const accountIds = parseAccountIds(b.accountIds);
    if (!accountIds.length) throw badRequest('至少选择一个号', 'accounts_required');
    if (mode === 'single' && accountIds.length !== 1) throw badRequest('「指定一个号」只能选一个号');
    // agent 只能选分配给自己的号
    if (accountIds.some((id) => !canAccessAccount(user, id))) throw forbidden();
    const accs = accountIds.map((id) => {
      const a = accounts.get(id);
      if (!a) throw badRequest('选的号不存在或已删除', 'account_not_found');
      // LINE 官方帐号只能给加了好友的人发消息，号码文件里的手机号对不上 LINE 用户
      if (a.channel === 'line') throw badRequest(`「${a.name}」是 LINE 官方帐号，不能外联群发：LINE 只能给加了好友的人发消息，按手机号找不到人`, 'line_unsupported');
      return a;
    });
    const defaultCountry = textField(b.defaultCountry, 'defaultCountry', 10).toUpperCase() || 'CN';
    if (!supportedCountry(defaultCountry)) throw badRequest(`不支持的默认国家：${defaultCountry}`, 'invalid_country');
    const message = textField(b.message, 'message', MAX_MESSAGE_CHARS);
    const hasMeta = accs.some((a) => a.channel === 'meta');
    const tplName = hasMeta ? textField(b.metaTemplateName, 'metaTemplateName', 512) : '';
    const tplLang = hasMeta ? textField(b.metaTemplateLanguage, 'metaTemplateLanguage', 20) : '';
    if (hasMeta && (!tplName || !tplLang)) {
      throw badRequest('选中的号里有 Meta 号：Meta 主动发起会话必须用审核通过的模板消息，请填写模板名和语言', 'template_required');
    }
    if (accs.some((a) => a.channel !== 'meta') && !message) throw badRequest('请填写开场消息', 'message_required');
    // 屏蔽词：开场消息里有就不建任务（400），管理员会收到提醒。只选了 Meta 号时发的是模板，这段消息不发出去，不查
    if (message && accs.some((a) => a.channel !== 'meta')) {
      ctx.blockwords.guard(message, {
        source: 'campaign',
        accountId: accs.length === 1 ? accs[0].id : null,
        accountName: accs.map((a) => a.name).join('、'),
        campaign: { id: null, name },
        user,
      });
    }

    // 号码文件：.txt，UTF-8，≤1MB（multer 限制），号码行 ≤10000
    if (!file) throw badRequest('请上传号码文件（字段名 file）', 'file_required');
    if (!/\.txt$/i.test(String(file.originalname || ''))) throw badRequest('只支持 .txt 文件', 'unsupported_file');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw badRequest('文件不是 UTF-8 编码，请另存为 UTF-8 后再上传', 'bad_encoding');
    }
    const items = [];
    text
      .replace(/^﻿/, '')
      .split(/\r\n|\n|\r/)
      .forEach((raw, i) => {
        const s = raw.trim();
        if (s && !s.startsWith('#')) items.push({ line: i + 1, raw: s });
      });
    if (!items.length) throw badRequest('文件里没有号码', 'empty_file');
    if (items.length > MAX_NUMBER_LINES) {
      throw badRequest(`号码不能超过 ${MAX_NUMBER_LINES} 行，这个文件有 ${items.length} 行`, 'too_many_lines');
    }

    // 预检：格式 → 重复 → 通知号码 → 联系过 → 分配 → 分到的号的黑名单
    const contacted = contactedNumbers();
    const notify = notifyNumbers();
    const seen = new Set();
    const rows = [];
    const valid = [];
    const skip = (r, reason) => {
      r.status = 'skipped';
      r.skipReason = reason;
    };
    for (const it of items) {
      const p = parsePhoneLine(it.raw, defaultCountry);
      if (!p) {
        rows.push({ line: it.line, number: clip(it.raw, 100), country: null, tz: null, accountId: null, status: 'skipped', skipReason: 'invalid' });
        continue;
      }
      const r = { line: it.line, number: p.digits, country: p.country, tz: mainTimezone(p.country), accountId: null, status: 'pending', skipReason: null };
      rows.push(r);
      if (seen.has(p.digits)) skip(r, 'duplicate');
      else {
        seen.add(p.digits);
        if (notify.has(p.digits)) skip(r, 'notify_number');
        else if (contacted.has(p.digits)) skip(r, 'already_contacted');
        else valid.push(r);
      }
    }
    // pooled：打乱后轮流分，各号分到的数量最多差 1
    if (mode === 'single') for (const r of valid) r.accountId = accountIds[0];
    else shuffle([...valid]).forEach((r, i) => (r.accountId = accountIds[i % accountIds.length]));
    const byId = new Map(accs.map((a) => [a.id, a]));
    for (const r of valid) if (byId.get(r.accountId).blocklist.includes(r.number)) skip(r, 'blocklisted');

    const id = newId();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO campaigns(id, name, created_by_id, created_by_name, created_at, mode, account_ids, message, meta_template_name,
                               meta_template_language, default_country, status)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      ).run(id, name, user.id, user.name || user.email || '', iso(now()), mode, JSON.stringify(accountIds), message, tplName, tplLang, defaultCountry);
      const ins = db.prepare(
        `INSERT INTO campaign_recipients(id, campaign_id, seq, line, number, country, tz, account_id, status, skip_reason)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      rows.forEach((r, i) => ins.run(newId(), id, i, r.line, r.number, r.country, r.tz, r.accountId, r.status, r.skipReason));
    })();

    const skipped = Object.fromEntries(PRECHECK_SKIP_REASONS.map((k) => [k, 0]));
    for (const r of rows) if (r.status === 'skipped') skipped[r.skipReason]++;
    const preview = {
      valid: rows.filter((r) => r.status === 'pending').length,
      invalidLines: rows.filter((r) => r.skipReason === 'invalid').map((r) => ({ line: r.line, raw: r.number })),
      skipped,
    };
    log.info(`[outreach] ${user.email || user.id} 新建外联任务 ${id}：${rows.length} 个号码，有效 ${preview.valid} 个`);
    return { campaign: view(getRow(id)), preview };
  }

  // ---------------- 状态 ----------------
  const badStatus = (c, action) => new HttpError(409, 'invalid_status', `任务当前是「${campaignStatusLabel(c.status)}」，不能${action}`);

  /** 没有待发号码的 running 任务转为 done */
  function checkDone(campaignId) {
    const r = db
      .prepare(
        `UPDATE campaigns SET status = 'done', finished_at = ?
         WHERE id = ? AND status = 'running' AND NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending')`,
      )
      .run(iso(now()), campaignId, campaignId);
    if (r.changes) log.info(`[outreach] 外联任务 ${campaignId} 发送完毕`);
  }

  /** 把这个任务用到的号的发送循环都拉起来 */
  function kickCampaign(campaignId) {
    const ids = db
      .prepare("SELECT DISTINCT account_id FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' AND account_id IS NOT NULL")
      .all(campaignId);
    for (const r of ids) kick(r.account_id);
  }

  function start(id) {
    const c = getRow(id);
    if (c.status !== 'draft') throw badStatus(c, '开始');
    db.prepare("UPDATE campaigns SET status = 'running', started_at = ?, error = NULL WHERE id = ? AND status = 'draft'").run(iso(now()), id);
    checkDone(id);
    kickCampaign(id);
    return view(getRow(id));
  }

  function pause(id) {
    const c = getRow(id);
    if (c.status !== 'running') throw badStatus(c, '暂停');
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'running'").run(id);
    return view(getRow(id));
  }

  function resume(id) {
    const c = getRow(id);
    if (c.status !== 'paused') throw badStatus(c, '继续');
    db.prepare("UPDATE campaigns SET status = 'running', error = NULL WHERE id = ? AND status = 'paused'").run(id);
    for (const key of [...fails.keys()]) if (key.startsWith(`${id}|`)) fails.delete(key);
    checkDone(id);
    kickCampaign(id);
    return view(getRow(id));
  }

  /** 取消：没发的号码留在 pending，不再发 */
  function cancel(id) {
    const c = getRow(id);
    if (!['draft', 'running', 'paused'].includes(c.status)) throw badStatus(c, '取消');
    db.prepare("UPDATE campaigns SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('draft', 'running', 'paused')").run(
      iso(now()),
      id,
    );
    return view(getRow(id));
  }

  function remove(id) {
    const c = getRow(id);
    if (!['draft', 'cancelled', 'done'].includes(c.status)) throw badStatus(c, '删除');
    db.transaction(() => {
      db.prepare('DELETE FROM campaign_recipients WHERE campaign_id = ?').run(id);
      db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
    })();
  }

  /**
   * 收件人分页。status 只认 pending、sent、failed、skipped（空表示全部）；page 从 1 起；按文件里的顺序。
   * @returns {{recipients:any[], total:number}}
   */
  function recipients(id, { status = '', page = 1, pageSize = 50 } = {}) {
    if (status && !RECIPIENT_STATUSES.includes(status)) throw badRequest('status 只能是 pending、sent、failed 或 skipped');
    const p = Number(page);
    const size = Number(pageSize);
    if (!Number.isInteger(p) || p < 1) throw badRequest('page 必须是从 1 开始的整数');
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) throw badRequest(`pageSize 必须是 1–${MAX_PAGE_SIZE} 的整数`);
    const where = status ? 'campaign_id = ? AND status = ?' : 'campaign_id = ?';
    const params = status ? [id, status] : [id];
    const total = db.prepare(`SELECT COUNT(*) n FROM campaign_recipients WHERE ${where}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM campaign_recipients WHERE ${where} ORDER BY seq LIMIT ? OFFSET ?`)
      .all(...params, size, (p - 1) * size);
    return { recipients: rows.map(rowToRecipient), total };
  }

  // ---------------- 发送 ----------------
  /** 号连上了没有：WAHA 要 working，Meta 要凭证齐全（configured） */
  async function connected(acc) {
    try {
      const st = await ctx.wa.getStatus(acc, { maxAgeMs: 5000, timeoutMs: 3000 });
      if (acc.channel === 'meta') return st.state === 'configured';
      if (acc.channel === 'waha') return st.state === 'working';
      return false;
    } catch {
      return false;
    }
  }

  const PENDING_JOIN = `FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
    WHERE r.account_id = ? AND r.status = 'pending' AND c.status = 'running'`;

  /** 这个号今天（服务器本地日期）发出的外联总数，所有任务合计 */
  const sentOn = (accountId, day) =>
    db.prepare("SELECT COUNT(*) n FROM campaign_recipients WHERE account_id = ? AND status = 'sent' AND sent_day = ?").get(accountId, day).n;

  /** 这个号下一个能发的：running 任务里 pending、收件人当地时间在窗口内的；先开始的任务先发，同一任务按文件顺序 */
  function nextRecipient(accountId, t, o) {
    const open = db
      .prepare(`SELECT DISTINCT r.tz ${PENDING_JOIN}`)
      .all(accountId)
      .map((x) => x.tz)
      .filter((tz) => inWindow(tz || 'UTC', t, o.windowStart, o.windowEnd));
    if (!open.length) return null;
    return db
      .prepare(
        `SELECT r.*, c.message, c.meta_template_name, c.meta_template_language, c.created_by_id, c.created_by_name, c.name AS campaign_name ${PENDING_JOIN}
           AND COALESCE(r.tz, 'UTC') IN (${open.map(() => '?').join(', ')})
         ORDER BY c.started_at, c.rowid, r.seq LIMIT 1`,
      )
      .get(accountId, ...open.map((tz) => tz || 'UTC'));
  }

  /** 号被删了：它在 running 任务里没发的号码记失败，任务能正常结束 */
  function dropDeletedAccount(accountId) {
    const ids = db.prepare(`SELECT DISTINCT r.campaign_id ${PENDING_JOIN}`).all(accountId);
    db.prepare(
      `UPDATE campaign_recipients SET status = 'failed', error = '发送用的号已删除'
       WHERE account_id = ? AND status = 'pending' AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'running')`,
    ).run(accountId);
    for (const r of ids) checkDone(r.campaign_id);
  }

  const skipRecipient = (id, reason) =>
    db.prepare("UPDATE campaign_recipients SET status = 'skipped', skip_reason = ? WHERE id = ? AND status = 'pending'").run(reason, id);

  /**
   * 给一个收件人发开场消息。返回 true 表示调了 WhatsApp 的接口（之后要等一个间隔），false 表示本地就跳过了。
   * @param {any} acc
   * @param {any} r 收件人行（带任务的 message、模板和发起人 created_by_id）
   */
  async function sendTo(acc, r) {
    const key = `${r.campaign_id}|${acc.id}`;
    // 发送前再查一遍：建任务之后号的黑名单、通知号码可能改了，别的任务或客户自己也可能已经联系过他（每个号码只发一条）
    const late = acc.blocklist.includes(r.number)
      ? 'blocklisted'
      : notifyNumbers().has(r.number)
        ? 'notify_number'
        : isContacted(r.number)
          ? 'already_contacted'
          : null;
    if (late) {
      skipRecipient(r.id, late);
      checkDone(r.campaign_id);
      return false;
    }
    // 屏蔽词：建任务之后才加的词，发之前再查一遍（扫码号发的是这段原文；Meta 发模板，不查）。命中就暂停整个任务、只记一条，
    // 这个号码留着不发。去掉这个词或者重建任务之后才能继续
    if (acc.channel !== 'meta') {
      const hit = ctx.blockwords.check(r.message, {
        source: 'campaign',
        accountId: acc.id,
        campaign: { id: r.campaign_id, name: r.campaign_name },
        user: r.created_by_id ? { id: r.created_by_id, name: r.created_by_name } : null,
      });
      if (hit) {
        const error = `开场消息里有屏蔽词${quoteWords(hit.words)}，任务已自动暂停，没有发出`;
        db.prepare("UPDATE campaigns SET status = 'paused', error = ? WHERE id = ? AND status = 'running'").run(error, r.campaign_id);
        log.warn(`[outreach] 外联任务 ${r.campaign_id} 的开场消息命中屏蔽词，已自动暂停`);
        return false;
      }
    }
    let chatId = acc.channel === 'meta' ? r.number : `${r.number}@c.us`;
    try {
      if (acc.channel === 'waha') {
        const ex = await waha.checkExists(acc.sessionName, r.number);
        if (!ex.exists) {
          skipRecipient(r.id, 'not_on_whatsapp');
          fails.delete(key);
          checkDone(r.campaign_id);
          return true;
        }
        if (ex.chatId) chatId = ex.chatId;
      }
      // 查号期间任务被暂停或取消了：这一条留着不发
      if (statusOf(r.campaign_id) !== 'running') return true;
      const template = acc.channel === 'meta' ? { name: r.meta_template_name, languageCode: r.meta_template_language } : null;
      // Meta 发的是模板，会话里存一条说明是哪个模板
      const text = template ? `[模板] ${template.name}（${template.languageCode}）` : r.message;
      // 发起人是有这个号权限的 agent 时，新会话分给他（按客户分配）
      const res = await ctx.wa.sendCampaignMessage(acc, { chatId, number: r.number, text, template, createdById: r.created_by_id });
      const t = now();
      db.prepare(
        `UPDATE campaign_recipients SET status = 'sent', sent_at = ?, sent_day = ?, chat_id = ?, conversation_id = ?, error = NULL
         WHERE id = ?`,
      ).run(iso(t), localDay(new Date(t)), chatId, res.conversationId, r.id);
      fails.delete(key);
    } catch (err) {
      const msg = clip(String(err?.message || err), 500);
      db.prepare("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?").run(msg, r.id);
      const n = (fails.get(key) || 0) + 1;
      fails.set(key, n);
      // 日志不记号码和错误原文（错误里可能带 chat id），原文在收件人和任务的 error 里
      log.warn(`[outreach] 号 ${acc.id} 发外联失败（任务 ${r.campaign_id}，连续第 ${n} 次）`);
      if (n >= FAILS_TO_PAUSE) {
        fails.delete(key);
        const error = `号「${acc.name}」连续 ${n} 次发送失败，任务已自动暂停。最后一次的错误：${msg}`;
        const p = db.prepare("UPDATE campaigns SET status = 'paused', error = ? WHERE id = ? AND status = 'running'").run(error, r.campaign_id);
        if (p.changes) log.warn(`[outreach] 外联任务 ${r.campaign_id} 在号 ${acc.id} 上连续失败 ${n} 次，已自动暂停`);
      }
    }
    checkDone(r.campaign_id);
    return true;
  }

  /**
   * 一个号的发送循环：条件都满足时一条一条发，每发一条随机等一个间隔；没有能发的（任务都不在 running、号没连上、
   * 今天到上限、收件人当地时间都不在窗口内、都发完了）就退出，等定时检查（tick）或开始、继续时再拉起来。
   */
  async function runAccount(accountId) {
    for (;;) {
      if (closed) return;
      if (!db.prepare(`SELECT 1 ${PENDING_JOIN} LIMIT 1`).get(accountId)) return;
      const acc = accounts.get(accountId);
      if (!acc) return void dropDeletedAccount(accountId);
      if (!(await connected(acc)) || closed) return;
      const o = settings();
      const t = now();
      if (sentOn(accountId, localDay(new Date(t))) >= o.dailyCapPerAccount) return;
      const r = nextRecipient(accountId, t, o);
      if (!r) return;
      const touched = await sendTo(acc, r);
      if (touched && !closed) {
        try {
          await wait(Math.max(0, intervalMs()));
        } catch {
          return;
        }
      }
    }
  }

  /** 拉起这个号的发送循环；已经在跑的只做个记号，跑完这一轮再看一遍 */
  function kick(accountId) {
    if (closed || !accountId) return;
    const cur = loops.get(accountId);
    if (cur) {
      cur.rerun = true;
      return;
    }
    const me = { rerun: false, promise: null };
    loops.set(accountId, me);
    me.promise = (async () => {
      try {
        do {
          me.rerun = false;
          await runAccount(accountId);
        } while (me.rerun && !closed);
      } catch (err) {
        log.error(`[outreach] 号 ${accountId} 的外联发送循环出错：${err?.stack || err}`);
      } finally {
        loops.delete(accountId);
      }
    })();
  }

  /** 定时检查：running 任务没有待发号码的转 done；有待发号码的号都拉起发送循环（进程重启后也靠它接着发） */
  function tick() {
    if (closed) return;
    try {
      for (const c of db.prepare("SELECT id FROM campaigns WHERE status = 'running'").all()) checkDone(c.id);
      const ids = db
        .prepare(
          `SELECT DISTINCT r.account_id FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
           WHERE c.status = 'running' AND r.status = 'pending' AND r.account_id IS NOT NULL`,
        )
        .all();
      for (const r of ids) kick(r.account_id);
    } catch (err) {
      log.error(`[outreach] 检查外联任务出错：${err?.stack || err}`);
    }
  }

  // ---------------- 回复和拒绝（service.js 调） ----------------
  /** 这个号给这个号码（或 chat）发过外联：白名单模式下也算在回复范围内 */
  function isContact(accountId, number, chatId) {
    if (!number && !chatId) return false;
    return !!db
      .prepare("SELECT 1 FROM campaign_recipients WHERE account_id = ? AND status = 'sent' AND (number = ? OR chat_id = ?) LIMIT 1")
      .get(accountId, number || '', chatId || '');
  }

  /**
   * 收到客户消息：是这个号的外联对象、还没记过回复的，记 repliedAt，会话 id 换成实际回复所在的会话
   * （发到 @c.us、回复从 @lid 来时是两个会话）。按号码或 chat 匹配。
   */
  function noteInbound({ accountId, number, chatId, conversationId }) {
    try {
      db.prepare(
        `UPDATE campaign_recipients SET replied_at = ?, conversation_id = ?
         WHERE account_id = ? AND status = 'sent' AND replied_at IS NULL AND (number = ? OR chat_id = ? OR conversation_id = ?)`,
      ).run(iso(now()), conversationId, accountId, number || '', chatId || '', conversationId);
    } catch (err) {
      log.warn(`[outreach] 记外联回复失败：${err?.message || err}`);
    }
  }

  /** 会话被判 declined：对应的外联对象记 declinedAt（拒绝的那条消息本身也是回复，repliedAt 没记的一起记上） */
  function noteDeclined({ accountId, conversationId }) {
    const conv = db.prepare('SELECT contact_number, chat_id FROM conversations WHERE id = ?').get(conversationId) || {};
    const at = iso(now());
    db.prepare(
      `UPDATE campaign_recipients SET declined_at = ?, replied_at = COALESCE(replied_at, ?)
       WHERE account_id = ? AND status = 'sent' AND declined_at IS NULL AND (conversation_id = ? OR number = ? OR chat_id = ?)`,
    ).run(at, at, accountId, conversationId, conv.contact_number || '\u0000', conv.chat_id || '\u0000');
  }

  return {
    create,
    /** 任务行（路由判断权限用），不存在为 null */
    getRow: (id) => getRow(id) || null,
    view,
    /** admin 看全部；agent 只看自己建的 */
    list(user) {
      const rows =
        user.role === 'admin'
          ? db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC, rowid DESC').all()
          : db.prepare('SELECT * FROM campaigns WHERE created_by_id = ? ORDER BY created_at DESC, rowid DESC').all(user.id);
      return rows.map(view);
    },
    start,
    pause,
    resume,
    cancel,
    remove,
    recipients,
    isContact,
    noteInbound,
    noteDeclined,
    tick,
    /** 后台跑起来：先检查一遍（进程重启后 running 的任务接着发），再按 tickMs 定时检查；tickMs 为 0 时不启动定时器（测试里手动调 tick） */
    run(tickMs = OUTREACH_TICK_MS) {
      if (closed) return;
      tick();
      if (tickMs && !timer) {
        timer = setInterval(tick, tickMs);
        timer.unref?.();
      }
    },
    /** 停下：不再拉起新的循环，打断正在等的间隔，等正在发的那一条发完 */
    async stop() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      abort.abort(new Error('closing'));
      await Promise.allSettled([...loops.values()].map((l) => l.promise));
    },
    /** 测试用：没有在跑的发送循环 */
    idle: () => loops.size === 0,
  };
}
