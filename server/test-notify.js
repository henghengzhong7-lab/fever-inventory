'use strict';

/**
 * 采购审批飞书提醒的测试（第十三轮）。
 *
 * 用内存假多维表格 + 假 sendMessage 顶替 lib/feishu.js，不碰真实数据、不真发消息。
 * 要钉住的行为：
 *   · 队员提交新申请 → 管理员收到提醒（姓名名单和 openId 名单都要能收到）
 *   · 管理员批准 → 申请人本人收到提醒（按提交时记下的 openId）
 *   · 老申请没有提交人身份 → 用申请人姓名从登录记录里反查
 *   · 普通编辑（approval 字段原样带回）→ 不触发任何提醒
 *   · 提醒发送失败 → 业务写入照常成功（提醒永远不能挡业务）
 *   · 收不到收件人 → 不报错、业务照常，日志里说一声
 *
 * 用法：node test-notify.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const store = require('./lib/store');

/* ==================== 假的多维表格 + 假发消息 ==================== */

const FAKE = { tables: [], data: {}, calls: [], msgs: [], groupMsgs: [] };

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
  },
  async sendMessage(cfg, openId, text) {
    if (FAKE.failNextSend) {
      FAKE.failNextSend = false;
      throw new Error('模拟：发送权限没开');
    }
    FAKE.msgs.push({ openId: openId, text: String(text) });
    return true;
  },
  async sendGroupWebhook(cfg, text) {
    if (FAKE.failNextGroup) {
      FAKE.failNextGroup = false;
      throw new Error('模拟：群机器人地址失效');
    }
    if (!cfg.groupWebhook) return false;   // 与真实现同语义：没配置返回 false
    FAKE.groupMsgs.push({ text: String(text) });
    return true;
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
  FAKE.msgs.length = 0;
  FAKE.groupMsgs.length = 0;
  mod.STATE.data = null;
  store.STORES.forEach(function (key) { FAKE.data[tableIdFor(key)] = []; });
}

/** 等异步的 fire-and-forget 提醒落地（成功或失败） */
function settle() { return new Promise(function (r) { setTimeout(r, 50); }); }

const MEMBER = { name: '张三', openId: 'ou_member_1', isAdmin: false };
const ADMIN = { name: '李队长', openId: 'ou_admin_1', isAdmin: true };

let seq = 0;
function newRequestRow(extra) {
  seq += 1;
  const base = {
    id: seq, categoryId: 'vision', troop: '步兵', name: '工业相机 ' + seq, spec: '',
    quantity: 1, budget: '6000', purpose: '识别', applicant: '张三',
    status: 'pending', approval: 'pending',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
  };
  return Object.assign(base, extra || {});
}

function msgsTo(openId) {
  return FAKE.msgs.filter(function (m) { return m.openId === openId; });
}

(async function main() {
  console.log('采购审批飞书提醒的测试（假表格 + 假发消息，不碰真实数据）');
  console.log();

  /* ---------- 1. 收件人解析 ---------- */
  console.log('[1] 管理员名单 → openId');
  mod.CONFIG.admins = ['李队长', 'ou_admin_2'];
  mod.rememberUser({ openId: 'ou_admin_1', name: '李队长' });
  mod.rememberUser({ openId: 'ou_member_1', name: '张三' });
  const ids = mod.adminOpenIds();
  check('openId 名单直接用', ids.indexOf('ou_admin_2') !== -1, JSON.stringify(ids));
  check('姓名名单从登录记录里反查出 openId', ids.indexOf('ou_admin_1') !== -1, JSON.stringify(ids));
  check('名单外的人不会被当成管理员', ids.indexOf('ou_member_1') === -1, JSON.stringify(ids));

  /* ---------- 2. 提交申请 → 提醒管理员 ---------- */
  console.log();
  console.log('[2] 提交申请提醒管理员');
  resetAll();
  await mod.loadAll(true);
  const row = newRequestRow();
  await mod.applyOps([{ store: 'purchaseRequests', type: 'add', data: row }], MEMBER);
  await settle();

  check('表格里已经写入（提醒没挡业务）', decoded('purchaseRequests').length === 1);
  const saved = decoded('purchaseRequests')[0];
  check('提交人的飞书身份记进了申请（requesterOpenId）',
    saved.requesterOpenId === 'ou_member_1' && saved.requesterName === '张三',
    JSON.stringify({ openId: saved.requesterOpenId, name: saved.requesterName }));
  check('openId 名单的管理员收到了提醒', msgsTo('ou_admin_2').length === 1,
    JSON.stringify(FAKE.msgs));
  check('姓名名单的管理员（已登录过的）也收到了提醒', msgsTo('ou_admin_1').length === 1);
  check('提醒里说了申请内容和申请人',
    /工业相机/.test(msgsTo('ou_admin_2')[0] ? msgsTo('ou_admin_2')[0].text : '') &&
    /张三/.test(msgsTo('ou_admin_2')[0] ? msgsTo('ou_admin_2')[0].text : ''),
    msgsTo('ou_admin_2')[0] && msgsTo('ou_admin_2')[0].text);
  check('提交人自己不该收到"等审批"的提醒', msgsTo('ou_member_1').length === 0);

  /* ---------- 3. 批准 → 提醒申请人 ---------- */
  console.log();
  console.log('[3] 批准后提醒申请人');
  resetAll();
  seed('purchaseRequests', newRequestRow({ requesterOpenId: 'ou_member_1', requesterName: '张三' }));
  await mod.loadAll(true);
  const pending = decoded('purchaseRequests')[0];
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: Object.assign({}, pending, { approval: 'approved' }) }],
    ADMIN
  );
  await settle();

  check('审批写进了表格', decoded('purchaseRequests')[0].approval === 'approved');
  check('申请人收到了批准提醒', msgsTo('ou_member_1').length === 1, JSON.stringify(FAKE.msgs));
  check('提醒里说了谁批的', /李队长/.test(msgsTo('ou_member_1')[0].text), msgsTo('ou_member_1')[0].text);
  check('管理员不该收到"已批准"的提醒', msgsTo('ou_admin_2').length === 0 && msgsTo('ou_admin_1').length === 0);

  /* ---------- 4. 老申请：姓名反查 ---------- */
  console.log();
  console.log('[4] 老申请（没有提交人身份）');
  resetAll();
  seed('purchaseRequests', newRequestRow({ id: 99, applicant: '张三' }));   // 无 requesterOpenId
  await mod.loadAll(true);
  const legacy = decoded('purchaseRequests')[0];
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: Object.assign({}, legacy, { approval: 'approved' }) }],
    ADMIN
  );
  await settle();
  check('老申请批准时，凭申请人姓名反查到登录记录并送达', msgsTo('ou_member_1').length === 1,
    JSON.stringify(FAKE.msgs));

  resetAll();
  seed('purchaseRequests', newRequestRow({ id: 98, applicant: '从没登录过的人' }));
  await mod.loadAll(true);
  const ghost = decoded('purchaseRequests')[0];
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: Object.assign({}, ghost, { approval: 'approved' }) }],
    ADMIN
  );
  await settle();
  check('反查不到收件人时不发也不报错，业务照常成功',
    decoded('purchaseRequests')[0].approval === 'approved' && FAKE.msgs.length === 0);

  /* ---------- 5. 普通编辑不触发 ---------- */
  console.log();
  console.log('[5] 普通编辑不触发提醒');
  resetAll();
  seed('purchaseRequests', newRequestRow({ approval: 'pending' }));
  await mod.loadAll(true);
  const editing = decoded('purchaseRequests')[0];
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: Object.assign({}, editing, { quantity: 3 }) }],
    MEMBER      // approval 原样带回 = 没改审批，普通队员可编辑
  );
  await settle();
  check('改数量这种普通编辑一条提醒都不该发', FAKE.msgs.length === 0, JSON.stringify(FAKE.msgs));

  /* ---------- 6. 发送失败不挡业务 ---------- */
  console.log();
  console.log('[6] 提醒发不出去也不能挡业务');
  resetAll();
  FAKE.failNextSend = true;
  await mod.loadAll(true);
  await mod.applyOps([{ store: 'purchaseRequests', type: 'add', data: newRequestRow() }], MEMBER);
  await settle();
  check('发送失败时业务写入照常成功', decoded('purchaseRequests').length === 1);

  /* ---------- 7. 群提醒（可选的群机器人 webhook） ---------- */
  console.log();
  console.log('[7] 群提醒：配了就发，没配就静默跳过，失败也不挡业务');

  resetAll();
  mod.CONFIG.groupWebhook = '';                       // 没配置
  await mod.loadAll(true);
  await mod.applyOps([{ store: 'purchaseRequests', type: 'add', data: newRequestRow() }], MEMBER);
  await settle();
  check('没配群机器人时不发群消息', FAKE.groupMsgs.length === 0, JSON.stringify(FAKE.groupMsgs));

  resetAll();
  mod.CONFIG.groupWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-hook';
  await mod.loadAll(true);
  await mod.applyOps([{ store: 'purchaseRequests', type: 'add', data: newRequestRow() }], MEMBER);
  await settle();
  check('提交申请时群消息也发了一条', FAKE.groupMsgs.length === 1, JSON.stringify(FAKE.groupMsgs));
  check('群消息里同样说清了申请内容', /工业相机/.test(FAKE.groupMsgs[0] ? FAKE.groupMsgs[0].text : ''),
    FAKE.groupMsgs[0] && FAKE.groupMsgs[0].text);

  FAKE.groupMsgs.length = 0;
  seed('purchaseRequests', newRequestRow({ requesterOpenId: 'ou_member_1', requesterName: '张三' }));
  await mod.loadAll(true);
  const pendingForGroup = decoded('purchaseRequests')[0];
  await mod.applyOps(
    [{ store: 'purchaseRequests', type: 'put', data: Object.assign({}, pendingForGroup, { approval: 'approved' }) }],
    ADMIN
  );
  await settle();
  check('批准时群消息也发了一条', FAKE.groupMsgs.length === 1, JSON.stringify(FAKE.groupMsgs));
  check('群里的批准消息说了谁批的', /李队长/.test(FAKE.groupMsgs[0] ? FAKE.groupMsgs[0].text : ''),
    FAKE.groupMsgs[0] && FAKE.groupMsgs[0].text);

  resetAll();
  FAKE.failNextGroup = true;
  await mod.loadAll(true);
  await mod.applyOps([{ store: 'purchaseRequests', type: 'add', data: newRequestRow() }], MEMBER);
  await settle();
  check('群发送失败时业务写入照常成功', decoded('purchaseRequests').length === 1);
  mod.CONFIG.groupWebhook = '';                       // 还原，别影响别的测试

  /* ---------- 8. 登录名单持久化（重新发布清掉本地文件也能恢复） ---------- */
  console.log();
  console.log('[8] 登录名单存进设置表，重新发布后能恢复');
  resetAll();
  mod.CONFIG.admins = ['李队长'];
  await mod.loadAll(true);                            // 先有数据镜像，rememberUser 才会往设置表写
  mod.resetKnownUsers();                              // 清内存，模拟"文件+内存全丢"
  mod.rememberUser({ openId: 'ou_admin_1', name: '李队长' });
  mod.rememberUser({ openId: 'ou_member_1', name: '张三' });
  await settle();

  const kuRow = decoded('settings').filter(function (r) { return r && r.key === 'knownUsers'; })[0];
  check('登录名单写进了设置表', !!kuRow, JSON.stringify(decoded('settings')));
  check('名单里记录了两个登录过的人',
    !!kuRow && kuRow.value && Object.keys(kuRow.value).length === 2, JSON.stringify(kuRow));
  check('rememberUser 本身也更新了内存（本次进程立即可用）',
    mod.adminOpenIds().indexOf('ou_admin_1') !== -1);

  // 模拟重新发布：本地文件清掉、内存名单清零，但设置表还在
  mod.resetKnownUsers();
  check('名单清空后按姓名反查不到管理员（复现线上问题）',
    mod.adminOpenIds().indexOf('ou_admin_1') === -1, JSON.stringify(mod.adminOpenIds()));
  await mod.loadAll(true);                            // 重启后 loadAll 会从设置表合并
  check('loadAll 后名单从设置表恢复，管理员又能反查到了',
    mod.adminOpenIds().indexOf('ou_admin_1') !== -1, JSON.stringify(mod.adminOpenIds()));
  check('名单外的人不会被合并成管理员', mod.adminOpenIds().indexOf('ou_member_1') === -1);

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) process.exitCode = 1;
})();
