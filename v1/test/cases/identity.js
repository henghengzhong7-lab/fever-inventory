/**
 * 身份方式后期更改（第十五轮）：同款共用 ⇄ 单独使用。
 *
 * 这一组用例盯的是**件数守恒**与**可追溯**两件事：
 * 改身份不是出入库，任何一件都不能凭空多出来或者消失，
 * 合并时删掉的身份要能在「删除记录」里查到。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  /** 直接造一件物品（绕过 Ops.inbound，好精确控制数量分布） */
  async function mkItem(over) {
    const now = DB.nowIso();
    const row = Object.assign({
      code: 'MC-0001', name: '测试件', spec: '', categoryId: 'mechanical',
      location: 'A区', troop: '哨兵', identityMode: 'shared',
      totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0,
      status: 'in_stock', safetyStock: null, remark: '', extra: {},
      purchaseRequestId: null, invoiceId: null, createdAt: now, updatedAt: now
    }, over);
    const check = Rules.checkInvariant(row);
    assert(check.ok, '造的数据本身要自洽：' + (check.message || ''));
    await DB.add('items', row);
    return row;
  }

  async function allItems() {
    return (await DB.getAll('items')).slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }

  /* ---------- 共用 → 单独（拆分） ---------- */

  test('拆分：原编码留 1 件，另发 N−1 个连续新码，件数一件不差', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: 'M4螺丝', identityMode: 'shared', totalQty: 5, inStockQty: 5, safetyStock: 20 });

    const r = await Ops.changeIdentity({ code: 'MC-0001', mode: 'single' });
    assertEqual(r.ok, true);
    assertEqual(r.keptCode, 'MC-0001', '原编码留着，已经贴出去的标签才不用重贴');
    assertEqual(r.newCodes.length, 4);
    assertEqual(r.newCodes.join(','), 'MC-0002,MC-0003,MC-0004,MC-0005', '新码要连续往下排');

    const items = await allItems();
    assertEqual(items.length, 5, '5 件 → 5 个身份');
    items.forEach((it) => {
      assertEqual(it.identityMode, 'single');
      assertEqual(it.totalQty, 1);
      assertEqual(it.inStockQty, 1);
      assertEqual(it.status, 'in_stock');
      assertEqual(it.safetyStock, null, '单独身份没有"安全库存"这个概念');
      assert(Rules.checkInvariant(it).ok, it.code + ' 必须自洽');
    });
    const sum = items.reduce((s, it) => s + it.totalQty, 0);
    assertEqual(sum, 5, '总件数守恒');
  });

  test('拆分只有 1 件时：只改标记，不凭空发新码', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', identityMode: 'shared', totalQty: 1, inStockQty: 1 });
    const r = await Ops.changeIdentity({ code: 'MC-0001', mode: 'single' });
    assertEqual(r.newCodes.length, 0);
    assertEqual((await DB.get('items', 'MC-0001')).identityMode, 'single');
    assertEqual((await allItems()).length, 1);
  });

  test('拆分被拦：还有件借在外面', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', identityMode: 'shared', totalQty: 5, inStockQty: 3, lentQty: 2 });
    await assertRejects(() => Ops.changeIdentity({ code: 'MC-0001', mode: 'single' }),
      '有件在外面时拆不了 —— 新标签贴不到在外的那些件上');
    assertEqual((await DB.get('items', 'MC-0001')).identityMode, 'shared', '被拒后原样不动');
  });

  test('拆分被拦：还有件在待修', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', identityMode: 'shared', totalQty: 3, inStockQty: 2, repairQty: 1 });
    await assertRejects(() => Ops.changeIdentity({ code: 'MC-0001', mode: 'single' }));
  });

  test('拆分被拦：已经有件被领用/用掉了', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', identityMode: 'shared', totalQty: 10, inStockQty: 7, usedUpQty: 3 });
    await assertRejects(() => Ops.changeIdentity({ code: 'MC-0001', mode: 'single' }),
      '领用掉的件没有实物可贴，硬拆就得给它编一个不存在的身份');
  });

  /* ---------- 单独 → 共用（合并） ---------- */

  test('合并：件数相加、保留指定编码、其余编码被删且留下删除记录', async () => {
    await fresh();
    await mkItem({ code: 'VS-0001', name: '工业相机', categoryId: 'vision', identityMode: 'single' });
    await mkItem({ code: 'VS-0002', name: '工业相机', categoryId: 'vision', identityMode: 'single', location: 'B区' });
    await mkItem({ code: 'VS-0003', name: '工业相机', categoryId: 'vision', identityMode: 'single' });

    const r = await Ops.changeIdentity({
      code: 'VS-0001', mode: 'shared',
      codesToMerge: ['VS-0001', 'VS-0002', 'VS-0003'], keepCode: 'VS-0002'
    });
    assertEqual(r.ok, true);
    assertEqual(r.keptCode, 'VS-0002', '保留了指定的那个编码');
    assertEqual(r.droppedCodes.join(','), 'VS-0001,VS-0003');

    const items = await allItems();
    assertEqual(items.length, 1, '三个身份合成一个');
    assertEqual(items[0].code, 'VS-0002');
    assertEqual(items[0].identityMode, 'shared');
    assertEqual(items[0].totalQty, 3, '件数相加');
    assertEqual(items[0].inStockQty, 3);
    assertEqual(items[0].location, 'B区', '保留的那条的其它字段不动');
    assert(Rules.checkInvariant(items[0]).ok);

    const log = await Rules.getDeleteLog();
    const dropped = log.filter((e) => e.store === 'items');
    assertEqual(dropped.length, 2, '被删掉的两个身份都要留痕');
    assert(dropped.some((e) => e.key === 'VS-0001'), '删除记录里能查到 VS-0001');
    assert(dropped.some((e) => e.reason && e.reason.indexOf('VS-0002') !== -1),
      '理由里要写清并进了哪个编码');
  });

  test('合并：已领用的身份可以并进来（贴纸早就不在了），件数仍然守恒', async () => {
    await fresh();
    await mkItem({ code: 'HW-0001', name: '扎带', categoryId: 'hardware', identityMode: 'single' });
    await mkItem({ code: 'HW-0002', name: '扎带', categoryId: 'hardware', identityMode: 'single',
      totalQty: 1, inStockQty: 0, usedUpQty: 1, status: 'used_up' });

    const r = await Ops.changeIdentity({
      code: 'HW-0001', mode: 'shared', codesToMerge: ['HW-0001', 'HW-0002']
    });
    const merged = await DB.get('items', r.keptCode);
    assertEqual(merged.totalQty, 2);
    assertEqual(merged.inStockQty, 1);
    assertEqual(merged.usedUpQty, 1);
    assertEqual(merged.status, 'in_stock', '还有在库的件，状态就是在库');
  });

  test('合并被拦：不是同款（名称 / 规格 / 大类不一致）', async () => {
    await fresh();
    await mkItem({ code: 'VS-0001', name: '工业相机', categoryId: 'vision', identityMode: 'single' });
    await mkItem({ code: 'VS-0002', name: '工业镜头', categoryId: 'vision', identityMode: 'single' });
    await assertRejects(() => Ops.changeIdentity({
      code: 'VS-0001', mode: 'shared', codesToMerge: ['VS-0001', 'VS-0002']
    }), '名字都不一样，不能合');

    await mkItem({ code: 'VS-0003', name: '工业相机', spec: '500万', categoryId: 'vision', identityMode: 'single' });
    await assertRejects(() => Ops.changeIdentity({
      code: 'VS-0001', mode: 'shared', codesToMerge: ['VS-0001', 'VS-0003']
    }), '规格不一样也不能合');
  });

  test('合并被拦：有件借在外面 / 待修中', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: '扳手', identityMode: 'single' });
    await mkItem({ code: 'MC-0002', name: '扳手', identityMode: 'single', totalQty: 1, inStockQty: 0, lentQty: 1, status: 'lent' });
    await assertRejects(() => Ops.changeIdentity({
      code: 'MC-0001', mode: 'shared', codesToMerge: ['MC-0001', 'MC-0002']
    }), '借出去的那件手上的标签不能作废');
  });

  test('合并被拦：名单里混进了「同款共用」的身份', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: '轴承', identityMode: 'single' });
    await mkItem({ code: 'MC-0002', name: '轴承', identityMode: 'shared', totalQty: 3, inStockQty: 3 });
    await assertRejects(() => Ops.changeIdentity({
      code: 'MC-0001', mode: 'shared', codesToMerge: ['MC-0001', 'MC-0002']
    }), '共用身份不是"一件一码"，合起来会出现两个身份对一批件');
  });

  test('合并被拦：只选了一个身份', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: '轴承', identityMode: 'single' });
    await assertRejects(() => Ops.changeIdentity({
      code: 'MC-0001', mode: 'shared', codesToMerge: ['MC-0001']
    }), '至少要两个');
  });

  test('已经是目标模式时如实报错，不做无意义的写入', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', identityMode: 'shared', totalQty: 2, inStockQty: 2 });
    await assertRejects(() => Ops.changeIdentity({ code: 'MC-0001', mode: 'shared' }),
      '本来就是共用，不用再改');
    await Ops.changeIdentity({ code: 'MC-0001', mode: 'single' });
    await assertRejects(() => Ops.changeIdentity({ code: 'MC-0001', mode: 'single' }));
  });

  /* ---------- 共同要求 ---------- */

  test('改身份不写流水（它不是一次出入库）', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: '螺丝', identityMode: 'shared', totalQty: 4, inStockQty: 4 });
    await Ops.changeIdentity({ code: 'MC-0001', mode: 'single' });
    assertEqual((await DB.getAll('transactions')).length, 0, '拆分不产生流水');

    await Ops.changeIdentity({
      code: 'MC-0001', mode: 'shared', codesToMerge: ['MC-0001', 'MC-0002', 'MC-0003', 'MC-0004']
    });
    assertEqual((await DB.getAll('transactions')).length, 0, '合并不产生流水');
  });

  test('拆开再合回来：件数、状态、位置都回到原样', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: '垫片', identityMode: 'shared',
      totalQty: 6, inStockQty: 6, location: 'C柜', troop: '雷达', safetyStock: 3 });

    const split = await Ops.changeIdentity({ code: 'MC-0001', mode: 'single' });
    const back = await Ops.changeIdentity({
      code: 'MC-0001', mode: 'shared',
      codesToMerge: ['MC-0001'].concat(split.newCodes), keepCode: 'MC-0001'
    });
    const merged = await DB.get('items', back.keptCode);
    assertEqual(merged.totalQty, 6);
    assertEqual(merged.inStockQty, 6);
    assertEqual(merged.lentQty + merged.repairQty + merged.usedUpQty, 0);
    assertEqual(merged.location, 'C柜', '位置这类字段一路跟着走');
    assertEqual(merged.troop, '雷达');
    assert(Rules.checkInvariant(merged).ok);
    assertEqual((await allItems()).length, 1, '最后还是只剩一个身份');
  });

  test('备份导出导入能把改过的身份带过去', async () => {
    await fresh();
    await mkItem({ code: 'MC-0001', name: '轴套', identityMode: 'shared', totalQty: 3, inStockQty: 3 });
    await Ops.changeIdentity({ code: 'MC-0001', mode: 'single' });

    const payload = await Rules.exportAll();
    await Rules.clearAll();
    await Rules.importAll(payload);
    const items = await allItems();
    assertEqual(items.length, 3);
    items.forEach((it) => assertEqual(it.identityMode, 'single'));
    assertEqual(items.reduce((s, it) => s + it.totalQty, 0), 3);
  });

  /* ---------- 候选名单（界面靠它列选项） ---------- */

  test('identityMergeCandidates：只列同款，且排除借出/待修的', async () => {
    await fresh();
    await mkItem({ code: 'VS-0001', name: '相机', categoryId: 'vision', identityMode: 'single' });
    await mkItem({ code: 'VS-0002', name: '相机', categoryId: 'vision', identityMode: 'single' });
    await mkItem({ code: 'VS-0003', name: '镜头', categoryId: 'vision', identityMode: 'single' });
    await mkItem({ code: 'VS-0004', name: '相机', categoryId: 'vision', identityMode: 'single',
      totalQty: 1, inStockQty: 0, lentQty: 1, status: 'lent' });
    await mkItem({ code: 'MC-0009', name: '相机', identityMode: 'single' });
    await mkItem({ code: 'VS-0005', name: '相机', categoryId: 'vision', identityMode: 'shared', totalQty: 2, inStockQty: 2 });

    const res = await Ops.identityMergeCandidates('VS-0001');
    const codes = res.candidates.map((c) => c.code);
    assertEqual(codes.join(','), 'VS-0002',
      '只应剩下同款且可动的那个：VS-0003 不同名、VS-0004 借出中、MC-0009 大类不同、VS-0005 不是单独身份');
  });
};
