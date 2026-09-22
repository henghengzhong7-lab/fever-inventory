'use strict';

/**
 * 写入耗时探针：拆开测量「点击确认」时，飞书那一侧到底要花多久。
 *
 * 为什么要有这个：/api/health 的探测只量了「读」（listTables）。
 * 使用者的抱怨全部集中在**写**（提交申请、确认收货、出入库），
 * 而写（batch_create / batch_update / batch_delete）在飞书侧走的是另一条链路，
 * 耗时和读不一定同量级，不能拿读的数字顶替。
 *
 * 安全性：只在「设置」表里写一条主键为 __perf_probe__ 的临时记录，
 * 测完立刻删除，并校验这条记录确实不在了。真实业务数据一行都不碰。
 *
 * 用法：node perf-write.js
 */

const fs = require('node:fs');
const path = require('node:path');
const feishu = require('./lib/feishu');
const store = require('./lib/store');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const APP = CFG.bitableAppToken;
const PROBE_KEY = '__perf_probe__';

function ms(n) {
  return String(Math.round(n)).padStart(6) + ' ms';
}

async function time(label, fn) {
  const t0 = process.hrtime.bigint();
  try {
    const out = await fn();
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ' + label.padEnd(40) + ms(dt));
    return out;
  } catch (err) {
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ' + label.padEnd(40) + ms(dt) + '   [失败] ' + (err.message || err));
    throw err;
  }
}

function stats(list) {
  if (!list.length) return '(无样本)';
  const sorted = list.slice().sort((a, b) => a - b);
  const sum = list.reduce((a, b) => a + b, 0);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return '最小 ' + Math.round(sorted[0]) +
    '  中位 ' + Math.round(p(0.5)) +
    '  P90 ' + Math.round(p(0.9)) +
    '  最大 ' + Math.round(sorted[sorted.length - 1]) +
    '  平均 ' + Math.round(sum / list.length) + ' ms';
}

(async function main() {
  console.log('=== 飞书侧「写」的耗时（每次都是真实 API 调用）===');
  console.log();

  await feishu.tenantAccessToken(CFG);
  console.log('  tenant_access_token 已就绪（后续都走缓存，不重复计费）');
  console.log();

  const tables = await time('listTables（定位设置表）', () => feishu.listTables(CFG, APP));
  const settingsTable = tables.find((t) => t.name === store.tableName('settings'));
  if (!settingsTable) throw new Error('找不到设置表，无法继续');
  const tableId = settingsTable.table_id;

  console.log();
  console.log('--- 读（作为对照）---');
  const readSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const t = process.hrtime.bigint();
    await feishu.listRecords(CFG, APP, tableId);
    readSamples.push(Number(process.hrtime.bigint() - t) / 1e6);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('  listRecords ×5   ' + stats(readSamples));
  console.log('  明细：' + readSamples.map((v) => Math.round(v)).join(', '));

  // 清掉可能残留的探针记录
  const before = await feishu.listRecords(CFG, APP, tableId);
  const stale = before.filter((r) => store.readText((r.fields || {})[store.FIELD.KEY]) === PROBE_KEY);
  if (stale.length) {
    console.log('  （发现上次残留的探针记录，先清掉 ' + stale.length + ' 条）');
    await feishu.batchDelete(CFG, APP, tableId, stale.map((r) => r.record_id));
  }

  console.log();
  console.log('--- 写：新增 1 条 ---');
  const createSamples = [];
  let recordIds = [];
  for (let i = 0; i < 3; i += 1) {
    const key = PROBE_KEY + '_' + i;
    const t = process.hrtime.bigint();
    const created = await feishu.batchCreate(CFG, APP, tableId, [{
      fields: store.rowToFields('settings', { key: key, value: 1 }, '性能探针', new Date().toISOString())
    }]);
    createSamples.push(Number(process.hrtime.bigint() - t) / 1e6);
    created.forEach((r) => recordIds.push(r.record_id));
  }
  console.log('  batchCreate ×3   ' + stats(createSamples));
  console.log('  明细：' + createSamples.map((v) => Math.round(v)).join(', '));

  console.log();
  console.log('--- 写：更新 1 条 ---');
  const updateSamples = [];
  for (let i = 0; i < 3; i += 1) {
    const key = PROBE_KEY + '_' + (i % recordIds.length);
    const t = process.hrtime.bigint();
    await feishu.batchUpdate(CFG, APP, tableId, [{
      record_id: recordIds[i % recordIds.length],
      fields: store.rowToFields('settings', { key: key, value: 2 }, '性能探针', new Date().toISOString())
    }]);
    updateSamples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  console.log('  batchUpdate ×3   ' + stats(updateSamples));
  console.log('  明细：' + updateSamples.map((v) => Math.round(v)).join(', '));

  console.log();
  console.log('--- 写：删除（清理）---');
  const tDel = process.hrtime.bigint();
  await feishu.batchDelete(CFG, APP, tableId, recordIds);
  console.log('  batchDelete ×' + recordIds.length + '   ' + ms(Number(process.hrtime.bigint() - tDel) / 1e6));

  // 校验清理干净
  const after = await feishu.listRecords(CFG, APP, tableId);
  const left = after.filter((r) => store.readText((r.fields || {})[store.FIELD.KEY]).indexOf(PROBE_KEY) === 0);
  console.log();
  console.log(left.length
    ? '  ✗ 警告：设置表里还残留 ' + left.length + ' 条探针记录，请手动删除'
    : '  ✓ 设置表已恢复原样，探针记录 0 条（业务数据一行未动）');
  console.log('    设置表原有记录数：' + before.length + ' → 现在：' + after.length);

  const all = createSamples.concat(updateSamples);
  const mid = all.slice().sort((a, b) => a - b)[Math.floor(all.length / 2)];
  console.log();
  console.log('=== 结论 ===');
  console.log('  单次「写」到飞书的中位耗时：约 ' + Math.round(mid) + ' ms');
  console.log('  单次「读」到飞书的中位耗时：约 ' +
    Math.round(readSamples.slice().sort((a, b) => a - b)[Math.floor(readSamples.length / 2)]) + ' ms');
  console.log('  → 使用者点一次确认，如果前端只发 1 个写请求，服务端这段是「1 次写」的量级；');
  console.log('    如果一个动作里前端发 2 个请求（先占编号、再落库），就要按 2 次累加。');
})().catch(function (err) {
  console.log('探针异常：' + (err && err.message ? err.message : err));
  if (err && err.payload) console.log(JSON.stringify(err.payload));
  process.exit(1);
});
