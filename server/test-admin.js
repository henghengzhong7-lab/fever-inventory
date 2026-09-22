'use strict';

/**
 * 管理员身份与采购审批权限的测试。
 *
 * 用一个内存里的假多维表格顶替 lib/feishu.js，所以**不会碰任何真实数据**。
 * 重点验证的是"拦得住"和"不该拦的别拦"这两件事：
 *   · 普通队员改审批状态 → 整批拒绝，一个字节都不写
 *   · 管理员改审批状态 → 放行
 *   · 普通队员改同一条申请的其他字段（改名、改数量）→ 不该被误伤
 *   · 普通队员导出备份要写的 lastBackupAt → 不该被误伤（这条最容易踩）
 *   · 兵种预算 → 只有管理员能改
 *
 * 除了函数级调用，最后还真的起了服务、发了 HTTP 请求，确认返回的是 403 而不是 500，
 * 也确认 /api/me 会告诉前端"你是不是管理员"。
 *
 * 用法：node test-admin.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const store = require('./lib/store');

/* ==================== 假的多维表格 ==================== */

const FAKE = { tables: [], data: {}, calls: [] };

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
    FAKE.calls.push({ op: 'create', tableId: tableId });
    const created = [];
    records.forEach(function (item) {
      const rec = { record_id: newRid(), fields: clone(item.fields) };
      FAKE.data[tableId].push(rec);
      created.push({ record_id: rec.record_id, fields: clone(rec.fields) });
    });
    return created;
  },
  async batchUpdate(cfg, appToken, tableId, records) {
    FAKE.calls.push({ op: 'update', tableId: tableId });
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
    FAKE.calls.push({ op: 'delete', tableId: tableId });
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

/* ==================== 脚手架 ==================== */

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
function rowsOf(key) { return FAKE.data[tableIdFor(key)] || []; }
function decoded(key) {
  return rowsOf(key).map(function (r) {
    const text = (r.fields && r.fields[store.FIELD.DATA]) || '';
    try { return JSON.parse(text); } catch (e) { return null; }
  }).filter(Boolean);
}
function seed(key, row) {
  rowsOf(key).push({
    record_id: newRid(),
    fields: store.rowToFields(key, row, '预置', new Date().toISOString())
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
  mod.STATE.data = null;
  store.STORES.forEach(function (key) { FAKE.data[tableIdFor(key)] = []; });
}

/** 一次申请的形状。approval 由调用方决定传不传（不传 = 模拟老数据） */
function requestRow(extra) {
  const base = {
    id: 1, categoryId: 'vision', troop: '步兵', name: '工业相机', spec: '',
    quantity: 1, budget: '6000', purpose: '识别', applicant: '张三',
    status: 'pending', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
  };
  return Object.assign(base, extra || {});
}

/** 期望这次写入被拒绝，并返回错误对象 */
async function expectForbidden(label, ops, actor) {
  try {
    await mod.applyOps(ops, actor);
    check(label, false, '居然成功了，本该被拒');
    return null;
  } catch (err) {
    check(label, err && err.forbidden === true, '抛的错没有 forbidden 标记：' + (err && err.message));
    return err;
  }
}

const MEMBER = { name: '张三', openId: 'ou_member_1', isAdmin: false };
const ADMIN = { name: '李队长', openId: 'ou_admin_1', isAdmin: true };

/* ==================== 开跑 ==================== */

(async function main() {
  console.log('管理员身份与采购审批权限的测试（用内存假表格，不碰真实数据）');
  console.log();

  // 名单：一个姓名、一个 openId，这样两种写法都被覆盖到
  mod.CONFIG.admins = ['李队长', 'ou_admin_2'];

  /* ---------- 1. 谁是管理员 ---------- */
  console.log('[1] 管理员判定');
  check('姓名在名单里 → 是管理员', mod.isAdminUser({ name: '李队长', openId: 'ou_x' }) === true);
  check('openId 在名单里 → 是管理员', mod.isAdminUser({ name: '随便谁', openId: 'ou_admin_2' }) === true);
  check('都不在名单里 → 不是管理员', mod.isAdminUser({ name: '张三', openId: 'ou_member_1' }) === false);
  check('姓名两边多打了空格也认', mod.isAdminUser({ name: ' 李队长 ', openId: '' }) === true);
  check('空身份 → 不是管理员', mod.isAdminUser(null) === false && mod.isAdminUser({}) === false);
  const savedAdmins = mod.CONFIG.admins;
  mod.CONFIG.admins = [];
  check('名单为空时没人能审批（默认就是最安全的）', mod.isAdminUser({ name: '李队长', openId: 'ou_admin_2' }) === false);
  mod.CONFIG.admins = savedAdmins;

  /* ---------- 2. 普通队员改审批状态 → 拒绝 ---------- */
  console.log();
  console.log('[2] 普通队员不能改审批状态');
  resetAll();
  seed('purchaseRequests', requestRow({ approval: 'pending' }));
  await mod.loadAll(true);

  let err = await expectForbidden(
    '把审批改成「已同意」被拒',
    [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'approved' }) }],
    MEMBER
  );
  check('错误信息说清了原因', /只有管理员/.test(err ? err.message : ''), err && err.message);
  check('被拒时一个字节都没写进表格', FAKE.calls.length === 0,
    '实际调用：' + JSON.stringify(FAKE.calls));
  check('表格里的数据没被动过', decoded('purchaseRequests')[0].approval === 'pending',
    '实际 approval=' + decoded('purchaseRequests')[0].approval);

  err = await expectForbidden(
    '把审批改成「已驳回」同样被拒',
    [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'rejected', status: 'canceled' }) }],
    MEMBER
  );
  check('驳回也被拦住了', !!err);

  /* ---------- 3. 管理员改审批状态 → 放行 ---------- */
  console.log();
  console.log('[3] 管理员可以审批');
  resetAll();
  seed('purchaseRequests', requestRow({ approval: 'pending' }));
  await mod.loadAll(true);
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'approved' }) }],
    ADMIN
  );
  check('审批状态写进了表格', decoded('purchaseRequests')[0].approval === 'approved',
    '实际 ' + decoded('purchaseRequests')[0].approval);

  resetAll();
  seed('purchaseRequests', requestRow({ approval: 'pending' }));
  await mod.loadAll(true);
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'rejected', status: 'canceled', approvalNote: '预算不够' }) }],
    ADMIN
  );
  check('驳回也写得进去，理由留着', decoded('purchaseRequests')[0].approvalNote === '预算不够');

  /* ---------- 4. 不该被误伤的地方 ---------- */
  console.log();
  console.log('[4] 普通队员的日常操作不能被误伤');

  // 4.1 改自己那条申请的普通字段（审批状态原样带回来，等于没改）
  resetAll();
  seed('purchaseRequests', requestRow({ approval: 'pending' }));
  await mod.loadAll(true);
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'pending', quantity: 3, name: '工业相机（改）' }) }],
    MEMBER
  );
  check('改名称/数量照样能存（审批字段没动就不算越权）',
    decoded('purchaseRequests')[0].quantity === 3 && decoded('purchaseRequests')[0].name === '工业相机（改）');

  // 4.2 老数据本来就没有 approval 字段，普通队员改动它不能被判成越权
  resetAll();
  seed('purchaseRequests', requestRow({}));   // 不带 approval
  await mod.loadAll(true);
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: requestRow({ purpose: '改用途' }) }],
    MEMBER
  );
  check('老数据（没有 approval 字段）普通队员仍可编辑',
    decoded('purchaseRequests')[0].purpose === '改用途');

  // 4.3 导备份要写 lastBackupAt —— 这条最容易误伤，专门盯住
  resetAll();
  await mod.loadAll(true);
  await mod.applyOps(
    [{ store: 'settings', type: 'put', data: { key: 'lastBackupAt', value: '2026-09-21T00:00:00.000Z' } }],
    MEMBER
  );
  check('普通队员导出备份时写 lastBackupAt 不会被拦',
    decoded('settings').some(function (s) { return s.key === 'lastBackupAt'; }));

  // 4.4 普通队员照常提申请、登记出入库
  resetAll();
  await mod.loadAll(true);
  await mod.applyOps([
    { store: 'purchaseRequests', type: 'add', data: requestRow({ id: 2, approval: 'pending' }) }
  ], MEMBER);
  check('普通队员能提交新申请（新单子默认待审批）',
    decoded('purchaseRequests').length === 1 && decoded('purchaseRequests')[0].approval === 'pending');

  /* ---------- 5. 兵种预算只有管理员能改 ---------- */
  console.log();
  console.log('[5] 兵种预算只有管理员能改');
  resetAll();
  await mod.loadAll(true);
  await expectForbidden(
    '普通队员改兵种预算被拒',
    [{ store: 'settings', type: 'put', data: { key: 'budgetByTroop', value: { 步兵: 10000 } } }],
    MEMBER
  );
  await mod.applyOps(
    [{ store: 'settings', type: 'put', data: { key: 'budgetByTroop', value: { 步兵: 10000 } } }],
    ADMIN
  );
  check('管理员能改兵种预算',
    decoded('settings').some(function (s) { return s.key === 'budgetByTroop' && s.value && s.value['步兵'] === 10000; }));

  // 值没变的重写不该被拦（前端保存时会把整个对象重写一遍）
  resetAll();
  await mod.loadAll(true);
  await mod.applyOps(
    [{ store: 'settings', type: 'put', data: { key: 'budgetByTroop', value: { 步兵: 10000 } } }],
    ADMIN
  );
  await mod.applyOps(
    [{ store: 'settings', type: 'put', data: { key: 'budgetByTroop', value: { 步兵: 10000 } } }],
    MEMBER
  ).then(function () {
    check('预算值没变时普通队员重写一遍不会报错', true);
  }, function (e) {
    check('预算值没变时普通队员重写一遍不会报错', false, e && e.message);
  });

  /* ---------- 6. 真的发 HTTP 请求：要 403，不要 500 ---------- */
  console.log();
  console.log('[6] 走 HTTP 的真实路径');
  await new Promise(function (resolve) { mod.server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + mod.server.address().port;

  async function post(pathname, body, token) {
    const res = await fetch(base + pathname, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { 'X-Session-Token': token } : {}),
      body: JSON.stringify(body || {})
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON 就当 null */ }
    return { status: res.status, body: json };
  }

  resetAll();
  await mod.loadAll(true);
  seed('purchaseRequests', requestRow({ approval: 'pending' }));
  await mod.loadAll(true);

  const memberToken = mod.issueSession({ openId: 'ou_member_1', name: '张三' });
  const adminToken = mod.issueSession({ openId: 'ou_admin_1', name: '李队长' });

  let out = await post('/api/write', {
    ops: [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'approved' }) }]
  }, memberToken);
  check('普通队员的写请求返回 403（不是 500）', out.status === 403,
    '实际 ' + out.status + ' ' + JSON.stringify(out.body));
  check('响应里带了 forbidden 标记', !!(out.body && out.body.forbidden === true),
    JSON.stringify(out.body));
  check('响应信息是人话', !!(out.body && /只有管理员/.test(out.body.message || '')),
    out.body && out.body.message);

  out = await post('/api/write', {
    ops: [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'approved' }) }]
  }, adminToken);
  check('管理员的同一个请求返回 200', out.status === 200,
    '实际 ' + out.status + ' ' + JSON.stringify(out.body));
  check('审批状态真的落库了', decoded('purchaseRequests')[0].approval === 'approved');

  out = await post('/api/me', {}, adminToken);
  check('/api/me 告诉前端"是管理员"', !!(out.body && out.body.user && out.body.user.isAdmin === true),
    JSON.stringify(out.body));

  out = await post('/api/me', {}, memberToken);
  check('/api/me 告诉前端"不是管理员"', !!(out.body && out.body.user && out.body.user.isAdmin === false),
    JSON.stringify(out.body));

  out = await post('/api/write', {
    ops: [{ store: 'purchaseRequests', type: 'put', data: requestRow({ approval: 'approved' }) }]
  });
  check('没带令牌仍然是 401（权限校验没有把登录校验顶掉）', out.status === 401,
    '实际 ' + out.status);

  await new Promise(function (resolve) { mod.server.close(resolve); });

  /* ---------- 汇总 ---------- */
  console.log();
  console.log('--------------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    console.log('管理员权限相关测试有失败项。');
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
})().catch(function (err) {
  console.error('测试自己抛错了：');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
