/**
 * 飞书共享版「写入体验」浏览器端到端测试的用例。
 *
 * 要盯住的核心是使用者抱怨的那件事：
 *   点「提交申请 / 确认收货 / 出入库」的确认按钮时，界面到底等了多久。
 *
 * 所以这里用一个「慢后端」把飞书的真实耗时模拟出来，然后断言：
 *   · 按钮相关的调用**立刻**返回（远早于后端写完）
 *   · 一次动作只发**一个**写请求（旧版「先占编码再落库」会发两个）
 *   · 后台确实把它写进去了，并且角标如实显示「已同步」
 *   · 写失败时不装成功：角标变红、弹出错误、镜像被拉回服务器真实数据
 */
(function () {
  'use strict';

  var out = [];
  var passed = 0;
  var failed = 0;

  function log(line) { out.push(line); }
  function flush() {
    document.getElementById('e2e-out').textContent = out.join('\n');
  }
  function check(label, ok, detail) {
    if (ok) { passed += 1; out.push('  ✓ ' + label); }
    else { failed += 1; out.push('  ✗ ' + label + (detail === undefined ? '' : '  → ' + detail)); }
  }
  function done() {
    if (window.__EARLY_ERRORS__ && window.__EARLY_ERRORS__.length) {
      out.push('');
      out.push('加载期错误：');
      window.__EARLY_ERRORS__.forEach(function (e) { out.push('  ' + e); });
      failed += window.__EARLY_ERRORS__.length;
    }
    out.push('');
    out.push('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    flush();
    // 把"闸门"换成 data URL，页面 load 才会结束，--dump-dom 才会吐出来
    var gate = document.getElementById('e2e-gate');
    if (gate) gate.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  }

  function sleep(ms) { return new Promise(function (r) { window.setTimeout(r, ms); }); }
  function pillNode() { return document.getElementById('fever-sync-pill'); }
  function pillText() { var n = pillNode(); return n ? n.textContent : '(没有角标)'; }
  function pillShown() { var n = pillNode(); return !!(n && n.style.display !== 'none'); }
  function toastText() { return document.getElementById('toast-root').textContent; }

  var DB = window.FEVER.DB;
  var Rules = window.FEVER.Rules;
  var Ops = window.FEVER.Ops;
  var fake = window.__FAKE__;

  /** 等所有改动落定（写成功或失败、失败后重拉数据也算），再多给一点时间让界面画完 */
  function waitSettled() {
    return DB.whenSettled().then(function () { return sleep(80); });
  }

  function main() {
    log('飞书共享版 · 写入体验端到端测试');
    log('假后端每次写入耗时：' + fake.writeDelayMs + ' ms（模拟飞书多维表格的真实速度）');
    log('');

    return Promise.resolve().then(function () {
      log('[1] 打开数据库 + 初始化大类');
      return DB.openDB().then(function () {
        return Rules.initCategories();
      }).then(function (cats) {
        check('四个大类就绪', cats.length === 4, cats.length);
        return waitSettled();
      });
    }).then(function () {
      log('');
      log('[2] 入库：界面不再等飞书');
      var before = fake.writes.length;
      var t0 = window.performance.now();
      return Ops.inbound({
        categoryId: 'mechanical', name: '测试螺丝', quantity: 5,
        troop: '其他', identityMode: 'shared', operator: '张三'
      }).then(function (res) {
        var cost = Math.round(window.performance.now() - t0);
        check('入库 ' + cost + 'ms 就返回了（假后端要 ' + fake.writeDelayMs + 'ms 才写完）',
          cost < fake.writeDelayMs / 2, cost + 'ms');
        check('返回时编码已经生成', res.codes[0] === 'MC-0001', res.codes[0]);
        return DB.get('items', 'MC-0001').then(function (item) {
          check('返回时界面上已经有这件物品（在库 5）', item && item.inStockQty === 5,
            item ? item.inStockQty : 'null');
          check('这时角标显示在同步：「' + pillText() + '」', /同步中/.test(pillText()), pillText());
          check('这时服务器上其实还没有', fake.data.items.length === 0, fake.data.items.length);
          return waitSettled();
        }).then(function () {
          check('落定后服务器上确实有了', fake.data.items.length === 1, fake.data.items.length);
          check('角标变成「已同步」：「' + pillText() + '」', /已同步/.test(pillText()), pillText());
          var delta = fake.writes.length - before;
          check('这一步只发了 1 个写请求（旧版是 2 个：先占编码、再落库）', delta === 1, delta);
        });
      });
    }).then(function () {
      log('');
      log('[3] 出入库（借出）：一次点击一个请求，且立刻返回');
      var before = fake.writes.length;
      var t0 = window.performance.now();
      return Ops.lend({
        code: 'MC-0001', qty: 2, operator: '李四', borrower: '王五', dueDate: '2026-10-01'
      }).then(function () {
        var cost = Math.round(window.performance.now() - t0);
        check('借出 ' + cost + 'ms 就返回了', cost < fake.writeDelayMs / 2, cost + 'ms');
        return waitSettled();
      }).then(function () {
        var delta = fake.writes.length - before;
        check('只发了 1 个写请求', delta === 1, delta);
        return DB.get('items', 'MC-0001').then(function (item) {
          check('服务器上的数量与界面一致（在库都是 3）',
            fake.data.items[0].inStockQty === 3 && item.inStockQty === 3,
            JSON.stringify([fake.data.items[0].inStockQty, item.inStockQty]));
        });
      });
    }).then(function () {
      log('');
      log('[4] 确认收货：发票 + 物品 + 流水 + 申请四张表一起写');
      return DB.add('purchaseRequests', {
        categoryId: 'electronic', name: '电调', spec: '60A', quantity: 3,
        budget: '600', applicant: '赵六', purpose: '备件', status: 'ordered',
        createdAt: DB.nowIso(), updatedAt: DB.nowIso()
      }).then(function (reqId) {
        return waitSettled().then(function () { return reqId; });
      }).then(function (reqId) {
        var before = fake.writes.length;
        var t0 = window.performance.now();
        return Ops.arrive({
          requestId: reqId, quantity: 3, invoiceNo: 'INV-001', supplier: '某供应商',
          amount: 560, operator: '张三', identityMode: 'shared'
        }).then(function () {
          var cost = Math.round(window.performance.now() - t0);
          check('确认收货 ' + cost + 'ms 就返回了', cost < fake.writeDelayMs / 2, cost + 'ms');
          return waitSettled();
        }).then(function () {
          var delta = fake.writes.length - before;
          check('只发了 1 个写请求（旧版是 2 个）', delta === 1, delta);
          check('发票、物品、申请都落库了',
            fake.data.invoices.length === 1 && fake.data.items.length === 2 &&
            fake.data.purchaseRequests[0] &&
            fake.data.purchaseRequests[0].status === 'arrived',
            JSON.stringify([fake.data.invoices.length, fake.data.items.length,
              fake.data.purchaseRequests[0] && fake.data.purchaseRequests[0].status]));
        });
      });
    }).then(function () {
      log('');
      log('[5] 写失败时：不装成功，如实报错并把界面拉回服务器的真实数据');
      fake.failNextWrites = 1;
      var stockBefore = null;
      return DB.get('items', 'MC-0001').then(function (item) {
        stockBefore = item.inStockQty;
        return Ops.consume({ code: 'MC-0001', qty: 1, operator: '张三' });
      }).then(function () {
        return DB.get('items', 'MC-0001').then(function (item) {
          check('界面先按成功更新了（本地镜像已减到 ' + item.inStockQty + '）',
            item.inStockQty === stockBefore - 1, item.inStockQty);
        });
      }).then(waitSettled).then(function () {
        check('角标变红并写明失败：「' + pillText() + '」', /同步失败/.test(pillText()), pillText());
        check('弹出了「保存失败」提示', /保存失败/.test(toastText()), toastText().slice(0, 60));
        return DB.get('items', 'MC-0001').then(function (item) {
          check('镜像已经拉回服务器真实数据（领用没生效，仍是在库 ' + stockBefore + '）',
            item.inStockQty === stockBefore, item.inStockQty);
          check('界面与服务器完全一致',
            fake.data.items[0].inStockQty === item.inStockQty,
            JSON.stringify([fake.data.items[0].inStockQty, item.inStockQty]));
        });
      }).then(function () {
        var pill = pillNode();
        if (pill) pill.click();
        // 角标是「先淡出再隐藏」，给它 400ms 淡出 + 220ms 收起
        return sleep(800);
      }).then(function () {
        check('点一下红色角标可以关掉（现在：' + pillText() + '，显示=' + pillShown() + '）',
          !pillShown(), pillText());
        check('服务端没有多出脏数据（物品表仍是 2 条）', fake.data.items.length === 2, fake.data.items.length);
      });
    }).then(function () {
      log('');
      log('[6] 重新同步后恢复正常');
      var t0 = window.performance.now();
      return Ops.consume({ code: 'MC-0001', qty: 1, operator: '张三' }).then(function () {
        return waitSettled();
      }).then(function () {
        check('失败之后还能正常写入（' + Math.round(window.performance.now() - t0) + 'ms 内完成）',
          fake.data.items[0].inStockQty === 2, fake.data.items[0].inStockQty);
        check('角标回到「已同步」：「' + pillText() + '」', /已同步/.test(pillText()), pillText());
      });
    });
  }

  main().then(done, function (err) {
    out.push('');
    out.push('测试崩了：' + (err && err.stack ? err.stack : err));
    failed += 1;
    done();
  });
})();
