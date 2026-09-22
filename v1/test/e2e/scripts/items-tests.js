/**
 * M3 的浏览器端到端测试：物品身份、二维码、标签打印、详情页、编辑。
 * 全程通过真实界面操作（点按钮、弹窗里填表），不是调内部函数。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var DB = global.FEVER.DB;
  var App = global.FEVER.App;

  function text(sel) {
    var node = document.querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /** 等弹窗出现并返回它 */
  function modal() {
    return E2E.waitUntil('弹窗打开', function () {
      return document.querySelector('.modal-mask');
    }).then(function () { return document.querySelector('.modal-mask'); });
  }

  function waitModalGone() {
    return E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
  }

  function fillIn(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"]');
    E2E.ok(node, '弹窗里应有字段 ' + name);
    E2E.setInput(node, value);
  }

  function pickRadio(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"][value="' + value + '"]');
    E2E.ok(node, '应有选项 ' + name + '=' + value);
    node.checked = true;
  }

  /** 打开"新增物品"弹窗并等字段就绪 */
  function openNewItem() {
    return E2E.waitUntil('有新增入口', function () { return document.querySelector('[data-act="new-inbound"]'); })
      .then(function () {
        E2E.clickSelector('[data-act="new-inbound"]');
        return modal();
      })
      .then(function (mask) {
        return E2E.waitUntil('新增弹窗字段就绪', function () { return mask.querySelector('[name="categoryId"]'); })
          .then(function () { return mask; });
      });
  }

  async function run() {
    await E2E.resetDb();
    await global.FEVER.Rules.initCategories();
    await App.refresh();
    await E2E.waitUntil('首页就绪', function () { return document.querySelectorAll('.cat-card').length === 4; });

    await E2E.record('新增物品弹窗按大类给出专属字段', async function () {
      var mask = await openNewItem();
      // 默认机械：应有机械专属字段，不该有视觉字段
      await E2E.waitUntil('机械专属字段出现', function () { return mask.querySelector('[name="x-vehicle"]'); });
      E2E.ok(mask.querySelector('[name="x-material"]'), '机械应有材质字段');
      E2E.ok(mask.querySelector('[name="troop"]'), '直接入库也应有必填的兵种下拉（第十三轮）');
      E2E.ok(!mask.querySelector('[name="x-resolution"]'), '机械不该出现视觉的分辨率字段');

      // 切到视觉：字段应整体换掉
      fillIn(mask, 'categoryId', 'vision');
      await E2E.waitUntil('视觉专属字段出现', function () { return mask.querySelector('[name="x-resolution"]'); });
      E2E.ok(mask.querySelector('[name="x-lensMount"]'), '视觉应有镜头接口字段');
      E2E.ok(!mask.querySelector('[name="x-vehicle"]'), '视觉不该再出现机械的车型字段');

      var mode = mask.querySelector('[name="identityMode"]:checked');
      E2E.ok(mode && mode.value === 'single', '视觉类应默认「每件单独建身份」，实际 ' + (mode && mode.value));
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

    await E2E.record('不选兵种保存会被拦下（第十三轮：直接入库也必须选兵种）', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'mechanical');
      fillIn(mask, 'name', '没选兵种的件');
      fillIn(mask, 'quantity', '1');
      pickRadio(mask, 'identityMode', 'shared');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.waitUntil('出现选兵种的提示', function () {
        return document.getElementById('toast-root') &&
          text('#toast-root').indexOf('兵种') !== -1;
      }, 5000);
      E2E.ok(E2E.topModal() !== null, '弹窗不该关掉 —— 数据没保存，让使用者补上再交');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 0, '没选兵种就不该有物品落库，实际 ' + items.length);
      await E2E.closeAllModals();
    });

    await E2E.record('入库 1 件单独建身份：生成 1 个编码', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'vision');
      await E2E.waitUntil('视觉字段切换完成', function () { return mask.querySelector('[name="x-resolution"]'); });
      fillIn(mask, 'troop', '其他');
      fillIn(mask, 'name', '工业相机');
      fillIn(mask, 'spec', '500万像素');
      fillIn(mask, 'location', '器材柜A');
      fillIn(mask, 'quantity', '1');
      fillIn(mask, 'x-resolution', '500万');
      fillIn(mask, 'x-lensMount', 'CS');
      pickRadio(mask, 'identityMode', 'single');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1, '应生成 1 条物品，实际 ' + items.length);
      E2E.ok(items[0].code === 'VS-0001', '编码应为 VS-0001，实际 ' + items[0].code);
      E2E.ok(items[0].identityMode === 'single', '应是单独建身份');
      E2E.ok(items[0].totalQty === 1, '单独建身份数量应为 1');
      E2E.ok(items[0].extra.resolution === '500万', '专属字段应保存下来');
    });

    await E2E.record('入库 5 件同款共用：只生成 1 个编码、件数为 5', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'mechanical');
      await E2E.waitUntil('切回机械字段', function () { return mask.querySelector('[name="x-vehicle"]'); });
      fillIn(mask, 'troop', '步兵');
      fillIn(mask, 'name', 'M4螺丝');
      fillIn(mask, 'quantity', '5');
      fillIn(mask, 'safetyStock', '20');
      fillIn(mask, 'x-vehicle', '2026主车');
      pickRadio(mask, 'identityMode', 'shared');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      var screws = items.filter(function (i) { return i.name === 'M4螺丝'; });
      E2E.ok(screws.length === 1, '同款共用只应有 1 条身份，实际 ' + screws.length);
      E2E.ok(screws[0].code === 'MC-0001', '机械编码应为 MC-0001，实际 ' + screws[0].code);
      E2E.ok(screws[0].totalQty === 5 && screws[0].inStockQty === 5, '件数应为 5');
      E2E.ok(screws[0].extra.vehicle === '2026主车', '专属字段应保存');
    });

    await E2E.record('批量入库：单独建身份 3 件生成 3 个连续编码', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'vision');
      await E2E.waitUntil('视觉字段就绪', function () { return mask.querySelector('[name="x-resolution"]'); });
      fillIn(mask, 'troop', '哨兵');
      fillIn(mask, 'name', '镜头');
      fillIn(mask, 'quantity', '3');
      pickRadio(mask, 'identityMode', 'single');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      var lenses = items.filter(function (i) { return i.name === '镜头'; }).map(function (i) { return i.code; }).sort();
      E2E.ok(lenses.join(',') === 'VS-0002,VS-0003,VS-0004', '应生成 VS-0002 到 VS-0004，实际 ' + lenses.join(','));
    });

    await E2E.record('大类页只列出本类物品', async function () {
      App.goto('category', { id: 'vision' });
      // 等"物品清单"表格真正渲染出来，而不是只等页面上出现某个词
      await E2E.waitUntil('视觉页表格出现', function () { return document.querySelector('#cat-table table'); });
      var body = text('#cat-table');
      E2E.ok(body.indexOf('工业相机') !== -1, '视觉页应有工业相机');
      E2E.ok(body.indexOf('镜头') !== -1, '视觉页应有镜头');
      E2E.ok(body.indexOf('M4螺丝') === -1, '视觉页的清单里不该出现机械的螺丝');
    });

    await E2E.record('物品详情页显示二维码，内容为 FEVER:ITEM:编码', async function () {
      App.goto('item', { code: 'VS-0001' });
      await E2E.waitUntil('详情页出现', function () { return text('#view-root').indexOf('工业相机') !== -1; });
      await E2E.waitUntil('二维码渲染出来', function () {
        var img = document.querySelector('#qr-holder img');
        return img && img.getAttribute('src').indexOf('data:image') === 0;
      });
      var payload = document.querySelector('#qr-holder').getAttribute('data-qr');
      E2E.ok(payload === 'FEVER:ITEM:VS-0001', '二维码内容应为 FEVER:ITEM:VS-0001，实际 ' + payload);
      var body = text('#view-root');
      E2E.ok(body.indexOf('单独建身份') !== -1, '详情页应显示身份方式');
      E2E.ok(body.indexOf('500万') !== -1, '详情页应显示视觉专属字段');
      E2E.ok(body.indexOf('CS') !== -1, '详情页应显示镜头接口');
      E2E.ok(body.indexOf('出入库履历') !== -1, '详情页应有履历区块');
      E2E.ok(body.indexOf('入库') !== -1, '履历里应有入库记录');
    });

    await E2E.record('编辑物品：编码不可改，其他字段可改', async function () {
      await E2E.waitUntil('详情页有编辑按钮', function () { return document.querySelector('[data-act="edit-item"]'); });
      E2E.clickSelector('[data-act="edit-item"]');
      var mask = await modal();
      await E2E.waitUntil('编辑弹窗就绪', function () { return mask.querySelector('[name="name"]'); });
      E2E.ok(!mask.querySelector('[name="code"]'), '弹窗里不应有编码输入框（编码不可改）');
      E2E.ok(text('.modal-body').indexOf('VS-0001') !== -1, '应提示当前编码');
      fillIn(mask, 'name', '工业相机(改)');
      fillIn(mask, 'location', '器材柜B');
      fillIn(mask, 'x-resolution', '1200万');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'VS-0001');
      E2E.ok(item.name === '工业相机(改)', '名称应已更新');
      E2E.ok(item.location === '器材柜B', '位置应已更新');
      E2E.ok(item.extra.resolution === '1200万', '专属字段应已更新');
      E2E.ok(item.code === 'VS-0001', '编码不应改变');
    });

    await E2E.record('标签打印页：单张标签含二维码与文字信息', async function () {
      App.goto('labels', { code: 'VS-0001' });
      await E2E.waitUntil('标签页出现', function () { return document.querySelectorAll('.label-card').length >= 1; });
      var cards = document.querySelectorAll('.label-card');
      E2E.ok(cards.length === 1, '指定编码时只应打印 1 张，实际 ' + cards.length);
      var card = cards[0];
      var stored = await DB.get('items', 'VS-0001');
      E2E.ok(card.textContent.indexOf('VS-0001') !== -1, '标签上应有编码');
      E2E.ok(card.textContent.indexOf('工业相机') !== -1, '标签上应有名称');
      E2E.ok(card.textContent.indexOf('视觉') !== -1, '标签上应有大类');
      E2E.ok(card.textContent.indexOf(stored.location) !== -1,
        '标签上应显示存放位置「' + stored.location + '」，实际标签内容：' + card.textContent.replace(/\s+/g, ' '));
      await E2E.waitUntil('标签上的二维码渲染完成', function () {
        var img = card.querySelector('.label-qr img');
        return img && img.getAttribute('src').indexOf('data:image') === 0;
      });
    });

    await E2E.record('标签打印页：不指定编码时铺开全部物品', async function () {
      App.goto('labels', {});
      await E2E.waitUntil('全部标签出现', function () { return document.querySelectorAll('.label-card').length === 5; });
      var cards = document.querySelectorAll('.label-card');
      E2E.ok(cards.length === 5, '4 个视觉身份 + 1 个机械身份 = 5 张，实际 ' + cards.length);
      var codes = Array.prototype.slice.call(cards).map(function (c) {
        return c.querySelector('.label-code').textContent.trim();
      }).sort();
      E2E.ok(codes.join(',') === 'MC-0001,VS-0001,VS-0002,VS-0003,VS-0004', '标签编码应齐全，实际 ' + codes.join(','));
    });

    await E2E.record('标签页有打印按钮和打印提示', async function () {
      E2E.ok(document.querySelector('[data-act="do-print"]'), '应有打印按钮');
      E2E.ok(text('.page-head').indexOf('Ctrl+P') !== -1, '应提示用 Ctrl+P 打印');
    });

    await E2E.record('大类页搜索与筛选可用', async function () {
      App.goto('category', { id: 'vision' });
      await E2E.waitUntil('视觉页出现', function () { return document.querySelector('[name="f-keyword"]'); });
      E2E.setInput(document.querySelector('[name="f-keyword"]'), '镜头');
      await E2E.waitUntil('筛选后只剩镜头', function () {
        var body = text('#cat-table');
        return body.indexOf('镜头') !== -1 && body.indexOf('工业相机') === -1;
      });
      E2E.setInput(document.querySelector('[name="f-keyword"]'), '');
      await E2E.waitUntil('恢复全部', function () { return text('#cat-table').indexOf('工业相机') !== -1; });
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
