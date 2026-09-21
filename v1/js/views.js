/**
 * FEver 战队物资管理 —— 页面视图
 *
 * 每个页面都是一个函数，返回 { title, crumb, html, onMount }。
 * app.js 负责切换页面，这里只负责"画出这一页长什么样"。
 */
(function (global) {
  'use strict';

  var UI = global.FEVER.UI;
  var DB = global.FEVER.DB;
  var Rules = global.FEVER.Rules;
  var Ops = global.FEVER.Ops;
  var Stats = global.FEVER.Stats;

  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  function categoryOf(summaries, id) {
    for (var i = 0; i < summaries.length; i += 1) {
      if (summaries[i].category.id === id) return summaries[i];
    }
    return null;
  }

  function moduleOf(id) {
    return (global.FEVER.Modules || {})[id] || null;
  }

  /* ================= 首页 ================= */

  function home() {
    return Stats.categorySummaries().then(function (summaries) {
      var today = UI.todayStr();
      return DB.runTx(['transactions', 'items', 'purchaseRequests'], 'readonly', function (T) {
        return T.getAll('transactions').then(function (txns) {
          return T.getAll('items').then(function (items) {
            return T.getAll('purchaseRequests').then(function (reqs) {
              var nameOf = {};
              items.forEach(function (i) { nameOf[i.code] = i.name; });
              var recent = txns.slice().sort(function (a, b) {
                return String(b.createdAt).localeCompare(String(a.createdAt)) || (num(b.id) - num(a.id));
              }).slice(0, 10);

              var pendingCount = reqs.filter(function (r) {
                return r.status === 'pending' || r.status === 'ordered';
              }).length;

              var allAlerts = [];
              summaries.forEach(function (s) {
                s.reminders.forEach(function (r) {
                  allAlerts.push({ code: r.code, name: r.name, level: r.level, text: r.text, category: s.category.name });
                });
              });

              var cards = summaries.map(function (s) {
                var mod = moduleOf(s.category.id);
                var metrics = [
                  { label: '在库件数', value: s.inStockQty },
                  { label: '种类', value: s.itemKinds }
                ].concat(mod && mod.cardMetrics ? mod.cardMetrics(s) : [
                  { label: '借出', value: s.lentKinds },
                  { label: '待修', value: s.repairKinds }
                ]);

                return '<div class="cat-card" data-goto-category="' + UI.esc(s.category.id) + '">' +
                  '<div class="cat-card-head">' +
                    '<span class="cat-icon">' + UI.esc(s.category.icon) + '</span>' +
                    '<div><div class="cat-name">' + UI.esc(s.category.name) + '</div>' +
                    '<div class="cat-desc">' + UI.esc(s.category.description) + '</div></div>' +
                  '</div>' +
                  '<div class="cat-metrics">' +
                    metrics.slice(0, 4).map(function (m) {
                      return '<div class="metric' + (m.alert ? ' alert' : '') + '">' +
                        '<div class="metric-value">' + UI.esc(m.value) + '</div>' +
                        '<div class="metric-label">' + UI.esc(m.label) + '</div></div>';
                    }).join('') +
                  '</div>' +
                  '<div class="cat-desc">' + UI.esc(mod && mod.summaryLine ? mod.summaryLine(s) : '') + '</div>' +
                '</div>';
              }).join('');

              var html =
                '<div class="page-head">' +
                  '<div><h1 class="page-title">物资总览</h1>' +
                  '<p class="page-sub">今天 ' + UI.esc(today) + '　·　数据存在本机，关掉浏览器也不会丢</p></div>' +
                  '<div class="page-actions">' +
                    '<button class="btn primary" data-act="new-purchase" type="button">新建采购申请</button>' +
                    '<button class="btn" data-act="new-inbound" type="button">直接入库</button>' +
                    '<button class="btn" data-goto="desk" type="button">出入库登记</button>' +
                  '</div>' +
                '</div>' +
                '<div class="cat-grid">' + cards + '</div>' +
                (pendingCount ? '<div class="panel" style="margin-top:16px"><div class="panel-body">' +
                  '<div class="alert-item info"><span class="who">采购</span>' +
                  '<span>有 ' + pendingCount + ' 条采购申请还没到货</span>' +
                  '<button class="btn small ghost" data-goto="purchases" type="button">去看看</button></div>' +
                  '</div></div>' : '') +
                '<div class="panel" style="margin-top:16px">' +
                  '<div class="panel-head"><h3 class="panel-title">需要注意（' + allAlerts.length + '）</h3></div>' +
                  '<div class="panel-body">' + (allAlerts.length
                    ? UI.alertBar(allAlerts.slice(0, 8))
                    : '<div class="empty">暂时没有需要注意的事</div>') + '</div>' +
                '</div>' +
                '<div class="panel">' +
                  '<div class="panel-head"><h3 class="panel-title">最近动态</h3>' +
                  '<button class="btn small" data-goto="txns" type="button">全部记录</button></div>' +
                  '<div class="panel-body tight">' +
                  (recent.length ? UI.table([
                    { label: '时间', render: function (t) { return UI.esc(UI.fmtTime(t.createdAt)); } },
                    { label: '动作', render: function (t) {
                        return '<span class="badge-pill pill-info">' + UI.esc(Rules.TXN_TYPES[t.type] || t.type) + '</span>'; } },
                    { label: '物品', render: function (t) {
                        return '<span class="code-cell" data-goto-item="' + UI.esc(t.itemCode) + '">' + UI.esc(t.itemCode) + '</span>' +
                          ' ' + UI.esc(nameOf[t.itemCode] || '(物品已不存在)'); } },
                    { label: '数量', num: true, render: function (t) { return UI.esc(num(t.qty)); } },
                    { label: '操作人', render: function (t) { return UI.esc(t.operator || '-'); } },
                    { label: '用途 / 借用', render: function (t) {
                        return UI.esc(t.borrower ? '借给 ' + t.borrower : (t.purpose || '-')); } }
                  ], recent) : '<div class="empty">还没有任何记录，先点上面的「直接入库」建一件物品</div>') +
                  '</div>' +
                '</div>';

              return { title: '物资总览', crumb: [], html: html };
            });
          });
        });
      });
    });
  }

  /* ================= 大类页 ================= */

  function category(params) {
    var catId = params.id;
    return Stats.categorySummaries().then(function (summaries) {
      var s = categoryOf(summaries, catId);
      if (!s) {
        return { title: '找不到大类', crumb: [{ label: '物资总览', goto: 'home' }], html: '<div class="empty">没有这个大类</div>' };
      }
      var mod = moduleOf(catId);
      var cat = s.category;

      var html =
        '<div class="page-head">' +
          '<div><h1 class="page-title">' + UI.esc(cat.icon) + ' ' + UI.esc(cat.name) + '</h1>' +
          '<p class="page-sub">' + UI.esc(mod && mod.summaryLine ? mod.summaryLine(s) : '') + '</p></div>' +
          '<div class="page-actions">' +
            '<button class="btn primary" data-act="new-item" data-cat="' + UI.esc(catId) + '" type="button">新增物品</button>' +
            '<button class="btn" data-act="new-purchase" data-cat="' + UI.esc(catId) + '" type="button">提采购申请</button>' +
            '<button class="btn" data-act="print-labels" data-cat="' + UI.esc(catId) + '" type="button">批量打印标签</button>' +
          '</div>' +
        '</div>' +
        (s.reminders.length ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">' +
          UI.esc(cat.name) + '需要注意（' + s.reminders.length + '）</h3></div>' +
          '<div class="panel-body">' + UI.alertBar(s.reminders.slice(0, 6)) + '</div></div>' : '') +
        (mod && mod.workspace ? mod.workspace(s, cat, new Date()) : '') +
        '<div class="panel">' +
          '<div class="panel-head"><h3 class="panel-title">筛选</h3>' +
            '<button class="btn small" data-act="reset-filter" type="button">清空条件</button></div>' +
          '<div class="panel-body"><div class="filters" id="cat-filters">' +
            '<div class="field"><label>关键字</label>' +
              '<input class="input" name="f-keyword" placeholder="名称 / 编码 / 规格 / 位置" data-filter="common"></div>' +
            (mod && mod.filterControls ? mod.filterControls() : '') +
            '<div class="field"><label>状态</label>' +
              '<select class="select" name="f-status" data-filter="common">' +
                '<option value="">全部</option>' +
                '<option value="in_stock">在库</option>' +
                '<option value="lent">有借出</option>' +
                '<option value="repairing">有损坏待修</option>' +
                '<option value="used_up">已用完</option>' +
              '</select></div>' +
          '</div></div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3 class="panel-title">物品清单</h3>' +
            '<span class="page-sub" id="cat-count"></span></div>' +
          '<div class="panel-body tight" id="cat-table"></div>' +
        '</div>';

      function onMount(root) {
        var state = {};
        function render() {
          var all = s.items;
          var filtered = all.filter(function (item) {
            var kw = state['f-keyword'];
            if (kw) {
              var hay = [item.code, item.name, item.spec, item.location].join(' ').toLowerCase();
              if (hay.indexOf(kw.toLowerCase()) === -1) return false;
            }
            var st = state['f-status'];
            if (st === 'in_stock' && num(item.inStockQty) <= 0) return false;
            if (st === 'lent' && num(item.lentQty) <= 0) return false;
            if (st === 'repairing' && num(item.repairQty) <= 0) return false;
            if (st === 'used_up' && num(item.inStockQty) + num(item.lentQty) + num(item.repairQty) > 0) return false;
            if (mod && mod.matches && !mod.matches(item, state)) return false;
            return true;
          });

          var columns = [
            { label: '编码', render: function (i) {
                return '<span class="code-cell" data-goto-item="' + UI.esc(i.code) + '">' + UI.esc(i.code) + '</span>'; } },
            { label: '名称', render: function (i) {
                return UI.esc(i.name) + (i.spec ? '<div class="hint">' + UI.esc(i.spec) + '</div>' : ''); } },
            { label: '身份', render: function (i) { return UI.identityPill(i.identityMode); } },
            { label: '状态', render: function (i) { return UI.statusPill(i.status); } },
            { label: '在库', num: true, render: function (i) { return UI.esc(num(i.inStockQty)); } },
            { label: '借出', num: true, render: function (i) { return UI.esc(num(i.lentQty)); } },
            { label: '待修', num: true, render: function (i) { return UI.esc(num(i.repairQty)); } },
            { label: '位置', render: function (i) { return UI.esc(i.location || '-'); } }
          ].concat(mod && mod.listColumns ? mod.listColumns() : []);

          columns.push({
            label: '操作',
            render: function (i) {
              return '<button class="btn small" data-goto-item="' + UI.esc(i.code) + '" type="button">详情</button>' +
                ' <button class="btn small" data-print-item="' + UI.esc(i.code) + '" type="button">标签</button>';
            }
          });

          UI.qs('#cat-table', root).innerHTML = UI.table(columns, filtered, {
            emptyText: all.length ? '没有符合筛选条件的物品' : '这一类还没有物品，点右上角「新增物品」开始'
          });
          UI.qs('#cat-count', root).textContent = '显示 ' + filtered.length + ' / ' + all.length + ' 种';
        }

        root.addEventListener('input', function (e) {
          var name = e.target.getAttribute && e.target.getAttribute('name');
          if (!name) return;
          state[name] = String(e.target.value).trim();
          render();
        });
        root.addEventListener('change', function (e) {
          var name = e.target.getAttribute && e.target.getAttribute('name');
          if (!name) return;
          state[name] = String(e.target.value).trim();
          render();
        });
        var resetBtn = root.querySelector('[data-act="reset-filter"]');
        if (resetBtn) {
          resetBtn.addEventListener('click', function () {
            UI.qsa('#cat-filters [name]', root).forEach(function (node) { node.value = ''; });
            state = {};
            render();
          });
        }
        render();
      }

      return {
        title: cat.name,
        crumb: [{ label: '物资总览', goto: 'home' }, { label: cat.name }],
        html: html,
        onMount: onMount
      };
    });
  }

  /* ================= 物品详情 ================= */

  function itemDetail(params) {
    var code = params.code;
    return Stats.itemContext(code).then(function (ctx) {
      if (!ctx) {
        return {
          title: '找不到物品',
          crumb: [{ label: '物资总览', goto: 'home' }],
          html: '<div class="empty">没有找到编码为 ' + UI.esc(code) + ' 的物品</div>'
        };
      }
      var item = ctx.item;
      var cat = ctx.category;
      var mod = cat ? moduleOf(cat.id) : null;
      var payload = Rules.qrPayload(item.code);

      var html =
        '<div class="page-head">' +
          '<div><h1 class="page-title">' + UI.esc(item.name) + '</h1>' +
          '<p class="page-sub"><span class="code-cell" data-copy="' + UI.esc(item.code) + '">' + UI.esc(item.code) + '</span>' +
          '　·　' + UI.esc(cat ? cat.name : '未知大类') + '　·　' + UI.esc(item.spec || '无规格') + '</p></div>' +
          '<div class="page-actions">' +
            '<button class="btn" data-print-item="' + UI.esc(item.code) + '" type="button">打印标签</button>' +
            '<button class="btn" data-goto="desk" type="button">出入库登记</button>' +
            '<button class="btn" data-act="edit-item" data-code="' + UI.esc(item.code) + '" type="button">编辑</button>' +
          '</div>' +
        '</div>' +
        '<div class="panel"><div class="panel-body">' +
          '<div style="display:flex;gap:24px;flex-wrap:wrap">' +
            '<div style="flex:0 0 auto">' +
              '<div class="qr-box"><div id="qr-holder" data-qr="' + UI.esc(payload) + '"></div>' +
              '<div class="qr-meta"><div class="qr-payload">' + UI.esc(payload) + '</div></div></div>' +
            '</div>' +
            '<div style="flex:1 1 420px;min-width:320px">' +
              '<table class="grid"><tbody>' +
                '<tr><th style="width:130px;background:#fafbfe">状态</th><td>' + UI.statusPill(item.status) +
                  (num(item.inStockQty) + num(item.lentQty) + num(item.repairQty) === 0 ? ' <span class="badge-pill pill-warn">需要补货</span>' : '') + '</td></tr>' +
                '<tr><th style="background:#fafbfe">身份</th><td>' + UI.identityPill(item.identityMode) + '</td></tr>' +
                '<tr><th style="background:#fafbfe">数量</th><td>总数 ' + UI.esc(num(item.totalQty)) +
                  '（在库 ' + UI.esc(num(item.inStockQty)) + ' / 借出 ' + UI.esc(num(item.lentQty)) +
                  ' / 待修 ' + UI.esc(num(item.repairQty)) + ' / 已领用 ' + UI.esc(num(item.usedUpQty)) + '）</td></tr>' +
                '<tr><th style="background:#fafbfe">存放位置</th><td>' + UI.esc(item.location || '-') + '</td></tr>' +
                '<tr><th style="background:#fafbfe">安全库存</th><td>' +
                  UI.esc(item.safetyStock === null || item.safetyStock === undefined || item.safetyStock === '' ? '未设置' : item.safetyStock) + '</td></tr>' +
                '<tr><th style="background:#fafbfe">入库时间</th><td>' + UI.esc(UI.fmtTime(item.createdAt)) + '</td></tr>' +
                '<tr><th style="background:#fafbfe">备注</th><td>' + UI.esc(item.remark || '-') + '</td></tr>' +
              '</tbody></table>' +
            '</div>' +
          '</div>' +
          (mod && mod.detailSections ? mod.detailSections(item, cat) : '') +
        '</div></div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3 class="panel-title">来源单据</h3></div>' +
          '<div class="panel-body">' +
            (item.purchaseRequestId || item.invoiceId
              ? '<table class="grid"><tbody>' +
                  '<tr><th style="width:130px;background:#fafbfe">采购申请</th><td>' +
                    (ctx.purchaseMissing
                      ? '<span class="badge-pill pill-warn">来源已删除</span>（原申请 #' + UI.esc(item.purchaseRequestId) + '）'
                      : (ctx.purchaseRequest
                          ? '<button class="btn small" data-goto-purchase="' + UI.esc(ctx.purchaseRequest.id) + '" type="button">#' +
                            UI.esc(ctx.purchaseRequest.id) + ' ' + UI.esc(ctx.purchaseRequest.name) + '</button> 申请人 ' +
                            UI.esc(ctx.purchaseRequest.applicant || '-') + '，预算 ' + UI.esc(ctx.purchaseRequest.budget || '-')
                          : '-')) + '</td></tr>' +
                  '<tr><th style="background:#fafbfe">发票</th><td>' +
                    (ctx.invoiceMissing
                      ? '<span class="badge-pill pill-warn">来源已删除</span>'
                      : (ctx.invoice
                          ? '<button class="btn small" data-goto-invoice="' + UI.esc(ctx.invoice.id) + '" type="button">' +
                            UI.esc(ctx.invoice.invoiceNo) + '</button> ' + UI.esc(ctx.invoice.supplier) +
                            '，金额 ' + UI.esc(ctx.invoice.amount) + ' 元，' + UI.esc(ctx.invoice.invoiceDate || '无日期')
                          : '-')) + '</td></tr>' +
                '</tbody></table>'
              : '<div class="empty">这件物品不是采购到货入库的</div>') +
          '</div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3 class="panel-title">出入库履历（' + ctx.transactions.length + '）</h3></div>' +
          '<div class="panel-body tight">' +
          (ctx.transactions.length ? UI.table([
            { label: '时间', render: function (t) { return UI.esc(UI.fmtTime(t.createdAt)); } },
            { label: '动作', render: function (t) {
                return '<span class="badge-pill pill-info">' + UI.esc(Rules.TXN_TYPES[t.type] || t.type) + '</span>'; } },
            { label: '数量', num: true, render: function (t) { return UI.esc(num(t.qty)); } },
            { label: '操作人', render: function (t) { return UI.esc(t.operator || '-'); } },
            { label: '借用人', render: function (t) { return UI.esc(t.borrower || '-'); } },
            { label: '预计归还', render: function (t) { return UI.esc(t.dueDate || '-'); } },
            { label: '用途 / 说明', render: function (t) { return UI.esc(t.purpose || '-'); } },
            { label: '操作后在库', num: true, render: function (t) {
                return UI.esc(t.snapshotInStock === undefined || t.snapshotInStock === null ? '-' : t.snapshotInStock); } }
          ], ctx.transactions) : '<div class="empty">还没有出入库记录</div>') +
          '</div>' +
        '</div>';

      function onMount(root) {
        global.FEVER.QR.render(root.querySelector('#qr-holder'));
      }

      return {
        title: item.name,
        crumb: [
          { label: '物资总览', goto: 'home' },
          { label: cat ? cat.name : '未知', goto: 'category', params: { id: cat ? cat.id : '' } },
          { label: item.code }
        ],
        html: html,
        onMount: onMount
      };
    });
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Views = {
    home: home,
    category: category,
    itemDetail: itemDetail
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
