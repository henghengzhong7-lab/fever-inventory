/** 模块关联：统计、流水筛选、单据互查、断链提示 */
'use strict';

const Stats = require('../../js/stats.js');

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  test('四个大类的统计与明细一致', async () => {
    await fresh();
    await Ops.inbound({ categoryId: 'mechanical', name: '轴承', quantity: 10, identityMode: 'shared', operator: '张三', safetyStock: 20 });
    await Ops.inbound({ categoryId: 'vision', name: '相机', quantity: 2, identityMode: 'single', operator: '张三' });
    const sums = await Stats.categorySummaries();
    assertEqual(sums.length, 4, '应有四个大类');
    const mech = sums.find((s) => s.category.id === 'mechanical');
    const vis = sums.find((s) => s.category.id === 'vision');
    assertEqual(mech.totalQty, 10);
    assertEqual(mech.itemKinds, 1);
    assertEqual(vis.totalQty, 2);
    assertEqual(vis.itemKinds, 2, '单独建身份 2 件是两个身份');
    assertEqual(mech.lowStock, 1, '在库 10 低于安全库存 20，应算低库存');
  });

  test('大类统计随出入库实时变化', async () => {
    await fresh();
    await Ops.inbound({ categoryId: 'mechanical', name: '轴承', quantity: 10, identityMode: 'shared', operator: '张三' });
    await Ops.lend({ code: 'MC-0001', qty: 4, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    const sums = await Stats.categorySummaries();
    const mech = sums.find((s) => s.category.id === 'mechanical');
    assertEqual(mech.inStockQty, 6);
    assertEqual(mech.lentQty, 4);
    assertEqual(mech.lentKinds, 1);
  });

  test('大类统计带出本类自己的提醒', async () => {
    await fresh();
    await Ops.inbound({
      categoryId: 'vision', name: '相机', quantity: 1, identityMode: 'single', operator: '张三',
      extra: { lastCalibrationDate: '2026-01-01' }
    });
    const sums = await Stats.categorySummaries(new Date('2026-09-21T10:00:00+08:00'));
    const vis = sums.find((s) => s.category.id === 'vision');
    assert(vis.reminders.some((r) => r.kind === 'calibration'), '视觉类应带出标定提醒');
    const mech = sums.find((s) => s.category.id === 'mechanical');
    assertEqual(mech.reminders.length, 0, '机械类没有对应数据时不应有提醒');
  });

  test('流水可按类型与操作人筛选', async () => {
    await fresh();
    await Ops.inbound({ categoryId: 'mechanical', name: '轴承', quantity: 10, identityMode: 'shared', operator: '张三' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '李四', borrower: '王五', dueDate: '2026-09-30' });
    await Ops.consume({ code: 'MC-0001', qty: 1, operator: '李四', purpose: '装配' });
    const lends = await Stats.filterTransactions({ type: 'lend' });
    assertEqual(lends.length, 1);
    assertEqual(lends[0].itemName, '轴承', '流水应带出物品名称');
    const byLi = await Stats.filterTransactions({ operator: '李四' });
    assertEqual(byLi.length, 2);
    const byCode = await Stats.filterTransactions({ itemCode: 'MC-0001' });
    assertEqual(byCode.length, 3);
  });

  test('流水按时间倒序排列', async () => {
    await fresh();
    await DB.add('transactions', { itemCode: 'MC-0001', type: 'inbound', qty: 1, operator: 'A', createdAt: '2026-09-01T00:00:00.000Z' });
    await DB.add('transactions', { itemCode: 'MC-0001', type: 'lend', qty: 1, operator: 'B', createdAt: '2026-09-10T00:00:00.000Z' });
    await DB.add('transactions', { itemCode: 'MC-0001', type: 'consume', qty: 1, operator: 'C', createdAt: '2026-09-05T00:00:00.000Z' });
    const rows = await Stats.filterTransactions({});
    assertEqual(rows[0].operator, 'B', '最新的应排最前');
    assertEqual(rows[2].operator, 'A');
  });

  test('物品详情能一次拿到大类、申请、发票与履历', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'hardware', name: '扎带', quantity: 10, budget: 5, purpose: 'x',
      applicant: '张三', status: 'ordered', createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    const res = await Ops.arrive({ requestId: reqId, quantity: 10, invoiceNo: 'FP-77', amount: 5, supplier: '五金店', operator: '李四' });
    const ctx = await Stats.itemContext(res.codes[0]);
    assertEqual(ctx.category.name, '硬件');
    assertEqual(ctx.purchaseRequest.id, reqId);
    assertEqual(ctx.invoice.invoiceNo, 'FP-77');
    assertEqual(ctx.transactions.length, 1);
    assertEqual(ctx.purchaseMissing, false);
    assertEqual(ctx.invoiceMissing, false);
  });

  test('上游被删后关联查询给出「已删除」标记而不是报错', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'hardware', name: '扎带', quantity: 10, budget: 5, purpose: 'x',
      applicant: '张三', status: 'ordered', createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    const res = await Ops.arrive({ requestId: reqId, quantity: 10, invoiceNo: 'FP-88', amount: 5, supplier: '五金店', operator: '李四' });
    await DB.remove('purchaseRequests', reqId);
    const ctx = await Stats.itemContext(res.codes[0]);
    assertEqual(ctx.purchaseRequest, null);
    assertEqual(ctx.purchaseMissing, true, '应标记来源申请已删除');
    assert(ctx.invoice, '发票仍在');
    const inv = await Stats.requestOfInvoice(ctx.invoice);
    assertEqual(inv.missing, true, '从发票回查申请也应标记已删除');
  });

  test('发票能查到自己生成的物品', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'vision', name: '镜头', quantity: 2, budget: 4000, purpose: 'x',
      applicant: '张三', status: 'ordered', createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    const res = await Ops.arrive({ requestId: reqId, quantity: 2, invoiceNo: 'FP-99', amount: 4000, supplier: '某公司', operator: '李四' });
    const items = await Stats.itemsOfInvoice(res.invoiceId);
    assertEqual(items.length, 2);
    assertEqual(items.map((i) => i.code).sort().join(','), 'VS-0001,VS-0002');
  });

  test('导出表格内容包含关键列', async () => {
    await fresh();
    await Ops.inbound({ categoryId: 'mechanical', name: '轴承', quantity: 10, identityMode: 'shared', operator: '张三' });
    const data = await Stats.snapshot();
    const csv = Stats.itemsCsv(data.items, data.categories);
    assert(/编码,名称/.test(csv), '应有表头');
    assert(/轴承/.test(csv), '应含物品名称');
    assert(/机械/.test(csv), '应把大类编号换成中文名');
    const txns = await Stats.filterTransactions({});
    const tCsv = Stats.transactionsCsv(txns);
    assert(/入库/.test(tCsv), '流水类型应显示中文');
  });
};
