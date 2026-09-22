/**
 * 兵种预算汇总的计算口径。
 *
 * 这是纯函数（吃数据、吐数字，不读库、不碰界面），所以直接断言结果。
 * 口径是跟需求确认过的，改之前先想清楚为什么：
 *   · 已用 = 管理员**已同意**的申请金额，待审批的不占预算
 *   · 已取消 / 已驳回的不计（钱不会花出去）
 *   · 没有兵种的老申请归到「未指定」，但**照样计入总额** ——
 *     宁可多显示一行，也不能让明细加起来不等于总数
 */
'use strict';

const Stats = require('../../js/stats.js');

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertDeepEqual } = H;

  const NOW = '2026-09-21T10:00:00.000Z';

  /** 造一条申请。默认是"已同意、待购买" */
  function req(over) {
    return Object.assign({
      id: 1, categoryId: 'mechanical', troop: '步兵', name: '件', quantity: 1,
      budget: 1000, status: 'pending', approval: 'approved',
      createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z'
    }, over);
  }

  function rowOf(summary, troop) {
    return summary.rows.filter((r) => r.troop === troop)[0];
  }

  test('已用只算已同意的，待审批的单列、不占预算', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 6000, approval: 'approved' }),
      req({ id: 2, troop: '步兵', budget: 2000, approval: 'pending' })
    ], { 步兵: 10000 }, 'all', NOW, []);

    const row = rowOf(s, '步兵');
    assertEqual(row.used, 6000, '已用只算已同意的那 6000');
    assertEqual(row.pending, 2000, '待审批的 2000 单列');
    assertEqual(row.remaining, 4000, '剩余 = 10000 - 6000，待审批的不扣');
    assertEqual(s.total.used, 6000);
    assertEqual(s.total.pending, 2000);
    assertEqual(s.total.remaining, 4000);
  });

  test('已取消和已驳回的一律不计（钱不会花出去）', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 6000, status: 'arrived', approval: 'approved' }),
      req({ id: 2, troop: '步兵', budget: 3000, status: 'canceled', approval: 'rejected' }),
      req({ id: 3, troop: '步兵', budget: 1000, status: 'canceled', approval: 'approved' })
    ], { 步兵: 10000 }, 'all', NOW, []);

    const row = rowOf(s, '步兵');
    assertEqual(row.used, 6000, '被驳回和已取消的都不算');
    assertEqual(row.pending, 0, '被驳回的不该被当成"待审批"');
    assertEqual(s.total.used, 6000);
  });

  test('超支只统计真的配了额度的兵种', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 11000 }),              // 超 1000
      req({ id: 2, troop: '无人机', budget: 4000 }),              // 没配额度
      req({ id: 3, troop: undefined, budget: 500 })               // 没写兵种
    ], { 步兵: 10000 }, 'all', NOW, []);

    assertEqual(rowOf(s, '步兵').over, true, '步兵超支');
    assertEqual(rowOf(s, '无人机').over, false, '没配额度就谈不上超支');
    assertEqual(rowOf(s, Stats.UNSPECIFIED).over, false, '「未指定」永远不该算超支');
    assertEqual(s.total.over, 1, '超支兵种数应是 1');
  });

  test('没写兵种的老申请归到「未指定」，但照样计入总额', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 3000 }),
      req({ id: 2, troop: undefined, budget: 700 })               // 老数据
    ], { 步兵: 10000 }, 'all', NOW, []);

    const unknown = rowOf(s, Stats.UNSPECIFIED);
    assert(!!unknown, '应有一行「未指定」');
    assertEqual(unknown.used, 700);
    assertEqual(s.total.used, 3700, '总额必须包含未指定的那 700，否则明细和总数对不上');
    assertEqual(s.total.unspecifiedUsed, 700);
    assertEqual(s.total.unspecifiedCount, 1);
    // 明细行加起来要等于总数，这是这一页最基本的自洽要求
    const sum = s.rows.reduce((acc, r) => acc + r.used, 0);
    assertEqual(sum, s.total.used, '明细相加应等于总额');
  });

  test('配了额度但一条申请都没有的兵种也要列出来', async () => {
    const s = Stats.budgetSummary([], { 步兵: 10000, 雷达: 5000 }, 'all', NOW, []);
    assertEqual(s.rows.length, 2, '配过额度的兵种应该都在表里');
    assertEqual(rowOf(s, '雷达').used, 0);
    assertEqual(rowOf(s, '雷达').remaining, 5000);
    assertEqual(rowOf(s, '雷达').usage, 0, '用 0 表示"还没花"，不是"没设预算"');
    assertEqual(s.total.budget, 15000);
  });

  test('没配额度的兵种：usage 是 null，界面上要能区分"没设"和"没花"', async () => {
    const s = Stats.budgetSummary([req({ id: 1, troop: '哨兵', budget: 300 })], {}, 'all', NOW, []);
    const row = rowOf(s, '哨兵');
    assertEqual(row.usage, null, '没设预算时使用率是 null（不是 0）');
    assertEqual(row.used, 300, '但花了多少还是要如实显示');
    assertEqual(row.remaining, -300, '剩余会是负数，这是事实');
  });

  test('「未指定」永远排在最后一行', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: undefined, budget: 100 }),
      req({ id: 2, troop: '雷达', budget: 100 }),
      req({ id: 3, troop: '重装', budget: 100 })
    ], {}, 'all', NOW, []);
    assertEqual(s.rows[s.rows.length - 1].troop, Stats.UNSPECIFIED, '「未指定」应垫底');
    assertEqual(s.rows[0].troop, '重装', '其余按兵种标准顺序排');
  });

  test('时间范围筛选按申请时间算', async () => {
    const rows = [
      req({ id: 1, troop: '步兵', budget: 1000, createdAt: '2026-09-15T00:00:00.000Z' }),   // 本月
      req({ id: 2, troop: '步兵', budget: 2000, createdAt: '2026-07-15T00:00:00.000Z' }),   // 本季（Q3）
      req({ id: 3, troop: '步兵', budget: 4000, createdAt: '2026-02-15T00:00:00.000Z' }),   // 本年
      req({ id: 4, troop: '步兵', budget: 8000, createdAt: '2025-12-31T00:00:00.000Z' })    // 去年
    ];

    assertEqual(Stats.budgetSummary(rows, {}, 'all', NOW, []).total.used, 15000);
    assertEqual(Stats.budgetSummary(rows, {}, 'year', NOW, []).total.used, 7000);
    assertEqual(Stats.budgetSummary(rows, {}, 'quarter', NOW, []).total.used, 3000);
    assertEqual(Stats.budgetSummary(rows, {}, 'month', NOW, []).total.used, 1000);
  });

  test('「已到货实际」取发票金额，和申请预算的差额看得出来', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 6000, status: 'arrived' }),
      req({ id: 2, troop: '步兵', budget: 3000, status: 'pending' })   // 还没到货
    ], { 步兵: 10000 }, 'all', NOW, [
      { id: 1, purchaseRequestId: 1, amount: 5880, invoiceNo: 'FP-1' }
    ]);

    const row = rowOf(s, '步兵');
    assertEqual(row.used, 9000, '已用仍按申请预算算');
    assertEqual(row.actual, 5880, '实际花销只看已到货的那张发票');
    assertEqual(row.remaining, 1000, '剩余不受实际花销影响（预算是按申请扣的）');
  });

  test('到货了但发票金额缺失时，先按申请预算记，不让这笔凭空消失', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 6000, status: 'arrived' })
    ], { 步兵: 10000 }, 'all', NOW, []);
    assertEqual(rowOf(s, '步兵').actual, 6000, '没有发票金额就退回用申请预算');
  });

  test('同一条申请有多张发票时金额累加（分开开票、多退少补都算真实花销）', async () => {
    const s = Stats.budgetSummary([
      req({ id: 1, troop: '步兵', budget: 6000, status: 'arrived' })
    ], { 步兵: 10000 }, 'all', NOW, [
      { id: 1, purchaseRequestId: 1, amount: 5000 },
      { id: 2, purchaseRequestId: 1, amount: 800 }
    ]);
    assertEqual(rowOf(s, '步兵').actual, 5800);
  });

  test('空数据、脏数据都不该把它弄炸', async () => {
    assertEqual(Stats.budgetSummary([], {}, 'all', NOW, []).rows.length, 0);
    assertEqual(Stats.budgetSummary(null, null, 'all', NOW, null).total.used, 0);
    // 预算额度里混进字符串／非法数字，要按数字处理而不是拼字符串
    const s = Stats.budgetSummary([], { 步兵: '10000', 雷达: '乱写的' }, 'all', NOW, []);
    assertEqual(rowOf(s, '步兵').budget, 10000, '数字字符串应被当成数字');
    assertEqual(rowOf(s, '雷达').budget, 0, '认不出来的按 0');
    // 行里有 null 不能整个挂掉
    assertEqual(Stats.budgetSummary([null, req({ id: 1, troop: '步兵', budget: 100 })], {}, 'all', NOW, []).total.used, 100);
  });

  test('rangeName 会跟着范围变，界面上要显示得出来', async () => {
    assertEqual(Stats.budgetSummary([], {}, 'all', NOW, []).rangeName, '全部');
    assertEqual(Stats.budgetSummary([], {}, 'month', NOW, []).rangeName, '本月');
    assertEqual(Stats.budgetSummary([], {}, 'quarter', NOW, []).rangeName, '本季');
    assertEqual(Stats.budgetSummary([], {}, 'year', NOW, []).rangeName, '本年');
  });

  /* ================= 导出（三段式 CSV） ================= */

  test('导出是三段式：总表 + 已消费明细 + 未消费预算，各段标题都在', async () => {
    const csv = Stats.budgetCsv([
      req({ id: 1, troop: '步兵', budget: 6000 })
    ], { 步兵: 10000 }, 'all', NOW, []);

    assert(csv.indexOf('兵种,预算额度,已用（已同意）') === 0, '第一段应是总表，表头打头');
    assert(csv.indexOf('【已消费明细】') !== -1, '应有「已消费明细」段');
    assert(csv.indexOf('【未消费预算】') !== -1, '应有「未消费预算」段');
    assert(csv.indexOf('兵种,申请编号,物品名称') !== -1, '明细段应有自己的表头');
  });

  test('消费情况标记：超支 / 已消费 / 未消费 分得清', async () => {
    const csv = Stats.budgetCsv([
      req({ id: 1, troop: '步兵', budget: 6000 }),                          // 花了一部分
      req({ id: 2, troop: '重装', budget: 12000 }),                         // 超支
      req({ id: 3, troop: '雷达', budget: 1, status: 'canceled', approval: 'rejected' }) // 一分没花
    ], { 步兵: 10000, 重装: 10000, 雷达: 5000 }, 'all', NOW, []);

    const rowOfCsv = (troop) => csv.split('\r\n').filter((l) => l.indexOf(troop + ',') === 0);
    assert(rowOfCsv('步兵')[0].indexOf('已消费') !== -1, '步兵花了钱应标「已消费」');
    assert(rowOfCsv('重装')[0].indexOf('超支') !== -1, '重装超了应标「超支」');
    assert(rowOfCsv('雷达')[0].indexOf('未消费') !== -1, '雷达没花应标「未消费」');
  });

  test('已消费明细逐条列出已同意的申请，取消/驳回的不出现，实际金额取发票', async () => {
    const csv = Stats.budgetCsv([
      req({ id: 1, troop: '步兵', budget: 6000, status: 'arrived', name: '电机' }),
      req({ id: 2, troop: '步兵', budget: 3000, status: 'canceled', approval: 'rejected', name: '不该出现' }),
      req({ id: 3, troop: '雷达', budget: 800, name: '传感器' })
    ], {}, 'all', NOW, [
      { id: 1, purchaseRequestId: 1, amount: 5880 }
    ]);

    assert(csv.indexOf('电机') !== -1, '已同意的申请应出现在明细里');
    assert(csv.indexOf('不该出现') === -1, '被驳回/取消的不算消费，明细里不该有');
    assert(csv.indexOf('传感器') !== -1, '雷达那笔也是已同意，应在明细里');
    const detailLine = csv.split('\r\n').filter((l) => l.indexOf('步兵,1,电机') === 0)[0];
    assert(!!detailLine, '电机那行应存在');
    assert(detailLine.indexOf('5880') !== -1, '到货实际应取发票金额 5880，而不是申请的 6000');
    assert(detailLine.indexOf('已到货') !== -1, '状态应标「已到货」');
  });

  test('未消费预算段只列还有剩余的兵种；都用完了给一句说明而不是空段', async () => {
    const csv1 = Stats.budgetCsv([
      req({ id: 1, troop: '步兵', budget: 6000 })
    ], { 步兵: 10000, 雷达: 5000 }, 'all', NOW, []);
    const unusedSection = csv1.split('【未消费预算】')[1];
    assert(unusedSection.indexOf('步兵') !== -1 && unusedSection.indexOf('4000') !== -1, '步兵剩 4000 应在未消费段');
    assert(unusedSection.indexOf('雷达') !== -1 && unusedSection.indexOf('5000') !== -1, '雷达分文未动也应列出');

    const csv2 = Stats.budgetCsv([
      req({ id: 1, troop: '步兵', budget: 10000 })
    ], { 步兵: 10000 }, 'all', NOW, []);
    assert(csv2.split('【未消费预算】')[1].indexOf('所有兵种的预算都已用完') !== -1, '花完了应给说明行');
  });

  test('导出遇到空数据、脏数据不炸（与汇总同款健壮性）', async () => {
    const csv = Stats.budgetCsv(null, null, 'all', NOW, null);
    assert(typeof csv === 'string' && csv.length > 0, '空数据也应产出可下载的 CSV');
    assert(csv.indexOf('还没有已同意的申请') !== -1, '没有消费时明细段给说明');
    assert(csv.indexOf('所有兵种的预算都已用完') !== -1, '没有预算时未消费段给说明');
  });
};
