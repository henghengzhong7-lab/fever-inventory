'use strict';

/**
 * 发号机制（第二十六轮）：编码由服务端分配。
 *
 * 为什么要有这个测试：编码序号原来是**前端各自在本机算**的，两个人同时添加物品
 * 都会算出 MC-0007 —— 服务端只能拒掉后一个（409），界面于是提示
 * "编号已被占用…请重新操作一次"并重拉全量数据。现在改成服务端发号，这里钉住四件事：
 *   · 接着库里已有的最大号往后发（兼容最早的、还没有水位的数据）
 *   · 水位**落库**（settings 的 codeCounter:<前缀>）→ 服务端重启后不会把旧号再发一遍
 *   · 两个请求同时进来 → 靠 enqueue 串行，拿到的是**不同的段**（绝不重叠）
 *   · 前缀不合法直接拒
 *
 * 用一个内存里的假多维表格顶替 lib/feishu.js，所以**不碰任何真实数据**。
 *
 * 用法：node test-reserve.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const store = require('./lib/store');

/* ==================== 假的多维表格 ==================== */

const FAKE = { tables: [], data: {}, writes: 0 };

let ridSeq = 0;
function newRid() { ridSeq += 1; return 'rec' + String(ridSeq).padStart(5, '0'); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

const fakeFeishu = {
  baseUrl: function (token) { return 'fake://base/' + token; },
  async tenantAccessToken() { return 'fake-token'; },
  async listTables() { return FAKE.tables.map((t) => ({ name: t.name, table_id: t.table_id })); },
  async listRecords(cfg, appToken, tableId) {
    return (FAKE.data[tableId] || []).map((r) => ({ record_id: r.record_id, fields: clone(r.fields) }));
  },
  async batchCreate(cfg, appToken, tableId, records) {
    FAKE.writes += 1;
    const created = [];
    records.forEach(function (item) {
      const rec = { record_id: newRid(), fields: clone(item.fields) };
      FAKE.data[tableId].push(rec);
      created.push({ record_id: rec.record_id, fields: clone(rec.fields) });
    });
    return created;
  },
  async batchUpdate(cfg, appToken, tableId, records) {
    FAKE.writes += 1;
    const updated = [];
    records.forEach(function (item) {
      const hit = (FAKE.data[tableId] || []).find((r) => r.record_id === item.record_id);
      if (!hit) throw new Error('要改的记录不存在：' + item.record_id);
      hit.fields = clone(item.fields);
      updated.push({ record_id: hit.record_id, fields: clone(hit.fields) });
    });
    return updated;
  },
  async batchDelete(cfg, appToken, tableId, recordIds) {
    FAKE.writes += 1;
    FAKE.data[tableId] = (FAKE.data[tableId] || []).filter((r) => recordIds.indexOf(r.record_id) === -1);
    return recordIds.map(function (id) { return { record_id: id, deleted: true }; });
  }
};

const feishuPath = require.resolve('./lib/feishu');
const stub = new Module(feishuPath, null);
stub.filename = feishuPath;
stub.loaded = true;
stub.exports = fakeFeishu;
require.cache[feishuPath] = stub;

const mod = require('./index.js');

/* ==================== 测试脚手架 ==================== */

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
FAKE.tables = store.STORES.map(function (key) {
  const configured = CFG.tableIds && CFG.tableIds[key];
  return { name: store.tableName(key), table_id: configured || ('tbl_' + key) };
});

let passed = 0;
let failed = 0;
function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  ✓ ' + label); } else {
    failed += 1;
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}
function equal(label, actual, expected) {
  check(label + '（期望 ' + JSON.stringify(expected) + '）', actual === expected, actual);
}

function tableIdFor(key) {
  return FAKE.tables.find((x) => x.name === store.tableName(key)).table_id;
}
function rowsOf(key) { return FAKE.data[tableIdFor(key)] || []; }

/** 把假表格里的行还原成业务对象（DATA 列存的是整条 JSON） */
function decoded(key) {
  return rowsOf(key).map(function (r) {
    const text = (r.fields && r.fields[store.FIELD.DATA]) || '';
    try { return JSON.parse(text); } catch (e) { return null; }
  }).filter(Boolean);
}

/** 往物品表里塞一条"老数据"（走真实的编码转换，保证和线上存的一样） */
function seedItem(code) {
  const fields = store.rowToFields('items', {
    code: code, name: '老件' + code, spec: '', categoryId: 'mechanical', location: '',
    troop: '重装', identityMode: 'shared', totalQty: 1, inStockQty: 1, lentQty: 0,
    repairQty: 0, usedUpQty: 0, status: 'in_stock', safetyStock: null,
    remark: '', extra: {}, purchaseRequestId: null, invoiceId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }, '测试', '2026-01-01T00:00:00.000Z');
  FAKE.data[tableIdFor('items')].push({ record_id: newRid(), fields: fields });
}

const ACTOR = { name: '测试队员', openId: 'ou_test', isAdmin: true };

/** 模拟"服务端重启"：把内存镜像丢掉，逼它从（假）表格重新加载 */
async function restart() {
  mod.STATE.data = null;
  await mod.loadAll(true);
}

async function main() {
  console.log('\n发号机制 · 服务端分配编码\n');

  console.log('[1] 老库还没有水位行：从物品表里已有的最大号往后发');
  store.STORES.forEach(function (key) { FAKE.data[tableIdFor(key)] = []; });
  seedItem('MC-0005');
  await restart();
  const a = await mod.enqueue(function () { return mod.allocateCodes('MC', 3, ACTOR); });
  equal('从 0006 开始', a.codes[0], 'MC-0006');
  equal('发 3 个', a.codes.length, 3);
  equal('最后一个是 0008', a.codes[2], 'MC-0008');
  equal('水位记到 8', a.watermark, 8);

  console.log('\n[2] 水位写进了 settings（不是只在内存里）');
  const watermarkRow = decoded('settings').filter(function (r) { return r && r.key === 'codeCounter:MC'; })[0];
  check('settings 里有 codeCounter:MC 这一行', !!watermarkRow);
  equal('记的值是 8', watermarkRow && watermarkRow.value, 8);

  console.log('\n[3] 接着往下发（不回头、不重号）');
  const b = await mod.enqueue(function () { return mod.allocateCodes('MC', 2, ACTOR); });
  equal('接着是 0009/0010', b.codes.join(','), 'MC-0009,MC-0010');
  const all1 = a.codes.concat(b.codes);
  equal('一个都没重复', new Set(all1).size, all1.length);

  console.log('\n[4] 服务端重启后不会把已经发出去的号再发一遍（水位持久化的意义）');
  await restart();
  const c = await mod.enqueue(function () { return mod.allocateCodes('MC', 2, ACTOR); });
  equal('重启后接着 0011/0012', c.codes.join(','), 'MC-0011,MC-0012');
  const all2 = all1.concat(c.codes);
  equal('跨重启也没有重复', new Set(all2).size, all2.length);

  console.log('\n[5] 两个请求同时进来：靠串行队列拿到**不同的段**（绝不重叠）');
  const [p, q] = await Promise.all([
    mod.enqueue(function () { return mod.allocateCodes('VS', 5, ACTOR); }),
    mod.enqueue(function () { return mod.allocateCodes('VS', 5, ACTOR); })
  ]);
  check('两次都发了 5 个', p.codes.length === 5 && q.codes.length === 5);
  const overlap = p.codes.filter(function (x) { return q.codes.indexOf(x) !== -1; });
  equal('两段没有任何重叠', overlap.length, 0);
  check('两段不重叠（' + JSON.stringify([p.from, p.to]) + ' 与 ' + JSON.stringify([q.from, q.to]) + '）',
    p.to < q.from || q.to < p.from);
  equal('两个段合起来正好 10 个不同的号', new Set(p.codes.concat(q.codes)).size, 10);

  console.log('\n[6] 不同前缀互不干扰');
  const mc = await mod.enqueue(function () { return mod.allocateCodes('MC', 1, ACTOR); });
  const vs = await mod.enqueue(function () { return mod.allocateCodes('VS', 1, ACTOR); });
  equal('MC 接着自己的水位', mc.codes[0], 'MC-0013');
  equal('VS 接着自己的水位', vs.codes[0], 'VS-0011');

  console.log('\n[7] 非法前缀要被拒（不然谁都能拿乱前缀占号）');
  let rejected = 0;
  for (const bad of ['', 'mc', 'MC1', 'abcdefgh', 'MC-', null, undefined]) {
    try {
      await mod.enqueue(function () { return mod.allocateCodes(bad, 1, ACTOR); });
    } catch (err) { rejected += 1; }
  }
  equal('7 种非法前缀全被拒', rejected, 7);
  // 单字母是**合法**前缀（正则放宽到 1~4 位）：将来加短前缀的大类不用再改这里
  const oneLetter = await mod.enqueue(function () { return mod.allocateCodes('M', 1, ACTOR); });
  equal('单字母前缀可用', oneLetter.codes[0], 'M-0001');

  console.log('\n[8] 记录 id 也由服务端发（第二十八轮）');
  // 起因：申请号/发票号/流水号原来是前端本机计数器分配的，而每次添加物品
  // 都会写一条入库流水 —— 两人同时添加几乎必然分到同一个流水 id，服务端只能 409。
  store.STORES.forEach(function (key) { FAKE.data[tableIdFor(key)] = []; });
  seedItem('MC-0100');
  // 造一条已有流水（id 1）—— 发号要接着它往后
  rowsOf('transactions').push({
    record_id: newRid(),
    fields: store.rowToFields('transactions', {
      id: 1, itemCode: 'MC-0100', type: 'inbound', qty: 1, operator: '测试',
      createdAt: '2026-01-01T00:00:00.000Z'
    }, '测试', '2026-01-01T00:00:00.000Z')
  });
  await restart();

  const t1 = await mod.enqueue(function () { return mod.allocateIds('transactions', 2, ACTOR); });
  equal('从数据里最大 id 之后接着发（1 → 2、3）', t1.ids.join(','), '2,3');
  const idRow = decoded('settings').filter(function (r) { return r.key === 'idCounter:transactions'; })[0];
  check('id 水位也落库了', !!idRow);
  equal('水位记到 3', idRow && idRow.value, 3);

  await restart();
  const t2 = await mod.enqueue(function () { return mod.allocateIds('transactions', 1, ACTOR); });
  equal('重启后不重发（接着 4）', t2.ids[0], 4);

  const [p2, q2] = await Promise.all([
    mod.enqueue(function () { return mod.allocateIds('invoices', 3, ACTOR); }),
    mod.enqueue(function () { return mod.allocateIds('invoices', 3, ACTOR); })
  ]);
  const overlap2 = p2.ids.filter(function (x) { return q2.ids.indexOf(x) !== -1; });
  equal('两个请求同时来：两段零重叠', overlap2.length, 0);
  check('两段不重叠（' + JSON.stringify([p2.from, p2.to]) + ' 与 ' + JSON.stringify([q2.from, q2.to]) + '）',
    p2.to < q2.from || q2.to < p2.from);

  // ⚠️ 防御：水位落后于数据时（比如手工导入了一批大号记录）必须取数据的最大值
  rowsOf('transactions').push({
    record_id: newRid(),
    fields: store.rowToFields('transactions', {
      id: 99, itemCode: 'MC-0100', type: 'lend', qty: 1, operator: '测试',
      createdAt: '2026-02-01T00:00:00.000Z'
    }, '测试', '2026-02-01T00:00:00.000Z')
  });
  await restart();
  const t3 = await mod.enqueue(function () { return mod.allocateIds('transactions', 1, ACTOR); });
  equal('水位落后于数据时取数据的最大值（99 → 100）', t3.ids[0], 100);

  let badStore = 0;
  for (const bad of ['items', 'categories', 'settings', '不存在的表', '']) {
    try {
      await mod.enqueue(function () { return mod.allocateIds(bad, 1, ACTOR); });
    } catch (err) { badStore += 1; }
  }
  equal('非自增表 / 不存在的表都被拒（5 种）', badStore, 5);

  console.log('\n--------------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) process.exitCode = 1;
}

main().catch(function (err) {
  console.error('测试崩了：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
