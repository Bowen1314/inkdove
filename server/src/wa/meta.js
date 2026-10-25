// Meta WhatsApp Cloud API。
// 发文本：POST {graph}/{Version}/{Phone-Number-ID}/messages
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
// 标已读：同一地址，{messaging_product, status:"read", message_id}
//   https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read
// 正在输入：在标已读的请求里加 typing_indicator:{type:"text"}；回复后或 25 秒后消失，没有单独的停止接口
//   https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators

// 发文件（F15）：先 POST {graph}/{Version}/{Phone-Number-ID}/media（multipart：messaging_product、file、type）拿 media id，
//   再发 {type:"image", image:{id}} 或 {type:"document", document:{id, filename}}。上传的 media id 30 天有效，本系统缓存 25 天
//   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/document-messages
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/image-messages
// 下载入站媒体（F4）：GET {graph}/{Version}/{media-id} → {url, mime_type, file_size}，再带同一个 token GET 那个 url（5 分钟有效）
// 下载媒体文件本身用 media-download.js 的 httpGet（node:http），不用 fetch，原因见那个文件开头的注释；查 url 的小 JSON 还用 fetch
import { httpGet, HttpGetError } from './media-download.js';
import { readLimited, TooLargeError } from './waha.js';

export class MetaError extends Error {}

const graphUrl = (graphBase, meta, ...segs) =>
  `${graphBase}/${encodeURIComponent(meta.apiVersion)}/${segs.map((x) => encodeURIComponent(x)).join('/')}`;

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new MetaError(`Meta 返回 ${res.status}：${data?.error?.message || text.slice(0, 200)}`);
  return data;
}

async function metaFetch(url, init, timeoutMs = 20_000) {
  const { signal, ...rest } = init || {};
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch (err) {
    throw new MetaError(`无法连接 Meta Graph API：${err?.cause?.code || err?.message || err}`);
  }
}

async function post(graphBase, meta, body) {
  if (!meta.phoneNumberId || !meta.accessToken) throw new MetaError('Meta 通道未配置 phoneNumberId 或 accessToken');
  const url = `${graphBase}/${encodeURIComponent(meta.apiVersion)}/${encodeURIComponent(meta.phoneNumberId)}/messages`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${meta.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new MetaError(`无法连接 Meta Graph API：${err?.cause?.code || err?.message || err}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new MetaError(`Meta 返回 ${res.status}：${data?.error?.message || text.slice(0, 200)}`);
  return data;
}

/**
 * @param {string} graphBase 默认 https://graph.facebook.com（测试可用 INKDOVE_META_GRAPH_URL 覆盖）
 * @param {{phoneNumberId:string, apiVersion:string, accessToken:string}} meta
 * @param {string} to 纯数字号码（wa_id）
 * @param {string} text
 * @returns {Promise<string|null>} 消息 id（wamid）
 */
export async function metaSendText(graphBase, meta, to, text) {
  const data = await post(graphBase, meta, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  });
  return data?.messages?.[0]?.id ?? null;
}

/**
 * F11：发审核通过的模板消息（主动发起会话只能用模板）。只带模板名和语言，不带 components，所以只支持没有变量的模板。
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
 * @param {{name:string, languageCode:string}} template
 * @returns {Promise<string|null>} 消息 id（wamid）
 */
export async function metaSendTemplate(graphBase, meta, to, template) {
  if (!template?.name || !template?.languageCode) throw new MetaError('未填写 Meta 模板名称或语言');
  const data = await post(graphBase, meta, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: template.name, language: { code: template.languageCode } },
  });
  return data?.messages?.[0]?.id ?? null;
}

/**
 * 标已读；typing=true 时同时显示"正在输入"。
 * @param {string} messageId 入站消息的 wamid
 */
export async function metaMarkRead(graphBase, meta, messageId, { typing = false } = {}) {
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
  if (typing) body.typing_indicator = { type: 'text' };
  await post(graphBase, meta, body);
}

/**
 * F15：上传媒体，返回 media id。
 * @param {{buffer:Buffer, mime:string, filename:string}} file
 */
export async function metaUploadMedia(graphBase, meta, file) {
  if (!meta.phoneNumberId || !meta.accessToken) throw new MetaError('Meta 通道未配置 phoneNumberId 或 accessToken');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', file.mime);
  form.append('file', new Blob([file.buffer], { type: file.mime }), file.filename);
  const res = await metaFetch(
    graphUrl(graphBase, meta, meta.phoneNumberId, 'media'),
    { method: 'POST', headers: { authorization: `Bearer ${meta.accessToken}` }, body: form },
    120_000,
  );
  const data = await readJson(res);
  if (!data?.id) throw new MetaError('Meta 媒体上传未返回 id');
  return String(data.id);
}

/**
 * F15：发图片或文档消息，返回 wamid。
 * @param {{kind:'image'|'document', mediaId:string, filename?:string, caption?:string}} m
 */
export async function metaSendMedia(graphBase, meta, to, m) {
  const media = { id: m.mediaId };
  if (m.kind === 'document' && m.filename) media.filename = m.filename;
  if (m.caption) media.caption = m.caption;
  const data = await post(graphBase, meta, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: m.kind,
    [m.kind]: media,
  });
  return data?.messages?.[0]?.id ?? null;
}

/**
 * 入站媒体：先 GET /{media-id} 查 url 和 file_size，再带同一个 token 下载（url 5 分钟有效）。
 * file_size 超过 maxBytes 时不下载，直接抛 TooLargeError（size 是 Meta 给的大小）。
 * res 是 node:http 的 IncomingMessage（带 headers），状态码已检查过；重定向到别的主机时不带 token。
 * @returns {Promise<{res:import('node:http').IncomingMessage, mime:string, size:number|null}>}
 */
export async function metaOpenMedia(graphBase, meta, mediaId, { maxBytes, timeoutMs = 60_000, signal } = {}) {
  if (!meta.accessToken) throw new MetaError('Meta 通道未配置 accessToken');
  const auth = { authorization: `Bearer ${meta.accessToken}` };
  const info = await readJson(await metaFetch(graphUrl(graphBase, meta, mediaId), { headers: auth, signal }));
  if (!info?.url) throw new MetaError('Meta 未返回媒体下载地址');
  const size = Number(info.file_size);
  const known = info.file_size != null && Number.isFinite(size) && size >= 0;
  if (maxBytes && known && size > maxBytes) throw new TooLargeError(size, maxBytes);
  let res;
  try {
    ({ stream: res } = await httpGet(String(info.url), { headers: auth, timeoutMs, signal }));
  } catch (err) {
    if (!(err instanceof HttpGetError)) throw err; // 被中止（服务关闭）
    if (err.status) throw new MetaError(`下载媒体失败：Meta 返回 ${err.status}`);
    throw new MetaError(`无法连接 Meta Graph API：${err.message}`);
  }
  const mime = String(info.mime_type || res.headers['content-type'] || '').split(';')[0].trim();
  return { res, mime, size: known ? size : null };
}

/**
 * F4：下载入站媒体：先查 url，再带 token 下载。
 * @returns {Promise<{buffer:Buffer, mime:string}>}
 */
export async function metaDownloadMedia(graphBase, meta, mediaId, { maxBytes } = {}) {
  let opened;
  try {
    opened = await metaOpenMedia(graphBase, meta, mediaId, { maxBytes });
  } catch (err) {
    // 保持原来的报错（MetaError「文件太大（超过 xMB）」）
    if (err instanceof TooLargeError) throw new MetaError(err.message);
    throw err;
  }
  const buffer = await readLimited(opened.res, maxBytes);
  return { buffer, mime: opened.mime };
}
