// 推荐回复采纳统计：每份存进会话的推荐回复、转人工草稿最后怎么样了（表结构见 db.js 的 draft_outcomes，看板的「推荐回复」读它）。
// 判定规则见 docs/features.md「推荐回复采纳统计」。只在本地比文字，不调模型；记录出错只记一行 warn，从不挡发送。
//
// 一份草稿的结果：
// - 人工发出文字（后台发送、通知号码转发、/d）：拿发出的文字和草稿比，按改动比例记直接用 / 改了再发 / 自己写的；
// - 「换一条」存了新推荐：前一份记换掉了。转人工草稿盖掉了推荐：前一份记没发；
// - 点 × 关掉：关掉。「填入输入框」也会清掉会话上的草稿，但不算关掉，等人工发出去再比；
// - 系统清掉（机器人、手机、外联发了消息，客户又来消息清掉跟进推荐，改派、停用成员，恢复机器人）：没发；
// - 起草后 24 小时还没定：没发（定时清理时记上，看板读的时候也按没发算）。
import { clip, newId, nowIso, safeJsonParse } from '../util.js';
import { DRAFT_PROMPT_VERSION } from './prompt-version.js';

/** 结果 → 看板上的叫法 */
export const DRAFT_OUTCOMES = {
  used: '直接用',
  edited: '改了再发',
  own: '自己写的',
  dismissed: '关掉',
  replaced: '换掉了',
  unsent: '没发',
};
/** 算「没用」的四种 */
export const UNUSED_OUTCOMES = ['own', 'dismissed', 'replaced', 'unsent'];
export const DRAFT_KINDS = { suggest: '推荐回复', handoff: '转人工草稿' };
/** 起草后多久以内人工发的文字拿来比、发的建议文件算数；过了还没定的记没发 */
export const DRAFT_PENDING_MS = 24 * 3600 * 1000;
/** 记录留多少天，超过的定时删掉 */
export const DRAFT_OUTCOME_RETENTION_DAYS = 180;
/** 多久清理一次（把过了 24 小时还没定的记成没发、删掉过期的记录）；启动 1 分钟后先跑一次 */
export const DRAFT_SWEEP_INTERVAL_MS = 3600 * 1000;
const FIRST_SWEEP_DELAY_MS = 60_000;
const DAY_MS = 24 * 3600 * 1000;
const DELETE_BATCH = 1000;
/** 改动比例不超过 0.1 算直接用，小于 0.75 算改了再发，再大算自己写的 */
export const USED_MAX_RATIO = 0.1;
export const EDITED_MAX_RATIO = 0.75;
/** 比较时每边最多取多少个词（中日韩泰等按字算），最长的情况也在几毫秒内比完 */
export const MAX_COMPARE_TOKENS = 2000;
const MAX_QUESTION = 2000;
const MAX_SENT_TEXT = 4000;

// ---------------- 比较文字 ----------------

/** 【待你确认：…】占位（和前端、translate.js 用的同一个写法） */
const TODO_RE = /【待你确认[^】]*】/g;
/** 不用空格分词的文字，一个字算一个词（韩文有空格，按词算） */
const DENSE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
/** 草稿词序列里的占位：能对上发出文字里任意几个词，不算改动 */
const WILDCARD = -1;

/** 文字 → 词：NFKC、小写，标点、符号、空白都不算（只改了标点和空格的当没改） */
export function textTokens(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(DENSE_RE, ' $& ').match(WORD_RE) || [];
}

/** 草稿 → 词，每处【待你确认：…】换成一个通配 */
function draftTokens(text) {
  const out = [];
  let last = 0;
  for (const m of String(text ?? '').matchAll(TODO_RE)) {
    out.push(...textTokens(text.slice(last, m.index)));
    if (out[out.length - 1] !== WILDCARD) out.push(WILDCARD);
    last = m.index + m[0].length;
  }
  out.push(...textTokens(String(text ?? '').slice(last)));
  return out;
}

/**
 * 发出的文字和草稿差多少：按词算编辑距离（增、删、换一个词各算 1），草稿里的【待你确认：…】能对上任意几个词、不算改动
 * （只是把占位填上了的算没改）。改动比例 = 距离 ÷ max(草稿里占位以外的词数, 发出的词数 − 填进占位的词数)，0–1。
 * 草稿里除了占位什么都没有时记 1（全是人自己写的）。每边最多取 MAX_COMPARE_TOKENS 个词。
 * @returns {{ratio:number, distance:number, draftWords:number, sentWords:number}}
 */
export function compareDraft(draftText, sentText) {
  const d = draftTokens(draftText).slice(0, MAX_COMPARE_TOKENS);
  const s = textTokens(sentText).slice(0, MAX_COMPARE_TOKENS);
  const literal = d.filter((x) => x !== WILDCARD).length;
  const n = s.length;
  if (!literal) return { ratio: 1, distance: n, draftWords: 0, sentWords: n };
  // 词换成数字再比
  const ids = new Map();
  const idOf = (w) => {
    let v = ids.get(w);
    if (v === undefined) {
      v = ids.size;
      ids.set(w, v);
    }
    return v;
  };
  const D = Int32Array.from(d, (w) => (w === WILDCARD ? WILDCARD : idOf(w)));
  const S = Int32Array.from(s, idOf);
  // 两行滚动的编辑距离；absorbed 记最优路径上被占位吃掉的发出词数（算分母用）
  let cost = new Int32Array(n + 1);
  let absorbed = new Int32Array(n + 1);
  let nextCost = new Int32Array(n + 1);
  let nextAbsorbed = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) cost[j] = j;
  for (let i = 0; i < D.length; i++) {
    const w = D[i];
    if (w === WILDCARD) {
      nextCost[0] = cost[0];
      nextAbsorbed[0] = absorbed[0];
      for (let j = 1; j <= n; j++) {
        if (nextCost[j - 1] < cost[j]) {
          nextCost[j] = nextCost[j - 1];
          nextAbsorbed[j] = nextAbsorbed[j - 1] + 1;
        } else {
          nextCost[j] = cost[j];
          nextAbsorbed[j] = absorbed[j];
        }
      }
    } else {
      nextCost[0] = cost[0] + 1;
      nextAbsorbed[0] = absorbed[0];
      for (let j = 1; j <= n; j++) {
        const sub = cost[j - 1] + (S[j - 1] === w ? 0 : 1);
        const del = cost[j] + 1;
        const ins = nextCost[j - 1] + 1;
        if (sub <= del && sub <= ins) {
          nextCost[j] = sub;
          nextAbsorbed[j] = absorbed[j - 1];
        } else if (del <= ins) {
          nextCost[j] = del;
          nextAbsorbed[j] = absorbed[j];
        } else {
          nextCost[j] = ins;
          nextAbsorbed[j] = nextAbsorbed[j - 1];
        }
      }
    }
    [cost, nextCost] = [nextCost, cost];
    [absorbed, nextAbsorbed] = [nextAbsorbed, absorbed];
  }
  const distance = cost[n];
  const denom = Math.max(literal, n - absorbed[n], 1);
  return { ratio: Math.min(1, distance / denom), distance, draftWords: literal, sentWords: n };
}

/** 改动比例 → used | edited | own */
export function outcomeOfRatio(ratio) {
  if (ratio <= USED_MAX_RATIO) return 'used';
  if (ratio < EDITED_MAX_RATIO) return 'edited';
  return 'own';
}

/** 改动比例存三位小数 */
const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------- 记录 ----------------

/**
 * 把这个会话里还没定的草稿记成 outcome（每个会话最多一行没定的）。不在 ctx 里的地方（wa/assign.js）也用它。
 * 出错只记 warn、返回 0，不影响调用方的事务。
 * @param {import('better-sqlite3').Database} db
 * @returns {number} 定下了几行
 */
export function settleDrafts(db, convId, outcome, { at = nowIso(), log = console } = {}) {
  try {
    return db.prepare('UPDATE draft_outcomes SET outcome = ?, outcome_at = ? WHERE conversation_id = ? AND outcome IS NULL').run(outcome, at, convId)
      .changes;
  } catch (err) {
    log.warn(`[draft-outcomes] 记录草稿结果失败：${err?.message || err}`);
    return 0;
  }
}

/**
 * @param {any} ctx 要 ctx.db、ctx.log、ctx.config、ctx.getSettings
 * @param {{now?: () => number}} [opts] now 是测试用的时钟
 */
export function createDraftOutcomes(ctx, opts = {}) {
  const { db } = ctx;
  const log = ctx.log || console;
  const now = opts.now || Date.now;
  const iso = () => new Date(now()).toISOString();
  const since = () => new Date(now() - DRAFT_PENDING_MS).toISOString();
  let firstTimer = null;
  let timer = null;

  const safe = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      log.warn(`[draft-outcomes] ${what}失败：${err?.message || err}`);
      return null;
    }
  };

  /** 这个会话最近一份草稿（24 小时以内的） */
  const latest = (convId) =>
    db.prepare('SELECT * FROM draft_outcomes WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(convId, since());

  /** 起草用的模型名：和 llm_calls 记的一样（mock 模式记 mock，真实模式是设置里的回复模型） */
  const modelName = () => (ctx.config?.llmMock ? 'mock' : String(ctx.getSettings?.()?.llm?.model || '').trim() || null);

  const store = {
    /**
     * 一份草稿存进了会话（推荐回复、转人工草稿）：记一行。这个会话前一份还没定的，新的是推荐回复时记换掉了，
     * 是转人工草稿时记没发（不是人要换的）。
     * @param {{id:string, account_id?:string|null}} conv 会话行
     * @param {{kind:string, text:string, fileIds?:string[], entryIds?:string[], createdAt:string, followUp?:boolean}} draft 存进去的草稿
     * @param {{question?:string, requestedBy?:{id:string}|null}} [o]
     */
    recorded(conv, draft, { question = '', requestedBy = null } = {}) {
      return safe('记录草稿', () =>
        db.transaction(() => {
          const at = draft.createdAt || iso();
          settleDrafts(db, conv.id, draft.kind === 'suggest' ? 'replaced' : 'unsent', { at, log });
          const id = newId();
          db.prepare(
            `INSERT INTO draft_outcomes(id, conversation_id, account_id, kind, follow_up, created_at, question, text, entry_ids, file_ids,
                                        model, prompt_version, requested_by_user_id)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            conv.id,
            conv.account_id ?? null,
            draft.kind === 'suggest' ? 'suggest' : 'handoff',
            draft.followUp ? 1 : 0,
            at,
            clip(String(question || '').trim(), MAX_QUESTION),
            String(draft.text || ''),
            JSON.stringify(Array.isArray(draft.entryIds) ? draft.entryIds : []),
            JSON.stringify(Array.isArray(draft.fileIds) ? draft.fileIds : []),
            modelName(),
            DRAFT_PROMPT_VERSION,
            requestedBy?.id ?? null,
          );
          return id;
        })(),
      );
    },

    /**
     * 人工发出了一条文字（后台、通知号码转发、/d）：这个会话 24 小时内还没定的那份草稿拿来比，记直接用 / 改了再发 / 自己写的。
     * 发送失败的不算（草稿留着没定，之后发成功了再比）。
     * @param {{id:string, text:string, status:string}} msg
     */
    operatorSent(convId, msg) {
      if (!msg || msg.status !== 'sent' || !String(msg.text || '').trim()) return null;
      return safe('比较草稿和发出的消息', () => {
        const row = latest(convId);
        if (!row || row.outcome) return null;
        const { ratio } = compareDraft(row.text, msg.text);
        const outcome = outcomeOfRatio(ratio);
        db.prepare(
          `UPDATE draft_outcomes SET outcome = ?, outcome_at = ?, sent_message_id = ?, sent_text = ?, edit_ratio = ?
            WHERE id = ? AND outcome IS NULL`,
        ).run(outcome, iso(), msg.id, clip(msg.text, MAX_SENT_TEXT), round3(ratio), row.id);
        return outcome;
      });
    },

    /**
     * 人工发出了一个文件：是这个会话最近一份草稿（24 小时内）建议的，记进 sent_file_ids（不重复）。
     * 只建议了文件、没有文字的草稿，还没定时记直接用。
     * @param {{id:string, status:string}} msg
     */
    fileSent(convId, fileId, msg) {
      if (!msg || msg.status !== 'sent') return;
      safe('记录发出的建议文件', () => {
        const row = latest(convId);
        if (!row) return;
        const suggested = safeJsonParse(row.file_ids, []);
        const sent = safeJsonParse(row.sent_file_ids, []);
        if (!Array.isArray(suggested) || !suggested.includes(fileId)) return;
        const list = Array.isArray(sent) ? sent : [];
        if (!list.includes(fileId)) {
          db.prepare('UPDATE draft_outcomes SET sent_file_ids = ? WHERE id = ?').run(JSON.stringify([...list, fileId]), row.id);
        }
        if (!row.outcome && !String(row.text || '').trim()) {
          db.prepare(
            "UPDATE draft_outcomes SET outcome = 'used', outcome_at = ?, sent_message_id = ?, edit_ratio = 0 WHERE id = ? AND outcome IS NULL",
          ).run(iso(), msg.id, row.id);
        }
      });
    },

    /** 点 × 关掉了会话上的草稿 */
    dismissed(convId) {
      return safe('记录关掉', () => settleDrafts(db, convId, 'dismissed', { at: iso(), log }));
    },

    /** 会话上的草稿被系统清掉了（机器人、手机、外联发了消息，客户又来消息，恢复机器人……） */
    unsent(convId) {
      return safe('记录没发', () => settleDrafts(db, convId, 'unsent', { at: iso(), log }));
    },

    /**
     * 定时清理：起草超过 24 小时还没定的记没发；删掉超过 180 天的记录。返回 {expired, deleted}
     */
    sweep() {
      const at = iso();
      const expired = db
        .prepare("UPDATE draft_outcomes SET outcome = 'unsent', outcome_at = ? WHERE outcome IS NULL AND created_at < ?")
        .run(at, since()).changes;
      const cutoff = new Date(now() - DRAFT_OUTCOME_RETENTION_DAYS * DAY_MS).toISOString();
      const del = db.prepare('DELETE FROM draft_outcomes WHERE rowid IN (SELECT rowid FROM draft_outcomes WHERE created_at < ? LIMIT ?)');
      let deleted = 0;
      for (;;) {
        const n = del.run(cutoff, DELETE_BATCH).changes;
        deleted += n;
        if (n < DELETE_BATCH) break;
      }
      if (deleted) log.info(`[draft-outcomes] 删掉了 ${deleted} 条超过 ${DRAFT_OUTCOME_RETENTION_DAYS} 天的推荐回复记录`);
      return { expired, deleted };
    },

    /** 开始定时清理：启动 1 分钟后一次，之后每 intervalMs 一次；为 0 时不启动（测试里手动调 sweep） */
    start(intervalMs = DRAFT_SWEEP_INTERVAL_MS) {
      if (!intervalMs || timer || firstTimer) return;
      const run = () => {
        try {
          store.sweep();
        } catch (err) {
          log.error(`[draft-outcomes] 清理推荐回复记录出错：${err?.stack || err}`);
        }
      };
      firstTimer = setTimeout(run, Math.min(FIRST_SWEEP_DELAY_MS, intervalMs));
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
