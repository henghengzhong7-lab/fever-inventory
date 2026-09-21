/**
 * 全部自动测试入口。
 * 运行：npm test（在本目录），或 node test/test.js
 *
 * 覆盖计划书第 6.1 节的测试组。每次改动数据层或规则层都要跑。
 */
'use strict';

// 让 Node 里也有 indexedDB（内存实现，用完即弃，不碰真实浏览器数据）
require('fake-indexeddb/auto');

const H = require('./harness.js');
const DB = require('../js/db.js');
const Rules = require('../js/rules.js');
const Ops = require('../js/ops.js');

const cases = require('./cases/db.js');
const syntaxCases = require('./cases/syntax.js');
const codeCases = require('./cases/codes.js');
const invariantCases = require('./cases/invariant.js');
const backupCases = require('./cases/backup.js');
const reminderCases = require('./cases/reminders.js');
const opsCases = require('./cases/ops.js');
const linkCases = require('./cases/links.js');
const moduleCases = require('./cases/modules.js');
const serverCases = require('./cases/server.js');
const offlineCases = require('./cases/offline.js');

[syntaxCases, cases, codeCases, invariantCases, backupCases, reminderCases, opsCases, linkCases,
  moduleCases, serverCases, offlineCases]
  .forEach((mod) => mod.register(H, DB, Rules, Ops));

console.log('');
console.log('FEver 战队物资管理 —— 自动测试');
console.log('============================================');

H.run().catch((err) => {
  console.error('测试运行器异常：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
