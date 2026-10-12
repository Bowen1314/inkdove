// 全局设置（第二期）：只剩 llm、reply、media、leads、email、branding。号级设置（自动回复开关、名单、通道、通知、代理）在 accounts.js。
import { kvGet, kvSet } from './db.js';
import { badRequest, isPlainObject } from './util.js';

export const DEFAULT_META_API_VERSION = 'v26.0';
export const LLM_FORMATS = ['openai', 'anthropic', 'gemini'];
export const EMAIL_PROVIDERS = [null, 'smtp', 'resend'];

/** @param {import('./config.js').Config} config */
function defaults(config) {
  return {
    llm: {
      format: 'openai',
      baseUrl: config.llmInit.baseUrl,
      apiKey: config.llmInit.apiKey,
      model: config.llmInit.model,
      distillModel: config.llmInit.distillModel,
    },
    reply: {
      persona: '',
      debounceSeconds: 4,
      maxBotRepliesPerChatPerHour: 20,
      humanize: true,
    },
    // F4（下一段）：语音和图片识别
    media: { voice: false, image: false, mediaModel: '', transcribeModel: '' },
    // F6（下一段）：客户线索
    leads: { enabled: true },
    email: {
      provider: null,
      from: '',
      smtp: { host: '', port: 465, secure: true, user: '', password: '' },
      resend: { apiKey: '' },
    },
    // 网站名称和 Logo。logo 是 {filename, mime, updatedAt} 或 null，文件在 {dataDir}/branding/ 下，只由上传接口改
    branding: { title: '', logo: null },
  };
}

/** 按 defaults 的形状取值：未知字段丢掉，缺的字段补默认值 */
function shapeLike(base, stored) {
  if (!isPlainObject(base)) return stored === undefined ? base : stored;
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    const s = isPlainObject(stored) ? stored[k] : undefined;
    if (isPlainObject(v)) out[k] = shapeLike(v, s);
    else out[k] = s === undefined ? v : s;
  }
  return out;
}

/** 号码规范化：只保留数字，去重，去空 */
export function normalizeNumbers(input, field = '号码列表') {
  let list = input;
  if (typeof list === 'string') list = list.split(/[\n,;，；]+/);
  if (!Array.isArray(list)) throw badRequest(`${field}必须是数组`);
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const digits = String(item).replace(/\D+/g, '');
    if (digits && !out.includes(digits)) out.push(digits);
  }
  return out;
}

/** 邮箱列表规范化 */
export function normalizeEmails(input, field = 'to') {
  let list = input;
  if (typeof list === 'string') list = list.split(/[\n,;，；\s]+/);
  if (!Array.isArray(list)) throw badRequest(`${field} 必须是数组`);
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v) continue;
    if (!/^[^\s@]+@[^\s@]+$/.test(v)) throw badRequest(`邮箱格式不对：${v}`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 首次启动用 KBWA_LLM_* 作为初始值；之后以 DB 为准。
 * 第一期存的旧字段（reply.autoReply、notify、channel）不再出现在全局设置里，由 accounts.js 的迁移接走。
 * @param {import('better-sqlite3').Database} db
 * @param {import('./config.js').Config} config
 */
export function loadSettings(db, config) {
  const stored = kvGet(db, 'settings', null);
  if (!stored) {
    const init = defaults(config);
    kvSet(db, 'settings', init);
    return init;
  }
  const s = shapeLike(defaults(config), stored);
  // shapeLike 不管 null 默认值下面的形状，这里单独把坏掉的 logo 元数据当成没有
  if (typeof s.branding.title !== 'string') s.branding.title = '';
  if (!validLogoMeta(s.branding.logo)) s.branding.logo = null;
  return s;
}

const LOGO_FILENAME = /^logo-[A-Za-z0-9-]+\.(png|jpg|webp|svg)$/;

/** logo 元数据是否完整（文件名只允许上传接口生成的格式，防止拼出别的路径） */
function validLogoMeta(m) {
  return isPlainObject(m) && typeof m.filename === 'string' && LOGO_FILENAME.test(m.filename) && typeof m.mime === 'string' && Number.isFinite(m.updatedAt);
}

/** 已设置的 logo 元数据，或 null */
export const logoMeta = (s) => (validLogoMeta(s.branding?.logo) ? s.branding.logo : null);

/** logo 的公开地址，v 用来换版本（浏览器缓存一天）；没有 logo 时为 null */
export function logoUrl(s) {
  const m = logoMeta(s);
  return m ? `/api/branding/logo?v=${m.updatedAt}` : null;
}

/** 公开接口 GET /api/branding 的内容：只有名称和 logo 地址，别的设置一律不带 */
export function publicBranding(s) {
  return { title: s.branding.title, logoUrl: logoUrl(s) };
}

export function saveSettings(db, settings) {
  kvSet(db, 'settings', settings);
}

const last4 = (k) => (k ? k.slice(-4) : null);

/** 全局发信方式是否配好了（F10） */
export function emailConfigured(s) {
  const e = s.email;
  if (e.provider === 'smtp') return !!e.smtp.host;
  if (e.provider === 'resend') return !!e.resend.apiKey;
  return false;
}

/** 对外视图：密钥不回传明文 */
export function publicSettings(s, config) {
  const key = s.llm.apiKey || '';
  return {
    llm: {
      format: s.llm.format,
      baseUrl: s.llm.baseUrl,
      model: s.llm.model,
      distillModel: s.llm.distillModel,
      apiKeySet: !!key,
      apiKeyLast4: last4(key),
    },
    reply: {
      persona: s.reply.persona,
      debounceSeconds: s.reply.debounceSeconds,
      maxBotRepliesPerChatPerHour: s.reply.maxBotRepliesPerChatPerHour,
      humanize: s.reply.humanize,
    },
    media: { ...s.media },
    leads: { ...s.leads },
    email: {
      provider: s.email.provider,
      from: s.email.from,
      smtp: {
        host: s.email.smtp.host,
        port: s.email.smtp.port,
        secure: s.email.smtp.secure,
        user: s.email.smtp.user,
        passwordSet: !!s.email.smtp.password,
      },
      resend: { apiKeySet: !!s.email.resend.apiKey, apiKeyLast4: last4(s.email.resend.apiKey) },
    },
    branding: { title: s.branding.title, logoSet: !!logoMeta(s), logoUrl: logoUrl(s) },
    webhookBase: config.publicBaseUrl,
  };
}

export const str = (v, field, max = 20000) => {
  if (typeof v !== 'string') throw badRequest(`${field} 必须是字符串`);
  if (v.length > max) throw badRequest(`${field} 太长`);
  return v;
};
export const boolField = (v, field) => {
  if (typeof v !== 'boolean') throw badRequest(`${field} 必须是布尔值`);
  return v;
};

/** 接口格式校验（设置保存和获取模型列表共用） */
export function checkLlmFormat(v) {
  if (!LLM_FORMATS.includes(v)) throw badRequest('llm.format 只能是 openai、anthropic 或 gemini');
  return v;
}

/** 接口地址校验：去掉首尾空白；非空时必须是 http(s)（设置保存和获取模型列表共用） */
export function checkLlmBaseUrl(v) {
  const s = str(v, 'llm.baseUrl', 500).trim();
  if (s && !/^https?:\/\//i.test(s)) throw badRequest('llm.baseUrl 必须以 http:// 或 https:// 开头');
  return s;
}

export const BRAND_TITLE_MAX = 40;

/** 网站名称：去掉首尾空白后最多 40 个字符，不能有换行和控制字符。错误信息以 branding.title 开头，前端靠它把错误放到字段下面 */
function brandTitle(v) {
  const s = str(v, 'branding.title', 1000).trim();
  if ([...s].length > BRAND_TITLE_MAX) throw badRequest(`branding.title 太长，最多 ${BRAND_TITLE_MAX} 个字符`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) throw badRequest('branding.title 不能有换行或控制字符');
  return s;
}

/**
 * 部分更新。未知字段忽略；类型不对返回 400。
 * @returns 新的 settings（不改动入参）
 */
export function applySettingsPatch(current, patch) {
  if (!isPlainObject(patch)) throw badRequest('请求体必须是对象');
  const s = structuredClone(current);

  if (patch.llm !== undefined) {
    const p = patch.llm;
    if (!isPlainObject(p)) throw badRequest('llm 必须是对象');
    if (p.format !== undefined) s.llm.format = checkLlmFormat(p.format);
    if (p.baseUrl !== undefined) s.llm.baseUrl = checkLlmBaseUrl(p.baseUrl);
    if (p.model !== undefined) s.llm.model = str(p.model, 'llm.model', 200).trim();
    if (p.distillModel !== undefined) s.llm.distillModel = str(p.distillModel, 'llm.distillModel', 200).trim();
    if (p.apiKey !== undefined) s.llm.apiKey = str(p.apiKey, 'llm.apiKey', 1000).trim();
  }

  if (patch.reply !== undefined) {
    const p = patch.reply;
    if (!isPlainObject(p)) throw badRequest('reply 必须是对象');
    if (p.persona !== undefined) s.reply.persona = str(p.persona, 'reply.persona', 4000);
    if (p.debounceSeconds !== undefined) {
      const n = p.debounceSeconds;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 120) {
        throw badRequest('reply.debounceSeconds 必须是 0–120 之间的数字');
      }
      s.reply.debounceSeconds = n;
    }
    if (p.maxBotRepliesPerChatPerHour !== undefined) {
      const n = p.maxBotRepliesPerChatPerHour;
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw badRequest('reply.maxBotRepliesPerChatPerHour 必须是 1–1000 的整数');
      s.reply.maxBotRepliesPerChatPerHour = n;
    }
    if (p.humanize !== undefined) s.reply.humanize = boolField(p.humanize, 'reply.humanize');
  }

  if (patch.media !== undefined) {
    const p = patch.media;
    if (!isPlainObject(p)) throw badRequest('media 必须是对象');
    if (p.voice !== undefined) s.media.voice = boolField(p.voice, 'media.voice');
    if (p.image !== undefined) s.media.image = boolField(p.image, 'media.image');
    if (p.mediaModel !== undefined) s.media.mediaModel = str(p.mediaModel, 'media.mediaModel', 200).trim();
    if (p.transcribeModel !== undefined) s.media.transcribeModel = str(p.transcribeModel, 'media.transcribeModel', 200).trim();
  }
  // F4：语音识别按接口格式的限制。只在这次改动涉及 media 或接口格式时检查（不影响只改别的设置）
  if ((patch.media !== undefined || patch.llm?.format !== undefined) && s.media.voice) {
    if (s.llm.format === 'anthropic') {
      throw badRequest('Anthropic 格式不支持语音识别，请关闭语音识别或换成 OpenAI / Gemini 格式', 'voice_unsupported_for_format');
    }
    if (s.llm.format === 'openai' && !s.media.transcribeModel) {
      throw badRequest('OpenAI 格式开启语音识别时要填转写模型（transcribeModel，例如 whisper-1）', 'transcribe_model_required');
    }
  }
  if (patch.leads !== undefined) {
    if (!isPlainObject(patch.leads)) throw badRequest('leads 必须是对象');
    if (patch.leads.enabled !== undefined) s.leads.enabled = boolField(patch.leads.enabled, 'leads.enabled');
  }

  if (patch.email !== undefined) {
    const p = patch.email;
    if (!isPlainObject(p)) throw badRequest('email 必须是对象');
    if (p.provider !== undefined) {
      if (!EMAIL_PROVIDERS.includes(p.provider)) throw badRequest('email.provider 只能是 null、smtp 或 resend');
      s.email.provider = p.provider;
    }
    if (p.from !== undefined) s.email.from = str(p.from, 'email.from', 255).trim();
    if (p.smtp !== undefined) {
      const e = p.smtp;
      if (!isPlainObject(e)) throw badRequest('email.smtp 必须是对象');
      const t = s.email.smtp;
      if (e.host !== undefined) t.host = str(e.host, 'email.smtp.host', 255).trim();
      if (e.port !== undefined) {
        if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw badRequest('email.smtp.port 必须是 1–65535 的整数');
        t.port = e.port;
      }
      if (e.secure !== undefined) t.secure = boolField(e.secure, 'email.smtp.secure');
      if (e.user !== undefined) t.user = str(e.user, 'email.smtp.user', 255).trim();
      if (e.password !== undefined) t.password = str(e.password, 'email.smtp.password', 500);
    }
    if (p.resend !== undefined) {
      if (!isPlainObject(p.resend)) throw badRequest('email.resend 必须是对象');
      if (p.resend.apiKey !== undefined) s.email.resend.apiKey = str(p.resend.apiKey, 'email.resend.apiKey', 500).trim();
    }
  }

  // 品牌：这里只改名称；logo 只能走上传、移除接口，branding.logo 和别的字段忽略
  if (patch.branding !== undefined) {
    const p = patch.branding;
    if (!isPlainObject(p)) throw badRequest('branding 必须是对象');
    if (p.title !== undefined) s.branding.title = brandTitle(p.title);
  }
  return s;
}

/** LLM 是否已配置（mock 下视为已配置） */
export function llmConfigured(settings, config) {
  if (config.llmMock) return true;
  return !!(settings.llm.baseUrl && settings.llm.model);
}
