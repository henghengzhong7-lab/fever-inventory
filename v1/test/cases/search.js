/**
 * 全局搜索（第十五轮）：`Rules.searchAll` 是个纯函数，这里直接喂数据断言。
 *
 * 界面只是把它接到顶栏那个入口上，所以规则对不对必须在这一层钉死。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  test('物品按 编码 / 名称 / 规格 / 位置 / 兵种 / 大类名 都能搜到', async () => {
    await fresh();
    await Ops.inbound({
      categoryId: 'mechanical', name: '步进电机', spec: '42BYGH 1.5A',
      location: 'C区2号柜', identityMode: 'shared', quantity: 1, operator: '张三'
    });
    const items = await DB.getAll('items');
    const cats = await DB.getAll('categories');
    const hits = (kw) => Rules.searchAll(items, cats, kw).items.length;

    assertEqual(hits('MC-0001'), 1, '按编码');
    assertEqual(hits('步进'), 1, '按名称');
    assertEqual(hits('42BYGH'), 1, '按规格');
    assertEqual(hits('C区2号柜'), 1, '按位置');
    assertEqual(hits('机械'), 1, '按大类名');
    assertEqual(hits('没这个词'), 0);
  });

  test('大类也能搜到；关键词两端空格忽略，空关键词不返回任何东西', async () => {
    await fresh();
    const cats = await DB.getAll('categories');
    const r = Rules.searchAll([], cats, '  视觉 ');
    assertEqual(r.categories.length, 1, '应搜到大类「视觉」');
    assertEqual(r.categories[0].id, 'vision');
    assertEqual(r.items.length, 0, '没有物品就给空数组，不是 undefined');

    assertEqual(Rules.searchAll([], cats, '').categories.length, 0, '空关键词不匹配任何东西');
    assertEqual(Rules.searchAll([], cats, '   ').items.length, 0, '只打空格也一样');
  });

  test('结果有上限，并如实报告"还有多少没显示"', async () => {
    await fresh();
    const items = [];
    for (let i = 1; i <= 12; i += 1) {
      items.push({ code: 'MC-' + String(i).padStart(4, '0'), name: '同款件', categoryId: 'mechanical' });
    }
    const r = Rules.searchAll(items, [], '同款件', 5);
    assertEqual(r.items.length, 5, '只返回上限条数');
    assertEqual(r.itemTotal, 12, '总数要如实给出 —— 界面会写"显示前 5 / 共 12"');
    assertEqual(r.truncated, true);

    const all = Rules.searchAll(items, [], '同款件');
    assertEqual(all.truncated, false, '没超上限就不该标 truncated');
  });

  test('不搜单据：采购申请、发票、流水里的内容不该出现在搜索结果里', async () => {
    await fresh();
    const reqId = await Ops.createRequest({
      categoryId: 'mechanical', troop: '哨兵', name: '独一无二的申请名',
      quantity: 1, budget: '10', applicant: '张三'
    });
    assert(reqId);
    const items = await DB.getAll('items');
    const cats = await DB.getAll('categories');
    assertEqual(Rules.searchAll(items, cats, '独一无二的申请名').items.length, 0,
      '搜索只覆盖物品与大类 —— 找单据走页面互联那几条路');
    assertEqual(Rules.searchAll(items, cats, '独一无二的申请名').categories.length, 0);
  });
};
