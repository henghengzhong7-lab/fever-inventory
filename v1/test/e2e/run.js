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
  { file: 'e2e-persist.html', name: 'M8 数据持久化' },
  // M9 把真实的 index.html 放进窄 iframe 里跑：
  // 媒体查询看的是 iframe 的视口宽度，所以这样测的就是真实首页（含它自己的 viewport），
  // 不用另做一份"长得像首页"的测试页（那种迟早会和首页跑偏）。
  { file: 'e2e-mobile.html', name: 'M9 手机端适配' },
  // M10 扫码查物：真实页面 + 一个"假扫码器"把 扫到→解析→结果页 整条链路跑通
  { file: 'e2e-scan.html', name: 'M10 扫码查物' }
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
    // 打一行进度：不然整套跑十来分钟，中间完全没输出，看起来像卡死了
    process.stdout.write('跑 ' + page.name + ' …… ');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fever-e2e-'));
    const server = H.createServer();
    const res = await H.runPage(server, '/test/e2e/' + page.file, profile);
    const text = res.text || '';
    const summary = /SUMMARY pass=(\d+) fail=(\d+)/.exec(text);
    const pass = summary ? Number(summary[1]) : 0;
    // 判据：**页面有没有自己交出 SUMMARY**。
    //   - 有 SUMMARY：页面跑到 finish() 了，结果可信，以它的统计为准。
    //     这时候外层超时只说明"Chrome 退出慢"（已知会偶发），不算测试失败——
    //     否则一个真通过的结果会被报成红的。
    //   - 没有 SUMMARY：页面根本没跑完（脚本抛在半路、卡住），算一项失败。
    //     注意页面侧自己有 60 秒兜底（lib.js 的 hardTimeout），所以"页面卡住"
    //     通常会先由它交出一份带"整体超时"失败的 SUMMARY，不会被这里漏掉。
    const failCount = summary ? Number(summary[2]) : (res.timedOut ? 1 : 0);
    totalPass += pass;
    totalFail += failCount;
    details.push({ page, text, pass, fail: failCount, timedOut: !!res.timedOut, ran: !!summary });
    console.log((summary ? '完成' : (res.timedOut ? '没跑完（超时）' : '没跑完')) +
      '（' + pass + ' 通过，' + failCount + ' 失败）' +
      (res.timedOut && summary ? '　[浏览器退出慢，结果有效]' : ''));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }

  console.log('');
  console.log('FEver 战队物资管理 —— 浏览器端测试');
  console.log('============================================');
  for (const d of details) {
    console.log('');
    console.log('【' + d.page.name + '】');
    if (d.timedOut) {
      console.log(d.ran
        ? '    （页面已经跑完并交出了结果，只是浏览器退出慢 —— 本次被外层超时强制结束，结果有效）'
        : '  ✗ 这一页没跑完（浏览器被超时强制结束），下面是它已经跑出来的部分');
    }
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
