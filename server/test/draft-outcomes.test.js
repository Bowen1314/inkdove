// 推荐回复采纳统计（reply/draft-outcomes.js）：比较算法和阈值、每种结果怎么定（直接用、改了再发、自己写的、关掉、换掉了、没发）、
// 填入输入框不算关掉、建议的文件、定时清理和保留天数、记录出错不影响发送，以及看板的 drafts 汇总和 GET /api/dashboard/drafts 列表。
// 模型都用 mock（aiHooks 换掉返回值），不连外网。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DRAFT_LIST_LIMIT } from '../src/dashboard.js';
import {
  compareDraft,
  DRAFT_OUTCOME_RETENTION_DAYS,
  EDITED_MAX_RATIO,
  MAX_COMPARE_TOKENS,
  outcomeOfRatio,
  textTokens,
  USED_MAX_RATIO,
} from '../src/reply/draft-outcomes.js';
import { DRAFT_PROMPT_VERSION } from '../src/reply/prompt-version.js';
import { clearMemberDrafts } from '../src/wa/assign.js';
import { newId } from '../src/util.js';
import { filesForm } from './fixtures.js';
import { aiHooks, convIdOf, convPath, getConv, startApp, startFakeWaha, waitDecided, waitFor, wahaMessage, wahaSend } from './helpers.js';

const BOSS = '8613900000000';
let seq = 0;
const newChat = () => `86137${String(Date.now() % 1e6).padStart(6, '0')}${++seq}@c.us`;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const DRAFT_EN =
  'Hi John, thanks for your inquiry about the A100 vacuum flask. The standard production lead time is 7–10 days, and samples can be sent within 3 days. The price for 1000 pcs is 【待你确认：按量报价】. Our MOQ is 500 pcs. Let me know if you need the catalog.';
const DRAFT_ZH = '您好，A100 保温杯标准交期 7–10 天，样品 3 天内寄出。1000 个的价格是【待你确认：按量报价】，起订量 500 个。需要目录的话我发您。';

describe('比较草稿和发出的文字', () => {
  it('分词：中文一个字一个词，英文按词，标点、空白、大小写、全角半角都不算', () => {
    assert.deepEqual(textTokens('您好，A100！'), ['您', '好', 'a100']);
    assert.deepEqual(textTokens('Hello,   WORLD!!'), ['hello', 'world']);
    assert.deepEqual(textTokens('ＡＢＣ　１２３'), ['abc', '123']);
    assert.deepEqual(textTokens(''), []);
  });

  it('一样的、只改了标点空格大小写的、只把【待你确认】填上的：改动比例 0，算直接用', () => {
    const cases = [
      DRAFT_EN,
      DRAFT_EN.replace(/,/g, '').replace('Hi John', 'hi john!!').replace(/\. /g, '.\n\n'),
      DRAFT_EN.replace(/【待你确认[^】]*】/, 'USD 2.35 per piece, FOB Ningbo, valid until the end of this month'),
      DRAFT_EN.replace(/【待你确认[^】]*】/, ''),
    ];
    for (const sent of cases) {
      const r = compareDraft(DRAFT_EN, sent);
      assert.equal(r.ratio, 0, sent);
      assert.equal(outcomeOfRatio(r.ratio), 'used');
    }
    assert.equal(compareDraft(DRAFT_ZH, DRAFT_ZH.replace(/【待你确认[^】]*】/, '每个 2.35 美元，含税含运费')).ratio, 0);
    assert.equal(compareDraft(DRAFT_ZH, DRAFT_ZH.replace(/，/g, ',').replace(/。/g, '. ')).ratio, 0, '中英文标点互换不算改');
  });

  it('开头加一句问候、改一句：还在直接用和改了再发的边上；改得多的算改了再发；自己另写的算自己写的', () => {
    const greet = compareDraft(DRAFT_EN, `Good morning! ${DRAFT_EN.replace(/【待你确认[^】]*】/, 'USD 2.35')}`).ratio;
    assert.ok(greet <= USED_MAX_RATIO, `加问候 ${greet}`);
    const small = compareDraft(DRAFT_EN, DRAFT_EN.replace(/【待你确认[^】]*】/, 'USD 2.35').replace('Let me know if you need the catalog.', 'Shall I send you our catalog?')).ratio;
    assert.ok(small > USED_MAX_RATIO && small < EDITED_MAX_RATIO, `改一句 ${small}`);
    const big = compareDraft(DRAFT_EN, "Hi John, the A100 lead time is about 2 weeks. Price for 1000 pcs is USD 2.35. MOQ 500. I'll send the catalog shortly.").ratio;
    assert.equal(outcomeOfRatio(big), 'edited', `大改 ${big}`);
    const zhEdited = compareDraft(DRAFT_ZH, '您好，A100 交期大概两周，样品三天寄出，1000 个每个 2.35 美元，起订 500 个。').ratio;
    assert.equal(outcomeOfRatio(zhEdited), 'edited', `中文大改 ${zhEdited}`);
    for (const [draft, sent] of [
      [DRAFT_EN, 'Hello, sorry for the late reply. We are on holiday until Monday, I will check with the factory and get back to you next week. Have a nice weekend!'],
      [DRAFT_ZH, '不好意思，这几天放假，下周一我问一下工厂再回复您，祝周末愉快！'],
      [DRAFT_EN, 'ok'],
    ]) {
      const r = compareDraft(draft, sent).ratio;
      assert.equal(outcomeOfRatio(r), 'own', `${sent} → ${r}`);
    }
  });

  it('阈值：≤0.1 直接用，<0.75 改了再发，再大自己写的；草稿除了占位什么都没有时算 1', () => {
    assert.equal(outcomeOfRatio(0), 'used');
    assert.equal(outcomeOfRatio(USED_MAX_RATIO), 'used');
    assert.equal(outcomeOfRatio(USED_MAX_RATIO + 0.001), 'edited');
    assert.equal(outcomeOfRatio(EDITED_MAX_RATIO - 0.001), 'edited');
    assert.equal(outcomeOfRatio(EDITED_MAX_RATIO), 'own');
    assert.equal(outcomeOfRatio(1), 'own');
    assert.equal(compareDraft('【待你确认：价格】', '59 元').ratio, 1);
    assert.equal(compareDraft('', 'hi').ratio, 1);
    assert.equal(compareDraft('一二三四五六七八九十', '一二三四五六七八九').ratio, 0.1, '删一个字：1/10');
  });

  it('很长的文字只比前面一段，几毫秒内比完', () => {
    const long = '中文测试内容'.repeat(2000);
    const t0 = performance.now();
    const r = compareDraft(long, [...long].reverse().join(''));
    assert.ok(performance.now() - t0 < 1000);
    assert.ok(r.draftWords <= MAX_COMPARE_TOKENS && r.sentWords <= MAX_COMPARE_TOKENS);
  });
});

describe('推荐回复的结果', () => {
  let t;
  let fake;
  let hooks;
  let manualAcc;
  let autoAcc;
  let admin;
  let agent;
  const rows = (convId) => t.ctx.db.prepare('SELECT * FROM draft_outcomes WHERE conversation_id = ? ORDER BY created_at, rowid').all(convId);
  const lastRow = (convId) => rows(convId).at(-1);
  const idle = () => waitFor(() => t.ctx.wa.idle());
  const suggest = async (convId, cookie) => {
    const r = await t.req('POST', `${convPath(convId)}/suggest`, { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.draft;
  };
  const send = async (convId, text, cookie) => {
    const r = await t.req('POST', `${convPath(convId)}/send`, { body: { text }, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  async function says(acc, chat, text, n = 1) {
    assert.equal((await wahaSend(t, acc, chat, text)).status, 200);
    const convId = convIdOf(acc, chat);
    await waitDecided(t, convId, n);
    await idle();
    return convId;
  }
  /** 推荐回复固定成 text（不带文件、不带条目时照 mock 的） */
  const withSuggest = async (out, fn) => {
    hooks.suggest = (args, mock) => (typeof out === 'function' ? out(args, mock) : { fileIds: [], entryIds: [], ...out });
    try {
      return await fn();
    } finally {
      hooks.suggest = null;
    }
  };

  before(async () => {
    fake = await startFakeWaha();
    hooks = await aiHooks();
    t = await startApp({ env: { INKDOVE_WAHA_URL: fake.url }, options: { aiOverrides: hooks.overrides } });
    await t.login();
    await t.req('POST', '/api/kb/entries', { body: { type: 'product', title: '保温杯 A100', content: '保温杯 A100 价格 59 元，容量 500ml。' } });
    await t.req('PUT', '/api/settings', { body: { reply: { debounceSeconds: 0.05 } } });
    manualAcc = await t.createAccount({ name: '人工号' });
    autoAcc = await t.createAccount({ name: '自动号', replyMode: 'auto', notify: { whatsapp: { enabled: true, number: `+${BOSS}` } } });
    for (const a of [manualAcc, autoAcc]) await t.req('POST', `/api/accounts/${a.id}/waha/start`);
    admin = t.ctx.db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
    agent = await t.addMember({ email: 'draft-agent@example.com', name: '小吴', accountIds: [manualAcc.id] });
  });
  after(async () => {
    await t.close();
    await fake.close();
  });

  it('要一条推荐回复记一行：类型、问题、引用条目、模型、提示词版本、谁要的；还没定', async () => {
    const convId = await says(manualAcc, newChat(), '保温杯 A100 多少钱');
    const assign = await t.req('PUT', `${convPath(convId)}/assignee`, { body: { userId: agent.user.id } });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const draft = await suggest(convId, agent.cookie);
    const [row] = rows(convId);
    assert.equal(row.kind, 'suggest');
    assert.equal(row.account_id, manualAcc.id);
    assert.equal(row.question, '保温杯 A100 多少钱');
    assert.equal(row.text, draft.text);
    assert.deepEqual(JSON.parse(row.entry_ids), draft.entryIds);
    assert.ok(draft.entryIds.length > 0);
    assert.equal(row.model, 'mock');
    assert.equal(row.prompt_version, DRAFT_PROMPT_VERSION);
    assert.equal(row.requested_by_user_id, agent.user.id);
    assert.equal(row.follow_up, 0);
    assert.equal(row.outcome, null);
    assert.equal(row.created_at, draft.createdAt);
  });

  it('把【待你确认】填上、改改标点就发：直接用，记下发出的消息和文字，改动比例 0', async () => {
    const convId = await says(manualAcc, newChat(), 'How much for 1000 pcs?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    const sentText = DRAFT_EN.replace(/【待你确认[^】]*】/, 'USD 2.35 per piece').replace(/,/g, '');
    const msg = await send(convId, sentText);
    const row = lastRow(convId);
    assert.equal(row.outcome, 'used');
    assert.equal(row.edit_ratio, 0);
    assert.equal(row.sent_message_id, msg.id);
    assert.equal(row.sent_text, sentText);
    assert.ok(row.outcome_at);
    // 之后再发的不改结果：第一条人工消息说了算
    await send(convId, 'Anything else?');
    assert.equal(lastRow(convId).sent_message_id, msg.id);
    assert.equal(rows(convId).length, 1);
  });

  it('改了一些再发：改了再发，记改动比例；自己另写的：自己写的', async () => {
    let convId = await says(manualAcc, newChat(), 'lead time?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    await send(convId, "Hi John, the A100 lead time is about 2 weeks. Price for 1000 pcs is USD 2.35. MOQ 500. I'll send the catalog shortly.");
    let row = lastRow(convId);
    assert.equal(row.outcome, 'edited');
    assert.ok(row.edit_ratio > USED_MAX_RATIO && row.edit_ratio < EDITED_MAX_RATIO, String(row.edit_ratio));

    convId = await says(manualAcc, newChat(), 'lead time?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    await send(convId, 'Sorry, we are on holiday until Monday. I will get back to you next week!');
    row = lastRow(convId);
    assert.equal(row.outcome, 'own');
    assert.ok(row.edit_ratio >= EDITED_MAX_RATIO);
  });

  it('「换一条」：前一条记换掉了，新的一条还没定；点 × 关掉：关掉', async () => {
    const convId = await says(manualAcc, newChat(), '保温杯 A100 多少钱');
    await suggest(convId);
    await suggest(convId);
    let list = rows(convId);
    assert.deepEqual(
      list.map((r) => r.outcome),
      ['replaced', null],
    );
    assert.ok(list[0].outcome_at);
    const del = await t.req('DELETE', `${convPath(convId)}/draft`);
    assert.equal(del.status, 200);
    list = rows(convId);
    assert.deepEqual(
      list.map((r) => r.outcome),
      ['replaced', 'dismissed'],
    );
    // 关掉之后人工再发：不改关掉的结果
    await send(convId, '59 元一个');
    assert.equal(lastRow(convId).outcome, 'dismissed');
    // 没有草稿时再点 × 不记
    assert.equal((await t.req('DELETE', `${convPath(convId)}/draft`)).status, 200);
    assert.equal(rows(convId).length, 2);
  });

  it('「填入输入框」（DELETE ?filled=1）不算关掉：等发出去再比', async () => {
    const convId = await says(manualAcc, newChat(), 'price?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    const del = await t.req('DELETE', `${convPath(convId)}/draft?filled=1`);
    assert.equal(del.status, 200);
    assert.equal(del.body.draft, null, '草稿照样清掉');
    assert.equal(lastRow(convId).outcome, null);
    await send(convId, DRAFT_EN.replace(/【待你确认[^】]*】/, 'USD 2.35'));
    assert.equal(lastRow(convId).outcome, 'used');
  });

  it('系统清掉的记没发：手机上回了、客户又来消息清掉跟进推荐、恢复机器人', async () => {
    // 手机上回了
    let chat = newChat();
    let convId = await says(manualAcc, chat, 'price?');
    await suggest(convId);
    const r = await t.ctx.wa.handleWahaWebhook({
      ...wahaMessage({ from: chat, body: 'I will call you', fromMe: true, session: manualAcc.waha.sessionName }),
      event: 'message.any',
    });
    assert.equal(r, 'archived_owner');
    assert.equal(lastRow(convId).outcome, 'unsent');
    assert.equal(lastRow(convId).sent_message_id, null, '手机上发的不拿来比');

    // 跟进推荐：客户又来消息就作废
    chat = newChat();
    convId = await says(manualAcc, chat, 'Do you have black?');
    await send(convId, 'Let me check with the warehouse');
    await suggest(convId);
    assert.equal(lastRow(convId).follow_up, 1);
    await says(manualAcc, chat, 'hello?', 2);
    assert.equal(lastRow(convId).outcome, 'unsent');

    // 恢复机器人
    convId = await says(manualAcc, newChat(), 'price?');
    await suggest(convId);
    assert.equal((await t.req('POST', `${convPath(convId)}/bot`, { body: { paused: false } })).status, 200);
    assert.equal(lastRow(convId).outcome, 'unsent');
  });

  it('成员停用清掉用了他资料的草稿：记没发', async () => {
    const convId = await says(manualAcc, newChat(), 'price?');
    await suggest(convId);
    const raw = JSON.parse(t.ctx.db.prepare('SELECT draft FROM conversations WHERE id = ?').get(convId).draft);
    t.ctx.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(JSON.stringify({ ...raw, agentUserId: 'gone-user' }), convId);
    assert.equal(clearMemberDrafts(t.ctx.db, 'gone-user'), 1);
    assert.equal(lastRow(convId).outcome, 'unsent');
  });

  it('转人工草稿也记（kind=handoff，没有要的人）；人工照草稿发出：直接用。转人工草稿盖掉还没定的推荐：推荐记没发', async () => {
    const chat = newChat();
    const convId = await says(autoAcc, chat, '保温杯 A100 能便宜点吗，给个折扣');
    const conv = await waitFor(() => getConv(t, convId).then((c) => (c?.draft ? c : null)));
    assert.equal(conv.draft.kind, 'handoff');
    const row = lastRow(convId);
    assert.equal(row.kind, 'handoff');
    assert.equal(row.requested_by_user_id, null);
    assert.match(row.question, /折扣/);
    await send(convId, conv.draft.text.replace(/【待你确认[^】]*】/, '1000 个以上 9 折'));
    assert.equal(lastRow(convId).outcome, 'used');

    // 还没定的推荐被转人工草稿盖掉
    const chat2 = newChat();
    const convId2 = await says(autoAcc, chat2, '保温杯 A100 多少钱');
    await suggest(convId2);
    assert.equal(lastRow(convId2).kind, 'suggest');
    await says(autoAcc, chat2, '能便宜点吗，给个折扣', 2);
    await waitFor(() => (lastRow(convId2)?.kind === 'handoff' ? true : null));
    assert.deepEqual(
      rows(convId2).map((r) => [r.kind, r.outcome]),
      [
        ['suggest', 'unsent'],
        ['handoff', null],
      ],
    );
  });

  it('建议的文件：发了记进 sent_file_ids；只建议文件、没有文字的推荐，发了文件算直接用', async () => {
    const up = await t.req('POST', '/api/files', { body: filesForm([{ name: 'a100-catalog.txt', buffer: Buffer.from('A100 catalog') }]) });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const fileId = up.body[0].id;
    const sendFile = async (convId) => {
      const r = await t.req('POST', `${convPath(convId)}/send-file`, { body: { fileId } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    // 文字 + 文件：先发文件（记上文件，结果等文字），再发文字
    let convId = await says(manualAcc, newChat(), 'catalog please');
    await withSuggest({ text: 'Here is our catalog.', fileIds: [fileId] }, () => suggest(convId));
    await sendFile(convId);
    let row = lastRow(convId);
    assert.deepEqual(JSON.parse(row.sent_file_ids), [fileId]);
    assert.equal(row.outcome, null);
    await send(convId, 'Here is our catalog!');
    assert.equal(lastRow(convId).outcome, 'used');
    await sendFile(convId);
    assert.deepEqual(JSON.parse(lastRow(convId).sent_file_ids), [fileId], '同一个文件再发不重复记');

    // 只有文件
    convId = await says(manualAcc, newChat(), 'catalog please');
    await withSuggest({ text: '', fileIds: [fileId] }, () => suggest(convId));
    await sendFile(convId);
    row = lastRow(convId);
    assert.equal(row.outcome, 'used');
    assert.equal(row.edit_ratio, 0);
  });

  it('发送失败的不算：草稿留着没定，之后发成功了再比', async () => {
    const convId = await says(manualAcc, newChat(), 'price?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    fake.state.failSend = true;
    try {
      const msg = await send(convId, DRAFT_EN);
      assert.equal(msg.status, 'failed');
    } finally {
      fake.state.failSend = false;
    }
    assert.equal(lastRow(convId).outcome, null);
    await send(convId, DRAFT_EN);
    assert.equal(lastRow(convId).outcome, 'used');
  });

  it('记录出错从不影响发送和要推荐：方法抛错、表不在了，都照常 200', async () => {
    const d = t.ctx.draftOutcomes;
    const saved = { operatorSent: d.operatorSent, recorded: d.recorded, fileSent: d.fileSent, dismissed: d.dismissed };
    const boom = () => {
      throw new Error('boom');
    };
    let convId = await says(manualAcc, newChat(), 'price?');
    Object.assign(d, { operatorSent: boom, recorded: boom, fileSent: boom, dismissed: boom });
    try {
      await suggest(convId);
      const msg = await send(convId, 'USD 2.35');
      assert.equal(msg.status, 'sent');
      assert.equal((await t.req('DELETE', `${convPath(convId)}/draft`)).status, 200);
    } finally {
      Object.assign(d, saved);
    }
    assert.equal(rows(convId).length, 0);

    // 表被改名（模拟库出错）：草稿-结果的读写都失败，发送照常
    convId = await says(manualAcc, newChat(), 'price?');
    t.ctx.db.exec('ALTER TABLE draft_outcomes RENAME TO draft_outcomes_off');
    try {
      await suggest(convId);
      const msg = await send(convId, 'USD 2.35');
      assert.equal(msg.status, 'sent');
      await suggest(convId);
      assert.equal((await t.req('DELETE', `${convPath(convId)}/draft`)).status, 200);
      assert.equal((await t.req('POST', `${convPath(convId)}/bot`, { body: { paused: false } })).status, 200);
    } finally {
      t.ctx.db.exec('ALTER TABLE draft_outcomes_off RENAME TO draft_outcomes');
    }
  });

  it('定时清理：起草超过 24 小时还没定的记没发；超过 24 小时才发的不拿来比；超过保留天数的删掉', async () => {
    const convId = await says(manualAcc, newChat(), 'price?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    const id = lastRow(convId).id;
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    t.ctx.db.prepare('UPDATE draft_outcomes SET created_at = ? WHERE id = ?').run(ago(25 * HOUR), id);
    await send(convId, DRAFT_EN);
    assert.equal(lastRow(convId).outcome, null, '超过 24 小时才发的不比');
    // 一条刚起草的、一条超过保留天数的
    const fresh = await says(manualAcc, newChat(), 'price?');
    await suggest(fresh);
    const oldId = newId();
    t.ctx.db
      .prepare(
        `INSERT INTO draft_outcomes(id, conversation_id, kind, created_at, text, prompt_version, outcome, outcome_at)
         VALUES(?, 'gone-conv', 'suggest', ?, 'x', 'v0', 'used', ?)`,
      )
      .run(oldId, ago((DRAFT_OUTCOME_RETENTION_DAYS + 1) * DAY), ago((DRAFT_OUTCOME_RETENTION_DAYS + 1) * DAY));
    const r = t.ctx.draftOutcomes.sweep();
    assert.ok(r.expired >= 1);
    assert.ok(r.deleted >= 1);
    assert.equal(t.ctx.db.prepare('SELECT outcome FROM draft_outcomes WHERE id = ?').get(id).outcome, 'unsent');
    assert.equal(lastRow(fresh).outcome, null, '没到 24 小时的不动');
    assert.equal(t.ctx.db.prepare('SELECT 1 FROM draft_outcomes WHERE id = ?').get(oldId), undefined);
  });

  it('看板：真实数据进汇总和列表；发出的那条撤回了结果不变、不能再存进知识库；能存的「存进知识库」照常；agent 403', async () => {
    const convId = await says(manualAcc, newChat(), 'lead time?');
    await withSuggest({ text: DRAFT_EN }, () => suggest(convId));
    const msg = await send(convId, "Hi John, the A100 lead time is about 2 weeks. Price for 1000 pcs is USD 2.35. MOQ 500. I'll send the catalog shortly.");
    const dash = await t.req('GET', '/api/dashboard?range=today&tz=UTC');
    assert.equal(dash.status, 200);
    const d = dash.body.drafts;
    assert.ok(d.total >= 10 && d.outcomes.used >= 3 && d.outcomes.edited >= 2 && d.outcomes.dismissed >= 1 && d.outcomes.replaced >= 1);
    assert.equal(d.byKind[0].kind, 'suggest');
    assert.equal(d.byKind[1].kind, 'handoff');
    assert.ok(d.byVersion.every((v) => v.model === 'mock'));
    assert.equal(d.files.suggested >= 2 && d.files.sent >= 2, true, JSON.stringify(d.files));

    let list = await t.req('GET', '/api/dashboard/drafts?range=today&tz=UTC&filter=edited');
    assert.equal(list.status, 200);
    let item = list.body.items[0];
    assert.equal(item.conversationId, convId);
    assert.equal(item.outcome, 'edited');
    assert.equal(item.outcomeLabel, '修改后发送');
    assert.equal(item.question, 'lead time?');
    assert.equal(item.text, DRAFT_EN);
    assert.match(item.sentText, /about 2 weeks/);
    assert.equal(item.accountName, '人工号');
    assert.deepEqual(item.sentMessage, { id: msg.id, revoked: false, canSaveToKb: true });
    const kb = await t.req('POST', `${convPath(convId)}/messages/${msg.id}/kb-draft`);
    assert.equal(kb.status, 200, JSON.stringify(kb.body));

    assert.equal((await t.req('POST', `${convPath(convId)}/messages/${msg.id}/revoke`)).status, 200);
    list = await t.req('GET', '/api/dashboard/drafts?range=today&tz=UTC&filter=edited');
    item = list.body.items[0];
    assert.equal(item.outcome, 'edited', '撤回不改结果');
    assert.deepEqual(item.sentMessage, { id: msg.id, revoked: true, canSaveToKb: false });

    for (const p of ['/api/dashboard/drafts', '/api/dashboard']) {
      const r = await t.req('GET', p, { cookie: agent.cookie });
      assert.equal(r.status, 403, p);
    }
  });
});

describe('看板的推荐回复汇总和列表', () => {
  // 固定的"现在"：2026-10-14 10:00 UTC
  const NOW = Date.parse('2026-10-14T10:00:00.000Z');
  const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
  let t;
  let A;
  let B;
  let entry;
  let agentCookie;

  const insert = (o) => {
    const id = o.id || newId();
    t.ctx.db
      .prepare(
        `INSERT INTO draft_outcomes(id, conversation_id, account_id, kind, follow_up, created_at, question, text, entry_ids, file_ids, model,
                                    prompt_version, requested_by_user_id, outcome, outcome_at, sent_message_id, sent_text, edit_ratio, sent_file_ids)
         VALUES(@id, @conv, @acc, @kind, 0, @created, @question, @text, @entries, @files, @model, @pv, NULL, @outcome, @outcomeAt, NULL, @sent, @ratio, @sentFiles)`,
      )
      .run({
        id,
        conv: o.conv || `${o.acc}:chat`,
        acc: o.acc,
        kind: o.kind || 'suggest',
        created: o.created,
        question: o.question || '客户的问题',
        text: o.text || '草稿',
        entries: JSON.stringify(o.entries || []),
        files: JSON.stringify(o.files || []),
        model: o.model === undefined ? 'gpt-x' : o.model,
        pv: o.pv || '2026-10-01',
        outcome: o.outcome ?? null,
        outcomeAt: o.outcome ? o.created : null,
        sent: o.sent ?? null,
        ratio: o.ratio ?? null,
        sentFiles: JSON.stringify(o.sentFiles || []),
      });
    return id;
  };
  const dash = async (q = '') => {
    const r = await t.req('GET', `/api/dashboard?range=7d&tz=UTC${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.drafts;
  };
  const listOf = async (q = '') => {
    const r = await t.req('GET', `/api/dashboard/drafts?range=7d&tz=UTC${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  before(async () => {
    t = await startApp({ options: { dashboardNow: () => NOW } });
    await t.login();
    A = await t.createAccount({ name: '号 A' });
    B = await t.createAccount({ name: '号 B' });
    agentCookie = (await t.addMember({ email: 'dash-draft@example.com', name: 'A', accountIds: [A.id] })).cookie;
    entry = (await t.req('POST', '/api/kb/entries', { body: { type: 'faq', title: '交期', content: '7 天' } })).body;
    t.ctx.db
      .prepare(
        `INSERT INTO conversations(id, account_id, chat_id, channel, contact_name, contact_number, created_at, updated_at)
         VALUES(?, ?, 'chat', 'waha', 'Tom', '8613800000000', ?, ?)`,
      )
      .run(`${A.id}:chat`, A.id, at(100), at(100));
    // 号 A：旧版本提示词 gpt-x（2026-10-01）4 条，新版本 2 条，另一个模型 1 条；转人工草稿 2 条
    insert({ acc: A.id, created: at(30), outcome: 'used', ratio: 0, files: ['f1', 'f2'], sentFiles: ['f1'] });
    insert({ acc: A.id, created: at(31), outcome: 'edited', ratio: 0.3, entries: [entry.id, 'gone-entry'], sent: '改过的' });
    insert({ acc: A.id, created: at(32), outcome: 'edited', ratio: 0.5 });
    insert({ acc: A.id, created: at(33), outcome: 'dismissed' });
    insert({ acc: A.id, created: at(2), pv: DRAFT_PROMPT_VERSION, outcome: 'own', ratio: 0.9 });
    insert({ acc: A.id, created: at(1), pv: DRAFT_PROMPT_VERSION }); // 还没定（不到 24 小时）
    insert({ acc: A.id, created: at(50), model: 'claude-y', outcome: 'replaced' });
    insert({ acc: A.id, created: at(26), kind: 'handoff', model: 'gpt-x' }); // 超过 24 小时还没定：按没发算
    insert({ acc: A.id, created: at(40), kind: 'handoff', outcome: 'used', ratio: 0.05 });
    // 号 B：1 条
    insert({ acc: B.id, created: at(5), outcome: 'unsent' });
    // 时间段外
    insert({ acc: A.id, created: at(24 * 9), outcome: 'used', ratio: 0 });
  });
  after(() => t?.close());

  it('agent 403；参数不对 400', async () => {
    for (const p of ['/api/dashboard/drafts?range=7d', '/api/dashboard?range=7d']) {
      assert.equal((await t.req('GET', p, { cookie: agentCookie })).status, 403, p);
    }
    for (const q of ['filter=nope', 'limit=0', 'limit=51', 'limit=x', 'cursor=abc', 'cursor=x|', 'range=1y']) {
      const r = await t.req('GET', `/api/dashboard/drafts?${q}`);
      assert.equal(r.status, 400, q);
    }
  });

  it('汇总：各结果计数、还没定的不进比率、超过 24 小时没定的算没发（不写库）、平均改动比例、文件', async () => {
    const d = await dash();
    assert.equal(d.total, 10);
    assert.equal(d.pending, 1);
    assert.equal(d.decided, 9);
    assert.deepEqual(d.outcomes, { used: 2, edited: 2, own: 1, dismissed: 1, replaced: 1, unsent: 2 });
    assert.equal(d.unused, 5);
    assert.equal(d.usedRate, 2 / 9);
    assert.equal(d.editedRate, 2 / 9);
    assert.equal(d.unusedRate, 5 / 9);
    assert.equal(d.avgEditRatio, 0.4);
    assert.deepEqual(d.files, { suggested: 2, sent: 1 });
    assert.equal(d.currentPromptVersion, DRAFT_PROMPT_VERSION);
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) n FROM draft_outcomes WHERE kind = 'handoff' AND outcome IS NULL").get().n, 1, '看板只读');
  });

  it('按类型、按模型 + 提示词版本分组', async () => {
    const d = await dash();
    assert.deepEqual(
      d.byKind.map((k) => [k.kind, k.label, k.total, k.pending, k.decided, k.outcomes.used, k.outcomes.unsent]),
      [
        ['suggest', '推荐回复', 8, 1, 7, 1, 1],
        ['handoff', '转人工草稿', 2, 0, 2, 1, 1],
      ],
    );
    const v = (kind, model, pv) => d.byVersion.find((x) => x.kind === kind && x.model === model && x.promptVersion === pv);
    // 旧版本 gpt-x：号 A 4 条 + 号 B 1 条（没发）
    const oldV = v('suggest', 'gpt-x', '2026-10-01');
    assert.equal(oldV.total, 5);
    assert.equal(oldV.usedRate, 1 / 5);
    assert.equal(oldV.editedRate, 2 / 5);
    assert.equal(oldV.unusedRate, 2 / 5);
    assert.equal(oldV.avgEditRatio, 0.4);
    assert.equal(oldV.firstAt, at(33));
    assert.equal(oldV.lastAt, at(5));
    const newV = v('suggest', 'gpt-x', DRAFT_PROMPT_VERSION);
    assert.equal(newV.total, 2);
    assert.equal(newV.pending, 1);
    assert.equal(newV.decided, 1);
    assert.equal(newV.unusedRate, 1);
    assert.equal(v('suggest', 'claude-y', '2026-10-01').outcomes.replaced, 1);
    assert.equal(v('handoff', 'gpt-x', '2026-10-01').total, 2);
    assert.deepEqual(
      d.byVersion.map((x) => [x.kind, x.model, x.promptVersion]),
      [
        ['suggest', 'gpt-x', DRAFT_PROMPT_VERSION],
        ['suggest', 'gpt-x', '2026-10-01'],
        ['suggest', 'claude-y', '2026-10-01'],
        ['handoff', 'gpt-x', '2026-10-01'],
      ],
      '先推荐回复再转人工草稿，同类型里最近用过的在前',
    );
  });

  it('按号筛选；每天的趋势', async () => {
    const b = await dash(`&accountId=${B.id}`);
    assert.equal(b.total, 1);
    assert.equal(b.outcomes.unsent, 1);
    const d = await dash();
    assert.equal(d.trend.length, 7);
    const day = (date) => d.trend.find((x) => x.date === date);
    // NOW 是 10-14 10:00 UTC：1、2、5 小时前在 10-14；26–50 小时前在 10-12、10-13
    assert.deepEqual(day('2026-10-14'), { date: '2026-10-14', used: 0, edited: 0, unused: 2, pending: 1 });
    const sum = d.trend.reduce((n, x) => n + x.used + x.edited + x.unused + x.pending, 0);
    assert.equal(sum, 10);
  });

  it('列表：默认是改了再发和没用的（不含没发、直接用、还没定的），最新的在前；引用条目带标题，删了的标出来', async () => {
    const r = await listOf();
    assert.deepEqual(
      r.items.map((x) => x.outcome),
      ['own', 'edited', 'edited', 'dismissed', 'replaced'],
    );
    assert.equal(r.nextCursor, null);
    const edited = r.items[1];
    assert.equal(edited.contactName, 'Tom');
    assert.equal(edited.conversationExists, true);
    assert.equal(edited.accountName, '号 A');
    assert.deepEqual(edited.entries, [
      { id: entry.id, title: '交期', deleted: false },
      { id: 'gone-entry', title: null, deleted: true },
    ]);
    assert.equal(edited.sentText, '改过的');
    assert.equal(edited.editRatio, 0.3);
    assert.equal(edited.sentMessage, null);
    // 没发：包括超过 24 小时还没定的
    const unsent = await listOf('&filter=unsent');
    assert.deepEqual(
      unsent.items.map((x) => [x.kind, x.outcome]),
      [
        ['suggest', 'unsent'],
        ['handoff', 'unsent'],
      ],
    );
    assert.deepEqual((await listOf(`&filter=unsent&accountId=${A.id}`)).items.length, 1);
  });

  it('列表分页：cursor 接着往下翻，不重不漏', async () => {
    const seen = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const r = await listOf(`&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.items.map((x) => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    const all = (await listOf()).items.map((x) => x.id);
    assert.deepEqual(seen, all);
    assert.equal(all.length, 5);
    assert.ok(DRAFT_LIST_LIMIT >= 5);
  });
});
