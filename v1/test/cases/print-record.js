/**
 * 标签打印记录（第二十轮定稿）：**只有打印次数与最近时间，没有"确认"那一套**。
 *
 * 需求方明确说过「不需要确认」：贴没贴好只有贴标签的人知道，
 * 让他多点一次确认纯属白事。所以这里只钉两件事：次数会累加、之前打过会被认出来。
 *
 * 记在**物品行**上，不拆到每张标签：同款共用的一件东西整体算一次。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assertEqual, assert } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  async function mkItem(over) {
    const now = DB.nowIso();
    const row = Object.assign({
      code: 'MC-0001', name: '带标签的件', spec: '', categoryId: 'mechanical',
      location: '', troop: '哨兵', identityMode: 'shared',
      totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0,
      status: 'in_stock', safetyStock: null, remark: '', extra: {},
      createdAt: now, updatedAt: now
    }, over);
    assert(Rules.checkInvariant(row).ok, '造的数据要自洽');
    await DB.add('items', row);
    return row;
  }

  test('第一次打印：次数记成 1、记下时间，不产生任何"待确认"', async () => {
    await fresh();
    await mkItem({});
    const r = await Ops.markPrinted({ codes: ['MC-0001'] });
    assertEqual(r.marked, 1);
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.printCount, 1);
    assert(!!item.lastPrintedAt, '要记下最近一次打印时间');
    assertEqual(item.printPending, undefined, '不再有"待确认"这个状态');
    assertEqual(item.printConfirmedAt, undefined, '也不再有确认时间');
  });

  test('再打一次：次数累加，最近时间被后一次覆盖', async () => {
    await fresh();
    await mkItem({});
    await Ops.markPrinted({ codes: ['MC-0001'], at: '2026-10-06T01:00:00.000Z' });
    await Ops.markPrinted({ codes: ['MC-0001'], at: '2026-10-06T02:00:00.000Z' });
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.printCount, 2, '次数要累加');
    assertEqual(item.lastPrintedAt, '2026-10-06T02:00:00.000Z', '最近时间要被后一次覆盖');
  });

  test('没打印过的不算"打过"（老数据没有这些键）', async () => {
    await fresh();
    await mkItem({});
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.printCount, undefined, '老数据不该被凭空补上字段');
    assertEqual(Ops.printedBeforeCount([item]), 0, '没打过 = 不是"打过"');
  });

  test('printedBeforeCount 只数真正打过的那几件', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001' });
    await mkItem({ code: 'MC-0002' });
    await mkItem({ code: 'MC-0003' });
    await Ops.markPrinted({ codes: ['MC-0001', 'MC-0003'] });
    const items = await DB.getAll('items');
    assertEqual(Ops.printedBeforeCount(items), 2);
    assertEqual(Ops.printedBeforeCount(null), 0, '空输入不该炸');
    assertEqual(Ops.printedBeforeCount([null, undefined]), 0, '列表里有空项也不该炸');
  });

  test('编码已经不存在时跳过，不让整次打印失败', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001' });
    const r = await Ops.markPrinted({ codes: ['MC-0001', 'MC-9999'] });
    assertEqual(r.marked, 1, '只有真记上的才算数');
    assertEqual((await DB.get('items', 'MC-0001')).printCount, 1);
  });

  test('一次打印多件，每件各记一次', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001' });
    await mkItem({ code: 'MC-0002' });
    const r = await Ops.markPrinted({ codes: ['MC-0001', 'MC-0002'], at: '2026-10-06T05:00:00.000Z' });
    assertEqual(r.marked, 2);
    const items = await DB.getAll('items');
    items.forEach((it) => {
      assertEqual(it.printCount, 1);
      assertEqual(it.lastPrintedAt, '2026-10-06T05:00:00.000Z');
    });
  });

  test('空名单不会出事', async () => {
    await fresh();
    const r = await Ops.markPrinted({ codes: [] });
    assertEqual(r.marked, 0);
    const r2 = await Ops.markPrinted(null);
    assertEqual(r2.marked, 0);
  });

  test('打印记录跟着备份走（导入导出后仍在）', async () => {
    await fresh();
    await mkItem({});
    await Ops.markPrinted({ codes: ['MC-0001'], at: '2026-10-06T06:00:00.000Z' });
    const payload = await Rules.exportAll();
    await Rules.clearAll();
    await Rules.importAll(payload);
    const item = await DB.get('items', 'MC-0001');
    assertEqual(item.printCount, 1, '换设备 / 恢复备份后不该丢打印记录');
    assertEqual(item.lastPrintedAt, '2026-10-06T06:00:00.000Z');
  });
};