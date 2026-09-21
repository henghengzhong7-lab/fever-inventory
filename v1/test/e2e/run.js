/**
 * 浏览器端到端测试入口。
 * 用法：node test/e2e/run.js [页面文件名...]（不带参数则跑全部）
 *
 * 每个页面自己会执行操作并把结果写进 <pre id="e2e-out">，
 * 这里负责起服务、开浏览器、把结果读回来并汇总。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./harness.js');

const PAGES = [
  { file: 'e2e-home.html', name: 'M2 框架与首页' },
  { file: 'e2e-items.html', name: 'M3 物品身份与二维码' },
  { file: 'e2e-purchase.html', name: 'M4 采购与到货入库' },
  { file: 'e2e-desk.html', name: 'M5 出入库与借用' },
  { file: 'e2e-category.html', name: 'M6 四大类专属页' },
  { file: 'e2e-settings.html', name: 'M7 设置与备份恢复' },
  { file: 'e2e-persist.html', name: 'M8 数据持久化' }
];

async function main() {
  const wanted = process.argv.slice(2);
  const pages = wanted.length
    ? PAGES.filter((p) => wanted.some((w) => p.file.includes(w)))
    : PAGES.filter((p) => fs.existsSync(path.join(__dirname, p.file)));

  let totalPass = 0;
  let totalFail = 0;
  const details = [];

  for (const page of pages) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fever-e2e-'));
    const server = H.createServer();
    const res = await H.runPage(server, '/test/e2e/' + page.file, profile);
    const text = res.text || '';
    const summary = /SUMMARY pass=(\d+) fail=(\d+)/.exec(text);
    const pass = summary ? Number(summary[1]) : 0;
    const failCount = summary ? Number(summary[2]) : 0;
    totalPass += pass;
    totalFail += failCount;
    details.push({ page, text, pass, fail: failCount });
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }

  console.log('');
  console.log('FEver 战队物资管理 —— 浏览器端测试');
  console.log('============================================');
  for (const d of details) {
    console.log('');
    console.log('【' + d.page.name + '】');
    const lines = (d.text || '(没有拿到输出)').split('\n').filter((l) => l.trim());
    lines.forEach((l) => {
      if (l.startsWith('PASS ')) console.log('  \u2713 ' + l.slice(5));
      else if (l.startsWith('FAIL ')) console.log('  \u2717 ' + l.slice(5));
      else if (!l.startsWith('SUMMARY')) console.log('    ' + l);
    });
  }

  console.log('');
  console.log('--------------------------------------------');
  console.log('通过 ' + totalPass + ' 项，失败 ' + totalFail + ' 项');
  if (totalFail > 0) {
    console.log('浏览器端测试有失败项。');
    process.exitCode = 1;
  } else if (totalPass === 0) {
    console.log('没有跑任何浏览器端测试（页面文件不存在或没有输出）。');
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
}

main().catch((err) => {
  console.error('端到端测试运行失败：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
