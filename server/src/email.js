// F10 发信方式：SMTP（nodemailer）或 Resend API。两种都实现 sendEmail({to, subject, text, html?})，
// 通知和测试邮件都只调这个接口。
// Resend：https://resend.com/docs/api-reference/emails/send-email
//         错误码 https://resend.com/docs/api-reference/errors ，限流 https://resend.com/docs/api-reference/rate-limit
import nodemailer from 'nodemailer';
import { smtpProxyFor } from './proxy/route.js';
import { sleep } from './util.js';

/**
 * SMTP 连接参数：secure=true 走 SMTPS（通常 465），false 则强制 STARTTLS（通常 587）。
 * 全局代理开着、SMTP 服务器不在直连名单里时，经它连（nodemailer 自带的 HTTP 代理支持：CONNECT 隧道里再做 TLS）
 */
export function smtpOptions(smtp) {
  const proxy = smtpProxyFor(smtp.host);
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(proxy ? { proxy } : {}),
  };
}

export class EmailError extends Error {}

/** 把 Resend 的错误变成可读的中文说明 */
function resendErrorMessage(status, data, raw) {
  const name = data && typeof data === 'object' ? data.name : '';
  const msg = (data && typeof data === 'object' && data.message) || String(raw || '').slice(0, 200) || '无返回内容';
  let hint = '';
  if (/domain is not verified|not verified/i.test(msg)) hint = '（发件地址的域名还没在 Resend 验证，请到 resend.com 的 Domains 里验证）';
  else if (status === 401 || name === 'missing_api_key' || name === 'invalid_api_key') hint = '（API key 不对或已失效）';
  else if (status === 422 && /from/i.test(msg)) hint = '（发件人格式应为 "名称 <地址>" 或纯邮箱）';
  return `Resend 返回 ${status}${name ? ` ${name}` : ''}：${msg}${hint}`;
}

/**
 * @param {{
 *   getSettings: () => any,
 *   resendUrl: string,
 *   createMailTransport?: (opts:any) => any,
 *   resendRetryDelayMs?: number,
 * }} deps
 */
export function createMailer(deps) {
  const createTransport = deps.createMailTransport || ((opts) => nodemailer.createTransport(opts));

  async function viaSmtp(e, msg) {
    if (!e.smtp.host) throw new EmailError('没有填写 SMTP 服务器');
    const from = e.from || e.smtp.user;
    if (!from) throw new EmailError('没有填写发件人');
    const transport = createTransport(smtpOptions(e.smtp));
    try {
      const info = await transport.sendMail({ from, to: msg.to.join(', '), subject: msg.subject, text: msg.text, html: msg.html });
      return { id: info?.messageId || null };
    } finally {
      transport.close?.();
    }
  }

  async function viaResend(e, msg) {
    if (!e.resend.apiKey) throw new EmailError('没有填写 Resend API key');
    if (!e.from) throw new EmailError('没有填写发件人');
    const body = { from: e.from, to: msg.to, subject: msg.subject, text: msg.text };
    if (msg.html) body.html = msg.html;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(deps.resendUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${e.resend.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new EmailError(`连不上 Resend：${err?.cause?.code || err?.message || err}`);
      }
      const raw = await res.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        /* 非 JSON */
      }
      if (res.ok) return { id: data?.id ?? null };
      // 429 重试 1 次（按 retry-after，最多等 5 秒）
      if (res.status === 429 && attempt === 1) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = deps.resendRetryDelayMs ?? (Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : 1000);
        await sleep(wait);
        continue;
      }
      throw new EmailError(resendErrorMessage(res.status, data, raw));
    }
  }

  return {
    /**
     * @param {{to:string[], subject:string, text:string, html?:string}} msg
     * @returns {Promise<{id:string|null}>}
     */
    async sendEmail(msg) {
      const e = deps.getSettings().email;
      if (!Array.isArray(msg.to) || !msg.to.length) throw new EmailError('没有收件地址');
      if (e.provider === 'smtp') return viaSmtp(e, msg);
      if (e.provider === 'resend') return viaResend(e, msg);
      throw new EmailError('还没有配置发信方式');
    },
  };
}
