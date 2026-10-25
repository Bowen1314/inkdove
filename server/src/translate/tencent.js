// 腾讯云机器翻译 TextTranslate（API 3.0，域名 tmt.tencentcloudapi.com，Version 2018-03-21）。
// 注意：官方已宣布文本翻译下线、不再接受新用户；2026-10-01 起不再发免费资源包，QPS 逐月缩减，2027-10-01 起接口全部不能用
// （https://cloud.tencent.com/document/product/551/104415、https://cloud.tencent.cn/announce/detail/2448）。这里留着给已经开通的老用户。
// - POST /，JSON {SourceText, Source:'auto', Target, ProjectId:0}，返回 Response.{TargetText, Source}；出错时 HTTP 仍是 200，
//   错误在 Response.Error.{Code, Message}；
// - 签名 TC3-HMAC-SHA256（https://cloud.tencent.com/document/api/213/30654）：签 content-type;host;x-tc-action 三个头，
//   x-tc-action 的值转小写；时间戳和服务器差 5 分钟以上会报 AuthFailure.SignatureExpire；
// - 语言检测接口（LanguageDetect）同样在下线名单里，这里不用，靠 Source=auto 时返回的 Source 判断。
// 中文能译成的语言（旧版 SDK 注释里的语言对表）：英日韩法西意德土俄葡越印尼泰马来阿拉伯；印地语只能从英语译，这里不算。
import crypto from 'node:crypto';
import { badResponse, detailOf, httpError, request, TranslateError, trimSlash, visibleAscii } from './common.js';
import { normalizeLang } from './languages.js';

const LABEL = '腾讯云翻译';
const SERVICE = 'tmt';
const BASE = 'https://tmt.tencentcloudapi.com';
const ACTION = 'TextTranslate';
const VERSION = '2018-03-21';
const CONTENT_TYPE = 'application/json; charset=utf-8';

const TARGETS = new Set('zh en ja ko fr es it de tr ru pt vi id th ms ar'.split(' '));

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();

/**
 * 规范请求串（CanonicalRequest）。
 * @param {{method?:string, query?:string, contentType:string, host:string, action:string, payload:string}} p
 */
export function tc3CanonicalRequest({ method = 'POST', query = '', contentType, host, action, payload }) {
  const headers = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  return [method, '/', query, headers, 'content-type;host;x-tc-action', sha256Hex(payload)].join('\n');
}

/**
 * 待签名字符串（StringToSign）。日期是时间戳对应的 UTC 日期。
 * @param {{timestamp:number, service:string, canonicalRequest:string}} p
 */
export function tc3StringToSign({ timestamp, service, canonicalRequest }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  return ['TC3-HMAC-SHA256', String(timestamp), `${date}/${service}/tc3_request`, sha256Hex(canonicalRequest)].join('\n');
}

/** 从 SecretDate 往下派生 SecretSigning（官方示例给了 SecretDate，可以从这一步开始核对） */
export const tc3KeyFromDateKey = (secretDate, service) => hmac(hmac(secretDate, service), 'tc3_request');
/** SecretKey → SecretSigning */
export const tc3SigningKey = (secretKey, date, service) => tc3KeyFromDateKey(hmac(`TC3${secretKey}`, date), service);
/** 签名：HMAC-SHA256(SecretSigning, StringToSign) 的小写十六进制 */
export const tc3Signature = (signingKey, stringToSign) => crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

/**
 * 整套签名，返回 Authorization 头。
 * @param {{secretId:string, secretKey:string, service:string, host:string, action:string, payload:string, timestamp:number, contentType?:string}} p
 */
export function tc3Authorization({ secretId, secretKey, service, host, action, payload, timestamp, contentType = CONTENT_TYPE }) {
  const canonicalRequest = tc3CanonicalRequest({ contentType, host, action, payload });
  const stringToSign = tc3StringToSign({ timestamp, service, canonicalRequest });
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signature = tc3Signature(tc3SigningKey(secretKey, date, service), stringToSign);
  return `TC3-HMAC-SHA256 Credential=${secretId}/${date}/${service}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;
}

/** 按腾讯云的错误码分类 */
function tencentError(code, message, redactOpts) {
  const detail = detailOf(message, redactOpts);
  const what = `${code}${detail ? `：${detail}` : ''}`;
  if (code === 'ActionOffline' || code === 'UnauthorizedOperation.ActionNotFound') {
    return new TranslateError(`腾讯云文本翻译接口已下线（${what}），请更换翻译服务`, 'config');
  }
  if (code === 'FailedOperation.UserNotRegistered') {
    return new TranslateError(`腾讯云机器翻译未开通（${what}）。官方已停止受理文本翻译新用户，请更换翻译服务`, 'auth');
  }
  if (code.startsWith('AuthFailure')) return new TranslateError(`腾讯云翻译鉴权失败（${what}）。请检查 SecretId 和 SecretKey`, 'auth');
  if (code.startsWith('RequestLimitExceeded')) return new TranslateError(`腾讯云翻译请求过于频繁，已限流（${what}）`, 'rate_limit');
  if (/^FailedOperation\.(NoFreeAmount|ServiceIsolate|StopUsing)$/.test(code) || code === 'LimitExceeded') {
    return new TranslateError(`腾讯云翻译额度已用尽或服务已停用（${what}）`, 'quota');
  }
  if (/^UnsupportedOperation\.Unsupported/i.test(code)) return new TranslateError(`腾讯云翻译不支持该语言（${what}）`, 'unsupported_language');
  if (code.startsWith('InternalError')) return new TranslateError(`腾讯云翻译服务异常（${what}）`, 'server');
  return new TranslateError(`腾讯云翻译返回错误（${what}）`, 'bad_request');
}

export default {
  id: 'tencent',
  label: LABEL,
  fields: [
    { key: 'secretId', type: 'secret', required: true, max: 200 },
    { key: 'secretKey', type: 'secret', required: true, max: 200 },
    { key: 'region', type: 'text', required: true, max: 50, pattern: /^[a-z]{2,4}-[a-z0-9-]{2,40}$/, default: 'ap-guangzhou' },
  ],
  targets: TARGETS,

  async translate(cfg, { text, source, target }, o = {}) {
    const secretId = String(cfg.secretId || '').trim();
    const secretKey = String(cfg.secretKey || '').trim();
    const region = String(cfg.region || '').trim();
    if (!secretId || !secretKey) throw new TranslateError('腾讯云翻译未填写 SecretId 和 SecretKey', 'config');
    if (!visibleAscii(secretId) || !visibleAscii(secretKey)) {
      throw new TranslateError('腾讯云翻译的 SecretId 或 SecretKey 包含空格、中文或其他非法字符，请检查后重新输入', 'config');
    }
    if (!region) throw new TranslateError('腾讯云翻译未填写区域', 'config');
    const redactOpts = { secrets: [secretId, secretKey] };
    const base = trimSlash(o.endpoint || BASE);
    let host;
    try {
      host = new URL(base).host;
    } catch {
      throw new TranslateError('腾讯云翻译地址格式错误', 'config');
    }
    const payload = JSON.stringify({
      SourceText: text,
      Source: source && source !== 'auto' ? source : 'auto',
      Target: target,
      ProjectId: 0,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await request({
      label: LABEL,
      url: `${base}/`,
      headers: {
        authorization: tc3Authorization({ secretId, secretKey, service: SERVICE, host, action: ACTION, payload, timestamp }),
        'content-type': CONTENT_TYPE,
        // Host 头由 fetch 按地址自动带上，和签名里用的 host 一致
        'x-tc-action': ACTION,
        'x-tc-timestamp': String(timestamp),
        'x-tc-version': VERSION,
        'x-tc-region': region,
      },
      body: payload,
      timeoutMs: o.timeoutMs,
      redactOpts,
      onAttempt: o.onAttempt,
    });
    const r = res.data?.Response;
    const err = r?.Error;
    if (err && typeof err.Code === 'string') throw tencentError(err.Code, err.Message, redactOpts);
    if (!res.ok) throw httpError(LABEL, res, redactOpts);
    if (typeof r?.TargetText !== 'string') throw badResponse(LABEL, '缺少 Response.TargetText');
    return { text: r.TargetText, detectedSource: normalizeLang(r.Source) };
  },
};
