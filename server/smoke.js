'use strict';

/**
 * 冒烟测试：拿真实的飞书多维表格跑一遍「写进去 → 读回来 → 删掉」，
 * 确认字段名、富文本格式、record_id 这些容易出错的地方都对得上。
 *
 * 用法：node smoke.js
 *
 * 它会往「设置」表写一条临时记录，验证完立刻删掉。跑来跑去是安全的。
 */

const fs = require('node:fs');
const path = require('node:path');
const feishu = require('./lib/feishu');
const store = require('./lib/store');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TEST_KEY = '__smoke_test__';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.log('  ✗ ' + label + (detail ? '  →  ' + detail : ''));
  }
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.bitableAppToken) {
    console.error('config.json 里还没有 bitableAppToken，先跑 node init-base.js');
    process.exit(1);
  }
  console.log('多维表格：' + feishu.baseUrl(cfg.bitableAppToken));

  // ---- 1. 读路径：六张表都能列出来 ----
  console.log('\n[1] 读出六张表（后端启动时走的就是这条路径）');
  const tableIds = {};
  for (const name of store.STORES) {
    const tables = await feishu.listTables(cfg, cfg.bitableAppToken);
    const wanted = store.tableName(name);
    const hit = tables.find(function (t) { return t.name === wanted; });
    check('找得到「' + wanted + '」', !!hit, hit ? '' : '表不存在');
    if (hit) tableIds[name] = hit.table_id;
  }
  const tableId = tableIds.settings;
  if (!tableId) {
    console.log('\n「设置」表不存在，后面的写测试跳过。');
    process.exit(1);
  }

  // ---- 2. 清场：确认没有上次残留 ----
  console.log('\n[2] 清掉上次可能残留的测试数据');
  const existing = await feishu.listRecords(cfg, cfg.bitableAppToken, tableId);
  const leftovers = existing.filter(function (r) {
    return store.readText((r.fields || {})[store.FIELD.KEY]) === TEST_KEY;
  });
  if (leftovers.length) {
    await feishu.batchDelete(cfg, cfg.bitableAppToken, tableId,
      leftovers.map(function (r) { return r.record_id; }));
    console.log('  清掉了 ' + leftovers.length + ' 条残留');
  } else {
    console.log('  没有残留，干净');
  }

  // ---- 3. 写路径：写一条进去，拿到 record_id ----
  console.log('\n[3] 写一条测试记录');
  const row = { key: TEST_KEY, value: { hello: '物资管理', n: 42, 中文键: '值' } };
  const nowIso = new Date().toISOString();
  const created = await feishu.batchCreate(cfg, cfg.bitableAppToken, tableId, [
    { fields: store.rowToFields('settings', row, '冒烟测试', nowIso) }
  ]);
  check('飞书返回了 record_id', !!(created[0] && created[0].record_id),
    created[0] ? JSON.stringify(created[0]).slice(0, 120) : '返回为空');
  const recordId = created[0] && created[0].record_id;

  // ---- 4. 读回来：确认整条 JSON 原样还原 ----
  console.log('\n[4] 读回来并还原成业务对象');
  const afterWrite = await feishu.listRecords(cfg, cfg.bitableAppToken, tableId);
  const mine = afterWrite.filter(function (r) {
    return store.readText((r.fields || {})[store.FIELD.KEY]) === TEST_KEY;
  });
  check('能按主键找到刚写的那条', mine.length === 1, '找到 ' + mine.length + ' 条');

  if (mine.length === 1) {
    const fields = mine[0].fields || {};
    check('「主键」列读得回来', store.readText(fields[store.FIELD.KEY]) === TEST_KEY);
    check('「摘要」列不为空', store.readText(fields[store.FIELD.LABEL]).length > 0);
    check('「操作人」列正确', store.readText(fields[store.FIELD.UPDATED_BY]) === '冒烟测试');
    const restored = store.fieldsToRow(mine[0]);
    check('「数据」列能解析回对象', !!restored);
    check('嵌套结构与中文键无损',
      !!restored && restored.value && restored.value.n === 42 && restored.value['中文键'] === '值',
      restored ? JSON.stringify(restored) : '解析失败');
  }

  // ---- 5. 更新路径 ----
  console.log('\n[5] 改一条（后端更新记录走的是这条路径）');
  if (recordId) {
    const changed = Object.assign({}, row, { value: { hello: '改过了', n: 43 } });
    await feishu.batchUpdate(cfg, cfg.bitableAppToken, tableId, [
      { record_id: recordId, fields: store.rowToFields('settings', changed, '冒烟测试', new Date().toISOString()) }
    ]);
    const afterUpdate = await feishu.listRecords(cfg, cfg.bitableAppToken, tableId);
    const updated = afterUpdate
      .map(function (r) { return store.fieldsToRow(r); })
      .filter(function (r) { return r && r.key === TEST_KEY; });
    check('改动生效', updated.length === 1 && updated[0].value.n === 43,
      updated.length ? JSON.stringify(updated[0]) : '找不到');
  }

  // ---- 6. 删除路径 ----
  console.log('\n[6] 删掉测试记录，恢复原状');
  const toDelete = (await feishu.listRecords(cfg, cfg.bitableAppToken, tableId))
    .filter(function (r) {
      return store.readText((r.fields || {})[store.FIELD.KEY]) === TEST_KEY;
    })
    .map(function (r) { return r.record_id; });
  if (toDelete.length) {
    await feishu.batchDelete(cfg, cfg.bitableAppToken, tableId, toDelete);
  }
  const finalList = await feishu.listRecords(cfg, cfg.bitableAppToken, tableId);
  check('测试数据已清干净', finalList.filter(function (r) {
    return store.readText((r.fields || {})[store.FIELD.KEY]) === TEST_KEY;
  }).length === 0);

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n[冒烟测试中断] ' + (err && err.message ? err.message : err));
  if (err && err.payload) console.error(JSON.stringify(err.payload).slice(0, 600));
  process.exit(1);
});
