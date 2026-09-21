/**
 * M6 的浏览器端到端测试：四个大类页面各不相同。
 *
 * 重点验"每个横块都有自己的场景功能"，不是同一张表换个名字：
 *   机械 = 标准件库存 + 装配位置索引
 *   电控 = 安全等级警示 + 易损件更换周期 + 电池健康
 *   视觉 = 标定看板 + 镜头相机配套 + 贵重设备去向
 *   硬件 = 工具校准检定 + 耗材余量 + 低库存报警
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var Ops = global.FEVER.Ops;
  var Rules = global.FEVER.Rules;
  var App = global.FEVER.App;

  function text(sel) {
    var node = document.querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function body() { return text('#view-root'); }

  /** 切到某个大类页，等到该类的专属工作区渲染出来 */
  function gotoCategory(id, marker) {
    App.goto('category', { id: id });
    return E2E.waitUntil('大类页 ' + id + ' 就绪', function () {
      return document.querySelector('#view-root').getAttribute('data-page') === 'category' &&
        body().indexOf(marker) !== -1;
    });
  }

  function panel(sel) { return document.querySelector(sel); }
  function rowsOf(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel + ' tbody tr'));
  }
  function cell(row, index) { return row.children[index].textContent.replace(/\s+/g, ' ').trim(); }

  /** 去年的日期，用来造"早就超期"的数据 */
  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    function p(x) { return String(x).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  async function run() {
    await E2E.resetDb();
    await Rules.initCategories();

    // ---- 机械：一个低库存标准件、一个充足标准件、一个单独件（带装配位置）
    await Ops.inbound({
      categoryId: 'mechanical', name: 'M4螺丝', spec: 'M4x12', quantity: 20,
      identityMode: 'shared', operator: '测试', safetyStock: 30,
      extra: { vehicle: '2026主车', assemblePos: '底盘左侧', material: '不锈钢' }
    });
    await Ops.inbound({
      categoryId: 'mechanical', name: '铝型材', spec: '2020', quantity: 50,
      identityMode: 'shared', operator: '测试', safetyStock: 10,
      extra: { assemblePos: '龙门架' }
    });
    await Ops.inbound({
      categoryId: 'mechanical', name: '底盘主梁', quantity: 1,
      identityMode: 'single', operator: '测试', extra: { assemblePos: '底盘左侧' }
    });

    // ---- 电控：高压危险件、超期易损件、衰减明显的电池
    await Ops.inbound({
      categoryId: 'electronic', name: '24V锂电组', quantity: 4, identityMode: 'shared',
      operator: '测试', extra: {
        voltage: '24V', safetyLevel: '高压危险',
        batteryCycles: '400', batteryHealth: '衰减明显', lastReplaceDate: daysAgo(400)
      }
    });
    await Ops.inbound({
      categoryId: 'electronic', name: '散热风扇', quantity: 6, identityMode: 'shared',
      operator: '测试', extra: { safetyLevel: '注意', lastReplaceDate: daysAgo(30) }
    });

    // ---- 视觉：超期未标定的相机 + 配套镜头 + 在借的贵重设备
    await Ops.inbound({
      categoryId: 'vision', name: '工业相机', spec: '500万像素', quantity: 1,
      identityMode: 'single', operator: '测试',
      extra: { resolution: '500万像素', lensMount: 'C', calibrationStatus: '已标定', lastCalibrationDate: daysAgo(120) }
    });
    await Ops.inbound({
      categoryId: 'vision', name: '定焦镜头', spec: '12mm', quantity: 1,
      identityMode: 'single', operator: '测试',
      extra: { lensMount: 'C', cameraPair: '配 VS-0001', calibrationStatus: '已标定', lastCalibrationDate: daysAgo(10) }
    });
    await Ops.lend({ code: 'VS-0001', qty: 1, operator: '测试', borrower: '王五', dueDate: '2030-01-01' });

    // ---- 硬件：到期的工具、没校准的工具、需要补货的耗材
    await Ops.inbound({
      categoryId: 'hardware', name: '电动螺丝刀', quantity: 2, identityMode: 'shared',
      operator: '测试', safetyStock: 5, location: '工具墙',
      extra: { isTool: '是', lastCalibrationDate: daysAgo(300) }
    });
    await Ops.inbound({
      categoryId: 'hardware', name: '扭力扳手', quantity: 1, identityMode: 'shared',
      operator: '测试', extra: { isTool: '是' }
    });
    await Ops.inbound({
      categoryId: 'hardware', name: '扎带', quantity: 20, identityMode: 'shared',
      operator: '测试', safetyStock: 100, extra: { isTool: '否' }
    });

    /* ================= 四类页面各不同 ================= */

    await E2E.record('四个大类页面渲染出的内容两两不同', async function () {
      var markers = {
        mechanical: '标准件库存', electronic: '安全等级警示',
        vision: '标定看板', hardware: '工具校准检定'
      };
      var snapshots = {};
      for (var id of Object.keys(markers)) {
        await gotoCategory(id, markers[id]);
        snapshots[id] = body();
      }
      var list = Object.keys(snapshots).map(function (k) { return snapshots[k]; });
      E2E.ok(new Set(list).size === 4, '四个大类页面内容应两两不同');
      // 每类的专属工作区标题，别的类不该出现
      E2E.ok(snapshots.mechanical.indexOf('装配位置索引') !== -1, '机械应有装配位置索引');
      E2E.ok(snapshots.mechanical.indexOf('标定看板') === -1, '机械不该出现视觉的标定看板');
      E2E.ok(snapshots.vision.indexOf('标准件库存') === -1, '视觉不该出现机械的标准件库存');
      E2E.ok(snapshots.hardware.indexOf('电池健康') === -1, '硬件不该出现电控的电池健康');
    });

    await E2E.record('机械页：标准件库存对照表标出低库存', async function () {
      await gotoCategory('mechanical', '标准件库存');
      var rows = rowsOf('#mod-mech-stock');
      E2E.ok(rows.length === 2, '应有 2 种标准件（单独建身份的底盘主梁不算），实际 ' + rows.length);

      var m4 = rows.filter(function (r) { return r.textContent.indexOf('M4螺丝') !== -1; })[0];
      E2E.ok(m4, '应有 M4螺丝');
      E2E.ok(m4.textContent.indexOf('需补货') !== -1, '在库 20 低于安全库存 30，M4螺丝应判为需补货');
      E2E.ok(m4.className.indexOf('row-low-stock') !== -1, '低库存行应有醒目样式');
      E2E.ok(m4.querySelector('[data-goto-item="MC-0001"]'), '标准件表里的编码应能跳到详情');

      var alu = rows.filter(function (r) { return r.textContent.indexOf('铝型材') !== -1; })[0];
      E2E.ok(alu && alu.textContent.indexOf('充足') !== -1, '铝型材在库 50 高于安全库存 10，应显示充足');
    });

    await E2E.record('机械页：装配位置索引把同位置的件归在一起', async function () {
      await gotoCategory('mechanical', '装配位置索引');
      var groups = Array.prototype.slice.call(document.querySelectorAll('#mod-mech-pos .pos-group'));
      E2E.ok(groups.length === 2, '应有 2 个装配位置，实际 ' + groups.length);
      var left = groups.filter(function (g) { return g.textContent.indexOf('底盘左侧') !== -1; })[0];
      E2E.ok(left, '应有「底盘左侧」分组');
      E2E.ok(left.textContent.indexOf('2 种') !== -1, '底盘左侧应有 2 种物品，实际：' + left.textContent.replace(/\s+/g, ' '));
      E2E.ok(left.querySelector('[data-goto-item="MC-0001"]') && left.querySelector('[data-goto-item="MC-0003"]'),
        '该位置下两种物品的编码都应列出');
    });

    await E2E.record('机械页：按装配位置筛选能只留该位置的件', async function () {
      await gotoCategory('mechanical', '物品清单');
      var input = document.querySelector('[name="f-assemblePos"]');
      E2E.ok(input, '机械页应有装配位置筛选框');
      E2E.setInput(input, '龙门架');
      await E2E.waitUntil('筛选后只剩 1 种', function () {
        return rowsOf('#cat-table').length === 1;
      });
      E2E.ok(text('#cat-table').indexOf('铝型材') !== -1, '应只剩龙门架上的铝型材');
      E2E.clickSelector('[data-act="reset-filter"]');
      await E2E.waitUntil('条件已清空', function () { return rowsOf('#cat-table').length === 3; });
    });

    /* ---------------- 电控 ---------------- */

    await E2E.record('电控页：安全等级警示只点出高压危险件', async function () {
      await gotoCategory('electronic', '安全等级警示');
      var bar = text('#mod-elec-safety');
      E2E.ok(bar.indexOf('24V锂电组') !== -1, '应点名高压危险的那件');
      E2E.ok(bar.indexOf('断电放电') !== -1, '应给出安全操作要求');
      E2E.ok(bar.indexOf('散热风扇') === -1, '「注意」级别的件不该进高压危险警示');
      E2E.ok(document.querySelector('#mod-elec-safety .alert-item.danger'), '应使用危险样式');
      E2E.ok(text('#mod-elec-safety-note').indexOf('1 种') !== -1, '应汇总危险件数');
    });

    await E2E.record('电控页：易损件超过更换周期会被标出来', async function () {
      await gotoCategory('electronic', '易损件更换周期');
      var rows = rowsOf('#mod-elec-spares');
      E2E.ok(rows.length === 2, '两种都填了更换日期，应列出 2 行，实际 ' + rows.length);
      E2E.ok(rows[0].textContent.indexOf('已超周期') !== -1,
        '超期的应排最前并标已超周期，实际第一行：' + rows[0].textContent.replace(/\s+/g, ' '));
      E2E.ok(rows[0].className.indexOf('row-low-stock') !== -1, '超期行应有醒目样式');
      var fan = rows.filter(function (r) { return r.textContent.indexOf('散热风扇') !== -1; })[0];
      E2E.ok(fan && fan.textContent.indexOf('周期内') !== -1, '刚换过 30 天的风扇应显示周期内');
    });

    await E2E.record('电控页：电池健康显示循环次数与衰减提示', async function () {
      await gotoCategory('electronic', '电池健康');
      var rows = rowsOf('#mod-elec-battery');
      E2E.ok(rows.length === 1, '只有锂电组填了电池信息，实际 ' + rows.length);
      var t = rows[0].textContent.replace(/\s+/g, ' ');
      E2E.ok(t.indexOf('400') !== -1, '应显示循环次数 400，实际：' + t);
      E2E.ok(t.indexOf('衰减明显') !== -1, '应显示健康状况');
      E2E.ok(t.indexOf('建议更换') !== -1, '衰减明显应给出更换建议');
      E2E.ok(text('#mod-elec-battery-note').indexOf('建议尽早更换') !== -1, '区块说明应说明要关注');
    });

    /* ---------------- 视觉 ---------------- */

    await E2E.record('视觉页：标定看板标出需重新标定并排最前', async function () {
      await gotoCategory('vision', '标定看板');
      var rows = rowsOf('#mod-vis-cal');
      E2E.ok(rows.length === 2, '应有 2 台设备，实际 ' + rows.length);
      var first = rows[0].textContent.replace(/\s+/g, ' ');
      E2E.ok(first.indexOf('工业相机') !== -1, '超期 120 天的相机应排最前，实际：' + first);
      E2E.ok(first.indexOf('需重新标定') !== -1, '超期应显示需重新标定');
      var lens = rows.filter(function (r) { return r.textContent.indexOf('定焦镜头') !== -1; })[0];
      E2E.ok(lens && lens.textContent.indexOf('已标定') !== -1, '刚标过 10 天的镜头应显示已标定');
      E2E.ok(text('#mod-vis-cal-note').indexOf('1 件需重新标定') !== -1, '应汇总需重标件数');
    });

    await E2E.record('视觉页：镜头与相机配套关系能对上', async function () {
      await gotoCategory('vision', '镜头与相机配套');
      var rows = rowsOf('#mod-vis-pair');
      E2E.ok(rows.length === 1, '只有镜头填了配套相机，应有 1 组，实际 ' + rows.length);
      var t = rows[0].textContent.replace(/\s+/g, ' ');
      E2E.ok(t.indexOf('VS-0002') !== -1, '本件应是 VS-0002 镜头，实际：' + t);
      E2E.ok(t.indexOf('VS-0001') !== -1, '应解析出配套的 VS-0001');
      E2E.ok(t.indexOf('工业相机') !== -1, '应带出配套设备的名称');
      E2E.ok(t.indexOf('库里没有这件') === -1, '库里确实有 VS-0001，不该报找不到');
    });

    await E2E.record('视觉页：贵重设备去向显示当前在借的那台', async function () {
      await gotoCategory('vision', '贵重设备去向');
      var rows = rowsOf('#mod-vis-precious');
      E2E.ok(rows.length === 2, '两件都是单独建身份的贵重设备，实际 ' + rows.length);
      var cam = rows.filter(function (r) { return r.textContent.indexOf('工业相机') !== -1; })[0];
      E2E.ok(cam && cam.textContent.indexOf('在外借出') !== -1, '被借出的相机应标在外借出');
      E2E.ok(cam.className.indexOf('row-low-stock') !== -1, '在借的应有醒目样式');
      E2E.ok(text('#mod-vis-precious-note').indexOf('1 件贵重设备当前在外借出') !== -1, '应汇总在借件数');
    });

    /* ---------------- 硬件 ---------------- */

    await E2E.record('硬件页：工具校准检定标出到期与从未校准', async function () {
      await gotoCategory('hardware', '工具校准检定');
      var rows = rowsOf('#mod-hw-cal');
      E2E.ok(rows.length === 2, '应有 2 把工具，实际 ' + rows.length);
      var t = rows[0].textContent.replace(/\s+/g, ' ');
      E2E.ok(t.indexOf('已到期') !== -1, '到期的应排最前并标已到期，实际：' + t);
      E2E.ok(rows[0].className.indexOf('row-low-stock') !== -1, '到期行应有醒目样式');
      var never = rows.filter(function (r) { return r.textContent.indexOf('扭力扳手') !== -1; })[0];
      E2E.ok(never && never.textContent.indexOf('从未校准') !== -1, '没填校准日期的应显示从未校准');
      E2E.ok(text('#mod-hw-cal-note').indexOf('2 把已到期') !== -1, '应汇总到期把数');
    });

    await E2E.record('硬件页：耗材余量对照安全库存', async function () {
      await gotoCategory('hardware', '耗材余量');
      var rows = rowsOf('#mod-hw-level');
      E2E.ok(rows.length === 1, '只有扎带不是工具，实际 ' + rows.length);
      var t = rows[0].textContent.replace(/\s+/g, ' ');
      E2E.ok(t.indexOf('扎带') !== -1, '应列出扎带，实际：' + t);
      E2E.ok(t.indexOf('需补货') !== -1, '余量 20 低于安全库存 100，应标需补货');
      E2E.ok(rows[0].className.indexOf('row-low-stock') !== -1, '需补货行应有醒目样式');
    });

    await E2E.record('硬件页：低库存报警条列出需要补的东西', async function () {
      await gotoCategory('hardware', '低库存报警');
      var bar = text('#mod-hw-alert');
      E2E.ok(bar.indexOf('扎带') !== -1, '应点名需要补的扎带');
      E2E.ok(bar.indexOf('100') !== -1, '应写出安全库存数字');
      E2E.ok(bar.indexOf('需要补货') !== -1, '应说明需要补货');
      E2E.ok(document.querySelector('#mod-hw-alert [data-goto-item]'), '报警条里的编码应能跳到详情');
    });

    /* ---------------- 通用：专属字段与跳转 ---------------- */

    await E2E.record('新增物品弹窗只出现本类专属字段', async function () {
      await gotoCategory('vision', '标定看板');
      E2E.clickSelector('[data-act="new-item"]');
      var mask = await E2E.waitUntil('弹窗打开', function () { return document.querySelector('.modal-mask'); })
        .then(function () { return document.querySelector('.modal-mask'); });
      await E2E.waitUntil('视觉专属字段出现', function () { return mask.querySelector('[name="x-resolution"]'); });
      E2E.ok(mask.querySelector('[name="x-lensMount"]'), '视觉应有镜头接口');
      E2E.ok(mask.querySelector('[name="x-calibrationStatus"]'), '视觉应有标定状态');
      E2E.ok(!mask.querySelector('[name="x-voltage"]'), '视觉不该出现电控的工作电压');
      E2E.ok(!mask.querySelector('[name="x-isTool"]'), '视觉不该出现硬件的是否工具');

      // 换成机械：字段应整体换掉
      E2E.setInput(mask.querySelector('[name="categoryId"]'), 'mechanical');
      await E2E.waitUntil('机械专属字段出现', function () { return mask.querySelector('[name="x-vehicle"]'); });
      E2E.ok(mask.querySelector('[name="x-assemblePos"]'), '机械应有装配位置');
      E2E.ok(!mask.querySelector('[name="x-resolution"]'), '机械不该再出现视觉的分辨率');
      E2E.clickSelector('.modal-close', mask);
      await E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
    });

    await E2E.record('详情页显示本类专属属性区块', async function () {
      App.goto('item', { code: 'MC-0001' });
      await E2E.waitUntil('机械详情就绪', function () {
        return text('.page-title').indexOf('M4螺丝') !== -1 && body().indexOf('机械属性') !== -1;
      });
      E2E.ok(body().indexOf('底盘左侧') !== -1, '机械详情应显示装配位置');
      E2E.ok(body().indexOf('不锈钢') !== -1, '机械详情应显示材质');
      E2E.ok(body().indexOf('标准件库存') !== -1, '机械详情应显示标准件库存说明');

      App.goto('item', { code: 'VS-0001' });
      await E2E.waitUntil('视觉详情就绪', function () {
        return text('.page-title').indexOf('工业相机') !== -1 && body().indexOf('视觉属性') !== -1;
      });
      E2E.ok(body().indexOf('标定') !== -1, '视觉详情应显示标定信息');
      E2E.ok(body().indexOf('贵重设备') !== -1, '视觉详情应说明是贵重设备');
      E2E.ok(body().indexOf('当前在借') !== -1, '在借时应提示当前在借');
    });

    await E2E.record('工作区里点编码能跳到该物品详情', async function () {
      await gotoCategory('hardware', '低库存报警');
      var link = document.querySelector('#mod-hw-alert [data-goto-item]');
      var code = link.getAttribute('data-goto-item');
      E2E.click(link);
      await E2E.waitUntil('跳到物品详情', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item' &&
          body().indexOf('出入库履历') !== -1;
      });
      E2E.ok(body().indexOf(code) !== -1, '详情页应显示该编码 ' + code);
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
