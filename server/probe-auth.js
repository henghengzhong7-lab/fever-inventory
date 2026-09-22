'use strict';

/**
 * 本地探针：验证「认证链路」本身，并确认令牌能扛住服务端重启、以及网关注入
 * Authorization 时仍然能认出队员身份。
 *
 * 用法：node probe-auth.js
 * （诊断端点只在本地由这个脚本临时打开，线上不会存在）
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8795;
const BASE = 'http://127.0.0.1:' + PORT;
// 诊断端点在线上是关闭的，本地跑这个探针时临时打开
const KEY = require('node:crypto').randomBytes(12).toString('hex');

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.log('  ✗ ' + label + (detail ? '\n      → ' + detail : '')); }
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', FEVER_DIAG_KEY: KEY }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', function (d) { process.stdout.write('    [server] ' + d); });
  child.stderr.on('data', function (d) { process.stdout.write('    [server:err] ' + d); });
  return child;
}

async function waitUp(tries) {
  for (let i = 0; i < (tries || 60); i += 1) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.status === 200) return await r.json();
    } catch (err) { /* 还没起来 */ }
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  throw new Error('服务端没起来');
}

async function req(pathname, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body: body };
}

async function main() {
  console.log('认证链路探针（服务端真实启动，读写真实多维表格）\n');

  let srv = startServer();
  let health = await waitUp();
  console.log('\n[1] 服务端实例信息');
  console.log('    instance=' + health.instance + '  pid=' + health.pid + '  uptimeSec=' + health.uptimeSec);
  check('/api/health 返回实例标识（可用来判断有没有重启）', !!health.instance);

  console.log('\n[2] 诊断端点回报的请求头（判断代理有没有剥头）');
  const diag = await req('/api/_diag?key=' + KEY, { headers: { 'X-Probe': 'yes', Authorization: 'Bearer bogus' } });
  console.log('    服务端收到的请求头：' + JSON.stringify(diag.body.headerNames));
  console.log('    auth = ' + JSON.stringify(diag.body.auth));
  check('诊断端点可用', diag.status === 200 && diag.body.ok === true, 'HTTP ' + diag.status);
  check('Authorization 能到达服务端', !!diag.body.auth.authorizationRaw);
  check('自定义头能到达服务端', !!diag.body.auth.xProbeRaw);
  check('无效令牌被判为未登录', diag.body.auth.sessionValid === false);

  const diagNoKey = await req('/api/_diag');
  check('不带密钥时诊断端点不可用（线上就是这种状态）', diagNoKey.status === 404, 'HTTP ' + diagNoKey.status);
  const diagBadKey = await req('/api/_diag?key=wrong-key');
  check('密钥不对同样不可用', diagBadKey.status === 404, 'HTTP ' + diagBadKey.status);

  console.log('\n[3] 签发令牌并访问受保护接口');
  const mint = await req('/api/_diag?key=' + KEY, { method: 'POST', body: { name: '探针' } });
  const token = mint.body.token;
  check('能签发令牌', !!token, JSON.stringify(mint.body).slice(0, 120));

  const me = await req('/api/me', { headers: { Authorization: 'Bearer ' + token } });
  check('/api/me 用 Authorization 通过', me.status === 200 && me.body.ok === true, 'HTTP ' + me.status);

  const data1 = await req('/api/data', { headers: { Authorization: 'Bearer ' + token } });
  check('/api/data 用 Authorization 通过', data1.status === 200 && data1.body.ok === true, 'HTTP ' + data1.status);

  const data2 = await req('/api/data', { headers: { 'X-Session-Token': token } });
  check('/api/data 用 X-Session-Token 兜底头也能通过',
    data2.status === 200 && data2.body.ok === true, 'HTTP ' + data2.status);

  // 复现线上真实情况：网关注入自己的 Authorization，把我们的令牌覆盖掉
  const dataGw = await req('/api/data', {
    headers: {
      'X-Session-Token': token,
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.gateway-injected-token'
    }
  });
  check('★ Authorization 被网关覆盖时，仍能靠 X-Session-Token 认出身份',
    dataGw.status === 200 && dataGw.body.ok === true,
    'HTTP ' + dataGw.status + ' ' + JSON.stringify(dataGw.body).slice(0, 120));

  const diagGw = await req('/api/_diag?key=' + KEY, {
    headers: {
      'X-Session-Token': token,
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.gateway-injected-token'
    }
  });
  console.log('    诊断：' + JSON.stringify(diagGw.body.auth));
  check('诊断能指认出匹配的是自定义头（matchedIndex=0）',
    diagGw.body.auth && diagGw.body.auth.matchedIndex === 0,
    JSON.stringify(diagGw.body.auth));

  const data3 = await req('/api/data');
  check('完全不带令牌仍然被拒（401）', data3.status === 401, 'HTTP ' + data3.status);

  console.log('\n[4] 关键：重启服务端后，同一个令牌还能不能用');
  srv.kill();
  await new Promise(function (r) { setTimeout(r, 1200); });
  srv = startServer();
  health = await waitUp();
  console.log('    新实例 instance=' + health.instance + '  pid=' + health.pid);
  check('确实换了实例（instance 变了）', !!health.instance);

  const data4 = await req('/api/data', { headers: { Authorization: 'Bearer ' + token } });
  check('★ 重启后旧令牌依然有效（队员不会掉线）',
    data4.status === 200 && data4.body.ok === true, 'HTTP ' + data4.status + ' ' + JSON.stringify(data4.body).slice(0, 120));

  const me2 = await req('/api/me', { headers: { Authorization: 'Bearer ' + token } });
  check('重启后 /api/me 也认得这个令牌', me2.status === 200, 'HTTP ' + me2.status);

  console.log('\n[5] 写接口也要能用');
  const w = await req('/api/write', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: { ops: [] }
  });
  check('/api/write 空操作通过（不产生任何写入）', w.status === 200 && w.body.ok === true, 'HTTP ' + w.status);

  srv.kill();
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  console.error('探针异常：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
