/**
 * 同名物品要归同一个大类（第二十四轮）。
 *
 * 起因：新增物品时**完全没有同名检查**，同一个东西可以被建到不同大类里，
 * 清点和搜索都会别扭。做法是"自动带出大类 + 说清楚"，不硬锁
 * （万一确实要分开，使用者改一下就行）。
 *
 * 这里钉的是纯函数那部分：同名怎么算、同名物品怎么找。
 * 界面行为（自动切大类、保住已填内容）由 items-tests.js 的端到端覆盖。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual } = H;

  test('同名判定：空格、全角空格、大小写都不该影响', async () => {
    const k = Rules.nameKey;
    assertEqual(k('M4螺丝'), k('M4螺丝'), '一模一样当然是同名');
    assertEqual(k('M4螺丝 '), k(' M4螺丝'), '首尾空格不该影响');
    assertEqual(k('M4　螺丝'), k('M4 螺丝'), '全角空格和半角空格该归一');
    assertEqual(k('m4螺丝'), k('M4螺丝'), '英文大小写不该影响');
    assertEqual(k('M4   螺丝'), k('M4 螺丝'), '连续空格该并成一个');
    assert(k('M4螺丝') !== k('M4螺母'), '不同的东西不能被当成同名');
    assertEqual(k(''), '', '空名字给空键');
    assertEqual(k(null), '', 'null 不该炸');
    assertEqual(k(undefined), '', 'undefined 不该炸');
  });

  test('同名物品查找：按归一化后的名字匹配', async () => {
    const items = [
      { code: 'MC-0001', name: '步进电机', categoryId: 'mechanical' },
      { code: 'MC-0005', name: ' 步进电机 ', categoryId: 'mechanical' },
      { code: 'EL-0001', name: '步进电机', categoryId: 'electronic' },
      { code: 'MC-0002', name: '螺母', categoryId: 'mechanical' }
    ];
    const same = Rules.sameNameItems(items, '步进电机');
    assertEqual(same.length, 3, '三件同名都该找出来（跨大类的也算）');
    assertEqual(same.map((x) => x.code).join(','), 'MC-0001,MC-0005,EL-0001');

    assertEqual(Rules.sameNameItems(items, '').length, 0, '没填名字时不该冒出同名提示');
    assertEqual(Rules.sameNameItems(items, '   ').length, 0, '只有空格也算没填');
    assertEqual(Rules.sameNameItems(items, '不存在的东西').length, 0);
    assertEqual(Rules.sameNameItems(null, '步进电机').length, 0, '空列表不该炸');
  });

  test('同名物品在实际入库之后也能被找出来', async () => {
    await Rules.clearAll();
    await Rules.initCategories();
    const a = await Ops.inbound({
      categoryId: 'mechanical', name: 'M4螺丝', troop: '重装',
      quantity: 5, operator: '张三', identityMode: 'shared'
    });
    const b = await Ops.inbound({
      categoryId: 'hardware', name: ' M4螺丝', troop: '重装',
      quantity: 5, operator: '张三', identityMode: 'shared'
    });
    const items = await DB.getAll('items');
    const same = Rules.sameNameItems(items, 'M4螺丝');
    assertEqual(same.length, 2, '两件跨大类的同名物品都该找出来');
    const ids = same.map((x) => x.categoryId).sort().join(',');
    assertEqual(ids, 'hardware,mechanical', '并如实带上各自的大类（界面靠它决定提示什么）');
    assertEqual((await DB.get('items', a.codes[0])).categoryId, 'mechanical');
    assertEqual((await DB.get('items', b.codes[0])).categoryId, 'hardware');
  });
};