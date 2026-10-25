// 火山引擎机器翻译（https://docs.volcengine.com/docs/MachineTranslation/TextTranslationAPI）：
// - POST https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01，JSON {TargetLanguage, TextList:[...], SourceLanguage?}，
//   返回 TranslationList[{Translation, DetectedSourceLanguage}]（不给源语言时才有 DetectedSourceLanguage）；
// - 语种检测 Action=LangDetect，JSON {TextList}，返回 DetectedLanguageList[{Language, Confidence}]；
// - Region cn-north-1，Service translate；出错时错误在 ResponseMetadata.Error.{Code, Message}：
//   -415 不支持的语向，-429 太频繁，-400 参数不对，-500 服务出错；1000xx 是网关错误（100009 AK 不对、100010 签名不对、
//   100013 子用户没权限、100018 限流……，https://docs.volcengine.com/docs/MachineTranslation/Interfaceerrormessage）；
// - 签名 HMAC-SHA256（https://docs.volcengine.com/docs/APISignatureCallGuide/Signaturemethod-9）：规范请求 → 待签名字符串 →
//   kDate = HMAC(SK, 日期)、kRegion、kService、kSigning = HMAC(kService, "request") → 签名。官方示例只签 host 和 x-date
//   两个头（请求体的哈希本来就在规范请求里），这里也只签这两个；
// - 每月前 200 万字符免费，超出按 49 元 / 百万字符日结后付费，没有「用完就停」的开关（https://docs.volcengine.com/docs/MachineTranslation/Productbilling）。
import crypto from 'node:crypto';
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { normalizeLang } from './languages.js';

const LABEL = '火山翻译';
const BASE = 'https://translate.volcengineapi.com';
const REGION = 'cn-north-1';
const SERVICE = 'translate';
const VERSION = '2020-06-01';

/** 语言支持页的文本翻译语种（只能译成中文的藏语、粤语、维吾尔语等不算） */
const TARGETS = new Set(
  (
    'zh tn vi iu it id hi en ho he es el uk ur tk tr ti ty tl to th ta te sl sk ss eo sm sg st sv ja tw qu pt pa no nr my bn mn mh mk ml ' +
    'mr ms lu ro lt lv lo kj hr kn ki cs ca nl ko ht gu ka kl km lg kg fi fj fr ru ng de tt da ts cv fa bs pl bi nd ba bg az ar af sq ab os ' +
    'ee et ay am cy gl ha hy ig ln ny om sn so sr sw xh yo zu hu rw wo'
  ).split(' '),
);

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();

/** 查询串按 RFC3986 编码、按名字排序 */
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const volcQuery = (query) =>
  Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k])}`)
    .join('&');

/** kSigning */
export const volcSigningKey = (secretAccessKey, date, region, service) => hmac(hmac(hmac(hmac(secretAccessKey, date), region), service), 'request');

/**
 * 火山引擎的签名。signedHeaders 是要签的头（小写名 → 值，按给的顺序），至少要有 host 和 x-date。
 * @param {{accessKeyId:string, secretAccessKey:string, region:string, service:string, method:string, path?:string,
 *   query:Record<string,string>, signedHeaders:[string,string][], body:string, xDate:string}} p
 * @returns {{canonicalRequest:string, stringToSign:string, signature:string, authorization:string}}
 */
export function volcSign({ accessKeyId, secretAccessKey, region, service, method, path = '/', query, signedHeaders, body, xDate }) {
  const names = signedHeaders.map(([k]) => k.toLowerCase());
  const canonicalHeaders = signedHeaders.map(([k, v]) => `${k.toLowerCase()}:${String(v).trim()}\n`).join('');
  const canonicalRequest = [method, path, volcQuery(query), canonicalHeaders, names.join(';'), sha256Hex(body)].join('\n');
  const date = xDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', volcSigningKey(secretAccessKey, date, region, service)).update(stringToSign, 'utf8').digest('hex');
  return {
    canonicalRequest,
    stringToSign,
    signature,
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** X-Date：UTC，YYYYMMDD'T'HHMMSS'Z' */
const xDateOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** 按火山的错误码分类（Code 可能是 "-415" 这样的数字串，也可能是 "SignatureDoesNotMatch" 这样的名字，CodeN 是数字） */
function volcError(err, redactOpts, status) {
  const code = String(err?.Code ?? '');
  const n = Number.isFinite(Number(err?.CodeN)) ? Number(err.CodeN) : Number(code);
  const detail = detailOf(err?.Message, redactOpts);
  const what = `${code || n}${detail ? `：${detail}` : ''}`;
  if (n === -415) return new TranslateError(`火山翻译不支持该语向（${what}）`, 'unsupported_language', { status });
  if (n === -429 || n === 100018 || code === 'FlowLimitExceeded') return new TranslateError(`火山翻译请求过于频繁，已限流（${what}）`, 'rate_limit', { status });
  if (n === 100012 || n === 100013 || /^(LackPolicy|AccessDenied)$/.test(code)) {
    return new TranslateError(`火山翻译拒绝该密钥（${what}）。子账号需在访问控制中授予机器翻译权限`, 'auth', { status });
  }
  if ((n >= 100003 && n <= 100006) || n === 100009 || n === 100010 || /Signature|AccessKey|ClientTokenId|Authentication|Timestamp/i.test(code)) {
    return new TranslateError(`火山翻译鉴权失败（${what}）。请检查 Access Key ID 和 Secret Access Key`, 'auth', { status });
  }
  if (n === -500 || (n >= 100014 && n <= 100016) || n === 100019 || n === 100001) return new TranslateError(`火山翻译服务异常（${what}）`, 'server', { status });
  return new TranslateError(`火山翻译返回错误（${what}）`, 'bad_request', { status });
}

function check(cfg) {
  const accessKeyId = String(cfg.accessKeyId || '').trim();
  const secretAccessKey = String(cfg.secretAccessKey || '').trim();
  if (!accessKeyId || !secretAccessKey) throw new TranslateError('火山翻译未填写 Access Key ID 和 Secret Access Key', 'config');
  if (!visibleAscii(accessKeyId) || !visibleAscii(secretAccessKey)) {
    throw new TranslateError('火山翻译的 Access Key ID 或 Secret Access Key 包含空格、中文或其他非法字符，请检查后重新输入', 'config');
  }
  return { accessKeyId, secretAccessKey };
}

/** 发一个签好名的请求，返回解析好的 JSON（已经按错误码抛过错） */
async function call(cfg, action, payload, o) {
  const c = check(cfg);
  const redactOpts = { secrets: [c.accessKeyId, c.secretAccessKey] };
  const base = trimSlash(o.endpoint || BASE);
  let host;
  try {
    host = new URL(base).host;
  } catch {
    throw new TranslateError('火山翻译地址格式错误', 'config');
  }
  const query = { Action: action, Version: VERSION };
  const body = JSON.stringify(payload);
  const xDate = xDateOf();
  const { authorization } = volcSign({
    ...c,
    region: REGION,
    service: SERVICE,
    method: 'POST',
    query,
    signedHeaders: [
      ['host', host],
      ['x-date', xDate],
    ],
    body,
    xDate,
  });
  const res = await request({
    label: LABEL,
    url: `${base}/?${volcQuery(query)}`,
    // Host 头由 fetch 按地址自动带上，和签名里用的 host 一致
    headers: { 'content-type': 'application/json', 'x-date': xDate, authorization },
    body,
    timeoutMs: o.timeoutMs,
    redactOpts,
    onAttempt: o.onAttempt,
  });
  const err = res.data?.ResponseMetadata?.Error;
  if (err && (err.Code !== undefined || err.CodeN !== undefined)) throw volcError(err, redactOpts, res.status);
  if (!res.ok) throw httpError(LABEL, res, redactOpts);
  if (!res.data) throw badResponse(LABEL, '非 JSON');
  return res.data;
}

export default {
  id: 'volcengine',
  label: LABEL,
  fields: [
    { key: 'accessKeyId', type: 'secret', required: true, max: 200 },
    { key: 'secretAccessKey', type: 'secret', required: true, max: 200 },
  ],
  targets: TARGETS,

  async translate(cfg, { text, source, target }, o = {}) {
    const payload = { TargetLanguage: target, TextList: [text] };
    if (source && source !== 'auto') payload.SourceLanguage = source;
    const data = await call(cfg, 'TranslateText', payload, o);
    const t = data.TranslationList?.[0];
    if (typeof t?.Translation !== 'string') throw badResponse(LABEL, '缺少 TranslationList[0].Translation');
    return { text: t.Translation, detectedSource: normalizeLang(t.DetectedSourceLanguage) };
  },

  async detect(cfg, text, o = {}) {
    const data = await call(cfg, 'LangDetect', { TextList: [text] }, o);
    const list = data.DetectedLanguageList;
    if (!Array.isArray(list)) throw badResponse(LABEL, '缺少 DetectedLanguageList');
    return normalizeLang(list[0]?.Language);
  },
};
