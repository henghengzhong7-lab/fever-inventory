/**
 * 打包提交（第十五轮）：批次号、待提交清单、整批同意。
 *
 * 这一组用例盯三件事：
 *   1. 草稿阶段的校验**与正式提交完全一致**（否则攒十条最后整批被拒）；
 *   2. 打包提交后这一批共享同一个批次号 —— 提醒合并、批量到货、按批打包发票全靠它；
 *   3. 只清掉真正提交了的草稿，没钩的留着。
 *
 * ⚠️ 草稿接口都只收**一个对象**（key 放进对象里，而不是第二个参数）：
 * 对外的 Ops 方法都过了 guard()，而 guard 只透传第一个参数。
 */
'use strict';

const Stats = require('../../js/stats.js');

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  const base = {
    categoryId: 'mechanical', troop: '哨兵', name: '打包件',
    quantity: 1, budget: '100', applicant: '张三'
  };

  /** 统一给草稿接口补上 key */
  function withKey(key, extra) {
    return Object.assign({ key: key }, base, extra || {});
  }

  /* ---------- 批次号 ---------- */

  test('批次号：带日期、够短、同一天内不重复', async () => {
    const id = Rules.newBatchId('2026-10-06T03:00:00.000Z', 'abcd');
    assert(/^B-20261006-ABCD$/.test(id), '格式应是 B-日期-4位，实际 ' + id);
    const real = Rules.newBatchId(DB.nowIso());
    assert(/^B-\d{8}-[A-Z0-9]{4}$/.test(real), '真实生成的也要符合格式，实际 ' + real);
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) seen.add(Rules.newBatchId(DB.nowIso()));
    assert(seen.size > 40, '50 次生成应基本不重复，实际 ' + seen.size);
  });

  test('待提交清单算谁的：有飞书身份按 openId 隔离，离线版一个本机格子', async () => {
    assertEqual(Rules.ownerKey({ openId: 'ou_abc', name: '张三' }), 'openId:ou_abc');
    assertEqual(Rules.ownerKey(null), 'local', '离线版没有登录身份');
    assertEqual(Rules.ownerKey({}), 'local');
    assertEqual(Rules.draftCartKey('openId:ou_abc'), 'draftCart:openId:ou_abc');
    assertEqual(Rules.draftCartKey(''), 'draftCart:local');
  });

  /* ---------- 草稿篮 ---------- */

  test('草稿：能存能读能删，且按人隔离（队友看不到）', async () => {
    await fresh();
    assertEqual((await Ops.loadDraftCart({ key: 'local' })).length, 0, '空清单是 []，不是 undefined');

    await Ops.addToDraftCart(withKey('local'));
    await Ops.addToDraftCart(withKey('local', { name: '第二件' }));
    await Ops.addToDraftCart(withKey('openId:ou_other', { name: '别人的' }));

    const mine = await Ops.loadDraftCart({ key: 'local' });
    assertEqual(mine.length, 2, '自己看到 2 条');
    assertEqual(mine[0].name, '打包件');
    assertEqual(mine[0].draftId.length > 1, true, '每条草稿有自己的号，删的时候认它');
    assertEqual((await Ops.loadDraftCart({ key: 'openId:ou_other' })).length, 1, '别人的清单互不干扰');

    const r = await Ops.removeFromDraftCart({ key: 'local', draftId: mine[0].draftId });
    assertEqual(r.removed, 1);
    assertEqual((await Ops.loadDraftCart({ key: 'local' })).length, 1);
  });

  test('草稿阶段的校验和正式提交一模一样', async () => {
    await fresh();
    await assertRejects(() => Ops.addToDraftCart(withKey('local', { troop: '' })),
      '缺兵种存不进去 —— 别等打包那一刻整批被拒');
    await assertRejects(() => Ops.addToDraftCart(withKey('local', { name: '' })));
    await assertRejects(() => Ops.addToDraftCart(withKey('local', { budget: '乱写' })));
    assertEqual((await Ops.loadDraftCart({ key: 'local' })).length, 0, '被拒的草稿不该留在清单里');
  });

  test('草稿里的购买链接也过一遍规范化', async () => {
    await fresh();
    await Ops.addToDraftCart(withKey('local', { link: 'item.jd.com/1.html' }));
    const list = await Ops.loadDraftCart({ key: 'local' });
    assertEqual(list[0].link, 'https://item.jd.com/1.html');
  });

  /* ---------- 打包提交 ---------- */

  test('打包提交：共享一个批次号，只清掉提交掉的，没钩的留着', async () => {
    await fresh();
    const a = await Ops.addToDraftCart(withKey('local', { name: '甲' }));
    const b = await Ops.addToDraftCart(withKey('local', { name: '乙' }));
    await Ops.addToDraftCart(withKey('local', { name: '丙' }));

    const res = await Ops.submitDraftCart({
      key: 'local', draftIds: [a.draft.draftId, b.draft.draftId], applicant: '李四'
    });
    assertEqual(res.ok, true);
    assertEqual(res.count, 2);
    assertEqual(res.ids.length, 2);

    const reqs = await DB.getAll('purchaseRequests');
    assertEqual(reqs.length, 2, '草稿不是申请，只有提交过的才进申请表');
    reqs.forEach((r) => {
      assertEqual(r.batchId, res.batchId, '这一批共享同一个批次号');
      assertEqual(r.applicant, '李四', '打包时填的申请人统一覆盖');
      assertEqual(r.approval, 'pending', '照样是待审批 —— 不能被兼容规则静默放行');
      assertEqual(r.status, 'pending');
    });

    const rest = await Ops.loadDraftCart({ key: 'local' });
    assertEqual(rest.length, 1, '没钩的那条留在清单里');
    assertEqual(rest[0].name, '丙');
  });

  test('打包提交：一条都没钩会被拒，且不动清单', async () => {
    await fresh();
    await Ops.addToDraftCart(withKey('local'));
    await assertRejects(() => Ops.submitDraftCart({ key: 'local', draftIds: [] }));
    assertEqual((await Ops.loadDraftCart({ key: 'local' })).length, 1, '清单原样不动');
    assertEqual((await DB.getAll('purchaseRequests')).length, 0);
  });

  test('单独提交（不走打包）的申请不带批次号 —— 历史记录保持干净', async () => {
    await fresh();
    const id = await Ops.createRequest(base);
    const req = await DB.get('purchaseRequests', id);
    assertEqual(req.batchId, undefined, '单条提交不写这个键，而不是写空串');
  });

  test('打包提交能被备份导出导入完整带走（含批次号）', async () => {
    await fresh();
    const a = await Ops.addToDraftCart(withKey('local'));
    const res = await Ops.submitDraftCart({ key: 'local', draftIds: [a.draft.draftId] });
    const payload = await Rules.exportAll();
    await Rules.clearAll();
    await Rules.importAll(payload);
    const back = await DB.get('purchaseRequests', res.ids[0]);
    assertEqual(back.batchId, res.batchId);
  });

  /* ---------- 整批同意 ---------- */

  test('整批同意：一次全批，已经批过的和不存在的不报错只跳过', async () => {
    await fresh();
    const a = await Ops.addToDraftCart(withKey('local', { name: '甲' }));
    const b = await Ops.addToDraftCart(withKey('local', { name: '乙' }));
    const c = await Ops.addToDraftCart(withKey('local', { name: '丙' }));
    const res = await Ops.submitDraftCart({
      key: 'local', draftIds: [a.draft.draftId, b.draft.draftId, c.draft.draftId]
    });

    // 先把第一条单独批掉，模拟"两个人同时在点整批同意"
    const first = await DB.get('purchaseRequests', res.ids[0]);
    await DB.put('purchaseRequests', Object.assign({}, first, { approval: 'approved', approvedAt: DB.nowIso() }));

    const r = await Ops.approveRequests(res.ids.concat([999999]));
    assertEqual(r.approved.length, 2, '只批掉这两条还没处理的');
    assertEqual(r.skipped, 2, '已批过的 1 条 + 不存在的 1 条，都是跳过而不是失败');

    const rows = await DB.getAll('purchaseRequests');
    assertEqual(rows.every((x) => x.approval === 'approved'), true);
    assertEqual(rows.every((x) => !!x.approvedAt), true, '都要记下同意时间');
  });

  test('整批同意：空名单会被拒，不会误伤整张表', async () => {
    await fresh();
    await assertRejects(() => Ops.approveRequests([]));
    await assertRejects(() => Ops.approveRequests(null));
  });

  /* ---------- 批次发票清单（第十六轮：列表页与批次页共用同一口径） ---------- */

  test('批次发票清单：能下的、缺票的、没到货的三件事分开报', async () => {
    const requests = [
      { id: 1, batchId: 'B-1', applicant: '王五', status: 'arrived' },
      { id: 2, batchId: 'B-1', applicant: '王五', status: 'arrived' },
      { id: 3, batchId: 'B-1', applicant: '李四', status: 'pending' },
      { id: 4, batchId: 'B-2', applicant: '赵六', status: 'arrived' }
    ];
    const invoices = [
      { id: 10, purchaseRequestId: 1, fileData: 'AAA' },
      { id: 11, purchaseRequestId: 2 },                       // 到货了但没传附件 → 缺票
      { id: 12, purchaseRequestId: 4, fileData: 'BBB' }
    ];

    const info = Stats.batchInvoiceInfo(requests, invoices, 'B-1');
    assertEqual(info.invoiceIds.join(','), '10', '只有带附件的发票能进打包');
    assertEqual(info.requests, 3, '这一批 3 条申请');
    assertEqual(info.arrived, 2, '其中 2 条已到货');
    assertEqual(info.missingNames.join(','), '王五', '缺票的人要去重（两条都是王五）');
    assertEqual(info.pendingNames.join(','), '李四', '没到货的单独列，不算"缺发票"');

    assertEqual(Stats.batchInvoiceInfo(requests, invoices, 'B-2').invoiceIds.join(','), '12');
    assertEqual(Stats.batchInvoiceInfo(requests, invoices, 'B-不存在').requests, 0,
      '不存在的批次应返回空，而不是抛错');
    assertEqual(Stats.batchInvoiceInfo([], [], 'B-1').invoiceIds.length, 0, '空输入也不该炸');
    assertEqual(Stats.batchInvoiceInfo(requests, invoices, '').requests, 0, '空批次号不匹配任何申请');
  });
};
