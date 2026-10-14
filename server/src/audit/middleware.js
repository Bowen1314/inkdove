// 操作日志的中间件：挂在 /api 路由的最前面（express.json 之后、要求登录之前），所以登录、接受邀请这些不用登录的接口也经过它。
// 按方法和路径在 audit/actions.js 里找规则；要记的，先在接口执行前读出改之前的对象，再包一层 res.json（拿返回的名字、个数，
// 不存）和 res.end（响应发出去之前同步写一行日志）。
// - 操作人是 requireAuth 填的 req.user；没登录的请求（401）不记，登录和接受邀请由规则给出操作人；
// - 成功失败都记：状态码 < 400 算成功，失败记状态码和接口返回的错误信息（越权 403、校验不过 400 也记）；
// - 写日志出任何错都只打一行警告，绝不影响接口本身的状态码和返回内容；
// - 不存请求体、查询参数、返回内容，也不存完整的地址；User-Agent 只存认出来的设备（「Chrome 130 · Windows 电脑」这样），不存原文。
import { scrubUrls, clipText } from './diff.js';
import { matchRule } from './actions.js';
import { describeDevice } from './device.js';

/** 失败原因：接口返回的 error（网址去掉令牌，截短）；没有的用状态码 */
function errorOf(body, status) {
  const msg = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  return clipText(scrubUrls(msg) || `HTTP ${status}`, 200);
}

/**
 * @param {any} ctx 要有 ctx.audit（audit/store.js）
 * @param {any} auth createAuth 的返回值（改自己资料时在要求登录之前找出是谁；登录失败时按邮箱找人）
 */
export function auditMiddleware(ctx, auth) {
  return function audit(req, res, next) {
    // 进来时 /api 后面那段；出错时 Express 会把 req.url 改回完整地址，所以先记下来
    const path = req.path;
    let hit = null;
    try {
      hit = matchRule(req.method, path);
    } catch (err) {
      ctx.log.warn(`[audit] 匹配操作日志规则出错：${err?.message || err}`);
    }
    if (!hit || hit.rule.skip) return next();
    const { rule, params } = hit;

    let before;
    if (rule.before) {
      try {
        before = rule.before({ ctx, auth, req, path, params });
      } catch (err) {
        ctx.log.warn(`[audit] 读取改动前的数据出错（${rule.a}）：${err?.message || err}`);
      }
    }

    let body;
    const json = res.json;
    res.json = function auditJson(b) {
      body = b;
      return json.call(this, b);
    };

    let done = false;
    const end = res.end;
    res.end = function auditEnd(...args) {
      if (!done) {
        done = true;
        try {
          write(args[0]);
        } catch (err) {
          ctx.log.warn(`[audit] 写操作日志出错（${rule.a}）：${err?.message || err}`);
        }
      }
      return end.apply(this, args);
    };

    function write(chunk) {
      const status = res.statusCode;
      const ok = status < 400;
      if (!rule.anonymous && !req.user) return; // 没登录（401）的不记
      // 导出接口返回的是文件：只拿来数行数，不存
      let text = '';
      if (ok && rule.m === 'GET' && chunk != null) text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const r = rule.run({ ctx, auth, req, path, params, before, body, text, ok, status });
      if (!r) return;
      const actor = r.actor !== undefined ? r.actor : req.user;
      if (!actor) return;
      ctx.audit.record({
        actor: { id: actor.id ?? null, name: actor.name ?? '', email: actor.email ?? '', role: actor.role ?? null },
        action: rule.a,
        summary: String(r.summary || rule.a).replaceAll('{了}', ok ? '了' : ''),
        target: r.target || null,
        changes: r.changes || [],
        ok,
        status,
        error: ok ? null : errorOf(body, status),
        ip: req.ip || req.socket?.remoteAddress || null,
        device: describeDevice(req.get('user-agent')),
      });
    }

    next();
  };
}
