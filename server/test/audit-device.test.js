// 操作日志的「设备」：从 User-Agent 认出浏览器和系统（audit/device.js）。只出短说明，不出原文；最多 60 个字。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEVICE_MAX, describeDevice } from '../src/audit/device.js';

const len = (s) => [...s].length;

describe('describeDevice', () => {
  const cases = [
    [
      'Chrome · Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome 130 · Windows 电脑',
    ],
    [
      'Edge · Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
      'Edge 130 · Windows 电脑',
    ],
    [
      'Edge · Android',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0',
      'Edge 130 · Android 手机',
    ],
    ['Firefox · Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox 131 · Mac 电脑'],
    [
      'Safari · Mac',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari 18 · Mac 电脑',
    ],
    [
      'Safari · iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      'Safari 17 · iPhone',
    ],
    [
      'Safari · iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      'Safari 17 · iPad',
    ],
    [
      'iPhone 上的 Chrome（CriOS）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
      'Chrome 130 · iPhone',
    ],
    [
      'iPhone 上的 Firefox（FxiOS）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
      'Firefox 131 · iPhone',
    ],
    [
      'Chrome · Android 手机',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome 130 · Android 手机',
    ],
    [
      'Chrome · Android 平板（没有 Mobile）',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome 130 · Android 平板',
    ],
    [
      'Samsung Internet',
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
      'Samsung Internet 26 · Android 手机',
    ],
    [
      'Android 上的微信',
      'Mozilla/5.0 (Linux; Android 13; V2148A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20231202 MMWEBID/2247 MicroMessenger/8.0.47.2560(0x28002F30) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
      '微信 · Android 手机',
    ],
    [
      'iPhone 上的微信',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI Language/zh_CN',
      '微信 · iPhone',
    ],
    [
      'Opera · Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      'Opera 114 · Windows 电脑',
    ],
    [
      'Chrome · ChromeOS',
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome 130 · ChromeOS 电脑',
    ],
    ['Firefox · Linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox 131 · Linux 电脑'],
    [
      '只认出系统（App 里的网页）',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0',
      'iPhone',
    ],
    ['curl', 'curl/8.4.0', 'curl 8.4.0'],
    ['python-requests', 'python-requests/2.32.3', 'python-requests 2.32.3'],
    ['Postman', 'PostmanRuntime/7.42.0', 'PostmanRuntime 7.42.0'],
    ['Go', 'Go-http-client/1.1', 'Go-http-client 1.1'],
    ['Java', 'Apache-HttpClient/4.5.14 (Java/17.0.12)', 'Apache-HttpClient 4.5.14'],
    ['爬虫：跳过开头的 Mozilla/5.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot 2.1'],
    ['Node 自带的 fetch', 'node', 'node'],
    ['认不出的取第一段', 'some garbage here', 'some'],
  ];
  for (const [name, ua, want] of cases) {
    it(name, () => {
      assert.equal(describeDevice(ua), want);
    });
  }

  it('没有 User-Agent 时为 null', () => {
    for (const ua of [undefined, null, '', '   ', '\t']) assert.equal(describeDevice(ua), null, JSON.stringify(ua));
  });

  it('很长的 User-Agent 截到 60 个字以内，不出原文', () => {
    const outs = [
      describeDevice('x'.repeat(5000)),
      describeDevice(`${'z'.repeat(300)}/1.0`),
      describeDevice(`curl/${'9'.repeat(400)}`),
      describeDevice(`${'长'.repeat(200)} 后面`),
    ];
    for (const out of outs) {
      assert.ok(out && len(out) <= DEVICE_MAX, out);
      assert.ok(out.endsWith('…'), out);
    }
    // 认出来的浏览器后面跟一大串也不受影响
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 ${'junk/1.0 '.repeat(300)}`;
    assert.equal(describeDevice(ua), 'Chrome 130 · Windows 电脑');
  });

  it('浏览器的说明里没有 User-Agent 原文的片段', () => {
    for (const [, ua] of cases.slice(0, 18)) {
      const out = describeDevice(ua);
      assert.ok(!/Mozilla|AppleWebKit|KHTML|Gecko/.test(out), out);
    }
  });
});
