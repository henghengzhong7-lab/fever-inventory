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

  /** 审批状态的彩色小标签 */
  function approvalPillOf(req) {
    var a = Rules.approvalOf(req);
    var cls = a === 'approved' ? 'pill-in_stock' : (a === 'rejected' ? 'pill-used_up' : 'pill-warn');
    return '<span class="badge-pill ' + cls + '">' + UI.esc(Rules.APPROVAL_NAMES[a] || a) + '</span>';
  }

  /**
   * 状态列。被驳回的申请，状态已经是「已取消」了，但直接显示「已取消」会让人
   * 以为是申请人自己撤的单 —— 这里显示「已驳回」，把真实原因说出来
   * （驳回理由在申请详情里）。
   */
  function statusCellOf(req) {
    if (Rules.approvalOf(req) === 'rejected') {
      return '<span class="badge-pill pill-used_up">已驳回</span>';
    }
    return statusPillOf(req.status);
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

          var waiting = reqs.filter(function (r) { return Rules.isPendingApproval(r); });
          var mine = DB.isAdmin();
          // 有 PDF 附件的发票数：管理员批量下载按钮的显隐与提示都看它
          var withFile = arr[2].filter(function (iv) { return iv.fileRef || iv.fileData; }).length;

          var html =
            '<div class="page-head">' +
              '<div><h1 class="page-title">采购申请</h1>' +
              '<p class="page-sub">提申请 → 管理员同意 → 已下单 → 到货点「确认到货」，物品会自动入库并留存发票</p></div>' +
              '<div class="page-actions">' +
                (mine && withFile
                  ? '<button class="btn" data-dl-invoices type="button">批量下载发票（' + withFile + '）</button> '
                  : '') +
                '<button class="btn primary" data-act="new-purchase" type="button">新建采购申请</button>' +
              '</div>' +
            '</div>' +
            (waiting.length
              ? '<div class="panel"><div class="panel-body">' +
                '<div class="alert-item ' + (mine ? 'warn' : 'info') + '">' +
                  '<span class="who">' + waiting.length + ' 条待审批</span><span>' +
                  (mine
                    ? '有 ' + waiting.length + ' 条申请等着你处理，同意后才能下单采购。'
                    : '等待管理员审批，同意后才能下单采购。') +
                  '</span>' +
                '</div></div></div>'
              : '') +
            '<div class="panel"><div class="panel-body tight">' +
            (reqs.length ? UI.table([
              { label: '#', render: function (r) { return UI.esc(r.id); } },
              { label: '物品', render: function (r) {
                  return UI.esc(r.name) + (r.spec ? '<div class="hint">' + UI.esc(r.spec) + '</div>' : ''); } },
              { label: '大类', render: function (r) { return UI.esc(cats[r.categoryId] || r.categoryId); } },
              { label: '兵种', render: function (r) {
                  var t = Rules.troopOf(r);
                  return t
                    ? '<span class="badge-pill pill-info">' + UI.esc(t) + '</span>'
                    : '<span class="hint">未指定</span>'; } },
              { label: '数量', num: true, render: function (r) { return UI.esc(num(r.quantity)); } },
              { label: '预算', num: true, render: function (r) { return UI.esc(r.budget === undefined || r.budget === null || r.budget === '' ? '-' : r.budget); } },
              { label: '申请人', render: function (r) { return UI.esc(r.applicant || '-'); } },
              { label: '审批', render: function (r) { return approvalPillOf(r); } },
              { label: '状态', render: function (r) { return statusCellOf(r); } },
              { label: '发票 / 入库', render: function (r) {
                  if (r.status !== 'arrived') return '<span class="hint">未到货</span>';
                  var inv = invoiceByReq[r.id];
                  if (!inv) return '<span class="hint">无发票</span>';
                  // 发票号码不再必填（第十三轮）：空号时显示文件名，让按钮仍然能点进详情
                  var label = inv.invoiceNo || inv.fileName || ('发票 #' + inv.id);
                  return '<button class="btn small" data-goto-invoice="' + UI.esc(inv.id) + '" type="button">' + UI.esc(label) + '</button>' +
                    ' <span class="hint">生成 ' + num(itemCountByReq[r.id]) + ' 个身份</span>';
                } },
              { label: '操作', render: function (r) {
                  var buttons = '';
                  var approval = Rules.approvalOf(r);
                  var delBtn = '<button class="btn small" data-del-purchase="' + UI.esc(r.id) + '" type="button">删除</button>';

                  // 终态只看状态：已经到货或已经取消的申请没有别的动作可做，
                  // 免得出现「一条已经取消的单子还挂着一个同意按钮」这种自相矛盾的界面
                  if (r.status === 'arrived' || r.status === 'canceled') return delBtn;

                  // 待审批：只有管理员能同意/驳回；普通队员只能自己撤单
                  if (approval === 'pending') {
                    if (mine) {
                      buttons += '<button class="btn small primary" data-approve="' + UI.esc(r.id) + '" type="button">同意</button> ';
                      buttons += '<button class="btn small danger" data-reject="' + UI.esc(r.id) + '" type="button">驳回</button> ';
                    } else {
                      buttons += '<span class="hint">等管理员审批</span> ';
                    }
                    buttons += '<button class="btn small" data-cancel-id="' + UI.esc(r.id) + '" type="button">取消</button>';
                    return buttons;
                  }

                  // 已驳回：终态。（驳回时会把状态一并改成已取消，所以正常走不到这里，
                  // 但手改过表的数据可能落到这个分支，给个删除出口总比一片空白好）
                  if (approval === 'rejected') return delBtn;

                  // 已同意：走原来的流程
                  if (r.status === 'pending') buttons += '<button class="btn small" data-advance="' + UI.esc(r.id) + '" data-to="ordered" type="button">标记已下单</button> ';
                  buttons += '<button class="btn small primary" data-arrive="' + UI.esc(r.id) + '" type="button">确认到货</button> ';
                  buttons += '<button class="btn small" data-cancel-id="' + UI.esc(r.id) + '" type="button">取消</button>';
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

  /* ================= 兵种预算 ================= */

  /**
   * 时间范围记在模块变量里而不是路由参数里。
   * 路由的 # 片段只带得动 id / code，把范围塞进去要动路由规则；
   * 而"换个范围看"本来就是同一个页面的局部状态，不值得为它改路由。
   */
  var budgetsRange = 'all';

  function money(v) { return num(v).toFixed(2); }

  /** 使用率进度条。没设预算的兵种画不了比例，就明说"未设预算" */
  function usageBar(row) {
    if (row.usage === null) return '<span class="hint">未设预算</span>';
    var pct = Math.round(row.usage * 100);
    var shown = Math.max(0, Math.min(100, pct));
    var color = row.usage > 1 ? 'var(--danger)' : (row.usage >= 0.8 ? 'var(--warn)' : 'var(--ok)');
    return '<div style="display:flex;align-items:center;gap:8px">' +
      '<div style="background:#eef1f7;border-radius:999px;height:8px;flex:1;min-width:70px;overflow:hidden">' +
        '<div style="width:' + shown + '%;height:100%;background:' + color + '"></div>' +
      '</div>' +
      '<span class="hint" style="min-width:38px;text-align:right">' + pct + '%</span>' +
    '</div>';
  }

  function rangeButtons() {
    var keys = ['all', 'year', 'quarter', 'month'];
    return keys.map(function (k) {
      return '<button class="btn small' + (budgetsRange === k ? ' primary' : '') +
        '" data-budget-range="' + k + '" type="button">' + UI.esc(Stats.RANGE_NAMES[k]) + '</button>';
    }).join(' ');
  }

  function budgets() {
    return DB.runTx(['purchaseRequests', 'invoices'], 'readonly', function (T) {
      return Promise.all([T.getAll('purchaseRequests'), T.getAll('invoices')]);
    }).then(function (arr) {
      // 预算额度存在 settings 里。注意：不能塞进上面那个 runTx ——
      // 一个事务里再开一个事务，IndexedDB 会直接把新事务挂掉。这里单独读一次。
      return DB.getSetting(Stats.BUDGET_KEY, {}).then(function (budgets) {
        var summary = Stats.budgetSummary(arr[0], budgets, budgetsRange, DB.nowIso(), arr[1]);
        var t = summary.total;
        var mine = DB.isAdmin();

        var html =
          '<div class="page-head">' +
            '<div><h1 class="page-title">兵种预算</h1>' +
            '<p class="page-sub">按兵种看预算用了多少。「已用」= 管理员已同意的申请金额；待审批的不占用预算，' +
              '管理员点同意的那一刻才扣。</p></div>' +
            '<div class="page-actions">' + rangeButtons() +
              ' <button class="btn" data-act="export-budgets" type="button">导出预算表格</button>' +
              (mine ? ' <button class="btn" data-act="edit-budgets" type="button">设置预算</button>' : '') +
            '</div>' +
          '</div>' +

          '<div class="cat-grid" style="margin-bottom:16px">' +
            '<div class="cat-card" style="cursor:default">' +
              '<div><div class="metric-label">总预算（' + UI.esc(summary.rangeName) + '）</div>' +
              '<div class="metric-value" style="font-size:22px">¥' + money(t.budget) + '</div></div>' +
            '</div>' +
            '<div class="cat-card" style="cursor:default">' +
              '<div><div class="metric-label">已用（已同意）</div>' +
              '<div class="metric-value" style="font-size:22px">¥' + money(t.used) + '</div></div>' +
            '</div>' +
            '<div class="cat-card" style="cursor:default">' +
              '<div><div class="metric-label">剩余</div>' +
              '<div class="metric-value" style="font-size:22px' + (t.remaining < 0 ? ';color:var(--danger)' : '') + '">¥' +
                money(t.remaining) + '</div></div>' +
            '</div>' +
            '<div class="cat-card" style="cursor:default">' +
              '<div><div class="metric-label">待审批（不占预算）</div>' +
              '<div class="metric-value" style="font-size:22px">¥' + money(t.pending) + '</div></div>' +
            '</div>' +
          '</div>' +

          (t.over ? '<div class="panel"><div class="panel-body">' +
            '<div class="alert-item danger"><span class="who">有 ' + t.over + ' 个兵种超支</span>' +
            '<span>已同意的金额已经超过预算额度，新申请建议先追加预算或改到下个周期。</span></div>' +
            '</div></div>' : '') +

          (t.unspecifiedCount
            ? '<div class="panel"><div class="panel-body">' +
              '<div class="alert-item warn"><span class="who">有 ' + t.unspecifiedCount + ' 条申请没写兵种</span>' +
              '<span>共 ¥' + money(t.unspecifiedUsed) + ' 已计入总额，但不属于任何兵种（这些是加兵种字段之前提的老申请）。' +
              '它们照样算进总预算，所以明细加起来和总数是对得上的。</span></div>' +
              '</div></div>'
            : '') +

          '<div class="panel">' +
            '<div class="panel-head"><h3 class="panel-title">按兵种明细</h3>' +
              '<span class="hint">共 ' + t.requests + ' 条申请</span></div>' +
            '<div class="panel-body tight">' +
            UI.table([
              { label: '兵种', render: function (r) {
                  return r.troop === Stats.UNSPECIFIED
                    ? '<span class="hint">' + UI.esc(r.troop) + '</span>'
                    : '<span class="badge-pill pill-info">' + UI.esc(r.troop) + '</span>'; } },
              { label: '预算', num: true, render: function (r) {
                  return r.budget > 0 ? '¥' + money(r.budget) : '<span class="hint">未设</span>'; } },
              { label: '已用（已同意）', num: true, render: function (r) { return '¥' + money(r.used); } },
              { label: '剩余', num: true, render: function (r) {
                  if (r.troop === Stats.UNSPECIFIED) return '<span class="hint">—</span>';
                  return '<span' + (r.remaining < 0 ? ' style="color:var(--danger);font-weight:700"' : '') + '>¥' + money(r.remaining) + '</span>'; } },
              { label: '使用率', render: usageBar },
              { label: '待审批', num: true, render: function (r) {
                  return r.pending > 0 ? '¥' + money(r.pending) : '<span class="hint">—</span>'; } },
              { label: '已到货实际', num: true, render: function (r) {
                  return r.actual > 0 ? '¥' + money(r.actual) : '<span class="hint">—</span>'; } },
              { label: '申请数', num: true, render: function (r) { return UI.esc(r.requests); } }
            ], summary.rows, {
              emptyText: '还没有任何申请。想让这一页有数，得先有采购申请并配好各兵种的预算额度。'
            }) +
            '</div>' +
          '</div>' +

          '<div class="panel"><div class="panel-body">' +
            '<p class="page-sub" style="margin:0">口径说明：<b>已用</b>只算管理员已同意的申请，' +
            '剩余 = 预算 − 已用；已取消和已驳回的一律不计（钱不会花出去）。' +
            '<b>已到货实际</b>是登记发票的真实金额，和「已用」的差额就是申请预算与真实花销的偏差，' +
            '它只作参考，不参与剩余额度的计算。</p>' +
          '</div></div>';

        return {
          title: '兵种预算',
          crumb: [{ label: '物资总览', goto: 'home' }, { label: '兵种预算' }],
          html: html,
          onMount: function (root) {
            root.addEventListener('click', function (e) {
              var btn = e.target.closest ? e.target.closest('[data-budget-range]') : null;
              if (!btn) return;
              var next = btn.getAttribute('data-budget-range');
              if (next === budgetsRange) return;
              budgetsRange = next;
              var App = global.FEVER.App;
              if (App && App.goto) App.goto('budgets');
            });
          }
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
                return '<button class="btn small" data-goto-invoice="' + UI.esc(iv.id) + '" type="button">' + UI.esc(Rules.invoiceLabel(iv)) + '</button>'; } },
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
            { label: '登记时间', render: function (iv) { return UI.esc(UI.fmtTime(iv.createdAt)); } },
            { label: '操作', render: function (iv) {
                return '<button class="btn small" data-del-invoice="' + UI.esc(iv.id) + '" type="button">删除</button>'; } }
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
              { label: '用途 / 说明', render: function (t) { return UI.esc(t.purpose || '-'); } },
              { label: '操作', render: function (t) {
                  return '<button class="btn small" data-del-txn="' + UI.esc(t.id) + '" type="button">删除</button>'; } }
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

  /**
   * 标签打印。
   *
   * 四种进入方式共用同一套版式（**标签长什么样没变，只是能一次出多张**）：
   *   { code: 'VS-0001' }          单个物品 —— 详情页与清单行里的「标签」按钮
   *   { codes: ['VS-0001', ...] }  勾选的一批 —— 物品清单的「批量打印标签」
   *   { categoryId: 'mechanical' } 某个大类下的全部
   *   {}                           全部物品
   */
  function labels(params) {
    var code = params.code;
    var codes = (params.codes && params.codes.length) ? params.codes : null;
    var categoryId = params.categoryId || '';

    return DB.runTx(['items', 'categories'], 'readonly', function (T) {
      return Promise.all([T.getAll('items'), T.getAll('categories')]).then(function (arr) {
        var items = arr[0];
        var cats = catNameMap(arr[1]);

        var selected;
        var scopeText = '';
        if (codes) {
          // 按**勾选顺序**出标签：人撕下来挨着贴的时候才连得上，所以不做排序
          selected = Rules.pickByCodes(items, codes);
          var missing = codes.length - selected.length;
          scopeText = '你勾选的 ' + codes.length + ' 件' +
            (missing > 0
              ? '，其中 ' + missing + ' 件已经不在了（可能刚被别人删掉），下面只出还在的 ' + selected.length + ' 张'
              : '');
        } else if (code) {
          selected = items.filter(function (i) { return i.code === code; });
        } else if (categoryId) {
          selected = items.filter(function (i) { return i.categoryId === categoryId; });
          scopeText = '「' + (cats[categoryId] || categoryId) + '」下的全部 ' + selected.length + ' 件';
        } else {
          selected = items;
          scopeText = '全部 ' + selected.length + ' 件';
        }

        var html =
          '<div class="page-head no-print">' +
            '<div><h1 class="page-title">标签打印</h1>' +
            '<p class="page-sub">共 ' + selected.length + ' 张标签' +
              (scopeText ? '（' + UI.esc(scopeText) + '）' : '') +
              '。确认版式后按 Ctrl+P 打印，打印时上面的导航会被自动隐藏。</p></div>' +
            '<div class="page-actions">' +
              '<button class="btn primary" data-act="do-print" type="button">直接打印</button>' +
              '<button class="btn" data-goto="home" type="button">返回</button>' +
            '</div>' +
          '</div>' +
          (!codes && !code && !categoryId
            ? '<div class="panel no-print"><div class="panel-body">' +
                '<div class="hint">下面会打印全部物品的标签。只想打印某一批，回物品清单勾上后点「批量打印标签」；' +
                '只想打印某一个，请到该物品详情页点「打印标签」。</div>' +
              '</div></div>'
            : '') +
          (selected.length
            ? '<div class="panel"><div class="panel-body"><div class="label-sheet">' +
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
              '</div></div></div>'
            : '<div class="panel"><div class="panel-body">' +
                '<div class="empty">没有可打印的标签。</div></div></div>');

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
        return Promise.all([
          DB.getSetting('lastBackupAt'),
          Rules.getDeleteLog()
        ]).then(function (stored) {
          var lastBackupAt = stored[0];
          var deleteCount = (stored[1] || []).length;
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
              '<div class="panel-head"><h3 class="panel-title">删除记录</h3></div>' +
              '<div class="panel-body">' +
                '<p class="page-sub">物品身份、采购申请、发票、出入库流水都可以删除，但' +
                  '<b>每删一条都会在这里留一笔</b>：谁删的、什么时候删的、删了什么，以及删除当时的完整内容。</p>' +
                '<div class="page-actions">' +
                  '<button class="btn" data-act="delete-log" type="button">查看删除记录' +
                    (deleteCount ? '（' + UI.esc(deleteCount) + '）' : '') + '</button>' +
                '</div>' +
                '<div class="alert-item info" style="margin-top:14px"><span>' +
                  '出入库流水按原设计是只追加、不修改的。删除留痕是这条底线上的一个折中：' +
                  '删得掉，但一定查得到。所以界面<b>刻意不提供「清空删除记录」</b>。</span></div>' +
              '</div>' +
            '</div>' +
            (global.FEVER_CONFIG
              ? '<div class="panel">' +
                '<div class="panel-head"><h3 class="panel-title">飞书提醒</h3></div>' +
                '<div class="panel-body">' +
                  '<p class="page-sub">队员提交采购申请 → 管理员收到提醒；管理员批准 → 申请人收到提醒。' +
                    '如果收不到，点下面的按钮真发一条测试消息，飞书的原始结果会直接显示 —— ' +
                    '是权限没开、机器人没启用还是别的，一眼便知，不用猜。</p>' +
                  '<div class="page-actions">' +
                    '<button class="btn" data-act="notify-test" type="button">发送测试提醒</button>' +
                  '</div>' +
                  '<div class="alert-item info" style="margin-top:14px"><span>' +
                    '想提醒得更醒目？让群主在「群设置 → 群机器人 → 添加自定义机器人」拿到 webhook 地址，' +
                    '填到服务器 config.json 的 groupWebhook 里。之后每次提交和批准都会<b>同时发到群里</b>，' +
                    '群消息不需要任何额外权限。</span></div>' +
                '</div>' +
              '</div>'
              : '') +
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
  global.FEVER.Views.budgets = budgets;
  global.FEVER.Views.invoices = invoices;
  global.FEVER.Views.transactions = transactions;
  global.FEVER.Views.lendLedger = lendLedger;
  global.FEVER.Views.labels = labels;
  global.FEVER.Views.settings = settings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
