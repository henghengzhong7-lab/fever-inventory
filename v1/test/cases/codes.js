/** 编码生成规则与二维码内容格式 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual, assertMatch, assertDeepEqual } = H;

  const MC = { id: 'mechanical', prefix: 'MC' };
  const VS = { id: 'vision', prefix: 'VS' };

  test('编码从 0001 开始并按大类顺延', async () => {
    await Rules.clearAll();
    const first = await Rules.nextCodes(MC, 1);
    const second = await Rules.nextCodes(MC, 1);
    assertDeepEqual(first, ['MC-0001']);
    assertDeepEqual(second, ['MC-0002']);
  });

  test('一次批量生成连续且不重号', async () => {
    const codes = await Rules.nextCodes(MC, 5);
    assertDeepEqual(codes, ['MC-0003', 'MC-0004', 'MC-0005', 'MC-0006', 'MC-0007']);
    assertEqual(new Set(codes).size, 5, '批量生成的编码不应重复');
  });

  test('两个大类的流水号互不影响', async () => {
    const vs = await Rules.nextCodes(VS, 2);
    assertDeepEqual(vs, ['VS-0001', 'VS-0002']);
    const mc = await Rules.nextCodes(MC, 1);
    assertDeepEqual(mc, ['MC-0008'], '机械的流水号应继续自己的序列，不被视觉影响');
  });

  test('编码格式为大类前缀加四位流水号', async () => {
    const codes = await Rules.nextCodes({ id: 'hardware', prefix: 'HW' }, 1);
    assertMatch(codes[0], /^HW-\d{4}$/, '编码格式应为 HW-0001 这种');
  });

  test('流水号超过 9999 时自动加位不重号', async () => {
    await DB.setSetting('codeCounter:EL', 9999);
    const codes = await Rules.nextCodes({ id: 'electronic', prefix: 'EL' }, 2);
    assertDeepEqual(codes, ['EL-10000', 'EL-10001']);
  });

  test('删除物品后编码不会被复用', async () => {
    const made = await Rules.nextCodes(MC, 1);
    await DB.put('items', {
      code: made[0], name: '临时件', categoryId: 'mechanical', identityMode: 'single',
      totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0,
      status: 'in_stock', extra: {}, createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    await DB.remove('items', made[0]);
    const next = await Rules.nextCodes(MC, 1);
    assert(next[0] !== made[0], '删掉的编码不能再次被使用');
    assertEqual(next[0], 'MC-0010', '应继续向后顺延到 MC-0010，而不是复用被删掉的 MC-0009');
  });

  test('二维码内容格式为 FEVER:ITEM:编码', async () => {
    assertEqual(Rules.qrPayload('VS-0003'), 'FEVER:ITEM:VS-0003');
  });

  test('能解析本系统的二维码内容', async () => {
    assertEqual(Rules.parseQrPayload('FEVER:ITEM:VS-0003'), 'VS-0003');
    assertEqual(Rules.parseQrPayload('  FEVER:ITEM:MC-0001  '), 'MC-0001');
    assertEqual(Rules.parseQrPayload('MC-0001'), 'MC-0001');
    assertEqual(Rules.parseQrPayload('https://example.com'), null);
    assertEqual(Rules.parseQrPayload(''), null);
  });
};
