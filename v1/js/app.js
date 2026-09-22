/**
 * FEver 战队物资管理 —— 主控制
 *
 * 负责：启动引导、页面切换（路由）、导航与面包屑、全局点击事件分发、备份导入导出。
 * 页面长什么样在 views*.js 与 actions.js，这里只管"调到哪一页、点了按钮怎么办"。
 */
(function (global) {
  'use strict';

  var UI = global.FEVER.UI;
  var DB = global.FEVER.DB;
  var Rules = global.FEVER.Rules;
  var Ops = global.FEVER.Ops;
  var Stats = global.FEVER.Stats;
  var Views = global.FEVER.Views;
  var Forms = global.FEVER.Forms;

  var NAV = [
    { key: 'home', label: '物资总览' },
    // 扫码查物紧跟总览：手机上最高频的动作就是"扫一下看看这件东西在不在、放哪了"，
    // 排在导航最前面才不用横向滑半天才摸到。
    { key: 'scan', label: '扫码查物' },
    { key: 'desk', label: '出入库登记' },
    { key: 'ledger', label: '借用台账', badge: 'overdue' },
    { key: 'purchases', label: '采购申请', badge: 'pendingPurchase' },
    { key: 'budgets', label: '兵种预算' },
    { key: 'invoices', label: '发票台账' },
    { key: 'txns', label: '出入库流水' },
    { key: 'settings', label: '设置与备份' }
  ];

  var currentRoute = { name: 'home', params: {} };
  /**
   * 最近一次**被请求**显示的路由。
   *
   * 和 currentRoute（最近一次**渲染完成**的路由）分开记，是为了对付这种情况：
   * 使用者点了「删除」，删除要落库、要写删除记录，是异步的；就在这几十毫秒里
   * 他又切到了别的页。等删除的收尾逻辑跑完，它还会再调一次 refresh()——
   * 如果那次 refresh 画的是 currentRoute（还停在删除前那一页），就会把使用者
   * 刚切过去的页面顶掉，**地址栏和内容对不上**。
   * 所以 refresh 一律重画"最后被请求的那一页"，而不是"最后画完的那一页"。
   */
  var requestedRoute = { name: 'home', params: {} };
  var renderSeq = 0;

  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  /**
   * 解 URL 里的中文/特殊字符。
   *
   * decodeURIComponent 遇到一个孤零零的 % 会直接抛异常。而地址栏是**使用者能改的地方**：
   * 他可能手打了一个 #scan/abc%，或者从聊天软件里粘过来时被截断了。
   * 这里让解析函数抛异常，代价是整页停在上一页、只看到"点了没反应"——
   * 一个坏 URL 不该有这种破坏力。所以解不开就原样返回，交给后面的"查不到"去兜。
   */
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (err) { return s; }
  }

  /** 把路由写成地址栏的 # 片段，刷新后还能回到同一页 */
  function routeToHash(route) {
    var params = route.params || {};

    // 批量打印要把"选中了哪几件"也记进地址栏（#labels/batch/MC-0001,VS-0002）：
    // 刷新、后退、把链接发给同事，都还能回到同一批标签。
    // 只放在内存里的话，刷新后会悄悄退回"打印全部物品"——那是白费一整叠标签纸的错误。
    if (route.name === 'labels' && params.codes && params.codes.length) {
      return '#labels/batch/' + Rules.encodeCodeList(params.codes);
    }
    if (route.name === 'labels' && params.categoryId) {
      return '#labels/cat/' + encodeURIComponent(params.categoryId);
    }

    // 扫码查物把"扫到的那个编码"记进地址栏（#scan/MC-0001）：
    // 扫完手一滑刷新了，或者想把结果发给队友核对，还能回到同一件物品上。
    // 非要 encodeURIComponent 不可 —— 这个 code 也可能来自手工输入框，
    // 粘进去的任意字符里要是有个 /，就会被当成路径分隔符，切出半截编码。
    if (route.name === 'scan' && params.code) {
      return '#scan/' + encodeURIComponent(String(params.code));
    }

    var parts = [route.name];
    if (params.id) parts.push(params.id);
    if (params.code) parts.push(params.code);
    return '#' + parts.join('/');
  }

  function hashToRoute(hash) {
    var raw = String(hash || '').replace(/^#/, '');
    if (!raw) return { name: 'home', params: {} };
    var parts = raw.split('/');
    var name = parts[0];
    if (name === 'category') return { name: 'category', params: { id: parts[1] || '' } };
    if (name === 'item') return { name: 'item', params: { code: parts[1] || '' } };
    // #scan 与 #scan/MC-0001 都合法：前者是"还没扫"的入口页，后者是"扫到了这件"的结果页。
    if (name === 'scan') return { name: 'scan', params: { code: safeDecode(parts[1] || '') } };
    if (name === 'labels') {
      // 'batch' / 'cat' 这两个关键字不会和物品编码撞车 —— 编码长得像 MC-0001、VS-0002，
      // 前缀是大写字母，永远不可能是全小写的单词。
      if (parts[1] === 'batch') return { name: 'labels', params: { codes: Rules.decodeCodeList(parts[2] || '') } };
      if (parts[1] === 'cat') return { name: 'labels', params: { categoryId: safeDecode(parts[2] || '') } };
      return { name: 'labels', params: { code: parts[1] || '' } };
    }
    return { name: name, params: {} };
  }

  var ROUTES = {
    home: function () { return Views.home(); },
    category: function (p) { return Views.category(p); },
    item: function (p) { return Views.itemDetail(p); },
    scan: function (p) { return Views.scan(p); },
    desk: function () { return Views.desk(); },
    ledger: function () { return Views.lendLedger(); },
    purchases: function () { return Views.purchases(); },
    budgets: function () { return Views.budgets(); },
    invoices: function () { return Views.invoices(); },
    txns: function () { return Views.transactions(); },
    labels: function (p) { return Views.labels(p); },
    settings: function () { return Views.settings(); }
  };

  function goto(name, params) {
    var route = { name: name, params: params || {} };
    requestedRoute = route;
    var hash = routeToHash(route);
    if (global.location.hash === hash) {
      render(route);
    } else {
      global.location.hash = hash;
    }
  }

  function renderNav(activeName) {
    var nav = UI.qs('#main-nav');
    nav.innerHTML = NAV.map(function (item) {
      return '<button class="nav-item' + (item.key === activeName ? ' active' : '') + '" ' +
        'data-goto="' + UI.esc(item.key) + '" type="button">' + UI.esc(item.label) +
        (item.badge ? '<span class="badge" id="nav-badge-' + UI.esc(item.key) + '" style="display:none"></span>' : '') +
        '</button>';
    }).join('');
    refreshBadges();
  }

  /** 导航上的小红点：超期未还、待处理采购 */
  function refreshBadges() {
    Ops.lendLedger().then(function (ledger) {
      var overdue = ledger.filter(function (r) { return r.overdue; }).length;
      setBadge('nav-badge-ledger', overdue);
    }).catch(function () { /* 忽略，不影响主流程 */ });
    DB.getAll('purchaseRequests').then(function (reqs) {
      var pending = reqs.filter(function (r) { return r.status === 'pending' || r.status === 'ordered'; }).length;
      setBadge('nav-badge-purchases', pending);
    }).catch(function () { /* 忽略 */ });
  }

  function setBadge(id, count) {
    var node = UI.qs('#' + id);
    if (!node) return;
    if (count > 0) { node.textContent = count; node.style.display = ''; }
    else { node.style.display = 'none'; }
  }

  function renderCrumb(crumb, title) {
    var box = UI.qs('#crumb');
    if (!crumb || !crumb.length) {
      box.innerHTML = '';
      return;
    }
    var html = crumb.map(function (c, index) {
      var isLast = index === crumb.length - 1;
      var label = UI.esc(c.label);
      var node;
      if (isLast) node = '<span class="current">' + label + '</span>';
      else if (c.goto) {
        node = '<button class="link" type="button" data-goto="' + UI.esc(c.goto) + '"' +
          (c.params ? ' data-params="' + UI.esc(JSON.stringify(c.params)) + '"' : '') + '>' + label + '</button>';
      } else node = label;
      return node;
    }).join('<span class="sep">›</span>');
    box.innerHTML = html + '<span class="sep">·</span><span>' + UI.esc(title || '') + '</span>';
  }

  function render(route) {
    var factory = ROUTES[route.name] || ROUTES.home;
    // 每次渲染发一个号。渲染要读数据库，是异步的；
    // 如果连点两个页面，先发的那个可能后返回，把新页面盖掉。
    // 所以只有"最新一次渲染"才允许真正动界面。
    var seq = (renderSeq += 1);
    // 注意：工厂函数必须放进 Promise 链里调用。
    // 写成 Promise.resolve(factory(...)) 的话，工厂里同步抛出的异常会绕过下面的
    // catch 直接冒出去，页面就永远停在上一页，使用者只看到"点了没反应"。
    return Promise.resolve().then(function () {
      return factory(route.params || {});
    }).then(function (view) {
      if (!view || seq !== renderSeq) return;
      currentRoute = route;
      document.title = (view.title ? view.title + ' · ' : '') + 'FEver 战队物资管理';
      // 关键：整块换掉 view-root，而不是只清空它的内容。
      // 各页面的 onMount 会在 view-root 上挂委托监听器（筛选、操作台按钮等），
      // 如果只替换 innerHTML，监听器会随每次渲染不断累积，
      // 结果是"点一次按钮弹出好几个弹窗"。换掉元素就等于把这些监听器一起清掉。
      var oldRoot = UI.qs('#view-root');
      var root = oldRoot.cloneNode(false);
      oldRoot.parentNode.replaceChild(root, oldRoot);
      root.innerHTML = view.html;
      // 标记当前是哪一页，方便自动测试准确等待"这一页真的渲染好了"
      root.setAttribute('data-page', route.name);
      renderNav(route.name === 'item' ? 'home' : route.name === 'category' ? 'home' : route.name);
      renderCrumb(view.crumb, view.title);
      if (view.onMount) view.onMount(root);
      global.scrollTo(0, 0);
    }).catch(function (err) {
      if (seq !== renderSeq) return;
      console.error(err);
      UI.qs('#view-root').innerHTML = '<div class="panel"><div class="panel-body">' +
        '<div class="alert-item danger"><span class="who">页面出错</span><span>' +
        UI.esc(err && err.message ? err.message : String(err)) + '</span></div></div></div>';
    });
  }

  /**
   * 重画"现在该显示的那一页"（删掉/存好一条之后刷新用）。
   *
   * 注意画的是 requestedRoute 而不是 currentRoute —— 理由见上面 requestedRoute 的说明：
   * 这类刷新是操作收尾时"顺手"触发的，使用者可能已经切走了，
   * 这时候要跟着他画新页，不能把他拽回旧页。
   */
  function refresh() {
    return render(requestedRoute).then(function () { refreshBadges(); });
  }

  /* ================= 备份导出 / 导入 ================= */

  function backupFilename(prefix, ext) {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return prefix + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + (ext || '.json');
  }

  function doExportBackup(silent) {
    return Rules.exportAll().then(function (payload) {
      UI.downloadText(backupFilename('FEver物资备份'), JSON.stringify(payload, null, 2), 'application/json');
      return DB.setSetting('lastBackupAt', DB.nowIso()).then(function () {
        if (!silent) UI.toast('备份已导出，请把文件保存好', 'ok');
        return payload;
      });
    });
  }

  function doImportBackup() {
    UI.pickTextFile('.json,application/json').then(function (file) {
      if (!file) return;
      return importFromText(file.text, file.name);
    });
  }

  /**
   * 从备份文件的文本内容恢复数据。
   * 拆出来是为了能直接对着文本跑测试，不用真的弹"选文件"窗口。
   * 返回值告诉调用方最后到底有没有导入：'canceled' / 'invalid' / 'done'。
   */
  function importFromText(text, fileName) {
    var payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      UI.toast('这个文件不是有效的备份文件（无法解析）', 'err');
      return Promise.resolve('invalid');
    }
    var check = Rules.validateBackup(payload);
    if (!check.ok) {
      UI.toast('不能导入：' + check.message, 'err');
      return Promise.resolve('invalid');
    }
    var exportedAt = payload.exportedAt ? UI.fmtTime(payload.exportedAt) : '未知时间';
    var counts = (payload.counts && Object.keys(payload.counts).length)
      ? '物品 ' + num(payload.counts.items) + ' 条、采购申请 ' + num(payload.counts.purchaseRequests) +
        ' 条、发票 ' + num(payload.counts.invoices) + ' 条、流水 ' + num(payload.counts.transactions) + ' 条'
      : '（文件里没有统计信息）';

    return UI.confirmDialog({
      title: '确认导入恢复',
      danger: true,
      okText: '先备份当前数据，然后导入',
      body: '<p>即将导入的备份：<b>' + UI.esc(fileName || '（未命名）') + '</b></p>' +
        '<p>导出时间：' + UI.esc(exportedAt) + '</p>' +
        '<p>内容：' + UI.esc(counts) + '</p>' +
        '<p style="color:var(--danger)"><b>导入会用备份里的数据整体替换当前数据，当前数据将不再出现在界面上。</b>' +
        '点击下面的按钮后，系统会先把当前数据自动导出一份作保险，再执行导入。</p>'
    }).then(function (ok) {
      if (!ok) { UI.toast('已取消，数据没有变化', 'warn'); return 'canceled'; }
      // 先自动把当前数据导出一份作保险，再执行导入
      return doExportBackup(true).then(function () {
        return Rules.importAll(payload);
      }).then(function (res) {
        // 备份里带着当时的"上次备份时间"，导入后要改回现在，
        // 否则刚恢复完就弹"已经很多天没备份了"，反而误导人。
        return DB.setSetting('lastBackupAt', DB.nowIso()).then(function () {
          UI.toast('导入完成：物品 ' + num(res.counts.items) + ' 条、申请 ' +
            num(res.counts.purchaseRequests) + ' 条、发票 ' + num(res.counts.invoices) +
            ' 条、流水 ' + num(res.counts.transactions) + ' 条', 'ok');
          return refresh().then(function () { return 'done'; });
        });
      }).catch(function (err) {
        UI.toast('导入失败：' + (err && err.message ? err.message : err) + '（数据已回滚，未受影响）', 'err');
        return 'failed';
      });
    });
  }

  /**
   * 设置页「发送测试提醒」：真发一条，把飞书的原始结果亮出来。
   * 收不到提醒时让证据说话 —— 是权限没开、机器人没启用还是名单没认出来，
   * 飞书返回什么错误码，界面就显示什么。
   */
  function runNotifyTest() {
    UI.toast('正在发送测试提醒……', 'info');
    DB.notifyTest().then(function (res) {
      var dm = res && res.dm;
      var g = res && res.group;
      if (dm && dm.ok) {
        var msg = '测试提醒已发出，请到飞书里查收（在你和「' +
          'FEver 战队物资管理」应用的会话里；手机端应该也收到了推送）';
        if (g && g.ok) msg += '；群提醒也已发出';
        else if (g && g.skipped) msg += '。' + g.skipped;
        else if (g && g.error) msg += '；但群提醒失败：' + g.error;
        UI.toast(msg, 'ok');
      } else {
        UI.toast('提醒发不出去：' + ((dm && dm.error) || '未知原因') +
          (dm && dm.feishuCode ? '（飞书错误码 ' + dm.feishuCode + '）' : ''), 'err');
      }
    }).catch(function (err) {
      UI.toast((err && err.message) || '测试提醒发送失败', 'err');
    });
  }

  function exportItemsCsv() {
    Stats.snapshot().then(function (data) {
      UI.downloadText(backupFilename('FEver物品清单', '.csv'), Stats.itemsCsv(data.items, data.categories), 'text/csv');
      UI.toast('物品清单已导出', 'ok');
    });
  }

  function exportTxnsCsv() {
    Stats.filterTransactions({}).then(function (rows0) {
      var root = UI.qs('#view-root');
      var rows = (currentRoute.name === 'txns' && root && root.__filtered) ? root.__filtered : rows0;
      UI.downloadText(backupFilename('FEver出入库流水', '.csv'), Stats.transactionsCsv(rows), 'text/csv');
      UI.toast('流水已导出', 'ok');
    });
  }

  /**
   * 兵种预算导出（三段式 CSV：总表 + 已消费明细 + 未消费预算）。
   * 导出永远是"全部时间"的全量口径 —— 页面上的时间范围只是看的角度，
   * 存档要的是完整账，按当前筛选导出反而容易漏。
   */
  function exportBudgetsCsv() {
    DB.runTx(['purchaseRequests', 'invoices'], 'readonly', function (T) {
      return Promise.all([T.getAll('purchaseRequests'), T.getAll('invoices')]);
    }).then(function (arr) {
      return DB.getSetting(Stats.BUDGET_KEY, {}).then(function (budgets) {
        UI.downloadText(backupFilename('FEver兵种预算', '.csv'),
          Stats.budgetCsv(arr[0], budgets, 'all', DB.nowIso(), arr[1]), 'text/csv');
        UI.toast('兵种预算已导出（含已消费明细与未消费预算）', 'ok');
      });
    });
  }

  /* ================= 全局事件分发 ================= */

  function bindGlobalEvents() {
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;

      var gotoBtn = target.closest('[data-goto], [data-goto-category]');
      if (gotoBtn) {
        var cat = gotoBtn.getAttribute('data-goto-category');
        var name = gotoBtn.getAttribute('data-goto');
        var paramsAttr = gotoBtn.getAttribute('data-params');
        var params = paramsAttr ? JSON.parse(paramsAttr) : {};
        if (cat) goto('category', { id: cat });
        else goto(name, params);
        return;
      }

      var itemBtn = target.closest('[data-goto-item]');
      if (itemBtn) { goto('item', { code: itemBtn.getAttribute('data-goto-item') }); return; }

      var printItem = target.closest('[data-print-item]');
      if (printItem) { goto('labels', { code: printItem.getAttribute('data-print-item') }); return; }

      var invBtn = target.closest('[data-goto-invoice]');
      if (invBtn) { openInvoiceDialog(num(invBtn.getAttribute('data-goto-invoice'))); return; }

      var purBtn = target.closest('[data-goto-purchase]');
      if (purBtn) { openPurchaseDialog(num(purBtn.getAttribute('data-goto-purchase'))); return; }

      var pdfBtn = target.closest('[data-invoice-pdf]');
      if (pdfBtn) { downloadInvoicePdf(num(pdfBtn.getAttribute('data-invoice-pdf'))); return; }

      var dlAllBtn = target.closest('[data-dl-invoices]');
      if (dlAllBtn) { openInvoicePicker(); return; }

      var copyBtn = target.closest('[data-copy]');
      if (copyBtn) {
        var text = copyBtn.getAttribute('data-copy');
        if (global.navigator && global.navigator.clipboard) {
          global.navigator.clipboard.writeText(text).then(function () { UI.toast('已复制 ' + text, 'ok'); });
        } else {
          UI.toast(text, 'ok');
        }
        return;
      }

      var act = target.closest('[data-act]');
      if (act) { handleAct(act.getAttribute('data-act'), act); return; }

      var advance = target.closest('[data-advance]');
      if (advance) {
        var id = num(advance.getAttribute('data-advance'));
        DB.get('purchaseRequests', id).then(function (req) {
          if (!req) return;
          req.status = advance.getAttribute('data-to');
          req.updatedAt = DB.nowIso();
          return DB.put('purchaseRequests', req).then(function () {
            UI.toast('状态已更新', 'ok'); return refresh();
          });
        });
        return;
      }

      var arriveBtn = target.closest('[data-arrive]');
      if (arriveBtn) {
        Forms.openArrive(num(arriveBtn.getAttribute('data-arrive')), { onDone: refresh });
        return;
      }

      var approveBtn = target.closest('[data-approve]');
      if (approveBtn) {
        Forms.approvePurchase(num(approveBtn.getAttribute('data-approve')), { onDone: refresh });
        return;
      }

      var rejectBtn = target.closest('[data-reject]');
      if (rejectBtn) {
        Forms.rejectPurchase(num(rejectBtn.getAttribute('data-reject')), { onDone: refresh });
        return;
      }

      var cancelReq = target.closest('[data-cancel-id]');
      if (cancelReq) {
        var cid = num(cancelReq.getAttribute('data-cancel-id'));
        UI.confirmDialog({
          title: '取消这条采购申请？',
          body: '取消后不会生成物品，可以稍后再删除这条申请。',
          okText: '取消申请'
        }).then(function (ok) {
          if (!ok) return;
          DB.get('purchaseRequests', cid).then(function (req) {
            if (!req) return;
            req.status = 'canceled';
            req.updatedAt = DB.nowIso();
            return DB.put('purchaseRequests', req).then(function () { UI.toast('已取消', 'ok'); return refresh(); });
          });
        });
        return;
      }

      var delReq = target.closest('[data-del-purchase]');
      if (delReq) {
        Forms.deletePurchase(num(delReq.getAttribute('data-del-purchase')), { onDone: refresh });
        return;
      }

      var delItem = target.closest('[data-del-item]');
      if (delItem) {
        var delCode = delItem.getAttribute('data-del-item');
        Forms.deleteItem(delCode, {
          onDone: function () {
            // 物品没了，详情页就留不住 —— 回到它原来所属的大类
            var back = delItem.getAttribute('data-del-back') || 'home';
            goto(back === 'home' ? 'home' : 'category', back === 'home' ? {} : { id: back });
            refreshBadges();
          }
        });
        return;
      }

      var delInv = target.closest('[data-del-invoice]');
      if (delInv) {
        Forms.deleteInvoice(num(delInv.getAttribute('data-del-invoice')), { onDone: refresh });
        return;
      }

      var delTxn = target.closest('[data-del-txn]');
      if (delTxn) {
        Forms.deleteTransaction(num(delTxn.getAttribute('data-del-txn')), { onDone: refresh });
        return;
      }

      var retBtn = target.closest('[data-return]');
      if (retBtn) {
        var rcode = retBtn.getAttribute('data-return');
        DB.get('items', rcode).then(function (item) {
          if (!item) return;
          Forms.openActionDialog({ action: 'giveBack', item: item, onDone: refresh });
        });
        return;
      }

    });

    global.addEventListener('hashchange', function () {
      requestedRoute = hashToRoute(global.location.hash);
      render(requestedRoute);
    });
  }

  function handleAct(name, node) {
    if (name === 'new-item') { Forms.openNewItem({ categoryId: node.getAttribute('data-cat'), onDone: refresh }); return; }
    if (name === 'new-purchase') { Forms.openNewPurchase({ categoryId: node.getAttribute('data-cat'), onDone: refresh }); return; }
    if (name === 'new-inbound') { Forms.openNewItem({ onDone: refresh }); return; }
    if (name === 'print-labels') {
      // 大类页上那个「批量打印标签」原来把 data-cat 丢掉了，于是不管点哪个大类、
      // 打出来的都是**全部物品**的标签。这里把它接上：机械页只出机械的标签。
      var printCat = node.getAttribute('data-cat');
      goto('labels', printCat ? { categoryId: printCat } : {});
      return;
    }
    if (name === 'export-backup') { doExportBackup(false).then(refresh); return; }
    if (name === 'import-backup') { doImportBackup(); return; }
    if (name === 'export-items') { exportItemsCsv(); return; }
    if (name === 'export-txns' || name === 'export-txns2') { exportTxnsCsv(); return; }
    if (name === 'export-budgets') { exportBudgetsCsv(); return; }
    if (name === 'notify-test') { runNotifyTest(); return; }
    if (name === 'edit-item') { openEditItem(node.getAttribute('data-code')); return; }
    if (name === 'edit-budgets') { Forms.openEditBudgets({ onDone: refresh }); return; }
    if (name === 'delete-log') { openDeleteLogDialog(); return; }
    if (name === 'reset-filter') { return; }
  }

  /**
   * 删除记录：谁、什么时候、删了什么。
   *
   * 界面上**刻意不提供"清空删除记录"** —— 它是审计用的，能随手清掉就失去意义了。
   * 真要清只能改数据（clearDeleteLog 只留给测试和人工维护）。
   */
  function openDeleteLogDialog() {
    Rules.getDeleteLog().then(function (list) {
      var rows = list.slice().reverse();     // 最近的在最前面
      UI.openModal({
        title: '删除记录',
        wide: true,
        body:
          '<div class="alert-item info" style="margin-bottom:14px"><span>' +
            '出入库流水按原设计是只追加、不删除的。后加的删除功能守住了这条底线：' +
            '<b>每删一条都记一笔，并留下被删内容的快照</b>，需要时能查回来。' +
            '这里只保留最近 ' + Rules.DELETE_LOG_MAX + ' 条。' +
          '</span></div>' +
          UI.table([
            { label: '时间', render: function (r) { return UI.esc(UI.fmtTime(r.at)); } },
            { label: '谁删的', render: function (r) { return UI.esc(r.by || '-'); } },
            { label: '类型', render: function (r) { return UI.esc(Rules.DELETE_LABELS[r.store] || r.store); } },
            { label: '删了什么', render: function (r) { return UI.esc(r.label || r.key); } },
            { label: '当时的内容', render: function (r) {
                return r.snapshot
                  ? '<span class="hint" style="word-break:break-all">' + UI.esc(JSON.stringify(r.snapshot)) + '</span>'
                  : '<span class="hint">没留快照</span>'; } }
          ], rows, { emptyText: '还没有删除记录。删过东西之后，这里会留下账。' })
      });
    });
  }

  /* ==================== 发票 PDF 下载（第十三轮） ==================== */

  /** base64 → 字节。zip 打包与单文件下载都要先过这一步 */
  function base64ToBytes(base64) {
    var bin = global.atob(base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** 下载一张发票的 PDF（发票详情弹窗里的按钮） */
  function downloadInvoicePdf(invoiceId) {
    DB.get('invoices', invoiceId).then(function (inv) {
      if (!inv) { UI.toast('找不到这张发票', 'err'); return; }
      return DB.loadInvoiceFile(inv).then(function (file) {
        if (!file) { UI.toast('这张发票没有 PDF 附件', 'warn'); return; }
        UI.downloadBytes(file.fileName || '发票.pdf', base64ToBytes(file.base64), file.mime || 'application/pdf');
        UI.toast('已开始下载 ' + (file.fileName || '发票.pdf'), 'ok');
      });
    }).catch(function (err) {
      UI.toast((err && err.message) || '下载失败', 'err');
    });
  }

  /**
   * 发票选择弹窗：批量下载前先勾一遍，想下哪几张下哪几张。
   *
   * 默认全选（多数时候管理员就是要全部），全不选时下载按钮禁用——
   * 宁可多点一下"全选"，也不能让人以为下了 zip 却是空的。
   * 事件都接在弹窗自己身上（onMount 之后 mask.addEventListener），
   * 不进全局分发，关掉弹窗就一起消失。
   */
  function openInvoicePicker() {
    DB.getAll('invoices').then(function (invoices) {
      var withFile = invoices.filter(function (inv) { return inv.fileRef || inv.fileData; });
      if (!withFile.length) { UI.toast('还没有上传过发票 PDF', 'warn'); return; }
      // 新的排上面，跟台账一个顺序
      withFile.sort(function (a, b) { return num(b.id) - num(a.id); });

      var rows = withFile.map(function (inv) {
        return '<label class="inv-pick-row">' +
          '<input type="checkbox" name="inv-pick" value="' + UI.esc(inv.id) + '" checked>' +
          '<span class="inv-pick-name">' + UI.esc(Rules.invoiceLabel(inv)) +
            '<span class="hint">¥' + num(inv.amount).toFixed(2) +
              (inv.invoiceDate ? ' · ' + UI.esc(inv.invoiceDate) : '') + '</span></span>' +
        '</label>';
      }).join('');

      var m = UI.openModal({
        title: '选择要下载的发票',
        wide: true,
        body:
          '<div class="page-actions" style="margin-bottom:6px">' +
            '<button class="btn small" data-inv-check="all" type="button">全选</button>' +
            '<button class="btn small" data-inv-check="none" type="button">全不选</button>' +
            '<span class="hint" id="inv-pick-count"></span>' +
          '</div>' +
          '<div class="inv-pick-list">' + rows + '</div>',
        footer: '<button class="btn primary" data-inv-download type="button" disabled>下载所选</button>'
      });
      var mask = m.el;

      function checkedBoxes() {
        return Array.prototype.slice.call(mask.querySelectorAll('input[name="inv-pick"]:checked'));
      }
      function paint() {
        var n = checkedBoxes().length;
        var counter = mask.querySelector('#inv-pick-count');
        if (counter) counter.textContent = '已选 ' + n + ' / ' + withFile.length + ' 张';
        var btn = mask.querySelector('[data-inv-download]');
        if (btn) { btn.disabled = n === 0; btn.textContent = '下载所选（' + n + '）'; }
      }

      mask.addEventListener('change', function (e) {
        if (e.target && e.target.name === 'inv-pick') paint();
      });
      mask.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-inv-check]') : null;
        if (t) {
          var on = t.getAttribute('data-inv-check') === 'all';
          Array.prototype.forEach.call(mask.querySelectorAll('input[name="inv-pick"]'), function (b) { b.checked = on; });
          paint();
          return;
        }
        var dl = e.target.closest ? e.target.closest('[data-inv-download]') : null;
        if (dl && !dl.disabled) {
          var ids = checkedBoxes().map(function (b) { return num(b.value); });
          m.close();
          downloadAllInvoices(ids);
        }
      });
      paint();
    });
  }

  /**
   * 管理员批量下载发票 PDF，打成一个 zip。
   *
   * 按钮只在管理员视角出现（DB.isAdmin 只画按钮），文件读取本身
   * 两个数据层接口一致：离线版从本地行数据取，飞书版逐张向服务器取。
   * 重名的发票自动加序号 —— 谁都不希望打包时悄悄覆盖掉哪张。
   * onlyIds 可选：只打包这些 id 的发票（勾选下载）；不传就是全部。
   */
  function downloadAllInvoices(onlyIds) {
    DB.getAll('invoices').then(function (invoices) {
      var pick = {};
      (onlyIds || []).forEach(function (id) { pick[id] = true; });
      var withFile = invoices.filter(function (inv) {
        return (inv.fileRef || inv.fileData) && (!onlyIds || !onlyIds.length || pick[inv.id]);
      });
      if (!withFile.length) { UI.toast('还没有可下载的发票 PDF', 'warn'); return; }

      UI.toast('正在打包 ' + withFile.length + ' 张发票……', 'info');
      var used = {};
      var files = [];
      var failed = [];

      var chain = Promise.resolve();
      withFile.forEach(function (inv) {
        chain = chain.then(function () {
          return DB.loadInvoiceFile(inv).then(function (file) {
            if (!file || !file.base64) { failed.push(inv); return; }
            var base = (inv.invoiceNo || file.fileName || ('发票-' + inv.id)).replace(/[\\/:*?"<>|]/g, '_');
            if (!/\.pdf$/i.test(base)) base += '.pdf';
            var name = base;
            var n = 2;
            while (used[name]) { name = base.replace(/\.pdf$/i, '') + '（' + n + '）.pdf'; n += 1; }
            used[name] = true;
            files.push({ name: name, bytes: base64ToBytes(file.base64), date: new Date(inv.createdAt || Date.now()) });
          }).catch(function () { failed.push(inv); });
        });
      });

      return chain.then(function () {
        if (!files.length) { UI.toast('一份发票都没取到，稍后再试', 'err'); return; }
        var stamp = new Date().toISOString().slice(0, 10);
        UI.downloadBytes('FEver发票-' + stamp + '.zip', global.FEVER.Zip.build(files), 'application/zip');
        var msg = '已打包 ' + files.length + ' 张发票';
        if (failed.length) msg += '，' + failed.length + ' 张取不到（可能是文件被清理了）';
        UI.toast(msg, failed.length ? 'warn' : 'ok');
      });
    }).catch(function (err) {
      UI.toast((err && err.message) || '打包失败', 'err');
    });
  }

  /** 发票详情弹窗：能看到来源申请与生成的物品，三者互相可跳 */  function openInvoiceDialog(invoiceId) {
    DB.get('invoices', invoiceId).then(function (inv) {
      if (!inv) { UI.toast('找不到这张发票', 'err'); return; }
      Stats.requestOfInvoice(inv).then(function (rel) {
        Stats.itemsOfInvoice(invoiceId).then(function (items) {
          UI.openModal({
            title: '发票 ' + (inv.invoiceNo || inv.fileName || ('#' + inv.id)),
            wide: true,
            body:
              '<table class="grid"><tbody>' +
                '<tr><th style="width:130px;background:#fafbfe">发票号码</th><td>' + UI.esc(inv.invoiceNo || '—') + '</td></tr>' +
                '<tr><th style="background:#fafbfe">供应商</th><td>' + UI.esc(inv.supplier || '-') + '</td></tr>' +
                '<tr><th style="background:#fafbfe">金额</th><td>' + UI.esc(num(inv.amount).toFixed(2)) + ' 元</td></tr>' +
                '<tr><th style="background:#fafbfe">发票日期</th><td>' + UI.esc(inv.invoiceDate || '-') + '</td></tr>' +
                '<tr><th style="background:#fafbfe">登记时间</th><td>' + UI.esc(UI.fmtTime(inv.createdAt)) + '</td></tr>' +
                '<tr><th style="background:#fafbfe">发票 PDF</th><td>' +
                  ((inv.fileRef || inv.fileData)
                    ? '<button class="btn small primary" data-invoice-pdf="' + UI.esc(inv.id) + '" type="button">下载 ' +
                      UI.esc(inv.fileName || '发票.pdf') + '</button>'
                    : '<span class="hint">登记时没有上传 PDF</span>') +
                '</td></tr>' +
                '<tr><th style="background:#fafbfe">来源采购申请</th><td>' +
                  (rel.missing
                    ? '<span class="badge-pill pill-warn">来源已删除</span>（原申请 #' + UI.esc(inv.purchaseRequestId) + '）'
                    : '<button class="btn small" data-goto-purchase="' + UI.esc(rel.request.id) + '" type="button">#' +
                      UI.esc(rel.request.id) + ' ' + UI.esc(rel.request.name) + '（' + UI.esc(rel.request.applicant || '-') + ' 申请）</button>') +
                '</td></tr>' +
                '<tr><th style="background:#fafbfe">生成的物品</th><td>' +
                  (items.length ? items.map(function (it) {
                    return '<button class="btn small" data-goto-item="' + UI.esc(it.code) + '" type="button">' +
                      UI.esc(it.code) + ' ' + UI.esc(it.name) + '</button>';
                  }).join(' ') : '<span class="hint">没有对应物品</span>') +
                '</td></tr>' +
              '</tbody></table>'
          });
        });
      });
    });
  }

  /** 采购申请详情弹窗 */
  function openPurchaseDialog(requestId) {
    Promise.all([
      DB.get('purchaseRequests', requestId),
      DB.getAll('categories'),
      DB.getAll('items'),
      DB.getAll('invoices')
    ]).then(function (arr) {
      var req = arr[0];
      if (!req) { UI.toast('找不到这条采购申请', 'err'); return; }
      var cat = arr[1].filter(function (c) { return c.id === req.categoryId; })[0];
      var mine = arr[2].filter(function (i) { return i.purchaseRequestId === requestId; });
      var inv = arr[3].filter(function (v) { return v.purchaseRequestId === requestId; })[0];
      UI.openModal({
                title: '采购申请 #' + req.id,
                wide: true,
                body:
                  '<table class="grid"><tbody>' +
                    '<tr><th style="width:130px;background:#fafbfe">物品</th><td>' + UI.esc(req.name) +
                      (req.spec ? '<div class="hint">' + UI.esc(req.spec) + '</div>' : '') + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">大类</th><td>' + UI.esc(cat ? cat.name : req.categoryId) + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">兵种</th><td>' +
                      (Rules.troopOf(req)
                        ? '<span class="badge-pill pill-info">' + UI.esc(Rules.troopOf(req)) + '</span>'
                        : '<span class="hint">未指定</span>') + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">数量 / 预算</th><td>' + UI.esc(num(req.quantity)) + ' 个 / ' +
                      UI.esc(req.budget || '-') + ' 元</td></tr>' +
                    '<tr><th style="background:#fafbfe">申请人</th><td>' + UI.esc(req.applicant || '-') + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">用途</th><td>' + UI.esc(req.purpose || '-') + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">状态</th><td>' +
                      UI.esc(Rules.INVOICE_STATUS_NAMES[req.status] || req.status) + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">提交时间</th><td>' + UI.esc(UI.fmtTime(req.createdAt)) + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">发票</th><td>' +
                      (inv ? '<button class="btn small" data-goto-invoice="' + UI.esc(inv.id) + '" type="button">' +
                        UI.esc(Rules.invoiceLabel(inv)) + '</button>' : '<span class="hint">未到货</span>') + '</td></tr>' +
                    '<tr><th style="background:#fafbfe">生成的物品</th><td>' +
                      (mine.length ? mine.map(function (it) {
                        return '<button class="btn small" data-goto-item="' + UI.esc(it.code) + '" type="button">' +
                          UI.esc(it.code) + '</button>';
                      }).join(' ') : '<span class="hint">还没有入库</span>') + '</td></tr>' +
                  '</tbody></table>'
      });
    });
  }

  /** 编辑物品（改名称、规格、位置、安全库存、备注、专属字段；编码不可改） */
  function openEditItem(code) {
    DB.get('items', code).then(function (item) {
      if (!item) { UI.toast('找不到该物品', 'err'); return; }
      DB.get('categories', item.categoryId).then(function (cat) {
        var special = (cat && cat.extraFields || []).map(function (f) {
          var value = (item.extra || {})[f.key] || '';
          if (f.type === 'select') {
            return UI.field({
              label: f.label, name: 'x-' + f.key, type: 'select',
              options: [''].concat(f.options || []).map(function (opt) {
                return { value: opt, label: opt === '' ? '（未填）' : opt };
              }),
              value: value
            });
          }
          return UI.field({ label: f.label, name: 'x-' + f.key, type: f.type || 'text', value: value });
        }).join('');

        var m = UI.openModal({
          title: '编辑物品　·　' + item.code,
          wide: true,
          body: '<div class="alert-item info" style="margin-bottom:12px"><span>编码 ' + UI.esc(item.code) +
            ' 是这件物品的身份，已经贴好的标签不会失效，所以不能改。</span></div>' +
            '<div class="form-grid">' +
              UI.field({ label: '物品名称', name: 'name', required: true, value: item.name }) +
              UI.field({ label: '规格 / 型号', name: 'spec', value: item.spec || '' }) +
              UI.field({ label: '存放位置', name: 'location', value: item.location || '' }) +
              UI.field({ label: '兵种', name: 'troop', type: 'select',
                options: [{ value: '', label: '（未指定）' }].concat(Rules.TROOPS.map(function (t) {
                  return { value: t, label: t, selected: t === Rules.troopOf(item) };
                })),
                value: Rules.troopOf(item),
                hint: '影响兵种预算的归属；改这里不会动采购申请上的兵种' }) +
              UI.field({ label: '安全库存', name: 'safetyStock', type: 'number', min: 0,
                value: item.safetyStock === null || item.safetyStock === undefined ? '' : item.safetyStock }) +
              UI.field({ label: '备注', name: 'remark', type: 'textarea', full: true, value: item.remark || '' }) +
            '</div>' +
            (special ? '<hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">' +
              '<h4 style="margin:0 0 10px">' + UI.esc(cat.name) + '专属属性</h4><div class="form-grid">' + special + '</div>' : ''),
          footer: '<button class="btn" data-cancel type="button">取消</button>' +
            '<button class="btn primary" data-ok type="button">保存</button>'
        });

        m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
        m.el.querySelector('[data-ok]').addEventListener('click', function () {
          var mask = m.el;
          var name = UI.val(mask, 'name');
          if (!name) { UI.toast('物品名称不能为空', 'warn'); return; }
          var draft = JSON.parse(JSON.stringify(item));
          draft.name = name;
          draft.spec = UI.val(mask, 'spec');
          draft.location = UI.val(mask, 'location');
          draft.troop = Rules.normalizeTroop(UI.val(mask, 'troop'));
          var safety = UI.val(mask, 'safetyStock');
          draft.safetyStock = safety === '' ? null : num(safety);
          draft.remark = UI.val(mask, 'remark');
          draft.extra = draft.extra || {};
          UI.qsa('[name^="x-"]', mask).forEach(function (node) {
            draft.extra[node.name.slice(2)] = String(node.value).trim();
          });
          draft.updatedAt = DB.nowIso();
          DB.put('items', draft).then(function () {
            m.close();
            UI.toast('已保存', 'ok');
            return refresh();
          }).catch(function (err) { UI.toast(Forms.failMessage(err), 'err'); });
        });
      });
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    bindGlobalEvents();
    UI.qs('#brand-home').addEventListener('click', function () { goto('home'); });
    Rules.initCategories().then(function () {
      requestedRoute = hashToRoute(global.location.hash);
      render(requestedRoute);
    }).catch(function (err) {
      console.error(err);
      UI.qs('#view-root').innerHTML = '<div class="panel"><div class="panel-body">' +
        '<div class="alert-item danger"><span class="who">启动失败</span><span>' +
        '无法打开本机数据库：' + UI.esc(err && err.message ? err.message : String(err)) +
        '。请确认是通过「启动」按钮打开的页面，而不是直接双击网页文件。</span></div></div></div>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.FEVER.App = {
    goto: goto, refresh: refresh,
    exportBackup: doExportBackup, importBackup: doImportBackup,
    importFromText: importFromText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
