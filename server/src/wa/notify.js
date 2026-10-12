// 转人工通知（按号）：邮件走全局发信方式（F10），WhatsApp 通知由这个号自己发给它的通知号码。
// WhatsApp 通知末尾带 F3 的用法说明，并记下通知消息的 id → 会话，供"引用通知回复"时找回会话（保留 7 天）。
import { emailConfigured } from '../settings.js';
import { clip, safeJsonParse, sleep } from '../util.js';

export const NOTIFY_REASONS = {
  handoff: '机器人没把握，转人工',
  blocked: '机器人的回复被规则拦截，没有发出',
  non_text: '非文字消息',
  rate_limit: '回复次数超限',
};

export const F3_USAGE_FOOTER = '直接引用这条消息回复，内容会转发给客户。回复 /d 发送上面的草稿，回复 /resume 恢复机器人。';
export const NOTICE_TTL_MS = 7 * 24 * 3600 * 1000;

/** WhatsApp 消息 id 的短形式：WAHA 发出的 id 形如 true_<chat>_<id>，入站引用里的 replyTo.id 可能只有最后的 <id> */
export function shortMessageId(id) {
  const s = String(id || '');
  const i = s.lastIndexOf('_');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * @param {{
 *   getSettings: () => any,
 *   config: import('../config.js').Config,
 *   db: import('better-sqlite3').Database,
 *   mailer: {sendEmail: (m:{to:string[], subject:string, text:string, html?:string}) => Promise<any>},
 *   sendToNumber: (acc:any, number: string, text: string) => Promise<string|null>,
 *   log: {info: Function, warn: Function, error: Function},
 *   retryDelayMs?: number,
 * }} deps
 */
export function createNotifier(deps) {
  const { getSettings, config, db, mailer, sendToNumber, log } = deps;
  const retryDelayMs = deps.retryDelayMs ?? 2000;

  async function sendEmailTo(acc, subject, text) {
    if (!emailConfigured(getSettings())) throw new Error('管理员还没有在设置里配置发信方式');
    const to = acc.notify.email.to;
    if (!to.length) throw new Error('没有填写收件地址');
    await mailer.sendEmail({ to, subject, text });
  }

  async function sendWhatsapp(acc, text) {
    const number = acc.notify.whatsapp.number;
    if (!number) throw new Error('没有填写接收通知的号码');
    return sendToNumber(acc, number, text);
  }

  /** 最多尝试 2 次（失败后重试 1 次），失败只写日志；成功返回 fn 的结果包装 */
  async function withRetry(label, fn) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return { ok: true, value: await fn() };
      } catch (err) {
        log.warn(`[notify] ${label} 第 ${attempt} 次发送失败：${err?.message || err}`);
        if (attempt < 2) await sleep(retryDelayMs);
      }
    }
    return { ok: false, value: null };
  }

  /** 记下通知消息 id → 会话（F3），顺手清掉 7 天前的 */
  function rememberNotice(accountId, externalId, conversationId) {
    if (!externalId) return;
    const now = Date.now();
    db.prepare('DELETE FROM notice_messages WHERE created_at < ?').run(new Date(now - NOTICE_TTL_MS).toISOString());
    db.prepare('INSERT INTO notice_messages(account_id, external_id, short_id, conversation_id, created_at) VALUES(?, ?, ?, ?, ?)').run(
      accountId,
      externalId,
      shortMessageId(externalId),
      conversationId,
      new Date(now).toISOString(),
    );
  }

  /** 按被引用的消息 id 找回会话；过期或找不到返回 null */
  function findNotice(accountId, quotedId) {
    if (!quotedId) return null;
    const since = new Date(Date.now() - NOTICE_TTL_MS).toISOString();
    const row = db
      .prepare(
        `SELECT conversation_id FROM notice_messages
         WHERE account_id = ? AND (external_id = ? OR short_id = ?) AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(accountId, String(quotedId), shortMessageId(quotedId), since);
    return row ? row.conversation_id : null;
  }

  /** 组装转人工通知内容 */
  function buildNotice(acc, conversationId, reason, detail = '') {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conv) return null;
    const chatId = conv.chat_id || conv.id;
    const num = conv.contact_number ? `+${conv.contact_number}` : chatId;
    const who = conv.contact_name ? `${conv.contact_name}（${num}）` : num;
    const recent = db
      .prepare("SELECT text FROM messages WHERE conversation_id = ? AND author = 'customer' ORDER BY seq DESC LIMIT 20")
      .all(conversationId)
      .map((r) => r.text);
    const picked = [];
    let total = 0;
    for (const t of recent) {
      const room = 500 - total;
      if (room <= 0) break;
      const piece = clip(t, room);
      picked.unshift(piece);
      total += piece.length;
    }
    const link = `${config.publicBaseUrl}/whatsapp?chat=${encodeURIComponent(conv.id)}`;
    // handoff / blocked 直接用引擎给的原因；另外两种用固定说法加细节
    const label = NOTIFY_REASONS[reason] || reason;
    const reasonText =
      (reason === 'handoff' || reason === 'blocked') && detail ? clip(detail, 200) : `${label}${detail ? `（${clip(detail, 120)}）` : ''}`;
    const draft = safeJsonParse(conv.draft, null);
    const last = recent[0] || '';
    const subject = `[待人工] 客户 ${num}：${clip(last.replace(/\s+/g, ' '), 30) || label}`;
    const lines = [
      `号：${acc.name}`,
      `客户：${who}`,
      `原因：${reasonText}`,
      '最近消息：',
      ...(picked.length ? picked.map((t) => `- ${t}`) : ['（无）']),
    ];
    // F2a / F15：草稿 {text, fileIds, createdAt}
    const draftText = draft && typeof draft.text === 'string' ? draft.text.trim() : '';
    const draftFileIds = draft && Array.isArray(draft.fileIds) ? draft.fileIds.filter((x) => typeof x === 'string').slice(0, 3) : [];
    const draftFiles = draftFileIds
      .map((id) => db.prepare('SELECT name, filename FROM files WHERE id = ?').get(id))
      .filter(Boolean)
      .map((f) => f.name || f.filename);
    if (draftText || draftFiles.length) {
      lines.push('建议回复（草稿，未发送）：');
      if (draftText) lines.push(clip(draftText, 1000));
      if (draftFiles.length) lines.push(`草稿附带的文件：${draftFiles.join('、')}`);
    }
    lines.push(`去处理：${link}`);
    return { subject, text: lines.join('\n') };
  }

  return {
    buildNotice,
    findNotice,
    rememberNotice,

    /** 转人工通知：各通道独立发送，失败只写日志。 */
    async notifyHandoff(acc, conversationId, reason, detail = '') {
      const n = acc.notify;
      const emailOn = n.email.enabled && emailConfigured(getSettings());
      if (!emailOn && !n.whatsapp.enabled) return;
      const notice = buildNotice(acc, conversationId, reason, detail);
      if (!notice) return;
      const jobs = [];
      if (emailOn) jobs.push(withRetry('邮件', () => sendEmailTo(acc, notice.subject, notice.text)));
      if (n.whatsapp.enabled) {
        jobs.push(
          withRetry('WhatsApp', () => sendWhatsapp(acc, `${notice.subject}\n\n${notice.text}\n\n${F3_USAGE_FOOTER}`)).then((r) => {
            if (r.ok) rememberNotice(acc.id, r.value, conversationId);
            return r;
          }),
        );
      }
      await Promise.all(jobs);
      log.info(`[notify] 已处理号 ${acc.id} 会话 ${conversationId} 的转人工通知（${reason}）`);
    },

    /** POST /api/accounts/:id/notify/test：返回 {email, whatsapp}，没开的通道为 null */
    async test(acc) {
      const n = acc.notify;
      const subject = `[待人工] KBWA 测试通知（${acc.name}）`;
      const text = `这是一条测试通知。机器人拿不准的问题不会回复客户，会这样通知你。\n后台：${config.publicBaseUrl}/whatsapp`;
      const run = async (fn) => {
        try {
          await fn();
          return { ok: true, error: null };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      };
      const [email, whatsapp] = await Promise.all([
        n.email.enabled ? run(() => sendEmailTo(acc, subject, text)) : null,
        n.whatsapp.enabled ? run(() => sendWhatsapp(acc, `${subject}\n\n${text}`)) : null,
      ]);
      return { email, whatsapp };
    },
  };
}

