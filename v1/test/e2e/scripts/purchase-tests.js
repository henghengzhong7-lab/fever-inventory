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

  /**
   * 等某一页真正渲染完成。用 E2E.goto —— 它靠"框架换过 #view-root"判断，
   * 而不是只看 data-page（已经在目标页时那个条件会立刻成立，等于没等）。
   */
  function gotoTab(name) { return E2E.goto(name); }

  /** 取最上面那个弹窗（弹窗会叠加，最后一个才是最新打开的） */
  function modal() {
    return E2E.waitUntil('弹窗打开', function () { return E2E.topModal(); });
  }

  function waitModalGone() {
    return E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
  }

  function fillIn(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"]');
    E2E.ok(node, '弹窗里应有字段 ' + name);
    E2E.setInput(node, value);
  }

  /** 下拉框选值（会回读确认，写错选项名会立刻报出来，不会拖成"等待超时"） */
  function pickIn(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"]');
    E2E.ok(node, '弹窗里应有下拉框 ' + name);
    E2E.setSelect(node, value);
  }

  /* ---------- 发票 PDF（第十三轮） ---------- */

  /** 一段以 %PDF 开头的最小 PDF 字节（base64），足够验证"存的就是 PDF 本体" */
  var MIN_PDF_B64 = global.btoa('%PDF-1.4\n%FEver test invoice\n%%EOF');

  /**
   * 往到货表单里喂一张"发票 PDF"。
   * 无头浏览器点不出系统文件选择器，和扫码拍照用例一样：DataTransfer 直塞 input。
   * 拖拽事件（dataTransfer.files）与 change 事件读的是同一份 input.files，
   * 塞进去之后两条路都会走到 —— 这里走 change 路验证"选文件"，拖拽高亮是纯样式。
   */
  async function feedPdf(mask, base64) {
    var input = mask.querySelector('#arrive-pdf-input');
    E2E.ok(input, '到货表单应有发票 PDF 选择入口');
    var bytes = Uint8Array.from(global.atob(base64), function (ch) { return ch.charCodeAt(0); });
    var file = new File([bytes], '测试发票.pdf', { type: 'application/pdf' });
    var dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await E2E.waitUntil('PDF 已被读取并显示', function () {
      var msg = mask.querySelector('#arrive-pdf-msg');
      return msg && msg.textContent.indexOf('已选') !== -1;
    });
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
      pickIn(mask, 'troop', '步兵');
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
      E2E.ok(reqs[0].troop === '步兵', '兵种应保存，实际 ' + reqs[0].troop);
      E2E.ok(reqs[0].applicant === '张三', '申请人应保存');
      E2E.ok(reqs[0].approval === 'pending', '新申请应默认待审批，实际 ' + reqs[0].approval);
      E2E.ok(body().indexOf('待购买') !== -1, '列表应显示「待购买」');
      E2E.ok(body().indexOf('待审批') !== -1, '列表应显示「待审批」');
      E2E.ok(body().indexOf('步兵') !== -1, '列表应显示兵种');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 0, '还没到货，不应生成物品');
    });

    await E2E.record('必填校验：兵种、物品名称、申请人缺一不可', async function () {
      E2E.clickSelector('[data-act="new-purchase"]');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="name"]'); });

      // 1) 兵种没选 —— 兵种决定预算归属，不能默认顶一个上去
      fillIn(mask, 'name', '测试件');
      fillIn(mask, 'applicant', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(150);
      E2E.ok(document.querySelector('.modal-mask'), '缺兵种时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('兵种') !== -1, '应提示要选兵种');

      // 2) 选了兵种，但名称空着
      pickIn(mask, 'troop', '步兵');
      fillIn(mask, 'name', '');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(150);
      E2E.ok(document.querySelector('.modal-mask'), '缺名称时弹窗不应关闭');
      E2E.ok(text('#toast-root').indexOf('物品名称') !== -1, '应提示要填物品名称');

      // 3) 名称填上了，申请人还空着
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

    await E2E.record('没经过审批的申请，下单和到货的按钮都不该出现', async function () {
      await gotoTab('purchases');
      await E2E.waitUntil('列表里出现了待审批的申请', function () { return body().indexOf('待审批') !== -1; });
      E2E.ok(!document.querySelector('[data-advance]'), '待审批时不该有「标记已下单」按钮');
      E2E.ok(!document.querySelector('[data-arrive]'), '待审批时不该有「确认到货」按钮');
      E2E.ok(document.querySelector('[data-approve]'), '管理员应该看到「同意」按钮');
      E2E.ok(document.querySelector('[data-reject]'), '管理员应该看到「驳回」按钮');

      // 就算绕过界面直接调入库，也得被挡住
      var reqs = await DB.getAll('purchaseRequests');
      await global.FEVER.Forms.openArrive(reqs[0].id, {});
      await E2E.wait(200);
      E2E.ok(!document.querySelector('.modal-mask'), '没审批就调入库时不该弹出到货表单');
      E2E.ok(text('#toast-root').indexOf('审批') !== -1, '应提示还没经过审批');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 0, '被挡住时不应生成物品，实际 ' + items.length);
    });

    await E2E.record('驳回必须写理由，驳回后成为终态', async function () {
      // 再种一条，用来试驳回（顺手验证「直接写库的老数据」和「表单新建」能共存）
      var now = DB.nowIso();
      await DB.add('purchaseRequests', {
        categoryId: 'electronic', troop: '无人机', name: '备用电调', spec: '', quantity: 2, budget: '900',
        purpose: '备用', applicant: '赵六', status: 'pending', approval: 'pending', createdAt: now, updatedAt: now
      });
      await gotoTab('purchases');
      await E2E.waitUntil('有驳回按钮', function () { return document.querySelector('[data-reject]'); });
      E2E.clickSelector('[data-reject]');
      var mask = await modal();
      await E2E.waitUntil('驳回框就绪', function () { return mask.querySelector('[data-ok]'); });
      E2E.ok(mask.textContent.indexOf('备用电调') !== -1, '驳回框里应写清是哪一条申请');

      // 不写理由 → 拦住
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(200);
      E2E.ok(document.querySelector('.modal-mask'), '没写理由时不该关掉');
      E2E.ok(text('#toast-root').indexOf('驳回理由') !== -1, '应提示要填驳回理由');
      var mid = await DB.getAll('purchaseRequests');
      E2E.ok(mid.every(function (r) { return r.approval !== 'rejected'; }), '没写理由就不该留下驳回记录');

      fillIn(mask, 'note', '本季度该兵种预算已用完，下季度再提');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();

      var rows = await DB.getAll('purchaseRequests');
      var rejected = rows.filter(function (r) { return r.approval === 'rejected'; })[0];
      E2E.ok(!!rejected, '应有一条被驳回的申请');
      E2E.ok(rejected.status === 'canceled', '驳回后状态应落到已取消，实际 ' + rejected.status);
      E2E.ok(rejected.approvalNote === '本季度该兵种预算已用完，下季度再提', '驳回理由应存下来');
      E2E.ok(body().indexOf('已驳回') !== -1, '列表应显示「已驳回」而不是「已取消」');

      // 终态：只剩删除，没有同意/下单/到货
      await gotoTab('purchases');
      await E2E.waitUntil('列表出现被驳回的那条', function () { return body().indexOf('已驳回') !== -1; });
      // 必须**按行**判断：列表里这时还有另一条待审批的申请（工业相机），
      // 直接 querySelector('[data-approve]') 会查到那一行上去，断言永远不成立。
      var rows = Array.prototype.slice.call(document.querySelectorAll('#view-root table tbody tr'));
      var rejectedRow = rows.filter(function (tr) { return tr.textContent.indexOf('已驳回') !== -1; })[0];
      E2E.ok(!!rejectedRow, '列表里应有一行显示「已驳回」');
      E2E.ok(!rejectedRow.querySelector('[data-approve]'), '已驳回的申请不该还有「同意」按钮');
      E2E.ok(!rejectedRow.querySelector('[data-advance]'), '已驳回的申请不该有「标记已下单」');
      E2E.ok(!rejectedRow.querySelector('[data-arrive]'), '已驳回的申请不该有「确认到货」');
      E2E.ok(!!rejectedRow.querySelector('[data-del-purchase]'), '已驳回的申请应当还能删除');

      // 清掉它，免得影响后面的用例（后面几条假定列表里只有一条申请）
      var delBtn = document.querySelector('[data-del-purchase]');
      E2E.ok(!!delBtn, '被驳回的申请应该可以删除');
      E2E.clickSelector('[data-del-purchase]');
      var confirmMask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return confirmMask.querySelector('[data-act="yes"]'); });
      E2E.clickSelector('[data-act="yes"]', confirmMask);
      await E2E.waitUntilAsync('列表里只剩一条申请', async function () {
        var list = await DB.getAll('purchaseRequests');
        return list.length === 1;
      });
      E2E.ok(true, '被驳回的申请已清理');
    });

    await E2E.record('管理员同意之后才放行：按钮出现、申请变成已同意', async function () {
      await gotoTab('purchases');
      await E2E.waitUntil('有同意按钮', function () { return document.querySelector('[data-approve]'); });
      E2E.clickSelector('[data-approve]');
      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.ok(mask.textContent.indexOf('步兵') !== -1, '确认框里应说清会占用哪个兵种的预算');
      E2E.clickSelector('[data-act="yes"]', mask);
      await waitModalGone();

      await E2E.waitUntilAsync('数据库里的审批状态变成已同意', async function () {
        var rows = await DB.getAll('purchaseRequests');
        return rows.length > 0 && rows[0].approval === 'approved';
      });
      var reqs = await DB.getAll('purchaseRequests');
      E2E.ok(reqs[0].approval === 'approved', '审批状态应为已同意，实际 ' + reqs[0].approval);
      E2E.ok(!!reqs[0].approvedAt, '应记下同意的时间');
      E2E.ok(body().indexOf('已同意') !== -1, '列表应显示「已同意」');
      E2E.ok(!!document.querySelector('[data-advance]'), '同意之后应出现「标记已下单」');
      E2E.ok(!document.querySelector('[data-approve]'), '已经批过的申请不该还有「同意」按钮');
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

    await E2E.record('确认到货：不用填发票号和供应商，拖进 PDF 后自动入库并登记发票', async function () {
      await E2E.waitUntil('有到货按钮', function () { return document.querySelector('[data-arrive]'); });
      E2E.clickSelector('[data-arrive]');
      var mask = await modal();
      // 第十三轮：发票号码 / 供应商不再出现在表单里 —— 票据信息由 PDF 承载
      E2E.ok(!mask.querySelector('[name="invoiceNo"]'), '到货表单不该再要发票号码');
      E2E.ok(!mask.querySelector('[name="supplier"]'), '到货表单不该再要供应商名称');
      E2E.ok(mask.querySelector('#arrive-pdf-drop'), '应有发票 PDF 的拖拽 / 点选入口');
      await E2E.waitUntil('到货表单就绪', function () { return mask.querySelector('[name="quantity"]'); });
      E2E.ok(mask.querySelector('[name="quantity"]').value === '2', '到货数量应默认等于申请数量');
      fillIn(mask, 'location', '器材柜A');
      fillIn(mask, 'amount', '5880');
      fillIn(mask, 'invoiceDate', '2026-09-20');
      fillIn(mask, 'operator', '李四');
      pickRadio(mask, 'identityMode', 'single');
      await feedPdf(mask, MIN_PDF_B64);
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
      E2E.ok(invs[0].invoiceNo === '' && invs[0].supplier === '' && invs[0].amount === 5880,
        '不填发票号/供应商也要能入库，金额照记');
      E2E.ok(invs[0].fileName === '测试发票.pdf' && invs[0].fileMime === 'application/pdf' && !!invs[0].fileData,
        '拖进来的 PDF 应保存到发票行上');
      E2E.ok(atob(invs[0].fileData).indexOf('%PDF') === 0, '保存下来的应是 PDF 原始字节');
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
      await E2E.waitUntil('列表出现发票入口', function () { return body().indexOf('测试发票.pdf') !== -1; });
      E2E.ok(!document.querySelector('[data-arrive]'), '已到货的申请不应再出现「确认到货」按钮');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 2, '物品数量不应再增加');
    });

    await E2E.record('发票台账列出发票并能回查申请与物品', async function () {
      await gotoTab('invoices');
      await E2E.waitUntil('发票列表出现', function () { return body().indexOf('测试发票.pdf') !== -1; });
      E2E.ok(body().indexOf('5880') !== -1, '应显示金额');
      E2E.ok(body().indexOf('VS-0001') !== -1, '应显示生成的物品编码');
      E2E.ok(body().indexOf('工业相机') !== -1, '应显示来源申请');
    });

    await E2E.record('点发票能打开详情，详情里能跳到申请与物品，并能下载 PDF', async function () {
      E2E.clickSelector('[data-goto-invoice]');
      var mask = await modal();
      await E2E.waitUntil('发票详情就绪', function () { return mask.querySelector('[data-goto-purchase]'); });
      var detail = mask.textContent.replace(/\s+/g, ' ');
      E2E.ok(detail.indexOf('测试发票.pdf') !== -1, '没填发票号时详情应以文件名标识发票');
      E2E.ok(detail.indexOf('工业相机') !== -1, '详情应显示来源申请');
      E2E.ok(mask.querySelector('[data-goto-item]'), '详情里应能跳到生成的物品');
      E2E.ok(mask.querySelector('[data-invoice-pdf]'), '带了 PDF 的发票应有下载按钮');
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
      E2E.ok(body().indexOf('测试发票.pdf') !== -1, '应显示来源发票（以文件名标识）');
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

    await E2E.record('管理员批量下载发票 PDF：先勾选、只下所选（第十三轮）', async function () {
      // 再造第二张带 PDF 的发票 —— 只有一张时测不出"选择"这件事
      var now2 = DB.nowIso();
      var id2 = await DB.add('purchaseRequests', {
        categoryId: 'hardware', troop: '其他', name: '第二张发票件', spec: '', quantity: 1, budget: '2',
        purpose: '', applicant: '李四', status: 'ordered', createdAt: now2, updatedAt: now2
      });
      await global.FEVER.Ops.arrive({
        requestId: id2, quantity: 1, amount: 2, operator: '张三',
        invoiceFile: { name: '第二张.pdf', mime: 'application/pdf', size: 10, base64: MIN_PDF_B64 }
      });

      await gotoTab('purchases');
      await E2E.waitUntil('批量下载按钮出现', function () { return document.querySelector('[data-dl-invoices]'); });
      E2E.ok(body().indexOf('批量下载发票（2）') !== -1, '按钮上应写明有 2 张发票可下载');

      // 拦下真正的浏览器下载（无头环境里下载不好验证），拿到字节自己验
      var saved = [];
      var realDownload = global.FEVER.UI.downloadBytes;
      global.FEVER.UI.downloadBytes = function (name, bytes, mime) {
        saved.push({ name: name, bytes: bytes, mime: mime });
      };
      try {
        // 点按钮先弹选择弹窗，默认全选
        E2E.clickSelector('[data-dl-invoices]');
        await E2E.waitUntil('发票选择弹窗打开', function () { return document.querySelector('input[name="inv-pick"]'); });
        E2E.ok(document.querySelectorAll('input[name="inv-pick"]').length === 2, '弹窗应列出 2 张发票');
        E2E.ok(document.querySelectorAll('input[name="inv-pick"]:checked').length === 2, '默认应全选');

        // 全不选 → 下载按钮禁用，点了也不该产生 zip
        E2E.clickSelector('[data-inv-check="none"]');
        var dlBtn = document.querySelector('[data-inv-download]');
        E2E.ok(dlBtn && dlBtn.disabled, '一张都不选时下载按钮应禁用');
        E2E.clickSelector('[data-inv-download]');
        await new Promise(function (r) { setTimeout(r, 200); });
        E2E.ok(saved.length === 0, '全不选时不产生下载');

        // 只勾第一张 → zip 里应只有 1 个条目（这就是"可以选择下哪些"本身）
        var box = document.querySelector('input[name="inv-pick"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await E2E.waitUntil('下载按钮恢复可用', function () {
          var b = document.querySelector('[data-inv-download]');
          return b && !b.disabled;
        });
        var counter = document.querySelector('#inv-pick-count');
        E2E.ok(counter && counter.textContent.indexOf('已选 1') !== -1,
          '计数应显示已选 1 张，实际：' + (counter ? counter.textContent : '没有计数'));
        E2E.clickSelector('[data-inv-download]');
        await E2E.waitUntil('zip 已生成', function () { return saved.length > 0; }, 10000);
      } finally {
        global.FEVER.UI.downloadBytes = realDownload;
      }

      var zip = saved[0];
      E2E.ok(/\.zip$/.test(zip.name), '应保存成 .zip 文件，实际 ' + zip.name);
      E2E.ok(zip.mime === 'application/zip', 'MIME 应是 application/zip');
      var b = zip.bytes;
      var starts = String.fromCharCode.apply(null, Array.prototype.slice.call(b.slice(0, 4)));
      E2E.ok(starts === 'PK\x03\x04', '应是合法 ZIP（PK 头），实际 ' + JSON.stringify(starts));
      var ends = String.fromCharCode.apply(null, Array.prototype.slice.call(b.slice(-22, -18)));
      E2E.ok(ends === 'PK\x05\x06', '结尾应是 ZIP 中央目录结束符（EOCD），实际 ' + JSON.stringify(ends));

      var entries = 0, hasPdf = false;
      for (var i = 0; i < b.length - 4; i += 1) {
        if (b[i] === 0x50 && b[i + 1] === 0x4B && b[i + 2] === 0x03 && b[i + 3] === 0x04) entries += 1;
        if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) hasPdf = true;
      }
      E2E.ok(entries === 1, '只勾了一张，zip 里应只有 1 个条目，实际 ' + entries);
      E2E.ok(hasPdf, 'zip 里应包含发票 PDF 的原始字节（%PDF 头）');
    });

    await E2E.record('拖进来的不是 PDF 会被当场拦下（第十三轮）', async function () {
      // 直接对数据层验证（表单层的校验是同一套话）：
      // 造一条新申请走到货，附件却是 .txt —— 数据层必须拒收
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var now = DB.nowIso();
      var id = await DB.add('purchaseRequests', {
        categoryId: 'hardware', troop: '其他', name: '附件校验件', spec: '', quantity: 1, budget: '1',
        purpose: '', applicant: '测', status: 'ordered', createdAt: now, updatedAt: now
      });
      var rejected = false;
      try {
        await global.FEVER.Ops.arrive({
          requestId: id, quantity: 1, amount: 1, operator: '测',
          invoiceFile: { name: '发票.txt', mime: 'text/plain', size: 3, base64: global.btoa('abc') }
        });
      } catch (err) {
        rejected = true;
        E2E.ok(/PDF/.test(err.message), '拒绝理由要说明只收 PDF，实际：' + err.message);
      }
      E2E.ok(rejected, '非 PDF 附件必须被数据层拒收');
      var invs = await DB.getAll('invoices');
      E2E.ok(invs.length === 0, '被拒后不应留下发票行');
      var req = await DB.get('purchaseRequests', id);
      E2E.ok(req && req.status === 'ordered', '被拒后申请状态不应改变');
    });

    await E2E.record('不填发票号和供应商、也不传 PDF，一样能完成到货入库（第十三轮）', async function () {
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var now = DB.nowIso();
      var reqId = await DB.add('purchaseRequests', {
        categoryId: 'hardware', troop: '其他', name: '扎带', spec: '', quantity: 100, budget: '50',
        purpose: '理线', applicant: '王五', status: 'ordered', createdAt: now, updatedAt: now
      });
      await gotoTab('purchases');
      await E2E.waitUntil('有到货按钮', function () { return document.querySelector('[data-arrive]'); });
      E2E.clickSelector('[data-arrive]');
      var mask = await modal();
      await E2E.waitUntil('到货表单就绪', function () { return mask.querySelector('[name="quantity"]'); });
      fillIn(mask, 'amount', '45');
      fillIn(mask, 'operator', '李四');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();

      var invs = await DB.getAll('invoices');
      E2E.ok(invs.length === 1 && invs[0].invoiceNo === '' && invs[0].supplier === '',
        '发票号与供应商为空也应正常登记（票据信息在 PDF 里）');
      E2E.ok(!invs[0].fileData && !invs[0].fileRef, '没传 PDF 就不该有附件');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1 && items[0].totalQty === 100,
        'hardware 默认同款共用，应生成 1 个身份记 100 件，实际 ' + items.length + ' 个身份');
      var req = await DB.get('purchaseRequests', reqId);
      E2E.ok(req && req.status === 'arrived', '申请应标记为已到货');
    });

    await E2E.record('改成同款共用模式后，到货只生成 1 个身份并记件数', async function () {
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var now = DB.nowIso();
      await DB.add('purchaseRequests', {
        categoryId: 'hardware', troop: '其他', name: '扎带', spec: '', quantity: 100, budget: '50',
        purpose: '理线', applicant: '王五', status: 'ordered', createdAt: now, updatedAt: now
      });
      await gotoTab('purchases');
      await E2E.waitUntil('有到货按钮', function () { return document.querySelector('[data-arrive]'); });
      E2E.clickSelector('[data-arrive]');
      var mask = await modal();
      await E2E.waitUntil('到货表单就绪', function () { return mask.querySelector('[name="quantity"]'); });
      fillIn(mask, 'amount', '45');
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
      E2E.ok(body().indexOf('HW-0001') !== -1, '物品本身应仍然可见');
    });

    await E2E.record('取消采购申请不生成物品', async function () {
      var now = DB.nowIso();
      await DB.add('purchaseRequests', {
        categoryId: 'electronic', troop: '无人机', name: '电调', spec: '', quantity: 4, budget: '800',
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

    /* ---------- 兵种预算（功能 3） ---------- */

    await E2E.record('兵种预算：已用只算已同意的申请', async function () {
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var now = DB.nowIso();
      // 三条申请，分别对应三种审批状态，用来钉住统计口径
      await DB.add('purchaseRequests', {
        categoryId: 'vision', troop: '步兵', name: '已同意件', spec: '', quantity: 1, budget: '9000',
        purpose: '', applicant: '甲', status: 'arrived', approval: 'approved', createdAt: now, updatedAt: now
      });
      await DB.add('purchaseRequests', {
        categoryId: 'vision', troop: '无人机', name: '待审批件', spec: '', quantity: 1, budget: '1000',
        purpose: '', applicant: '乙', status: 'pending', approval: 'pending', createdAt: now, updatedAt: now
      });
      await DB.add('purchaseRequests', {
        categoryId: 'vision', troop: '哨兵', name: '被驳回件', spec: '', quantity: 1, budget: '500',
        purpose: '', applicant: '丙', status: 'canceled', approval: 'rejected', approvalNote: '不批',
        createdAt: now, updatedAt: now
      });
      await DB.setSetting(global.FEVER.Stats.BUDGET_KEY, { 步兵: 10000, 无人机: 5000 });

      await gotoTab('budgets');
      await E2E.waitUntil('预算页渲染完成', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'budgets' &&
          body().indexOf('步兵') !== -1;
      });
      E2E.ok(body().indexOf('兵种预算') !== -1, '应有兵种预算标题');
      E2E.ok(body().indexOf('15000.00') !== -1, '总预算应是 10000+5000=15000，页面：' + body().slice(0, 200));
      E2E.ok(body().indexOf('9000.00') !== -1, '已用应是 9000（只有已同意的那条算）');
      E2E.ok(body().indexOf('6000.00') !== -1, '剩余应是 15000-9000=6000');
      E2E.ok(body().indexOf('1000.00') !== -1, '待审批的 1000 应单列，不占预算');
      E2E.ok(body().indexOf('哨兵') === -1, '被驳回的申请不该出现在预算明细里');
      var saved = await DB.getSetting(global.FEVER.Stats.BUDGET_KEY, {});
      E2E.ok(saved['步兵'] === 10000, '预算额度应存在 settings 里（不动飞书表结构）');
    });

    await E2E.record('兵种预算：改额度能存下来并立刻生效', async function () {
      E2E.clickSelector('[data-act="edit-budgets"]');
      var mask = await modal();
      await E2E.waitUntil('预算设置框就绪', function () { return mask.querySelector('[name="budget-0"]'); });
      var troops = global.FEVER.Rules.TROOPS;
      var idx = troops.indexOf('步兵');
      E2E.ok(idx >= 0, '兵种列表里应有步兵');
      fillIn(mask, 'budget-' + idx, '20000');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();

      await E2E.waitUntil('页面上的总预算已更新', function () { return body().indexOf('25000.00') !== -1; });
      var saved = await DB.getSetting(global.FEVER.Stats.BUDGET_KEY, {});
      E2E.ok(saved['步兵'] === 20000, '步兵额度应存成 20000，实际 ' + saved['步兵']);
      E2E.ok(saved['无人机'] === 5000, '没动过的兵种额度应保持原样，实际 ' + saved['无人机']);
      E2E.ok(body().indexOf('16000.00') !== -1, '剩余应跟着变成 25000-9000=16000');
    });

    await E2E.record('兵种预算导出：三段式 CSV，含已消费明细与未消费预算', async function () {
      // 拦下真正的浏览器下载，拿到内容自己验（与批量下载 zip 同一手法）
      var savedTexts = [];
      var realDownloadText = global.FEVER.UI.downloadText;
      global.FEVER.UI.downloadText = function (name, text, mime) {
        savedTexts.push({ name: name, text: text, mime: mime });
      };
      try {
        E2E.clickSelector('[data-act="export-budgets"]');
        await E2E.waitUntil('CSV 已生成', function () { return savedTexts.length > 0; }, 10000);
      } finally {
        global.FEVER.UI.downloadText = realDownloadText;
      }

      var csv = savedTexts[0];
      E2E.ok(/\.csv$/.test(csv.name), '应保存成 .csv 文件，实际 ' + csv.name);
      E2E.ok(csv.text.indexOf('【已消费明细】') !== -1 && csv.text.indexOf('【未消费预算】') !== -1,
        '应有已消费明细与未消费预算两段');
      // 当前数据：步兵已同意 9000（额度 20000）、无人机只有待审批 1000（额度 5000）
      E2E.ok(csv.text.indexOf('步兵,20000.00,9000.00,11000.00') !== -1, '总表里步兵一行应为 已用9000/剩11000');
      E2E.ok(csv.text.indexOf('已消费') !== -1, '步兵应标记已消费');
      E2E.ok(csv.text.indexOf('无人机,5000.00,0.00,5000.00') !== -1, '总表里无人机一行应为 已用0/剩5000');
      E2E.ok(csv.text.indexOf('已同意件') !== -1, '已消费明细里应有那条已同意的申请');
      E2E.ok(csv.text.indexOf('待审批件') === -1, '待审批的没花钱，不该出现在已消费明细里');
      var unusedSection = csv.text.split('【未消费预算】')[1];
      E2E.ok(unusedSection.indexOf('步兵') !== -1 && unusedSection.indexOf('无人机') !== -1,
        '两个兵种都还有剩余额度，都应在未消费预算段里');
    });

    /* ---------- 删除与删除记录（功能 4） ---------- */

    await E2E.record('删除物品身份：删得掉，但履历和删除记录都留着', async function () {
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var res = await global.FEVER.Ops.inbound({
        categoryId: 'mechanical', name: '步进电机', quantity: 2,
        identityMode: 'shared', operator: '前台登记'
      });
      var code = res.codes[0];

      App.goto('item', { code: code });
      await E2E.waitUntil('物品详情页出现删除按钮', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item' &&
          document.querySelector('[data-del-item]');
      });
      E2E.clickSelector('[data-del-item]');
      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.ok(mask.textContent.indexOf('删除记录') !== -1, '确认框里应说明这次删除会记入删除记录');
      E2E.ok(mask.textContent.indexOf(code) !== -1, '确认框里应写清删的是哪一件');
      E2E.clickSelector('[data-act="yes"]', mask);

      await E2E.waitUntilAsync('物品已从库里删掉', async function () {
        return (await DB.get('items', code)) === undefined;
      });
      var txns = await DB.getAll('transactions');
      E2E.ok(txns.length === 1, '流水不能被连带删掉 —— 履历要留着，实际 ' + txns.length + ' 条');
      // 等删除记录真的落库再断言（它是删除之后另外写的一笔，不同步）。
      // 注意空数组是 truthy —— 直接返回 filter 结果会让等待"立刻成功"，
      // 必须没有命中时返回 null，否则等于没等。
      var log = await E2E.waitUntilAsync('删除记录落库', async function () {
        var rows = await global.FEVER.Rules.getDeleteLog();
        return rows.length ? rows : null;
      });
      E2E.ok(log.length === 1, '应留下 1 条删除记录，实际 ' + log.length);
      E2E.ok(log[0].store === 'items' && log[0].key === code, '删除记录要记清类型和被删的键');
      E2E.ok(log[0].snapshot && log[0].snapshot.name === '步进电机', '快照里要有被删物品的内容');
      E2E.ok(log[0].by === '本机操作', '离线版的操作人应如实写成「本机操作」，实际 ' + log[0].by);

      // 删完不该停在一个已经不存在的详情页上，要退回它所属的大类
      await E2E.waitUntil('自动退回机械大类页', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'category';
      });
      E2E.ok(body().indexOf('步进电机') === -1, '清单里不该再有它');
    });

    await E2E.record('还有实物借在外的物品不许删：按钮直接不可点', async function () {
      var res = await global.FEVER.Ops.inbound({
        categoryId: 'mechanical', name: '扭力扳手', quantity: 1,
        identityMode: 'shared', operator: '前台登记'
      });
      var code = res.codes[0];
      await global.FEVER.Ops.lend({
        code: code, qty: 1, borrower: '张三', dueDate: '2026-12-31',
        purpose: '调车', operator: '前台登记'
      });

      App.goto('item', { code: code });
      await E2E.waitUntil('物品详情页就绪', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item' && body().indexOf(code) !== -1;
      });
      E2E.ok(!document.querySelector('[data-del-item]'), '借出中的物品不该出现可点的删除按钮');
      var disabled = document.querySelector('.page-actions button[disabled]');
      E2E.ok(!!disabled, '应当画出一个禁用的删除按钮，让人知道这里有个删除但暂时不能用');
      E2E.ok(/借/.test(disabled.getAttribute('title') || ''),
        '禁用按钮上要写清原因，实际：' + disabled.getAttribute('title'));
    });

    await E2E.record('删除发票：从台账消失，由它入库的物品保留', async function () {
      await E2E.resetDb();
      await global.FEVER.Rules.initCategories();
      var now = DB.nowIso();
      var reqId = await DB.add('purchaseRequests', {
        categoryId: 'hardware', troop: '其他', name: '扎带', spec: '', quantity: 50, budget: '60',
        purpose: '', applicant: '王五', status: 'ordered', approval: 'approved',
        createdAt: now, updatedAt: now
      });
      await global.FEVER.Ops.arrive({
        requestId: reqId, quantity: 50, invoiceNo: 'FP-DEL-1', amount: 58,
        supplier: '五金店', operator: '李四', identityMode: 'shared'
      });

      await gotoTab('invoices');
      await E2E.waitUntil('发票台账出现', function () { return body().indexOf('FP-DEL-1') !== -1; });
      E2E.ok(!!document.querySelector('[data-del-invoice]'), '发票列表应该有删除按钮');
      E2E.clickSelector('[data-del-invoice]');
      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.clickSelector('[data-act="yes"]', mask);

      await E2E.waitUntilAsync('发票已删除', async function () {
        return (await DB.getAll('invoices')).length === 0;
      });
      // 删除记录是删除之后**另外**写的一笔，所以不能只等"记录没了"就读日志 ——
      // 那会在日志落库之前就读，看到"没有记录"这种假象。
      // （filter 空结果是 truthy，必须显式返回 null，否则等待会立刻"成功"。）
      var invLog = await E2E.waitUntilAsync('删除记录里出现了这张发票', async function () {
        var rows = await global.FEVER.Rules.getDeleteLog();
        var hit = rows.filter(function (r) { return r.store === 'invoices'; });
        return hit.length ? hit : null;
      });
      E2E.ok(!!invLog[0].snapshot, '快照里要有被删发票的内容');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1, '物品是实物，不该因为票据被删就跟着消失，实际 ' + items.length);
    });

    await E2E.record('删除流水：删得掉，但必须留痕（且要说清不会改库存）', async function () {
      await gotoTab('txns');
      await E2E.waitUntil('流水列表出现删除按钮', function () { return document.querySelector('[data-del-txn]'); });
      var before = await DB.getAll('transactions');
      E2E.ok(before.length === 1, '前置条件：此时应有 1 条入库流水，实际 ' + before.length);

      E2E.clickSelector('[data-del-txn]');
      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.ok(mask.textContent.indexOf('不会改动物品的库存数量') !== -1,
        '确认框必须提醒"删流水不改库存"，否则账实会悄悄对不上');
      E2E.clickSelector('[data-act="yes"]', mask);

      await E2E.waitUntilAsync('流水少了一条', async function () {
        return (await DB.getAll('transactions')).length === 0;
      });
      var txnLog = await E2E.waitUntilAsync('删除记录里出现了这条流水', async function () {
        var rows = await global.FEVER.Rules.getDeleteLog();
        var hit = rows.filter(function (r) { return r.store === 'transactions'; });
        return hit.length ? hit : null;
      });
      E2E.ok(txnLog[0].snapshot && txnLog[0].snapshot.itemCode, '快照里要保留原流水内容，删了也查得回来');
      E2E.ok(txnLog[0].by === '本机操作', '操作人应如实写成「本机操作」');
    });

    await E2E.record('设置页能翻到删除记录（界面刻意不给清空）', async function () {
      await gotoTab('settings');
      await E2E.waitUntil('设置页出现删除记录入口', function () {
        return document.querySelector('[data-act="delete-log"]');
      });
      E2E.ok(body().indexOf('删除记录') !== -1, '设置页应有删除记录板块');
      E2E.clickSelector('[data-act="delete-log"]');
      var mask = await modal();
      await E2E.waitUntil('删除记录弹窗就绪', function () { return mask.textContent.indexOf('谁删的') !== -1; });

      var detail = mask.textContent.replace(/\s+/g, ' ');
      E2E.ok(detail.indexOf('FP-DEL-1') !== -1, '应列出被删的发票，实际：' + detail.slice(0, 200));
      E2E.ok(detail.indexOf('本机操作') !== -1, '操作人应如实写成「本机操作」');
      E2E.ok(!mask.querySelector('[data-act="clear-delete-log"]'), '界面不提供"清空删除记录"');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
