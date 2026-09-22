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

// 兵种改为必填后（第十三轮），绝大多数老用例并不关心兵种 ——
// 在这里统一垫一个默认值，免得几十处调用点都要机械补参数。
// 只补「没写 troop 键」的调用：显式传 troop:'' 的用例（见 cases/troop.js）
// 仍然会到达数据层，用来验证「缺兵种必须被拒绝」这条真规则。
const realInbound = Ops.inbound;
Ops.inbound = function (input) {
  return realInbound(Object.assign({ troop: '其他' }, input));
};

const cases = require('./cases/db.js');
const syntaxCases = require('./cases/syntax.js');
const apiCases = require('./cases/api.js');
const codeCases = require('./cases/codes.js');
const invariantCases = require('./cases/invariant.js');
const backupCases = require('./cases/backup.js');
const troopCases = require('./cases/troop.js');
const approvalCases = require('./cases/approval.js');
const budgetCases = require('./cases/budget.js');
const deleteCases = require('./cases/delete.js');
const batchCases = require('./cases/batch.js');
const scanCases = require('./cases/scan.js');
const reminderCases = require('./cases/reminders.js');
const opsCases = require('./cases/ops.js');
const linkCases = require('./cases/links.js');
const moduleCases = require('./cases/modules.js');
const serverCases = require('./cases/server.js');
const offlineCases = require('./cases/offline.js');
const invoiceCases = require('./cases/invoice.js');

[syntaxCases, apiCases, cases, codeCases, invariantCases, backupCases, troopCases, approvalCases, budgetCases,
  deleteCases, batchCases, scanCases, reminderCases, opsCases, linkCases, moduleCases, serverCases, offlineCases,
  invoiceCases]
  .forEach((mod) => mod.register(H, DB, Rules, Ops));

console.log('');
console.log('FEver 战队物资管理 —— 自动测试');
console.log('============================================');

H.run().catch((err) => {
  console.error('测试运行器异常：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
