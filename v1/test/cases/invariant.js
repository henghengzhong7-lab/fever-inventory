/** 库存恒等式校验 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual } = H;

  function item(over) {
    return Object.assign({
      code: 'MC-9001', identityMode: 'shared',
      totalQty: 10, inStockQty: 10, lentQty: 0, repairQty: 0, usedUpQty: 0
    }, over);
  }

  test('数量自洽时校验通过', async () => {
    assert(Rules.checkInvariant(item({})).ok, '初始应在库 10 件且通过校验');
    assert(Rules.checkInvariant(item({ inStockQty: 6, lentQty: 3, repairQty: 1 })).ok, '6+3+1=10 应通过');
    assert(Rules.checkInvariant(item({ inStockQty: 0, usedUpQty: 10 })).ok, '全部领用也应通过');
  });

  test('数量对不上时校验失败', async () => {
    const bad = Rules.checkInvariant(item({ inStockQty: 9 }));
    assertEqual(bad.ok, false, '9 ≠ 10 应失败');
    assert(/不自洽/.test(bad.message), '应给出不自洽提示，实际：' + bad.message);
  });

  test('出现负数时校验失败', async () => {
    const bad = Rules.checkInvariant(item({ inStockQty: 11, lentQty: -1 }));
    assertEqual(bad.ok, false, '负数应失败');
  });

  test('单独建身份的物品总数必须是 1', async () => {
    const good = Rules.checkInvariant({ identityMode: 'single', totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0 });
    assert(good.ok, '1 件应通过');
    const bad = Rules.checkInvariant({ identityMode: 'single', totalQty: 2, inStockQty: 2, lentQty: 0, repairQty: 0, usedUpQty: 0 });
    assertEqual(bad.ok, false, '单独建身份总数 2 应失败');
  });

  test('状态由数量正确派生', async () => {
    assertEqual(Rules.statusOf(item({})), 'in_stock');
    assertEqual(Rules.statusOf(item({ inStockQty: 7, lentQty: 3 })), 'in_stock', '还有在库的，主状态是「在库」');
    assertEqual(Rules.statusOf(item({ inStockQty: 0, lentQty: 10 })), 'lent');
    assertEqual(Rules.statusOf(item({ inStockQty: 0, repairQty: 10 })), 'repairing');
    assertEqual(Rules.statusOf(item({ inStockQty: 0, usedUpQty: 10 })), 'used_up');
  });

  test('各类名字都有中文可显示', async () => {
    assertEqual(Rules.STATUS_NAMES.lent, '借出');
    assertEqual(Rules.STATUS_NAMES.repairing, '损坏待修');
    assertEqual(Rules.TXN_TYPES.repair_done, '修好回库');
    assertEqual(Rules.INVOICE_STATUS_NAMES.arrived, '已到货');
  });
};
