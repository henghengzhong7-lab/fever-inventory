/**
 * FEver 战队物资管理 —— 采购、发票、流水、借用台账、标签打印、设置
 */
(function (global) {
  'use strict';

  var UI = global.FEVER.UI;
  var DB = global.FEVER.DB;
  var Rules = global.FEVER.Rules;
  var Ops = global.FEVER.Ops;
  var Stats = global.FEVER.Stats;

  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  function catNameMap(categories) {
    var map = {};
    categories.forEach(function (c) { map[c.id] = c.name; });
    return map;
  }

  function statusPillOf(status) {
    var cls = status === 'arrived' ? 'pill-in_stock'
      : (status === 'canceled' ? 'pill-used_up' : (status === 'ordered' ? 'pill-lent' : 'pill-warn'));
    return '<span class="badge-pill ' + cls + '">' + UI.esc(Rules.INVOICE_STATUS_NAMES[status] || status) + '</span>';
  }

  /* ================= 采购申请 ================= */

  function purchases() {
    return DB.runTx(['purchaseRequests', 'categories', 'invoices', 'items'], 'readonly', function (T) {
      return Promise.all([T.getAll('purchaseRequests'), T.getAll('categories'), T.getAll('invoices'), T.getAll('items')])
        .then(function (arr) {
          var reqs = arr[0].slice().sort(function (a, b) { return num(b.id) - num(a.id); });
          var cats = catNameMap(arr[1]);
          var invoiceByReq = {};
          arr[2].forEach(function (iv) { invoiceByReq[iv.purchaseRequestId] = iv; });
          var itemCountByReq = {};
          arr[3].forEach(function (it) {
            if (it.purchaseRequestId) itemCountByReq[it.purchaseRequestId] = (itemCountByReq[it.purchaseRequestId] || 0) + 1;
          });

          var html =
            '<div class="page-head">' +
              '<div><h1 class="page-title">采购申请</h1>' +
              '<p class="page-sub">提申请 → 已下单 → 到货点「确认到货」，物品会自动入库并留存发票</p></div>' +
              '<div class="page-actions"><button class="btn primary" data-act="new-purchase" type="button">新建采购申请</button></div>' +
            '</div>' +
            '<div class="panel"><div class="panel-body tight">' +
            (reqs.length ? UI.table([
              { label: '#', render: function (r) { return UI.esc(r.id); } },
              { label: '物品', render: function (r) {
                  return UI.esc(r.name) + (r.spec ? '<div class="hint">' + UI.esc(r.spec) + '</div>' : ''); } },
              { label: '大类', render: function (r) { return UI.esc(cats[r.categoryId] || r.categoryId); } },
              { label: '数量', num: true, render: function (r) { return UI.esc(num(r.quantity)); } },
              { label: '预算', num: true, render: function (r) { return UI.esc(r.budget === undefined || r.budget === null || r.budget === '' ? '-' : r.budget); } },
              { label: '申请人', render: function (r) { return UI.esc(r.applicant || '-'); } },
              { label: '状态', render: function (r) { return statusPillOf(r.status); } },
              { label: '发票 / 入库', render: function (r) {
                  if (r.status !== 'arrived') return '<span class="hint">未到货</span>';
                  var inv = invoiceByReq[r.id];
                  return (inv ? '<button class="btn small" data-goto-invoice="' + UI.esc(inv.id) + '" type="button">' + UI.esc(inv.invoiceNo) + '</button>' : '<span class="hint">无发票</span>') +
                    ' <span class="hint">生成 ' + num(itemCountByReq[r.id]) + ' 个身份</span>';
                } },
              { label: '操作', render: function (r) {
                  var buttons = '';
                  if (r.status === 'pending') buttons += '<button class="btn small" data-advance="' + UI.esc(r.id) + '" data-to="ordered" type="button">标记已下单</button> ';
                  if (r.status === 'pending' || r.status === 'ordered') {
                    buttons += '<button class="btn small primary" data-arrive="' + UI.esc(r.id) + '" type="button">确认到货</button> ';
                    buttons += '<button class="btn small" data-cancel-id="' + UI.esc(r.id) + '" type="button">取消</button>';
                  }
                  if (r.status === 'arrived' || r.status === 'canceled') {
                    buttons += '<button class="btn small" data-del-purchase="' + UI.esc(r.id) + '" type="button">删除</button>';
                  }
                  return buttons;
                } }
            ], reqs, {
              emptyText: '还没有采购申请，点右上角新建一条'
            }) : '<div class="empty">还没有采购申请，点右上角新建一条</div>') +
            '</div></div>';

          return {
            title: '采购申请',
            crumb: [{ label: '物资总览', goto: 'home' }, { label: '采购申请' }],
            html: html
          };
        });
    });
  }

  /* ================= 发票台账 ================= */

  function invoices() {
    return DB.runTx(['invoices', 'purchaseRequests', 'items'], 'readonly', function (T) {
      return Promise.all([T.getAll('invoices'), T.getAll('purchaseRequests'), T.getAll('items')]).then(function (arr) {
        var list = arr[0].slice().sort(function (a, b) { return num(b.id) - num(a.id); });
        var reqById = {};
        arr[1].forEach(function (r) { reqById[r.id] = r; });
        var itemsByInvoice = {};
        arr[2].forEach(function (it) {
          if (it.invoiceId) {
            itemsByInvoice[it.invoiceId] = itemsByInvoice[it.invoiceId] || [];
            itemsByInvoice[it.invoiceId].push(it);
          }
        });

        var total = list.reduce(function (s, iv) { return s + num(iv.amount); }, 0);
        var html =
          '<div class="page-head">' +
            '<div><h1 class="page-title">发票台账</h1>' +
            '<p class="page-sub">共 ' + list.length + ' 张，合计 ' + total.toFixed(2) + ' 元</p></div>' +
          '</div>' +
          '<div class="panel"><div class="panel-body tight">' +
          UI.table([
            { label: '发票号', render: function (iv) {
                return '<button class="btn small" data-goto-invoice="' + UI.esc(iv.id) + '" type="button">' + UI.esc(iv.invoiceNo) + '</button>'; } },
            { label: '供应商', render: function (iv) { return UI.esc(iv.supplier || '-'); } },
            { label: '金额', num: true, render: function (iv) { return UI.esc(num(iv.amount).toFixed(2)); } },
            { label: '发票日期', render: function (iv) { return UI.esc(iv.invoiceDate || '-'); } },
            { label: '来源申请', render: function (iv) {
                var req = reqById[iv.purchaseRequestId];
                if (!req) return '<span class="badge-pill pill-warn">来源已删除</span>';
                return '<button class="btn small" data-goto-purchase="' + UI.esc(req.id) + '" type="button">#' + UI.esc(req.id) + ' ' + UI.esc(req.name) + '</button>';
              } },
            { label: '生成物品', render: function (iv) {
                var items = itemsByInvoice[iv.id] || [];
                if (!items.length) return '<span class="hint">-</span>';
                return items.slice(0, 4).map(function (it) {
                  return '<span class="code-cell" data-goto-item="' + UI.esc(it.code) + '">' + UI.esc(it.code) + '</span>';
                }).join('、') + (items.length > 4 ? ' 等 ' + items.length + ' 个' : '');
              } },
            { label: '登记时间', render: function (iv) { return UI.esc(UI.fmtTime(iv.createdAt)); } }
          ], list, { emptyText: '还没有发票记录。采购到货确认时会自动登记发票。' }) +
          '</div></div>';

        return {
          title: '发票台账',
          crumb: [{ label: '物资总览', goto: 'home' }, { label: '发票台账' }],
          html: html
        };
      });
    });
  }

  /* ================= 出入库流水 ================= */

  function transactions() {
    return Stats.filterTransactions({}).then(function (rows) {
      var typeOptions = Object.keys(Rules.TXN_TYPES).map(function (k) {
        return '<option value="' + UI.esc(k) + '">' + UI.esc(Rules.TXN_TYPES[k]) + '</option>';
      }).join('');

      var html =
        '<div class="page-head">' +
          '<div><h1 class="page-title">出入库流水</h1>' +
          '<p class="page-sub">每一次出入库都会留一条记录，记录只追加、不修改，方便回溯</p></div>' +
          '<div class="page-actions">' +
            '<button class="btn" data-act="export-txns" type="button">导出表格</button>' +
            '<button class="btn" data-goto="desk" type="button">去登记</button>' +
          '</div>' +
        '</div>' +
        '<div class="panel"><div class="panel-body"><div class="filters">' +
          '<div class="field"><label>关键字</label><input class="input" name="t-keyword" placeholder="编码 / 名称 / 人 / 用途"></div>' +
          '<div class="field"><label>动作</label><select class="select" name="t-type"><option value="">全部</option>' + typeOptions + '</select></div>' +
          '<div class="field"><label>操作人</label><input class="input" name="t-operator" placeholder="操作人姓名"></div>' +
          '<div class="field"><label>起始日期</label><input class="input" type="date" name="t-from"></div>' +
          '<div class="field"><label>截止日期</label><input class="input" type="date" name="t-to"></div>' +
        '</div></div></div>' +
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">记录</h3>' +
          '<span class="page-sub" id="txn-count"></span></div>' +
          '<div class="panel-body tight" id="txn-table"></div></div>';

      function onMount(root) {
        var state = {};
        function render() {
          Stats.filterTransactions({
            keyword: state['t-keyword'],
            type: state['t-type'],
            operator: state['t-operator'],
            from: state['t-from'],
            to: state['t-to']
          }).then(function (filtered) {
            UI.qs('#txn-table', root).innerHTML = UI.table([
              { label: '时间', render: function (t) { return UI.esc(UI.fmtTime(t.createdAt)); } },
              { label: '动作', render: function (t) {
                  return '<span class="badge-pill pill-info">' + UI.esc(Rules.TXN_TYPES[t.type] || t.type) + '</span>'; } },
              { label: '编码', render: function (t) {
                  return '<span class="code-cell" data-goto-item="' + UI.esc(t.itemCode) + '">' + UI.esc(t.itemCode) + '</span>'; } },
              { label: '名称', render: function (t) { return UI.esc(t.itemName || ''); } },
              { label: '数量', num: true, render: function (t) { return UI.esc(num(t.qty)); } },
              { label: '操作人', render: function (t) { return UI.esc(t.operator || '-'); } },
              { label: '借用人', render: function (t) { return UI.esc(t.borrower || '-'); } },
              { label: '预计归还', render: function (t) { return UI.esc(t.dueDate || '-'); } },
              { label: '用途 / 说明', render: function (t) { return UI.esc(t.purpose || '-'); } }
            ], filtered, { emptyText: '没有符合条件的记录' });
            UI.qs('#txn-count', root).textContent = '显示 ' + filtered.length + ' / ' + rows.length + ' 条';
            root.__filtered = filtered;
          });
        }
        root.addEventListener('input', function (e) {
          var name = e.target.name;
          if (!name || name.indexOf('t-') !== 0) return;
          state[name] = String(e.target.value).trim();
          render();
        });
        // 下拉框和日期框在真实浏览器里主要触发 change，只监听 input 会导致筛选不生效
        root.addEventListener('change', function (e) {
          var name = e.target.name;
          if (!name || name.indexOf('t-') !== 0) return;
          state[name] = String(e.target.value).trim();
          render();
        });
        render();
      }

      return {
        title: '出入库流水',
        crumb: [{ label: '物资总览', goto: 'home' }, { label: '出入库流水' }],
        html: html,
        onMount: onMount
      };
    });
  }

  /* ================= 借用台账 ================= */

  function lendLedger() {
    return Ops.lendLedger().then(function (rows) {
      var overdue = rows.filter(function (r) { return r.overdue; });
      var html =
        '<div class="page-head">' +
          '<div><h1 class="page-title">借用台账</h1>' +
          '<p class="page-sub">当前有 ' + rows.length + ' 条未归还，其中超期 ' + overdue.length + ' 条</p></div>' +
          '<div class="page-actions"><button class="btn" data-goto="desk" type="button">去登记归还</button></div>' +
        '</div>' +
        (overdue.length ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">超期未还（' + overdue.length + '）</h3></div>' +
          '<div class="panel-body">' + UI.alertBar(overdue.map(function (r) {
            return {
              code: r.itemCode, name: r.itemCode + ' ' + r.name, level: 'danger',
              text: '超期 ' + r.overdueDays + ' 天未还，借用人 ' + (r.borrower || '未填') + '，预计归还 ' + (r.dueDate || '未填')
            };
          })) + '</div></div>' : '') +
        '<div class="panel"><div class="panel-body tight">' +
        UI.table([
          { label: '编码', render: function (r) {
              return '<span class="code-cell" data-goto-item="' + UI.esc(r.itemCode) + '">' + UI.esc(r.itemCode) + '</span>'; } },
          { label: '名称', render: function (r) { return UI.esc(r.name); } },
          { label: '借出数量', num: true, render: function (r) { return UI.esc(num(r.qty)); } },
          { label: '借用人', render: function (r) { return UI.esc(r.borrower || '-'); } },
          { label: '借出时间', render: function (r) { return UI.esc(UI.fmtTime(r.lentAt)); } },
          { label: '预计归还', render: function (r) {
              return UI.esc(r.dueDate || '-') + (r.overdue
                ? ' <span class="badge-pill pill-danger">超期 ' + UI.esc(r.overdueDays) + ' 天</span>' : ''); } },
          { label: '用途', render: function (r) { return UI.esc(r.purpose || '-'); } },
          { label: '操作', render: function (r) {
              return '<button class="btn small primary" data-return="' + UI.esc(r.itemCode) + '" type="button">归还</button>'; } }
        ], rows, {
          rowClass: function (r) { return r.overdue ? 'overdue' : ''; },
          emptyText: '当前没有借出去的东西'
        }) +
        '</div></div>';

      return {
        title: '借用台账',
        crumb: [{ label: '物资总览', goto: 'home' }, { label: '借用台账' }],
        html: html
      };
    });
  }

  /* ================= 标签打印 ================= */

  function labels(params) {
    var code = params.code;
    return DB.runTx(['items', 'categories'], 'readonly', function (T) {
      return Promise.all([T.getAll('items'), T.getAll('categories')]).then(function (arr) {
        var items = arr[0];
        var cats = catNameMap(arr[1]);
        var selected = code
          ? items.filter(function (i) { return i.code === code; })
          : items;

        var html =
          '<div class="page-head no-print">' +
            '<div><h1 class="page-title">标签打印</h1>' +
            '<p class="page-sub">共 ' + selected.length + ' 张标签。确认版式后按 Ctrl+P 打印，打印时上面的导航会被自动隐藏。</p></div>' +
            '<div class="page-actions">' +
              '<button class="btn primary" data-act="do-print" type="button">直接打印</button>' +
              '<button class="btn" data-goto="home" type="button">返回</button>' +
            '</div>' +
          '</div>' +
          (code ? '' :
            '<div class="panel no-print"><div class="panel-body">' +
              '<div class="hint">下面会打印全部物品的标签。只想打印某一个，请到该物品详情页点「打印标签」。</div>' +
            '</div></div>') +
          '<div class="panel"><div class="panel-body"><div class="label-sheet">' +
            selected.map(function (item) {
              return '<div class="label-card">' +
                '<div class="label-qr" data-qr="' + UI.esc(Rules.qrPayload(item.code)) + '"></div>' +
                '<div class="label-meta">' +
                  '<span class="label-code">' + UI.esc(item.code) + '</span>' +
                  '<span class="label-name">' + UI.esc(item.name) + '</span>' +
                  (item.spec ? '<span class="label-line">' + UI.esc(item.spec) + '</span>' : '') +
                  '<span class="label-line">' + UI.esc(cats[item.categoryId] || item.categoryId) + '</span>' +
                  (item.location ? '<span class="label-line">' + UI.esc(item.location) + '</span>' : '') +
                '</div>' +
              '</div>';
            }).join('') +
          '</div></div></div>';

        function onMount(root) {
          global.FEVER.QR.renderAll(root, { level: 'M' });
          var printBtn = root.querySelector('[data-act="do-print"]');
          if (printBtn) printBtn.addEventListener('click', function () { global.print(); });
        }

        return {
          title: '标签打印',
          crumb: code
            ? [{ label: '物资总览', goto: 'home' }, { label: code, goto: 'item', params: { code: code } }, { label: '标签打印' }]
            : [{ label: '物资总览', goto: 'home' }, { label: '标签打印' }],
          html: html,
          onMount: onMount
        };
      });
    });
  }

  /* ================= 设置与数据备份 ================= */

  function settings() {
    return DB.runTx(['items', 'purchaseRequests', 'invoices', 'transactions', 'categories'], 'readonly', function (T) {
      return Promise.all([
        T.count('items'), T.count('purchaseRequests'), T.count('invoices'),
        T.count('transactions'), T.count('categories')
      ]).then(function (counts) {
        return DB.getSetting('lastBackupAt').then(function (lastBackupAt) {
          var remind = Rules.backupReminder(lastBackupAt, new Date());
          var days = remind.days;
          var needBackup = remind.need;

          var html =
            '<div class="page-head">' +
              '<div><h1 class="page-title">设置与数据备份</h1>' +
              '<p class="page-sub">数据只存在这台电脑的浏览器里。请定期导出备份，备份文件存到 U 盘或网盘。</p></div>' +
            '</div>' +
            (needBackup ? '<div class="panel"><div class="panel-body">' +
              '<div class="alert-item warn"><span class="who">备份提醒</span><span>' +
              (lastBackupAt ? '上次备份是 ' + UI.esc(UI.fmtDate(lastBackupAt)) + '，已经 ' + UI.esc(days) + ' 天没备份了。' : '还没有备份过。') +
              '建议现在导出一次。</span></div></div></div>' : '') +
            '<div class="panel"><div class="panel-body">' +
              '<table class="grid"><tbody>' +
                '<tr><th style="width:170px;background:#fafbfe">物品身份</th><td>' + UI.esc(counts[0]) + ' 条</td></tr>' +
                '<tr><th style="background:#fafbfe">采购申请</th><td>' + UI.esc(counts[1]) + ' 条</td></tr>' +
                '<tr><th style="background:#fafbfe">发票</th><td>' + UI.esc(counts[2]) + ' 条</td></tr>' +
                '<tr><th style="background:#fafbfe">出入库流水</th><td>' + UI.esc(counts[3]) + ' 条</td></tr>' +
                '<tr><th style="background:#fafbfe">上次备份</th><td>' +
                  UI.esc(lastBackupAt ? UI.fmtTime(lastBackupAt) : '从未备份') + '</td></tr>' +
              '</tbody></table>' +
            '</div></div>' +
            '<div class="panel">' +
              '<div class="panel-head"><h3 class="panel-title">备份与恢复</h3></div>' +
              '<div class="panel-body">' +
                '<p class="page-sub">导出备份会把全部数据（物品、采购、发票、流水、大类设置）打包成一个文件。</p>' +
                '<div class="page-actions">' +
                  '<button class="btn primary" data-act="export-backup" type="button">导出备份</button>' +
                  '<button class="btn" data-act="import-backup" type="button">导入恢复</button>' +
                  '<button class="btn" data-act="export-items" type="button">导出物品表格</button>' +
                  '<button class="btn" data-act="export-txns2" type="button">导出流水表格</button>' +
                '</div>' +
                '<div class="alert-item warn" style="margin-top:14px"><span class="who">注意</span>' +
                '<span>导入恢复会用备份里的数据整体替换当前数据。导入前系统会先把当前数据自动导出一份作保险，并再次向你确认。</span></div>' +
              '</div>' +
            '</div>' +
            '<div class="panel">' +
              '<div class="panel-head"><h3 class="panel-title">关于数据安全</h3></div>' +
              '<div class="panel-body">' +
                '<div class="alert-item info"><span>数据保存在本机浏览器里，刷新、关闭浏览器、重启电脑都不会丢。</span></div>' +
                '<div class="alert-item warn" style="margin-top:8px"><span>但以下情况会看不到数据：清除浏览器数据、换用另一个浏览器、换 Windows 用户、使用无痕模式。所以请务必定期导出备份。</span></div>' +
                '<div class="alert-item info" style="margin-top:8px"><span>本系统不联网、不需要登录、不上传任何数据。</span></div>' +
              '</div>' +
            '</div>';

          return {
            title: '设置与数据备份',
            crumb: [{ label: '物资总览', goto: 'home' }, { label: '设置与数据备份' }],
            html: html
          };
        });
      });
    });
  }

  global.FEVER.Views = global.FEVER.Views || {};
  global.FEVER.Views.purchases = purchases;
  global.FEVER.Views.invoices = invoices;
  global.FEVER.Views.transactions = transactions;
  global.FEVER.Views.lendLedger = lendLedger;
  global.FEVER.Views.labels = labels;
  global.FEVER.Views.settings = settings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
