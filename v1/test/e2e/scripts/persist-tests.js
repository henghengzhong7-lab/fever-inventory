/**
 * M8 的浏览器端到端测试：数据真能存住。
 *
 * 这个页面按 ?phase= 分三段跑，由 test/e2e/run-persist.js 用**同一个浏览器配置目录、
 * 同一个端口**反复打开，才能验证"关掉浏览器再打开数据还在"（对照 AC-02 ~ AC-04）。
 *
 *   phase=seed    造一整套数据（物品 / 采购 / 发票 / 流水），把"应该有多少"存进设置
 *   phase=verify  先自己刷新一次（模拟按 F5），再核对数据是否原样还在
 *   phase=after   在"重启之后"再新增一批，核对编码没有重用已发出去的号
 *
 * 注意：核对阶段一律不改动已有数据（不改不删），否则后面几步就没法对照了。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var DB = global.FEVER.DB;
  var Rules = global.FEVER.Rules;
  var Ops = global.FEVER.Ops;
  var Stats = global.FEVER.Stats;

  var EXPECT_KEY = 'e2e_persist_expect';

  function text(sel) {
    var node = document.querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function phase() {
    var m = /[?&]phase=([a-z]+)/.exec(global.location.search);
    return m ? m[1] : 'seed';
  }

  function itemByCode(items, code) {
    return items.filter(function (i) { return i.code === code; })[0];
  }

  async function snapshotCounts() {
    var names = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions'];
    var out = {};
    for (var i = 0; i < names.length; i += 1) {
      out[names[i]] = (await DB.getAll(names[i])).length;
    }
    return out;
  }

  async function loadExpect() {
    var raw = await DB.getSetting(EXPECT_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  /* ================= 第 1 步：造数据 ================= */

  async function runSeed() {
    await E2E.resetDb();
    await Rules.initCategories();

    await Ops.inbound({
      categoryId: 'mechanical', name: '步进电机', spec: '42BYGH', quantity: 5,
      identityMode: 'shared', operator: '李四', safetyStock: 2, location: 'A区货架'
    });
    await Ops.inbound({
      categoryId: 'vision', name: '工业相机', quantity: 1,
      identityMode: 'single', operator: '李四', extra: { resolution: '500万像素' }
    });
    await Ops.inbound({
      categoryId: 'hardware', name: '内六角扳手', quantity: 3,
      identityMode: 'shared', operator: '李四', extra: { isTool: '是' }
    });
    // 借出 2 件（还剩 3 件在库）：用来验证"部分借出"的账在重启后依然准确
    await Ops.lend({
      code: 'MC-0001', qty: 2, operator: '李四', borrower: '张三',
      dueDate: '2030-01-01', purpose: '装配用'
    });

    var reqId = await DB.add('purchaseRequests', {
      categoryId: 'electronic', name: '电调', spec: '40A', quantity: 2, budget: 600,
      purpose: '备用', applicant: '王五', status: 'arrived',
      createdAt: DB.nowIso(), updatedAt: DB.nowIso()
    });
    await DB.add('invoices', {
      purchaseRequestId: reqId, invoiceNo: 'FP-2026-001', amount: 580,
      supplier: '某供应商', invoiceDate: '2026-09-21', createdAt: DB.nowIso()
    });
    await DB.setSetting('lastBackupAt', DB.nowIso());

    var counts = await snapshotCounts();
    var codes = (await DB.getAll('items')).map(function (i) { return i.code; }).sort();
    await DB.setSetting(EXPECT_KEY, JSON.stringify({
      counts: counts, codes: codes, at: DB.nowIso()
    }));

    await E2E.record('第 1 步：造好一整套数据并记下应有的条数', function () {
      E2E.ok(counts.items === 3, '应有 3 件物品，实际 ' + counts.items);
      E2E.ok(counts.categories === 4, '应有 4 个大类，实际 ' + counts.categories);
      E2E.ok(counts.purchaseRequests === 1, '应有 1 条采购申请');
      E2E.ok(counts.invoices === 1, '应有 1 张发票');
      E2E.ok(counts.transactions >= 4, '流水应有入库与借出记录，实际 ' + counts.transactions);
      E2E.ok(codes.join(',') === 'HW-0001,MC-0001,VS-0001',
        '编码应分别从各类的 0001 开始，实际 ' + codes.join(','));
    });

    E2E.finish();
  }

  /* ================= 第 2/3 步：核对数据还在 ================= */

  async function runVerify() {
    // 先自己刷新一次，模拟使用者按 F5（对照 AC-02）。
    // 用 sessionStorage 做标记，保证只刷新一次，不会转圈。
    if (!global.sessionStorage.getItem('e2e-reloaded')) {
      global.sessionStorage.setItem('e2e-reloaded', '1');
      global.location.reload();
      return;
    }

    var expect = await loadExpect();

    await E2E.record('刷新之后，第 1 步记下的期望值还在（说明数据没被清掉）', function () {
      E2E.ok(expect, '应能读回期望值。如果这条失败，说明数据在刷新/重启后丢了');
    });
    if (!expect) { E2E.finish(); return; }

    await E2E.record('全部数据在刷新与重启后原样还在（对照 AC-02 / AC-03 / AC-04）', async function () {
      var now = await snapshotCounts();
      Object.keys(expect.counts).forEach(function (name) {
        E2E.ok(now[name] === expect.counts[name],
          name + ' 重启后应为 ' + expect.counts[name] + ' 条，实际 ' + now[name] + ' 条');
      });
    });

    await E2E.record('物品内容、编码与库存数字完整无缺', async function () {
      var items = await DB.getAll('items');
      var codes = items.map(function (i) { return i.code; }).sort();
      E2E.ok(codes.join(',') === expect.codes.join(','),
        '物品编码应完全一致，期望 ' + expect.codes.join(',') + '，实际 ' + codes.join(','));

      var motor = itemByCode(items, 'MC-0001');
      E2E.ok(motor, '应有 MC-0001');
      E2E.ok(motor.name === '步进电机', '名称应完整保留');
      E2E.ok(motor.spec === '42BYGH', '规格应完整保留');
      E2E.ok(motor.location === 'A区货架', '存放位置应完整保留');
      E2E.ok(motor.safetyStock === 2, '安全库存应完整保留');
      E2E.ok(motor.totalQty === 5 && motor.inStockQty === 3 && motor.lentQty === 2,
        '库存数字应完整（总 5、在库 3、借出 2），实际总 ' + motor.totalQty +
        ' 在库 ' + motor.inStockQty + ' 借出 ' + motor.lentQty);
      // 主状态是派生的：只要还有在库的，主状态就是「在库」，借出件数单独看
      E2E.ok(motor.status === 'in_stock', '主状态应为在库，实际 ' + motor.status);

      var cam = itemByCode(items, 'VS-0001');
      E2E.ok(cam.identityMode === 'single', '单独建身份的模式应保留');
      E2E.ok(cam.extra && cam.extra.resolution === '500万像素', '大类专属字段应保留');
    });

    await E2E.record('借用台账在重启后仍能查到借用人（对照 AC-19）', async function () {
      var ledger = await Ops.lendLedger();
      E2E.ok(ledger.length === 1, '应有 1 条在借，实际 ' + ledger.length);
      E2E.ok(ledger[0].itemCode === 'MC-0001', '应是 MC-0001');
      E2E.ok(ledger[0].borrower === '张三', '借用人应是张三，实际 ' + ledger[0].borrower);
      E2E.ok(ledger[0].qty === 2, '借出数量应是 2，实际 ' + ledger[0].qty);
      E2E.ok(ledger[0].dueDate === '2030-01-01', '预计归还日期应保留');
    });

    await E2E.record('采购申请与发票的关联在重启后仍然成立（对照 AC-15）', async function () {
      var reqs = await DB.getAll('purchaseRequests');
      var invs = await DB.getAll('invoices');
      E2E.ok(reqs.length === 1 && invs.length === 1, '应各有 1 条');
      E2E.ok(invs[0].purchaseRequestId === reqs[0].id, '发票应仍指向那条申请');
      E2E.ok(invs[0].invoiceNo === 'FP-2026-001', '发票号应保留');

      var rel = await Stats.requestOfInvoice(invs[0]);
      E2E.ok(rel && rel.request, '应能顺着发票查回申请');
      E2E.ok(rel.request.name === '电调', '查回的申请应是电调');
    });

    await E2E.record('流水在重启后完整可查（对照 AC-25）', async function () {
      var txns = await Stats.filterTransactions({});
      var types = txns.map(function (t) { return t.type; });
      E2E.ok(types.indexOf('inbound') !== -1, '应有入库流水');
      E2E.ok(types.indexOf('lend') !== -1, '应有借出流水');
      E2E.ok(types.filter(function (t) { return t === 'inbound'; }).length === 3,
        '应有 3 条入库流水（3 件物品），实际 ' + types.length + ' 条流水');
      E2E.ok(txns.every(function (t) { return !!t.itemCode; }), '每条流水都应带物品编码');
    });

    await E2E.record('页面能正常渲染出重启后的数据（不是空白页）', async function () {
      global.FEVER.App.goto('home');
      await E2E.waitUntil('首页渲染', function () {
        return document.querySelectorAll('.cat-card').length === 4;
      });
      var body = text('#view-root');
      E2E.ok(body.indexOf('物资总览') !== -1, '首页应正常渲染');
      await E2E.waitUntilAsync('首页数字反映真实数据', async function () {
        var cards = Array.prototype.slice.call(document.querySelectorAll('.cat-card'));
        var mech = cards.filter(function (c) {
          return c.querySelector('.cat-name').textContent.trim() === '机械';
        })[0];
        if (!mech) return false;
        var metrics = {};
        Array.prototype.slice.call(mech.querySelectorAll('.metric')).forEach(function (m) {
          metrics[m.querySelector('.metric-label').textContent.trim()] =
            m.querySelector('.metric-value').textContent.trim();
        });
        // 机械：5 件里借出 2 件，所以卡片上在库是 3
        return metrics['在库件数'] === '3';
      });
    });

    E2E.finish();
  }

  /* ================= 第 4 步：重启后继续入账 ================= */

  async function runAfter() {
    await E2E.record('重启后再入库，编码接着往下排、不复用（对照 AC-09）', async function () {
      var before = await loadExpect();
      E2E.ok(before, '应能读回第 1 步的期望值');

      await Ops.inbound({
        categoryId: 'mechanical', name: '重启后新增件', quantity: 1,
        identityMode: 'single', operator: '李四'
      });
      var item = itemByCode(await DB.getAll('items'), 'MC-0002');
      E2E.ok(item, '新增的机械件应是 MC-0002');
      E2E.ok(item.name === '重启后新增件', '名称应正确');

      var now = await snapshotCounts();
      E2E.ok(now.items === before.counts.items + 1,
        '物品应比过去多 1 条，期望 ' + (before.counts.items + 1) + '，实际 ' + now.items);
      E2E.ok(now.transactions === before.counts.transactions + 1,
        '应多出 1 条入库流水，期望 ' + (before.counts.transactions + 1) + '，实际 ' + now.transactions);
      // 别的表不该受影响
      E2E.ok(now.invoices === before.counts.invoices, '发票条数不该变');
      E2E.ok(now.purchaseRequests === before.counts.purchaseRequests, '采购申请条数不该变');
    });

    await E2E.record('重启后新入库的编码不与历史编码冲突', async function () {
      var codes = (await DB.getAll('items')).map(function (i) { return i.code; });
      E2E.ok(new Set(codes).size === codes.length, '编码不该有重复，实际 ' + codes.sort().join(','));
      E2E.ok(codes.indexOf('MC-0002') !== -1, '应有 MC-0002');
    });

    E2E.finish();
  }

  var runners = { seed: runSeed, verify: runVerify, after: runAfter };
  (runners[phase()] || runSeed)().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
