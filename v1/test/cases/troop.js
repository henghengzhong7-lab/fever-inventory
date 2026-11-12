/**
 * 兵种字段：常量、规范化、采购申请表单一侧的规则、到货入库的继承。
 *
 * 兵种是「兵种预算」的归类键，所以它的取值必须被约束住 ——
 * 随便存一个字符串进去，那笔钱就会从预算汇总里漏掉，而且是静默漏掉。
 */
'use strict';

const Stats = require('../../js/stats.js');

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertDeepEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  async function addRequest(over) {
    const now = DB.nowIso();
    const row = Object.assign({
      categoryId: 'mechanical', troop: '步兵', name: '测试件', spec: '',
      quantity: 1, budget: '100', purpose: '', applicant: '张三',
      status: 'pending', createdAt: now, updatedAt: now
    }, over);
    const id = await DB.add('purchaseRequests', row);
    return Object.assign({ id }, row);
  }

  test('兵种取值：步兵细分三类 + 第二十二轮三个车型 + 第二十五轮「英雄 / 小轮腿」', async () => {
    assertDeepEqual(Rules.TROOPS,
      ['重装', '步兵', '轮腿步兵', '过洞步兵', '可折叠步兵', '小轮腿',
        // 第二十二轮按需求方要求新增（纯新增，旧的都保留）
        '舵轮机器人', '老步兵机器人', '新步兵机器人',
        // 第二十五轮再加两个（同样是纯新增）
        '英雄',
        '哨兵', '飞镖', '无人机', '雷达', '前哨战', '能量机关', '其他']);
    assertEqual(Rules.TROOPS[Rules.TROOPS.length - 1], '其他', '「其他」必须是最后一个（它是兜底项，不该被误选）');
    assertEqual(new Set(Rules.TROOPS).size, Rules.TROOPS.length, '兵种不能有重复项');
  });

  test('表单选项里没有历史值「步兵」，但它仍是合法取值', async () => {
    // 这是本轮改动的核心权衡：步兵细分成三类之后，
    // 「步兵」不再给用户选（TROOP_OPTIONS），但仍是合法取值（TROOPS）——
    // 因为它已经是老数据的预算归类键，直接删掉会让那些钱静默改归属。
    assertEqual(Rules.TROOP_OPTIONS.indexOf('步兵'), -1, '下拉框里不应再出现「步兵」');
    assertEqual(Rules.TROOP_OPTIONS.length, Rules.TROOPS.length - Rules.TROOP_LEGACY.length);
    ['轮腿步兵', '过洞步兵', '可折叠步兵'].forEach((t) => {
      assertEqual(Rules.TROOP_OPTIONS.indexOf(t) !== -1, true, '下拉框里应有「' + t + '」');
    });
    assertEqual(Rules.TROOP_OPTIONS[Rules.TROOP_OPTIONS.length - 1], '其他', '「其他」仍应排最后');
  });

  test('老数据里的「步兵」原样保留，不被归到「其他」', async () => {
    // 归到「其他」就等于把这笔钱从「步兵」预算里搬走 —— 而且是静默的
    assertEqual(Rules.normalizeTroop('步兵'), '步兵');
    assertEqual(Rules.troopOf({ troop: '步兵' }), '步兵');
  });

  test('编辑老记录时，历史兵种会被补进下拉选项（否则一保存就被改掉）', async () => {
    const legacy = Rules.troopChoices('步兵');
    assertEqual(legacy.indexOf('步兵') !== -1, true, '编辑一条「步兵」的老记录时，选项里必须还有「步兵」');
    assertEqual(legacy.length, Rules.TROOP_OPTIONS.length + 1);
    // 新值不该被重复插入
    assertEqual(Rules.troopChoices('雷达').length, Rules.TROOP_OPTIONS.length);
    assertEqual(Rules.troopChoices('').length, Rules.TROOP_OPTIONS.length);
    assertEqual(Rules.troopChoices(undefined).indexOf('其他') !== -1, true);
  });

  test('预算设置表单：已配过额度的历史兵种仍然列出来（能看也能改）', async () => {
    // 不列出来的话，老「步兵」压着的那笔预算在界面上就只剩"能看不能改"
    const withLegacy = Rules.budgetTroops({ 步兵: 10000, 无人机: 5000 });
    assertEqual(withLegacy.indexOf('步兵') !== -1, true, '配过额度的历史兵种应出现在预算表单里');
    assertEqual(withLegacy.indexOf('无人机') !== -1, true);
    // 顺序与 troopChoices 一致：历史值紧跟在「重装」之后
    assertEqual(withLegacy[0], '重装');
    assertEqual(withLegacy[1], '步兵');

    // 没配过额度的新用户看不到历史兵种，列表就是常规选项
    assertDeepEqual(Rules.budgetTroops({}), Rules.TROOP_OPTIONS);
    assertDeepEqual(Rules.budgetTroops(null), Rules.TROOP_OPTIONS);
    // 键存在但值为空/0 视为"没配"，与保存时的"空或 0 不落库"口径一致
    assertEqual(Rules.budgetTroops({ 步兵: '' }).indexOf('步兵'), -1);
  });

  test('三个新兵种都能正常建申请并各自归到自己的预算桶', async () => {
    await fresh();
    for (const t of ['轮腿步兵', '过洞步兵', '可折叠步兵']) {
      const id = await Ops.createRequest({
        categoryId: 'mechanical', troop: t, name: t + '专用件',
        quantity: 1, budget: '100', applicant: '张三'
      });
      const back = await DB.get('purchaseRequests', id);
      assertEqual(back.troop, t, t + ' 应原样存下来');
    }
    const rows = (await Stats.budgetSummary(
      await DB.getAll('purchaseRequests'), {}, 'all', DB.nowIso(), [])).rows;
    ['轮腿步兵', '过洞步兵', '可折叠步兵'].forEach((t) => {
      assert(rows.some((r) => r.troop === t), t + ' 应在预算里有独立的一行');
    });
  });

  test('空值规范化成「未指定」，不硬塞成「其他」', async () => {
    // 空和「其他」是两码事：空表示老数据还没填，界面上要显示「未指定」并提示补填；
    // 如果把空也算进「其他」，预算板块里就会凭白多出一笔看不见来路的钱。
    assertEqual(Rules.normalizeTroop(''), '');
    assertEqual(Rules.normalizeTroop(null), '');
    assertEqual(Rules.normalizeTroop(undefined), '');
    assertEqual(Rules.normalizeTroop('   '), '');
  });

  test('认识的值原样保留，两端空格会被去掉', async () => {
    Rules.TROOPS.forEach((t) => {
      assertEqual(Rules.normalizeTroop(t), t, t + ' 应原样保留');
    });
    assertEqual(Rules.normalizeTroop('  步兵  '), '步兵');
  });

  test('认不出来的兵种一律归到「其他」，钱不会漏出预算之外', async () => {
    assertEqual(Rules.normalizeTroop('前哨站'), '其他', '改过名字的旧值应兜到「其他」');
    assertEqual(Rules.normalizeTroop('工程'), '其他');
    assertEqual(Rules.normalizeTroop('0'), '其他');
    assertEqual(Rules.normalizeTroop(123), '其他');
  });

  test('troopOf 能安全处理没有这个字段的老记录', async () => {
    assertEqual(Rules.troopOf({ name: '老申请' }), '', '老数据没有 troop 应返回空');
    assertEqual(Rules.troopOf(null), '');
    assertEqual(Rules.troopOf(undefined), '');
    assertEqual(Rules.troopOf({ troop: '雷达' }), '雷达');
    assertEqual(Rules.troopOf({ troop: '不存在的兵种' }), '其他');
  });

  test('直接入库时可以带兵种', async () => {
    await fresh();
    const res = await Ops.inbound({
      categoryId: 'mechanical', name: '备用轮组', quantity: 2,
      identityMode: 'shared', operator: '张三', troop: '哨兵'
    });
    assertEqual(res.items[0].troop, '哨兵', '入库时就该记下兵种');
  });

  test('直接入库不带兵种会被拒绝（兵种必填，第十三轮）', async () => {
    await fresh();
    // 显式传 troop:'' 绕过测试入口的默认垫层，验证数据层这条真规则
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: '扎带', quantity: 50,
      identityMode: 'shared', operator: '张三', troop: ''
    }), '没选兵种应被拒绝 —— 不选兵种的件会从兵种预算里静默漏掉');
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: '扎带', quantity: 50,
      identityMode: 'shared', operator: '张三', troop: '   '
    }), '只打了空格也等于没选');
  });

  test('直接入库时给了非法兵种会兜到「其他」', async () => {
    await fresh();
    const res = await Ops.inbound({
      categoryId: 'mechanical', name: '杂件', quantity: 1,
      identityMode: 'shared', operator: '张三', troop: '乱写的'
    });
    assertEqual(res.items[0].troop, '其他');
  });

  test('采购到货时物品自动继承申请上的兵种', async () => {
    await fresh();
    const req = await addRequest({ troop: '无人机', name: '桨叶', quantity: 4, budget: '800' });
    const res = await Ops.arrive({
      requestId: req.id, quantity: 4, invoiceNo: 'FP-1', amount: 780,
      supplier: '某公司', operator: '李四', identityMode: 'shared'
    });
    assertEqual(res.items[0].troop, '无人机', '物品的兵种要和采购申请一致，否则两边口径对不上');
    const saved = await DB.get('items', res.items[0].code);
    assertEqual(saved.troop, '无人机', '落库后仍然是这个兵种');
  });

  test('老申请（没有兵种）到货入库不会凭空编一个兵种出来', async () => {
    await fresh();
    const req = await addRequest({ troop: undefined, name: '老件', quantity: 1 });
    const res = await Ops.arrive({
      requestId: req.id, quantity: 1, invoiceNo: 'FP-2', amount: 10,
      supplier: '某公司', operator: '李四', identityMode: 'shared'
    });
    assertEqual(res.items[0].troop, '', '老数据应保持「未指定」，不猜');
  });

  test('兵种不影响原有的入库校验', async () => {
    await fresh();
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: 'x', quantity: 1, operator: '', troop: '步兵'
    }), '缺操作人仍然应被拒绝');
    await assertRejects(() => Ops.inbound({
      categoryId: 'mechanical', name: 'x', quantity: 0, operator: '张三', troop: '步兵'
    }), '数量 0 仍然应被拒绝');
  });

  test('兵种被存进采购申请后能原样读回（备份导出导入不丢）', async () => {
    await fresh();
    const req = await addRequest({ troop: '能量机关', name: '气弹簧' });
    const back = await DB.get('purchaseRequests', req.id);
    assertEqual(Rules.troopOf(back), '能量机关');

    const payload = await Rules.exportAll();
    assertEqual(Rules.validateBackup(payload).ok, true, '备份应合法');
    await Rules.importAll(payload);
    const after = await DB.get('purchaseRequests', req.id);
    assertEqual(after.troop, '能量机关', '导入备份后兵种必须还在');
  });

  /* ---------- 第二十二轮：新增三个车型兵种 ---------- */

  test('新增的舵轮机器人 / 老步兵机器人 / 新步兵机器人：可选、可存、可读回', async () => {
    const added = ['舵轮机器人', '老步兵机器人', '新步兵机器人'];
    added.forEach((t) => {
      assertEqual(Rules.TROOP_OPTIONS.indexOf(t) !== -1, true, t + ' 应出现在下拉框里');
      assertEqual(Rules.normalizeTroop(t), t, t + ' 是合法兵种，不该被折成「其他」');
    });

    await fresh();
    for (const t of added) {
      const req = await addRequest({ troop: t, name: '件-' + t });
      assertEqual(Rules.troopOf(await DB.get('purchaseRequests', req.id)), t);
    }
  });

  test('纯新增：旧的三个细分步兵一个都没动（老数据与预算归属不受影响）', async () => {
    ['轮腿步兵', '过洞步兵', '可折叠步兵'].forEach((t) => {
      assertEqual(Rules.TROOP_OPTIONS.indexOf(t) !== -1, true, t + ' 必须仍然可选（本轮定的是"旧的保留"）');
      assertEqual(Rules.normalizeTroop(t), t, t + ' 的归属不能变');
    });
    // 历史值「步兵」也照旧只用于读取，不进下拉框
    assertEqual(Rules.TROOP_OPTIONS.indexOf('步兵'), -1, '「步兵」仍然不出现在下拉框里');
    assertEqual(Rules.normalizeTroop('步兵'), '步兵', '但老数据里的「步兵」仍然归它自己，不许折成「其他」');
  });

  test('筛选栏的兵种列表：全量列出，不靠"数据里出现过"', async () => {
    const list = Rules.troopFilterList([]);
    // 核心：一条申请都没有的时候，也得能看到全部可选兵种 ——
    // 原来采购申请页用"从现有申请里收集"，新兵种就永远不显示（用户反馈的"兵种不全"）
    ['舵轮机器人', '老步兵机器人', '新步兵机器人', '重装', '哨兵', '其他'].forEach((t) => {
      assert(list.indexOf(t) !== -1, '空数据时也应列出 ' + t + '，实际：' + list.join('、'));
    });
    assertEqual(list.length, Rules.TROOP_OPTIONS.length);
    assertEqual(list.indexOf('步兵'), -1, '历史值只在数据里真的出现过时才补进来');
  });

  test('筛选栏的兵种列表：数据里出现过的历史值要补进来', async () => {
    const list = Rules.troopFilterList(['步兵', '哨兵', '哨兵', '', null, undefined]);
    assert(list.indexOf('步兵') !== -1, '老申请写着「步兵」，筛选项必须有它，否则那些申请筛不出来');
    assertEqual(list.length, Rules.TROOP_OPTIONS.length + 1, '补了历史值，但不该重复加');
    assert(list.indexOf('' ) === -1 && list.indexOf(null) === -1, '空值不该变成选项');
  });

  test('筛选栏的兵种列表：乱七八糟的旧值不会被当成兵种', async () => {
    const list = Rules.troopFilterList(['这是个不存在的兵种']);
    assert(list.indexOf('这是个不存在的兵种') === -1, '不认识的值会被归一化成「其他」，不该原样出现');
    assert(list.indexOf('其他') !== -1);
  });
};
