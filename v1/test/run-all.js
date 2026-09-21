/**
 * 一次跑完全部测试：自动测试 + 浏览器端到端测试 + 数据持久化测试。
 *
 * 用法：npm run test:all
 *
 * 三类测试各跑各的进程，任何一个有失败项，整体退出码非 0。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HERE = __dirname;
const SUITES = [
  { name: '自动测试（数据层 / 规则层 / 模块层）', script: 'test.js' },
  { name: '浏览器端到端测试（界面实操）', script: path.join('e2e', 'run.js') },
  { name: '数据持久化测试（刷新 / 关浏览器 / 重启）', script: path.join('e2e', 'run-persist.js') }
];

const results = [];

SUITES.forEach((suite) => {
  console.log('');
  console.log('############################################');
  console.log('# ' + suite.name);
  console.log('############################################');
  const res = spawnSync(process.execPath, [path.join(HERE, suite.script)], {
    stdio: 'inherit',
    cwd: path.resolve(HERE, '..')
  });
  results.push({ name: suite.name, code: res.status === null ? 1 : res.status });
});

console.log('');
console.log('############################################');
console.log('# 全部测试汇总');
console.log('############################################');
results.forEach((r) => {
  console.log((r.code === 0 ? '  ✓ 通过：' : '  ✗ 有失败：') + r.name);
});

const failed = results.filter((r) => r.code !== 0);
console.log('');
if (failed.length) {
  console.log('有 ' + failed.length + ' 组测试未通过，请往上翻看具体失败项。');
  process.exitCode = 1;
} else {
  console.log('全部测试通过。');
}
