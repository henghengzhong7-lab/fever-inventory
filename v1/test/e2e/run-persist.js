/**
 * 数据持久化测试（对照 AC-02 ~ AC-04）。
 *
 * 和其他页面测试不一样的地方：这里**用同一个浏览器配置目录连续打开多次**，
 * 模拟"关掉浏览器再打开 / 重启电脑后再打开"。
 * 只有这样才能证明数据真的写进了本机存储，而不是只在内存里活着。
 *
 * 用法：node test/e2e/run-persist.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./harness.js');

/**
 * 一次运行 = 一个全新的浏览器配置目录 + 三个步骤。
 *
 * 三个步骤必须用**同一个端口**：浏览器按「协议 + 主机 + 端口」分区存 IndexedDB，
 * 端口一变就是另一套数据，测试就失去意义了（还会误报"数据丢了"）。
 */
const STEPS = [
  { phase: 'seed', name: '第 1 步：录入数据（模拟使用者第一次使用）' },
  { phase: 'verify', name: '第 2 步：关掉浏览器、重新打开，数据应当还在（模拟按 F5 与关闭浏览器）' },
  { phase: 'verify', name: '第 3 步：再关一次、再打开，数据仍应还在（模拟重启电脑）' },
  { phase: 'after', name: '第 4 步：重启之后继续入库，编码接着往下排' }
];

/** 找一个空闲端口，之后所有步骤都用它 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function runSteps(profile, port) {
  const out = [];
  for (const step of STEPS) {
    const server = H.createServer();
    const res = await H.runPage(server, '/test/e2e/e2e-persist.html?phase=' + step.phase, profile, port);
    out.push({ step, text: res.text || '' });
  }
  return out;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fever-persist-'));
  let results;
  try {
    results = await runSteps(profile, await pickFreePort());
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }

  let pass = 0;
  let fail = 0;
  console.log('');
  console.log('FEver 战队物资管理 —— 数据持久化测试');
  console.log('============================================');
  for (const r of results) {
    console.log('');
    console.log('【' + r.step.name + '】');
    const lines = (r.text || '(没有拿到输出)').split('\n').filter((l) => l.trim());
    if (!lines.length) console.log('    (没有拿到输出)');
    lines.forEach((l) => {
      if (l.startsWith('PASS ')) { pass += 1; console.log('  \u2713 ' + l.slice(5)); }
      else if (l.startsWith('FAIL ')) { fail += 1; console.log('  \u2717 ' + l.slice(5)); }
      else if (!l.startsWith('SUMMARY')) console.log('    ' + l);
    });
  }

  console.log('');
  console.log('--------------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0 || pass === 0) {
    console.log('数据持久化测试未通过。');
    process.exitCode = 1;
  } else {
    console.log('全部通过：数据在刷新、关闭浏览器、重启后都还在。');
  }
}

main().catch((err) => {
  console.error('持久化测试运行失败：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
