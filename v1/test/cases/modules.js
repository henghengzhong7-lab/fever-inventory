/**
 * 四大类专属逻辑：机械标准件与位置索引、电控安全与电池、
 * 视觉标定看板与配套关系、硬件工具校准与耗材余量。
 *
 * 这些是"四个大类各不相同"的核心依据，必须逐类有独立断言。
 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual } = H;

  const sys = typeof globalThis !== 'undefined' ? globalThis : global;
  const mods = {};
  // 大类工作区要用通用界面件拼 HTML，Node 里也加载一份（只拼字符串，不碰 document）
  require('../../js/ui.js');
  ['mechanical', 'electronic', 'vision', 'hardware'].forEach((id) => {
    // 这些文件是浏览器/Node 双用的 IIFE，加载后挂在全局上
    require('../../js/modules/' + id + '.js');
    mods[id] = sys.FEVER.Modules[id];
  });

  const today = new Date('2026-09-21T10:00:00+08:00');

  test('四个大类模块都注册成功且各自实现了 workspace', async () => {
    ['mechanical', 'electronic', 'vision', 'hardware'].forEach((id) => {
      assert(mods[id], '应有 ' + id + ' 模块');
      assertEqual(mods[id].id, id);
      assert(typeof mods[id].workspace === 'function', id + ' 应有 workspace');
    });
  });

  test('四个大类的专属能力集合互不相同', async () => {
    const keys = (m) => Object.keys(m).filter((k) => k !== 'id' && k !== 'workspace')
      .filter((k) => typeof m[k] === 'function').sort().join(',');
    const sets = ['mechanical', 'electronic', 'vision', 'hardware'].map((id) => keys(mods[id]));
    assertEqual(new Set(sets).size, 4, '四类的功能集合应两两不同，实际：' + sets.join(' || '));
  });

  /* ---------- 机械：标准件库存 + 装配位置索引 ---------- */

  test('机械：标准件库存只收同款共用件，并标出低库存', async () => {
    const items = [
      { code: 'MC-0001', name: 'M4螺丝', identityMode: 'shared', inStockQty: 20, safetyStock: 30 },
      { code: 'MC-0002', name: '铝型材', identityMode: 'shared', inStockQty: 50, safetyStock: 10 },
      { code: 'MC-0003', name: '主车底盘', identityMode: 'single', inStockQty: 1, safetyStock: 1 }
    ];
    const rows = mods.mechanical.standardStock(items);
    assertEqual(rows.length, 2, '单独建身份的不该进标准件表');
    const m4 = rows.find((r) => r.code === 'MC-0001');
    assertEqual(m4.low, true, '在库 20 低于安全库存 30，应标低库存');
    assertEqual(rows.find((r) => r.code === 'MC-0002').low, false, '在库 50 高于 10，不该标低库存');
  });

  test('机械：没设安全库存的标准件不算低库存', async () => {
    const rows = mods.mechanical.standardStock([
      { code: 'MC-0001', name: '垫片', identityMode: 'shared', inStockQty: 0, safetyStock: null }
    ]);
    assertEqual(rows[0].safety, null);
    assertEqual(rows[0].low, false, '没设安全库存不应报低库存');
  });

  test('机械：装配位置索引按位置归堆并跳过没填位置的', async () => {
    const items = [
      { code: 'MC-0001', name: '侧板', extra: { assemblePos: '底盘左侧' } },
      { code: 'MC-0002', name: '支架', extra: { assemblePos: '底盘左侧' } },
      { code: 'MC-0003', name: '螺丝', extra: {} }
    ];
    const index = mods.mechanical.positionIndex(items);
    assertEqual(index.length, 1, '只应有一个装配位置');
    assertEqual(index[0].position, '底盘左侧');
    assertEqual(index[0].items.length, 2, '该位置下应有 2 种物品');
  });

  /* ---------- 电控：安全等级 + 易损件 + 电池 ---------- */

  test('电控：只有「高压危险」才算危险件，「注意」不算', async () => {
    assertEqual(mods.electronic.isDangerous({ extra: { safetyLevel: '高压危险' } }), true);
    assertEqual(mods.electronic.isDangerous({ extra: { safetyLevel: '注意' } }), false);
    assertEqual(mods.electronic.needsAttention({ extra: { safetyLevel: '注意' } }), true);
    assertEqual(mods.electronic.isDangerous({ extra: {} }), false);
  });

  test('电控：电池清单按循环次数从高到低排，衰减明显的被标出', async () => {
    const rows = mods.electronic.batteryList([
      { code: 'EL-0001', name: '电池A', extra: { batteryCycles: '120', batteryHealth: '良好' } },
      { code: 'EL-0002', name: '电池B', extra: { batteryCycles: '400', batteryHealth: '衰减明显' } },
      { code: 'EL-0003', name: '电调', extra: {} }
    ]);
    assertEqual(rows.length, 2, '没登记电池信息的不该出现');
    assertEqual(rows[0].code, 'EL-0002', '循环次数高的排前面');
    assertEqual(rows[0].decayed, true);
    assertEqual(rows[0].worn, true, '循环 400 次应算偏高');
    assertEqual(rows[1].worn, false, '循环 120 次不算偏高');
  });

  test('电控：易损件超过更换周期算到期', async () => {
    const electronic = { reminders: { spareCycleDays: 180 } };
    const rows = mods.electronic.spareParts([
      { code: 'EL-0001', name: '风扇', extra: { lastReplaceDate: '2025-01-01' } },
      { code: 'EL-0002', name: '新风扇', extra: { lastReplaceDate: '2026-09-01' } }
    ], electronic, today);
    assertEqual(rows.length, 2);
    assertEqual(rows.find((r) => r.code === 'EL-0001').due, true, '超 180 天应到期');
    assertEqual(rows.find((r) => r.code === 'EL-0002').due, false, '刚换过不该到期');
  });

  /* ---------- 视觉：标定看板 + 配套关系 ---------- */

  test('视觉：标定超过周期标成「需重新标定」并排最前', async () => {
    const vision = { reminders: { calibrationDays: 90 } };
    const rows = mods.vision.calibrationBoard([
      { code: 'VS-0001', name: '老相机', identityMode: 'single', extra: { lastCalibrationDate: '2026-01-01', calibrationStatus: '已标定' } },
      { code: 'VS-0002', name: '新相机', identityMode: 'single', extra: { lastCalibrationDate: '2026-09-10', calibrationStatus: '已标定' } },
      { code: 'VS-0003', name: '没标过的', identityMode: 'single', extra: {} }
    ], vision, today);
    assertEqual(rows[0].overdue, true, '超期的应排最前');
    assertEqual(rows[0].status, '需重新标定', '超期应把状态改写成需重新标定');
    const fresh = rows.find((r) => r.code === 'VS-0002');
    assertEqual(fresh.overdue, false);
    assertEqual(fresh.status, '已标定', '没过期不该改写状态');
    assertEqual(rows.find((r) => r.code === 'VS-0003').overdue, true, '从未标定算超期');
  });

  test('视觉：配套关系能对上库里的那台设备，对不上也如实标出', async () => {
    const pairs = mods.vision.pairing([
      { code: 'VS-0001', name: '镜头', extra: { cameraPair: '配 VS-0002' } },
      { code: 'VS-0002', name: '相机', extra: {} },
      { code: 'VS-0003', name: '备用镜头', extra: { cameraPair: 'VS-9999' } }
    ]);
    const hit = pairs.find((p) => p.fromCode === 'VS-0001');
    assertEqual(hit.toCode, 'VS-0002', '应能从「配 VS-0002」里取出编码');
    assertEqual(hit.resolved, true);
    assertEqual(hit.toName, '相机');
    assertEqual(pairs.find((p) => p.fromCode === 'VS-0003').resolved, false, '库里没有的要标出来');
  });

  /* ---------- 硬件：工具校准 + 耗材余量 ---------- */

  test('硬件：工具检定台账只收工具，到期排前面', async () => {
    const hardware = { reminders: { toolCalibrationDays: 180 } };
    const rows = mods.hardware.toolLedger([
      { code: 'HW-0001', name: '电烙铁', inStockQty: 1, lentQty: 0, extra: { isTool: '是', lastCalibrationDate: '2026-01-01' } },
      { code: 'HW-0002', name: '新扳手', inStockQty: 2, lentQty: 0, extra: { isTool: '是', lastCalibrationDate: '2026-09-15' } },
      { code: 'HW-0003', name: '螺丝', inStockQty: 100, lentQty: 0, extra: { isTool: '否' } }
    ], hardware, today);
    assertEqual(rows.length, 2, '不是工具的不该进检定台账');
    assertEqual(rows[0].code, 'HW-0001', '到期的排前面');
    assertEqual(rows[0].due, true);
    assertEqual(rows.find((r) => r.code === 'HW-0002').due, false);
  });

  test('硬件：工具从未校准过也算到期', async () => {
    const rows = mods.hardware.toolLedger([
      { code: 'HW-0001', name: '新工具', inStockQty: 1, lentQty: 0, extra: { isTool: '是' } }
    ], { reminders: { toolCalibrationDays: 180 } }, today);
    assertEqual(rows[0].due, true, '从未校准应提示送检');
    assertEqual(rows[0].age, null);
  });

  test('硬件：耗材余量表把用完的和需补货的分开', async () => {
    const rows = mods.hardware.consumableLevels([
      { code: 'HW-0001', name: '扎带', inStockQty: 0, safetyStock: 50 },
      { code: 'HW-0002', name: '热缩管', inStockQty: 20, safetyStock: 100 },
      { code: 'HW-0003', name: '螺丝', inStockQty: 500, safetyStock: 100 },
      { code: 'HW-0004', name: '扳手', inStockQty: 2, extra: { isTool: '是' } }
    ]);
    assertEqual(rows.length, 3, '工具不该进耗材余量表');
    const tie = rows.find((r) => r.code === 'HW-0001');
    assertEqual(tie.out, true, '没有余量应标已用完');
    assertEqual(tie.low, true);
    assertEqual(rows.find((r) => r.code === 'HW-0003').low, false);
  });

  test('硬件：耗材没设安全库存时不算需补货', async () => {
    const rows = mods.hardware.consumableLevels([
      { code: 'HW-0001', name: '自攻钉', inStockQty: 0, safetyStock: null }
    ]);
    assertEqual(rows[0].safety, null);
    assertEqual(rows[0].low, false, '没设安全库存不应报需补货');
    assertEqual(rows[0].out, true, '但确实没余量了');
  });

  /* ---------- 四类的工作区 HTML 各不同 ---------- */

  test('四个大类的工作区 HTML 各不相同且都不为空', async () => {
    await Rules.clearAll();
    await Rules.initCategories();
    const cats = await DB.getAll('categories');
    const summary = { category: null, items: [], itemCount: 0, itemKinds: 0, inStockQty: 0, lentQty: 0, reminders: [], lowStock: 0 };
    const outs = {};
    ['mechanical', 'electronic', 'vision', 'hardware'].forEach((id) => {
      const cat = cats.find((c) => c.id === id);
      const html = mods[id].workspace(Object.assign({}, summary, { category: cat }), cat, today);
      assert(html && html.length > 100, id + ' 的工作区应有内容');
      outs[id] = html;
    });
    const texts = Object.keys(outs).map((k) => outs[k]);
    assertEqual(new Set(texts).size, 4, '四类工作区内容应两两不同');
    assert(outs.mechanical.includes('标准件库存'), '机械应有标准件库存');
    assert(outs.mechanical.includes('装配位置索引'), '机械应有装配位置索引');
    assert(outs.electronic.includes('安全等级警示'), '电控应有安全等级警示');
    assert(outs.electronic.includes('电池健康'), '电控应有电池健康');
    assert(outs.vision.includes('标定看板'), '视觉应有标定看板');
    assert(outs.vision.includes('镜头与相机配套'), '视觉应有配套关系');
    assert(outs.hardware.includes('工具校准检定'), '硬件应有工具校准');
    assert(outs.hardware.includes('耗材余量'), '硬件应有耗材余量');
  });

  test('工作区里的编码都带 data-goto-item，能跳回物品详情', async () => {
    await Rules.clearAll();
    await Rules.initCategories();
    const cat = await DB.get('categories', 'vision');
    const items = [
      { code: 'VS-0001', name: '相机', identityMode: 'single', inStockQty: 1, lentQty: 0,
        extra: { lastCalibrationDate: '2026-01-01', cameraPair: 'VS-0002' } },
      { code: 'VS-0002', name: '镜头', identityMode: 'single', inStockQty: 1, lentQty: 0, extra: {} }
    ];
    const html = mods.vision.workspace(
      { category: cat, items, itemKinds: 2, inStockQty: 2, lentQty: 0, reminders: [], lowStock: 0 },
      cat, today);
    assert(html.includes('data-goto-item="VS-0001"'), '标定看板里的编码应可跳转');
    assert(html.includes('data-goto-item="VS-0002"'), '配套关系里的编码应可跳转');
  });
};
