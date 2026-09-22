/**
 * M10 扫码查物（第二版手机端）。
 *
 * 用户要的是"扫一下，确认物品状态：在库、借出、在什么位置"。
 * 所以这一组盯的不是"页面上有没有扫到二维码四个字"，而是这几件事：
 *
 *   · 入口页 → 结果页是真的换过去了（走地址栏，不是内存里传个变量），
 *     刷新或者把链接发给队友还能回到同一件东西上；
 *   · 结果页上的「状态 / 存放位置 / 借给谁了」和电脑端物品详情页读到的是**同一份数据** ——
 *     两页都走 Stats.itemContext + Ops.lendLedger。这是"手机版和电脑版数据保持一致"
 *     真正能被验证的地方：哪天有人给手机端另写一套算法，这条会红。
 *   · 扫到的不是本系统的码、或者系统里根本没这件，都要说清楚，而且**不能崩**；
 *   · 扫完能就地登记借用，登记完电脑端的数量、台账、流水同时跟上；
 *   · 结果页不写死任何一件东西 —— 换个编码，内容跟着换。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var DB = global.FEVER.DB;
  var Ops = global.FEVER.Ops;
  var Stats = global.FEVER.Stats;
  var Rules = global.FEVER.Rules;
  var Scanner = global.FEVER.Scanner;

  function root() { return document.getElementById('view-root'); }
  function pageName() { return root() ? String(root().getAttribute('data-page') || '') : ''; }
  function text(sel) {
    var node = sel ? document.querySelector(sel) : root();
    return node ? String(node.textContent).replace(/\s+/g, ' ').trim() : '';
  }
  function q(sel) { return root().querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(root().querySelectorAll(sel)); }

  function fillIn(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"]');
    E2E.ok(node, '弹窗里应有字段 ' + name);
    E2E.setInput(node, value);
  }
  function waitModal() { return E2E.waitUntil('弹窗打开', function () { return E2E.topModal(); }); }
  function waitModalGone() { return E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); }); }

  /** 等结果卡真的画出来：它要读库才画得出来，切页完成 ≠ 卡片就位 */
  function waitResult() {
    return E2E.waitUntil('扫码结果卡画出来', function () {
      return pageName() === 'scan' && !!q('.scan-result');
    }, 10000);
  }
  /** 等页面上出现某句提示（"没有找到"这类） */
  function waitHint(marker) {
    return E2E.waitUntil('看到「' + marker + '」', function () {
      return pageName() === 'scan' && text('#view-root').indexOf(marker) !== -1;
    }, 10000);
  }

  /** 按字段名取表格里的值（扫码结果页与物品详情页的字段表结构一致） */
  function gridField(label) {
    var rows = qa('#view-root table.grid tbody tr');
    for (var i = 0; i < rows.length; i += 1) {
      var th = rows[i].querySelector('th');
      if (th && th.textContent.trim() === label) {
        var td = rows[i].querySelector('td');
        return td ? td.textContent.replace(/\s+/g, ' ').trim() : null;
      }
    }
    return null;
  }
  /**
   * 这一页上"存放位置"显示的是什么。
   * 扫码结果页把它单独放大成一块（.scan-loc-value），详情页放在字段表里 ——
   * 两种呈现读的都是同一个 item.location，这里负责把两种写法取成同一个字符串。
   */
  function locationOnPage() {
    var big = q('.scan-loc-value');
    if (big) return big.textContent.trim();
    return gridField('存放位置');
  }
  function actionLabels() {
    return qa('[data-scan-act]').map(function (b) { return b.textContent.trim(); });
  }
  /** 在入口页手工输入编码并查询 */
  function lookupByInput(raw) {
    E2E.ok(q('#scan-code'), '扫码页应当有手工输入框');
    E2E.setInput(q('#scan-code'), raw);
    E2E.click(q('#scan-lookup'));
  }

  /** 假扫码器的调用次数，登记到外面，方便在用例里断言"该被调/不该被调" */
  var fakeCalls = { n: 0 };

  /** 造一个"假的扫码器"：无头浏览器里开不了真摄像头，用它把整条链路跑通 */
  function registerFakeScanner(available, text) {
    Scanner.register({
      name: 'e2e-fake', label: '测试用扫码器', priority: 900,
      available: function () { return available; },
      scan: function () {
        fakeCalls.n += 1;
        return Promise.resolve(text);
      }
    });
  }

  async function run() {
    await E2E.resetDb();
    await Rules.initCategories();

    // 一件同款共用件：放在 A-3 货架，先入库 4 件，再借给两个人
    // —— 这正是"借给谁了"要回答的问题，也是台账最容易出错的地方
    var sharedCode = (await Ops.inbound({
      categoryId: 'mechanical', name: 'M4 螺丝盒', quantity: 4,
      identityMode: 'shared', operator: '张三', location: 'A-3 货架第二层'
    })).codes[0];
    await Ops.lend({ code: sharedCode, qty: 2, operator: '张三', borrower: '李四', dueDate: '2026-12-31' });
    await Ops.lend({ code: sharedCode, qty: 1, operator: '张三', borrower: '王五', dueDate: '2026-10-15' });

    // 一件单独建身份的：留给"扫码后就地借用"那条用例
    var singleCode = (await Ops.inbound({
      categoryId: 'hardware', name: '电动螺丝刀', quantity: 1,
      identityMode: 'single', operator: '张三', location: '工具墙 2 号位'
    })).codes[0];

    // 一件已经领用完的：用来验"用完的东西扫码要提醒补货"
    var usedUpCode = (await Ops.inbound({
      categoryId: 'mechanical', name: '扎带', quantity: 1,
      identityMode: 'shared', operator: '张三', location: '耗材柜'
    })).codes[0];
    await Ops.consume({ code: usedUpCode, qty: 1, operator: '张三' });

    /* ================= 入口页 ================= */

    await E2E.record('导航里能找到「扫码查物」，入口页同时给出"扫"和"手工输入"两条路', async function () {
      await E2E.goto('scan');
      var keys = Array.prototype.map.call(
        document.querySelectorAll('#main-nav .nav-item'),
        function (b) { return b.getAttribute('data-goto'); }
      );
      E2E.ok(keys.indexOf('scan') !== -1, '导航里应有扫码查物入口，实际：' + keys.join('、'));
      E2E.ok(q('#scan-start'), '应有「开始扫码」按钮');
      E2E.ok(q('#scan-code') && q('#scan-lookup'), '应能手工输入编码查询（开不了摄像头时的退路）');
      E2E.ok(!q('.scan-result'), '还没扫之前不该有结果卡');
    });

    await E2E.record('「拍照 / 选图」要有直达按钮：最稳的那条兜底路不能只靠自动降级', async function () {
      await E2E.goto('scan');
      var btn = q('#scan-photo');
      E2E.ok(btn, '有本机解码库时应当给「拍照 / 选图」按钮 —— 飞书里前几条路失败后，' +
        '异步链末端才弹出来的选择器常被手机系统吃掉，必须留一个亲手点的入口');
      E2E.ok(/拍照|选图/.test(btn.textContent),
        '按钮文字要说清是做什么的，实际「' + (btn ? btn.textContent : '') + '」');
      // 离线版没有飞书鉴权模块，这一行不该出现
      var diag = q('#scan-diag');
      E2E.ok(!diag || diag.hidden, '不在飞书客户端里时不该显示飞书鉴权那一行');
    });

    await E2E.record('扫到不是本系统的二维码：说清楚，留在原页，并把扫到的原文显示出来', async function () {
      await E2E.goto('scan');
      lookupByInput('https://example.com/some-page');
      await waitHint('不是本系统的标签');
      E2E.ok(text('#view-root').indexOf('https://example.com/some-page') !== -1,
        '要把扫到的原始内容显示出来，否则使用者不知道扫到了什么');
      E2E.ok(pageName() === 'scan', '解析失败时不该跳到别的页');
      E2E.ok(!q('.scan-result'), '解析失败时不该画出结果卡');
      E2E.ok(global.location.hash === '#scan', '解析失败不该改地址栏，实际 ' + global.location.hash);
    });

    await E2E.record('系统里没有这个编码：提示"没有找到"，而不是画一张空结果卡', async function () {
      await E2E.goto('scan', { code: 'ZZ-9999' });
      await waitHint('没有找到');
      E2E.ok(text('#view-root').indexOf('ZZ-9999') !== -1, '提示里要带上那个查不到的编码');
      E2E.ok(!q('.scan-result'), '查不到就不该画结果卡');
    });

    /* ================= 结果页：状态 / 位置 / 借给谁 ================= */

    await E2E.record('手工输入编码 → 跳到结果页，状态、存放位置、数量都对', async function () {
      await E2E.goto('scan');
      lookupByInput(sharedCode);
      await waitResult();

      var ctx = await Stats.itemContext(sharedCode);
      var name = q('.scan-name').textContent.trim();
      E2E.ok(name === 'M4 螺丝盒', '结果卡上应显示物品名称，实际「' + name + '」');
      E2E.ok(locationOnPage() === 'A-3 货架第二层',
        '存放位置应是「A-3 货架第二层」，实际「' + locationOnPage() + '」');
      E2E.ok(text('.scan-status').indexOf(Rules.STATUS_NAMES[ctx.item.status]) !== -1,
        '结果卡上应显示物品状态，实际「' + text('.scan-status') + '」');
      E2E.ok(text('.scan-result').indexOf('总数 4') !== -1,
        '应写明总数量，实际「' + text('.scan-result') + '」');
      E2E.ok(text('.scan-result').indexOf('在库 1') !== -1 && text('.scan-result').indexOf('借出 3') !== -1,
        '数量明细要写清楚（在库 1 / 借出 3），实际「' + text('.scan-result') + '」');
      E2E.ok(global.location.hash === '#scan/' + sharedCode,
        '地址栏应记下扫到的是哪一件，实际 ' + global.location.hash);
    });

    await E2E.record('借出去的件：扫码一眼看出借给谁、借了几件、什么时候该还（两个人都在）', async function () {
      await E2E.goto('scan', { code: sharedCode });
      await waitResult();

      var block = text('.scan-lent');
      E2E.ok(block.indexOf('借出中（3 件）') !== -1,
        '借出件数应以物品上的借出数为准（3 件），实际「' + block + '」');
      E2E.ok(block.indexOf('李四') !== -1, '借用人李四应当在借出明细里，实际「' + block + '」');
      E2E.ok(block.indexOf('王五') !== -1,
        '借用人王五也应当在明细里 —— 同一件东西借给两个人，两个人都要看得见，实际「' + block + '」');
      E2E.ok(block.indexOf('2026-12-31') !== -1 && block.indexOf('2026-10-15') !== -1,
        '两个人的应还日期都要在，实际「' + block + '」');

      // 台账明细与物品上的数字不能各说各话
      var ctx = await Stats.itemContext(sharedCode);
      var ledger = await Ops.lendLedger();
      var live = ledger.filter(function (r) { return r.itemCode === sharedCode; });
      var rows = qa('.scan-lent-row');
      E2E.ok(rows.length === live.length,
        '结果页列出的借出行数（' + rows.length + '）应与台账一致（' + live.length + '）');
      E2E.ok(live.reduce(function (s, r) { return s + r.qty; }, 0) === ctx.item.lentQty,
        '台账未还件数之和应等于物品上的借出件数，否则页面上会出现自相矛盾的数字');
    });

    await E2E.record('已经领用完的件：扫码会提醒需要补货，且不给用得上的动作按钮', async function () {
      await E2E.goto('scan', { code: usedUpCode });
      await waitResult();
      E2E.ok(text('.scan-result').indexOf('需要补货') !== -1,
        '在库/借出/待修都是 0 时应提醒补货，实际「' + text('.scan-result') + '」');
      E2E.ok(actionLabels().length === 0,
        '没料可借、也没人在借，就不该给点了会白点的按钮，实际：' + actionLabels().join('、'));
      E2E.ok(q('[data-goto-item]'), '「完整详情」应始终可用');
    });

    /* ================= 数据一致：扫码页 / 详情页 / 数据层 ================= */

    await E2E.record('数据一致：扫码结果页、电脑端物品详情页、数据层三处读到的是同一份', async function () {
      var ctx = await Stats.itemContext(sharedCode);

      await E2E.goto('scan', { code: sharedCode });
      await waitResult();
      var scanLoc = locationOnPage();
      var scanStatus = text('.scan-status');
      var scanQty = text('.scan-result');

      // 电脑端那一页：同一个编码、同一份数据
      await E2E.goto('item', { code: sharedCode });
      await E2E.waitUntil('详情页画出来', function () { return !!gridField('存放位置'); }, 10000);
      var detailLoc = locationOnPage();

      E2E.ok(scanLoc === ctx.item.location,
        '扫码页的位置应直接来自 Stats.itemContext（期望「' + ctx.item.location + '」，实际「' + scanLoc + '」）');
      E2E.ok(detailLoc === ctx.item.location,
        '详情页的位置也应来自同一份数据（期望「' + ctx.item.location + '」，实际「' + detailLoc + '」）');
      E2E.ok(scanLoc === detailLoc,
        '两端显示的位置必须一致：扫码页「' + scanLoc + '」vs 详情页「' + detailLoc + '」');
      E2E.ok(scanStatus.indexOf(Rules.STATUS_NAMES[ctx.item.status]) !== -1,
        '扫码页的状态应与数据层一致（期望「' + Rules.STATUS_NAMES[ctx.item.status] + '」，实际「' + scanStatus + '」）');
      E2E.ok(scanQty.indexOf('在库 ' + ctx.item.inStockQty) !== -1 &&
             scanQty.indexOf('借出 ' + ctx.item.lentQty) !== -1,
        '扫码页的数量明细应与数据层一致（在库 ' + ctx.item.inStockQty + ' / 借出 ' + ctx.item.lentQty +
        '），实际「' + scanQty + '」');
    });

    await E2E.record('结果页不写死任何一件物品：换个编码，内容跟着换', async function () {
      await E2E.goto('scan', { code: singleCode });
      await waitResult();
      var name = q('.scan-name').textContent.trim();
      E2E.ok(name === '电动螺丝刀', '换编码后名称应跟着换，实际「' + name + '」');
      E2E.ok(locationOnPage() === '工具墙 2 号位', '位置也跟着换，实际「' + locationOnPage() + '」');
    });

    /* ================= 整条链路：点「开始扫码」 ================= */

    await E2E.record('点「开始扫码」走完整链路：扫到的文本 → 解析 → 落到那件物品的结果页', async function () {
      fakeCalls.n = 0;
      registerFakeScanner(true, Rules.qrPayload(sharedCode));

      await E2E.goto('scan');
      E2E.ok(q('#scan-start'), '注册了可用扫码来源之后应当有「开始扫码」按钮');
      E2E.ok(text('#scan-hint').indexOf('测试用扫码器') !== -1,
        '页面上应列出可用的扫码方式，实际「' + text('#scan-hint') + '」');

      E2E.click(q('#scan-start'));
      await waitResult();
      E2E.ok(fakeCalls.n === 1, '扫码来源应当正好被调用一次，实际 ' + fakeCalls.n + ' 次');
      E2E.ok(q('.scan-name').textContent.trim() === 'M4 螺丝盒', '扫码结果应落到扫到的那件物品上');
      E2E.ok(global.location.hash === '#scan/' + sharedCode, '地址栏也应跟上，实际 ' + global.location.hash);
    });

    /* ================= 拍照识别：没有自带识别能力时的兜底 ================= */

    function sourceNamed(name) {
      var list = (Scanner.available ? Scanner.available() : []).filter(function (s) {
        return s.name === name;
      });
      return list[0] || null;
    }

    function waitNode(sel, label, timeout) {
      return new Promise(function (resolve, reject) {
        var t0 = Date.now();
        (function step() {
          var node = document.querySelector(sel);
          if (node) return resolve(node);
          if (Date.now() - t0 > (timeout || 8000)) return reject(new Error('等不到' + label));
          global.setTimeout(step, 50);
        })();
      });
    }

    function waitText(sel, marker, label, timeout) {
      return new Promise(function (resolve, reject) {
        var t0 = Date.now();
        (function step() {
          var node = document.querySelector(sel);
          if (node && String(node.textContent || '').indexOf(marker) !== -1) return resolve(node);
          if (Date.now() - t0 > (timeout || 8000)) return reject(new Error('等不到' + label));
          global.setTimeout(step, 50);
        })();
      });
    }

    /** 无头浏览器点不出系统文件选择器，只能直接把图塞给 input —— 等价于队员选好了照片 */
    async function feedPhoto(url) {
      var input = await waitNode('.scan-overlay .scan-file', '拍照遮罩里的文件选择框');
      var blob = await (await fetch(url)).blob();
      var file = new File([blob], 'label.png', { type: blob.type || 'image/png' });
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    }

    /** 给某个 Promise 加个钟：解码要是卡住，用例要红，不能一直挂着 */
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise(function (resolve) {
          global.setTimeout(function () { resolve('__TIMEOUT__'); }, ms || 15000);
        })
      ]);
    }

    function blankDataUrl() {
      var c = document.createElement('canvas');
      c.width = 160; c.height = 160;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 160, 160);
      return c.toDataURL('image/png');
    }

    await E2E.record('手机浏览器没有自带识别能力时，拍照识别这条兜底要站得住', async function () {
      // iPhone 上就是这种情况：没有 BarcodeDetector，摄像头实时识别那条路走不通，
      // 之前"开始扫码点了没反应"正是因为它被判成不可用。有 jsQR 就必须有兜底。
      E2E.ok(typeof global.jsQR === 'function', '测试页应加载本机解码库 jsQR');
      var names = (Scanner.available() || []).map(function (s) { return s.name; });
      E2E.ok(names.indexOf('photo') !== -1,
        '可用来源里应有「拍照识别」，实际：' + names.join('、'));
    });

    await E2E.record('拍一张标签照片也认得出编码，并落到那件物品上', async function () {
      await E2E.goto('scan');
      var src = sourceNamed('photo');
      E2E.ok(src, '应有拍照识别来源');
      // autoPick:false —— 无头浏览器点不出系统文件选择器，选图这一步由下面直接喂图代替
      var pending = withTimeout(src.scan({ autoPick: false }).catch(function () { return null; }));
      await feedPhoto(global.FEVER.QR.dataUrl(Rules.qrPayload(sharedCode)).url);
      var scanned = await pending;
      E2E.ok(scanned === Rules.qrPayload(sharedCode),
        '解出来的应当是标签原文「' + Rules.qrPayload(sharedCode) + '」，实际「' + scanned + '」');
      E2E.ok(Rules.parseQrPayload(scanned) === sharedCode, '解出的文本应解析回编码');

      await E2E.goto('scan', { code: sharedCode });
      await waitResult();
      E2E.ok(q('.scan-name').textContent.trim() === 'M4 螺丝盒',
        '拍照识别的结果应落到那件物品上，实际「' + q('.scan-name').textContent.trim() + '」');
    });

    await E2E.record('照片里没有二维码时给一句人话，而不是什么都不说', async function () {
      await E2E.goto('scan');
      E2E.ok(!q('.scan-result'), '用例开始时应当在扫码入口页（不是某件物品的结果页）');
      var src = sourceNamed('photo');
      E2E.ok(src, '应有拍照识别来源');
      var pending = withTimeout(src.scan({ autoPick: false }).catch(function () { return '__REJECTED__'; }));
      await feedPhoto(blankDataUrl());
      await waitText('.scan-overlay .scan-hint', '没认出二维码', '「没认出二维码」的提示');
      E2E.ok(!q('.scan-result'), '认不出就不该跳页');

      E2E.click(document.querySelector('.scan-overlay .scan-cancel'));
      await pending;
      E2E.ok(!document.querySelector('.scan-overlay'), '点了取消，遮罩要收掉');
      E2E.ok(pageName() === 'scan', '取消之后还留在扫码页');
    });

    await E2E.record('扫码失败时会说一声到底为什么，而不是静默什么都不发生', async function () {
      // 把上一个用例的假扫码器改成"不可用"，再放一个一用就报错的进去：
      // 只留这一个来源，才能确定报错是它发出来的。
      // 内置来源（摄像头 / 拍照识别）也临时置为不可用 ——
      // 无头浏览器里它们会真的去开摄像头并卡在那里，报错就永远等不到了。
      fakeCalls.n = 0;
      registerFakeScanner(false, '不该被调用');
      ['camera', 'photo'].forEach(function (name) {
        Scanner.register({
          name: name, label: name, priority: 1,
          available: function () { return false; },
          scan: function () { return Promise.reject(new Error('测试中置为不可用')); }
        });
      });
      Scanner.register({
        name: 'e2e-broken', label: '坏掉的扫码器', priority: 950,
        available: function () { return true; },
        scan: function () { return Promise.reject(new Error('相机被占用')); }
      });

      await E2E.goto('scan');
      E2E.click(q('#scan-start'));
      await E2E.waitUntil('出现失败提示', function () {
        return text('#toast-root').indexOf('相机被占用') !== -1;
      }, 10000);
      E2E.ok(fakeCalls.n === 0, '标了不可用的来源不该被调用，实际被调了 ' + fakeCalls.n + ' 次');
      E2E.ok(q('#scan-start') && !q('#scan-start').disabled, '失败后按钮要能再点一次');
      E2E.ok(pageName() === 'scan' && !q('.scan-result'), '扫码失败不该跳页');
    });

    /* ================= 地址栏 ================= */

    await E2E.record('地址栏带着编码：照着这条链接打开还能回到同一件物品', async function () {
      await E2E.goto('scan');
      await E2E.waitUntil('回到入口页', function () { return pageName() === 'scan' && !q('.scan-result'); });

      // 模拟"队友把链接发过来、照着地址直接打开" —— 走 hashchange 那条真实路径
      global.location.hash = '#scan/' + sharedCode;
      await waitResult();
      E2E.ok(q('.scan-name').textContent.trim() === 'M4 螺丝盒',
        '照着 #scan/编码 打开应当直接看到那件物品');

      // 手打坏了的地址（孤零零一个 %）不能把整页搞挂
      global.location.hash = '#scan/abc%';
      await E2E.waitUntil('坏地址也能给出人话', function () {
        return pageName() === 'scan' && text('#view-root').indexOf('abc%') !== -1;
      }, 10000);
      E2E.ok(text('#view-root').indexOf('页面出错') === -1, '坏地址不该把页面打成"页面出错"');
    });

    /* ================= 就地在结果页登记 ================= */

    await E2E.record('在扫码结果页直接登记借用，电脑端的数量、台账、流水同时跟上', async function () {
      await E2E.goto('scan', { code: singleCode });
      await waitResult();
      E2E.ok(actionLabels().indexOf('借用') !== -1,
        '在库有货就应给「借用」按钮，实际：' + actionLabels().join('、'));

      E2E.click(qa('[data-scan-act]').filter(function (b) {
        return b.textContent.trim() === '借用';
      })[0]);
      var mask = await waitModal();
      await E2E.waitUntil('借用表单就绪', function () { return mask.querySelector('[name="borrower"]'); });
      fillIn(mask, 'qty', '1');
      fillIn(mask, 'borrower', '赵六');
      fillIn(mask, 'dueDate', '2026-10-20');
      fillIn(mask, 'operator', '张三');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();

      await E2E.waitUntilAsync('借用落到库里', async function () {
        var c = await Stats.itemContext(singleCode);
        return c.item.lentQty === 1 && c.item.inStockQty === 0;
      }, 10000);

      var ctx = await Stats.itemContext(singleCode);
      E2E.ok(ctx.item.lentQty === 1 && ctx.item.inStockQty === 0,
        '数量应变成在库 0 / 借出 1，实际在库 ' + ctx.item.inStockQty + ' 借出 ' + ctx.item.lentQty);

      var ledger = await Ops.lendLedger();
      var row = ledger.filter(function (r) { return r.itemCode === singleCode; })[0];
      E2E.ok(row && row.borrower === '赵六' && row.qty === 1,
        '电脑端借用台账里应立刻看得到这笔');

      var txns = await DB.getByIndex('transactions', 'itemCode', singleCode);
      E2E.ok(txns.some(function (t) { return t.type === 'lend' && t.borrower === '赵六'; }),
        '流水里应留下这笔借出');

      // 页面自己也刷新了：扫码再看一次，就该显示借出中
      await E2E.goto('scan', { code: singleCode });
      await waitResult();
      E2E.ok(text('.scan-lent').indexOf('借出中（1 件）') !== -1 && text('.scan-lent').indexOf('赵六') !== -1,
        '登记完这一页自己也要跟上，实际「' + text('.scan-lent') + '」');
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
