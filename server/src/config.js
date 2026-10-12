import path from 'node:path';

/**
 * 只读取 KBWA_ 前缀的环境变量。禁止读取 LLM_API_KEY / OPENAI_API_KEY 等通用名。
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env = process.env) {
  /** @param {string} name */
  const get = (name) => {
    if (!name.startsWith('KBWA_')) throw new Error(`只允许读取 KBWA_ 变量：${name}`);
    const v = env[name];
    return v === undefined ? '' : String(v);
  };
  const num = (name, def) => {
    const raw = get(name).trim();
    if (!raw) return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  const bool = (name) => ['1', 'true', 'yes', 'on'].includes(get(name).trim().toLowerCase());

  const config = {
    port: num('KBWA_PORT', 8794),
    dataDir: path.resolve(get('KBWA_DATA_DIR').trim() || './data'),
    adminEmail: get('KBWA_ADMIN_EMAIL').trim().toLowerCase(),
    adminPassword: get('KBWA_ADMIN_PASSWORD'),
    sessionSecret: get('KBWA_SESSION_SECRET'),
    publicBaseUrl: (get('KBWA_PUBLIC_BASE_URL').trim() || 'http://127.0.0.1:8794').replace(/\/+$/, ''),
    cookieSecure: bool('KBWA_COOKIE_SECURE'),
    wahaUrl: (get('KBWA_WAHA_URL').trim() || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    wahaApiKey: get('KBWA_WAHA_API_KEY').trim(),
    wahaWebhookUrl: get('KBWA_WAHA_WEBHOOK_URL').trim() || 'http://127.0.0.1:8794/webhooks/waha',
    wahaWebhookSecret: get('KBWA_WAHA_WEBHOOK_SECRET'),
    // F13 代理中继：每个号一个端口，从这里往上分配；WAHA 用 KBWA_PROXY_RELAY_HOST 连过来（compose 里 kbwa 的固定主机名）
    proxyRelayPortBase: num('KBWA_PROXY_RELAY_PORT_BASE', 18000),
    proxyRelayHost: get('KBWA_PROXY_RELAY_HOST').trim() || 'kbwa',
    // 仅第一期升级用：第一期的 WAHA session 名，迁移成「默认号」时沿用，已扫码的登录态不用重扫
    legacyWahaSession: get('KBWA_WAHA_SESSION').trim() || 'default',
    llmInit: {
      baseUrl: get('KBWA_LLM_BASE_URL').trim(),
      apiKey: get('KBWA_LLM_API_KEY').trim(),
      model: get('KBWA_LLM_MODEL').trim(),
      distillModel: get('KBWA_LLM_DISTILL_MODEL').trim(),
    },
    llmMock: bool('KBWA_LLM_MOCK'),
    // 仅测试用：覆盖 Meta Graph API 基址
    metaGraphUrl: (get('KBWA_META_GRAPH_URL').trim() || 'https://graph.facebook.com').replace(/\/+$/, ''),
    // 仅测试用：覆盖 Resend API 地址
    resendApiUrl: get('KBWA_RESEND_API_URL').trim() || 'https://api.resend.com/emails',
  };

  const errors = [];
  if (!config.adminEmail) errors.push('缺少 KBWA_ADMIN_EMAIL');
  else if (!/^[^\s@]+@[^\s@]+$/.test(config.adminEmail)) errors.push('KBWA_ADMIN_EMAIL 不是合法的邮箱');
  if (!config.adminPassword) errors.push('缺少 KBWA_ADMIN_PASSWORD');
  else if (config.adminPassword.length < 12) errors.push('KBWA_ADMIN_PASSWORD 至少 12 个字符');
  if (!config.sessionSecret) errors.push('缺少 KBWA_SESSION_SECRET');
  if (!config.wahaWebhookSecret) errors.push('缺少 KBWA_WAHA_WEBHOOK_SECRET');
  if (!Number.isInteger(config.proxyRelayPortBase) || config.proxyRelayPortBase < 1024 || config.proxyRelayPortBase > 65000) {
    errors.push('KBWA_PROXY_RELAY_PORT_BASE 必须是 1024–65000 的整数');
  }
  if (errors.length) {
    const err = new Error(errors.join('；'));
    err.name = 'ConfigError';
    throw err;
  }
  return config;
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
