'use strict';

/**
 * 验证「写库改成表间并行」之后，行为与原来完全一致。
 *
 * 用一个内存里的假多维表格顶替 lib/feishu.js，所以**不会碰任何真实数据**。
 * 除了功能正确性，还专门验证两件事：
 *   · 多表的写入确实是并行发生的（耗时和调用时间线能看出来）
 *   · 第一次写完之后，同一条记录的第二次写走的是「更新」而不是又「新增」一遍
 *
 * 用法：node test-parallel.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const store = require('./lib/store');

/* ==================== 假的多维表格 ==================== */

const FAKE = {
  tables: [],
  data: {},
  delayMs: 150,
  calls: [],
  failOn: null
};

let ridSeq = 0;
function newRid() { ridSeq += 1; return 'rec' + String(ridSeq).padStart(5, '0'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

async function simulate(op, tableId, fn) {
  const rec = { op: op, tableId: tableId, startedAt: Date.now() };
  FAKE.calls.push(rec);
  await sleep(FAKE.delayMs);
  if (FAKE.failOn === op) {
    rec.failed = true;
    const err = new Error('模拟的飞书写入失败');
    err.feishuCode = 99999;
    throw err;
  }
  const out = fn();
  rec.endedAt = Date.now();
  return out;
}

const fakeFeishu = {
  baseUrl: function (token) { return 'fake://base/' + token; },
  async tenantAccessToken() { return 'fake-token'; },
  async listTables() { return FAKE.tables.map((t) => ({ name: t.name, table_id: t.table_id })); },
  async listRecords(cfg, appToken, tableId) {
    return (FAKE.data[tableId] || []).map((r) => ({ record_id: r.record_id, fields: clone(r.fields) }));
  },
  async batchCreate(cfg, appToken, tableId, records) {
    return simulate('create', tableId, function () {
      const created = [];
      records.forEach(function (item) {
        const rec = { record_id: newRid(), fields: clone(item.fields) };
        FAKE.data[tableId].push(rec);
        created.push({ record_id: rec.record_id, fields: clone(rec.fields) });
      });
      return created;
    });
  },
  async batchUpdate(cfg, appToken, tableId, records) {
    return simulate('update', tableId, function () {
      const updated = [];
      records.forEach(function (item) {
        const hit = (FAKE.data[tableId] || []).find((r) => r.record_id === item.record_id);
        if (!hit) throw new Error('要改的记录不存在：' + item.record_id);
        hit.fields = clone(item.fields);
        updated.push({ record_id: hit.record_id, fields: clone(hit.fields) });
      });
      return updated;
    });
  },
  async batchDelete(cfg, appToken, tableId, recordIds) {
    return simulate('delete', tableId, function () {
      FAKE.data[tableId] = (FAKE.data[tableId] || []).filter((r) => recordIds.indexOf(r.record_id) === -1);
      return recordIds.map(function (id) { return { record_id: id, deleted: true }; });
    });
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
store.STORES.forEach(function (key) {
  const t = FAKE.tables.find((x) => x.name === store.tableName(key));
  FAKE.data[t.table_id] = [];
});

function tableIdFor(key) {
  return FAKE.tables.find((x) => x.name === store.tableName(key)).table_id;
}

function rowsOf(key) {
  return FAKE.data[tableIdFor(key)] || [];
}

function decoded(key) {
  return rowsOf(key).map(function (r) {
    const text = (r.fields && r.fields[store.FIELD.DATA]) || '';
    try { return JSON.parse(text); } catch (e) { return null; }
  }).filter(Boolean);
}

function seed(key, row, operator) {
  rowsOf(key).push({
    record_id: newRid(),
    fields: store.rowToFields(key, row, operator || '预置', new Date().toISOString())
  });
}

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.log('  ✗ ' + label + (detail ? '\n      → ' + detail : '')); }
}

function resetAll() {
  FAKE.calls.length = 0;
  FAKE.failOn = null;
  mod.STATE.data = null;
  store.STORES.forEach(function (key) { FAKE.data[tableIdFor(key)] = []; });
}

/* ==================== 开跑 ==================== */

(async function main() {
  console.log('用内存假表格验证写库并行化的正确性（不碰真实数据）');
  console.log('每次写操作的模拟耗时：' + FAKE.delayMs + ' ms');
  console.log();

  /* ---------- 1. 单表新增 ---------- */
  console.log('[1] 单表新增 / 自增编号');
  resetAll();
  let r = await mod.applyOps([
    { store: 'categories', type: 'add', data: { id: 1, name: '电机' } }
  ], '队员甲');
  check('新增写进了表格', rowsOf('categories').length === 1, '实际 ' + rowsOf('categories').length + ' 条');
  check('内容正确', decoded('categories')[0].name === '电机');
  check('操作人被记录', (rowsOf('categories')[0].fields[store.FIELD.UPDATED_BY] || '') === '队员甲');

  // transactions 是自增表，编号由服务端分配
  r = await mod.applyOps([
    { store: 'transactions', type: 'add', data: { id: 1, itemCode: 'M-001', type: 'in', qty: 5 } }
  ], '队员甲');
  check('自增表编号顺延到 2', r.sequences.transactions === 2, '实际 ' + r.sequences.transactions);
  check('不自增的表不出现在编号里', r.sequences.categories === undefined,
    '实际 ' + JSON.stringify(r.sequences.categories));

  /* ---------- 2. 多表并行（核心） ---------- */
  console.log();
  console.log('[2] 一次事务里写三张不同的表 —— 验证并行且结果正确');
  resetAll();
  FAKE.calls.length = 0;
  const t0 = Date.now();
  r = await mod.applyOps([
    { store: 'categories', type: 'add', data: { id: 1, name: '结构件' } },
    { store: 'items', type: 'add', data: { code: 'M-001', name: 'M3 螺丝' } },
    { store: 'transactions', type: 'add', data: { id: 1, itemCode: 'M-001', type: 'in', qty: 50 } }
  ], '队员乙');
  const elapsed = Date.now() - t0;

  check('三张表都写进去了', rowsOf('categories').length === 1 && rowsOf('items').length === 1 && rowsOf('transactions').length === 1,
    'categories=' + rowsOf('categories').length + ' items=' + rowsOf('items').length + ' transactions=' + rowsOf('transactions').length);
  check('三张表的内容都对', decoded('items')[0].code === 'M-001' && decoded('transactions')[0].qty === 50);

  const createCalls = FAKE.calls.filter((c) => c.op === 'create');
  check('发出了 3 次写入调用', createCalls.length === 3, '实际 ' + createCalls.length);

  const serialCost = FAKE.delayMs * 3;
  check('总耗时接近「一次往返」而不是三次累加（' + elapsed + 'ms）', elapsed < FAKE.delayMs * 2.2,
    '串行应为 ' + serialCost + 'ms 左右，实际 ' + elapsed + 'ms');

  const overlap = createCalls.length >= 2 &&
    createCalls.some((a, i) => createCalls.some((b, j) => i !== j && Math.abs(a.startedAt - b.startedAt) < FAKE.delayMs / 2));
  check('三次调用在时间上确实重叠（真并行）', overlap,
    createCalls.map((c) => new Date(c.startedAt).toISOString().slice(17, 23)).join(' / '));

  /* ---------- 3. 第二次写同一条，应该走「更新」 ---------- */
  console.log();
  console.log('[3] 先新增、再改同一条 —— 第二次必须走更新而不是又新增一遍');
  resetAll();
  await mod.applyOps([{ store: 'items', type: 'add', data: { code: 'M-002', name: 'M4 螺丝', qty: 10 } }], '队员丙');
  FAKE.calls.length = 0;
  await mod.applyOps([
    { store: 'items', type: 'put', data: { code: 'M-002', name: 'M4 螺丝', qty: 25 } }
  ], '队员丙');
  const ops2 = FAKE.calls.map((c) => c.op);
  check('第二次只有 1 次调用', FAKE.calls.length === 1, '实际 ' + FAKE.calls.length + ' 次：' + ops2.join(','));
  check('走的是 update 而不是 create', ops2[0] === 'update', '实际 ' + ops2[0]);
  check('表格里仍然只有 1 条（没重复插入）', rowsOf('items').length === 1, '实际 ' + rowsOf('items').length + ' 条');
  check('数量已更新为 25', decoded('items')[0].qty === 25, JSON.stringify(decoded('items')[0]));

  /* ---------- 4. 编号冲突整批拒绝 ---------- */
  console.log();
  console.log('[4] 编号被别人占了 —— 应整批拒绝，且不动表格');
  resetAll();
  seed('categories', { id: 1, name: '已有的大类' });
  await mod.loadAll(true);
  const beforeData = clone(FAKE.data);
  let conflict = null;
  try {
    await mod.applyOps([
      { store: 'categories', type: 'add', data: { id: 1, name: '撞号的' } },
      { store: 'items', type: 'add', data: { code: 'M-003', name: '顺便加的' } }
    ], '队员丁');
  } catch (err) { conflict = err; }
  check('抛出了冲突错误', !!conflict && conflict.conflict === true, conflict ? conflict.message : '没有抛错');
  check('表格一点没变（整批拒绝）', JSON.stringify(FAKE.data) === JSON.stringify(beforeData));
  check('镜像也没被改脏', mod.STATE.data.items.length === 0, '实际 items=' + mod.STATE.data.items.length);
  check('提示里带上了编号', !!conflict && /1/.test(conflict.message));

  /* ---------- 5. 写库失败 → 镜像回滚 ---------- */
  console.log();
  console.log('[5] 飞书写入失败 —— 镜像应回滚，不能让前端看到没写进去的数据');
  resetAll();
  seed('items', { code: 'M-100', name: '原有物品' });
  await mod.loadAll(true);
  FAKE.failOn = 'create';
  let writeErr = null;
  try {
    await mod.applyOps([{ store: 'categories', type: 'add', data: { id: 9, name: '写不进去的' } }], '队员戊');
  } catch (err) { writeErr = err; }
  FAKE.failOn = null;
  check('抛出了错误', !!writeErr, writeErr ? writeErr.message : '没有抛错');
  check('镜像里没有那条脏数据', !mod.STATE.data.categories.some((x) => x.id === 9),
    JSON.stringify(mod.STATE.data.categories));
  check('原有数据仍然完好', mod.STATE.data.items.length === 1 && mod.STATE.data.items[0].code === 'M-100');

  /* ---------- 6. 删除 + 清空 ---------- */
  console.log();
  console.log('[6] 删除单条 / 整表清空');
  resetAll();
  seed('items', { code: 'M-200', name: '要被删的' });
  seed('items', { code: 'M-201', name: '要留下的' });
  await mod.loadAll(true);
  await mod.applyOps([{ store: 'items', type: 'delete', key: 'M-200' }], '队员己');
  check('删除后只剩 1 条', rowsOf('items').length === 1, '实际 ' + rowsOf('items').length + ' 条');
  check('剩下的是对的那条', decoded('items')[0].code === 'M-201');

  await mod.applyOps([{ store: 'items', type: 'clear' }], '队员己');
  check('清空后表格里 0 条', rowsOf('items').length === 0, '实际 ' + rowsOf('items').length + ' 条');
  check('镜像里也是 0 条', mod.STATE.data.items.length === 0);

  /* ---------- 7. 空操作不应产生任何写入 ---------- */
  console.log();
  console.log('[7] 空操作不应打飞书接口');
  resetAll();
  await mod.loadAll(true);
  FAKE.calls.length = 0;
  await mod.applyOps([], '队员庚');
  check('没有发出任何写入调用', FAKE.calls.length === 0, '实际 ' + FAKE.calls.length + ' 次');

  /* ---------- 收尾 ---------- */
  console.log();
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})().catch(function (err) {
  console.log('测试异常：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
