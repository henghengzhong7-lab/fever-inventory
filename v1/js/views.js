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
          '<div class="panel-body tight">' +
            // 批量操作条。默认全部禁用，勾了东西才亮 —— 免得有人先点按钮再找东西勾。
            '<div class="batch-bar no-print">' +
              '<label class="batch-all"><input type="checkbox" id="cat-check-all"> 全选当前筛选结果</label>' +
              '<span class="batch-info" id="cat-selected">已选 0 件</span>' +
              '<button class="btn small" id="cat-batch-print" type="button" disabled>批量打印标签</button>' +
              '<button class="btn small danger" id="cat-batch-del" type="button" disabled>批量删除</button>' +
              '<button class="btn small ghost" id="cat-batch-clear" type="button" disabled>清空选择</button>' +
            '</div>' +
            '<div id="cat-table"></div>' +
          '</div>' +
        '</div>';

      function onMount(root) {
        var state = {};
        /**
         * 勾选的物品编码。用数组而不是 Set，是为了**记住勾选顺序** ——
         * 批量打印标签按这个顺序出，撕下来挨着贴的时候才对得上。
         */
        var picked = [];
        /** 当前筛选后真正显示出来的行，「全选」全选的是你看到的这批，不是全部 */
        var lastFiltered = [];

        function syncBatchBar() {
          var info = root.querySelector('#cat-selected');
          if (info) info.textContent = '已选 ' + picked.length + ' 件';
          ['#cat-batch-print', '#cat-batch-del', '#cat-batch-clear'].forEach(function (sel) {
            var btn = root.querySelector(sel);
            if (btn) btn.disabled = picked.length === 0;
          });
          var allBox = root.querySelector('#cat-check-all');
          if (allBox) {
            var hit = lastFiltered.filter(function (i) { return picked.indexOf(i.code) !== -1; }).length;
            allBox.checked = lastFiltered.length > 0 && hit === lastFiltered.length;
            allBox.indeterminate = hit > 0 && hit < lastFiltered.length;
          }
        }

        function togglePick(code, on) {
          var at = picked.indexOf(code);
          if (on && at === -1) picked.push(code);
          else if (!on && at !== -1) picked.splice(at, 1);
          syncBatchBar();
        }

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
            // 勾选列放最前面。勾选状态由 picked 决定而不是由 DOM 决定 ——
            // 筛选一变整张表会重画，靠 DOM 记状态会全丢。
            { label: '', cls: 'pick', render: function (i) {
                return '<input type="checkbox" class="row-pick" data-pick="' + UI.esc(i.code) + '"' +
                  (picked.indexOf(i.code) !== -1 ? ' checked' : '') + ' aria-label="选中 ' + UI.esc(i.code) + '">'; } },
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
          lastFiltered = filtered;
          syncBatchBar();
        }

        root.addEventListener('input', function (e) {
          var name = e.target.getAttribute && e.target.getAttribute('name');
          if (!name) return;
          state[name] = String(e.target.value).trim();
          render();
        });
        root.addEventListener('change', function (e) {
          // 先处理行勾选框：它没有 name，会被下面那段挡掉
          var pick = e.target.getAttribute && e.target.getAttribute('data-pick');
          if (pick) { togglePick(pick, !!e.target.checked); return; }

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

        // ---- 批量操作条 ----
        var allBox = root.querySelector('#cat-check-all');
        if (allBox) {
          allBox.addEventListener('change', function () {
            if (allBox.checked) {
              // 只把"当前看得见的这批"加进来，不清掉之前勾的 ——
              // 换个筛选条件再勾是常见用法，默默清空会让人丢选。
              lastFiltered.forEach(function (i) {
                if (picked.indexOf(i.code) === -1) picked.push(i.code);
              });
            } else {
              picked = [];
            }
            render();
          });
        }
        var printBtn = root.querySelector('#cat-batch-print');
        if (printBtn) {
          printBtn.addEventListener('click', function () {
            if (!picked.length) return;
            // 选中集合走地址栏（见 app.js 的 routeToHash）：刷新、后退、转发链接都还在
            global.FEVER.App.goto('labels', { codes: picked.slice() });
          });
        }
        var delBtn = root.querySelector('#cat-batch-del');
        if (delBtn) {
          delBtn.addEventListener('click', function () {
            if (!picked.length) return;
            global.FEVER.Forms.deleteItemsBatch(picked.slice(), {
              onDone: function () {
                picked = [];
                global.FEVER.App.refresh();
              }
            });
          });
        }
        var clearBtn = root.querySelector('#cat-batch-clear');
        if (clearBtn) {
          clearBtn.addEventListener('click', function () {
            picked = [];
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

      // 删除按钮：还有实物借在外面或待修时**不画成可点的**。
      // 这类物品删掉之后，那几件东西就没人认领了 —— 数量对不上，也再查不到是谁借的。
      // 这里只是"看起来不能点"，真正的拦截在 Rules.blockItemDeletion（见 actions.js）。
      var blockReason = Rules.blockItemDeletion(item);
      var deleteBtn = blockReason
        ? '<button class="btn danger" type="button" disabled title="' + UI.esc(blockReason) + '">删除</button>'
        : '<button class="btn danger" data-del-item="' + UI.esc(item.code) +
          '" data-del-back="' + UI.esc(item.categoryId || '') + '" type="button" ' +
          'title="删除这件物品身份，并记入删除记录">删除</button>';

      var html =
        '<div class="page-head">' +
          '<div><h1 class="page-title">' + UI.esc(item.name) + '</h1>' +
          '<p class="page-sub"><span class="code-cell" data-copy="' + UI.esc(item.code) + '">' + UI.esc(item.code) + '</span>' +
          '　·　' + UI.esc(cat ? cat.name : '未知大类') + '　·　' + UI.esc(item.spec || '无规格') + '</p></div>' +
          '<div class="page-actions">' +
            '<button class="btn" data-print-item="' + UI.esc(item.code) + '" type="button">打印标签</button>' +
            '<button class="btn" data-goto="desk" type="button">出入库登记</button>' +
            '<button class="btn" data-act="edit-item" data-code="' + UI.esc(item.code) + '" type="button">编辑</button>' +
            deleteBtn +
          '</div>' +
        '</div>' +
        '<div class="panel"><div class="panel-body">' +
          '<div class="detail-row">' +
            '<div class="detail-qr">' +
              '<div class="qr-box"><div id="qr-holder" data-qr="' + UI.esc(payload) + '"></div>' +
              '<div class="qr-meta"><div class="qr-payload">' + UI.esc(payload) + '</div></div></div>' +
            '</div>' +
            '<div class="detail-fields">' +
              '<table class="grid"><tbody>' +
                '<tr><th style="width:130px;background:#fafbfe">状态</th><td>' + UI.statusPill(item.status) +
                  (num(item.inStockQty) + num(item.lentQty) + num(item.repairQty) === 0 ? ' <span class="badge-pill pill-warn">需要补货</span>' : '') + '</td></tr>' +
                '<tr><th style="background:#fafbfe">身份</th><td>' + UI.identityPill(item.identityMode) + '</td></tr>' +
                '<tr><th style="background:#fafbfe">兵种</th><td>' +
                  (Rules.troopOf(item)
                    ? '<span class="badge-pill pill-info">' + UI.esc(Rules.troopOf(item)) + '</span>'
                    : '<span class="hint">未指定</span>') + '</td></tr>' +
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
                            UI.esc(Rules.invoiceLabel(ctx.invoice)) + '</button> ' + UI.esc(ctx.invoice.supplier || '-') +
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

  /* ================= 扫码查物（第二版手机端） ================= */

  /**
   * 扫码查物。
   *
   * 手机上打开应用，第一件事多半是「扫一下，看这件东西还在不在、放在哪、借给谁了」，
   * 所以要一步到位：扫码 → 立刻看到状态 / 位置 / 借出信息，还能顺手登记。
   *
   * 数据一律走 Stats.itemContext —— 和电脑端物品详情页**同一个入口**。
   * 这是"手机版和电脑版数据保持一致"真正的落点：不是两边各算一遍再想办法对齐，
   * 而是根本只有一份算法、一份数据，想不一致都难。
   */
  function scan(params) {
    var raw = (params && params.code) ? String(params.code) : '';
    var Scanner = global.FEVER.Scanner;
    // 没有扫码模块也要能用这一页（比如测试页只引了 views.js）：
    // 少了「开始扫码」按钮，手工输编码照样查得到。
    var canScan = !!(Scanner && Scanner.scan);
    var sources = (Scanner && Scanner.available) ? Scanner.available() : [];
    var sourceHint = sources.length
      ? '可用方式：' + sources.map(function (s) { return s.label || s.name; }).join('、')
      : '当前环境不能直接开摄像头扫码（浏览器不支持，也不在飞书客户端里）。' +
        '可以手工输入编码，或用扫码枪扫 —— 结果是一样的。';

    /**
     * 「拍照 / 选图」单独做一个按钮。
     *
     * 为什么不能只靠自动降级：在飞书内置浏览器里，前面几条路（原生扫码、开摄像头）
     * 一旦失败，链子会一路降级到文件选择器 —— 那是在一串异步之后才弹出来的，
     * 有些手机系统会直接吃掉这个迟到的弹窗。而用户**亲手点**按钮触发的选择器
     * 永远弹得出来。所以最稳的那条兜底路要给一个直达入口。
     */
    var photoSource = null;
    if (Scanner && Scanner.sources) {
      Scanner.sources().forEach(function (s) {
        if (s.name === 'photo') {
          try { if (s.available()) photoSource = s; } catch (err) { /* 不可用就不给按钮 */ }
        }
      });
    }

    /**
     * 飞书扫码的准备情况（只在飞书里有内容；离线版没有这个模块，自然不显示）。
     *
     * 为什么要在页面上写出来：手机上报"扫不了"时，最缺的就是一句能直接念回来的
     * 具体原因 —— 是没配可信域名、还是签名没过、还是压根不在飞书客户端里。
     * 之前这些只进 console，手机上根本看不到。
     */
    function jsapiNote() {
      var jsapi = global.FEVER && global.FEVER.FeishuJsapi;
      if (!jsapi || !jsapi.state) return '';
      var st = jsapi.state;
      if (st.ok) return '飞书扫码：已就绪';
      if (st.stage === 'no-sdk') return '当前不在飞书客户端里（用下面的摄像头 / 拍照即可）';
      if (!st.done) return '飞书扫码：正在准备……';
      return '飞书扫码没就绪：' + (st.error || '未知原因');
    }

    var head =
      '<div class="page-head">' +
        '<div><h1 class="page-title">扫码查物</h1>' +
        '<p class="page-sub">扫物品标签上的二维码，立刻看到它在不在、放在哪、借给了谁。</p></div>' +
      '</div>';

    var panel =
      '<div class="panel"><div class="panel-body">' +
        (canScan
          ? '<div class="scan-start-row">' +
              '<button class="btn primary scan-start" id="scan-start" type="button">开始扫码</button>' +
              (photoSource
                ? '<button class="btn scan-photo" id="scan-photo" type="button">拍照 / 选图</button>'
                : '') +
            '</div>'
          : '') +
        '<div class="inline-row">' +
          '<input class="input" id="scan-code" autocomplete="off" ' +
            'placeholder="也可以手工输入编码，如 MC-0001" value="' + UI.esc(raw) + '">' +
          '<button class="btn" id="scan-lookup" type="button">查询</button>' +
        '</div>' +
        '<div class="hint" id="scan-hint">' + UI.esc(sourceHint) + '</div>' +
        '<div class="hint scan-diag" id="scan-diag" hidden></div>' +
      '</div></div>';

    var crumb = [{ label: '物资总览', goto: 'home' }, { label: '扫码查物' }];

    function wire(root) {
      var input = root.querySelector('#scan-code');
      var hint = root.querySelector('#scan-hint');

      /** 扫到（或输入）的文本 → 解析 → 跳转；不合规就地提示，不跳 */
      function handleText(text) {
        if (!text) return;
        var code = Rules.parseQrPayload(text);
        if (!code) {
          UI.toast('这不是 FEver 的物品标签，没法定位到具体物品', 'warn');
          if (hint) hint.textContent = '扫到的内容是「' + text + '」，不是本系统的标签格式。';
          return;
        }
        global.FEVER.App.goto('scan', { code: code });
      }

      var startBtn = root.querySelector('#scan-start');
      if (startBtn && Scanner) {
        startBtn.addEventListener('click', function () {
          startBtn.disabled = true;
          if (hint) hint.textContent = '正在打开扫码……';
          Scanner.scan().then(function (text) {
            if (hint) hint.textContent = sourceHint;
            handleText(text);
          }).catch(function (err) {
            if (hint) hint.textContent = sourceHint;
            // 用户自己取消：不弹提示，当作什么都没发生，别拿红字怪他
            if (err && err.cancelled) return;
            UI.toast((err && err.message) ? err.message : '扫码失败', 'err');
          }).then(function () { startBtn.disabled = false; });
        });
      }

      function lookupFromInput() {
        handleText(input ? String(input.value || '').trim() : '');
      }
      var lookupBtn = root.querySelector('#scan-lookup');
      if (lookupBtn) lookupBtn.addEventListener('click', lookupFromInput);

      // 飞书鉴权是异步跑的，等它有个结果再把这一行刷出来
      var diag = root.querySelector('#scan-diag');
      function refreshDiag() {
        if (!diag) return;
        var note = jsapiNote();
        diag.textContent = note;
        diag.hidden = !note;
      }
      refreshDiag();
      var jsapi = global.FEVER && global.FEVER.FeishuJsapi;
      if (jsapi && jsapi.ready) jsapi.ready.then(refreshDiag, refreshDiag);

      var photoBtn = root.querySelector('#scan-photo');
      if (photoBtn && photoSource) {
        photoBtn.addEventListener('click', function () {
          photoBtn.disabled = true;
          if (hint) hint.textContent = '选一张标签照片……';
          photoSource.scan().then(function (text) {
            if (hint) hint.textContent = sourceHint;
            handleText(text);
          }).catch(function (err) {
            if (hint) hint.textContent = sourceHint;
            if (err && err.cancelled) return;
            UI.toast((err && err.message) ? err.message : '没能认出这张图', 'err');
          }).then(function () { photoBtn.disabled = false; });
        });
      }
      if (input) {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); lookupFromInput(); }
        });
      }

      // 快捷动作（借用 / 归还 / 送修）就地把结果登记掉，登记完原地刷新这一页
      var Forms = global.FEVER.Forms;
      UI.qsa('[data-scan-act]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = btn.getAttribute('data-scan-act');
          var itemCode = btn.getAttribute('data-code');
          DB.get('items', itemCode).then(function (item) {
            if (!item) { UI.toast('找不到这件物品', 'err'); return; }
            Forms.openActionDialog({
              action: action, item: item,
              onDone: function () { global.FEVER.App.refresh(); }
            });
          });
        });
      });
    }

    if (!raw) {
      return Promise.resolve({ title: '扫码查物', crumb: crumb, html: head + panel, onMount: wire });
    }

    var code = Rules.parseQrPayload(raw);
    if (!code) {
      return Promise.resolve({
        title: '扫码查物',
        crumb: crumb,
        html: head + panel +
          '<div class="panel"><div class="panel-body">' +
            '<div class="alert-item warn"><span class="who">这不是本系统的标签</span>' +
            '<span>扫到的内容没法解析成物品编码。请确认扫的是物品上那张标签，' +
            '或者手工输入编码（形如 MC-0001）。</span></div>' +
            '<div class="scan-raw">扫到的原始内容：<code>' + UI.esc(raw) + '</code></div>' +
          '</div></div>',
        onMount: wire
      });
    }

    return Promise.all([Stats.itemContext(code), Ops.lendLedger()]).then(function (arr) {
      var ctx = arr[0];
      var ledger = arr[1] || [];

      if (!ctx) {
        return {
          title: '扫码查物',
          crumb: crumb,
          html: head + panel +
            '<div class="panel"><div class="panel-body">' +
              '<div class="alert-item danger"><span class="who">没有找到 ' + UI.esc(code) + '</span>' +
              '<span>系统里没有这个编码的物品。可能是标签贴错了，或者这件物品已经被删除。' +
              '如果确实还在，请到「出入库登记」里重新入库。</span></div>' +
            '</div></div>',
          onMount: wire
        };
      }

      var item = ctx.item;
      var cat = ctx.category;
      // live 是"这件东西还没还的借出"，一件一笔（见 Ops.lendLedger 的说明）。
      // 计数以 item.lentQty 为准 —— 和电脑端物品详情页显示的是同一个数字，
      // 两边对不上时（比如有人删过流水）在下面明说，而不是各报各的。
      var live = ledger.filter(function (r) { return r.itemCode === item.code; });
      var liveQty = live.reduce(function (s, r) { return s + num(r.qty); }, 0);
      var lentQty = num(item.lentQty);
      var qty = num(item.inStockQty) + lentQty + num(item.repairQty);
      var last = ctx.transactions.length ? ctx.transactions[0] : null;

      var actions = [];
      if (num(item.inStockQty) > 0) actions.push({ act: 'lend', label: '借用' });
      if (num(item.lentQty) > 0) actions.push({ act: 'giveBack', label: '归还' });
      if (num(item.inStockQty) > 0) actions.push({ act: 'sendRepair', label: '送修' });
      if (num(item.repairQty) > 0) actions.push({ act: 'repairDone', label: '修好回库' });

      var html =
        head + panel +
        '<div class="panel"><div class="panel-body scan-result">' +
          '<div class="scan-head">' +
            '<div class="scan-name">' + UI.esc(item.name) + '</div>' +
            '<div class="scan-meta">' +
              '<span class="code-cell" data-copy="' + UI.esc(item.code) + '">' + UI.esc(item.code) + '</span>' +
              '　·　' + UI.esc(cat ? cat.name : '未知大类') +
              (item.spec ? '　·　' + UI.esc(item.spec) : '') +
            '</div>' +
          '</div>' +

          // 状态与位置是这张卡片的重点：扫完最想知道的就是这两件事
          '<div class="scan-status">' +
            UI.statusPill(item.status) +
            (qty === 0 ? ' <span class="badge-pill pill-warn">需要补货</span>' : '') +
          '</div>' +
          '<div class="scan-loc">' +
            '<div class="scan-loc-label">存放位置</div>' +
            '<div class="scan-loc-value' + (item.location ? '' : ' scan-loc-empty') + '">' +
              UI.esc(item.location || '没有登记位置') + '</div>' +
          '</div>' +

          '<table class="grid cols-2"><tbody>' +
            '<tr><th>数量</th><td>总数 ' + UI.esc(num(item.totalQty)) +
              '（在库 ' + UI.esc(num(item.inStockQty)) + ' / 借出 ' + UI.esc(num(item.lentQty)) +
              ' / 待修 ' + UI.esc(num(item.repairQty)) + ' / 已领用 ' + UI.esc(num(item.usedUpQty)) + '）</td></tr>' +
            '<tr><th>身份</th><td>' + UI.identityPill(item.identityMode) + '</td></tr>' +
            '<tr><th>兵种</th><td>' +
              (Rules.troopOf(item) ? '<span class="badge-pill pill-info">' + UI.esc(Rules.troopOf(item)) + '</span>'
                : '<span class="hint">未指定</span>') + '</td></tr>' +
            '<tr><th>安全库存</th><td>' +
              UI.esc(item.safetyStock === null || item.safetyStock === undefined || item.safetyStock === ''
                ? '未设置' : item.safetyStock) + '</td></tr>' +
            (last ? '<tr><th>最近一次</th><td>' + UI.esc(Rules.TXN_TYPES[last.type] || last.type) +
              '　' + UI.esc(num(last.qty)) + ' 件　' + UI.esc(last.operator || '-') +
              '　<span class="hint">' + UI.esc(UI.fmtTime(last.createdAt)) + '</span></td></tr>' : '') +
          '</tbody></table>' +

          (lentQty > 0 || live.length
            ? '<div class="scan-lent">' +
                '<div class="scan-lent-title">借出中（' + UI.esc(lentQty) + ' 件）</div>' +
                (live.length
                  ? live.map(function (r) {
                      return '<div class="scan-lent-row' + (r.overdue ? ' overdue' : '') + '">' +
                        '<span class="who">' + UI.esc(r.borrower || '未填借用人') + '</span>' +
                        '<span>' + UI.esc(num(r.qty)) + ' 件</span>' +
                        '<span>应还 ' + UI.esc(r.dueDate || '未填') + '</span>' +
                        (r.overdue ? '<span class="badge-pill pill-danger">已超期 ' + UI.esc(num(r.overdueDays)) + ' 天</span>' : '') +
                        '</div>';
                    }).join('')
                  // 有借出件数却查不到对应的借出流水：多半是那条流水被删过。
                  // 这种时候不能假装"没人借"，也不能拿台账的数字覆盖物品上的数字，
                  // 只能把矛盾摆出来让人去查。
                  : '<div class="scan-lent-row"><span>台账里查不到对应的借出流水（可能被删过），请到「借用台账」核对。</span></div>') +
                (live.length && liveQty !== lentQty
                  ? '<div class="scan-lent-row overdue"><span>台账未还合计 ' + UI.esc(liveQty) +
                    ' 件，与物品上的借出 ' + UI.esc(lentQty) + ' 件对不上，请核对。</span></div>'
                  : '') +
              '</div>'
            : '') +

          '<div class="scan-actions">' +
            actions.map(function (a) {
              return '<button class="btn" type="button" data-scan-act="' + UI.esc(a.act) +
                '" data-code="' + UI.esc(item.code) + '">' + UI.esc(a.label) + '</button>';
            }).join('') +
            '<button class="btn" type="button" data-goto-item="' + UI.esc(item.code) + '">完整详情</button>' +
          '</div>' +
        '</div></div>' +
        panel;

      return {
        title: item.name,
        crumb: crumb.concat([{ label: item.code }]),
        html: html,
        onMount: wire
      };
    });
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Views = {
    home: home,
    category: category,
    itemDetail: itemDetail,
    scan: scan
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
