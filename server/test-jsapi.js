'use strict';

/**
 * 网页应用 JSAPI 鉴权（手机端扫码要走的那一步）。
 *
 * 为什么值得单独测：
 *   手机端扫码点不动，根因之一就是 `tt.scanCode` 需要 JSAPI 鉴权 ——
 *   而鉴权签名**错一位就全错**，前端只会收到一句"鉴权失败"，
 *   看不出是字段顺序错了、还是凭证没拿到。所以签名这一步必须能在不联网的情况下验。
 *
 * 另外这里还守着一道门：签名参数只对**已登录**的队员发。
 *
 * 用法：node test-jsapi.js
 */

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const feishu = require('./lib/feishu');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.log('  ✗ ' + label + (detail ? '\n      → ' + detail : ''));
  }
}

console.log('JSAPI 鉴权测试（手机端扫码）');

/* ---- 签名算法：字段顺序、内容都不能差 ---- */

const TICKET = 'demo-jsapi-ticket';
const NONCE = 'a1b2c3d4e5f60718';
// 13 位 = 毫秒级。飞书 h5sdk.config 要的就是毫秒，这里跟着真实用例走，
// 免得测试本身把一个"秒级也算得通"的错误写法固化成标准。
const TS = 1700000000000;
const URL = 'https://fever-inventory.app.workbuddy.host/';

/* ---- 时间戳单位：踩过一次的坑，必须钉死 ---- */

const ts = feishu.jsapiTimestamp();
check('鉴权时间戳是**毫秒级**（13 位）—— 用秒级签名能算出来但客户端一定鉴权失败',
  String(ts).length === 13 && Math.abs(ts - Date.now()) < 60000,
  '实际 ' + ts + '（' + String(ts).length + ' 位）');

const expected = crypto.createHash('sha1')
  .update('jsapi_ticket=' + TICKET + '&noncestr=' + NONCE + '&timestamp=' + TS + '&url=' + URL, 'utf8')
  .digest('hex');

check('签名 = sha1(jsapi_ticket / noncestr / timestamp / url)，与飞书官方顺序一致',
  feishu.jsapiSignature(TICKET, NONCE, TS, URL) === expected,
  feishu.jsapiSignature(TICKET, NONCE, TS, URL) + ' ≠ ' + expected);

check('换一个页面地址，签名跟着变（签名是绑页面的，不能一个签名到处用）',
  feishu.jsapiSignature(TICKET, NONCE, TS, URL + 'x') !== expected);

check('换一张凭证，签名跟着变',
  feishu.jsapiSignature(TICKET + 'x', NONCE, TS, URL) !== expected);

// 顺序换了也必须不一样 —— 这正是最容易写错的地方
const swapped = crypto.createHash('sha1')
  .update('jsapi_ticket=' + TICKET + '&timestamp=' + TS + '&noncestr=' + NONCE + '&url=' + URL, 'utf8')
  .digest('hex');
check('字段顺序对不上就算不出同一个签名（顺序敏感）',
  feishu.jsapiSignature(TICKET, NONCE, TS, URL) !== swapped);

/* ---- 接口这道门：没登录不能拿签名 ---- */

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (function attempt() {
    return fetch('http://127.0.0.1:' + port + '/api/health')
      .then(function (res) { return res.ok; })
      .catch(function () { return false; })
      .then(function (ok) {
        if (ok) return true;
        if (Date.now() > deadline) return false;
        return new Promise(function (r) { setTimeout(r, 500); }).then(attempt);
      });
  })();
}

async function runGateTest() {
  const port = 8791;
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore'
  });

  try {
    const up = await waitForHealth(port, 60000);
    if (!up) {
      check('服务能起来（没起来就没法验接口）', false, '60 秒内 /api/health 一直不通');
      return;
    }

    const res = await fetch('http://127.0.0.1:' + port +
      '/api/jsapi-config?url=' + encodeURIComponent(URL));
    const body = await res.json().catch(function () { return {}; });
    check('没登录拿不到 JSAPI 签名（必须 401）', res.status === 401,
      '实际 ' + res.status + '，返回 ' + JSON.stringify(body));
    check('401 时给出人话提示，且不带任何签名参数',
      !!body.message && !body.signature && !body.nonceStr,
      JSON.stringify(body));

    // 没带 url 的请求会先被登录门挡住（401），这里只关心一件事：**绝不能算出签名**
    const missing = await fetch('http://127.0.0.1:' + port + '/api/jsapi-config');
    const mb = await missing.json().catch(function () { return {}; });
    check('缺 url 时绝不算出签名（400 或被登录门挡住都行，就是不能给）',
      (missing.status === 400 || missing.status === 401) && !mb.signature,
      '实际 ' + missing.status + '，返回 ' + JSON.stringify(mb));
  } finally {
    child.kill();
  }
}

runGateTest().catch(function (err) {
  check('接口门测试自身没抛异常', false, String(err && err.stack ? err.stack : err));
}).then(function () {
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    process.exitCode = 1;
  }
});
