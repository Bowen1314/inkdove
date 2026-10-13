import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  account_ids TEXT NOT NULL DEFAULT '[]',
  disabled INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  session_name TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  waha_config_hash TEXT,
  relay_port INTEGER,
  relay_username TEXT,
  relay_password TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice_messages (
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  short_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  text TEXT NOT NULL DEFAULT '',
  file_path TEXT,
  created_at TEXT NOT NULL,
  distilled_at TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gaps (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  phase TEXT NOT NULL,
  progress TEXT NOT NULL,
  log TEXT NOT NULL DEFAULT '[]',
  stats TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_number TEXT NOT NULL DEFAULT '',
  bot_paused INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  muted_until TEXT,
  llm_day TEXT,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  external_id TEXT,
  direction TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  used_entry_ids TEXT NOT NULL DEFAULT '[]',
  confident INTEGER,
  bot_decision TEXT,
  offtopic_strike INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  handled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS entries_origin ON entries(origin);
CREATE INDEX IF NOT EXISTS notice_short ON notice_messages(account_id, short_id);
`;

/**
 * 给已有表补列（第二期在第一期的库上加字段用）。下一段要加字段也用它。
 * @param {import('better-sqlite3').Database} db
 */
export function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * 知识库全文索引的两张表。重建时先 DROP 再用它建（kb/store.js 的 rebuildEntryIndex）。
 * - entries_fts：contentless 的 FTS5 表（content=''），只存倒排索引、不存一份原文，库小很多；contentless_delete=1 才能按
 *   rowid 删掉一行（改条目是先删再插）。存进去的列读不出来（读出来是 NULL），只能 MATCH、取 rowid 和 bm25；
 * - entries_fts_state：索引里每一行是按条目的哪个版本建的（rowid、id、updated_at），启动自检拿它和 entries 对。
 */
export const ENTRIES_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS entries_fts_state(entry_rowid INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, updated_at TEXT NOT NULL);`;

function migrate(db) {
  ensureColumn(db, 'auth_sessions', 'user_id', 'TEXT');
  // 第一期的会话没有 user_id，全部作废
  db.prepare('DELETE FROM auth_sessions WHERE user_id IS NULL').run();
  ensureColumn(db, 'conversations', 'account_id', 'TEXT');
  ensureColumn(db, 'conversations', 'chat_id', 'TEXT');
  ensureColumn(db, 'conversations', 'draft', 'TEXT');
  ensureColumn(db, 'messages', 'via', 'TEXT');
  ensureColumn(db, 'messages', 'sent_by_user_id', 'TEXT');
  ensureColumn(db, 'messages', 'sent_by_name', 'TEXT');
  ensureColumn(db, 'messages', 'decision_reason', 'TEXT');
  ensureColumn(db, 'messages', 'decision_code', 'TEXT');
  // F14 拆条发送：同一条回复拆成几条时的序号（0 起）；每小时回复上限只数第 0 条
  ensureColumn(db, 'messages', 'part_index', 'INTEGER');
  // 第一期 external_id 全局唯一；第二期多个号，改成会话内唯一
  db.exec('DROP INDEX IF EXISTS messages_external');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS messages_conv_external ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL',
  );
  db.exec('CREATE INDEX IF NOT EXISTS conversations_account ON conversations(account_id)');

  // ---- 第二期 B 段 ----
  // F2c：缺口来源、来自哪个会话、被问到的次数。旧行 origin 记 distill、count 记 1
  ensureColumn(db, 'gaps', 'origin', "TEXT NOT NULL DEFAULT 'distill'");
  ensureColumn(db, 'gaps', 'conversation_id', 'TEXT');
  ensureColumn(db, 'gaps', 'count', 'INTEGER NOT NULL DEFAULT 1');
  // F4：客户发来的语音、图片 {type, mime}；F15：消息带的文件 {fileId, filename, mime, size}
  ensureColumn(db, 'messages', 'media', 'TEXT');
  ensureColumn(db, 'messages', 'attachment', 'TEXT');
  // 待处理原因：置 needsHuman 时一起写，清 needsHuman 时清空。新加列时按已有消息回填一次
  const hadPendingReason = db.prepare('PRAGMA table_info(conversations)').all().some((c) => c.name === 'pending_reason');
  ensureColumn(db, 'conversations', 'pending_reason', 'TEXT');
  if (!hadPendingReason) {
    db.exec(`UPDATE conversations SET pending_reason = (
      SELECT m.decision_reason FROM messages m
       WHERE m.conversation_id = conversations.id AND m.direction = 'in'
         AND m.decision_reason IS NOT NULL AND m.decision_reason <> '' AND COALESCE(m.bot_decision, '') <> 'replied'
       ORDER BY m.seq DESC LIMIT 1)
     WHERE needs_human = 1`);
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS gap_hits (
  gap_id TEXT NOT NULL,
  conversation_id TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gap_hits_ts ON gap_hits(ts);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  description_status TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  kb_source_id TEXT,
  send_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_meta_media (
  file_id TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (file_id, phone_number_id)
);
`);

  // ---- 第三批：F12 看板要额外记录的数据（写入见 records.js） ----
  // decisions：引擎每处理一轮写一行（合并的几条消息算一轮），skipped 不写；code 是 codes.js 里的枚举
  // llm_calls：每次调用模型写一行，token 取不到时为 NULL
  // handoffs：needsHuman 从 false 变成 true 时新建一行，之后第一条人工消息填 first_response_*，机器人恢复时填 resumed_at
  db.exec(`
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT,
  decision TEXT NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  used_entry_ids TEXT NOT NULL DEFAULT '[]',
  sent_file_ids TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
CREATE INDEX IF NOT EXISTS decisions_account ON decisions(account_id, ts);
CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  purpose TEXT NOT NULL,
  format TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS llm_calls_ts ON llm_calls(ts);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  account_id TEXT,
  code TEXT,
  started_at TEXT NOT NULL,
  first_response_at TEXT,
  first_responder_user_id TEXT,
  first_responder_kind TEXT,
  resumed_at TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_conv ON handoffs(conversation_id, started_at);
CREATE INDEX IF NOT EXISTS handoffs_started ON handoffs(started_at);
`);

  // ---- 第三批：F6 客户线索（读写见 leads/store.js） ----
  // leads：每个会话一条，再次提取时覆盖更新；manual_fields 是人工改过的字段名（JSON 数组），重新提取时不覆盖。
  //   lastContactAt、号名、联系人名字和号码读的时候从会话和号表取，不存
  // lead_stage_history：stage 每变一次写一行（首次提取也写），F12 看板的漏斗用
  // conversations.lead_seq：上次提取（或删除线索）时会话里最新一条消息的 seq，之后有新的客户消息才再提取。
  //   放在会话上而不是线索上，删掉的线索不会被同样的旧消息再提取出来
  ensureColumn(db, 'conversations', 'lead_seq', 'INTEGER');
  db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  account_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  interest TEXT NOT NULL DEFAULT '',
  quantity TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'inquiry',
  summary TEXT NOT NULL DEFAULT '',
  manual_fields TEXT NOT NULL DEFAULT '[]',
  extracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_account ON leads(account_id);
CREATE TABLE IF NOT EXISTS lead_stage_history (
  lead_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_stage_history_lead ON lead_stage_history(lead_id, ts);
`);

  // ---- F5 红线体检（读写见 redteam/runner.js） ----
  // redteam_runs：每次体检一行。progress {done,total}、summary {total, redlinePassed, redlineFailed, legitReplied, legitRefused}、
  //   results（明细数组）都是 JSON，每判完一题更新一次。status：running | done | failed | cancelled。
  //   F12 看板的 kb.lastRedteam 取最近一次 done 的（按 finished_at）
  db.exec(`
CREATE TABLE IF NOT EXISTS redteam_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  progress TEXT NOT NULL,
  summary TEXT NOT NULL,
  results TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS redteam_runs_started ON redteam_runs(started_at);
`);

  // ---- F11 主动外联（读写见 outreach/store.js） ----
  // campaigns：外联任务。stats、perAccount 读的时候从 campaign_recipients 聚合，不存
  // campaign_recipients：文件里每个号码一行（格式不对、重复的也存，status=skipped），按 seq（文件里的顺序）发。
  //   number 是不带 + 的国际号码（格式不对的存原文）；tz 是号码所属国家的主时区，判断发送窗口用；
  //   chat_id 是实际发到的 chat（WAHA 查号接口可能给 @lid）；sent_day 是发出那天的服务器本地日期，数每个号每天的发送量用
  db.exec(`
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_id TEXT,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  account_ids TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL DEFAULT '',
  meta_template_name TEXT NOT NULL DEFAULT '',
  meta_template_language TEXT NOT NULL DEFAULT '',
  default_country TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS campaigns_status ON campaigns(status);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  line INTEGER NOT NULL,
  number TEXT NOT NULL,
  country TEXT,
  tz TEXT,
  account_id TEXT,
  chat_id TEXT,
  status TEXT NOT NULL,
  skip_reason TEXT,
  sent_at TEXT,
  sent_day TEXT,
  error TEXT,
  replied_at TEXT,
  declined_at TEXT,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign ON campaign_recipients(campaign_id, status, seq);
CREATE INDEX IF NOT EXISTS campaign_recipients_account ON campaign_recipients(account_id, status, sent_day);
CREATE INDEX IF NOT EXISTS campaign_recipients_number ON campaign_recipients(number);
`);

  // ---- F12 看板（dashboard.js）按时间段聚合用的索引 ----
  // 入站消息（客户消息数、新客户、热力图）和人工消息（成员表）按 direction + ts 取时间段；外联按 sent_at 取时间段。
  // decisions、llm_calls、handoffs、gap_hits 的时间索引上面已经建了
  db.exec(`
CREATE INDEX IF NOT EXISTS messages_direction_ts ON messages(direction, ts);
CREATE INDEX IF NOT EXISTS campaign_recipients_sent ON campaign_recipients(sent_at);
`);

  // ---- 按客户分配会话（读写见 wa/assign.js） ----
  // conversations.assignee_id：负责这个会话的成员，NULL 是未分配（只有 admin 看得到）；assigned_at：最近一次改负责人的时间。
  // conversation_assignments：负责人每变一次写一行。to_user_id 为 NULL 是取消分配，by_user_id 为 NULL 是系统做的；
  //   reason：manual | bulk | transfer | migration | campaign | access_removed | user_deleted
  ensureColumn(db, 'conversations', 'assignee_id', 'TEXT');
  ensureColumn(db, 'conversations', 'assigned_at', 'TEXT');
  db.exec(`
CREATE INDEX IF NOT EXISTS conversations_assignee ON conversations(assignee_id);
CREATE TABLE IF NOT EXISTS conversation_assignments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  from_user_id TEXT,
  to_user_id TEXT,
  by_user_id TEXT,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_assignments_conv ON conversation_assignments(conversation_id, at);
`);
  migrateAssignments(db);

  // ---- 推荐回复：业务员个人话术（每个成员自己改，起草推荐回复时拼进提示词） ----
  ensureColumn(db, 'users', 'style_prompt', "TEXT NOT NULL DEFAULT ''");

  // ---- 我的资料（每个成员自己改）：对客户的称呼、职位、联系电话、联系邮箱、补充介绍。起草推荐回复和转人工草稿时作为
  // 【业务员信息】拼进提示词，自动回复不用；只在 /api/auth/me 里返回，成员列表、登录不带。老库启动时自动加列 ----
  for (const col of ['display_name', 'job_title', 'contact_phone', 'contact_email', 'bio']) {
    ensureColumn(db, 'users', col, "TEXT NOT NULL DEFAULT ''");
  }

  // ---- 知识库全文索引（读写和启动自检见 kb/store.js） ----
  // entries_fts：每个条目一行（不管什么状态都进），rowid 和 entries 的 rowid 相同；body 是 kb/search.js 的 entryIndexText
  //   （中文先切成两字一组再用空格连起来，unicode61 才能按词匹配）。检索时 JOIN entries 按 status 过滤，不靠索引判断状态。
  // entries_fts_state：和 entries_fts 一行对一行，记建索引时条目的 rowid、id 和更新时间，两张表总在同一个事务里一起写。
  //   启动时拿它和 entries 逐行对一遍，对不上就整个重建。
  // 已经有旧结构的 entries_fts（带 entry_id、updated_at 列的那一版）时 CREATE ... IF NOT EXISTS 不动它，启动自检发现
  //   索引版本不对，整个重建成新结构。
  // entries_status：按状态 + 创建时间取条目（回复时判断能不能全带、整理资料时取标题样本）不用扫全表、不用排序
  db.exec(`${ENTRIES_FTS_DDL}
CREATE INDEX IF NOT EXISTS entries_status ON entries(status, created_at);
`);

  // ---- 消息译成中文（wa/translate.js 的 translateMessage）：会话里点「翻译」的译文 {text, via, createdAt, truncated?}（JSON），
  // 存一次大家都看得到、不再调接口。老库启动时自动加列，没译过的为 NULL ----
  ensureColumn(db, 'messages', 'translation', 'TEXT');

  // ---- 消息撤回（wa/service.js 的 revokeMessage、handleRevoked）：撤回过的消息原文保留，只记什么时候、谁撤回的。
  // revoked_by：member（业务员在墨鸽里点「撤回」，revoked_by_user_id / revoked_by_name 记成员 id 和当时的名字）、
  //   customer（客户撤回了他发的消息）、phone（在同一个号的手机等其他设备上撤回了我方消息）。
  // 撤回过的消息不再进模型的上下文（自动回复、推荐回复、转人工草稿、线索提取、判断客户语言）。老库启动时自动加列，没撤回过的为 NULL ----
  ensureColumn(db, 'messages', 'revoked_at', 'TEXT');
  ensureColumn(db, 'messages', 'revoked_by', 'TEXT');
  ensureColumn(db, 'messages', 'revoked_by_user_id', 'TEXT');
  ensureColumn(db, 'messages', 'revoked_by_name', 'TEXT');

  // ---- 可选的向量检索（后台计算和检索见 kb/vectors.js） ----
  // 每个条目按 kb/vectors.js 的 entrySegments 分成一段或几段，每段一行（chunk 从 0 起）。kind 现在只有 entry。
  // model_key：格式 + 接口地址 + 模型名的哈希（ai/embed.js 的 embedModelKey），只用和当前设置一样的行；换了模型，新的算完一行
  //   就覆盖一行（主键不含 model_key），全部算完后把剩下的旧行删掉。
  // text_hash：分段后文字的哈希，文字没变就不重算；source_updated_at：算的时候条目的 updated_at，和条目一样就不用再比哈希。
  // quant：vec 的存法，现在只有 int8：vec 是 dims 个 int8 字节，原值 ≈ int8 × scale（scale = 归一化后最大绝对值 / 127），
  //   和内存里检索用的是同一份，读出来不用再量化。以后换存法时旧格式的行当作没算过（kb/vectors.js 的 QUANT）。
  // 条目删除时在同一个事务里删掉（kb/store.js）；停用的留着，重新启用不用重算。
  db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  model_key TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  dims INTEGER NOT NULL,
  quant TEXT NOT NULL,
  scale REAL NOT NULL,
  vec BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id, chunk)
);
CREATE INDEX IF NOT EXISTS embeddings_model ON embeddings(model_key, kind);
`);
}

/**
 * 升级到按客户分配时跑一次（kv 的 assignments_migrated 记标记，新装的库第一次启动就记上，之后新建的会话不会被它分配）：
 * 已有会话里，它的号恰好只有一个启用中（disabled=0）的 agent 有权限的，分给这个 agent（reason=migration，系统做的）；
 * 其余保持未分配。为的是升级后 agent 不至于什么都看不到。
 * @param {import('better-sqlite3').Database} db
 */
function migrateAssignments(db) {
  if (kvGet(db, 'assignments_migrated', false)) return;
  db.transaction(() => {
    /** @type {Map<string, string[]>} 号 id → 有权限的启用中 agent */
    const agentsOf = new Map();
    for (const u of db.prepare("SELECT id, account_ids FROM users WHERE role = 'agent' AND disabled = 0").all()) {
      let ids = [];
      try {
        ids = JSON.parse(u.account_ids || '[]');
      } catch {
        /* 存坏了的按没有号 */
      }
      for (const accountId of Array.isArray(ids) ? new Set(ids) : []) {
        if (!agentsOf.has(accountId)) agentsOf.set(accountId, []);
        agentsOf.get(accountId).push(u.id);
      }
    }
    const now = new Date().toISOString();
    const update = db.prepare('UPDATE conversations SET assignee_id = ?, assigned_at = ? WHERE id = ? AND assignee_id IS NULL');
    const history = db.prepare(
      `INSERT INTO conversation_assignments(id, conversation_id, from_user_id, to_user_id, by_user_id, reason, at)
       VALUES(?, ?, NULL, ?, NULL, 'migration', ?)`,
    );
    for (const c of db.prepare('SELECT id, account_id FROM conversations WHERE assignee_id IS NULL AND account_id IS NOT NULL').all()) {
      const agents = agentsOf.get(c.account_id) || [];
      if (agents.length !== 1) continue;
      if (update.run(agents[0], now, c.id).changes) history.run(crypto.randomUUID(), c.id, agents[0], now);
    }
    kvSet(db, 'assignments_migrated', true);
  })();
}

/**
 * @param {string} dataDir
 */
export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'files', 'tmp'), { recursive: true });
  const db = new Database(path.join(dataDir, 'inkdove.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** @param {import('better-sqlite3').Database} db */
export function kvGet(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

/** @param {import('better-sqlite3').Database} db */
export function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
