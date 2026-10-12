// WAHA HTTP 客户端。接口以 https://waha.devlike.pro/docs/how-to/sessions/ 等官方文档为准。

export class WahaError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {import('../config.js').Config} config
 */
export function createWahaClient(config) {
  const base = config.wahaUrl;

  async function request(method, path, { body, timeoutMs = 10_000, accept = 'application/json', raw = false } = {}) {
    const headers = { accept };
    if (config.wahaApiKey) headers['x-api-key'] = config.wahaApiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? '超时' : err?.cause?.code || err?.message || String(err);
      throw new WahaError(`WAHA 连不上（${base}）：${why}`);
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.message || data.error)) || String(text).slice(0, 200);
      throw new WahaError(`WAHA 返回 ${res.status}：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
    }
    return data;
  }

  const enc = encodeURIComponent;

  return {
    /** GET /api/sessions/{session}，不存在返回 null */
    async getSession(name, timeoutMs = 3000) {
      try {
        return await request('GET', `/api/sessions/${enc(name)}`, { timeoutMs });
      } catch (err) {
        if (err instanceof WahaError && err.status === 404) return null;
        throw err;
      }
    },
    /** POST /api/sessions */
    createSession(name, sessionConfig) {
      return request('POST', '/api/sessions', { body: { name, start: true, config: sessionConfig } });
    },
    /** PUT /api/sessions/{session} */
    updateSession(name, sessionConfig) {
      return request('PUT', `/api/sessions/${enc(name)}`, { body: { name, config: sessionConfig } });
    },
    startSession(name) {
      return request('POST', `/api/sessions/${enc(name)}/start`);
    },
    stopSession(name) {
      return request('POST', `/api/sessions/${enc(name)}/stop`);
    },
    logoutSession(name) {
      return request('POST', `/api/sessions/${enc(name)}/logout`);
    },
    /** DELETE /api/sessions/{session}：文档写明会先登出并停止，幂等 */
    deleteSession(name) {
      return request('DELETE', `/api/sessions/${enc(name)}`);
    },
    /** POST /api/sendSeen {session, chatId, messageIds?}（GOWS 支持 messageIds） */
    sendSeen(session, chatId, messageIds) {
      const body = { session, chatId };
      if (messageIds?.length) body.messageIds = messageIds;
      return request('POST', '/api/sendSeen', { body, timeoutMs: 10_000 });
    },
    /** POST /api/{session}/presence {chatId, presence:"typing"|"paused"}（startTyping/stopTyping 是它的快捷方式） */
    setPresence(session, chatId, presence) {
      return request('POST', `/api/${enc(session)}/presence`, { body: { chatId, presence }, timeoutMs: 10_000 });
    },
    /** GET /api/{session}/auth/qr?format=image（Accept: image/png） */
    async getQrPng(name) {
      const res = await request('GET', `/api/${enc(name)}/auth/qr?format=image`, { accept: 'image/png', raw: true, timeoutMs: 5000 });
      return Buffer.from(await res.arrayBuffer());
    },
    /** POST /api/sendText {session, chatId, text}，返回消息 id（拿不到为 null） */
    async sendText(session, chatId, text) {
      const data = await request('POST', '/api/sendText', { body: { session, chatId, text }, timeoutMs: 20_000 });
      const id = data?.id;
      if (typeof id === 'string') return id;
      return id?._serialized || id?.id || data?.key?.id || null;
    },
    /**
     * F15：POST /api/sendImage 或 /api/sendFile {session, chatId, file, caption?}。
     * file 是 {mimetype, filename, data(base64，不带 data: 前缀)} 或 {mimetype, filename, url}。GOWS 两个都支持。
     * https://waha.devlike.pro/docs/how-to/send-messages/
     * @param {'image'|'file'} kind
     */
    async sendMedia(kind, session, chatId, file, caption) {
      const body = { session, chatId, file };
      if (caption) body.caption = caption;
      const data = await request('POST', kind === 'image' ? '/api/sendImage' : '/api/sendFile', { body, timeoutMs: 120_000 });
      const id = data?.id;
      if (typeof id === 'string') return id;
      return id?._serialized || id?.id || data?.key?.id || null;
    },
    /**
     * F4：下载入站媒体。payload.media.url 由 WAHA 按 WAHA_BASE_URL 拼成，形如 http://<host>/api/files/<session>/<file>；
     * 这里只取路径，拼到 KBWA_WAHA_URL 上再请求（带 X-Api-Key），不会把 key 发到别的主机。
     * @returns {Promise<{buffer:Buffer, mime:string}>}
     */
    async downloadMedia(mediaUrl, { maxBytes, timeoutMs = 60_000 } = {}) {
      let u;
      try {
        u = new URL(String(mediaUrl), base);
      } catch {
        throw new WahaError('媒体地址不合法');
      }
      if (!u.pathname.startsWith('/api/files/')) throw new WahaError(`媒体地址不是 WAHA 的 /api/files/ 路径：${u.pathname}`);
      const res = await request('GET', `${u.pathname}${u.search}`, { accept: '*/*', raw: true, timeoutMs });
      const buffer = await readLimited(res, maxBytes);
      return { buffer, mime: String(res.headers.get('content-type') || '').split(';')[0].trim() };
    },
    /** GET /api/{session}/lids/{lid} → {lid, pn}；返回纯数字手机号或 null */
    async lidToNumber(session, lid) {
      const data = await request('GET', `/api/${enc(session)}/lids/${enc(lid)}`, { timeoutMs: 5000 });
      const pn = data?.pn;
      if (typeof pn !== 'string' || !pn) return null;
      const digits = pn.split('@')[0].replace(/\D+/g, '');
      return digits || null;
    },
  };
}

/** 读响应体，超过 maxBytes 就中止并抛错（先看 content-length，再边读边数） */
export async function readLimited(res, maxBytes) {
  const limit = maxBytes ?? Infinity;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new TooLargeError(declared, limit);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) {
      throw new TooLargeError(total, limit);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class TooLargeError extends Error {
  constructor(size, limit) {
    super(`文件太大（超过 ${Math.round(limit / 1024 / 1024)}MB）`);
    this.size = size;
    this.limit = limit;
  }
}

/** WAHA 会话状态 → 本系统 state */
export function mapWahaStatus(status) {
  switch (status) {
    case 'STOPPED':
      return { state: 'stopped', error: null };
    case 'STARTING':
      return { state: 'starting', error: null };
    case 'SCAN_QR_CODE':
      return { state: 'scan_qr', error: null };
    case 'WORKING':
      return { state: 'working', error: null };
    case 'FAILED':
      return { state: 'failed', error: 'WAHA 会话失败（FAILED），请重新连接' };
    case 'PASSKEY_REQUIRED':
    case 'PASSKEY_CONFIRMATION_REQUIRED':
      return { state: 'failed', error: `WAHA 状态 ${status}：需要在手机上确认通行密钥后再重新连接` };
    default:
      return { state: 'failed', error: `未知的 WAHA 状态：${status}` };
  }
}
