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
import { readLimited } from './waha.js';

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
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new MetaError(`连不上 Meta Graph API：${err?.cause?.code || err?.message || err}`);
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
    throw new MetaError(`连不上 Meta Graph API：${err?.cause?.code || err?.message || err}`);
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
 * @param {string} graphBase 默认 https://graph.facebook.com（测试可用 KBWA_META_GRAPH_URL 覆盖）
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
  if (!data?.id) throw new MetaError('Meta 上传媒体没有返回 id');
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
 * F4：下载入站媒体：先查 url，再带 token 下载。
 * @returns {Promise<{buffer:Buffer, mime:string}>}
 */
export async function metaDownloadMedia(graphBase, meta, mediaId, { maxBytes } = {}) {
  if (!meta.accessToken) throw new MetaError('Meta 通道未配置 accessToken');
  const auth = { authorization: `Bearer ${meta.accessToken}` };
  const info = await readJson(await metaFetch(graphUrl(graphBase, meta, mediaId), { headers: auth }));
  if (!info?.url) throw new MetaError('Meta 没有返回媒体下载地址');
  if (maxBytes && Number(info.file_size) > maxBytes) {
    throw new MetaError(`文件太大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
  }
  const res = await metaFetch(String(info.url), { headers: auth }, 60_000);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new MetaError(`下载媒体失败：Meta 返回 ${res.status}`);
  }
  const buffer = await readLimited(res, maxBytes);
  return { buffer, mime: String(info.mime_type || res.headers.get('content-type') || '').split(';')[0].trim() };
}
