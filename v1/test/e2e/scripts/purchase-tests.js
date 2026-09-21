/**
 * M4 的浏览器端到端测试：采购申请、到货确认、自动入库、发票台账，
 * 以及三个模块之间的互相关联与必填校验。
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

  /** 等某一页真正渲染完成（比匹配页面文字可靠） */
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

  function pickRadio(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"][value="' + value + '"]');
    E2E.ok(node, '应有选项 ' + name + '=' + value);
    node.checked = true;
  }

  async function run() {
    await E2E.resetDb();
    await global.FEVER.Rules.initCategories();
    await App.refresh();

    await E2E.record('新建采购申请：提交后出现在列表，状态为待购买', async function () {
      await gotoTab('purchases');
      await E2E.waitUntil('有新建入口', function () { return document.querySelector('[data-act="new-purchase"]'); });
      E2E.clickSelector('[data-act="new-purchase"]');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="name"]'); });
      fillIn(mask, 'categoryId', 'vision');
      fillIn(mask, 'name', '工业相机');
      fillIn(mask, 'spec', '500万像素');
      fillIn(mask, 'quantity', '2');
      fillIn(mask, 'budget', '6000');
      fillIn(mask, 'applicant', '张三');
      fillIn(mask, 'purpose', '色块识别');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      await E2E.waitUntil('列表出现新申请', function () { return body().indexOf('工业相机') !== -1; });
      var reqs = await DB.getAll('purchaseRequests');
      E2E.ok(reqs.length === 1, '应有 1 条申请，实际 ' + reqs.length);
      E2E.ok(reqs[0].status === 'pending', '状态应为待购买，实际 ' + reqs[0].status);
      E2E.ok(reqs[0].applicant === '张三', '申请人应保存');
      E2E.ok(body().indexOf('待购买') !== -1, '列表应显示「待购买」');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 0, '还没到货，不应生成物品');
    });

    await E2E.record('必填校验：缺物品名称或申请人无法提交', async function () {
      E2E.clickSelector('[data-act="new-purchase"]');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="name"]'); });
      fillIn(mask, 'name', '');
      fillIn(mask, 'applicant', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(150);
      E2E.ok(document.querySelector('.modal-mask'), '缺名称时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('物品名称') !== -1, '应提示要填物品名称');
      fillIn(mask, 'name', '测试件');
      fillIn(mask, 'applicant', '');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(150);
      E2E.ok(document.querySelector('.modal-mask'), '缺申请人时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('申请人') !== -1, '应提示要填申请人');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
      var reqs = await DB.getAll('purchaseRequests');
      E2E.ok(reqs.length === 1, '被拒的申请不应入库，实际 ' + reqs.length + ' 条');
    });

    await E2E.record('状态流转：待购买 → 已下单', async function () {
      await E2E.waitUntil('有待下单按钮', function () { return document.querySelector('[data-advance]'); });
      E2E.clickSelector('[data-advance]');
      // 注意两点：按钮文字本身含「已下单」，不能只看页面文字；
      // 也不能靠预先缓存的状态变量，必须每次重新读数据库。
      await E2E.waitUntilAsync('数据库里的状态变为已下单', async function () {
        var rows = await DB.getAll('purchaseRequests');
        return rows.length > 0 && rows[0].status === 'ordered';
      });
      E2E.ok(body().indexOf('已下单') !== -1, '列表应显示已下单');
    });

    await E2E.record('确认到货：填发票后自动入库并登记发票', async function () {
      await E2E.waitUntil('有到货按钮', function () { return document.querySelector('[data-arrive]'); });
      E2E.clickSelector('[data-arrive]');
      var mask = await modal();
      await E2E.waitUntil('到货表单就绪', function () { return mask.querySelector('[name="invoiceNo"]'); });
      E2E.ok(mask.querySelector('[name="quantity"]').value === '2', '到货数量应默认等于申请数量');
      fillIn(mask, 'location', '器材柜A');
      fillIn(mask, 'invoiceNo', 'FP-2026-001');
      fillIn(mask, 'amount', '5880');
      fillIn(mask, 'supplier', '某视觉公司');
      fillIn(mask, 'invoiceDate', '2026-09-20');
      fillIn(mask, 'operator', '李四');
      pickRadio(mask, 'identityMode', 'single');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();

      var items = await DB.getAll('items');
      E2E.ok(items.length === 2, '视觉类单独建身份，应生成 2 个身份，实际 ' + items.length);
      E2E.ok(items.map(function (i) { return i.code; }).sort().join(',') === 'VS-0001,VS-0002',
        '编码应为 VS-0001、VS-0002');
      items.forEach(function (i) {
        E2E.ok(i.status === 'in_stock', '到货后状态应为在库');
        E2E.ok(i.location === '器材柜A', '存放位置应保存');
        E2E.ok(i.purchaseRequestId, '物品应挂上来源申请');
        E2E.ok(i.invoiceId, '物品应挂上来源发票');
      });
      var invs = await DB.getAll('invoices');
      E2E.ok(invs.length === 1, '应有 1 张发票，实际 ' + invs.length);
      E2E.ok(invs[0].invoiceNo === 'FP-2026-001' && invs[0].supplier === '某视觉公司' && invs[0].amount === 5880,
        '发票信息应完整保存');
      var txns = await DB.getAll('transactions');
      E2E.ok(txns.length === 2 && txns.every(function (t) { return t.type === 'inbound'; }),
        '应有 2 条入库流水，实际 ' + txns.length);
      var reqsAll = await DB.getAll('purchaseRequests');
      E2E.ok(reqsAll.length === 1 && reqsAll[0].status === 'arrived',
        '申请应标记为已到货，实际 ' + (reqsAll[0] && reqsAll[0].status));
    });

    await E2E.record('到货后物品出现在对应大类里', async function () {
      App.goto('category', { id: 'vision' });
      await E2E.waitUntil('视觉页清单出现', function () {
        return document.querySelector('#cat-table table') && text('#cat-table').indexOf('工业相机') !== -1;
      });
      E2E.ok(text('#cat-table').indexOf('VS-0001') !== -1, '视觉页应列出到货的物品');
    });

    await E2E.record('已到货的申请不再显示确认到货按钮', async function () {
      await gotoTab('purchases');
      await E2E.waitUntil('列表出现发票号', function () { return body().indexOf('FP-2026-001') !== -1; });
      E2E.ok(!document.querySelector('[data-arrive]'), '已到货的申请不应再出现「确认到货」按钮');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 2, '物品数量不应再增加');
    });

    await E2E.record('发票台账列出发票并能回查申请与物品', async function () {
      await gotoTab('invoices');
      await E2E.waitUntil('发票列表出现', function () { return body().indexOf('FP-2026-001') !== -1; });
      E2E.ok(body().indexOf('某视觉公司') !== -1, '应显示供应商');
      E2E.ok(body().indexOf('5880') !== -1, '应显示金额');
      E2E.ok(body().indexOf('VS-0001') !== -1, '应显示生成的物品编码');
      E2E.ok(body().indexOf('工业相机') !== -1, '应显示来源申请');
    });

    await E2E.record('点发票能打开详情，详情里能跳到申请与物品', async function () {
      E2E.clickSelector('[data-goto-invoice]');
      var mask = await modal();
      await E2E.waitUntil('发票详情就绪', function () { return mask.querySelector('[data-goto-purchase]'); });
      var detail = mask.textContent.replace(/\s+/g, ' ');
      E2E.ok(detail.indexOf('FP-2026-001') !== -1, '详情应显示发票号');
      E2E.ok(detail.indexOf('某视觉公司') !== -1, '详情应显示供应商');
      E2E.ok(detail.indexOf('工业相机') !== -1, '详情应显示来源申请');
      E2E.ok(mask.querySelector('[data-goto-item]'), '详情里应能跳到生成的物品');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

    await E2E.record('点物品能回查来源申请与发票，三者互相关联', async function () {
      App.goto('item', { code: 'VS-0001' });
      await E2E.waitUntil('物品详情页就绪', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item' &&
          document.querySelector('[data-goto-purchase]');
      });
      E2E.ok(body().indexOf('来源单据') !== -1, '应有来源单据区块');
      E2E.ok(body().indexOf('FP-2026-001') !== -1, '应显示来源发票号');
      E2E.ok(body().indexOf('某视觉公司') !== -1, '应显示供应商');
      E2E.ok(body().indexOf('张三') !== -1, '应显示申请人');
      await E2E.waitUntil('有跳转申请按钮', function () { return document.querySelector('[data-goto-purchase]'); });
      E2E.clickSelector('[data-goto-purchase]');
      var mask = await modal();
      await E2E.waitUntil('申请详情就绪', function () { return mask.textContent.indexOf('采购申请 #') !== -1; });
      E2E.ok(mask.textContent.indexOf('色块识别') !== -1, '应显示用途');
      E2E.ok(mask.querySelector('[data-goto-invoice]'), '申请详情里应能跳回发票');
      E2E.ok(mask.querySelector('[data-goto-item]'), '申请详情里应能跳到物品');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

    await E2E.record('到货必填项校验：缺发票号或供应商无法入库', async function () {
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var now = DB.nowIso();
      var reqId = await DB.add('purchaseRequests', {
        categoryId: 'hardware', name: '扎带', spec: '', quantity: 100, budget: '50',
        purpose: '理线', applicant: '王五', status: 'ordered', createdAt: now, updatedAt: now
      });
      await gotoTab('purchases');
      await E2E.waitUntil('有到货按钮', function () { return document.querySelector('[data-arrive]'); });
      E2E.clickSelector('[data-arrive]');
      var mask = await modal();
      await E2E.waitUntil('到货表单就绪', function () { return mask.querySelector('[name="invoiceNo"]'); });
      fillIn(mask, 'invoiceNo', '');
      fillIn(mask, 'amount', '45');
      fillIn(mask, 'supplier', '五金店');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(250);
      E2E.ok(document.querySelector('.modal-mask'), '缺发票号时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('发票号码') !== -1, '应提示缺发票号码');
      fillIn(mask, 'invoiceNo', 'FP-002');
      fillIn(mask, 'supplier', '');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(250);
      E2E.ok(document.querySelector('.modal-mask'), '缺供应商时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('供应商') !== -1, '应提示缺供应商');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 0, '被拒时不应生成物品，实际 ' + items.length);
      var invs = await DB.getAll('invoices');
      E2E.ok(invs.length === 0, '被拒时不应生成发票，实际 ' + invs.length);
      var req = await DB.get('purchaseRequests', reqId);
      E2E.ok(req && req.status === 'ordered', '被拒后申请状态不应改变，实际 ' + (req && req.status));
    });

    await E2E.record('改成同款共用模式后，到货只生成 1 个身份并记件数', async function () {
      var mask = document.querySelector('.modal-mask');
      fillIn(mask, 'invoiceNo', 'FP-002');
      fillIn(mask, 'amount', '45');
      fillIn(mask, 'supplier', '五金店');
      fillIn(mask, 'quantity', '100');
      fillIn(mask, 'operator', '李四');
      pickRadio(mask, 'identityMode', 'shared');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1, '同款共用应只生成 1 个身份，实际 ' + items.length);
      E2E.ok(items[0].code === 'HW-0001', '编码应为 HW-0001，实际 ' + items[0].code);
      E2E.ok(items[0].totalQty === 100, '件数应为 100，实际 ' + items[0].totalQty);
    });

    await E2E.record('删除采购申请后，已生成的物品与流水仍完整可查', async function () {
      await gotoTab('purchases');
      await E2E.waitUntil('有删除按钮', function () { return document.querySelector('[data-del-purchase]'); });
      E2E.clickSelector('[data-del-purchase]');
      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.clickSelector('[data-act="yes"]', mask);
      await E2E.waitUntil('申请已从列表消失', function () { return !document.querySelector('[data-del-purchase]'); });
      var reqs = await DB.getAll('purchaseRequests');
      E2E.ok(reqs.length === 0, '申请应已删除');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1, '物品应保留，实际 ' + items.length);
      var txns = await DB.getAll('transactions');
      E2E.ok(txns.length === 1, '流水应保留，实际 ' + txns.length);

      App.goto('item', { code: 'HW-0001' });
      await E2E.waitUntil('物品详情出现', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item' && body().indexOf('HW-0001') !== -1;
      });
      E2E.ok(body().indexOf('来源已删除') !== -1, '应提示来源已删除');
      E2E.ok(body().indexOf('FP-002') !== -1, '发票信息仍应可见');
    });

    await E2E.record('取消采购申请不生成物品', async function () {
      var now = DB.nowIso();
      await DB.add('purchaseRequests', {
        categoryId: 'electronic', name: '电调', spec: '', quantity: 4, budget: '800',
        purpose: '备用', applicant: '赵六', status: 'pending', createdAt: now, updatedAt: now
      });
      await gotoTab('purchases');
      await E2E.waitUntil('有待取消的申请', function () { return document.querySelector('[data-cancel-id]'); });
      E2E.clickSelector('[data-cancel-id]');
      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.clickSelector('[data-act="yes"]', mask);
      await E2E.waitUntilAsync('状态变为已取消', async function () {
        var rows = await DB.getAll('purchaseRequests');
        return rows.length && rows[0].status === 'canceled';
      });
      var reqs = await DB.getAll('purchaseRequests');
      E2E.ok(reqs[0].status === 'canceled', '状态应为已取消，实际 ' + reqs[0].status);
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1, '取消不应生成物品，实际 ' + items.length + ' 件');
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
