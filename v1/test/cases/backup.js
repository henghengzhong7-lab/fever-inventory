/** 备份导出与导入恢复 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual, assertDeepEqual, assertRejects } = H;

  async function seed() {
    await Rules.clearAll();
    await Rules.initCategories();
    await DB.add('items', {
      code: 'MC-0001', name: '步进电机', spec: '42BYGH', categoryId: 'mechanical',
      identityMode: 'shared', totalQty: 5, inStockQty: 5, lentQty: 0, repairQty: 0,
      usedUpQty: 0, status: 'in_stock', extra: { material: '铝' },
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
    });
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'vision', name: '工业相机', spec: '500万', quantity: 1, budget: 3000,
      purpose: '识别', applicant: '张三', status: 'arrived',
      createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z'
    });
    const invId = await DB.add('invoices', {
      purchaseRequestId: reqId, invoiceNo: 'FP-123', amount: 2980, supplier: '某供应商',
      invoiceDate: '2026-09-02', createdAt: '2026-09-02T00:00:00.000Z'
    });
    await DB.add('transactions', {
      itemCode: 'MC-0001', type: 'inbound', qty: 5, operator: '李四',
      createdAt: '2026-09-01T00:00:00.000Z'
    });
    await DB.setSetting('lastBackupAt', '2026-09-20T00:00:00.000Z');
    return { reqId, invId };
  }

  test('导出备份包含全部表与版本号', async () => {
    await seed();
    const payload = await Rules.exportAll();
    assertEqual(payload.formatVersion, DB.FORMAT_VERSION, '应带格式版本号');
    assert(payload.exportedAt, '应带导出时间');
    DB.STORES.forEach((name) => {
      assert(Array.isArray(payload.data[name]), '备份应包含表 ' + name);
    });
    assertEqual(payload.data.items.length, 1);
    assertEqual(payload.data.invoices.length, 1);
    assertEqual(payload.data.transactions.length, 1);
    assertEqual(payload.counts.categories, 4);
  });

  test('导入后各表条数与内容与导出前一致', async () => {
    const payload = await Rules.exportAll();
    const counts = payload.counts;
    await Rules.clearAll();
    assertEqual((await DB.getAll('items')).length, 0, '清空后应为 0');
    const res = await Rules.importAll(payload);
    assert(res.ok, '导入应成功');
    DB.STORES.forEach((name) => {
      assertEqual(res.counts[name], counts[name], name + ' 恢复条数应一致');
    });
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.name, '步进电机');
    assertDeepEqual(item.extra, { material: '铝' });
    assertEqual((await DB.getSetting('lastBackupAt')), '2026-09-20T00:00:00.000Z');
  });

  test('导入非法文件会被拒绝且不改动现有数据', async () => {
    await seed();
    const before = (await DB.getAll('items')).length;
    await assertRejects(() => Rules.importAll({ nope: true }), '缺少 data 应被拒绝');
    await assertRejects(() => Rules.importAll({ data: { items: [] } }), '缺表应被拒绝');
    assertEqual((await DB.getAll('items')).length, before, '被拒后数据不应变化');
  });

  test('导入过程中出错会整体回滚', async () => {
    const payload = await Rules.exportAll();
    await seed();
    const before = await DB.getAll('items');
    // 人为塞一条坏数据（items 主键为 code，缺失会让 put 抛错）
    const broken = JSON.parse(JSON.stringify(payload));
    broken.data.items.push({ name: '没有主键的物品' });
    await assertRejects(() => Rules.importAll(broken), '坏数据应导致导入失败');
    const after = await DB.getAll('items');
    assertEqual(after.length, before.length, '失败后应回滚，条数不变');
    assertEqual(after[0].code, 'MC-0001', '失败后原有数据应完好');
  });

  test('导出导入能往返保持流水完整', async () => {
    await seed();
    const payload = await Rules.exportAll();
    await Rules.importAll(payload);
    const txns = await DB.getAll('transactions');
    assertEqual(txns.length, 1);
    assertEqual(txns[0].type, 'inbound');
    assertEqual(txns[0].operator, '李四');
  });

  /* ---------- 备份提醒：超过 7 天没备份要提醒 ---------- */

  test('从没备份过就要提醒，且不知道多少天', async () => {
    const r = Rules.backupReminder(null, new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(r.need, true);
    assertEqual(r.days, null);
  });

  test('刚备份过不提醒', async () => {
    const r = Rules.backupReminder('2026-09-21T00:00:00.000Z', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(r.need, false);
    assertEqual(r.days, 0);
  });

  test('第 7 天是边界，不到 7 天不提醒', async () => {
    const today = new Date('2026-09-21T10:00:00+08:00');
    assertEqual(Rules.backupReminder('2026-09-15T00:00:00.000Z', today).need, false, '6 天不该提醒');
    assertEqual(Rules.backupReminder('2026-09-14T00:00:00.000Z', today).need, true, '7 天应提醒');
  });

  test('超过 7 天提醒并给出天数', async () => {
    const r = Rules.backupReminder('2026-09-10T00:00:00.000Z', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(r.need, true);
    assertEqual(r.days, 11);
  });

  test('备份时间是个坏值时按"没备份过"处理，仍会提醒', async () => {
    const r = Rules.backupReminder('不是时间', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(r.need, true, '坏时间不能当成"刚备份过"而漏提醒');
  });
};
