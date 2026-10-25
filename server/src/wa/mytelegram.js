// 替用户在 my.telegram.org 取 api_id / api_hash（Telegram 扫码登录要用）：手机号 → Telegram 里收到的验证码 → 登录 →
// 读出已有的应用，没有就新建一个叫 Inkdove 的。
//
// my.telegram.org 没有正式接口，这里照它网页上的表单发请求（/auth/send_password、/auth/login、/apps、/apps/create，
// 按 2026-10 改版后的页面写的），它再改版就可能失效；失效时用户仍可以自己去网页上复制。
// 请求走全局 fetch：开了全局代理就经 mihomo 出去（proxy/route.js），国内不开连不上。
// 手机号、验证码、cookie、api_hash 只在内存里过一遍：不存盘、不进日志，报错里也不带。
import crypto from 'node:crypto';
import { badRequest, HttpError } from '../util.js';

const UA = 'Inkdove (+https://github.com/Bowen1314/inkdove)';
const TIMEOUT_MS = 20_000;
/** 验证码多久内有效（my.telegram.org 自己的时限不明，墨鸽这边最多等这么久） */
const PENDING_MS = 10 * 60_000;

const unreachable = (err) =>
  new HttpError(
    502,
    'my_telegram_unreachable',
    `无法连接 my.telegram.org（${err?.name === 'TimeoutError' ? '超时' : err?.cause?.code || err?.message || err}）。中国大陆需先在「设置 → 代理」开启全局代理`,
  );
const failed = (msg) => new HttpError(502, 'my_telegram_failed', msg);

/** 对方报错的原话（去掉标签、截短）；my.telegram.org 的报错不带用户填的内容 */
const said = (r) =>
  String(r.json?.text ?? r.text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

const flood = () => new HttpError(429, 'my_telegram_flood', '操作过于频繁，my.telegram.org 暂时限制登录，请数小时后重试');

/**
 * 发一个请求，带上并收下 cookie；不跟随跳转（没登录时 /apps 会跳到 /auth）
 * @param {string} base
 * @param {Map<string,string>} jar
 * @param {string} path
 * @param {Record<string,string>} [form] 有就 POST 表单
 */
async function call(base, jar, path, form) {
  /** @type {Record<string,string>} */
  const headers = { 'user-agent': UA };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  let res;
  try {
    res = await fetch(base + path, {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(err);
  }
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!value || value === 'deleted') jar.delete(name);
    else jar.set(name, value);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw unreachable(err);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 不是 JSON（页面或纯文本）
  }
  return { status: res.status, ok: res.ok, text, json };
}

const attrOf = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, '&') : undefined;
};

/**
 * 认 /apps 页面：已有应用 → {apiId, apiHash}；还没有 → {create: {hidden, platforms}}（新建表单里的隐藏字段和可选平台）；认不出 → null
 * @param {string} html
 * @returns {{apiId: string, apiHash: string} | {create: {hidden: Record<string,string>, platforms: string[]}} | null}
 */
export function parseAppsPage(html) {
  // 先按标签找：「api_id」后面第一个单独的数字、「api_hash」后面第一个单独的 32 位十六进制（在标签文字里或 data-copy / data-value 里）
  const after = (label, value) =>
    new RegExp(`${label}[\\s\\S]{0,1000}?(?:data-(?:copy|value)\\s*=\\s*["']|>)\\s*(${value})\\s*["'<]`, 'i').exec(html)?.[1];
  let apiId = after('api_id', '\\d{3,12}');
  let apiHash = after('api_hash', '[0-9a-f]{32}');
  if (!apiId || !apiHash) {
    // 再看复制按钮、显示按钮上的值：纯数字的只有一个、32 位十六进制的只有一个，就是它们
    const vals = new Set([...html.matchAll(/data-(?:copy|value)\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1].trim()));
    const ids = [...vals].filter((v) => /^\d{3,12}$/.test(v));
    const hashes = [...vals].filter((v) => /^[0-9a-f]{32}$/i.test(v));
    if (ids.length === 1 && hashes.length === 1) [apiId, apiHash] = [ids[0], hashes[0]];
  }
  if (apiId && apiHash) return { apiId, apiHash: apiHash.toLowerCase() };

  const form = /<form\b[^>]*(?:app_create_form|\/apps\/create)[\s\S]*?<\/form>/i.exec(html)?.[0];
  if (!form) return null;
  /** @type {Record<string,string>} */
  const hidden = {};
  const platforms = [];
  for (const tag of form.match(/<input\b[^>]*>/gi) ?? []) {
    const name = attrOf(tag, 'name');
    const type = (attrOf(tag, 'type') || '').toLowerCase();
    if (!name) continue;
    if (type === 'hidden') hidden[name] = attrOf(tag, 'value') ?? '';
    else if (name === 'app_platform' && type === 'radio') platforms.push(attrOf(tag, 'value') ?? '');
  }
  return { create: { hidden, platforms: platforms.filter(Boolean) } };
}

/** 打开 /apps 认页面；被跳去登录页说明没登录上 */
async function readApps(base, jar) {
  const r = await call(base, jar, '/apps');
  if (r.status >= 300 && r.status < 400) throw failed('登录 my.telegram.org 未成功，请重新获取验证码');
  if (!r.ok) throw failed(`my.telegram.org 应用页打开失败（HTTP ${r.status}）`);
  return parseAppsPage(r.text);
}

/** 新建应用。只有简称被占用时换一个再试一次 */
async function createApp(base, jar, create) {
  const platform = ['desktop', 'other'].find((p) => create.platforms.includes(p)) ?? create.platforms[0] ?? 'desktop';
  for (let attempt = 0; ; attempt++) {
    const r = await call(base, jar, '/apps/create', {
      ...create.hidden,
      app_title: 'Inkdove',
      // 5–32 位字母数字，全 Telegram 不能重名
      app_shortname: `inkdove${crypto.randomInt(100000, 1000000)}`,
      app_url: 'https://github.com/Bowen1314/inkdove',
      app_platform: platform,
      app_desc: 'Customer support inbox (Inkdove)',
    });
    // 旧页面失败时回 200 + 「ERROR」，新页面回错误状态码 + {text, field}
    if (r.ok && r.text.trim() !== 'ERROR') return;
    if (r.json?.field === 'app_shortname' && attempt === 0) continue;
    const s = said(r);
    if (/too many/i.test(s)) throw flood();
    if (!s || s === 'ERROR') {
      throw failed(
        'my.telegram.org 拒绝创建应用（返回 ERROR），常见于新注册帐号或代理 IP。可更换代理节点或稍后重试，' +
          '也可在 my.telegram.org → API development tools 手动创建后填入',
      );
    }
    throw failed(`my.telegram.org 拒绝创建应用：${s}`);
  }
}

/**
 * 每个号一份待交验证码的状态（只在内存里，10 分钟作废；进程重启就没了，重新获取验证码即可）
 * @param {{baseUrl: string}} o
 */
export function createMyTelegram({ baseUrl }) {
  /** @type {Map<string, {phone: string, randomHash: string, jar: Map<string,string>, until: number, busy: boolean}>} */
  const pending = new Map();

  function guard(accId) {
    const p = pending.get(accId);
    if (p?.busy) throw new HttpError(409, 'busy', '上一步尚未完成，请稍候');
    return p;
  }

  return {
    /**
     * 让 my.telegram.org 往这个手机号的 Telegram 里发验证码
     * @param {string} accId
     * @param {unknown} raw 带国家区号的手机号
     */
    async sendCode(accId, raw) {
      const s = typeof raw === 'string' ? raw.replace(/[\s\-().]/g, '').replace(/^00/, '+') : '';
      if (!/^\+\d{6,15}$/.test(s)) throw badRequest('手机号格式错误，需包含国家区号', 'bad_phone');
      guard(accId);
      const p = { phone: s, randomHash: '', jar: new Map(), until: Date.now() + PENDING_MS, busy: true };
      pending.set(accId, p);
      try {
        // 先打开一次登录页，和浏览器一样带着它给的 cookie 往下走
        await call(baseUrl, p.jar, '/auth');
        const r = await call(baseUrl, p.jar, '/auth/send_password', { phone: s });
        if (r.ok && typeof r.json?.random_hash === 'string' && r.json.random_hash) {
          p.randomHash = r.json.random_hash;
          return;
        }
        const msg = said(r);
        if (/too many/i.test(msg)) throw flood();
        if (/phone/i.test(msg)) throw badRequest(`my.telegram.org 不接受该手机号（${msg}），请填写该 Telegram 帐号绑定的手机号`, 'bad_phone');
        throw failed(`my.telegram.org 未发送验证码${msg ? `：${msg}` : ''}`);
      } catch (err) {
        pending.delete(accId);
        throw err;
      } finally {
        p.busy = false;
      }
    },

    /**
     * 交验证码：登录 my.telegram.org，读出（没有就新建）应用，再退出
     * @param {string} accId
     * @param {unknown} raw Telegram 里收到的验证码
     * @returns {Promise<{apiId: string, apiHash: string, created: boolean}>}
     */
    async apply(accId, raw) {
      const code = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
      if (!/^[\w-]{4,64}$/.test(code)) throw badRequest('请输入验证码', 'bad_code');
      const p = guard(accId);
      if (!p || !p.randomHash || p.until < Date.now()) {
        pending.delete(accId);
        throw badRequest('请先获取验证码（10 分钟内有效）', 'no_code');
      }
      p.busy = true;
      let loggedIn = false;
      try {
        const r = await call(baseUrl, p.jar, '/auth/login', { phone: p.phone, random_hash: p.randomHash, password: code });
        if (!r.ok) {
          const msg = said(r);
          if (/too many/i.test(msg)) throw flood();
          if (/code/i.test(msg)) throw badRequest('验证码错误（区分大小写）', 'bad_code');
          throw failed(`登录 my.telegram.org 失败${msg ? `：${msg}` : ''}`);
        }
        loggedIn = true;
        pending.delete(accId);
        let page = await readApps(baseUrl, p.jar);
        let created = false;
        if (page && 'create' in page) {
          await createApp(baseUrl, p.jar, page.create);
          created = true;
          page = await readApps(baseUrl, p.jar);
        }
        if (!page || !('apiId' in page)) {
          throw failed(
            `已登录 my.telegram.org${created ? '并创建应用' : ''}，但无法识别页面中的 api_id 和 api_hash（页面可能已改版）。` +
              '请在 my.telegram.org → API development tools 手动复制',
          );
        }
        return { apiId: page.apiId, apiHash: page.apiHash, created };
      } catch (err) {
        // 验证码填错了留着等重填；别的错要重新获取（登录后已经删掉了，这时可能又有了新获取的，别误删）
        if (pending.get(accId) === p && err?.code !== 'bad_code') pending.delete(accId);
        throw err;
      } finally {
        p.busy = false;
        // 用完退出（尽力而为）
        if (loggedIn) await call(baseUrl, p.jar, '/auth/logout').catch(() => {});
      }
    },

    /** 号删了、换了号码：丢掉待交的验证码 */
    cancel(accId) {
      pending.delete(accId);
    },
  };
}
