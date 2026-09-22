/**
 * 采购申请的审批状态：兼容规则、状态判定、以及"没批准不能入库"这道闸。
 *
 * 这一组里最要紧的是**老数据的兼容**：approval 字段是后加的，
 * 引入之前建的单子没有这个字段。如果把它们当成"没批过"，上线当天所有在途
 * 申请会一起卡住，还得逐条补点一次同意 —— 加功能不能这么弄坏原有流程。
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

  test('三种合法审批状态原样返回', async () => {
    assertEqual(Rules.approvalOf({ approval: 'pending' }), 'pending');
    assertEqual(Rules.approvalOf({ approval: 'approved' }), 'approved');
    assertEqual(Rules.approvalOf({ approval: 'rejected' }), 'rejected');
  });

  test('老数据没有 approval 字段 → 视为已同意（不追溯卡住在途的单子）', async () => {
    assertEqual(Rules.approvalOf({ name: '老申请' }), 'approved');
    assertEqual(Rules.approvalOf({ approval: '' }), 'approved');
    assertEqual(Rules.approvalOf({ approval: null }), 'approved');
    assertEqual(Rules.approvalOf({ approval: undefined }), 'approved');
    assertEqual(Rules.approvalOf(null), 'approved', '传空对象也不该炸');
    assertEqual(Rules.isApproved({ name: '老申请' }), true, '老数据应当能继续走到货');
  });

  test('认不出来的值按「待审批」处理（宁可多让管理员点一次）', async () => {
    assertEqual(Rules.approvalOf({ approval: 'approved ' }), 'approved', '两端空格要去掉');
    assertEqual(Rules.approvalOf({ approval: 'AGREED' }), 'pending', '看不懂的值按最保守的处理');
    assertEqual(Rules.approvalOf({ approval: '1' }), 'pending');
  });

  test('isApproved / isPendingApproval 与 approvalOf 一致，且互斥', async () => {
    ['pending', 'approved', 'rejected'].forEach((a) => {
      const row = { approval: a };
      assert(!(Rules.isApproved(row) && Rules.isPendingApproval(row)),
        a + ' 不该同时是"已同意"和"待审批"');
    });
    assertEqual(Rules.isApproved({ approval: 'approved' }), true);
    assertEqual(Rules.isPendingApproval({ approval: 'pending' }), true);
    assertEqual(Rules.isApproved({ approval: 'rejected' }), false);
    assertEqual(Rules.isPendingApproval({ approval: 'rejected' }), false, '被驳回不是"待审批"');
  });

  test('审批状态和理由能存进申请并原样读回', async () => {
    await fresh();
    const req = await addRequest({ approval: 'pending' });
    const saved = await DB.get('purchaseRequests', req.id);
    saved.approval = 'rejected';
    saved.approvalNote = '预算不够';
    saved.approvedAt = DB.nowIso();
    saved.status = 'canceled';
    await DB.put('purchaseRequests', saved);

    const back = await DB.get('purchaseRequests', req.id);
    assertEqual(back.approval, 'rejected');
    assertEqual(back.approvalNote, '预算不够');
    assertEqual(back.status, 'canceled', '驳回应同时落到终态');
    assert(!!back.approvedAt, '应记下处理时间');
  });

  test('没审批的申请不能入库（数据层拦住，不只是界面上不画按钮）', async () => {
    await fresh();
    const req = await addRequest({ approval: 'pending', name: '待批件', quantity: 2, budget: '500' });
    await assertRejects(() => Ops.arrive({
      requestId: req.id, quantity: 2, invoiceNo: 'FP-1', amount: 480,
      supplier: '某公司', operator: '李四', identityMode: 'shared'
    }), '待审批的申请不该能入库');

    // 拒绝之后不能留下半截数据
    assertEqual((await DB.getAll('items')).length, 0, '被拒时不该生成物品');
    assertEqual((await DB.getAll('invoices')).length, 0, '被拒时不该生成发票');
    assertEqual((await DB.getAll('transactions')).length, 0, '被拒时不该留下流水');
    const back = await DB.get('purchaseRequests', req.id);
    assertEqual(back.status, 'pending', '被拒后申请状态不该变');
  });

  test('被驳回的申请不能入库，报错要说清是被驳回（不是"还没批"）', async () => {
    await fresh();
    const req = await addRequest({ approval: 'rejected', status: 'canceled', name: '被拒件' });
    let message = '';
    try {
      await Ops.arrive({
        requestId: req.id, quantity: 1, invoiceNo: 'FP-9', amount: 10,
        supplier: '某公司', operator: '李四', identityMode: 'shared'
      });
    } catch (err) { message = err.userMessage || err.message; }
    assert(/驳回/.test(message), '错误里应说明是被驳回，实际：' + message);
    assertEqual((await DB.getAll('items')).length, 0, '不该生成物品');
  });

  test('已同意（以及没有 approval 字段的老数据）照常入库', async () => {
    await fresh();
    const approved = await addRequest({ approval: 'approved', name: '已批件', quantity: 1, budget: '300' });
    const res = await Ops.arrive({
      requestId: approved.id, quantity: 1, invoiceNo: 'FP-A', amount: 280,
      supplier: '某公司', operator: '李四', identityMode: 'shared'
    });
    assertEqual(res.items.length, 1, '已同意的申请应当能正常入库');

    const legacy = await addRequest({ name: '老件', quantity: 1, budget: '300' });   // 没有 approval
    const res2 = await Ops.arrive({
      requestId: legacy.id, quantity: 1, invoiceNo: 'FP-B', amount: 290,
      supplier: '某公司', operator: '李四', identityMode: 'shared'
    });
    assertEqual(res2.items.length, 1, '老数据（引入审批之前建的）也必须能继续入库');
  });

  test('审批状态不会影响原有的入库校验', async () => {
    await fresh();
    // 发票号改为选填后（第十三轮），空号照样能入库；数量 0 这类老校验仍然挡着
    const req = await addRequest({ approval: 'approved', name: '待检件' });
    const res = await Ops.arrive({
      requestId: req.id, quantity: 1, invoiceNo: '', amount: 10,
      supplier: '某公司', operator: '李四'
    });
    assertEqual(res.items.length, 1, '发票号选填后，空号应能正常入库');

    const req2 = await addRequest({ approval: 'approved', name: '待检件二' });
    await assertRejects(() => Ops.arrive({
      requestId: req2.id, quantity: 0, invoiceNo: 'FP-1', amount: 10,
      supplier: '某公司', operator: '李四'
    }), '数量 0 仍然应被拒绝');
  });

  test('新建的采购申请一定是「待审批」', async () => {
    // 这条是踩坑之后补的：approvalOf 对**没有 approval 字段**的记录按「已同意」处理
    // （给老数据留的兼容），所以创建时漏写这个字段，新申请会被静默放行 ——
    // 界面显示"已同意"、审批按钮根本不出现，而且全程没有任何报错。
    await fresh();
    const id = await Ops.createRequest({
      categoryId: 'vision', troop: '步兵', name: '工业相机', quantity: 2,
      budget: '6000', applicant: '张三', purpose: '色块识别'
    });
    const saved = await DB.get('purchaseRequests', id);
    assertEqual(saved.approval, 'pending', '新申请必须显式写成待审批，不能靠"没有字段"');
    assertEqual(saved.status, 'pending');
    assertEqual(Rules.isApproved(saved), false, '新申请不该被当成已同意');
    assertEqual(Rules.isPendingApproval(saved), true);
  });

  test('新建申请会校验兵种和必填项', async () => {
    await fresh();
    const base = { categoryId: 'vision', troop: '步兵', name: '件', quantity: 1, applicant: '张三' };
    await assertRejects(() => Ops.createRequest(Object.assign({}, base, { troop: '' })),
      '兵种空着应被拒绝（它是预算的归类键）');
    await assertRejects(() => Ops.createRequest(Object.assign({}, base, { troop: '视觉' })),
      '兵种不在列表里应被拒绝（视觉是大类，不是兵种）');
    await assertRejects(() => Ops.createRequest(Object.assign({}, base, { name: '' })),
      '物品名称空着应被拒绝');
    await assertRejects(() => Ops.createRequest(Object.assign({}, base, { applicant: '' })),
      '申请人空着应被拒绝');
    await assertRejects(() => Ops.createRequest(Object.assign({}, base, { quantity: 0 })),
      '数量 0 应被拒绝');
    await assertRejects(() => Ops.createRequest(Object.assign({}, base, { budget: '-5' })),
      '负数预算应被拒绝');
    assertEqual((await DB.getAll('purchaseRequests')).length, 0, '被拒的不该留下记录');
  });

  test('新建申请时预算留空是允许的（有些人还不知道要花多少钱）', async () => {
    await fresh();
    const id = await Ops.createRequest({
      categoryId: 'hardware', troop: '其他', name: '扎带', quantity: 100, applicant: '王五'
    });
    const saved = await DB.get('purchaseRequests', id);
    assertEqual(saved.budget, '', '没填预算就是空字符串');
    assertEqual(saved.troop, '其他');
  });

  test('备份导出导入之后审批状态和理由都还在', async () => {
    await fresh();
    const req = await addRequest({ approval: 'rejected', status: 'canceled', approvalNote: '重复申请' });
    const payload = await Rules.exportAll();
    assertEqual(Rules.validateBackup(payload).ok, true, '备份应合法');
    await Rules.importAll(payload);
    const back = await DB.get('purchaseRequests', req.id);
    assertEqual(back.approval, 'rejected', '导入后审批状态必须还在');
    assertEqual(back.approvalNote, '重复申请', '驳回理由也要保留，它是唯一的解释');
  });
};
