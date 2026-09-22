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
  var DB = global.FEVER.DB;

  function text(sel) {
    var node = document.querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function body() { return text('#view-root'); }

  /**
   * 切到某个大类页，等到该类的专属工作区渲染出来。
   *
   * 必须走 E2E.goto（它等的是"框架换过 #view-root 节点"）。
   * 只等 data-page / 页面文字是不行的：**已经停在这一页时**，这两个条件
   * 在重画之前就已经成立了，测试会骑在旧页面上点按钮 —— 表现为
   * "点不到自己刚建的那几条数据"，而单独复刻同一场景却又是对的。
   * 实测踩过一次：批量打印/批量删除三条用例全红，真因在这个等待条件。
   */
  async function gotoCategory(id, marker) {
    await E2E.goto('category', { id: id });
    await E2E.waitUntil('大类页 ' + id + ' 的专属工作区就绪', function () {
      return body().indexOf(marker) !== -1;
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

    /* ================= 批量：勾选 → 批量打印 / 批量删除 ================= */

    /** 清单里所有勾选框上的编码，按显示顺序 */
    function rowCodes() {
      return Array.prototype.slice.call(document.querySelectorAll('#cat-table .row-pick'))
        .map(function (n) { return n.getAttribute('data-pick'); });
    }
    function boxOf(code) {
      return document.querySelector('#cat-table .row-pick[data-pick="' + code + '"]');
    }
    /** 勾上某几件（真点一下，靠浏览器的 change 事件触发页面逻辑） */
    async function pickCodes(codes) {
      for (var i = 0; i < codes.length; i += 1) {
        var box = boxOf(codes[i]);
        if (!box) throw new Error('找不到 ' + codes[i] + ' 的勾选框');
        E2E.click(box);
      }
      await E2E.waitUntil('已选 ' + codes.length + ' 件', function () {
        return document.querySelector('#cat-selected').textContent.indexOf('已选 ' + codes.length + ' 件') !== -1;
      });
    }
    function selectedText() {
      var node = document.querySelector('#cat-selected');
      return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    await E2E.record('物品清单每条都能勾，没勾选时批量按钮是禁用的', async function () {
      await gotoCategory('mechanical', '标准件库存');
      E2E.ok(rowCodes().length === 3, '机械有 3 件物品就该有 3 个勾选框，实际 ' + rowCodes().length);
      E2E.ok(selectedText().indexOf('已选 0 件') !== -1, '一上来应当是「已选 0 件」，实际 ' + selectedText());
      ['#cat-batch-print', '#cat-batch-del', '#cat-batch-clear'].forEach(function (sel) {
        var btn = document.querySelector(sel);
        E2E.ok(btn && btn.disabled === true, sel + ' 在没勾选时必须是禁用的（免得有人先点按钮再找东西勾）');
      });
    });

    await E2E.record('勾选后按钮亮起、已选数字跟着变，清空选择能一键取消', async function () {
      await gotoCategory('mechanical', '标准件库存');
      var codes = rowCodes();
      await pickCodes([codes[0], codes[1]]);
      E2E.ok(document.querySelector('#cat-batch-print').disabled === false, '勾了之后批量打印应当能点');
      E2E.ok(document.querySelector('#cat-batch-del').disabled === false, '勾了之后批量删除应当能点');
      E2E.ok(boxOf(codes[0]).checked === true, '勾选框本身要显示成勾上的');

      E2E.click(document.querySelector('#cat-batch-clear'));
      await E2E.waitUntil('清空后回到 0 件', function () {
        return selectedText().indexOf('已选 0 件') !== -1;
      });
      E2E.ok(boxOf(codes[0]).checked === false, '清空选择后行上的勾也要跟着取消');
      E2E.ok(document.querySelector('#cat-batch-print').disabled === true, '清空后按钮应重新变灰');
    });

    await E2E.record('全选只选「当前筛选结果」，换筛选条件不丢已勾的', async function () {
      await gotoCategory('mechanical', '标准件库存');
      E2E.setInput(document.querySelector('[name="f-keyword"]'), 'M4');
      await E2E.waitUntil('筛选后只剩一件', function () { return rowCodes().length === 1; });

      E2E.click(document.querySelector('#cat-check-all'));
      await E2E.waitUntil('已选 1 件', function () { return selectedText().indexOf('已选 1 件') !== -1; });
      E2E.ok(rowCodes().length === 1, '筛选结果就是 1 件');

      E2E.setInput(document.querySelector('[name="f-keyword"]'), '');
      await E2E.waitUntil('筛选恢复成 3 件', function () { return rowCodes().length === 3; });
      E2E.ok(selectedText().indexOf('已选 1 件') !== -1,
        '换个筛选条件不该把已经勾好的默默清掉，实际 ' + selectedText());
    });

    await E2E.record('批量打印：按勾选顺序出标签，并把选中集合记进地址栏', async function () {
      await gotoCategory('mechanical', '标准件库存');
      var codes = rowCodes();
      // 故意倒着勾：先勾第二件，再勾第一件 —— 标签就该按这个顺序排
      await pickCodes([codes[1], codes[0]]);

      E2E.click(document.querySelector('#cat-batch-print'));
      await E2E.waitUntil('标签页只剩勾的那两张', function () {
        return document.querySelectorAll('.label-card').length === 2;
      });
      var printed = Array.prototype.slice.call(document.querySelectorAll('.label-card .label-code'))
        .map(function (n) { return n.textContent.trim(); });
      E2E.ok(printed.join(',') === codes[1] + ',' + codes[0],
        '标签要按勾选顺序出（撕下来挨着贴才对得上），期望 ' + codes[1] + ',' + codes[0] + '，实际 ' + printed.join(','));
      E2E.ok(location.hash.indexOf('#labels/batch/') === 0,
        '选中集合要记进地址栏，否则一刷新就退回「打印全部」，实际 ' + location.hash);
      E2E.ok(text('.page-sub').indexOf('2 张') !== -1, '页头要写清共几张，实际 ' + text('.page-sub'));
    });

    await E2E.record('批量打印的链接可以直接打开（刷新 / 转发同事都回到同一批）', async function () {
      // 直接改地址栏，等于模拟"刷新"或"别人打开这个链接"
      location.hash = '#labels/batch/MC-0003,MC-0002';
      await E2E.waitUntil('按链接打开后标签按链接里的顺序出', function () {
        var printed = Array.prototype.slice.call(document.querySelectorAll('.label-card .label-code'))
          .map(function (n) { return n.textContent.trim(); });
        return printed.join(',') === 'MC-0003,MC-0002';
      });

      // 老的单张形式不能被新写法弄坏
      location.hash = '#labels/VS-0001';
      await E2E.waitUntil('单个编码的老链接照旧只出一张', function () {
        var cards = document.querySelectorAll('.label-card');
        return cards.length === 1 && cards[0].textContent.indexOf('VS-0001') !== -1;
      });
    });

    await E2E.record('大类页的「批量打印标签」只出本大类的标签', async function () {
      // 这个按钮以前把 data-cat 丢了：不管点哪个大类，打出来的都是**全部物品**的标签。
      // 一整叠标签纸打错是很难发现的浪费，所以专门盯一条。
      await gotoCategory('mechanical', '标准件库存');
      E2E.click(document.querySelector('[data-act="print-labels"]'));
      await E2E.waitUntil('标签页只出机械的标签', function () {
        var cards = document.querySelectorAll('.label-card');
        if (!cards.length) return false;
        return Array.prototype.slice.call(cards).every(function (c) {
          return c.querySelector('.label-code').textContent.trim().indexOf('MC-') === 0;
        });
      });
      E2E.ok(text('.page-sub').indexOf('机械') !== -1,
        '页头要写清这是「机械」下的标签，实际 ' + text('.page-sub'));
      E2E.ok(document.querySelectorAll('.label-card').length === 3,
        '机械有 3 件就该出 3 张，实际 ' + document.querySelectorAll('.label-card').length);
    });

    await E2E.record('批量删除：确认框写清删哪几件，点取消一件都不删', async function () {
      await gotoCategory('mechanical', '标准件库存');
      var target = rowCodes().slice(-1)[0];
      await pickCodes([target]);

      E2E.click(document.querySelector('#cat-batch-del'));
      var modal = await E2E.waitUntil('确认框出现', function () { return E2E.topModal(); });
      E2E.ok(modal.textContent.indexOf(target) !== -1,
        '确认框第一行要写清删的是哪一条，实际：' + modal.textContent.replace(/\s+/g, ' ').slice(0, 160));
      E2E.ok(modal.textContent.indexOf('删除记录') !== -1, '要说明会记入删除记录');

      E2E.click(modal.querySelector('[data-act="no"]'));
      await E2E.wait(150);
      E2E.closeAllModals();
      E2E.ok(!!(await DB.get('items', target)), '点了取消就不该删掉任何东西');
      E2E.ok((await Rules.getDeleteLog()).length === 0, '取消不该留下删除记录');
    });

    await E2E.record('批量删除：借出中的被跳过并写明原因，其他照删', async function () {
      var lentCode = (await Ops.inbound({
        categoryId: 'mechanical', name: '借出去的件', quantity: 1, identityMode: 'single', operator: '测试'
      })).codes[0];
      var freeCode = (await Ops.inbound({
        categoryId: 'mechanical', name: '在库的件', quantity: 1, identityMode: 'single', operator: '测试'
      })).codes[0];
      await Ops.lend({ code: lentCode, qty: 1, operator: '测试', borrower: '王五', dueDate: '2030-01-01' });

      await gotoCategory('mechanical', '标准件库存');
      await pickCodes([lentCode, freeCode]);

      E2E.click(document.querySelector('#cat-batch-del'));
      var modal = await E2E.waitUntil('确认框出现', function () { return E2E.topModal(); });
      E2E.ok(modal.textContent.indexOf('跳过') !== -1,
        '要提前说清哪几件会被跳过，而不是让人以为全都删了：' + modal.textContent.replace(/\s+/g, ' ').slice(0, 200));
      E2E.ok(modal.textContent.indexOf('借在外面') !== -1, '跳过原因要说人话（借在外面）');

      E2E.click(modal.querySelector('[data-act="yes"]'));
      await E2E.waitUntilAsync('在库的那件被删掉', function () {
        return DB.get('items', freeCode).then(function (r) { return !r; });
      });
      E2E.ok(!!(await DB.get('items', lentCode)), '借出去的那件必须还在，否则实物就没人认领了');
    });

    await E2E.record('批量删除：确认后清单里消失，且每一件都单独记了一笔账', async function () {
      await gotoCategory('mechanical', '标准件库存');
      var codes = rowCodes();
      E2E.ok(codes.length >= 2, '这一轮至少要剩两件可删的，实际 ' + codes.length);
      var two = codes.slice(0, 2);
      var before = (await Rules.getDeleteLog()).length;

      await pickCodes(two);
      E2E.click(document.querySelector('#cat-batch-del'));
      var modal = await E2E.waitUntil('确认框出现', function () { return E2E.topModal(); });
      E2E.click(modal.querySelector('[data-act="yes"]'));

      await E2E.waitUntilAsync('两件都被删掉', function () {
        return Promise.all(two.map(function (c) { return DB.get('items', c); }))
          .then(function (rows) { return rows.every(function (r) { return !r; }); });
      });

      var log = await Rules.getDeleteLog();
      E2E.ok(log.length === before + two.length,
        '删两件就要多两笔账（逐条留痕），实际多了 ' + (log.length - before));
      two.forEach(function (c) {
        var hit = log.filter(function (r) { return r.store === 'items' && r.key === c; });
        E2E.ok(hit.length === 1, c + ' 应当有且只有一笔删除记录');
        E2E.ok(!!hit[0].snapshot, c + ' 的删除记录要带快照，否则以后没法还原');
      });

      // 界面上也不该再出现它们
      await gotoCategory('mechanical', '标准件库存');
      two.forEach(function (c) {
        E2E.ok(body().indexOf(c) === -1, '清单里不该再出现 ' + c);
      });
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
