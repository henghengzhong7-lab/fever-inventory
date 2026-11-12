/**
 * 批量删除出入库流水（第二十一轮）。
 *
 * 与「批量删除物品」同一套做法：**整批一个事务**，删流水与写「删除记录」一起提交
 * —— 删除记录是"读当前 → 合并 → 写回"的读改写，逐条删会互相覆盖、账会丢。
 *
 * 口径上刻意与单条删除一致：**不改动物品的库存数量**。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  /** 造 n 条流水（走真实的 Ops 登记，顺带把物品数量也动起来） */
  async function seedTxns(n) {
    const ids = [];
    for (let i = 1; i <= n; i += 1) {
      const res = await Ops.inbound({
        categoryId: 'mechanical', name: '件' + i, identityMode: 'shared',
        quantity: 1, operator: '测试员'
      });
      const code = res.codes[0];
      const t = await DB.get('items', code);
      await Ops.lend({ code: code, qty: 1, borrower: '甲' + i, dueDate: '2026-10-20', operator: '测试员' });
      const rows = await DB.getAll('transactions');
      const mine = rows.filter((r) => r.itemCode === code);
      ids.push(mine[mine.length - 1].id);
    }
    return ids;
  }

  test('批量删除：几条都删掉，并逐条记入删除记录', async () => {
    await fresh();
    const ids = await seedTxns(3);
    const res = await Ops.deleteTransactions(ids);
    assertEqual(res.removed.length, 3);
    assertEqual(res.missing, 0);

    const left = await DB.getAll('transactions');
    assertEqual(left.filter((r) => ids.indexOf(r.id) !== -1).length, 0, '这三条应该都没了');

    const log = await Rules.getDeleteLog();
    const mine = log.filter((e) => e.store === 'transactions');
    assertEqual(mine.length, 3, '每一条都要留痕');
    assertEqual(mine.every((e) => e.reason === '批量删除'), true);
    assertEqual(mine.every((e) => e.snapshot && e.snapshot.id), true, '留痕要带流水快照');
  });

  test('批量删除：不动物品的库存数量（与单条删除同一口径）', async () => {
    await fresh();
    const ids = await seedTxns(2);
    const before = await DB.getAll('items');
    await Ops.deleteTransactions(ids);
    const after = await DB.getAll('items');
    assertEqual(after.length, before.length, '不该凭空多出/少掉物品');
    after.forEach((it, i) => {
      assertEqual(it.lentQty, before[i].lentQty, it.code + ' 的借出件数不该被流水删除改动');
      assertEqual(it.inStockQty, before[i].inStockQty, it.code + ' 的在库件数不该被改动');
    });
  });

  test('删除记录不会互相覆盖（整批一个事务的关键理由）', async () => {
    await fresh();
    const a = await seedTxns(2);
    await Ops.deleteTransactions(a);
    const b = await seedTxns(2);
    await Ops.deleteTransactions(b);
    const log = await Rules.getDeleteLog();
    const mine = log.filter((e) => e.store === 'transactions');
    assertEqual(mine.length, 4, '两批共 4 条都要在账上，一条都不能被后一批覆盖掉');
  });

  test('已被别人删掉的流水按"不在了"如实报出，不让整批失败', async () => {
    await fresh();
    const ids = await seedTxns(2);
    await DB.remove('transactions', ids[0]);
    const res = await Ops.deleteTransactions(ids);
    assertEqual(res.removed.length, 1, '只删掉还在的那一条');
    assertEqual(res.missing, 1, '少的那一条要报出来');
  });

  test('预演是只读的：跑完一条都没少', async () => {
    await fresh();
    const ids = await seedTxns(2);
    const before = (await DB.getAll('transactions')).length;
    const info = await Ops.previewTransactionDeletion(ids);
    assertEqual(info.deletable.length, 2);
    assertEqual(info.missing, 0);
    assertEqual((await DB.getAll('transactions')).length, before, '预演不许删任何东西');
  });

  test('空名单会被拒，不至于把整张表清掉', async () => {
    await fresh();
    await seedTxns(1);
    const before = (await DB.getAll('transactions')).length;
    assertEqual(before, 2, 'seedTxns(1) 会产生两条流水：入库一条、借出一条');
    await assertRejects(() => Ops.deleteTransactions([]));
    await assertRejects(() => Ops.deleteTransactions(null));
    assertEqual((await DB.getAll('transactions')).length, before, '一条都不能少');
  });

  test('txnLabel：单条删除、批量清单、删除记录共用同一句人话', async () => {
    const row = { type: 'lend', itemCode: 'MC-0001', itemName: '步进电机', qty: 2, operator: '张三' };
    const label = Rules.txnLabel(row);
    assert(label.indexOf('借出') !== -1, '要含动作名，实际：' + label);
    assert(label.indexOf('MC-0001') !== -1);
    assert(label.indexOf('步进电机') !== -1);
    assert(label.indexOf('2') !== -1);
    assert(label.indexOf('张三') !== -1);
    assertEqual(Rules.txnLabel(null), '', '空行给空字符串，不给 undefined');
    assert(Rules.txnLabel({ type: 'lend', itemCode: 'X', qty: 1 }).indexOf('undefined') === -1,
      '缺字段时不能拼出 undefined');
  });
};