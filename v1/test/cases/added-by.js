/**
 * 添加人姓名（第二十三轮）。
 *
 * 起因：直接添加物品时**没有"谁加的"这一项** —— 代码里写死成「前台登记」，
 * 流水上永远记着这个假名字。现在改成人填（默认带出当前登录人），
 * 并记到物品行（addedBy）与这次入库的流水上。
 *
 * 顺带钉住金额/日期的校验规则：入库与编辑物品共用 Rules 里那一份，
 * 不许各写一份（否则必然出现"一边拦得住、一边塞得进"）。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  test('直接入库：添加人记到物品行上（不是只记流水）', async () => {
    await fresh();
    const res = await Ops.inbound({
      categoryId: 'mechanical', name: '步进电机', troop: '重装',
      quantity: 2, operator: '张三', identityMode: 'shared'
    });
    const item = await DB.get('items', res.codes[0]);
    assertEqual(item.addedBy, '张三', '物品详情要能看到"谁加的"，所以必须记在物品行上');

    const txns = await DB.getAll('transactions');
    const inboundTxn = txns.filter((t) => t.itemCode === item.code && t.type === 'inbound')[0];
    assertEqual(inboundTxn.operator, '张三', '流水上的操作人也得是真人');
  });

  test('添加人不能是空的（原来会静默写成「前台登记」）', async () => {
    await fresh();
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: 'x', troop: '重装', quantity: 1, identityMode: 'shared'
    }), '缺添加人必须被拒，不许兜一个假名字');
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: 'x', troop: '重装', quantity: 1,
      identityMode: 'shared', operator: '   '
    }), '只填空格也算没填');
  });

  test('采购到货入库同样记添加人（另一条入库路径）', async () => {
    await fresh();
    // createRequest 返回的就是新建申请的 id（数字），不是对象
    const reqId = await Ops.createRequest({
      categoryId: 'mechanical', name: '采购件', troop: '哨兵',
      quantity: 1, applicant: '李四', operator: '李四'
    });
    await Ops.approveRequests([reqId]);
    const arrived = await Ops.arrive({
      requestId: reqId, quantity: 1, operator: '王五', identityMode: 'shared',
      invoiceNo: 'FP-2026-001', amount: 88, supplier: '某公司', invoiceDate: '2026-09-20'
    });
    const item = await DB.get('items', arrived.codes[0]);
    assertEqual(item.addedBy, '王五', '点「确认到货」的人也要被记下来');
  });

  test('老数据没有 addedBy：不许被补成假名字', async () => {
    await fresh();
    const cat = await DB.get('categories', 'mechanical');
    const codes = await Rules.nextCodes(cat, 1);
    const now = DB.nowIso();
    await DB.add('items', {
      code: codes[0], name: '老件', spec: '', categoryId: 'mechanical', location: '',
      troop: '重装', identityMode: 'shared', totalQty: 1, inStockQty: 1, lentQty: 0,
      repairQty: 0, usedUpQty: 0, status: 'in_stock', safetyStock: null,
      remark: '', extra: {}, purchaseRequestId: null, invoiceId: null,
      createdAt: now, updatedAt: now
    });
    const item = await DB.get('items', codes[0]);
    assertEqual(item.addedBy, undefined, '界面上写「未记录」就够了，别塞一个编的名字');
  });

  /* ---------- 金额 / 日期：入库与编辑共用同一份规则 ---------- */

  test('金额校验：空 → null；0 与正数收下；负数与非数字被拒', async () => {
    assertEqual(Rules.parseOptionalPrice('').value, null);
    assertEqual(Rules.parseOptionalPrice(null).value, null);
    assertEqual(Rules.parseOptionalPrice(undefined).value, null);
    assertEqual(Rules.parseOptionalPrice('   ').value, null, '只有空格也算空');
    assertEqual(Rules.parseOptionalPrice('0').value, 0, '0 是合法金额（免费拿到的也算记着）');
    assertEqual(Rules.parseOptionalPrice('38.60').value, 38.6);
    assertEqual(Rules.parseOptionalPrice('-1').ok, false, '负数不许');
    assertEqual(Rules.parseOptionalPrice('abc').ok, false, '非数字不许');
    assert(Rules.parseOptionalPrice('-1').message.indexOf('不小于 0') !== -1, '要说清怎么改');
  });

  test('日期校验：空 → 空字符串；填了原样收下', async () => {
    assertEqual(Rules.parseOptionalDate('').value, '');
    assertEqual(Rules.parseOptionalDate(null).value, '');
    assertEqual(Rules.parseOptionalDate('2026-10-07').value, '2026-10-07');
    assertEqual(Rules.parseOptionalDate(' 2026-10-07 ').value, '2026-10-07', '前后空格要去掉');
  });

  test('入库把非法金额挡在外面（走的是同一份规则）', async () => {
    await fresh();
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: 'x', troop: '重装', quantity: 1,
      identityMode: 'shared', operator: '张三', totalPrice: '-5'
    }), '负数金额必须被拒');
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: 'x', troop: '重装', quantity: 1,
      identityMode: 'shared', operator: '张三', totalPrice: '乱写的'
    }), '非数字金额必须被拒');
  });

  test('入库后 totalPrice / purchaseDate 按规则存下来', async () => {
    await fresh();
    const res = await Ops.inbound({
      categoryId: 'mechanical', name: '带价件', troop: '重装', quantity: 1,
      identityMode: 'shared', operator: '张三', totalPrice: '38.60', purchaseDate: ' 2026-09-01 '
    });
    const item = await DB.get('items', res.codes[0]);
    assertEqual(item.totalPrice, 38.6);
    assertEqual(item.purchaseDate, '2026-09-01');
    assertEqual(item.addedBy, '张三');
  });
};