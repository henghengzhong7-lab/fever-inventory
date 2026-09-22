'use strict';

/**
 * 端到端测试：真实后端 + 真实飞书多维表格。
 *
 * 和 feishu/test/remote-db.js 的区别：
 *   remote-db.js 用的是「假后端」（内存数组），验的是前端的远程数据层；
 *   这个脚本用的是真后端、真表格，验的是服务端那套「串行队列 + 自增编号校验 + 落库」。
 *
 * 本地没有飞书客户端，拿不到免登授权码，所以这里直接自己签一个会话令牌来跳过登录。
 * 这只影响「谁在操作」的记录，不跳过任何数据逻辑。
 *
 * 用法：node test-e2e.js
 *
 * ⚠️ 会往真实多维表格写数据，跑完自动清干净。开跑前会先确认表格是空的——
 *    如果里面已经有数据，脚本会直接退出，绝不覆盖。
 */

const assert = require('node:assert');

const mod = require('./index.js');
const feishu = require('./lib/feishu');
const store = require('./lib/store');

const PORT = 8790;
const BASE_URL = 'http://127.0.0.1:' + PORT;
const TEST_TOKEN = mod.issueSession({ openId: 'ou_e2e_test', name: '端到端测试' });

let passed = 0;
let failed = 0;

async function step(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + label);
  } catch (err) {
    failed += 1;
    console.log('  ✗ ' + label + '\n      → ' + (err && err.message ? err.message : err));
  }
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.log('  ✗ ' + label + (detail ? '  →  ' + detail : ''));
  }
}

async function api(pathname, options) {
  const opts = Object.assign({ headers: {} }, options);
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  if (opts.auth !== false) opts.headers.Authorization = 'Bearer ' + TEST_TOKEN;
  const res = await fetch(BASE_URL + pathname, {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
  return { status: res.status, body: body };
}

/** 清空真实表格里的全部数据 */
async function wipeAll() {
  await mod.applyOps(store.STORES.map(function (name) {
    return { store: name, type: 'clear' };
  }), 'e2e测试清理');
}

async function main() {
  console.log('多维表格：' + feishu.baseUrl(mod.CONFIG.bitableAppToken));

  // ---- 0. 安全检查：表必须是空的 ----
  console.log('\n[0] 开跑前的安全检查');
  const before = await mod.loadAll(false);
  const dirty = store.STORES.filter(function (name) { return before[name].length > 0; });
  if (dirty.length) {
    console.log('  ✗ 多维表格里已经有数据（' + dirty.join('、') + '），为避免误删，测试中止。');
    console.log('    如果这些是测试残留，先手动清空再跑。');
    process.exit(1);
  }
  console.log('  ✓ 表格是空的，可以安全测试');

  // ---- 1. 起服务 ----
  console.log('\n[1] 启动后端并挂上测试会话');
  await new Promise(function (resolve) { mod.server.listen(PORT, '127.0.0.1', resolve); });
  const health = await api('/api/health', { auth: false });
  check('/api/health 可达', health.status === 200 && health.body.ok === true,
    'HTTP ' + health.status);
  const noAuth = await api('/api/data', { auth: false });
  check('不带会话访问 /api/data 被拒（401）', noAuth.status === 401, 'HTTP ' + noAuth.status);

  // 线上网关（腾讯 STGW/EdgeOne）会给每个请求注入它自己的 Authorization，
  // 把前端发的令牌整个覆盖掉 —— 这是「队员打开应用报登录已失效」的真实原因。
  // 这里把修正后的行为固定下来：自定义头优先，Authorization 被换掉也不影响。
  const clobbered = await fetch(BASE_URL + '/api/data', {
    headers: {
      'X-Session-Token': TEST_TOKEN,
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.gateway-injected-token'
    }
  });
  check('Authorization 被网关覆盖时，靠 X-Session-Token 仍能认出身份',
    clobbered.status === 200, 'HTTP ' + clobbered.status);
  const onlyGateway = await fetch(BASE_URL + '/api/data', {
    headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.gateway-injected-token' }
  });
  check('只有网关令牌时仍然被拒（不会误认成已登录）',
    onlyGateway.status === 401, 'HTTP ' + onlyGateway.status);

  // ---- 2. 一次事务写多张表（对应前端的 runTx） ----
  console.log('\n[2] 一次写请求里操作多张表（对应界面上「入库」这类操作）');
  const write1 = await api('/api/write', {
    method: 'POST',
    body: {
      ops: [
        { store: 'categories', type: 'add', data: { id: 'cat_hardware', name: '机械件', order: 1 } },
        { store: 'items', type: 'add', data: { code: 'M3-001', name: 'M3 螺丝', categoryId: 'cat_hardware', qty: 0, unit: '个' } },
        { store: 'transactions', type: 'add', data: { id: 1, itemCode: 'M3-001', type: 'IN', qty: 100, createdAt: '2026-09-21T10:00:00.000Z' } }
      ]
    }
  });
  check('写请求返回 200', write1.status === 200 && write1.body.ok === true,
    'HTTP ' + write1.status + ' ' + JSON.stringify(write1.body).slice(0, 200));
  check('返回了自增序列（transactions 下一个编号应为 2）',
    write1.body && write1.body.sequences && write1.body.sequences.transactions === 2,
    JSON.stringify(write1.body && write1.body.sequences));

  // ---- 3. 换个「客户端」读回来 ----
  console.log('\n[3] 重新读一遍，确认真的落到多维表格里了');
  const read1 = await api('/api/data');
  const data1 = read1.body && read1.body.data;
  check('大类读到 1 条', data1 && data1.categories.length === 1,
    data1 ? data1.categories.length : 'no data');
  check('物品读到 1 条', data1 && data1.items.length === 1);
  check('流水读到 1 条', data1 && data1.transactions.length === 1);
  check('物品字段完整（中文内容无损）',
    data1 && data1.items[0] && data1.items[0].name === 'M3 螺丝' && data1.items[0].unit === '个',
    data1 && data1.items[0] ? JSON.stringify(data1.items[0]) : '');
  check('自增编号保持数字类型（不是字符串 "1"）',
    data1 && data1.transactions[0] && data1.transactions[0].id === 1,
    data1 && data1.transactions[0] ? typeof data1.transactions[0].id : '');

  // ---- 4. 绕过内存镜像，直接问飞书 ----
  console.log('\n[4] 绕过服务端内存镜像，直接查飞书确认数据真写进去了');
  for (const name of ['categories', 'items', 'transactions']) {
    const tableId = mod.CONFIG.tableIds[name];
    const rows = await feishu.listRecords(mod.CONFIG, mod.CONFIG.bitableAppToken, tableId);
    const real = rows.filter(function (r) { return store.fieldsToRow(r); });
    check('飞书里「' + store.tableName(name) + '」有 ' + real.length + ' 条', real.length === 1,
      '实际 ' + real.length + ' 条');
  }

  // ---- 5. 改一条 ----
  console.log('\n[5] 改一条（对应「借出后数量变化」）');
  const write2 = await api('/api/write', {
    method: 'POST',
    body: {
      ops: [
        { store: 'items', type: 'put', data: { code: 'M3-001', name: 'M3 螺丝', categoryId: 'cat_hardware', qty: 70, unit: '个' } },
        { store: 'transactions', type: 'add', data: { id: 2, itemCode: 'M3-001', type: 'OUT', qty: 30, createdAt: '2026-09-21T11:00:00.000Z' } }
      ]
    }
  });
  check('写请求返回 200', write2.status === 200, 'HTTP ' + write2.status);
  const read2 = await api('/api/data');
  const items2 = read2.body.data.items;
  check('物品还是 1 条（put 是覆盖不是新增）', items2.length === 1, '实际 ' + items2.length + ' 条');
  check('数量已更新为 70', items2[0].qty === 70, '实际 ' + items2[0].qty);
  check('流水变成 2 条', read2.body.data.transactions.length === 2);
  check('服务端自增序列推进到 3', read2.body.sequences.transactions === 3,
    String(read2.body.sequences.transactions));

  // ---- 6. 编号冲突必须整批拒绝 ----
  console.log('\n[6] 编号撞车时整批拒绝（多人同时登记的关键防线）');
  const conflict = await api('/api/write', {
    method: 'POST',
    body: {
      ops: [
        { store: 'items', type: 'add', data: { code: 'M3-002', name: '这条不该被写进去', qty: 1, unit: '个' } },
        { store: 'items', type: 'add', data: { code: 'M3-001', name: '跟已有编号撞了', qty: 1, unit: '个' } }
      ]
    }
  });
  check('返回 409 冲突', conflict.status === 409, 'HTTP ' + conflict.status);
  check('错误里标了 conflict 标记（前端据此提示刷新）',
    conflict.body && conflict.body.conflict === true, JSON.stringify(conflict.body).slice(0, 160));
  const read3 = await api('/api/data');
  check('冲突时整批都没写进去（M3-002 不存在）',
    !read3.body.data.items.some(function (i) { return i.code === 'M3-002'; }),
    JSON.stringify(read3.body.data.items.map(function (i) { return i.code; })));
  check('内存镜像没被改脏（仍是 1 条物品）', read3.body.data.items.length === 1);

  // ---- 7. 删一条 ----
  console.log('\n[7] 删一条');
  const write3 = await api('/api/write', {
    method: 'POST',
    body: { ops: [{ store: 'transactions', type: 'delete', key: '2' }] }
  });
  check('删除请求返回 200', write3.status === 200, 'HTTP ' + write3.status);
  const read4 = await api('/api/data');
  check('流水回到 1 条', read4.body.data.transactions.length === 1,
    '实际 ' + read4.body.data.transactions.length + ' 条');
  const txTableId = mod.CONFIG.tableIds.transactions;
  const txRows = await feishu.listRecords(mod.CONFIG, mod.CONFIG.bitableAppToken, txTableId);
  check('飞书里那条也确实删掉了',
    txRows.filter(function (r) { return store.fieldsToRow(r); }).length === 1,
    '飞书里还有 ' + txRows.filter(function (r) { return store.fieldsToRow(r); }).length + ' 条');

  // ---- 8. 空写请求也要能通过 ----
  console.log('\n[8] 空写请求（前端启动时只读不写的情况）');
  const write4 = await api('/api/write', { method: 'POST', body: { ops: [] } });
  check('返回 200 且不报错', write4.status === 200 && write4.body.ok === true,
    'HTTP ' + write4.status);

  // ---- 9. 清场 ----
  console.log('\n[9] 清空测试数据，恢复原状');
  await wipeAll();
  mod.STATE.data = null;
  const after = await mod.loadAll(true);
  const leftover = store.STORES.filter(function (name) { return after[name].length > 0; });
  check('六张表全部清空', leftover.length === 0, '还有数据的表：' + leftover.join('、'));
  for (const name of store.STORES) {
    const rows = await feishu.listRecords(mod.CONFIG, mod.CONFIG.bitableAppToken, mod.CONFIG.tableIds[name]);
    const real = rows.filter(function (r) { return store.fieldsToRow(r); });
    if (real.length) {
      check('飞书「' + store.tableName(name) + '」也清空了', false, '还剩 ' + real.length + ' 条');
    }
  }
  check('飞书侧六张表也全部清空', true);

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  mod.server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async function (err) {
  console.error('\n[端到端测试中断] ' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  try {
    await wipeAll();
    console.log('已尝试清空测试数据。');
  } catch (cleanupErr) {
    console.error('清理也失败了，请手动检查多维表格：' + cleanupErr.message);
  }
  process.exit(1);
});
