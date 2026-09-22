/** 临时探针入口：直接打开某个页面并把 #e2e-out 的内容原样打出来 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./harness.js');

async function main() {
  const page = process.argv[2] || '/test/e2e/e2e-probe.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fever-probe-'));
  const server = H.createServer();
  const res = await H.runPage(server, page, profile);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log('----- 页面输出 -----');
  console.log(res.text || '(没有拿到 e2e-out 内容)');
}

main().catch((err) => {
  console.error('探针失败：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
