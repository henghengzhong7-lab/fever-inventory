/**
 * 兵种字段：常量、规范化、采购申请表单一侧的规则、到货入库的继承。
 *
 * 兵种是「兵种预算」的归类键，所以它的取值必须被约束住 ——
 * 随便存一个字符串进去，那笔钱就会从预算汇总里漏掉，而且是静默漏掉。
 */
'use strict';

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

  test('兵种选项是需求方给的这 9 个，且「其他」排在最后', async () => {
    assertDeepEqual(Rules.TROOPS,
      ['重装', '步兵', '哨兵', '飞镖', '无人机', '雷达', '前哨战', '能量机关', '其他']);
    assertEqual(Rules.TROOPS[Rules.TROOPS.length - 1], '其他', '「其他」必须是最后一个（它是兜底项，不该被误选）');
    assertEqual(Rules.TROOPS.length, 9);
    assertEqual(new Set(Rules.TROOPS).size, 9, '兵种不能有重复项');
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
};
