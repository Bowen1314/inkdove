// 让全局 fetch 用 Node 自带的连接（dispatcher），不用 npm 里的 undici 7.30。必须是 app.js 的第一个 import（ESM 按 import 的顺序执行模块）。
//
// 为什么：npm undici 一加载（lib/global.js）就把自己的 Agent 设成全局 dispatcher——前提是那时还没有；Node 自带的 fetch
// 要等第一次调用才装自己的 Agent。app.js 经 wa/proxy-test.js 和 sources/parse.js（cheerio）都会加载 npm undici，不处理的话，
// 调模型、发邮件、检查更新、调 WAHA / Meta、抓网址这些 fetch 收发全走 undici 7.30。它有个会让整个进程崩掉的 bug
// （读得慢、解析器暂停时对方关连接，assert(!this.paused) 失败，详见 wa/media-download.js 开头）。
// 这里抢先调一次 fetch（data: 地址，不走网络），让 Node 自带的 Agent 先占住全局 dispatcher，之后 npm undici 加载时看到已经有了就不再替换。
// fetch 函数本身一直是 Node 自带的，变的只是底下的连接。proxy-test.js 用 npm undici 自己的 fetch 和 ProxyAgent，不受影响。
// 测试：不少测试文件在导入 app.js 之前就导入了会带进 cheerio / undici 的模块，所以 package.json 的 test 脚本用
// node --import ./src/builtin-fetch.js 让每个测试进程最先加载这个文件，和正式环境一致。
fetch('data:,').catch(() => {});

/**
 * 上面那次调用装好的 Node 自带 Agent（全局 dispatcher）。全局代理（proxy/route.js）开启时用它直连、用它的类建走代理的 Agent，
 * 关掉时把它原样放回去。
 */
export const builtinDispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
