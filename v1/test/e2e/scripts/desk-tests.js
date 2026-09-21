/**
 * M5 的浏览器端到端测试：出入库操作台、借出/归还/领用/送修/修好回库、
 * 流水筛选与借用台账（含超期高亮）。
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
  function body() { return text('#view-root'); }
  /** 只取表格数据行：表头里也有「预计归还」「借出」等字样，整块文本判断会被干扰 */
  function dataRows(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel || '#txn-table tbody tr'));
  }

  function gotoTab(name) {
    App.goto(name);
    return E2E.waitUntil('页面 ' + name + ' 渲染完成', function () {
      return document.querySelector('#view-root').getAttribute('data-page') === name;
    });
  }

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

  /**
   * 在操作台输入编码并识别。
   * 注意：传进来可能是带二维码前缀的内容，页面上显示的是解析后的纯编码，
   * 所以要等解析后的编码出现，不能拿原始输入去比对。
   */
  async function lookup(raw) {
    var code = global.FEVER.Rules.parseQrPayload(raw) || raw;
    await E2E.waitUntil('操作台输入框就绪', function () { return document.querySelector('#desk-code'); });
    E2E.setInput(document.querySelector('#desk-code'), raw);
    E2E.clickSelector('#desk-lookup');
    await E2E.waitUntil('识别完成 ' + code, function () {
      var box = document.querySelector('#desk-result');
      return box && box.textContent.indexOf(code) !== -1;
    });
  }

  /** 点操作台上的某个动作按钮 */
  function clickDeskAction(label) {
    var btns = Array.prototype.slice.call(document.querySelectorAll('[data-desk-act]'));
    var btn = btns.filter(function (b) { return b.textContent.trim() === label; })[0];
    E2E.ok(btn, '操作台上应有「' + label + '」按钮');
    E2E.click(btn);
  }

  async function run() {
    await E2E.resetDb();
    await global.FEVER.Rules.initCategories();

    // 造一批物品：一把工具（可借）、一箱耗材（可领用）、一台贵重设备（超期借用）
    await global.FEVER.Ops.inbound({
      categoryId: 'hardware', name: '电动螺丝刀', quantity: 2, identityMode: 'shared',
      operator: '测试', extra: { isTool: '是' }, location: '工具墙'
    });
    await global.FEVER.Ops.inbound({
      categoryId: 'mechanical', name: 'M4螺丝', quantity: 100, identityMode: 'shared',
      operator: '测试', safetyStock: 30
    });
    await global.FEVER.Ops.inbound({
      categoryId: 'vision', name: '工业相机', quantity: 1, identityMode: 'single', operator: '测试'
    });

    await gotoTab('desk');

    await E2E.record('输入编号能识别物品并显示当前状态', async function () {
      await lookup('HW-0001');
      var box = text('#desk-result');
      E2E.ok(box.indexOf('电动螺丝刀') !== -1, '应显示物品名称');
      E2E.ok(box.indexOf('在库') !== -1, '应显示当前状态');
      E2E.ok(box.indexOf('在库 2') !== -1, '应显示在库件数');
    });

    await E2E.record('输入不存在的编号给出明确提示且不留记录', async function () {
      var before = (await DB.getAll('transactions')).length;
      await lookup('MC-9999');
      E2E.ok(text('#desk-result').indexOf('未找到该物品') !== -1, '应提示未找到该物品');
      var after = await DB.getAll('transactions');
      E2E.ok(after.length === before, '不应产生任何流水');
    });

    await E2E.record('扫码内容能直接粘贴识别（FEVER:ITEM: 前缀也会被识别）', async function () {
      await lookup('FEVER:ITEM:HW-0001');
      E2E.ok(text('#desk-result').indexOf('电动螺丝刀') !== -1, '带二维码前缀的内容也应识别出物品');
      E2E.ok(text('#desk-result').indexOf('未找到') === -1, '带前缀的内容不应被当成找不到');
      E2E.ok(document.querySelector('#desk-code').value === 'HW-0001', '识别后输入框应回填纯编码');
    });

    await E2E.record('借出：填借用人、用途、归还日期后状态变借出', async function () {
      await lookup('HW-0001');
      clickDeskAction('借出');
      var mask = await modal();
      await E2E.waitUntil('借出表单就绪', function () { return mask.querySelector('[name="borrower"]'); });
      fillIn(mask, 'qty', '1');
      fillIn(mask, 'borrower', '张三');
      fillIn(mask, 'dueDate', '2026-09-30');
      fillIn(mask, 'purpose', '装车用');
      fillIn(mask, 'operator', '李四');
      // 提交前应显示本次变化
      E2E.ok(text('#act-preview').indexOf('在库 2') !== -1, '应显示提交前的数量变化，实际：' + text('#act-preview'));
      E2E.ok(text('#act-preview').indexOf('1') !== -1, '应显示变化后的数量');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'HW-0001');
      E2E.ok(item.inStockQty === 1 && item.lentQty === 1, '在库 1、借出 1，实际在库 ' + item.inStockQty + ' 借出 ' + item.lentQty);
      var txns = await DB.getAll('transactions');
      var lend = txns.filter(function (t) { return t.type === 'lend'; })[0];
      E2E.ok(lend && lend.borrower === '张三' && lend.dueDate === '2026-09-30', '流水应记录借用人与归还日期');
      await E2E.waitUntil('操作台刷新为借出状态', function () { return text('#desk-result').indexOf('借出 1') !== -1; });
    });

    await E2E.record('借出缺少借用人或归还日期会被拒绝', async function () {
      await lookup('HW-0001');
      clickDeskAction('借出');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="borrower"]'); });
      fillIn(mask, 'qty', '1');
      fillIn(mask, 'borrower', '');
      fillIn(mask, 'dueDate', '2026-09-30');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(250);
      E2E.ok(document.querySelector('.modal-mask'), '缺借用人时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('借用人') !== -1, '应提示要填借用人');
      fillIn(mask, 'borrower', '张三');
      fillIn(mask, 'dueDate', '');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(250);
      E2E.ok(document.querySelector('.modal-mask'), '缺归还日期时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('归还日期') !== -1, '应提示要填归还日期');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
      var item = await DB.get('items', 'HW-0001');
      E2E.ok(item.lentQty === 1, '被拒后数量不应变化');
    });

    await E2E.record('借出数量超过在库会被拒绝', async function () {
      await lookup('HW-0001');
      clickDeskAction('借出');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="qty"]'); });
      fillIn(mask, 'qty', '99');
      fillIn(mask, 'borrower', '王五');
      fillIn(mask, 'dueDate', '2026-09-30');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(300);
      E2E.ok(text('#toast-root').indexOf('不够借出') !== -1, '应提示数量不够，实际：' + text('#toast-root'));
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
      var item = await DB.get('items', 'HW-0001');
      E2E.ok(item.inStockQty === 1, '被拒后在库数量不变');
    });

    await E2E.record('借用台账显示在借记录与借用人', async function () {
      await gotoTab('ledger');
      await E2E.waitUntil('台账出现记录', function () { return body().indexOf('HW-0001') !== -1; });
      E2E.ok(body().indexOf('张三') !== -1, '应显示借用人');
      E2E.ok(body().indexOf('2026-09-30') !== -1, '应显示预计归还日期');
      E2E.ok(body().indexOf('装车用') !== -1, '应显示用途');
    });

    await E2E.record('归还后状态回在库、台账清空、流水增加', async function () {
      await gotoTab('desk');
      await lookup('HW-0001');
      clickDeskAction('归还');
      var mask = await modal();
      await E2E.waitUntil('归还表单就绪', function () { return mask.querySelector('[name="operator"]'); });
      fillIn(mask, 'operator', '李四');
      fillIn(mask, 'purpose', '完好归还');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'HW-0001');
      E2E.ok(item.inStockQty === 2 && item.lentQty === 0, '应回到全部在库，实际在库 ' + item.inStockQty + ' 借出 ' + item.lentQty);
      var txns = await DB.getAll('transactions');
      E2E.ok(txns.filter(function (t) { return t.type === 'return'; }).length === 1, '应新增一条归还流水');
      await gotoTab('ledger');
      await E2E.waitUntil('台账已清空', function () { return body().indexOf('当前没有借出去的东西') !== -1; });
    });

    await E2E.record('超期借用会被标出超期天数并排在前面', async function () {
      await global.FEVER.Ops.inbound({
        categoryId: 'electronic', name: '电调', quantity: 3, identityMode: 'shared', operator: '测试'
      });
      await global.FEVER.Ops.lend({
        code: 'EL-0001', qty: 1, operator: '李四', borrower: '超期的人', dueDate: '2020-01-01'
      });
      await global.FEVER.Ops.lend({
        code: 'HW-0001', qty: 1, operator: '李四', borrower: '正常的人', dueDate: '2030-01-01'
      });
      await gotoTab('ledger');
      await E2E.waitUntil('台账出现两条', function () { return body().indexOf('超期的人') !== -1 && body().indexOf('正常的人') !== -1; });
      E2E.ok(body().indexOf('超期') !== -1, '应显示超期标记');
      var rows = Array.prototype.slice.call(document.querySelectorAll('#view-root tbody tr'));
      var overdueIndex = rows.findIndex(function (r) { return r.textContent.indexOf('超期的人') !== -1; });
      E2E.ok(overdueIndex === 0, '超期的应排在最前面，实际在第 ' + (overdueIndex + 1) + ' 行');
      E2E.ok(rows[0].className.indexOf('overdue') !== -1, '超期行应有醒目样式');
      E2E.ok(body().indexOf('超期未还（1）') !== -1, '应汇总超期条数');
    });

    await E2E.record('导航角标显示超期数量', async function () {
      var badge = document.querySelector('#nav-badge-ledger');
      E2E.ok(badge && badge.style.display !== 'none', '借用台账导航上应出现角标');
      E2E.ok(badge.textContent === '1', '角标应为 1，实际 ' + badge.textContent);
    });

    await E2E.record('领用：扣减库存并累计已领用，领完提示补货', async function () {
      await gotoTab('desk');
      await lookup('MC-0001');
      clickDeskAction('领用');
      var mask = await modal();
      await E2E.waitUntil('领用表单就绪', function () { return mask.querySelector('[name="taker"]'); });
      fillIn(mask, 'qty', '80');
      fillIn(mask, 'taker', '王五');
      fillIn(mask, 'purpose', '装配用');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'MC-0001');
      E2E.ok(item.inStockQty === 20, '在库应剩 20，实际 ' + item.inStockQty);
      E2E.ok(item.usedUpQty === 80, '已领用应为 80，实际 ' + item.usedUpQty);
      E2E.ok(item.totalQty === 100, '总件数不应改变');

      // 低于安全库存 30，应出现补货提示
      await gotoTab('home');
      await E2E.waitUntil('首页出现低库存提示', function () { return body().indexOf('库存偏低') !== -1; });
      E2E.ok(body().indexOf('M4螺丝') !== -1, '应指出是哪种物品需要补货');
    });

    await E2E.record('领用超过在库会被拒绝', async function () {
      await gotoTab('desk');
      await lookup('MC-0001');
      clickDeskAction('领用');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="qty"]'); });
      fillIn(mask, 'qty', '999');
      fillIn(mask, 'taker', '王五');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(300);
      E2E.ok(text('#toast-root').indexOf('不够领用') !== -1, '应提示数量不够');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
      E2E.ok((await DB.get('items', 'MC-0001')).inStockQty === 20, '被拒后库存不变');
    });

    await E2E.record('送修与修好回库：状态与数量正确', async function () {
      // 前面的用例已经借出并归还过，这里重新读一次库存，避免写死数字
      await lookup('HW-0001');
      var before = await DB.get('items', 'HW-0001');
      var stockBefore = before.inStockQty;
      clickDeskAction('送修');
      var mask = await modal();
      await E2E.waitUntil('送修表单就绪', function () { return mask.querySelector('[name="purpose"]'); });
      fillIn(mask, 'qty', '1');
      fillIn(mask, 'purpose', '按不动了');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'HW-0001');
      E2E.ok(item.repairQty === 1 && item.inStockQty === stockBefore - 1,
        '送修 1 件后待修应为 1、在库应为 ' + (stockBefore - 1) +
        '，实际待修 ' + item.repairQty + ' 在库 ' + item.inStockQty);
      await E2E.waitUntil('操作台刷新', function () { return text('#desk-result').indexOf('待修 1') !== -1; });

      clickDeskAction('修好回库');
      var mask2 = await modal();
      await E2E.waitUntil('回库表单就绪', function () { return mask2.querySelector('[name="operator"]'); });
      fillIn(mask2, 'operator', '李四');
      fillIn(mask2, 'purpose', '换了开关');
      E2E.clickSelector('[data-ok]', mask2);
      await waitModalGone();
      var after = await DB.get('items', 'HW-0001');
      E2E.ok(after.repairQty === 0 && after.inStockQty === stockBefore,
        '修好后应全部回到在库 ' + stockBefore + '，实际待修 ' + after.repairQty + ' 在库 ' + after.inStockQty);
      var txns = await DB.getAll('transactions');
      var types = txns.map(function (t) { return t.type; });
      E2E.ok(types.indexOf('repair') !== -1 && types.indexOf('repair_done') !== -1, '应留下送修与修好两条流水');
    });

    await E2E.record('全部送出后状态为损坏待修', async function () {
      await lookup('MC-0001');
      clickDeskAction('送修');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="qty"]'); });
      fillIn(mask, 'qty', '20');
      fillIn(mask, 'purpose', '整批返修');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'MC-0001');
      E2E.ok(item.status === 'repairing', '状态应为损坏待修，实际 ' + item.status);
      await E2E.waitUntil('操作台显示损坏待修', function () { return text('#desk-result').indexOf('损坏待修') !== -1; });
    });

    await E2E.record('库存恒等式在多次操作后仍成立', async function () {
      var items = await DB.getAll('items');
      items.forEach(function (i) {
        var sum = i.inStockQty + i.lentQty + i.repairQty + i.usedUpQty;
        E2E.ok(sum === i.totalQty,
          i.code + ' 数量不自洽：在库 ' + i.inStockQty + ' + 借出 ' + i.lentQty + ' + 待修 ' + i.repairQty +
          ' + 已领用 ' + i.usedUpQty + ' = ' + sum + '，总数 ' + i.totalQty);
      });
    });

    await E2E.record('流水页列出全部记录并能按类型与操作人筛选', async function () {
      await gotoTab('txns');
      await E2E.waitUntil('流水表出现', function () { return document.querySelector('#txn-table table'); });
      var all = text('#txn-table');
      E2E.ok(all.indexOf('借出') !== -1, '应包含借出记录');
      E2E.ok(all.indexOf('归还') !== -1, '应包含归还记录');
      E2E.ok(all.indexOf('领用') !== -1, '应包含领用记录');
      E2E.ok(all.indexOf('送修') !== -1, '应包含送修记录');

      E2E.setInput(document.querySelector('[name="t-type"]'), 'consume');
      // 只看数据行的「动作」列：表头与筛选下拉框里也有「归还」等字样，不能拿来判断
      await E2E.waitUntil('只剩领用记录', function () {
        var rows = dataRows();
        return rows.length >= 1 && rows.every(function (r) {
          return r.children[1].textContent.trim() === '领用';
        });
      });
      E2E.setInput(document.querySelector('[name="t-type"]'), '');
      E2E.setInput(document.querySelector('[name="t-operator"]'), '李四');
      await E2E.waitUntil('按操作人筛选生效', function () { return text('#txn-table').indexOf('李四') !== -1; });
      E2E.setInput(document.querySelector('[name="t-operator"]'), '不存在的人');
      await E2E.waitUntil('筛选无结果', function () { return text('#txn-table').indexOf('没有符合条件') !== -1; });
    });

    await E2E.record('流水按时间倒序排列', async function () {
      E2E.setInput(document.querySelector('[name="t-operator"]'), '');
      // 上一步筛成了「没有符合条件的记录」，必须等到数据行真的回来再断言
      await E2E.waitUntil('恢复全部记录', function () { return dataRows().length >= 1; });
      var rows = dataRows();
      E2E.ok(rows.length >= 1, '应有记录');
      var times = rows.map(function (r) { return r.children[0].textContent.trim(); });
      for (var i = 1; i < times.length; i++) {
        E2E.ok(times[i - 1] >= times[i],
          '流水应按时间倒序，第 ' + i + ' 行「' + times[i - 1] + '」不应早于第 ' + (i + 1) + ' 行「' + times[i] + '」');
      }
    });

    await E2E.record('点流水里的编码能跳到该物品详情', async function () {
      await E2E.waitUntil('流水里有编码链接', function () { return document.querySelector('#txn-table [data-goto-item]'); });
      var code = document.querySelector('#txn-table [data-goto-item]').getAttribute('data-goto-item');
      E2E.clickSelector('#txn-table [data-goto-item]');
      await E2E.waitUntil('跳到物品详情', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item';
      });
      E2E.ok(body().indexOf(code) !== -1, '详情页应显示该编码 ' + code);
      E2E.ok(body().indexOf('出入库履历') !== -1, '详情页应有履历');
    });

    await E2E.record('物品详情里的履历包含该物品的全部操作', async function () {
      App.goto('item', { code: 'HW-0001' });
      // 上一步停在别的物品详情页，必须等到本物品的页面渲染出来再断言
      await E2E.waitUntil('详情页就绪', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item' &&
          text('.page-title').indexOf('电动螺丝刀') !== -1 && body().indexOf('出入库履历') !== -1;
      });
      var histPanel = function () {
        return Array.prototype.slice.call(document.querySelectorAll('#view-root .panel')).filter(function (p) {
          return p.querySelector('.panel-title') && p.querySelector('.panel-title').textContent.indexOf('出入库履历') !== -1;
        })[0];
      }();
      E2E.ok(histPanel, '应找到出入库履历区块');

      var t = histPanel.textContent.replace(/\s+/g, ' ');
      // 这把工具经历了：入库 → 借出 → 归还 → 送修 → 修好回库
      ['入库', '借出', '归还', '送修', '修好回库'].forEach(function (label) {
        E2E.ok(t.indexOf(label) !== -1, '履历里应有「' + label + '」，实际：' + t);
      });

      // 履历条数应与数据库里该物品的流水条数一致
      var stored = await DB.getAll('transactions');
      var mine = stored.filter(function (x) { return x.itemCode === 'HW-0001'; });
      E2E.ok(t.indexOf('出入库履历（' + mine.length + '）') !== -1,
        '履历标题应显示条数 ' + mine.length + '，实际：' + t.slice(0, 40));

      // 应是最新的排在最前：第一条是「修好回库」
      var rows = Array.prototype.slice.call(histPanel.querySelectorAll('tbody tr'));
      E2E.ok(rows.length === mine.length, '履历行数应等于流水条数');
      E2E.ok(rows[0].textContent.indexOf('修好回库') !== -1, '最新一条应排在最前，实际第一行：' + rows[0].textContent.replace(/\s+/g, ' '));
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
