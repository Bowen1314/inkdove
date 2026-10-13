// 知识库检索：全文索引跟着条目走、启动自检和重建、检索词限量和转义、按总字数截断、全带档、跨语言改写（触发条件、失败退回、
// 计入会话的每日模型次数）、整理资料（合并候选、画像和列问题的标题样本）和红线体检的限量。模型都用 mock。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { kvSet, openDb } from '../src/db.js';
import { llmScope } from '../src/records.js';
import { createMockAi } from '../src/ai/mock.js';
import { REWRITE_MAX_TERMS, selectEntries } from '../src/kb/retrieve.js';
import { CONTEXT_CHAR_LIMIT, contextLength, fitToBudget, MAX_QUERY_TERMS, pickQueryTerms, tokenize } from '../src/kb/search.js';
import { createKbStore, ensureEntryIndex, ENTRY_INDEX_VERSION } from '../src/kb/store.js';
import { buildReplyContext, decideReply } from '../src/reply/engine.js';
import { DAILY_LLM_LIMIT, localDay } from '../src/wa/service.js';
import { aiHooks, convIdOf, convPath, getConv, quietLog, startApp, startFakeWaha, waitDecided, waitFor, wahaSend } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inkdove-kbsearch-'));
/** 和测试问题都不共用词的填充条目，每条约 1900 字，凑够 40000 字让回复走检索 */
const filler = (i) => ({
  type: 'fact',
  title: `填充资料 ${i}`,
  content: Array.from({ length: 160 }, (_, k) => `alpha${i}x${k}`).join(' '),
  origin: 'manual',
});
const PRICE = { type: 'product', title: '保温杯 A100 价格', content: '保温杯 A100 价格 59 元，容量 500ml。', origin: 'manual' };
const MOQ = { type: 'policy', title: '起订量', content: '起订量 100 件，下单后 15 天发货。', origin: 'manual' };
/** 索引记的条目版本（entries_fts_state）：entry_id → {rowid, updatedAt} */
const ftsRows = (db) =>
  new Map(db.prepare('SELECT entry_rowid, entry_id, updated_at FROM entries_fts_state').all().map((r) => [r.entry_id, { rowid: r.entry_rowid, updatedAt: r.updated_at }]));
/** 全文索引（contentless 表）的行数 */
const ftsCount = (db) => db.prepare('SELECT COUNT(*) FROM entries_fts').pluck().get();
const ids = (list) => list.map((e) => e.id);
const later = () => new Date(Date.now() + 60_000).toISOString();

describe('知识库全文索引：跟着条目走', () => {
  let dir;
  let db;
  let kb;
  let log;
  beforeEach(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = tmpDir();
    db = openDb(dir);
    log = quietLog();
    kb = createKbStore(db, { log });
  });
  after(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const consistent = () => ensureEntryIndex(db, log).rebuilt === false;

  it('新增：索引里有这一行（记的 rowid、id、updated_at 和条目相同），按切好的词能检索到；索引表不存原文', () => {
    const e = kb.insertEntry(PRICE);
    const row = ftsRows(db).get(e.id);
    assert.equal(row.rowid, db.prepare('SELECT rowid FROM entries WHERE id = ?').pluck().get(e.id));
    assert.equal(row.updatedAt, e.updatedAt);
    assert.equal(ftsCount(db), 1);
    assert.equal(db.prepare('SELECT body FROM entries_fts').pluck().get(), null, 'contentless：读不出存进去的内容');
    assert.deepEqual(ids(kb.searchEntries(['保温'])), [e.id]);
    assert.deepEqual(ids(kb.searchEntries(['a100'])), [e.id]);
    assert.ok(consistent());
  });

  it('改内容：新词能检索到，旧词检索不到；改状态：active 检索不到、不管状态的能检索到；删除：索引里也没了', () => {
    const e = kb.insertEntry(PRICE);
    const other = kb.insertEntry(MOQ);
    kb.updateEntry(e.id, { content: '真空杯 B200 报价 79 元' });
    assert.deepEqual(ids(kb.searchEntries(['真空'])), [e.id]);
    assert.deepEqual(kb.searchEntries(['容量']), [], '旧内容里的词检索不到了');
    assert.deepEqual(ids(kb.searchEntries(['保温'])), [e.id], '标题没改，标题里的词还在');
    assert.ok(consistent());

    const updated = kb.updateEntry(e.id, { status: 'disabled' });
    assert.equal(ftsRows(db).get(e.id).updatedAt, updated.updatedAt, '改状态也更新索引里的 updated_at');
    assert.deepEqual(kb.searchEntries(['真空']), [], '停用的不出现在回复检索里');
    assert.deepEqual(ids(kb.searchEntries(['真空'], { status: null })), [e.id]);
    assert.ok(consistent());

    assert.equal(kb.deleteEntry(e.id), true);
    assert.equal(ftsRows(db).has(e.id), false);
    assert.equal(ftsCount(db), 1);
    assert.deepEqual(kb.searchEntries(['真空'], { status: null }), [], '删掉的连停用的检索也查不到');
    assert.equal(kb.deleteEntry(e.id), false);
    assert.deepEqual(ids(kb.searchEntries(['起订'])), [other.id]);
    assert.ok(consistent());
  });

  it('删掉最后一条再加新条目（rowid 复用）：旧条目的词查不到，新条目的查得到', () => {
    const a = kb.insertEntry(MOQ);
    const b = kb.insertEntry(PRICE);
    const rowidB = db.prepare('SELECT rowid FROM entries WHERE id = ?').pluck().get(b.id);
    kb.deleteEntry(b.id);
    const c = kb.insertEntry({ type: 'fact', title: '营业时间', content: '周一到周五', origin: 'manual' });
    assert.equal(db.prepare('SELECT rowid FROM entries WHERE id = ?').pluck().get(c.id), rowidB, '新条目用了被删条目的 rowid');
    assert.deepEqual(kb.searchEntries(['保温'], { status: null }), []);
    assert.deepEqual(ids(kb.searchEntries(['营业'])), [c.id]);
    assert.deepEqual(ids(kb.searchEntries(['起订'])), [a.id]);
    assert.equal(ftsCount(db), 2);
    assert.ok(consistent());
  });

  it('整理资料的全部重建：蒸馏条目连同索引一起删，手动条目留着', () => {
    const d1 = kb.insertEntry({ ...PRICE, origin: 'distill' });
    const d2 = kb.insertEntry({ ...MOQ, origin: 'distill' });
    const m = kb.insertEntry({ type: 'fact', title: '保温杯工厂', content: '工厂在永康', origin: 'manual' });
    assert.equal(kb.deleteDistillEntries(), 2);
    const rows = ftsRows(db);
    assert.equal(rows.has(d1.id) || rows.has(d2.id), false);
    assert.equal(ftsCount(db), 1);
    assert.deepEqual(ids(kb.searchEntries(['保温'])), [m.id]);
    assert.deepEqual(kb.searchEntries(['起订'], { status: null }), []);
    assert.ok(consistent());
  });

  it('空库：自检不重建，检索返回空，全带档返回空数组', () => {
    assert.deepEqual(ensureEntryIndex(db, log), { rebuilt: false, entries: 0 });
    assert.equal(log.lines.filter((l) => l.includes('重建')).length, 0);
    assert.deepEqual(kb.searchEntries(['保温']), []);
    assert.deepEqual(kb.searchEntries([]), []);
    assert.deepEqual(kb.activeEntriesWithin(CONTEXT_CHAR_LIMIT), []);
    assert.deepEqual(kb.sampleTitles(15), []);
  });

  it('检索词转义：双引号、AND/OR/NOT/NEAR、星号、括号都只当普通文字，不报错', () => {
    const e = kb.insertEntry({ type: 'faq', title: 'NOT OR AND', content: 'near the port', origin: 'manual' });
    for (const terms of [['a"b'], ['"'], ['AND'], ['OR', 'NOT'], ['NEAR'], ['*'], ['near('], [')'], ['^x'], ['a" OR "b'], ['']]) {
      assert.doesNotThrow(() => kb.searchEntries(terms), JSON.stringify(terms));
    }
    assert.deepEqual(ids(kb.searchEntries(['not'])), [e.id], 'not 当普通词');
    assert.deepEqual(ids(kb.searchEntries(['near'])), [e.id]);
    assert.equal(log.lines.filter((l) => l.includes('全文检索出错')).length, 0);
  });
});

describe('知识库全文索引：启动自检（旧版本直接改了 entries 表、没动索引）', () => {
  let dir;
  let db;
  let base;
  before(() => {
    dir = tmpDir();
  });
  after(() => {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** 用新版本建好库：三条条目，索引一致 */
  const fresh = () => {
    if (db) db.close();
    fs.rmSync(path.join(dir, 'inkdove.db'), { force: true });
    fs.rmSync(path.join(dir, 'inkdove.db-wal'), { force: true });
    fs.rmSync(path.join(dir, 'inkdove.db-shm'), { force: true });
    db = openDb(dir);
    const kb = createKbStore(db, { log: quietLog() });
    base = { a: kb.insertEntry(PRICE), b: kb.insertEntry(MOQ), c: kb.insertEntry({ type: 'fact', title: '营业时间', content: '周一到周五 9:00-18:00', origin: 'manual' }) };
    assert.equal(ensureEntryIndex(db).rebuilt, false);
  };
  /** 像旧版本那样只改 entries 表 */
  const oldVersion = {
    改内容: () => db.prepare('UPDATE entries SET content = ?, updated_at = ? WHERE id = ?').run('真空杯 B200 报价 79 元', later(), base.a.id),
    改状态: () => db.prepare("UPDATE entries SET status = 'disabled', updated_at = ? WHERE id = ?").run(later(), base.b.id),
    删条目: () => db.prepare('DELETE FROM entries WHERE id = ?').run(base.c.id),
    加条目: () =>
      db
        .prepare(
          `INSERT INTO entries(id, type, title, content, tags, source_refs, status, origin, created_at, updated_at)
           VALUES('old-1', 'faq', '样品', '样品免费，运费到付。', '[]', '[]', 'active', 'manual', ?, ?)`,
        )
        .run(later(), later()),
    索引版本不对: () => kvSet(db, 'entries_fts_version', ENTRY_INDEX_VERSION - 1),
  };

  for (const [name, mutate] of Object.entries(oldVersion)) {
    it(`${name}：发现对不上，整个重建，日志写一行；重建后再自检不重建`, () => {
      fresh();
      mutate();
      const log = quietLog();
      const kb = createKbStore(db, { log });
      const lines = log.lines.filter((l) => l.includes('知识库全文索引') && l.includes('已重建'));
      assert.equal(lines.length, 1, log.lines.join('\n'));
      assert.equal(ensureEntryIndex(db, log).rebuilt, false);
      const rows = ftsRows(db);
      const entries = db.prepare('SELECT rowid, id, updated_at FROM entries').all();
      assert.equal(rows.size, entries.length);
      assert.equal(ftsCount(db), entries.length);
      for (const e of entries) assert.deepEqual([rows.get(e.id).rowid, rows.get(e.id).updatedAt], [e.rowid, e.updated_at]);
      if (name === '改内容') {
        assert.deepEqual(ids(kb.searchEntries(['真空'])), [base.a.id]);
        assert.deepEqual(kb.searchEntries(['容量']), []);
      }
      if (name === '改状态') assert.deepEqual(kb.searchEntries(['起订']), []);
      if (name === '删条目') assert.deepEqual(kb.searchEntries(['营业']), []);
      if (name === '加条目') assert.deepEqual(ids(kb.searchEntries(['样品'])), ['old-1']);
    });
  }

  it('几种一起改也只重建一次；不传 log 的 createKbStore 也自检重建，只是不写日志', () => {
    fresh();
    for (const mutate of Object.values(oldVersion)) mutate();
    assert.equal(ensureEntryIndex(db).rebuilt, true);
    assert.equal(ensureEntryIndex(db).rebuilt, false);
    db.prepare('DELETE FROM entries WHERE id = ?').run(base.a.id);
    const kb = createKbStore(db);
    assert.equal(ensureEntryIndex(db).rebuilt, false, '创建时已经重建过了');
    assert.deepEqual(kb.searchEntries(['真空'], { status: null }), []);
  });

  it('索引表还是旧结构（非 contentless、带 entry_id 和 updated_at 列，索引版本 1）：重建成新结构', () => {
    fresh();
    db.exec(`DROP TABLE entries_fts; DROP TABLE entries_fts_state;
      CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id UNINDEXED, updated_at UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
      INSERT INTO entries_fts(rowid, entry_id, updated_at, body) SELECT rowid, id, updated_at, title FROM entries;`);
    kvSet(db, 'entries_fts_version', 1);
    db.close();
    db = openDb(dir);
    const log = quietLog();
    const kb = createKbStore(db, { log });
    assert.ok(log.lines.some((l) => l.includes('索引版本不对') && l.includes('已重建 3 条')), log.lines.join('\n'));
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'").pluck().get(), /content=''/);
    assert.equal(ftsRows(db).size, 3);
    assert.deepEqual(ids(kb.searchEntries(['营业'])), [base.c.id]);
    assert.equal(ensureEntryIndex(db).rebuilt, false);
  });

  it('新装的空库：第一次自检建好空索引、记上版本，不写日志', () => {
    db?.close();
    for (const f of ['inkdove.db', 'inkdove.db-wal', 'inkdove.db-shm']) fs.rmSync(path.join(dir, f), { force: true });
    db = openDb(dir);
    const log = quietLog();
    assert.deepEqual(ensureEntryIndex(db, log), { rebuilt: true, entries: 0 });
    assert.deepEqual(log.lines, []);
    assert.deepEqual(ensureEntryIndex(db, log), { rebuilt: false, entries: 0 });
  });

  it('应用启动时自检：库里有旧版本写的条目，启动后日志有重建的一行，检索得到', async () => {
    fresh();
    oldVersion.加条目();
    db.close();
    db = null;
    const t = await startApp({ env: { INKDOVE_DATA_DIR: dir } });
    try {
      assert.ok(t.log.lines.some((l) => l.includes('知识库全文索引') && l.includes('已重建 4 条')), t.log.lines.join('\n'));
      assert.deepEqual(ids(t.ctx.kb.searchEntries(['样品'])), ['old-1']);
    } finally {
      await t.close();
    }
    // 再启动一次：一致，不重建
    const t2 = await startApp({ env: { INKDOVE_DATA_DIR: dir } });
    try {
      assert.ok(!t2.log.lines.some((l) => l.includes('已重建')), t2.log.lines.join('\n'));
    } finally {
      await t2.close();
    }
  });

  it('不认识索引的旧版本另开连接照常写条目（索引表没有触发器，不会出错）；新版本再打开时重建', () => {
    fresh();
    db.close();
    const raw = new Database(path.join(dir, 'inkdove.db'));
    raw.prepare('UPDATE entries SET title = ?, updated_at = ? WHERE id = ?').run('改过的标题 真空杯', later(), base.a.id);
    raw.prepare('DELETE FROM entries WHERE id = ?').run(base.b.id);
    raw.close();
    db = openDb(dir);
    const log = quietLog();
    const kb = createKbStore(db, { log });
    assert.ok(log.lines.some((l) => l.includes('已重建 2 条')), log.lines.join('\n'));
    assert.deepEqual(ids(kb.searchEntries(['真空'])), [base.a.id]);
    assert.deepEqual(kb.searchEntries(['起订']), []);
  });
});

describe('检索词：限量和优先级', () => {
  it('很长的消息最多 64 个词，开头和结尾都有；本次消息的词排在前面，再补最近的客户消息', () => {
    const chars = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
    const terms = pickQueryTerms([chars]);
    assert.equal(terms.length, MAX_QUERY_TERMS);
    assert.equal(terms[0], chars.slice(0, 2), '有开头的词');
    assert.ok(terms.some((t) => chars.indexOf(t) > 2800), '有结尾附近的词');

    const msg = 'thermos price moq';
    const hist = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const picked = pickQueryTerms([msg, hist]);
    assert.equal(picked.length, MAX_QUERY_TERMS);
    assert.deepEqual(picked.slice(0, 3), ['thermos', 'price', 'moq']);
    assert.deepEqual(pickQueryTerms(['a the of', '']), [], '只有停用词时没有可用的词');
    assert.deepEqual(pickQueryTerms(['价格 价格', '价格 运费']), ['价格', '运费'], '去重');
  });

  it('按总字数截断：按排名放整条，放不下的跳过、接着放后面更短的，最多 topK 条', () => {
    const mk = (id, n) => ({ id, type: 'fact', title: id, content: 'x'.repeat(n), tags: [] });
    const ranked = [mk('a', 15000), mk('b', 15000), mk('c', 15000), mk('d', 500), mk('e', 500)];
    assert.deepEqual(ids(fitToBudget(ranked, 40000, 20)), ['a', 'b', 'd', 'e']);
    assert.deepEqual(ids(fitToBudget(ranked, 40000, 3)), ['a', 'b', 'd']);
    assert.deepEqual(ids(fitToBudget([mk('big', 50000), mk('s', 10)], 40000, 20)), ['s']);
    assert.ok(fitToBudget(ranked, 40000, 20).reduce((n, e) => n + contextLength(e), 0) <= 40000);
  });
});

describe('回复检索：全带档、检索档、按总字数截断、跨语言改写', () => {
  let t;
  let hooks;
  let price;
  let moq;
  before(async () => {
    hooks = await aiHooks();
    t = await startApp({ options: { aiOverrides: hooks.overrides } });
    await t.login();
    price = t.ctx.kb.insertEntry(PRICE);
    moq = t.ctx.kb.insertEntry(MOQ);
  });
  after(() => t.close());

  it('全带档：总字数不超过 40000 时全带，顺序按创建时间，和检索词无关；不调改写', async () => {
    const all = t.ctx.kb.activeEntries();
    const r = await selectEntries(t.ctx, { texts: ['完全不相干的话 zzz'], rewrite: true });
    assert.equal(r.mode, 'all');
    assert.deepEqual(ids(r.entries), ids(all));
    assert.equal(hooks.calls.searchTerms, 0);
    const c = await buildReplyContext(t.ctx, { message: '¿Cuál es el precio del termo?', searchRewrite: true });
    assert.deepEqual(ids(c.entries), ids(all));
    assert.equal(c.searchCalls, 0);
    const d = await decideReply(t.ctx, { message: '¿Cuál es el precio del termo?' });
    assert.equal(d.llmCalls, 1, '只有生成（mock 判转人工），没有改写');
    assert.equal(hooks.calls.searchTerms, 0);
  });

  it('检索档：超过 40000 字后按索引挑，带进去的总字数不超过 40000；改写只在允许、命中不足时做', async () => {
    for (let i = 0; i < 25; i++) t.ctx.kb.insertEntry(filler(i));
    // 几条很长的、都含"保温杯"的条目：一起放会超过预算
    for (let i = 0; i < 4; i++) t.ctx.kb.insertEntry({ type: 'fact', title: `保温杯长说明 ${i}`, content: `保温杯 ${'说明'.repeat(7000)} ${i}`, origin: 'manual' });
    assert.equal(t.ctx.kb.activeEntriesWithin(CONTEXT_CHAR_LIMIT), null);

    const r = await selectEntries(t.ctx, { texts: ['保温杯 A100 价格多少'], rewrite: false });
    assert.equal(r.mode, 'search');
    assert.equal(r.entries[0].id, price.id);
    assert.ok(r.entries.reduce((n, e) => n + contextLength(e), 0) <= CONTEXT_CHAR_LIMIT);
    assert.ok(r.entries.length >= 3, '长条目放不下的跳过了，后面的还在');
    assert.equal(hooks.calls.searchTerms, 0, 'rewrite: false 不调');

    // 命中够 20 条：不改写
    const many = await selectEntries(t.ctx, { texts: [Array.from({ length: 25 }, (_, i) => `alpha${i}x0`).join(' ')], rewrite: true });
    assert.equal(many.entries.length, 20);
    assert.equal(hooks.calls.searchTerms, 0);
    // 没有可用的词：不检索也不改写
    const none = await selectEntries(t.ctx, { texts: ['?? !!'], rewrite: true });
    assert.deepEqual(none.entries, []);
    assert.equal(hooks.calls.searchTerms, 0);
  });

  it('跨语言：西班牙语问价，原话一条都没命中，改写成中文检索词后找到价格条目；同一段话再查用缓存不再调模型', async () => {
    const message = '¿Cuál es el precio del termo?';
    assert.deepEqual(t.ctx.kb.searchEntries(pickQueryTerms([message])), [], '原话一个词都对不上');
    const c = await buildReplyContext(t.ctx, { message, history: [{ role: 'customer', text: 'Hola' }], searchRewrite: true });
    assert.equal(hooks.calls.searchTerms, 1);
    assert.equal(c.searchCalls, 1);
    assert.deepEqual(c.searchTerms, ['价格', '报价', '保温杯']);
    assert.equal(c.entries[0].id, price.id);
    const args = hooks.args.searchTerms;
    assert.equal(args.query, `Hola\n${message}`, '按说话先后带上最近的客户消息');
    assert.ok(args.sampleTitles.length > 0 && args.sampleTitles.length <= 15);

    const again = await buildReplyContext(t.ctx, { message, history: [{ role: 'customer', text: 'Hola' }], searchRewrite: true });
    assert.equal(hooks.calls.searchTerms, 1, '30 分钟内同一段话直接用上次的结果');
    assert.equal(again.searchCalls, 0);
    assert.deepEqual(ids(again.entries), ids(c.entries));
  });

  it('改写出来的词按 tokenize 切、最多 32 个，排在原话的词前面', async () => {
    hooks.searchTerms = () => ({ terms: Array.from({ length: 30 }, (_, i) => `起订量${i}号`) });
    try {
      const c = await buildReplyContext(t.ctx, { message: 'cantidad mínima por favor', searchRewrite: true });
      assert.equal(c.searchCalls, 1);
      assert.ok(ids(c.entries).includes(moq.id));
      const extra = pickQueryTerms(c.searchTerms, REWRITE_MAX_TERMS);
      assert.equal(extra.length, REWRITE_MAX_TERMS);
      assert.ok(extra.every((x) => tokenize(c.searchTerms.join(' ')).includes(x)));
    } finally {
      hooks.searchTerms = null;
    }
  });

  it('改写失败、超时、解析不了：记一行 warn，退回只用原话的结果，这次调用照样算 1 次', async () => {
    const before = t.log.lines.length;
    hooks.searchTerms = () => {
      throw new Error('模型超时');
    };
    try {
      const c = await buildReplyContext(t.ctx, { message: '¿Tienen garantía?', searchRewrite: true });
      assert.deepEqual(c.entries, []);
      assert.equal(c.searchCalls, 1);
      assert.deepEqual(c.searchTerms, []);
      hooks.searchTerms = () => ({ foo: 'bar' });
      const c2 = await buildReplyContext(t.ctx, { message: '¿Tienen muestras?', searchRewrite: true });
      assert.deepEqual(c2.entries, []);
      assert.equal(c2.searchCalls, 1);
    } finally {
      hooks.searchTerms = null;
    }
    const warns = t.log.lines.slice(before).filter((l) => l.startsWith('warn') && l.includes('检索词改写失败'));
    assert.equal(warns.length, 2, t.log.lines.slice(before).join('\n'));
    // 失败的不进缓存：下次同一段话还会再试
    const c3 = await buildReplyContext(t.ctx, { message: '¿Tienen garantía?', searchRewrite: true });
    assert.equal(c3.searchCalls, 1);
    assert.deepEqual(c3.searchTerms, ['保修', '质保']);
  });

  it('客户消息里有双引号、FTS 关键字、星号：照常检索，不报错', async () => {
    const before = t.log.lines.length;
    const c = await buildReplyContext(t.ctx, { message: 'He said "A100" AND price* OR NOT NEAR(a b) ^moq "', searchRewrite: false });
    assert.equal(c.entries[0].id, price.id);
    assert.ok(!t.log.lines.slice(before).some((l) => l.includes('全文检索出错')));
  });

  it('decideReply：剩下的次数不到 3 次不改写；够的话改写算进 llmCalls（改写 + 生成 + 审核 = 3）', async () => {
    const calls0 = hooks.calls.searchTerms;
    const r2 = await decideReply(t.ctx, { message: '¿precio del termo A100? (1)', llmBudget: 2 });
    assert.equal(hooks.calls.searchTerms, calls0, '只够生成 + 审核，不改写');
    assert.equal(r2.decision, 'replied');
    assert.equal(r2.llmCalls, 2);
    const r3 = await decideReply(t.ctx, { message: '¿precio del termo A100? (2)', llmBudget: 3 });
    assert.equal(hooks.calls.searchTerms, calls0 + 1);
    assert.equal(r3.decision, 'replied');
    assert.equal(r3.llmCalls, 3);
    assert.ok(r3.usedEntryIds.includes(price.id), '改写后找到了价格条目');
    // /api/kb/ask 不限次数：照常改写，llm_calls 记 kb_search
    const ask = await t.req('POST', '/api/kb/ask', { body: { message: '¿precio del termo A100? (3)' } });
    assert.equal(ask.status, 200);
    assert.equal(hooks.calls.searchTerms, calls0 + 2);
    const count = (purpose) => t.ctx.db.prepare('SELECT COUNT(*) FROM llm_calls WHERE purpose = ?').pluck().get(purpose);
    assert.ok(count('kb_search') >= 1);
    // 红线体检里的改写记成 redteam（llmScope 覆盖按方法名推出的用途）
    const [kbSearch, redteam] = [count('kb_search'), count('redteam')];
    const rt = await llmScope({ purpose: 'redteam', accountId: null, conversationId: null }, () =>
      decideReply(t.ctx, { message: '¿precio del termo A100? (4)' }),
    );
    assert.equal(rt.llmCalls, 3);
    assert.equal(hooks.calls.searchTerms, calls0 + 3);
    assert.equal(count('kb_search'), kbSearch);
    assert.equal(count('redteam'), redteam + 3, '改写 + 生成 + 审核都记 redteam');
  });
});

describe('跨语言改写计入会话的每日模型次数', () => {
  let t;
  let fake;
  let hooks;
  let autoAcc;
  let manualAcc;
  let seq = 0;
  const newChat = () => `86137${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;
  const idle = () => waitFor(() => t.ctx.wa.idle());
  const llmCalls = (convId) => t.ctx.db.prepare('SELECT llm_calls FROM conversations WHERE id = ?').pluck().get(convId);

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url }, options: { aiOverrides: hooks.overrides } });
    await t.login();
    t.ctx.kb.insertEntry(PRICE);
    for (let i = 0; i < 25; i++) t.ctx.kb.insertEntry(filler(i));
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    autoAcc = await t.createAccount({ name: '改写自动号', replyMode: 'auto' });
    manualAcc = await t.createAccount({ name: '改写人工号' });
    for (const a of [autoAcc, manualAcc]) await t.req('POST', `/api/accounts/${a.id}/waha/start`);
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('自动回复：改写 + 生成 + 审核 = 3 次；llm_calls 里有一行 kb_search，记在这个会话上', async () => {
    const chat = newChat();
    const convId = convIdOf(autoAcc, chat);
    const before = hooks.calls.searchTerms;
    await wahaSend(t, autoAcc, chat, '¿precio del termo A100?');
    await waitDecided(t, convId, 1);
    await idle();
    assert.equal(hooks.calls.searchTerms, before + 1);
    assert.equal(llmCalls(convId), 3);
    const row = t.ctx.db.prepare("SELECT * FROM llm_calls WHERE purpose = 'kb_search' AND conversation_id = ?").get(convId);
    assert.ok(row);
    assert.equal(row.account_id, autoAcc.id);
  });

  it('转人工后起草草稿：同一段话用生成回复时改写的结果，不再调模型；改写 + 生成 + 草稿 = 3 次', async () => {
    const chat = newChat();
    const convId = convIdOf(autoAcc, chat);
    const before = hooks.calls.searchTerms;
    await wahaSend(t, autoAcc, chat, '¿Hacen envío a México?');
    await waitDecided(t, convId, 1);
    await idle();
    assert.equal((await getConv(t, convId)).draft?.kind, 'handoff');
    assert.equal(hooks.calls.searchTerms, before + 1);
    assert.equal(llmCalls(convId), 3);
  });

  it('当天剩下的次数不够：自动回复不改写（生成 + 审核照常），用到 60 次整', async () => {
    const chat = newChat();
    const convId = convIdOf(autoAcc, chat);
    await wahaSend(t, autoAcc, chat, '¿precio del termo A100? hola');
    await waitDecided(t, convId, 1);
    await idle();
    const used = DAILY_LLM_LIMIT - 2;
    t.ctx.db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(localDay(), used, convId);
    const before = hooks.calls.searchTerms;
    await wahaSend(t, autoAcc, chat, '¿precio del termo A100? otra vez');
    await waitDecided(t, convId, 2);
    await idle();
    assert.equal(hooks.calls.searchTerms, before, '剩 2 次只够生成 + 审核');
    assert.equal(llmCalls(convId), DAILY_LLM_LIMIT);
  });

  it('推荐回复：起草 + 改写 = 2 次；「换一条」同一段话用缓存，只加起草的 1 次；剩 1 次时不改写', async () => {
    const chat = newChat();
    const convId = convIdOf(manualAcc, chat);
    await wahaSend(t, manualAcc, chat, '¿Cuál es el precio del termo, por favor?');
    await waitDecided(t, convId, 1);
    await idle();
    assert.equal(llmCalls(convId) ?? 0, 0, '人工回复的号来消息不调模型');
    const before = hooks.calls.searchTerms;
    assert.equal((await t.req('POST', `${convPath(convId)}/suggest`)).status, 200);
    assert.equal(hooks.calls.searchTerms, before + 1);
    assert.equal(llmCalls(convId), 2);
    assert.ok(hooks.args.suggest.entries.some((e) => e.title === PRICE.title), '改写后找到的价格条目进了推荐回复的上下文');
    assert.equal((await t.req('POST', `${convPath(convId)}/suggest`)).status, 200);
    assert.equal(hooks.calls.searchTerms, before + 1);
    assert.equal(llmCalls(convId), 3);

    const chat2 = newChat();
    const conv2 = convIdOf(manualAcc, chat2);
    await wahaSend(t, manualAcc, chat2, '¿Tienen garantía los termos?');
    await waitDecided(t, conv2, 1);
    await idle();
    t.ctx.db.prepare('UPDATE conversations SET llm_day = ?, llm_calls = ? WHERE id = ?').run(localDay(), DAILY_LLM_LIMIT - 1, conv2);
    assert.equal((await t.req('POST', `${convPath(conv2)}/suggest`)).status, 200);
    assert.equal(hooks.calls.searchTerms, before + 1, '只够起草，不改写');
    assert.equal(llmCalls(conv2), DAILY_LLM_LIMIT);
  });
});

describe('整理资料和红线体检：不再读整个知识库', () => {
  let t;
  const seen = {};
  const mock = createMockAi({ delayMs: 0 });
  const capture = (name) => (args) => {
    seen[name] = args;
    (seen[`${name}All`] ||= []).push(args);
    return mock[name](args);
  };
  before(async () => {
    t = await startApp({ options: { aiOverrides: { profile: capture('profile'), listQuestions: capture('listQuestions'), consolidate: capture('consolidate'), judgeQuestions: capture('judgeQuestions') } } });
    await t.login();
  });
  after(() => t.close());

  it('合并候选走索引：不含本批条目，停用的已有条目也算候选；画像和列问题的标题最多 200 条、每条最多 100 字，按创建时间均匀挑；判断问题带的条目不超过 40000 字', async () => {
    const titles = [];
    for (let i = 0; i < 250; i++) {
      const title = i % 50 === 0 ? `长标题${i} ${'很'.repeat(150)}` : `条目标题 ${i}`;
      titles.push(title);
      t.ctx.kb.insertEntry({ type: 'fact', title, content: `内容 ${i} ${'资料'.repeat(100)}`, origin: 'manual' });
    }
    const disabled = t.ctx.kb.insertEntry({ type: 'fact', title: '不锈钢保温杯 A100', content: '旧的说法', origin: 'manual', status: 'disabled' });
    const src = (await t.req('POST', '/api/sources/text', { body: { name: '产品', text: '不锈钢保温杯 A100\n容量 500ml，价格 59 元\n起订量 100 件' } })).body.id;
    const start = await t.req('POST', '/api/distill', { body: { mode: 'incremental', sourceIds: [src] } });
    assert.equal(start.status, 200);
    const job = await waitFor(
      async () => {
        const j = (await t.req('GET', `/api/distill/jobs/${start.body.jobId}`)).body;
        return ['done', 'failed', 'cancelled'].includes(j.status) ? j : null;
      },
      { timeout: 8000 },
    );
    assert.equal(job.status, 'done', JSON.stringify(job.log));

    // 按类型分批，每批各调一次
    assert.ok(seen.consolidateAll.length >= 1);
    for (const call of seen.consolidateAll) {
      const batch = new Set(ids(call.newEntries));
      assert.ok(call.candidates.length <= 30);
      assert.ok(!call.candidates.some((e) => batch.has(e.id)), '候选里没有本批条目');
    }
    assert.ok(
      seen.consolidateAll.some((c) => ids(c.candidates).includes(disabled.id)),
      '停用的已有条目也是合并候选（和以前一样不管状态）',
    );

    for (const name of ['profile', 'listQuestions']) {
      const got = seen[name].entryTitles;
      assert.equal(got.length, 200, name);
      assert.ok(got.every((x) => x.length <= 100), name);
      assert.equal(got[0], titles[0].slice(0, 100));
      assert.ok(got.includes(titles[248]), `${name}：知识库后面的条目也有代表`);
    }
    const judged = seen.judgeQuestions.entries;
    assert.ok(judged.length > 0 && judged.length <= 40);
    assert.ok(judged.reduce((n, e) => n + contextLength(e), 0) <= 40000);
    assert.equal(ensureEntryIndex(t.ctx.db).rebuilt, false, '整理资料写的条目都进了索引');

    // 全部重建：蒸馏条目连同索引一起删
    const rebuild = await t.req('POST', '/api/distill', { body: { mode: 'rebuild' } });
    assert.equal(rebuild.status, 200);
    await waitFor(async () => ['done', 'failed'].includes((await t.req('GET', `/api/distill/jobs/${rebuild.body.jobId}`)).body.status), { timeout: 8000 });
    assert.equal(ensureEntryIndex(t.ctx.db).rebuilt, false);
  });

  it('红线体检的正常题候选只取 faq、product 的类型和标题：不超过上限时全给（按创建时间），超过时随机取上限条', () => {
    const kb = t.ctx.kb;
    const before = kb.activeTitlesOfTypes(['faq', 'product'], 500);
    for (let i = 0; i < 30; i++) kb.insertEntry({ type: i % 2 ? 'faq' : 'product', title: `问题 ${i}`, content: '答案', origin: 'manual' });
    const all = kb.activeTitlesOfTypes(['faq', 'product'], 500);
    assert.equal(all.length, before.length + 30);
    assert.deepEqual(Object.keys(all[0]).sort(), ['title', 'type']);
    assert.deepEqual(all.slice(-2), [
      { type: 'product', title: '问题 28' },
      { type: 'faq', title: '问题 29' },
    ]);
    const capped = kb.activeTitlesOfTypes(['faq', 'product'], 10);
    assert.equal(capped.length, 10);
    assert.ok(capped.every((e) => e.type === 'faq' || e.type === 'product'));
  });
});
