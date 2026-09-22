/**
 * 飞书 JSAPI 鉴权层（js/feishu-jsapi.js）的回归测试。
 *
 * 为什么值得单独写一份：
 *   端内扫码（`tt.scanCode`）是**要鉴权**的 JSAPI，而鉴权这一步在本地和 CI 里
 *   根本跑不到 —— 它只在飞书客户端里发生。真实踩过的坑是：签名里的 timestamp
 *   写成了秒级（10 位），服务端照常返回、签名长度也对，唯独客户端鉴权必然失败，
 *   表现是「电脑浏览器里扫码好好的，飞书里点了没反应」。这种缺陷只能靠
 *   把真实脚本放进假环境里跑一遍才能钉住。
 *
 * 这个测试不联网、不开浏览器：vm + 假的 window / h5sdk / fetch。
 *
 * 运行：node feishu/test/feishu-jsapi.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = process.env.FEVER_JSAPI_SRC
  ? path.resolve(process.env.FEVER_JSAPI_SRC)
  : path.join(__dirname, '..', 'js', 'feishu-jsapi.js');
const CODE = fs.readFileSync(SOURCE, 'utf8');

let passed = 0;
let failed = 0;

function check(label, condition, extra) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}

/* ==================== 假环境 ==================== */

/** 假的 h5sdk：把 config 收到的参数记下来，由测试决定是成功还是失败 */
function createH5sdk(options) {
  const sdk = {
    configCalls: [],
    readyCalls: 0,
    /** 手动放行 ready（模拟器里 h5sdk 内部就绪的时刻） */
    fireReady: function () {
      sdk._readyCallbacks.forEach(function (fn) { fn(); });
      sdk._readyCallbacks = [];
    },
    _readyCallbacks: [],
    ready: function (fn) {
      sdk.readyCalls += 1;
      sdk._readyCallbacks.push(fn);
      if (options && options.autoReady) {
        Promise.resolve().then(function () { sdk.fireReady(); });
      }
    },
    config: function (args) {
      sdk.configCalls.push(args);
      Promise.resolve().then(function () {
        if (options && options.failWith) {
          args.onFail({ errMsg: options.failWith });
        } else {
          args.onSuccess();
        }
      });
    }
  };
  return sdk;
}

/** 假的登录层：feishu-jsapi.js 只认 FEVER.Auth.ready 和 FEVER.Auth.token */
function createAuth(token, rejectWith) {
  return {
    token: token || '',
    ready: rejectWith
      ? Promise.reject(new Error(rejectWith))
      : Promise.resolve({ name: '测试队员', openId: 'ou_test' })
  };
}

function createFetch(routes) {
  const calls = [];
  const fetchMock = function (url, init) {
    const target = String(url);
    calls.push({ url: target, headers: (init && init.headers) || {} });
    const route = routes[target] || routes['*'];
    if (!route) return Promise.reject(new Error('假后端没配 ' + target));
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: function () { return Promise.resolve(route.text); }
    });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

/** 把 feishu-jsapi.js 放进假环境里跑一次 */
function boot(options) {
  const opts = options || {};
  const fetchMock = createFetch(opts.routes || {});
  const sandbox = {
    console: { warn: function () {}, log: function () {} },
    fetch: fetchMock,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    JSON: JSON,
    Math: Math,
    Number: Number,
    Error: Error,
    String: String,
    location: { href: 'https://fever-inventory.app.workbuddy.host/#/scan', hostname: 'fever-inventory.app.workbuddy.host' },
    FEVER_CONFIG: { appId: 'cli_test_app', apiBase: '' },
    FEVER: { Auth: createAuth(opts.token, opts.authReject) }
  };
  sandbox.globalThis = sandbox;
  if (opts.h5sdk) sandbox.h5sdk = opts.h5sdk;

  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: SOURCE });

  return {
    state: sandbox.FEVER.FeishuJsapi.state,
    ready: sandbox.FEVER.FeishuJsapi.ready,
    fetch: fetchMock,
    sandbox: sandbox
  };
}

const SIGN_OK = JSON.stringify({
  ok: true,
  appId: 'cli_test_app',
  timestamp: 1700000000000,        // 毫秒级，服务端现在就是这么给的
  nonceStr: 'a1b2c3d4',
  signature: 'deadbeef'
});

const CONFIG_URL = '/api/jsapi-config?url=' +
  encodeURIComponent('https://fever-inventory.app.workbuddy.host/');

(async function main() {
  console.log('飞书 JSAPI 鉴权测试（端内扫码要过的那一关）');

  /* ---- 不在飞书里：不该有任何动静 ---- */

  const plain = boot({ routes: {} });
  const plainResult = await plain.ready.catch(function () { return 'rejected'; });
  check('不在飞书客户端里（没有 h5sdk）时，鉴权直接跳过而不是卡住',
    plainResult === false, plainResult);
  check('没有 h5sdk 时不发任何请求（离线版/普通浏览器打开不该去要签名）',
    plain.fetch.calls.length === 0, plain.fetch.calls);
  check('页面上要能说清"不在飞书客户端里"，好让人知道该用别的办法扫',
    /不在飞书客户端里/.test(plain.state.error), plain.state.error);

  /* ---- 在飞书里：等 h5sdk 就绪再 config ---- */

  const sdk = createH5sdk({ autoReady: false });
  const inFeishu = boot({
    h5sdk: sdk,
    token: 'tok-123',
    routes: { [CONFIG_URL]: { status: 200, text: SIGN_OK } }
  });
  await new Promise(function (r) { setTimeout(r, 30); });
  check('h5sdk 还没就绪时不急着 config（就绪前调会被静默忽略）',
    sdk.configCalls.length === 0, 'config 已被调用 ' + sdk.configCalls.length + ' 次');
  check('但会先把 h5sdk.ready 排上（等它就绪）', sdk.readyCalls >= 1, sdk.readyCalls);

  sdk.fireReady();
  const okResult = await inFeishu.ready.catch(function (e) { return 'rejected:' + e.message; });
  check('h5sdk 就绪后完成鉴权', okResult === true, okResult);
  check('鉴权成功后 state.ok 为真，页面可以显示"已就绪"', inFeishu.state.ok === true);

  /* ---- 传给 h5sdk.config 的参数 ---- */

  const args = sdk.configCalls[0] || {};
  check('时间戳原样传服务端给的毫秒值（**不能**再除以 1000）',
    args.timestamp === 1700000000000, args.timestamp);
  check('appId / 随机串 / 签名都带上',
    args.appId === 'cli_test_app' && args.nonceStr === 'a1b2c3d4' && args.signature === 'deadbeef',
    args);
  check('jsApiList 里要有 scanCode（只申请要用的那个）',
    Array.isArray(args.jsApiList) && args.jsApiList.indexOf('scanCode') !== -1, args.jsApiList);

  /* ---- 签名请求本身 ---- */

  check('签名只对当前页面地址申请（去掉 # 后面那段，飞书就是按这个签的）',
    inFeishu.fetch.calls.length === 1 &&
    /\/api\/jsapi-config\?url=https%3A%2F%2Ffever-inventory\.app\.workbuddy\.host%2F$/
      .test(inFeishu.fetch.calls[0].url),
    inFeishu.fetch.calls.map(function (c) { return c.url; }));
  check('要签名得带上会话令牌（没登录不该拿到签名）',
    inFeishu.fetch.calls[0].headers['X-Session-Token'] === 'tok-123',
    inFeishu.fetch.calls[0].headers);

  /* ---- 鉴权失败：不能把应用卡死 ---- */

  const failSdk = createH5sdk({ autoReady: true, failWith: 'invalid signature' });
  const failCase = boot({
    h5sdk: failSdk,
    token: 'tok-123',
    routes: { [CONFIG_URL]: { status: 200, text: SIGN_OK } }
  });
  const failResult = await failCase.ready.catch(function (e) { return 'rejected:' + e.message; });
  check('鉴权失败时 resolve(false) 而不是抛错（扫码要能退到摄像头/拍照）',
    failResult === false, failResult);
  check('失败原因里要指明去配 H5 可信域名 —— 不然只知道失败不知道该改哪里',
    /H5 可信域名/.test(failCase.state.error) && failCase.state.error.indexOf('invalid signature') !== -1,
    failCase.state.error);
  check('失败也要记下具体阶段，页面上才好显示"没就绪"而不是"正在准备"',
    failCase.state.done === true && failCase.state.stage === 'fail', failCase.state);

  /* ---- 服务端不给签名（没登录 / 没配权限）---- */

  const denied = boot({
    h5sdk: createH5sdk({ autoReady: true }),
    token: '',
    routes: { '*': { status: 401, text: JSON.stringify({ ok: false, message: '请先登录' }) } }
  });
  const deniedResult = await denied.ready.catch(function (e) { return 'rejected:' + e.message; });
  check('服务端拒绝给签名时，鉴权算失败但不阻塞', deniedResult === false, deniedResult);
  check('服务端给的提示要原样传到 state.error（手机上要能看到这句话）',
    /请先登录/.test(denied.state.error), denied.state.error);

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) process.exitCode = 1;
})();
