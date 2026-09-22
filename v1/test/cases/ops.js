/** 入库、借出、归还、领用、送修、修好回库、采购到货 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertDeepEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  async function addItem(over) {
    const cat = await DB.get('categories', 'mechanical');
    const codes = await Rules.nextCodes(cat, 1);
    const code = over.code || codes[0];
    const item = Object.assign({
      code, name: '测试件', spec: '', categoryId: 'mechanical', location: 'A区',
      identityMode: 'shared', totalQty: 10, inStockQty: 10, lentQty: 0,
      repairQty: 0, usedUpQty: 0, status: 'in_stock', safetyStock: 3,
      remark: '', extra: {}, purchaseRequestId: null, invoiceId: null,
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    }, over, { code });
    await DB.put('items', item);
    return item;
  }

  test('入库按单独建身份模式生成多个独立身份', async () => {
    await fresh();
    const res = await Ops.inbound({
      categoryId: 'vision', name: '工业相机', quantity: 3,
      identityMode: 'single', operator: '张三', location: '器材柜'
    });
    assertEqual(res.items.length, 3, '3 件应生成 3 个身份');
    res.items.forEach((i) => {
      assertEqual(i.totalQty, 1, '单独建身份的每件数量为 1');
      assertEqual(i.identityMode, 'single');
    });
    assertDeepEqual(res.codes, ['VS-0001', 'VS-0002', 'VS-0003']);
  });

  test('入库按同款共用模式只生成一个身份并记件数', async () => {
    await fresh();
    const res = await Ops.inbound({
      categoryId: 'mechanical', name: 'M4螺丝', quantity: 100,
      identityMode: 'shared', operator: '张三', safetyStock: 20
    });
    assertEqual(res.items.length, 1, '同款共用只生成一个身份');
    assertEqual(res.items[0].totalQty, 100);
    assertEqual(res.items[0].inStockQty, 100);
    assertEqual(res.items[0].code, 'MC-0001');
  });

  test('入库会写一条入库流水', async () => {
    await fresh();
    await Ops.inbound({ categoryId: 'mechanical', name: '轴承', quantity: 4, identityMode: 'shared', operator: '李四' });
    const txns = await DB.getAll('transactions');
    assertEqual(txns.length, 1);
    assertEqual(txns[0].type, 'inbound');
    assertEqual(txns[0].qty, 4);
    assertEqual(txns[0].operator, '李四');
  });

  test('入库缺少名称或操作人会被拒绝', async () => {
    await fresh();
    await assertRejects(() => Ops.inbound({ categoryId: 'mechanical', quantity: 1, operator: '张三' }), '缺名称应拒绝');
    await assertRejects(() => Ops.inbound({ categoryId: 'mechanical', name: 'x', quantity: 1 }), '缺操作人应拒绝');
    await assertRejects(() => Ops.inbound({ categoryId: 'mechanical', name: 'x', quantity: 0, operator: '张三' }), '数量 0 应拒绝');
    await assertRejects(() => Ops.inbound({ categoryId: 'mechanical', name: 'x', quantity: 1.5, operator: '张三' }), '小数应拒绝');
  });

  test('校验失败返回的是 Promise 拒绝而不是同步抛错', async () => {
    await fresh();
    // 界面代码统一写 Ops.xxx().catch(...)，所以校验失败必须能以 Promise 拒绝的形式被接到，
    // 否则界面上不会出现任何提示，控制台还会留下未捕获错误。
    const returnsPromise = Ops.arrive({
      requestId: 1, quantity: 1, invoiceNo: '', amount: 10, operator: ''
    });
    assert(returnsPromise && typeof returnsPromise.then === 'function', '应返回 Promise');
    let caught = null;
    await returnsPromise.catch((err) => { caught = err; });
    assert(caught, '应能以 catch 接到错误');
    assertEqual(caught.userMessage, '操作人不能为空', '应给出可直接展示给使用者的提示');

    let caught2 = null;
    await Ops.inbound({ categoryId: 'mechanical', quantity: 1, operator: '张三' })
      .catch((err) => { caught2 = err; });
    assert(caught2, '入库校验失败也应能以 catch 接到');
    assertEqual(caught2.userMessage, '物品名称不能为空');
  });

  test('借出后状态与数量正确并写入台账', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    const res = await Ops.lend({ code: 'MC-0001', qty: 3, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    assertEqual(res.item.inStockQty, 7);
    assertEqual(res.item.lentQty, 3);
    const ledger = await Ops.lendLedger(new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(ledger.length, 1, '台账应有一条在借');
    assertEqual(ledger[0].borrower, '李四');
    assertEqual(ledger[0].qty, 3);
    assertEqual(ledger[0].overdue, false);
  });

  test('借出超过在库数量会被拒绝且不留痕', async () => {
    await fresh();
    await addItem({ code: 'MC-0001', totalQty: 2, inStockQty: 2 });
    const before = (await DB.getAll('transactions')).length;
    await assertRejects(() => Ops.lend({ code: 'MC-0001', qty: 5, operator: '张三', borrower: '李四', dueDate: '2026-09-30' }));
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.inStockQty, 2, '被拒后库存不应变化');
    assertEqual((await DB.getAll('transactions')).length, before, '被拒后不应写流水');
  });

  test('借出缺少借用人或归还日期会被拒绝', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await assertRejects(() => Ops.lend({ code: 'MC-0001', qty: 1, operator: '张三', dueDate: '2026-09-30' }), '缺借用人应拒绝');
    await assertRejects(() => Ops.lend({ code: 'MC-0001', qty: 1, operator: '张三', borrower: '李四' }), '缺归还日期应拒绝');
  });

  test('归还后台账清空且流水增加', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 3, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    const res = await Ops.giveBack({ code: 'MC-0001', operator: '李四' });
    assertEqual(res.item.inStockQty, 10);
    assertEqual(res.item.lentQty, 0);
    assertEqual((await Ops.lendLedger()).length, 0, '归还后台账应清空');
    const txns = await DB.getAll('transactions');
    assertEqual(txns.length, 2);
    assertEqual(txns.map((t) => t.type).sort().join(','), 'lend,return');
  });

  test('部分归还后台账只记剩余数量', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 5, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    await Ops.giveBack({ code: 'MC-0001', qty: 2, operator: '李四' });
    const ledger = await Ops.lendLedger();
    assertEqual(ledger.length, 1);
    assertEqual(ledger[0].qty, 3, '还剩 3 件未还');
  });

  test('同一件东西借给两个人，台账要两笔都在（不是只剩后借的那个）', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 3, operator: '张三', borrower: '先借的人', dueDate: '2026-09-25' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '后借的人', dueDate: '2026-09-28' });

    const item = await DB.get('items', 'MC-0001');
    const ledger = await Ops.lendLedger(new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(ledger.length, 2, '两个人各借一次，台账要有两笔，实际 ' + ledger.length + ' 笔');
    assertEqual(ledger.map((r) => r.borrower).sort().join(','), '先借的人,后借的人',
      '两个借用人都要在台账里，实际：' + ledger.map((r) => r.borrower).join('、'));
    assertEqual(ledger.reduce((s, r) => s + r.qty, 0), item.lentQty,
      '台账里未还的件数之和要等于物品上的借出件数');
  });

  test('归还先把最早那笔冲掉，剩下后借的那笔仍在台账上', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 3, operator: '张三', borrower: '早借的', dueDate: '2026-09-25' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '晚借的', dueDate: '2026-09-28' });
    await Ops.giveBack({ code: 'MC-0001', qty: 3, operator: '李四' });

    const ledger = await Ops.lendLedger();
    assertEqual(ledger.length, 1, '还清一笔后应只剩一笔，实际 ' + ledger.length + ' 笔');
    assertEqual(ledger[0].borrower, '晚借的', '先借的先还，剩下的应是后借的那笔');
    assertEqual(ledger[0].qty, 2);
  });

  test('一次归还跨过好几笔借出（把几个人的一起收回来）', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '甲', dueDate: '2026-09-25' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '乙', dueDate: '2026-09-26' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '丙', dueDate: '2026-09-27' });
    await Ops.giveBack({ code: 'MC-0001', qty: 5, operator: '李四' });

    const ledger = await Ops.lendLedger();
    assertEqual(ledger.length, 1, '还掉 5 件后应只剩 1 件未还，实际 ' + ledger.length + ' 笔');
    assertEqual(ledger[0].borrower, '丙', '先借先还，剩下的应是最后那笔的一部分');
    assertEqual(ledger[0].qty, 1);
  });

  test('到期日相同也按借出先后排，页面顺序不会随机跳', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 1, operator: '张三', borrower: '第一个', dueDate: '2026-09-30' });
    await Ops.lend({ code: 'MC-0001', qty: 1, operator: '张三', borrower: '第二个', dueDate: '2026-09-30' });

    const ledger = await Ops.lendLedger(new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(ledger.map((r) => r.borrower).join(','), '第一个,第二个',
      '同一天到期的应按借出先后排，实际：' + ledger.map((r) => r.borrower).join('、'));
  });

  test('超期借用会标出超期天数并排在前面', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await addItem({ code: 'MC-0002' });
    await Ops.lend({ code: 'MC-0001', qty: 1, operator: '张三', borrower: '王五', dueDate: '2026-09-25' });
    await Ops.lend({ code: 'MC-0002', qty: 1, operator: '张三', borrower: '赵六', dueDate: '2026-09-20' });
    const ledger = await Ops.lendLedger(new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(ledger[0].itemCode, 'MC-0002', '超期的应排在最前');
    assertEqual(ledger[0].overdue, true);
    assertEqual(ledger[0].overdueDays, 1);
    assertEqual(ledger[1].overdue, false);
  });

  test('归还数量超过借出数量会被拒绝', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    await assertRejects(() => Ops.giveBack({ code: 'MC-0001', qty: 3, operator: '李四' }));
    assertEqual((await DB.get('items', 'MC-0001')).lentQty, 2, '被拒后数量不变');
  });

  test('领用按件数扣减库存并累计已领用', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    const res = await Ops.consume({ code: 'MC-0001', qty: 3, operator: '张三', purpose: '装配用' });
    assertEqual(res.item.inStockQty, 7);
    assertEqual(res.item.usedUpQty, 3);
    assertEqual(res.item.totalQty, 10, '领用不改变总件数');
  });

  test('领用超过在库会被拒绝', async () => {
    await fresh();
    await addItem({ code: 'MC-0001', totalQty: 2, inStockQty: 2 });
    await assertRejects(() => Ops.consume({ code: 'MC-0001', qty: 3, operator: '张三' }));
  });

  test('领用完后状态变为已用完', async () => {
    await fresh();
    await addItem({ code: 'MC-0001', totalQty: 3, inStockQty: 3 });
    const res = await Ops.consume({ code: 'MC-0001', qty: 3, operator: '张三' });
    assertEqual(res.item.status, 'used_up');
    assertEqual(res.item.inStockQty, 0);
  });

  test('送修与修好回库的状态与数量正确', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    const sent = await Ops.sendRepair({ code: 'MC-0001', qty: 2, operator: '张三', purpose: '电机异响' });
    assertEqual(sent.item.inStockQty, 8);
    assertEqual(sent.item.repairQty, 2);
    const back = await Ops.repairDone({ code: 'MC-0001', operator: '张三' });
    assertEqual(back.item.inStockQty, 10);
    assertEqual(back.item.repairQty, 0);
    assertEqual(back.item.status, 'in_stock');
  });

  test('全部送修时状态为损坏待修', async () => {
    await fresh();
    await addItem({ code: 'MC-0001', identityMode: 'single', totalQty: 1, inStockQty: 1 });
    const res = await Ops.sendRepair({ code: 'MC-0001', qty: 1, operator: '张三', purpose: '摔坏' });
    assertEqual(res.item.status, 'repairing');
    assertEqual(res.item.inStockQty, 0);
  });

  test('找不到编码时给出明确提示且不写流水', async () => {
    await fresh();
    const before = (await DB.getAll('transactions')).length;
    let msg = '';
    try {
      await Ops.lend({ code: 'MC-9999', qty: 1, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    } catch (e) { msg = e.message; }
    assert(/未找到/.test(msg), '应提示未找到，实际：' + msg);
    assertEqual((await DB.getAll('transactions')).length, before, '不应写流水');
  });

  test('串行操作后库存恒等式始终成立', async () => {
    await fresh();
    await addItem({ code: 'MC-0001', totalQty: 10, inStockQty: 10 });
    await Ops.lend({ code: 'MC-0001', qty: 2, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    await Ops.consume({ code: 'MC-0001', qty: 3, operator: '张三' });
    await Ops.sendRepair({ code: 'MC-0001', qty: 1, operator: '张三', purpose: '烧了' });
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.inStockQty + item.lentQty + item.repairQty + item.usedUpQty, item.totalQty, '四类数量之和应等于总数');
    assertEqual(item.inStockQty, 4);
  });

  test('流水只追加，不因后续操作被改写', async () => {
    await fresh();
    await addItem({ code: 'MC-0001' });
    await Ops.lend({ code: 'MC-0001', qty: 3, operator: '张三', borrower: '李四', dueDate: '2026-09-30' });
    const first = (await DB.getAll('transactions'))[0];
    await Ops.giveBack({ code: 'MC-0001', operator: '李四' });
    await Ops.consume({ code: 'MC-0001', qty: 1, operator: '张三' });
    const again = (await DB.get('transactions', first.id));
    assertEqual(again.type, 'lend');
    assertEqual(again.qty, 3, '历史流水不应被改写');
    assertEqual((await DB.getAll('transactions')).length, 3, '每次操作都追加一条');
  });

  test('采购到货自动入库并生成发票与流水', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'vision', name: '工业相机', spec: '500万', quantity: 2, budget: 6000,
      purpose: '色块识别', applicant: '张三', status: 'ordered',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    const res = await Ops.arrive({
      requestId: reqId, quantity: 2, location: '器材柜A',
      invoiceNo: 'FP-2026-001', amount: 5880, supplier: '某视觉公司',
      invoiceDate: '2026-09-20', operator: '李四'
    });
    assertEqual(res.items.length, 2, '视觉类默认单独建身份');
    res.items.forEach((i) => {
      assertEqual(i.status, 'in_stock');
      assertEqual(i.purchaseRequestId, reqId, '物品应挂上来源申请');
      assertEqual(i.invoiceId, res.invoiceId, '物品应挂上来源发票');
    });
    const req = await DB.get('purchaseRequests', reqId);
    assertEqual(req.status, 'arrived', '申请应标记为已到货');
    const inv = await DB.get('invoices', res.invoiceId);
    assertEqual(inv.invoiceNo, 'FP-2026-001');
    assertEqual(inv.supplier, '某视觉公司');
    assertEqual(inv.amount, 5880);
    assertEqual(inv.purchaseRequestId, reqId);
    const txns = await DB.getAll('transactions');
    assertEqual(txns.length, 2, '每件物品一条入库流水');
    assertEqual(txns[0].invoiceId, res.invoiceId);
  });

  test('采购到货可以指定同款共用模式', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'hardware', name: '扎带', quantity: 500, budget: 50,
      purpose: '理线', applicant: '张三', status: 'ordered',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    const res = await Ops.arrive({
      requestId: reqId, quantity: 500, identityMode: 'shared',
      invoiceNo: 'FP-002', amount: 45, supplier: '五金店', operator: '李四'
    });
    assertEqual(res.items.length, 1);
    assertEqual(res.items[0].totalQty, 500);
    assertEqual(res.items[0].code, 'HW-0001');
  });

  test('重复确认到货会被拒绝', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'hardware', name: '扎带', quantity: 10, budget: 5,
      purpose: 'x', applicant: '张三', status: 'ordered',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    await Ops.arrive({ requestId: reqId, quantity: 10, invoiceNo: 'FP-1', amount: 5, supplier: '五金店', operator: '李四' });
    await assertRejects(() => Ops.arrive({
      requestId: reqId, quantity: 10, invoiceNo: 'FP-2', amount: 5, supplier: '五金店', operator: '李四'
    }), '重复到货应被拒绝');
    assertEqual((await DB.getAll('invoices')).length, 1, '不应产生第二张发票');
  });

  test('到货时缺金额或缺操作人仍会被拒绝且不生成物品（发票号/供应商已选填）', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'hardware', name: '扎带', quantity: 10, budget: 5,
      purpose: 'x', applicant: '张三', status: 'ordered',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    // 第十三轮：发票号与供应商不再必填 —— 但金额、操作人这类老校验一个都不能松
    await assertRejects(() => Ops.arrive({ requestId: reqId, quantity: 10, amount: 0, operator: '李四' }), '金额为 0 应拒绝');
    await assertRejects(() => Ops.arrive({ requestId: reqId, quantity: 10, amount: 5, operator: '' }), '缺操作人应拒绝');
    assertEqual((await DB.getAll('items')).length, 0, '被拒后不应生成物品');
    assertEqual((await DB.getAll('invoices')).length, 0, '被拒后不应生成发票');
    assertEqual((await DB.get('purchaseRequests', reqId)).status, 'ordered', '申请状态不应改变');
  });

  test('到货中途失败不会留下半套数据', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'vision', name: '镜头', quantity: 2, budget: 4000,
      purpose: 'x', applicant: '张三', status: 'ordered',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    // 数量为小数，会在生成物品阶段失败，此时发票已尝试写入
    await assertRejects(() => Ops.arrive({
      requestId: reqId, quantity: 2.5, invoiceNo: 'FP-X', amount: 4000, supplier: '某公司', operator: '李四'
    }));
    assertEqual((await DB.getAll('invoices')).length, 0, '失败后不应留下发票');
    assertEqual((await DB.getAll('items')).length, 0, '失败后不应留下物品');
    assertEqual((await DB.get('purchaseRequests', reqId)).status, 'ordered');
  });

  test('删除上游采购申请后物品与流水仍可查', async () => {
    await fresh();
    const reqId = await DB.add('purchaseRequests', {
      categoryId: 'hardware', name: '扎带', quantity: 10, budget: 5,
      purpose: 'x', applicant: '张三', status: 'ordered',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    const res = await Ops.arrive({ requestId: reqId, quantity: 10, invoiceNo: 'FP-9', amount: 5, supplier: '五金店', operator: '李四' });
    await DB.remove('purchaseRequests', reqId);
    const item = await DB.get('items', res.codes[0]);
    assert(item, '删掉申请后物品仍应存在');
    assertEqual(item.purchaseRequestId, reqId, '物品仍保留来源申请编号，界面显示「来源已删除」');
    const missing = await DB.get('purchaseRequests', reqId);
    assertEqual(missing, undefined, '申请确实已删除');
    assertEqual((await DB.getAll('transactions')).length, 1, '流水不受影响');
  });
};
