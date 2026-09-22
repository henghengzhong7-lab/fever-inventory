/**
 * 删除与「删除记录」。
 *
 * 这套系统的硬要求是**可追溯**：出入库流水被刻意做成只追加、不可改写。
 * 后加的删除功能不能把这个前提拆掉，所以每删一条都记一笔并留下快照。
 * 这一组测的就是"删得掉，但一定查得到"这条底线没被破坏。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertDeepEqual } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  /** 造一条流水，用来验证"删物品不会连带删掉履历" */
  async function addTxn(over) {
    const now = DB.nowIso();
    const row = Object.assign({
      itemCode: 'MC-0001', itemName: '步进电机', type: 'inbound', qty: 2,
      operator: '前台登记', createdAt: now
    }, over);
    const id = await DB.add('transactions', row);
    return Object.assign({ id }, row);
  }

  test('没有删除记录时返回空数组，而不是 null / undefined', async () => {
    await fresh();
    const list = await Rules.getDeleteLog();
    assert(Array.isArray(list), '应当拿到数组，实际：' + JSON.stringify(list));
    assertEqual(list.length, 0);
  });

  test('删除记录最多留 300 条', async () => {
    assertEqual(Rules.DELETE_LOG_MAX, 300);
  });

  test('离线版的操作人如实写「本机操作」，不编一个假名字', async () => {
    await fresh();
    assertEqual(Rules.currentActor(), '本机操作');
  });

  test('记一条删除：时间、操作人、类型、对象、快照都要在', async () => {
    await fresh();
    const snapshot = { code: 'MC-0001', name: '步进电机', totalQty: 2, inStockQty: 2 };
    const row = await Rules.logDeletion({
      store: 'items', key: 'MC-0001', label: 'MC-0001 步进电机', snapshot
    });

    assert(row, 'logDeletion 应当返回记下的那一条（返回 null 表示没写成功）');
    assertEqual(row.store, 'items');
    assertEqual(row.key, 'MC-0001');
    assertEqual(row.by, '本机操作');
    assert(!!row.at && !isNaN(new Date(row.at).getTime()), 'at 要是合法时间：' + row.at);
    assertEqual(row.label, '物品 MC-0001 步进电机', 'label 应当带上类型前缀，界面直接用');
    assertDeepEqual(row.snapshot, snapshot, '快照必须原样保留，它是唯一能还原被删内容的依据');

    const list = await Rules.getDeleteLog();
    assertEqual(list.length, 1, '应当真的写进 settings 了（这一条以前是"静默失败"的）');
    assertEqual(list[0].key, 'MC-0001');
  });

  test('认不出来的表名不丢账：类型位置回退成原值', async () => {
    await fresh();
    await Rules.logDeletion({ store: 'somethingElse', key: 'x1', label: 'x1' });
    const list = await Rules.getDeleteLog();
    assertEqual(list.length, 1);
    assertEqual(list[0].label, 'somethingElse x1', '认不出类型时也要把它记下来，不能吞掉');
  });

  test('没传快照时记成 null，而不是 undefined（要能序列化进备份）', async () => {
    await fresh();
    await Rules.logDeletion({ store: 'items', key: 'MC-0009' });
    const list = await Rules.getDeleteLog();
    assertEqual(list[0].snapshot, null);
    assertEqual(JSON.parse(JSON.stringify(list[0])).snapshot, null);
  });

  test('超过 300 条时挤掉最老的，只留最近 300 条', async () => {
    await fresh();
    for (let i = 1; i <= 305; i += 1) {
      await Rules.logDeletion({ store: 'items', key: 'MC-' + i, label: '第 ' + i + ' 件' });
    }
    const list = await Rules.getDeleteLog();
    assertEqual(list.length, 300, '上限是 300 条');
    assertEqual(list[0].key, 'MC-6', '最早那几条应当被挤掉');
    assertEqual(list[list.length - 1].key, 'MC-305', '最新一条要在最后');
  });

  test('还有实物借在外面 / 待修时不许删物品', async () => {
    const lent = Rules.blockItemDeletion({ code: 'MC-0001', lentQty: 2, repairQty: 0 });
    assert(lent, '借出中的物品应当被拦住');
    assert(/借/.test(lent) && /2/.test(lent), '理由要说清借出去几件，实际：' + lent);

    const repairing = Rules.blockItemDeletion({ code: 'MC-0002', lentQty: 0, repairQty: 1 });
    assert(repairing, '待修中的物品应当被拦住');
    assert(/待修|修/.test(repairing), '理由要说清是待修，实际：' + repairing);
  });

  test('只在库里的（含已领用/已用完）可以删', async () => {
    assertEqual(Rules.blockItemDeletion({ code: 'MC-0001', inStockQty: 3, lentQty: 0, repairQty: 0, usedUpQty: 0 }), null);
    assertEqual(Rules.blockItemDeletion({ code: 'MC-0002', inStockQty: 0, lentQty: 0, repairQty: 0, usedUpQty: 5 }), null,
      '已经领用完的不影响追踪，应当能删');
    assert(Rules.blockItemDeletion(null), '找不到物品时也要给个说法，不能静默放行');
  });

  test('删掉物品之后，它的出入库履历还在（流水只追加这条底线不破）', async () => {
    await fresh();
    const item = {
      code: 'MC-0001', categoryId: 'mechanical', name: '步进电机', spec: '',
      identityMode: 'shared', totalQty: 2, inStockQty: 2, lentQty: 0, repairQty: 0,
      usedUpQty: 0, status: 'in_stock', createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    };
    await DB.put('items', item);
    const txn = await addTxn({});

    // 走 deleteRecord 的两步：先删，再记一笔（快照就是删之前的整条记录）
    await DB.remove('items', 'MC-0001');
    await Rules.logDeletion({ store: 'items', key: 'MC-0001', label: 'MC-0001 步进电机', snapshot: item });

    assertEqual(await DB.get('items', 'MC-0001'), undefined, '物品身份应当没了');
    const txnBack = await DB.get('transactions', txn.id);
    assert(txnBack, '流水不能被连带删掉 —— 已经记下的履历必须留着');
    assertEqual(txnBack.itemCode, 'MC-0001', '流水里仍然写着它的编码，还能追到是哪件');

    const list = await Rules.getDeleteLog();
    assertEqual(list.length, 1);
    assertDeepEqual(list[0].snapshot, item, '靠这条快照能人工把物品身份还原回来');
  });

  test('删除记录跟着备份一起导出、一起导入', async () => {
    await fresh();
    await Rules.logDeletion({ store: 'purchaseRequests', key: 7, label: '#7 备用电调', snapshot: { id: 7, name: '备用电调' } });
    const payload = await Rules.exportAll();
    assertEqual(Rules.validateBackup(payload).ok, true);
    await Rules.importAll(payload);

    const list = await Rules.getDeleteLog();
    assertEqual(list.length, 1, '导入之后删除记录必须还在 —— 它是审计账');
    assertEqual(list[0].key, '7', '键统一按字符串存，导入导出不会变形');
  });

  test('写日志失败时：主操作照旧算成功，日志不假装记上了', async () => {
    await fresh();
    const original = DB.setSetting;
    DB.setSetting = function () { return Promise.reject(new Error('模拟写盘失败')); };
    let result;
    let threw = false;
    try {
      result = await Rules.logDeletion({ store: 'items', key: 'MC-0001', label: 'x' });
    } catch (err) {
      threw = true;
    } finally {
      DB.setSetting = original;
    }
    assertEqual(threw, false, '记日志失败不该把异常抛出去（那会让已经完成的删除被报成失败）');
    assertEqual(result, null, '没记上就要如实返回 null');
    assertEqual((await Rules.getDeleteLog()).length, 0, '确实没写上');
  });

  test('clearDeleteLog 能清空（只留给测试与人工维护，界面不提供）', async () => {
    await fresh();
    await Rules.logDeletion({ store: 'items', key: 'MC-0001' });
    assertEqual((await Rules.getDeleteLog()).length, 1);
    await Rules.clearDeleteLog();
    assertEqual((await Rules.getDeleteLog()).length, 0);
  });

  test('删掉采购申请后，由它到货生成的物品和发票都还在', async () => {
    await fresh();
    const id = await Ops.createRequest({
      categoryId: 'electronic', troop: '步兵', name: '备用电调', quantity: 1,
      budget: '900', applicant: '赵六'
    });
    const req = await DB.get('purchaseRequests', id);
    req.approval = 'approved';
    await DB.put('purchaseRequests', req);
    const res = await Ops.arrive({
      requestId: id, quantity: 1, invoiceNo: 'FP-77', amount: 880,
      supplier: '某公司', operator: '李四', identityMode: 'shared'
    });

    const delReq = await DB.get('purchaseRequests', id);
    await DB.remove('purchaseRequests', id);
    await Rules.logDeletion({ store: 'purchaseRequests', key: id, label: '#' + id + ' 备用电调', snapshot: delReq });

    assertEqual(await DB.get('purchaseRequests', id), undefined, '申请应当删掉了');
    assertEqual((await DB.getAll('items')).length, res.items.length,
      '物品是实物，不该因为申请被删就跟着消失');
    assertEqual((await DB.getAll('invoices')).length, 1, '发票也要留着，它是钱花出去的凭据');
  });
};
