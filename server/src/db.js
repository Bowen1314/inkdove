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
