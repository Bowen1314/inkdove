// 全局设置（第二期）：只剩 llm、embedding、reply、media、leads、email、branding、pricing、outreach、suggest、translation、proxy、blockwords。号级设置（回复方式、名单、通道、通知、代理）在 accounts.js。
import { MAX_BLOCKWORDS, normalizeWordList } from './blockwords/match.js';
import { kvGet, kvSet } from './db.js';
import { checkBypassList } from './proxy/bypass.js';
import {
  FIELD_LABELS,
  getTranslationProvider,
  missingField,
  providerDefaults,
  publicProviders,
  TRANSLATION_PROVIDER_IDS,
} from './translate/index.js';
import { badRequest, isPlainObject } from './util.js';

export const DEFAULT_META_API_VERSION = 'v26.0';
export const LLM_FORMATS = ['openai', 'anthropic', 'gemini'];
export const EMAIL_PROVIDERS = [null, 'smtp', 'resend'];
/** 向量检索用哪个服务：llm 是和回复模型同一个（格式、地址、密钥都用回复模型的），custom 是单独配置 */
export const EMBEDDING_SOURCES = ['llm', 'custom'];
/** 向量接口的格式（Anthropic 没有向量接口） */
export const EMBEDDING_FORMATS = ['openai', 'gemini'];
export const EMBEDDING_DEFAULTS = Object.freeze({ enabled: false, source: 'llm', format: 'openai', baseUrl: '', apiKey: '', model: '' });
/** 会话输入框一键翻译的方式：ai 用回复模型翻译（默认，升级后不变），api 用翻译接口（translate/） */
export const TRANSLATION_MODES = ['ai', 'api'];
/** 选「翻译 API」时默认显示哪家 */
export const DEFAULT_TRANSLATION_PROVIDER = 'deepl';
/** 全局代理的节点来源：subscription 是 Clash 订阅地址，config 是粘贴的 Clash 配置 */
export const PROXY_SOURCES = ['subscription', 'config'];
export const PROXY_DEFAULTS = Object.freeze({ enabled: false, source: 'subscription', subscriptionUrl: '', node: '', bypass: [] });
/** 粘贴的 Clash 配置最长多少字符（请求体上限是 2MB） */
export const MAX_PROXY_CONFIG = 1_900_000;

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
    // 可选的向量检索（按意思搜，kb/vectors.js），默认关
    embedding: { ...EMBEDDING_DEFAULTS },
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
    // F12：模型单价 [{model, inputPerMillion, outputPerMillion}]，美元 / 百万 token，看板估算费用用。没填的模型只统计 token 数
    pricing: [],
    // F11 主动外联：每个号每天最多发几条（所有外联任务合计）、两条之间随机等多少秒、收件人当地时间的发送时段
    outreach: { ...OUTREACH_DEFAULTS },
    // 推荐回复：公司话术要求（所有业务员共用），拼进起草推荐回复的提示词
    suggest: { companyPrompt: '' },
    // 一键翻译：mode 是 ai（用回复模型）或 api（用 provider 这家翻译接口）；每家的配置分开存，换来换去不丢；
    // fallbackToAi：翻译接口出错时改用 AI 翻译（回复模型配好了才行）
    translation: { mode: 'ai', provider: DEFAULT_TRANSLATION_PROVIDER, fallbackToAi: true, providers: providerDefaults() },
    // 屏蔽词：发出去的消息里有这些词就不发（规则见 blockwords/match.js），默认关、词表为空
    blockwords: { enabled: false, words: [] },
    // 全局代理（默认关）：订阅地址是密钥（带机场账号的 token）；粘贴的配置不存原文，只存解析出的节点（proxy/index.js）。
    // node 是手动选的节点名，空串是自动选最快的；bypass 是不走代理的地址，每项一个
    proxy: { ...PROXY_DEFAULTS, bypass: [] },
  };
}

/** 公司话术要求最长多少字符 */
export const MAX_COMPANY_PROMPT = 4000;

export const OUTREACH_DEFAULTS = Object.freeze({
  dailyCapPerAccount: 30,
  minIntervalSeconds: 90,
  maxIntervalSeconds: 240,
  windowStart: '09:00',
  windowEnd: '20:00',
});
const OUTREACH_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * F11：校验外联设置。p 是要写的字段（没给的用 current 的值），返回校验后的完整设置。
 * 错误信息以字段路径开头（outreach.minIntervalSeconds …），前端靠它把错误放到对应字段下面。
 */
export function checkOutreach(current, p) {
  if (!isPlainObject(p)) throw badRequest('outreach 必须是对象');
  const o = { ...current };
  const int = (field, min, max) => {
    if (p[field] === undefined) return;
    const n = p[field];
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`outreach.${field} 必须是 ${min}–${max} 之间的整数`);
    o[field] = n;
  };
  int('dailyCapPerAccount', 1, 10000);
  int('minIntervalSeconds', 1, 86400);
  int('maxIntervalSeconds', 1, 86400);
  for (const field of ['windowStart', 'windowEnd']) {
    if (p[field] === undefined) continue;
    const v = typeof p[field] === 'string' ? p[field].trim() : p[field];
    if (typeof v !== 'string' || !OUTREACH_HHMM.test(v)) throw badRequest(`outreach.${field} 格式是 HH:MM，例如 09:00`);
    o[field] = v;
  }
  if (o.minIntervalSeconds > o.maxIntervalSeconds) throw badRequest('outreach.maxIntervalSeconds 不能小于最短间隔（minIntervalSeconds）');
  return o;
}

export const MAX_PRICING_ROWS = 200;
const MAX_PRICE_PER_MILLION = 100_000;

/**
 * 校验模型单价表：数组，每项 {model: 非空字符串, inputPerMillion, outputPerMillion: 0–100000 的数}，model 去掉首尾空白后不能重复。
 * 错误信息以 pricing 开头，前端靠它把错误放到表格下面。
 */
export function checkPricing(v) {
  if (!Array.isArray(v)) throw badRequest('pricing 必须是数组');
  if (v.length > MAX_PRICING_ROWS) throw badRequest(`pricing 最多 ${MAX_PRICING_ROWS} 行`);
  const seen = new Set();
  return v.map((row, i) => {
    const at = `pricing 第 ${i + 1} 行`;
    if (!isPlainObject(row)) throw badRequest(`${at}必须是对象`);
    const model = str(row.model, `${at}的 model`, 200).trim();
    if (!model) throw badRequest(`${at}的 model 不能为空`);
    if (seen.has(model)) throw badRequest(`${at}的 model 重复了：${model}`);
    seen.add(model);
    const price = (field) => {
      const n = row[field];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PRICE_PER_MILLION) {
        throw badRequest(`${at}的 ${field} 必须是 0–${MAX_PRICE_PER_MILLION} 之间的数字（美元 / 百万 token）`);
      }
      return n;
    };
    return { model, inputPerMillion: price('inputPerMillion'), outputPerMillion: price('outputPerMillion') };
  });
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
 * 首次启动用 INKDOVE_LLM_* 作为初始值；之后以 DB 为准。
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
  // 数组也不管形状：存坏了的单价表当成空表
  try {
    s.pricing = checkPricing(s.pricing);
  } catch {
    s.pricing = [];
  }
  // 存坏了的外联设置回到默认值
  try {
    s.outreach = checkOutreach(OUTREACH_DEFAULTS, s.outreach);
  } catch {
    s.outreach = { ...OUTREACH_DEFAULTS };
  }
  if (typeof s.suggest.companyPrompt !== 'string') s.suggest.companyPrompt = '';
  // 存坏了的向量检索设置：字段逐个回到默认值
  const em = s.embedding;
  if (typeof em.enabled !== 'boolean') em.enabled = false;
  if (!EMBEDDING_SOURCES.includes(em.source)) em.source = EMBEDDING_DEFAULTS.source;
  if (!EMBEDDING_FORMATS.includes(em.format)) em.format = EMBEDDING_DEFAULTS.format;
  for (const k of ['baseUrl', 'apiKey', 'model']) if (typeof em[k] !== 'string') em[k] = '';
  // 存坏了的翻译设置：字段逐个回到默认值（不认识的方式回到 AI 翻译）
  const tr = s.translation;
  if (!TRANSLATION_MODES.includes(tr.mode)) tr.mode = 'ai';
  if (!TRANSLATION_PROVIDER_IDS.includes(tr.provider)) tr.provider = DEFAULT_TRANSLATION_PROVIDER;
  if (typeof tr.fallbackToAi !== 'boolean') tr.fallbackToAi = true;
  const pd = providerDefaults();
  for (const [id, fields] of Object.entries(pd)) {
    for (const [k, v] of Object.entries(fields)) if (typeof tr.providers[id][k] !== 'string') tr.providers[id][k] = v;
  }
  // 存坏了的屏蔽词设置：开关回到关，词表只留能用的词（不是字符串、超长、没有字的去掉），最多 MAX_BLOCKWORDS 个
  if (typeof s.blockwords.enabled !== 'boolean') s.blockwords.enabled = false;
  try {
    s.blockwords.words = normalizeWordList(s.blockwords.words);
  } catch {
    const usable = (w) => {
      try {
        return normalizeWordList([w]).length === 1;
      } catch {
        return false;
      }
    };
    const words = Array.isArray(s.blockwords.words) ? s.blockwords.words.filter(usable) : [];
    s.blockwords.words = normalizeWordList(words.slice(0, MAX_BLOCKWORDS));
  }
  // 存坏了的全局代理设置：字段逐个回到默认值（数组 shapeLike 不管，单独校验）
  const px = s.proxy;
  if (typeof px.enabled !== 'boolean') px.enabled = false;
  if (!PROXY_SOURCES.includes(px.source)) px.source = PROXY_DEFAULTS.source;
  for (const k of ['subscriptionUrl', 'node']) if (typeof px[k] !== 'string') px[k] = '';
  try {
    px.bypass = checkBypassList(px.bypass);
  } catch {
    px.bypass = [];
  }
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
    embedding: {
      enabled: s.embedding.enabled,
      source: s.embedding.source,
      format: s.embedding.format,
      baseUrl: s.embedding.baseUrl,
      model: s.embedding.model,
      apiKeySet: !!s.embedding.apiKey,
      apiKeyLast4: last4(s.embedding.apiKey),
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
    pricing: s.pricing.map((p) => ({ ...p })),
    outreach: { ...s.outreach },
    suggest: { companyPrompt: s.suggest.companyPrompt },
    translation: {
      mode: s.translation.mode,
      provider: s.translation.provider,
      fallbackToAi: s.translation.fallbackToAi,
      providers: publicProviders(s.translation.providers),
    },
    blockwords: { enabled: s.blockwords.enabled, words: [...s.blockwords.words] },
    // 订阅地址不回传，只说填没填；节点名和粘贴的配置在 GET /settings/proxy/status 里
    proxy: {
      enabled: s.proxy.enabled,
      source: s.proxy.source,
      node: s.proxy.node,
      bypass: [...s.proxy.bypass],
      subscriptionUrlSet: !!s.proxy.subscriptionUrl,
    },
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

/** 接口地址校验：去掉首尾空白；非空时必须是 http(s)。错误信息以 field 开头 */
export function checkBaseUrl(v, field) {
  const s = str(v, field, 500).trim();
  if (s && !/^https?:\/\//i.test(s)) throw badRequest(`${field} 必须以 http:// 或 https:// 开头`);
  return s;
}

/** 回复模型的接口地址（设置保存和获取模型列表共用） */
export const checkLlmBaseUrl = (v) => checkBaseUrl(v, 'llm.baseUrl');

/**
 * 向量检索设置的字段校验（不做「开着时必须填什么」的交叉检查，那个在 applySettingsPatch 里）。设置保存和测试接口共用。
 * 错误信息以 embedding.<字段> 开头，前端靠它把错误放到对应字段下面。
 * @param {any} current 现在的 embedding 设置
 * @param {any} p 要改的字段
 * @returns 改好的完整 embedding 设置（不改动入参）
 */
export function checkEmbeddingPatch(current, p) {
  if (!isPlainObject(p)) throw badRequest('embedding 必须是对象');
  const e = { ...current };
  if (p.enabled !== undefined) e.enabled = boolField(p.enabled, 'embedding.enabled');
  if (p.source !== undefined) {
    if (!EMBEDDING_SOURCES.includes(p.source)) throw badRequest('embedding.source 只能是 llm（和回复模型同一个）或 custom（单独配置）');
    e.source = p.source;
  }
  if (p.format !== undefined) {
    if (!EMBEDDING_FORMATS.includes(p.format)) throw badRequest('embedding.format 只能是 openai 或 gemini');
    e.format = p.format;
  }
  if (p.baseUrl !== undefined) e.baseUrl = checkBaseUrl(p.baseUrl, 'embedding.baseUrl');
  if (p.model !== undefined) e.model = str(p.model, 'embedding.model', 200).trim();
  if (p.apiKey !== undefined) e.apiKey = str(p.apiKey, 'embedding.apiKey', 1000).trim();
  return e;
}

/**
 * 向量检索实际用的接口。source=llm 时格式、地址、密钥用回复模型的（回复模型是 Anthropic 时用不了），模型都用 embedding.model。
 * 不管开没开都算，开关由调用方看。
 * @param {{llm:any, embedding:any}} s
 * @returns {{ok:true, format:string, baseUrl:string, apiKey:string, model:string} | {ok:false, error:string, field:string}}
 *   field：哪个字段的问题（前端放错误用）
 */
export function resolveEmbeddingConfig(s) {
  const e = s.embedding;
  const model = String(e.model || '').trim();
  let cfg;
  if (e.source === 'custom') {
    cfg = { format: e.format, baseUrl: String(e.baseUrl || '').trim(), apiKey: e.apiKey || '' };
    if (!cfg.baseUrl) return { ok: false, error: '还没有填写向量接口的地址', field: 'baseUrl' };
  } else {
    if (!EMBEDDING_FORMATS.includes(s.llm.format)) {
      return { ok: false, error: '回复模型是 Anthropic 格式，Anthropic 没有向量接口，请选「单独配置」', field: 'source' };
    }
    cfg = { format: s.llm.format, baseUrl: String(s.llm.baseUrl || '').trim(), apiKey: s.llm.apiKey || '' };
    if (!cfg.baseUrl) return { ok: false, error: '回复模型还没有填接口地址，请先填好或选「单独配置」', field: 'source' };
  }
  if (!model) return { ok: false, error: '还没有填写向量模型', field: 'model' };
  return { ok: true, ...cfg, model };
}

/**
 * 一家翻译服务的配置字段校验。设置保存和测试接口共用。
 * - 密钥（secret、secretUrl）：不给或空串（去掉首尾空白后）表示不改，null 表示清空。和回复模型的密钥不同（那边空串就是清空），
 *   因为设置页的密钥框留空就是「不改」，清空走单独的按钮；
 * - 其他字段：不给表示不改，空串或 null 表示清空；
 * - 地址必须是 http(s)；密钥只能是可见 ASCII（否则拼请求头会出错）；区域按各家的格式。
 * 错误信息以 translation.providers.<服务>.<字段> 开头，前端靠它把错误放到对应字段下面；信息里不带填的值（可能是密钥）。
 * @param {string} id 服务
 * @param {Record<string,string>} current 现在的配置
 * @param {unknown} p 要改的字段
 * @returns 改好的完整配置（不改动入参）
 */
export function checkTranslationProviderPatch(id, current, p) {
  const provider = getTranslationProvider(id);
  if (!provider) throw badRequest(`translation.provider 不认识：${String(id).slice(0, 40)}`);
  const at = `translation.providers.${id}`;
  if (!isPlainObject(p)) throw badRequest(`${at} 必须是对象`);
  const out = { ...current };
  for (const f of provider.fields) {
    const v = p[f.key];
    const field = `${at}.${f.key}`;
    if (v === undefined) continue;
    const secret = f.type === 'secret' || f.type === 'secretUrl';
    if (v === null) {
      out[f.key] = '';
      continue;
    }
    const s = str(v, field, f.max).trim();
    if (!s) {
      if (!secret) out[f.key] = '';
      continue;
    }
    if (f.type === 'url' || f.type === 'secretUrl') out[f.key] = checkBaseUrl(s, field);
    else {
      if (f.type === 'secret' && !/^[\x21-\x7e]+$/.test(s)) throw badRequest(`${field} 里有空格、中文或其他特殊字符，请检查后重新填写`);
      if (f.pattern && !f.pattern.test(s)) throw badRequest(`${field} 格式不对`);
      out[f.key] = s;
    }
  }
  return out;
}

/**
 * 翻译设置的校验（不做「选了翻译 API 时这家必须配好」的交叉检查，那个在 applySettingsPatch 里）。
 * @param {any} current 现在的 translation 设置
 * @param {unknown} p 要改的字段；providers 里只给要改的服务、要改的字段
 */
export function checkTranslationPatch(current, p) {
  if (!isPlainObject(p)) throw badRequest('translation 必须是对象');
  const t = { ...current, providers: { ...current.providers } };
  if (p.mode !== undefined) {
    if (!TRANSLATION_MODES.includes(p.mode)) throw badRequest('translation.mode 只能是 ai（AI 翻译）或 api（翻译 API）');
    t.mode = p.mode;
  }
  if (p.provider !== undefined) {
    if (!TRANSLATION_PROVIDER_IDS.includes(p.provider)) throw badRequest(`translation.provider 只能是 ${TRANSLATION_PROVIDER_IDS.join('、')}`);
    t.provider = p.provider;
  }
  if (p.fallbackToAi !== undefined) t.fallbackToAi = boolField(p.fallbackToAi, 'translation.fallbackToAi');
  if (p.providers !== undefined) {
    if (!isPlainObject(p.providers)) throw badRequest('translation.providers 必须是对象');
    // 不认识的服务忽略（和别的设置一样）
    for (const id of TRANSLATION_PROVIDER_IDS) {
      if (p.providers[id] !== undefined) t.providers[id] = checkTranslationProviderPatch(id, t.providers[id], p.providers[id]);
    }
  }
  return t;
}

/**
 * 选了「翻译 API」时这家服务还缺什么：{field, message}，都填好了返回 null。
 * @param {any} translation settings.translation
 */
export function translationProviderProblem(translation) {
  const provider = getTranslationProvider(translation.provider);
  if (!provider) return { field: 'provider', message: '还没有选翻译服务' };
  const field = missingField(provider.id, translation.providers[provider.id]);
  if (!field) return null;
  return { field, message: `还没有填 ${provider.label} 的 ${FIELD_LABELS[field] || field}` };
}

/**
 * 全局代理设置的字段校验（要下载订阅、看节点在不在、能不能关的检查在 proxy/index.js 的 prepare 里）。
 * - 订阅地址是密钥：不给或空串（去掉首尾空白后）表示不改，null 表示清空；
 * - config（粘贴的 Clash 配置）不存进设置：这里只查类型和长度，解析在 prepare 里；
 * - node：空串是自动选最快的。
 * 错误信息以 proxy.<字段> 开头，前端靠它把错误放到对应字段下面；信息里不带填的值。
 * @param {any} current 现在的 proxy 设置
 * @param {unknown} p 要改的字段
 * @returns 改好的完整 proxy 设置（不改动入参）
 */
export function checkProxyPatch(current, p) {
  if (!isPlainObject(p)) throw badRequest('proxy 必须是对象');
  const out = { ...current, bypass: [...current.bypass] };
  if (p.enabled !== undefined) out.enabled = boolField(p.enabled, 'proxy.enabled');
  if (p.source !== undefined) {
    if (!PROXY_SOURCES.includes(p.source)) throw badRequest('proxy.source 只能是 subscription（订阅地址）或 config（粘贴 Clash 配置）');
    out.source = p.source;
  }
  if (p.subscriptionUrl === null) out.subscriptionUrl = '';
  else if (p.subscriptionUrl !== undefined) {
    const v = str(p.subscriptionUrl, 'proxy.subscriptionUrl', 4000).trim();
    if (v) {
      let u = null;
      try {
        u = new URL(v);
      } catch {
        /* 下面报错 */
      }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw badRequest('proxy.subscriptionUrl 必须是 http:// 或 https:// 开头的网址');
      out.subscriptionUrl = v;
    }
  }
  if (p.config !== undefined && p.config !== null) str(p.config, 'proxy.config', MAX_PROXY_CONFIG);
  if (p.node !== undefined) {
    if (p.node === null) out.node = '';
    else out.node = str(p.node, 'proxy.node', 200);
  }
  if (p.bypass !== undefined) out.bypass = checkBypassList(p.bypass);
  return out;
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

  if (patch.embedding !== undefined) s.embedding = checkEmbeddingPatch(s.embedding, patch.embedding);
  // 向量检索开着时：用回复模型的服务就不能是 Anthropic（改回复模型的接口格式时也查），单独配置要有地址，都要有模型名。
  // 只在这次改动涉及 embedding 或回复模型的接口格式时检查（不影响只改别的设置）
  if ((patch.embedding !== undefined || patch.llm?.format !== undefined) && s.embedding.enabled) {
    if (s.embedding.source === 'llm' && !EMBEDDING_FORMATS.includes(s.llm.format)) {
      throw badRequest(
        patch.embedding !== undefined
          ? '回复模型是 Anthropic 格式，Anthropic 没有向量接口：向量检索请选「单独配置」'
          : '向量检索在用回复模型的服务，Anthropic 没有向量接口：请先把向量检索改成「单独配置」或关掉，再换接口格式',
        'embedding_unsupported_for_format',
      );
    }
    if (s.embedding.source === 'custom' && !s.embedding.baseUrl) {
      throw badRequest('embedding.baseUrl 开启向量检索并单独配置时必须填写接口地址', 'embedding_base_url_required');
    }
    if (!s.embedding.model) throw badRequest('embedding.model 开启向量检索时必须填写向量模型', 'embedding_model_required');
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

  // F12：模型单价表整体替换
  if (patch.pricing !== undefined) s.pricing = checkPricing(patch.pricing);
  // F11：外联设置（前端整块写；只给了部分字段时其余保持不变）
  if (patch.outreach !== undefined) s.outreach = checkOutreach(s.outreach, patch.outreach);
  // 推荐回复：公司话术要求
  if (patch.suggest !== undefined) {
    const p = patch.suggest;
    if (!isPlainObject(p)) throw badRequest('suggest 必须是对象');
    if (p.companyPrompt !== undefined) s.suggest.companyPrompt = str(p.companyPrompt, 'suggest.companyPrompt', MAX_COMPANY_PROMPT);
  }
  // 一键翻译。选了翻译 API 时，这家服务的必填字段要填好（只在这次改动涉及 translation 时检查）
  if (patch.translation !== undefined) {
    s.translation = checkTranslationPatch(s.translation, patch.translation);
    if (s.translation.mode === 'api') {
      const problem = translationProviderProblem(s.translation);
      if (problem) {
        const at = problem.field === 'provider' ? 'translation.provider' : `translation.providers.${s.translation.provider}.${problem.field}`;
        throw badRequest(`${at} 选「翻译 API」时要先填好：${problem.message}`, 'translation_provider_not_configured');
      }
    }
  }
  // 屏蔽词：开关和词表（词表整体替换）
  if (patch.blockwords !== undefined) {
    const p = patch.blockwords;
    if (!isPlainObject(p)) throw badRequest('blockwords 必须是对象');
    if (p.enabled !== undefined) s.blockwords.enabled = boolField(p.enabled, 'blockwords.enabled');
    if (p.words !== undefined) s.blockwords.words = normalizeWordList(p.words);
  }
  // 全局代理：字段校验在这里；要联网、看号的检查由接口层调 ctx.globalProxy.prepare
  if (patch.proxy !== undefined) s.proxy = checkProxyPatch(s.proxy, patch.proxy);
  return s;
}

/** LLM 是否已配置（mock 下视为已配置） */
export function llmConfigured(settings, config) {
  if (config.llmMock) return true;
  return !!(settings.llm.baseUrl && settings.llm.model);
}
