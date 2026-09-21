/** 提醒判定：低库存、标定、校准、易损件、安全警示、借用超期 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual } = H;

  const vision = {
    id: 'vision', name: '视觉', reminders: { calibrationDays: 90, toolCalibrationDays: 0, spareCycleDays: 365 }
  };
  const hardware = {
    id: 'hardware', name: '硬件', reminders: { calibrationDays: 0, toolCalibrationDays: 180, spareCycleDays: 365 }
  };
  const electronic = {
    id: 'electronic', name: '电控', reminders: { calibrationDays: 0, toolCalibrationDays: 0, spareCycleDays: 180 }
  };

  const today = new Date('2026-09-21T10:00:00+08:00');

  function kinds(list) { return list.map((r) => r.kind).sort(); }

  test('件数低于安全库存时提示补货', async () => {
    const list = Rules.remindersFor({ inStockQty: 2, safetyStock: 5, extra: {} }, vision, today);
    assert(kinds(list).includes('low_stock'), '应出现低库存提醒');
  });

  test('件数不低于安全库存时不提示', async () => {
    const list = Rules.remindersFor({ inStockQty: 5, safetyStock: 5, extra: {} }, vision, today);
    assert(!kinds(list).includes('low_stock'), '刚好等于安全库存不应提示');
  });

  test('没设安全库存时不提示补货', async () => {
    const list = Rules.remindersFor({ inStockQty: 0, safetyStock: null, extra: {} }, vision, today);
    assert(!kinds(list).includes('low_stock'), '未设置安全库存不应提示');
  });

  test('视觉类超过标定周期提示需重新标定', async () => {
    const list = Rules.remindersFor(
      { inStockQty: 1, extra: { lastCalibrationDate: '2026-05-01' } }, vision, today);
    const hit = list.find((r) => r.kind === 'calibration');
    assert(hit, '应出现标定提醒');
    assert(/未标定/.test(hit.text), '提示应说明未标定天数，实际：' + hit.text);
  });

  test('视觉类在标定周期内不提示', async () => {
    const list = Rules.remindersFor(
      { inStockQty: 1, extra: { lastCalibrationDate: '2026-09-01' } }, vision, today);
    assert(!kinds(list).includes('calibration'), '未超期不应提示');
  });

  test('视觉类从未标定过时提示尚未标定', async () => {
    const list = Rules.remindersFor({ inStockQty: 1, extra: {} }, vision, today);
    const hit = list.find((r) => r.kind === 'calibration');
    assertEqual(hit.text, '尚未标定');
  });

  test('硬件类工具校准到期提示', async () => {
    const list = Rules.remindersFor(
      { inStockQty: 1, extra: { isTool: '是', lastCalibrationDate: '2026-01-01' } }, hardware, today);
    assert(kinds(list).includes('tool_calibration'), '应出现工具校准提醒');
  });

  test('非工具不提示校准', async () => {
    const list = Rules.remindersFor(
      { inStockQty: 1, extra: { isTool: '否', lastCalibrationDate: '2026-01-01' } }, hardware, today);
    assert(!kinds(list).includes('tool_calibration'), '不是工具不应提示校准');
  });

  test('电控易损件超过更换周期提示', async () => {
    const list = Rules.remindersFor(
      { inStockQty: 1, extra: { lastReplaceDate: '2025-01-01' } }, electronic, today);
    assert(kinds(list).includes('spare_cycle'), '应出现易损件更换提醒');
  });

  test('高压危险物品始终带安全警示', async () => {
    const list = Rules.remindersFor({ inStockQty: 1, extra: { safetyLevel: '高压危险' } }, electronic, today);
    const hit = list.find((r) => r.kind === 'safety');
    assert(hit, '应出现安全警示');
    assertEqual(hit.level, 'danger');
  });

  test('借用超期按天计算', async () => {
    const info = Rules.overdueInfo('2026-09-20', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(info.overdue, true);
    assertEqual(info.days, 1, '应超期 1 天');
  });

  test('今天到期不算超期', async () => {
    const info = Rules.overdueInfo('2026-09-21', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(info.overdue, false);
    assertEqual(info.days, 0);
  });

  test('未到期不算超期', async () => {
    const info = Rules.overdueInfo('2026-09-30', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(info.overdue, false);
  });

  test('没填归还日期不算超期', async () => {
    const info = Rules.overdueInfo('', new Date('2026-09-21T10:00:00+08:00'));
    assertEqual(info.overdue, false);
    assertEqual(info.days, 0);
  });
};
