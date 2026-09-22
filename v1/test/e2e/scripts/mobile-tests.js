/**
 * M9 手机端适配（第二版）。
 *
 * 做法：把**真实的 v1/index.html** 装进一个 iframe，先在手机宽度(390)测一遍，
 * 再把这个 iframe 拉宽到桌面宽度(1440)测一遍。
 *
 * 为什么用 iframe 而不是另做一份"长得像首页"的测试页：
 *   iframe 的视口宽度就是媒体查询看到的宽度，所以这里测的是**首页本身** ——
 *   它自己的 viewport、真实的样式表、真实的脚本顺序，一个都不走样。
 *   另做一份测试页的话，首页改了那边不会跟着改，迟早跑偏（这次就踩到过同类问题）。
 *
 * 为什么同一个 iframe 要从窄拉到宽：
 *   后半段是"没碰坏电脑端"的正面证据 —— 同一份代码、同一个文档，
 *   窄档该收的地方收，宽档该放的照样放，说明手机样式没有外溢到桌面。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var PHONE_W = 390;
  var DESKTOP_W = 1440;

  var frame = null;
  var W = null;            // iframe 里的 window（真实应用所在的那个）

  function cssOf(sel, prop) {
    var node = W.document.querySelector(sel);
    return node ? W.getComputedStyle(node)[prop] : '';
  }
  /**
   * 布局视口宽度。
   * 必须用 documentElement.clientWidth，不能用 window.innerWidth ——
   * innerWidth 含纵向滚动条那 15px，拿它当"屏幕宽"去比元素宽度，
   * 会平白差出 15px（弹窗那条断言就是这么踩的）。
   */
  function vpW() { return W.document.documentElement.clientWidth; }
  function bodyText() {
    var root = W.document.querySelector('#view-root');
    return root ? String(root.textContent).replace(/\s+/g, ' ').trim() : '';
  }
  /** 页面上列数最多的那张表（列多的表才需要横向滑动） */
  function widestTable() {
    var tables = Array.prototype.slice.call(W.document.querySelectorAll('table.grid'));
    var best = null;
    tables.forEach(function (t) {
      var cols = t.querySelectorAll('thead th').length;
      if (!best || cols > best.cols) best = { el: t, cols: cols };
    });
    return best;
  }
  function navKeys() {
    return Array.prototype.map.call(W.document.querySelectorAll('#main-nav .nav-item'), function (b) {
      return b.getAttribute('data-goto');
    }).filter(function (k) { return !!k; });
  }
  function resizeTo(width, height) {
    frame.style.width = width + 'px';
    frame.style.height = height + 'px';
  }

  /** 切页并等到这一页真的画完（在 iframe 里点，判据同 lib.js 的 goto） */
  async function go(route, params) {
    var before = W.document.querySelector('#view-root');
    W.FEVER.App.goto(route, params || {});
    await E2E.waitUntil('iframe 里切到 ' + route, function () {
      var root = W.document.querySelector('#view-root');
      return !!root && root !== before && root.getAttribute('data-page') === route;
    }, 10000);
    return bodyText();
  }

  async function openAndCloseModal() {
    var m = W.FEVER.UI.openModal({ title: '弹窗尺寸检查', body: '<p>内容</p>' });
    await E2E.waitUntil('弹窗出现', function () { return !!W.document.querySelector('.modal-mask .modal'); });
    return m;
  }

  async function run() {
    frame = document.createElement('iframe');
    frame.id = 'app-frame';
    // 挪到屏幕外而不是 display:none —— display:none 的 iframe 不参与布局，
    // 宽度会被算成 0，媒体查询就全乱了。
    frame.style.cssText = 'position:absolute;left:-99999px;top:0;border:0;';
    resizeTo(PHONE_W, 844);
    document.body.appendChild(frame);
    frame.src = '/index.html';

    await E2E.waitUntil('iframe 里的真实首页启动完成', function () {
      try {
        var w = frame.contentWindow;
        if (!w || !w.FEVER || !w.FEVER.App) return false;
        var root = w.document.querySelector('#view-root');
        return !!root && !!root.getAttribute('data-page');
      } catch (err) { return false; }
    }, 20000);
    W = frame.contentWindow;

    // 造数据走应用自己的接口 —— 和电脑端完全同一套数据层
    await W.FEVER.Rules.clearAll();
    await W.FEVER.Rules.initCategories();
    await W.FEVER.Ops.inbound({
      categoryId: 'mechanical', name: '手机端测试件', quantity: 4,
      troop: '其他', identityMode: 'shared', operator: '张三'
    });
    var oneCode = (await W.FEVER.Ops.inbound({
      categoryId: 'hardware', name: '手机端测试工具', quantity: 1,
      troop: '其他', identityMode: 'single', operator: '张三'
    })).codes[0];
    await go('home');

    /* ================= 手机档 ================= */

    await E2E.record('窄屏下确实命中手机档（否则下面的断言都没测到手机端）', function () {
      E2E.ok(vpW() <= PHONE_W, 'iframe 内布局视口宽度 ' + vpW() + 'px，应不超过 ' + PHONE_W);
      E2E.ok(W.matchMedia('(max-width: 720px)').matches, '媒体查询 (max-width:720px) 应当命中');
    });

    await E2E.record('手机上所有入口都摸得到，导航条可横向滑动（不藏功能）', function () {
      var keys = navKeys();
      E2E.ok(keys.length >= 8, '导航入口至少 8 个，实际 ' + keys.length + '：' + keys.join('、'));
      var nav = W.document.querySelector('.main-nav');
      E2E.ok(W.getComputedStyle(nav).flexWrap === 'nowrap',
        '手机上导航应单行排列（靠滑动而不是折行），否则会占掉半屏');
      E2E.ok(nav.scrollWidth > nav.clientWidth,
        '导航条内容(' + nav.scrollWidth + ')应比容器(' + nav.clientWidth + ')宽，才滑得动');
    });

    var entries = navKeys();
    for (var i = 0; i < entries.length; i += 1) {
      // 用 IIFE 把当前入口名固定进闭包。不能写成
      // `record(name, async function (key) { return function () {…} }(key))` ——
      // 那样交给 record 的是一个"返回函数的函数"，它只返回不执行，
      // 用例会永远通过（假绿），比不测还糟。
      await (function (key) {
        return E2E.record('手机上能打开「' + key + '」页并渲染出内容', async function () {
          var txt = await go(key);
          E2E.ok(txt.length > 0, key + ' 页应当有内容');
          E2E.ok(txt.indexOf('页面出错') === -1, key + ' 页不该是"页面出错"状态');
          E2E.ok(txt.indexOf('启动失败') === -1, key + ' 页不该是"启动失败"状态');
        });
      })(entries[i]);
    }

    await E2E.record('手机上物品详情的左右两栏改成上下，二维码不会把表格挤没', async function () {
      await go('item', { code: oneCode });
      var dir = cssOf('.detail-row', 'flexDirection');
      E2E.ok(dir === 'column', '手机档应改为上下排列(flex-direction: column)，实际 ' + dir);
      var qr = W.document.querySelector('.detail-qr');
      E2E.ok(qr, '详情页应有二维码区块');
      E2E.ok(qr.getBoundingClientRect().width <= vpW(),
        '二维码区块宽度不应超过视口，否则会把右边挤出去');
    });

    await E2E.record('手机上多列表格改为横向滑动，而不是把每列挤到只剩两个字', async function () {
      await go('txns');
      // 表格是在 onMount 里读库之后才画进去的，切页完成 ≠ 表格已就位，要单独等
      await E2E.waitUntil('流水页的表格画出来', function () { return !!widestTable(); }, 10000);
      var wide = widestTable();
      E2E.ok(wide.cols >= 6, '流水表应有较多列，实际只有 ' + wide.cols + ' 列 —— 这条断言就没意义了');
      var minW = parseFloat(W.getComputedStyle(wide.el).minWidth);
      E2E.ok(minW > vpW(),
        wide.cols + ' 列的表最小宽度(' + minW + 'px)应大于视口(' + vpW() + 'px)，这样才会滑动而不是挤成一团');
      var box = wide.el.parentNode;
      var ox = W.getComputedStyle(box).overflowX;
      E2E.ok(ox === 'auto' || ox === 'scroll',
        '表格的容器应可横向滚动，实际 overflow-x=' + ox);
    });

    await E2E.record('手机上弹窗铺满屏幕，底下不会被留白挤成一条', async function () {
      var m = await openAndCloseModal();
      var radius = parseFloat(cssOf('.modal', 'borderRadius'));
      var w = W.document.querySelector('.modal').getBoundingClientRect().width;
      E2E.ok(radius === 0, '手机档弹窗应贴边（无圆角），实际圆角 ' + radius + 'px');
      E2E.ok(Math.abs(w - vpW()) < 3, '弹窗宽度 ' + w + ' 应贴住布局视口 ' + vpW());
      m.close();
    });

    await E2E.record('手机上的按钮够大，手指点得中', async function () {
      await go('item', { code: oneCode });
      var btns = W.document.querySelectorAll('#view-root .page-actions .btn');
      E2E.ok(btns.length > 0, '详情页应有操作按钮');
      for (var i = 0; i < btns.length; i += 1) {
        var h = btns[i].getBoundingClientRect().height;
        E2E.ok(h >= 38, '按钮「' + btns[i].textContent.trim() + '」高度只有 ' + h + 'px，手机档应 >= 38px');
      }
    });

    /* ================= 桌面档（把同一个 iframe 拉宽） ================= */
    /* 这一段是"没碰坏电脑端"的正面证据：同一个文档，宽档下必须回到原来的排版。 */

    resizeTo(DESKTOP_W, 900);
    await E2E.wait(120);

    await E2E.record('拉宽到桌面宽度后，手机档样式整体退出', function () {
      E2E.ok(vpW() >= DESKTOP_W - 40, 'iframe 内布局视口宽度 ' + vpW() + 'px，应约为 ' + DESKTOP_W);
      E2E.ok(!W.matchMedia('(max-width: 720px)').matches, '宽屏下不该再命中手机档');
      var nav = W.document.querySelector('.main-nav');
      E2E.ok(W.getComputedStyle(nav).flexWrap === 'wrap', '桌面端导航应回到可换行，实际 ' + W.getComputedStyle(nav).flexWrap);
      E2E.ok(nav.scrollWidth <= nav.clientWidth + 1,
        '桌面端导航不该出现横向滚动（内容 ' + nav.scrollWidth + '，容器 ' + nav.clientWidth + '）');
      var topH = parseFloat(cssOf('.topbar', 'height'));
      E2E.ok(Math.abs(topH - 56) < 2, '桌面端顶栏高度应仍是 56px，实际 ' + topH + 'px');
    });

    await E2E.record('桌面端的大类卡片、详情两栏、弹窗圆角都还是原来的样子', async function () {
      await go('home');
      var cols = W.getComputedStyle(W.document.querySelector('.cat-grid')).gridTemplateColumns.split(' ').length;
      E2E.ok(cols >= 2, '桌面端大类卡片应是多列，实际 ' + cols + ' 列');

      await go('item', { code: oneCode });
      E2E.ok(cssOf('.detail-row', 'flexDirection') === 'row',
        '桌面端详情页应仍是左右两栏，实际 ' + cssOf('.detail-row', 'flexDirection'));

      var m = await openAndCloseModal();
      var radius = parseFloat(cssOf('.modal', 'borderRadius'));
      E2E.ok(radius > 0, '桌面端弹窗应保留圆角，实际 ' + radius + 'px');
      m.close();
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
