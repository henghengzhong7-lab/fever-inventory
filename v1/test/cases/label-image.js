/**
 * 标签导出图片（第十八轮）。
 *
 * 只测纯逻辑（排版计算、条数上限、参数校验）—— 真画图要 canvas，
 * 那是浏览器端到端测试的活（见 items-tests.js 的「导出标签图片」用例）。
 */
'use strict';

const LabelImage = require('../../js/label-image.js');

module.exports.register = function (H) {
  const { test, assertEqual, assert } = H;

  function rejects(promise) {
    return promise.then(
      () => false,
      (err) => String((err && err.message) || err)
    );
  }

  test('排版：几张标签算出几行，画布尺寸随之变化', async () => {
    const one = LabelImage.layout(1);
    assertEqual(one.rows, 1, '1 张 → 1 行');
    assertEqual(one.cols, 3, '一行放 3 张');

    assertEqual(LabelImage.layout(3).rows, 1, '3 张刚好一行');
    assertEqual(LabelImage.layout(4).rows, 2, '4 张要两行');
    assertEqual(LabelImage.layout(24).rows, 8, '24 张 = 8 行（满页）');

    // 0 张也要给出合法画布，不能算出 0 或负数
    const zero = LabelImage.layout(0);
    assertEqual(zero.rows, 1);
    assert(zero.width > 0 && zero.height > 0, '画布尺寸必须为正');

    // 换行数变多，画布必须变高（否则第二行会被裁掉）
    assert(LabelImage.layout(10).height > LabelImage.layout(2).height,
      '标签变多时画布要变高，否则后面的行看不见');
  });

  test('一次最多 24 张，超了就该拦住并说清怎么分批', async () => {
    assertEqual(LabelImage.MAX_PER_IMAGE, 24);
    const msg = await rejects(LabelImage.render([]));
    assert(String(msg).indexOf('没有可导出') !== -1, '一张都没选要说清楚，实际：' + msg);

    const cards = [];
    for (let i = 0; i < 25; i += 1) cards.push({ code: 'MC-' + i, name: '件', qrDataUrl: null });
    const overMsg = await rejects(LabelImage.render(cards));
    assert(String(overMsg).indexOf('24') !== -1, '应说明一次最多几张，实际：' + overMsg);
    assert(String(overMsg).indexOf('分批') !== -1, '应告诉用户怎么分批，实际：' + overMsg);
  });
};
