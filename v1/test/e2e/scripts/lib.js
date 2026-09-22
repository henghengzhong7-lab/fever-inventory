/**
 * 浏览器端测试的公共工具：收集结果、等待条件、模拟点击、清空数据库。
 * 这些脚本跑在真实页面里，内容会写进 <pre id="e2e-out">。
 */
(function (global) {
  'use strict';

  var results = [];
  var out = document.getElementById('e2e-out');

  // 把页面里任何未捕获的错误记下来，方便定位（否则只能看到"等待超时"）
  var pageErrors = [];
  (global.__EARLY_ERRORS__ || []).forEach(function (m) { pageErrors.push(m); });
  global.__EARLY_ERRORS__ = pageErrors;
  global.addEventListener('error', function (e) {
    pageErrors.push('错误：' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  global.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    pageErrors.push('未处理的 Promise 拒绝：' + (r && r.message ? r.message : String(r)));
  });

  // 万一某个测试卡住，超时后也要交出结果，避免整个测试挂死
  var hardTimeout = setTimeout(function () {
    if (!out.getAttribute('data-done')) {
      results.push({ name: '整体超时（可能有测试卡住）', ok: false, message: '测试未在 60 秒内完成' });
      flush();
      out.setAttribute('data-done', 'timeout');
      releaseGate();
    }
  }, 60000);

  function flush() {
    out.textContent = results.map(function (r) {
      return (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' :: ' + r.message);
    }).concat(pageErrors.map(function (m) { return 'NOTE ' + m; })).join('\n') +
      '\nSUMMARY pass=' + results.filter(function (r) { return r.ok; }).length +
      ' fail=' + results.filter(function (r) { return !r.ok; }).length;
  }

  function record(name, fn) {
    var errorsBefore = pageErrors.length;
    return Promise.resolve()
      .then(fn)
      .then(function () { results.push({ name: name, ok: true }); })
      .catch(function (err) {
        var message = String(err && err.message ? err.message : err);
        // 把本用例期间页面自己吐出的报错附在失败信息后面，
        // 否则"等待超时"看不出到底是慢还是页面报错了
        var fresh = pageErrors.slice(errorsBefore);
        if (fresh.length) message += ' ｜ 页面报错：' + fresh.join(' ／ ');
        results.push({ name: name, ok: false, message: message });
      })
      .then(function () { flush(); });
  }

  function fail(message) { throw new Error(message); }
  function ok(cond, message) { if (!cond) fail(message || '条件不成立'); }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 反复检查直到条件成立，超时就报错 */
  function waitUntil(label, fn, timeoutMs) {
    var limit = timeoutMs || 6000;
    var start = Date.now();
    return new Promise(function (resolve, reject) {
      function tick() {
        var value;
        try { value = fn(); } catch (err) { value = false; }
        if (value) { resolve(value); return; }
        if (Date.now() - start > limit) { reject(new Error('等待超时：' + label + ' ｜ ' + diagnose())); return; }
        setTimeout(tick, 40);
      }
      tick();
    });
  }

  /** 超时时把"当时停在哪一页"带出来，省得只能干瞪眼 */
  function diagnose() {
    var root = document.getElementById('view-root');
    var page = root ? (root.getAttribute('data-page') || '未标记') : '无 view-root';
    var text = root ? String(root.textContent).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return '当时页面=' + page + '，内容开头=「' + text + '」';
  }

  /**
   * 异步版的等待：判断条件本身要读数据库时用它。
   * 不能用上面那个同步版——同步版把 Promise 当成"真值"，
   * 会导致条件还没成立就以为通过了。
   */
  function waitUntilAsync(label, fn, timeoutMs) {
    var limit = timeoutMs || 6000;
    var start = Date.now();
    return new Promise(function (resolve, reject) {
      function tick() {
        Promise.resolve()
          .then(fn)
          .then(function (value) {
            if (value) { resolve(value); return; }
            if (Date.now() - start > limit) { reject(new Error('等待超时：' + label)); return; }
            setTimeout(tick, 50);
          })
          .catch(function () {
            if (Date.now() - start > limit) { reject(new Error('等待超时：' + label)); return; }
            setTimeout(tick, 50);
          });
      }
      tick();
    });
  }

  /** 真按一下（会触发页面上的事件分发） */
  function click(node) {
    if (!node) fail('要点击的元素不存在');
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: global }));
  }

  /**
   * 切到某一页，并等到**这一次**渲染真的画完。
   *
   * 不能只等 `data-page === name`：如果**当前已经在目标页**上，
   * 上一次渲染留下的 data-page 早就等于 name 了，这个条件会立刻成立，
   * 测试就骑在一个"还没把新数据画出来"的旧页面上继续往下跑 ——
   * 表现为莫名其妙地点到了过期的按钮。
   *
   * 实测踩过一次：采购页连着两轮操作（第二轮开始时已经在采购页），
   * 第二轮点「驳回」点到的还是上一轮那条申请，一路红到超时；
   * 而单独复刻同一场景的探针却是对的，因为探针每次都从首页切过去。
   *
   * 所以判据换成：**页面框架换过 #view-root 节点**（app.js 每次渲染都会
   * clone 一个新的 #view-root 换上去），并且新节点上标着目标页名。
   */
  function goto(name, params) {
    var before = document.querySelector('#view-root');
    global.FEVER.App.goto(name, params);
    return waitUntil('页面 ' + name + ' 渲染完成', function () {
      var root = document.querySelector('#view-root');
      return !!root && root !== before && root.getAttribute('data-page') === name;
    });
  }

  /**
   * 取**最上面**那个弹窗。
   * 弹窗是依次 append 到 #modal-root 的，所以最后一个才是最新的那个；
   * 如果前一个用例失败时留下了没关掉的弹窗，取第一个会拿到那个旧的，
   * 于是后面几个用例全都"点不到自己该点的地方" —— 一个真失败变成一串假失败。
   */
  function topModal() {
    var all = document.querySelectorAll('.modal-mask');
    return all.length ? all[all.length - 1] : null;
  }

  /** 把所有开着的弹窗关掉（清理用，别让残留弹窗误导下一个用例） */
  function closeAllModals() {
    var all = document.querySelectorAll('.modal-mask');
    for (var i = all.length - 1; i >= 0; i -= 1) {
      var btn = all[i].querySelector('.modal-close');
      if (btn) btn.click();
    }
  }

  function clickSelector(sel, root) {
    var node = (root || document).querySelector(sel);
    if (!node) fail('找不到元素：' + sel);
    click(node);
    return node;
  }

  function setInput(node, value) {
    if (!node) fail('要填写的输入框不存在');
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 给 <select> 选值，**设完必须回读确认**。
   * 原因：给下拉框设一个不存在的值，浏览器不会报错，而是静默把 value 变成空字符串。
   * 于是测试以为"填了"，页面以为"没填"，最后只看到一堆莫名其妙的"等待超时"。
   * 实测踩过一次：把大类名（视觉）当成兵种写进去，采购流程 13 项全红。
   */
  function setSelect(node, value) {
    if (!node) fail('要选择的下拉框不存在');
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
    if (node.value !== value) {
      var all = Array.prototype.map.call(node.options || [], function (o) { return o.value; })
        .filter(function (v) { return v; }).join('、');
      fail('下拉框里没有「' + value + '」这个选项，设值后被浏览器改成了「' + node.value +
        '」。可选的只有：' + all);
    }
  }

  /** 清空所有表，让每组测试从干净状态开始 */
  function resetDb() {
    return global.FEVER.Rules.clearAll();
  }

  /* 兵种必填（第十三轮）：端到端里几十处直接调 Ops.inbound 的旧用例并不关心兵种，
   * 在这里统一垫一个默认值，免得每个套件都要机械补参数。
   * 只补「没写 troop 键」的调用：显式传 troop:'' 的用例仍会到达数据层，
   * 用来验证「缺兵种必须被拒绝」这条真规则。 */
  (function () {
    var Ops = global.FEVER && global.FEVER.Ops;
    if (!Ops || typeof Ops.inbound !== 'function') return;
    var real = Ops.inbound;
    Ops.inbound = function (input) {
      return real(Object.assign({ troop: '其他' }, input));
    };
  })();

  function finish() {
    clearTimeout(hardTimeout);
    flush();
    var summary = results.filter(function (r) { return !r.ok; }).length === 0 && results.length > 0;
    out.setAttribute('data-done', summary ? 'all-pass' : 'has-fail');
    releaseGate();
  }

  /** 放开"闸门"，让浏览器认为页面加载完成，随后 --dump-dom 才会取走结果 */
  function releaseGate() {
    var gate = document.getElementById('e2e-gate');
    if (gate) gate.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  }

  global.E2E = {
    record: record, fail: fail, ok: ok, wait: wait,
    waitUntil: waitUntil, waitUntilAsync: waitUntilAsync,
    goto: goto,
    topModal: topModal, closeAllModals: closeAllModals,
    click: click, clickSelector: clickSelector, setInput: setInput, setSelect: setSelect,
    resetDb: resetDb, finish: finish, results: results
  };
})(window);
