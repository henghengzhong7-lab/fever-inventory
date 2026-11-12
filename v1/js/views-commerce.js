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

  /**
   * 筛选里的「未指定」哨兵值。
   * 用单独的常量而不是空字符串：空字符串是"这个条件没启用"，
   * 两件事必须分得开 —— 否则「只看没填兵种的」和「不看兵种」会变成同一个条件。
   */
  var FILTER_NONE = '__none__';

  /** 按给定顺序渲染一组下拉选项，第一项固定是「全部」 */
  function optionsHtml(values, allLabel) {
    return ['<option value="">' + UI.esc(allLabel || '全部') + '</option>'].concat(
      values.map(function (v) {
        return '<option value="' + UI.esc(v.value) + '">' + UI.esc(v.label) + '</option>';
      })
    ).join('');
  }

  /** 从数据里数出某一列出现过的值（有序、去重），空值折算成「未指定」 */
  function distinctOf(rows, read, noneLabel) {
    var seen = {};
    var list = [];
    var hasNone = false;
    rows.forEach(function (r) {
      var v = read(r);
      if (!v) { hasNone = true; return; }
      if (seen[v]) return;
      seen[v] = true;
      list.push({ value: v, label: v });
    });
    if (hasNone) list.push({ value: FILTER_NONE, label: noneLabel || '（未指定）' });
    return list;
  }

  /**
   * 采购申请列表。
   *
   * 第十四周加了筛选栏 —— 起因是"只想看某个人申请的东西"。
   * 做法与物品页一致：筛选控件带 name="f-*"，页面上用一次事件委托收拢所有变化，
   * 改完条件就地重画表格（不重新走一遍路由，也就不闪、不丢滚动位置）。
   *
   * 每一列都给了一个条件，等价于"每列都能筛"：
   *   关键字（物品/规格/申请人/用途/编号）、大类、兵种、申请人、审批、状态。
   * 没有做 Excel 那种点列头弹复选框的交互 —— 手机上那种控件很难点，
   * 而且列头本身在窄屏下要横向滚动，弹层会跟着跑偏。
   *
   * 路由参数（第十五轮，供"页面互联"用）：
   *   { troop: '轮腿步兵', range: 'month' }
   * 从兵种预算点「27 次」进来时带上这两个，页面把它们预置成筛选条件 ——
   * 点进去看到的就是那 27 次，而不是全表。
   */
  function purchases(params) {
    var p = params || {};
    return DB.runTx(['purchaseRequests', 'categories', 'invoices', 'items'], 'readonly', function (T) {
      return Promise.all([T.getAll('purchaseRequests'), T.getAll('categories'), T.getAll('invoices'), T.getAll('items')])
        .then(function (arr) {
          var reqs = arr[0].slice().sort(function (a, b) { return num(b.id) - num(a.id); });
          var categories = arr[1].slice().sort(function (a, b) { return num(a.sortOrder) - num(b.sortOrder); });
          var catMap = catNameMap(arr[1]);
          var invoiceByReq = {};
          arr[2].forEach(function (iv) { invoiceByReq[iv.purchaseRequestId] = iv; });
          var itemCountByReq = {};
          arr[3].forEach(function (it) {
            if (it.purchaseRequestId) itemCountByReq[it.purchaseRequestId] = (itemCountByReq[it.purchaseRequestId] || 0) + 1;
          });
          // 每一批的发票清单（第十六轮）：列表上直接给「整批发票」下载入口，
          // 不用先进批次页。口径与批次页共用 Stats.batchInvoiceInfo。
          var batchInv = {};
          reqs.forEach(function (r) {
            if (!r.batchId || batchInv[r.batchId]) return;
            batchInv[r.batchId] = Stats.batchInvoiceInfo(arr[0], arr[2], r.batchId);
          });

          var waiting = reqs.filter(function (r) { return Rules.isPendingApproval(r); });
          var mine = DB.isAdmin();
          // 有 PDF 附件的发票数：管理员批量下载按钮的显隐与提示都看它
          var withFile = arr[2].filter(function (iv) { return iv.fileRef || iv.fileData; }).length;

          /** 表格的列定义。只写一次，初次渲染和筛选后重画都走它 */
          function buildColumns() {
            return [
              { label: '#', render: function (r) {
                  // 打包提交的申请带批次号：给「整批」入口（进批次页）和
                  // 「整批发票」入口（直接打包下载这一批的发票，第十六轮）——
                  // 后者不用先进批次页，管理员在列表上就能一次下完。
                  if (!r.batchId) return UI.esc(r.id);
                  var info = batchInv[r.batchId];
                  var dl = (mine && info && info.invoiceIds.length)
                    ? ' <button class="btn small ghost" data-batch-invoice-ids="' + info.invoiceIds.join(',') +
                      '" data-batch-invoice-missing="' + info.missingNames.length + '" type="button">整批发票（' +
                      info.invoiceIds.length + '）</button>'
                    : '';
                  return UI.esc(r.id) +
                    '<div class="hint"><button class="btn small ghost" data-goto-batch="' +
                    UI.esc(r.batchId) + '" type="button">整批</button>' + dl + '</div>';
                } },
              { label: '物品', render: function (r) {
                  // 点一下"能跳多深跳多深"：已到货的进物品详情，没到货的进申请详情
                  return '<span class="code-cell" data-open-purchase="' + UI.esc(r.id) + '">' +
                    UI.esc(r.name) + '</span>' + (r.spec ? '<div class="hint">' + UI.esc(r.spec) + '</div>' : ''); } },
              { label: '大类', render: function (r) { return UI.esc(catMap[r.categoryId] || r.categoryId); } },
              { label: '兵种', render: function (r) {
                  var t = Rules.troopOf(r);
                  return t
                    ? '<span class="badge-pill pill-info">' + UI.esc(t) + '</span>'
                    : '<span class="hint">未指定</span>'; } },
              { label: '数量', num: true, render: function (r) { return UI.esc(num(r.quantity)); } },
              { label: '预算', num: true, render: function (r) { return UI.esc(r.budget === undefined || r.budget === null || r.budget === '' ? '-' : r.budget); } },
              { label: '购买链接', render: function (r) {
                  // 渲染前再规范一次：备份文件是可以被手改的，
                  // 直接相信存进去的值就等于给 <a href> 留了个注入口子
                  var href = Rules.purchaseLink(r.link);
                  return href
                    ? '<a class="btn small" data-purchase-link="' + UI.esc(r.id) + '" href="' + UI.esc(href) +
                      '" target="_blank" rel="noopener noreferrer">打开</a>'
                    : '<span class="hint">-</span>'; } },
              { label: '申请人', render: function (r) { return UI.esc(r.applicant || '-'); } },
              { label: '审批', render: function (r) { return approvalPillOf(r); } },
              { label: '状态', render: function (r) { return statusCellOf(r); } },
              { label: '发票 / 入库', render: function (r) {
                  if (r.status !== 'arrived') return '<span class="hint">未到货</span>';
                  var inv = invoiceByReq[r.id];
                  if (!inv) return '<span class="hint">无发票</span>';
                  // 发票号码不再必填（第十三轮）：空号时显示文件名，让按钮仍然能点进详情
                  var label = Rules.invoiceLabel(inv);
                  // 到货时没拿到发票是常事（发票往往后到）：
                  // 缺附件时把「补传发票」画成主按钮，一眼看出这条还差张票
                  var hasFile = !!(inv.fileRef || inv.fileData);
                  return '<button class="btn small" data-goto-invoice="' + UI.esc(inv.id) + '" type="button">' + UI.esc(label) + '</button>' +
                    ' <button class="btn small' + (hasFile ? '' : ' primary') + '" data-upload-invoice="' + UI.esc(inv.id) + '" type="button">' +
                      (hasFile ? '更换 PDF' : '补传发票') + '</button>' +
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
            ];
          }

          var columns = buildColumns();

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
            '<div class="panel">' +
              '<div class="panel-head"><h3 class="panel-title">筛选</h3>' +
                '<button class="btn small" data-act="reset-filter" type="button">清空条件</button></div>' +
              '<div class="panel-body"><div class="filters" id="purchase-filters">' +
                '<div class="field"><label>关键字</label>' +
                  '<input class="input" name="f-keyword" placeholder="物品 / 规格 / 申请人 / 用途 / 编号"></div>' +
                '<div class="field"><label>大类</label>' +
                  '<select class="select" name="f-category">' +
                  optionsHtml(categories.map(function (c) { return { value: c.id, label: c.name }; })) +
                  '</select></div>' +
                '<div class="field"><label>兵种</label>' +
                  '<select class="select" name="f-troop">' +
                  (function () {
                    // 第二十二轮：原来这里是 distinctOf(reqs) —— 只列"现有申请里出现过的兵种"，
                    // 所以新兵种在还没人提过申请之前根本不显示，看起来就是「兵种不全」。
                    // 兵种是固定清单的枚举（跟"申请人"不一样），改成全量列出来。
                    var troops = Rules.troopFilterList(reqs.map(function (r) { return Rules.troopOf(r); }));
                    var opts = troops.map(function (t) { return { value: t, label: t }; });
                    // 有没填兵种的申请时，才补一项「（未指定）」——它对应 __none__ 这个特殊值
                    if (reqs.some(function (r) { return !Rules.troopOf(r); })) {
                      opts.push({ value: FILTER_NONE, label: '（未指定）' });
                    }
                    return optionsHtml(opts);
                  })() +
                  '</select></div>' +
                '<div class="field"><label>申请人</label>' +
                  '<select class="select" name="f-applicant">' +
                  optionsHtml(distinctOf(reqs, function (r) {
                    return String(r.applicant || '').trim();
                  }, '（未填）')) +
                  '</select></div>' +
                '<div class="field"><label>申请时间 起</label>' +
                  '<input class="input" type="date" name="f-from"></div>' +
                '<div class="field"><label>申请时间 止</label>' +
                  '<input class="input" type="date" name="f-to"></div>' +
                '<div class="field"><label>审批</label>' +
                  '<select class="select" name="f-approval">' +
                  optionsHtml([
                    { value: 'pending', label: '待审批' },
                    { value: 'approved', label: '已同意' },
                    { value: 'rejected', label: '已驳回' }
                  ]) +
                  '</select></div>' +
                '<div class="field"><label>状态</label>' +
                  '<select class="select" name="f-status">' +
                  optionsHtml([
                    { value: 'pending', label: '待购买' },
                    { value: 'ordered', label: '已下单' },
                    { value: 'arrived', label: '已到货' },
                    { value: 'canceled', label: '已取消' }
                  ]) +
                  '</select></div>' +
              '</div>' +
              // 筛选栏只在手机上折叠收起（样式在 css 里），桌面端一直摊开
              '</div>' +
            '</div>' +
            '<div class="panel">' +
              '<div class="panel-head"><h3 class="panel-title">申请清单</h3>' +
                '<span class="page-sub" id="purchase-count"></span></div>' +
              '<div class="panel-body tight"><div id="purchase-table"></div></div>' +
            '</div>';

          return {
            title: '采购申请',
            crumb: [{ label: '物资总览', goto: 'home' }, { label: '采购申请' }],
            html: html,
            onMount: function (root) {
              var state = {};

              // 从兵种预算点「27 次」进来时，把条件预置好 —— 看到的就是那 27 次
              if (p.troop) state['f-troop'] = (p.troop === Stats.UNSPECIFIED) ? FILTER_NONE : p.troop;
              var startOfRange = Stats.rangeStart(p.range, DB.nowIso());
              if (startOfRange) state['f-from'] = String(startOfRange).slice(0, 10);
              Object.keys(state).forEach(function (name) {
                var node = root.querySelector('[name="' + name + '"]');
                if (!node) return;
                node.value = state[name];
                // 下拉框里没有这个值时（比如该兵种暂时一条申请都没有），补一个选项：
                // 否则界面看起来"什么都没筛"，却只剩一个空列表，人会以为数据丢了
                if (node.tagName === 'SELECT' && node.value !== state[name]) {
                  var opt = document.createElement('option');
                  opt.value = state[name];
                  opt.textContent = state[name] === FILTER_NONE ? '（未指定）' : state[name];
                  node.appendChild(opt);
                  node.value = state[name];
                }
              });

              function matches(req) {
                var kw = state['f-keyword'];
                if (kw) {
                  var hay = [req.id, req.name, req.spec, req.applicant, req.purpose]
                    .join(' ').toLowerCase();
                  if (hay.indexOf(kw.toLowerCase()) === -1) return false;
                }
                var cat = state['f-category'];
                if (cat && req.categoryId !== cat) return false;

                var troop = state['f-troop'];
                if (troop) {
                  var t = Rules.troopOf(req);
                  if (troop === FILTER_NONE ? !!t : t !== troop) return false;
                }

                var applicant = state['f-applicant'];
                if (applicant) {
                  var a = String(req.applicant || '').trim();
                  if (applicant === FILTER_NONE ? !!a : a !== applicant) return false;
                }

                var approval = state['f-approval'];
                if (approval && Rules.approvalOf(req) !== approval) return false;

                var status = state['f-status'];
                if (status && req.status !== status) return false;

                // 申请时间范围：只比到"天"，日期输入框给的就是 YYYY-MM-DD
                var from = state['f-from'];
                var to = state['f-to'];
                if (from || to) {
                  var day = String(req.createdAt || '').slice(0, 10);
                  if (from && day < from) return false;
                  if (to && day > to) return false;
                }
                return true;
              }

              function render() {
                var shown = reqs.filter(matches);
                var holder = UI.qs('#purchase-table', root);
                if (!holder) return;
                holder.innerHTML = UI.table(columns, shown, {
                  emptyText: reqs.length
                    ? '没有符合筛选条件的申请'
                    : '还没有采购申请，点右上角新建一条'
                });
                var counter = UI.qs('#purchase-count', root);
                if (counter) counter.textContent = '显示 ' + shown.length + ' / ' + reqs.length + ' 条';
              }

              // 输入框和下拉框都收在这里：筛选栏里的控件没有别的用途，
              // 不必逐个绑定（页面重画后也就不用重新绑）
              root.addEventListener('input', function (e) {
                var name = e.target.getAttribute && e.target.getAttribute('name');
                if (!name || name.indexOf('f-') !== 0) return;
                state[name] = String(e.target.value).trim();
                render();
              });
              root.addEventListener('change', function (e) {
                var name = e.target.getAttribute && e.target.getAttribute('name');
                if (!name || name.indexOf('f-') !== 0) return;
                state[name] = String(e.target.value).trim();
                render();
              });

              var resetBtn = root.querySelector('[data-act="reset-filter"]');
              if (resetBtn) {
                resetBtn.addEventListener('click', function () {
                  UI.qsa('#purchase-filters [name]', root).forEach(function (node) { node.value = ''; });
                  state = {};
                  render();
                });
              }

              render();
            }
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
    return DB.runTx(['purchaseRequests', 'invoices', 'items'], 'readonly', function (T) {
      return Promise.all([T.getAll('purchaseRequests'), T.getAll('invoices'), T.getAll('items')]);
    }).then(function (arr) {
      // 预算额度存在 settings 里。注意：不能塞进上面那个 runTx ——
      // 一个事务里再开一个事务，IndexedDB 会直接把新事务挂掉。这里单独读一次。
      return DB.getSetting(Stats.BUDGET_KEY, {}).then(function (budgets) {
        // 第三张表（items）是第二十五轮加的：直接入库买的东西（填了总价的）也算花钱
        var summary = Stats.budgetSummary(arr[0], budgets, budgetsRange, DB.nowIso(), arr[1], arr[2]);
        var t = summary.total;
        var mine = DB.isAdmin();

        var html =
          '<div class="page-head">' +
            '<div><h1 class="page-title">兵种预算</h1>' +
            '<p class="page-sub">按兵种看预算用了多少。「已用」= 管理员已同意的申请金额 <b>+ 直接入库买的东西</b>' +
              '（按物品上填的总价算，因为那些钱也是真花了）；待审批的不占用预算，' +
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
              '<div><div class="metric-label">已用</div>' +
              '<div class="metric-value" style="font-size:22px">¥' + money(t.spent) + '</div>' +
              '<div class="hint">申请 ¥' + money(t.used) + '　+　入库 ¥' + money(t.direct) + '</div></div>' +
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
              { label: '已用', num: true, render: function (r) {
                  // 已用 = 已同意申请 + 直接入库（第二十五轮）。构成用小字摊开 ——
                  // 不然使用者拿它跟别处对不上会怀疑算错了。
                  // 「入库」那部分**可点**（第二十六轮）：直接入库的东西没有采购申请可以跳，
                  // 点进去是一份明细（买了哪几件、多少钱、谁录的），每条还能点进物品详情。
                  var drillRange = budgetsRange || 'all';
                  return '¥' + money(r.spent) +
                    (r.direct > 0
                      ? '<div class="hint">申请 ¥' + money(r.used) + ' / ' +
                        '<button class="btn small ghost" data-budget-direct="' + UI.esc(r.troop) +
                        '" data-drill-range="' + UI.esc(drillRange) + '" type="button">' +
                        '入库 ¥' + money(r.direct) + ' 明细</button></div>'
                      : ''); } },
              { label: '剩余', num: true, render: function (r) {
                  if (r.troop === Stats.UNSPECIFIED) return '<span class="hint">—</span>';
                  return '<span' + (r.remaining < 0 ? ' style="color:var(--danger);font-weight:700"' : '') + '>¥' + money(r.remaining) + '</span>'; } },
              { label: '使用率', render: usageBar },
              { label: '待审批', num: true, render: function (r) {
                  return r.pending > 0 ? '¥' + money(r.pending) : '<span class="hint">—</span>'; } },
              { label: '已到货实际', num: true, render: function (r) {
                  return r.actual > 0 ? '¥' + money(r.actual) : '<span class="hint">—</span>'; } },
              { label: '申请数', num: true, render: function (r) {
                  // 点一下跳到采购申请页并预置「这个兵种 + 当前预算周期」的筛选（第十五轮），
                  // 而不是弹一个只读列表 —— 那样还能接着往下点进每一条
                  var range = budgetsRange || 'all';
                  return '<button class="btn small" data-budget-drill="' + UI.esc(r.troop) +
                    '" data-drill-range="' + UI.esc(range) + '" type="button">' +
                    UI.esc(r.requests) + ' 次</button>'; } }
            ], summary.rows, {
              emptyText: '还没有任何申请。想让这一页有数，得先有采购申请并配好各兵种的预算额度。'
            }) +
            '</div>' +
          '</div>' +

          '<div class="panel"><div class="panel-body">' +
            '<p class="page-sub" style="margin:0">口径说明：<b>已用 = 已同意的申请金额 + 直接入库买的东西</b>' +
            '（直接入库的那些按物品上填的「总价」算，没填价的不计）；剩余 = 预算 − 已用；' +
            '已取消和已驳回的一律不计（钱不会花出去）。' +
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
            // 存的是 invoiceDate，显示叫「到货日期」（第十四周改名，见 actions.js 的说明）
            { label: '到货日期', render: function (iv) { return UI.esc(iv.invoiceDate || '-'); } },
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
        '<div class="panel no-print"><div class="panel-body">' +
          '<div class="page-actions" style="margin:0">' +
            '<button class="btn small" data-txn-check="all" type="button">全选</button>' +
            '<button class="btn small" data-txn-check="none" type="button">全不选</button>' +
            '<button class="btn small danger" id="txn-del-selected" type="button" disabled>批量删除</button>' +
            '<span class="hint" id="txn-picked"></span>' +
          '</div>' +
          '<div class="hint" style="margin-top:6px">勾选要删的流水（谁都能删，和单条删除一个口径）。' +
            '<b>删除流水不会改物品的库存数量</b> —— 流水是账本；要改数量请另做一次出入库登记。' +
            '每一条都会单独记入「删除记录」。</div>' +
        '</div></div>' +
        '<div class="panel"><div class="panel-head"><h3 class="panel-title">记录</h3>' +
          '<span class="page-sub" id="txn-count"></span></div>' +
          '<div class="panel-body tight" id="txn-table"></div></div>';

      function onMount(root) {
        var state = {};
        // 勾选的流水 id（第二十一轮）。按 id 记、不记 DOM，改筛选条件后勾选还在。
        var picked = {};

        /** 刷新批量工具条：按钮文字带条数，没勾时禁用 */
        function paintBar() {
          var n = Object.keys(picked).filter(function (k) { return picked[k]; }).length;
          var btn = root.querySelector('#txn-del-selected');
          if (btn) {
            btn.disabled = !n;
            btn.textContent = n ? ('批量删除（' + n + '）') : '批量删除';
          }
          var hint = root.querySelector('#txn-picked');
          if (hint) hint.textContent = n ? ('已选 ' + n + ' 条') : '';
        }

        function render() {
          Stats.filterTransactions({
            keyword: state['t-keyword'],
            type: state['t-type'],
            operator: state['t-operator'],
            from: state['t-from'],
            to: state['t-to']
          }).then(function (filtered) {
            UI.qs('#txn-table', root).innerHTML = UI.table([
              { label: '', render: function (t) {
                  return '<input type="checkbox" data-txn-pick="' + UI.esc(t.id) + '"' +
                    (picked[t.id] ? ' checked' : '') + '>'; } },
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
            paintBar();
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
          // 批量删除的勾选框（第二十一轮）：它没有 name，所以先单独接住
          var pick = e.target.getAttribute && e.target.getAttribute('data-txn-pick');
          if (pick) {
            picked[pick] = !!e.target.checked;
            paintBar();
            return;
          }
          var name = e.target.name;
          if (!name || name.indexOf('t-') !== 0) return;
          state[name] = String(e.target.value).trim();
          render();
        });

        // 批量删除工具条：全选 / 全不选 / 批量删除
        root.addEventListener('click', function (e) {
          var chk = e.target.closest ? e.target.closest('[data-txn-check]') : null;
          if (chk) {
            var on = chk.getAttribute('data-txn-check') === 'all';
            // 全选只作用于**当前筛选出来的这些** —— 跟物品清单的批量条一个道理
            (root.__filtered || []).forEach(function (t) { picked[t.id] = on; });
            render();
            return;
          }
          var delBtn = e.target.closest ? e.target.closest('#txn-del-selected') : null;
          if (delBtn) {
            var ids = Object.keys(picked).filter(function (k) { return picked[k]; })
              .map(function (v) { return Number(v); });
            if (!ids.length) { UI.toast('先勾选要删除的流水', 'warn'); return; }
            global.FEVER.Forms.deleteTransactionsBatch(ids, {
              onDone: function () {
                picked = {};
                global.FEVER.App.refresh();
              }
            });
          }
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
   * 标签挑选弹窗（第十五轮）。
   *
   * 以前只有两条路：回物品清单勾一批 → 「批量打印标签」，或者干脆全打。
   * 物品一多，清单里翻找很难受。这里给一个**带搜索、能按大类筛、默认沿用当前选中**
   * 的挑选列表，改完就地重画标签页（不重新走路由，所以不闪、也不丢滚动位置）。
   *
   * 交互细节与「批量下载发票」那个选择器保持一致（复用 .inv-pick-* 样式）：
   * 实时计数、一个都没选时按钮禁用 —— 这类细节踩过一次就别再各写一套。
   */
  function openLabelPicker(opts) {
    var o = opts || {};
    var items = o.items || [];
    var cats = o.cats || {};
    var catList = o.catList || [];
    var batches = o.batches || [];
    // 物品 → 批次号的映射由调用方给（批次信息在采购申请上，标签在物品上，中间要翻一层）
    var batchOf = typeof o.batchOfItem === 'function' ? o.batchOfItem : function () { return ''; };
    var picked = {};
    (o.picked || []).forEach(function (c) { picked[c] = true; });
    var filter = { keyword: '', categoryId: '', batchId: '' };

    var m = UI.openModal({
      title: '选择要打印的标签',
      wide: true,
      body:
        '<div class="filters" style="margin-bottom:10px">' +
          '<div class="field"><label>关键字</label>' +
            '<input class="input" name="l-keyword" placeholder="编码 / 名称 / 规格 / 位置"></div>' +
          '<div class="field"><label>大类</label>' +
            '<select class="select" name="l-category">' +
              ['<option value="">全部</option>'].concat(catList.map(function (c) {
                return '<option value="' + UI.esc(c.id) + '">' + UI.esc(c.name) + '</option>';
              })).join('') +
            '</select></div>' +
          // 按批次筛（第十六轮）：打包提交的那批到货后，标签一次打完。
          // 选项写的是「提交人 · 时间」（第十七轮），批次号放在悬停提示里
          '<div class="field"><label>批次</label>' +
            '<select class="select" name="l-batch">' +
              ['<option value="">全部</option>'].concat(batches.map(function (b) {
                return '<option value="' + UI.esc(b.id) + '" title="批次号 ' + UI.esc(b.id) + '">' +
                  UI.esc(b.label) + '（' + b.count + ' 件）</option>';
              })).join('') +
            '</select></div>' +
        '</div>' +
        '<div class="page-actions" style="margin-bottom:6px">' +
          '<button class="btn small" data-l-check="all" type="button">全选</button>' +
          '<button class="btn small" data-l-check="none" type="button">全不选</button>' +
          '<span class="hint" id="label-pick-count"></span>' +
        '</div>' +
        '<div class="hint" style="margin:-2px 0 8px">改动下面的筛选条件，会<b>自动只勾筛选出来的这些</b>。</div>' +
        '<div class="inv-pick-list" id="label-pick-list"></div>',
      footer: '<button class="btn" data-cancel type="button">取消</button>' +
        '<button class="btn primary" data-ok type="button">用这些标签</button>'
    });
    var mask = m.el;

    function visible() {
      var kw = filter.keyword.toLowerCase();
      return items.filter(function (it) {
        if (filter.categoryId && it.categoryId !== filter.categoryId) return false;
        // 批次挂在申请上、标签挂在物品上，所以靠调用方给的那个映射翻过来
        if (filter.batchId && batchOf(it) !== filter.batchId) return false;
        if (!kw) return true;
        var hay = [it.code, it.name, it.spec, it.location, cats[it.categoryId] || '']
          .join(' ').toLowerCase();
        return hay.indexOf(kw) !== -1;
      });
    }

    function paintCount() {
      var n = Object.keys(picked).filter(function (k) { return picked[k]; }).length;
      var counter = mask.querySelector('#label-pick-count');
      if (counter) counter.textContent = '已选 ' + n + ' / 共 ' + items.length + ' 件';
      var btn = mask.querySelector('[data-ok]');
      if (btn) {
        btn.disabled = n === 0;
        btn.textContent = n ? ('用这些标签（' + n + ' 张）') : '一张都没选';
      }
    }

    function paintList() {
      var list = visible();
      var holder = mask.querySelector('#label-pick-list');
      holder.innerHTML = list.length
        ? list.map(function (it) {
            return '<label class="inv-pick-row">' +
              '<input type="checkbox" name="label-pick" value="' + UI.esc(it.code) + '"' +
                (picked[it.code] ? ' checked' : '') + '>' +
              '<span class="inv-pick-name">' + UI.esc(it.code) + '　' + UI.esc(it.name) +
                '<span class="hint">' + UI.esc(cats[it.categoryId] || it.categoryId) +
                  (it.location ? '　' + UI.esc(it.location) : '') + '</span></span>' +
            '</label>';
          }).join('')
        : '<div class="empty">' + (filter.batchId
            ? '这一批还没有到货生成的物品 —— 没到货的那部分不会出现在这里'
            : '没有符合筛选条件的物品') + '</div>';
      paintCount();
    }

    /**
     * 筛选即选择（第十九轮）：筛选条件一变，就把**现在看得见的**这些勾上、其余取消。
     *
     * 原来筛选只影响"看得见的行"，勾选状态是另一回事 —— 于是默认全选的情况下，
     * "选一个批次 → 用这些标签"交出去的是**全部**标签（本人踩过：用户反馈"打印出来的不是我要的那几张"）。
     * 想只打印某一批的人不会想到还要再点一次「全选」。
     */
    function selectVisible() {
      var next = {};
      visible().forEach(function (it) { next[it.code] = true; });
      picked = next;
    }

    // 勾选状态记在 picked 里，不记在 DOM 上：一改筛选条件列表就重画，
    // 靠 input.checked 记状态会整片丢（跟物品清单的批量选择同一个道理）
    mask.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.name === 'label-pick') { picked[t.value] = !!t.checked; paintCount(); return; }
      var field = t.getAttribute && t.getAttribute('name');
      if (field === 'l-category') {
        filter.categoryId = String(t.value).trim();
        selectVisible();
        paintList();
      } else if (field === 'l-batch') {
        filter.batchId = String(t.value).trim();
        selectVisible();
        paintList();
      }
    });
    mask.addEventListener('input', function (e) {
      var name = e.target && e.target.getAttribute ? e.target.getAttribute('name') : '';
      if (name !== 'l-keyword') return;
      filter.keyword = String(e.target.value).trim();
      selectVisible();
      paintList();
    });
    mask.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-l-check]') : null;
      if (!btn) return;
      var on = btn.getAttribute('data-l-check') === 'all';
      // 全选/全不选只作用于**当前筛出来的这批**：筛出 3 件想全勾，
      // 结果把另外两百件也一起勾上，是最容易出的事故
      visible().forEach(function (it) { picked[it.code] = on; });
      paintList();
    });

    mask.querySelector('[data-cancel]').addEventListener('click', m.close);
    mask.querySelector('[data-ok]').addEventListener('click', function () {
      // 出标签的顺序 = 列表顺序（按编码），可预测；
      // 想按特定顺序贴，回物品清单勾选进入（那条路保留着 pickByCodes 的顺序）
      var next = items.filter(function (it) { return picked[it.code]; })
        .map(function (it) { return it.code; });
      m.close();
      if (o.onOk) o.onOk(next);
    });

    paintList();
  }

  /**
   * 标签打印。
   *
   * 四种进入方式共用同一套版式（**标签长什么样没变，只是能一次出多张**）：
   *   { code: 'VS-0001' }          单个物品 —— 详情页与清单行里的「标签」按钮
   *   { codes: ['VS-0001', ...] }  勾选的一批 —— 物品清单的「批量打印标签」
   *   { categoryId: 'mechanical' } 某个大类下的全部
   *   { batchId: 'B-20261006-4F7K' } 某一次打包提交到货生成的（第十六轮）
   *   {}                           全部物品
   */
  function labels(params) {
    var code = params.code;
    var codes = (params.codes && params.codes.length) ? params.codes : null;
    var categoryId = params.categoryId || '';
    // 打印某一整批（打包提交）到货生成的标签（第十六轮）
    var batchId = params.batchId || '';

    return DB.runTx(['items', 'categories', 'purchaseRequests'], 'readonly', function (T) {
      return Promise.all([T.getAll('items'), T.getAll('categories'), T.getAll('purchaseRequests')])
        .then(function (arr) {
        // 挑选列表按编码排，顺序稳定、可预测。
        // 「按勾选顺序出标签」那条路走的是 pickByCodes，顺序仍然由勾选决定，不受这里影响。
        var items = arr[0].slice().sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
        var cats = catNameMap(arr[1]);
        var catList = arr[1].slice().sort(function (a, b) { return num(a.sortOrder) - num(b.sortOrder); });
        var byCode = {};
        items.forEach(function (i) { byCode[i.code] = i; });

        // 物品 → 它的来源申请 → 批次号（第十六轮）。
        // 标签是物品的，所以"打某一批的标签"= "这批申请到货时生成的物品"。
        var batchOfReq = {};
        var batchInfo = {};   // 批次号 → { at, applicant }
        arr[2].forEach(function (r) {
          if (!r.batchId) return;
          var b = String(r.batchId);
          batchOfReq[String(r.id)] = b;
          var info = batchInfo[b];
          if (!info) { info = batchInfo[b] = { at: '', applicant: '' }; }
          // 时间取这一批**最早**提交的那条（= 报上去的那一刻），人名跟着它走 ——
          // 打包提交时申请人会被统一覆盖，所以同一批里人名其实是同一个。
          var at = String(r.createdAt || '');
          if (!info.at || (at && at < info.at)) {
            info.at = at;
            info.applicant = String(r.applicant || '');
          }
        });
        function batchOfItem(item) {
          return batchOfReq[String(item.purchaseRequestId || '')] || '';
        }
        // 给人看的名字（第十七轮）：「张三 · 10-06 14:30」。
        // 批次号本身不丢 —— 悬停能看到，页头也会写出来，出问题查得清。
        function batchLabel(b) {
          var info = batchInfo[b] || {};
          var at = info.at ? String(info.at).slice(5, 16).replace('T', ' ') : '';
          var who = info.applicant || '（没填申请人）';
          return at ? (who + ' · ' + at) : who;
        }
        // 一条申请生成一个身份，所以"这一批有几张标签"= 这批到货生成的身份数
        var batches = Object.keys(batchInfo).sort().reverse().map(function (b) {
          return {
            id: b,
            label: batchLabel(b),
            count: items.filter(function (i) { return batchOfItem(i) === b; }).length
          };
        });

        /* 初始选中：沿用进入时的那一套语义，行为跟以前完全一样 ——
           只是现在变成了"可以先选再打"，可以再改 */
        var picked = [];
        var scopeText = '';
        if (codes) {
          // 按**勾选顺序**出标签：人撕下来挨着贴的时候才连得上，所以不做排序
          var got = Rules.pickByCodes(items, codes);
          picked = got.map(function (i) { return i.code; });
          var missing = codes.length - got.length;
          scopeText = '你勾选的 ' + codes.length + ' 件' +
            (missing > 0
              ? '，其中 ' + missing + ' 件已经不在了（可能刚被别人删掉），下面只出还在的 ' + got.length + ' 张'
              : '');
        } else if (code) {
          picked = items.filter(function (i) { return i.code === code; }).map(function (i) { return i.code; });
        } else if (batchId) {
          picked = items.filter(function (i) { return batchOfItem(i) === batchId; })
            .map(function (i) { return i.code; });
          scopeText = batchLabel(batchId) + ' 提交的 ' + picked.length + ' 件（批次 ' + batchId + '）' +
            (picked.length ? '' : '　这一批还没有到货，所以还没有物品可打');
        } else if (categoryId) {
          picked = items.filter(function (i) { return i.categoryId === categoryId; }).map(function (i) { return i.code; });
          scopeText = '「' + (cats[categoryId] || categoryId) + '」下的全部 ' + picked.length + ' 件';
        } else {
          picked = items.map(function (i) { return i.code; });
          scopeText = '全部 ' + picked.length + ' 件';
        }

        var html =
          '<div class="page-head no-print">' +
            '<div><h1 class="page-title">标签打印</h1>' +
            '<p class="page-sub" id="label-summary"></p></div>' +
            '<div class="page-actions">' +
              '<button class="btn" data-act="pick-labels" type="button">选择标签</button>' +
              '<button class="btn" data-act="save-labels" type="button">导出标签图片</button>' +
              '<button class="btn primary" data-act="do-print" type="button">打印</button>' +
              '<button class="btn" data-goto="home" type="button">返回</button>' +
            '</div>' +
          '</div>' +
          '<div class="panel no-print"><div class="panel-body">' +
            '<div class="hint">点「选择标签」只打其中几张（能搜关键字、按大类筛、按批次筛，默认全选），' +
            '<b>选完会直接弹出打印窗口</b>。</div>' +
            '<div class="hint"><b>点了完全没反应？</b>说明当前这个环境不给打印（<b>飞书客户端里就是这样</b>，' +
            '手机端也一样）。两条替代路子：① 点「导出标签图片」，把标签存成图片再打印；' +
            '② 在电脑浏览器（Chrome / Edge）里打开这个网址，<b>直接按 Ctrl+P</b> —— ' +
            '打印样式已经调好了，只会打出标签，不会带上导航。</div>' +
            '<div class="hint">也可以回物品清单勾一批再点「批量打印标签」，或在物品详情页点「打印标签」。</div>' +
          '</div></div>' +
          '<div id="label-sheet"></div>';

        /** 一张标签的版式（渲染与重画共用，别写两份） */
        function labelCard(item) {
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
        }

        function onMount(root) {
          var summary = root.querySelector('#label-summary');
          var sheet = root.querySelector('#label-sheet');

          function render() {
            var list = picked.map(function (c) { return byCode[c]; }).filter(Boolean);
            if (summary) {
              summary.innerHTML = '共 ' + list.length + ' 张标签' +
                (scopeText ? '（' + UI.esc(scopeText) + '）' : '') +
                '。确认版式后按 Ctrl+P 打印，打印时上面的导航会被自动隐藏。';
            }
            if (!sheet) return;
            // 打印时纸上会多一行说明（屏幕上不显示）：打出来的是不是自己选的那一批，
            // 一眼就能核对，不用去数字数
            var printLine = '<div class="print-only"><div class="print-line">共 ' + list.length +
              ' 张标签' + (scopeText ? '　' + UI.esc(scopeText) : '') + '　打印时间 ' +
              UI.esc(UI.fmtTime(DB.nowIso())) + '</div></div>';
            sheet.innerHTML = printLine + (list.length
              ? '<div class="panel"><div class="panel-body"><div class="label-sheet">' +
                  list.map(labelCard).join('') +
                '</div></div></div>'
              : '<div class="panel"><div class="panel-body"><div class="empty">没有可打印的标签。</div></div></div>');
            global.FEVER.QR.renderAll(sheet, { level: 'M' });
          }

          /**
           * 统一的打印入口（第十九轮）：页头「打印」、挑选后自动打印、批次页点过来的打印，
           * 全走这里，打完统一记一次打印次数。
           *
           * 第二十轮定的规矩：**第一次打印不打扰；已经打过才问一句要不要重复打印**。
           * 原来还有"待确认 / 确认已贴好"那一套（要求用户确认贴好了没有），已按需求方要求删掉 ——
           * 贴没贴好只有他自己知道，再点一次确认纯属白事。也不在第一次打印后弹任何提示。
           */
          function doPrint(list) {
            var items = (list || []).filter(Boolean);
            if (!items.length) { UI.toast('没有可打印的标签', 'warn'); return; }
            var codes = items.map(function (it) { return it.code; });
            var before = Ops.printedBeforeCount(items);
            var run = function () {
              try { global.print(); } catch (err) { /* 没有打印能力：交给「导出标签图片」 */ }
              Ops.markPrinted({ codes: codes }).then(function () {
                render();
              }).catch(function (err) {
                UI.toast((err && err.message) || '打印次数没记上', 'err');
              });
            };
            if (before) {
              UI.confirmDialog({
                title: '已经打印过了',
                okText: '再次打印',
                body: '这批标签里有 <b>' + before + '</b> / ' + items.length +
                  ' 件之前打印过。是否再次打印？'
              }).then(function (ok) { if (ok) run(); });
              return;
            }
            run();
          }

          /**
           * 导出标签图片（PNG）—— 手机上打不开打印窗口时的出路（第十八轮）。
           * 画完直接把图片摆出来让人长按保存；电脑上还能一键存成文件。
           */
          function exportLabelsAsImage() {
            var list = picked.map(function (c) { return byCode[c]; }).filter(Boolean);
            if (!list.length) { UI.toast('先选要导出的标签', 'warn'); return; }
            var cards = list.map(function (item) {
              var qr = null;
              try { qr = global.FEVER.QR.dataUrl(Rules.qrPayload(item.code), { size: 300, level: 'M' }); }
              catch (err) { qr = null; }
              return {
                code: item.code,
                name: item.name,
                spec: item.spec,
                categoryName: cats[item.categoryId] || item.categoryId,
                location: item.location || '',
                qrDataUrl: qr ? qr.url : null
              };
            });
            var btn = root.querySelector('[data-act="save-labels"]');
            if (btn) btn.disabled = true;
            global.FEVER.LabelImage.render(cards).then(function (canvas) {
              if (btn) btn.disabled = false;
              var url = canvas.toDataURL('image/png');
              var m = UI.openModal({
                title: '标签图片（' + cards.length + ' 张）',
                wide: true,
                body: '<div class="hint" style="margin-bottom:8px">' +
                  '<b>手机上</b>：长按下面这张图保存或分享出去打印。<br>' +
                  '<b>电脑上</b>：点「下载图片」存到本地，双击打开就是图片浏览器，' +
                  '在图片上右键→打印，或按 Ctrl+P 就能把标签打出来。</div>' +
                  '<img alt="标签图" src="' + url + '" style="width:100%;border:1px solid #dfe3ec">',
                footer: '<button class="btn" data-cancel type="button">关闭</button>' +
                  '<button class="btn primary" data-save type="button">下载图片</button>'
              });
              m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
              m.el.querySelector('[data-save]').addEventListener('click', function () {
                global.FEVER.LabelImage.download(canvas, 'FEver标签-' + cards.length + '张.png');
              });
            }).catch(function (err) {
              if (btn) btn.disabled = false;
              UI.toast((err && err.message) || '导出失败', 'err');
            });
          }

          root.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('[data-act="pick-labels"]') : null;
            if (btn) {
              openLabelPicker({
                items: items, cats: cats, catList: catList, batches: batches,
                batchOfItem: batchOfItem, picked: picked.slice(),
                onOk: function (next) {
                  picked = next;
                  scopeText = '你选的 ' + next.length + ' 件';
                  render();
                  // 选完就该**真的**去打印（原来这里只重画页面，用户看着像没反应）。
                  // 打印次数与「待确认」也在这里记（第十九轮）。
                  doPrint(next.map(function (c) { return byCode[c]; }).filter(Boolean));
                }
              });
              return;
            }

            var saveBtn = e.target.closest ? e.target.closest('[data-act="save-labels"]') : null;
            if (saveBtn) { exportLabelsAsImage(); }
          });

          var printBtn = root.querySelector('[data-act="do-print"]');
          if (printBtn) {
            printBtn.addEventListener('click', function () {
              doPrint(picked.map(function (c) { return byCode[c]; }).filter(Boolean));
            });
          }

          render();
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

  /* ================= 待提交清单（第十五轮） ================= */

  /**
   * 「先存起来」的东西攒在这里，攒够了打包提交。
   *
   * 清单存在**共享库的 settings 里**、按登录身份隔离（`Rules.ownerKey`）：
   * 手机攒一半、回电脑能接着攒，而队友看不到你的草稿。
   * 打包提交后这一批共享一个批次号 —— 管理员只收到一条提醒、能整批审批、
   * 能批量确认到货、能按批次打包下载发票。
   */
  function cart() {
    var key = Rules.ownerKey(DB.currentUser());
    return Ops.loadDraftCart({ key: key }).then(function (list) {
      // 默认全选：攒下来的东西本来就是"都要报"的，默认不选反而要人多点一遍
      var picked = list.map(function (d) { return d.draftId; });

      var html =
        '<div class="page-head">' +
          '<div><h1 class="page-title">待提交清单</h1>' +
          '<p class="page-sub">先存起来的东西都在这儿。勾选要报的，打包一次提交 —— ' +
            '管理员只会收到一条提醒。</p></div>' +
          '<div class="page-actions">' +
            '<button class="btn" data-act="new-purchase" type="button">继续添加</button>' +
            '<button class="btn primary" data-act="submit-cart" type="button">打包提交</button>' +
          '</div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3 class="panel-title">清单</h3>' +
            '<span class="page-sub" id="cart-count"></span></div>' +
          '<div class="panel-body tight"><div id="cart-table"></div></div>' +
        '</div>';

      function onMount(root) {
        function draw() {
          var holder = root.querySelector('#cart-table');
          if (!holder) return;
          holder.innerHTML = list.length
            ? UI.table([
                { label: '', cls: 'pick', render: function (d) {
                    return '<input type="checkbox" data-cart-pick="' + UI.esc(d.draftId) + '"' +
                      (picked.indexOf(d.draftId) !== -1 ? ' checked' : '') + '>'; } },
                { label: '物品', render: function (d) {
                    return UI.esc(d.name) + (d.spec ? '<div class="hint">' + UI.esc(d.spec) + '</div>' : ''); } },
                { label: '大类', render: function (d) { return UI.esc(d.categoryId); } },
                { label: '兵种', render: function (d) {
                    return '<span class="badge-pill pill-info">' + UI.esc(d.troop) + '</span>'; } },
                { label: '数量', num: true, render: function (d) { return UI.esc(num(d.quantity)); } },
                { label: '预算', num: true, render: function (d) {
                    return UI.esc(d.budget === '' ? '-' : d.budget); } },
                { label: '申请人', render: function (d) { return UI.esc(d.applicant || '-'); } },
                { label: '操作', render: function (d) {
                    return '<button class="btn small" data-cart-del="' + UI.esc(d.draftId) + '" type="button">移除</button>'; } }
              ], list, { emptyText: '清单是空的' })
            : '<div class="empty">还没有存起来的东西。在「新建采购申请」里填好后点「先存起来」，' +
              '攒够了再回来一次提交。</div>';
          var counter = root.querySelector('#cart-count');
          if (counter) counter.textContent = list.length
            ? '共 ' + list.length + ' 条，已选 ' + picked.length + ' 条'
            : '';
        }

        root.addEventListener('change', function (e) {
          var id = e.target.getAttribute && e.target.getAttribute('data-cart-pick');
          if (!id) return;
          var at = picked.indexOf(id);
          if (e.target.checked && at === -1) picked.push(id);
          else if (!e.target.checked && at !== -1) picked.splice(at, 1);
          draw();
        });

        root.addEventListener('click', function (e) {
          var del = e.target.closest ? e.target.closest('[data-cart-del]') : null;
          if (del) {
            var delId = del.getAttribute('data-cart-del');
            Ops.removeFromDraftCart({ key: key, draftId: delId }).then(function () {
              list = list.filter(function (d) { return d.draftId !== delId; });
              picked = picked.filter(function (x) { return x !== delId; });
              UI.toast('已从清单移除', 'ok');
              draw();
            }).catch(function (err) { UI.toast((err && err.message) || '移除失败', 'err'); });
            return;
          }
          var submit = e.target.closest ? e.target.closest('[data-act="submit-cart"]') : null;
          if (submit) {
            if (!picked.length) { UI.toast('先勾选要提交的物品', 'warn'); return; }
            var first = list.filter(function (d) { return d.draftId === picked[0]; })[0];
            global.FEVER.Forms.openSubmitCartDialog(picked, {
              defaultApplicant: (first && first.applicant) || '',
              onDone: function () {
                var App = global.FEVER.App;
                if (App && App.refresh) App.refresh();
              }
            });
          }
        });

        draw();
      }

      return {
        title: '待提交清单',
        crumb: [{ label: '物资总览', goto: 'home' }, { label: '待提交清单' }],
        html: html,
        onMount: onMount
      };
    });
  }

  /* ================= 批次页（第十五轮） ================= */

  /**
   * 一次打包提交 = 一个批次。这一页把"Batch 之后要做的事"收在一处：
   * 整批同意、批量确认到货、按批次打包下载发票、缺发票时提醒申请人。
   */
  function batch(params) {
    var batchId = String((params && params.id) || '');
    return DB.runTx(['purchaseRequests', 'invoices', 'items', 'categories'], 'readonly', function (T) {
      return Promise.all([
        T.getAll('purchaseRequests'), T.getAll('invoices'), T.getAll('items'), T.getAll('categories')
      ]).then(function (arr) {
        var reqs = arr[0].filter(function (r) { return String(r.batchId || '') === batchId; })
          .sort(function (a, b) { return num(a.id) - num(b.id); });
        if (!reqs.length) {
          return {
            title: '批次 ' + batchId,
            crumb: [{ label: '物资总览', goto: 'home' }, { label: '采购申请', goto: 'purchases' }, { label: batchId }],
            html: '<div class="empty">找不到这个批次（可能这条申请被删了，或者链接不对）。</div>'
          };
        }
        var cats = catNameMap(arr[3]);
        var invByReq = {};
        arr[1].forEach(function (iv) { invByReq[iv.purchaseRequestId] = iv; });
        var itemCount = {};
        arr[2].forEach(function (it) {
          if (it.purchaseRequestId) itemCount[it.purchaseRequestId] = (itemCount[it.purchaseRequestId] || 0) + 1;
        });

        var mine = DB.isAdmin();
        var pendingIds = reqs.filter(function (r) { return Rules.isPendingApproval(r); }).map(function (r) { return r.id; });
        var canArrive = reqs.filter(function (r) { return r.status !== 'arrived' && r.status !== 'canceled' && Rules.isApproved(r); });
        // 发票情况走 Stats.batchInvoiceInfo —— 与采购申请列表上的「整批发票」同一个函数，
        // 两处口径必须一致（以前各算一遍的教训）
        var info = Stats.batchInvoiceInfo(arr[0], arr[1], batchId);
        var noFile = info.missingNames.length;
        var applicants = info.missingNames;

        var pickable = canArrive.map(function (r) {
          return '<label class="inv-pick-row">' +
            '<input type="checkbox" name="arrive-pick" value="' + UI.esc(r.id) + '" checked>' +
            '<span class="inv-pick-name">' + UI.esc(r.name) + ' ×' + UI.esc(num(r.quantity)) +
              '<span class="hint">' + UI.esc(r.applicant || '-') + '　预算 ' + UI.esc(r.budget || '-') + ' 元</span></span>' +
          '</label>';
        }).join('');

        var html =
          '<div class="page-head">' +
            '<div><h1 class="page-title">批次 ' + UI.esc(batchId) + '</h1>' +
            '<p class="page-sub">' + reqs.length + ' 条申请，申请人 ' +
              UI.esc(reqs[0].applicant || '-') + '，提交于 ' + UI.esc(UI.fmtTime(reqs[0].createdAt)) + '</p></div>' +
            '<div class="page-actions">' +
              '<button class="btn" data-goto="purchases" type="button">回采购申请</button>' +
            '</div>' +
          '</div>' +
          '<div class="panel"><div class="panel-head"><h3 class="panel-title">这一批</h3></div>' +
            '<div class="panel-body tight">' +
            UI.table([
              { label: '#', render: function (r) {
                  return '<span class="code-cell" data-open-purchase="' + UI.esc(r.id) + '">' + UI.esc(r.id) + '</span>'; } },
              { label: '物品', render: function (r) { return UI.esc(r.name); } },
              { label: '大类', render: function (r) { return UI.esc(cats[r.categoryId] || r.categoryId); } },
              { label: '兵种', render: function (r) {
                  return '<span class="badge-pill pill-info">' + UI.esc(Rules.troopOf(r) || '未指定') + '</span>'; } },
              { label: '数量', num: true, render: function (r) { return UI.esc(num(r.quantity)); } },
              { label: '预算', num: true, render: function (r) { return UI.esc(r.budget || '-'); } },
              { label: '审批', render: function (r) { return approvalPillOf(r); } },
              { label: '状态', render: function (r) { return statusCellOf(r); } },
              { label: '发票', render: function (r) {
                  var iv = invByReq[r.id];
                  if (r.status !== 'arrived') return '<span class="hint">未到货</span>';
                  if (!iv) return '<span class="hint">无发票</span>';
                  return (iv.fileRef || iv.fileData)
                    ? '<button class="btn small" data-goto-invoice="' + UI.esc(iv.id) + '" type="button">' + UI.esc(Rules.invoiceLabel(iv)) + '</button>'
                    : '<span class="badge-pill pill-warn">缺发票</span>'; } }
            ], reqs, { emptyText: '这一批没有申请' }) +
            '</div>' +
          '</div>' +
          '<div class="panel no-print"><div class="panel-head"><h3 class="panel-title">这一批的动作</h3></div>' +
            '<div class="panel-body">' +
              (mine && pendingIds.length
                ? '<div style="margin-bottom:10px">' +
                    '<button class="btn primary" data-batch-approve type="button">整批同意（' + pendingIds.length + ' 条）</button> ' +
                    '<span class="hint">也可以在上面逐条同意 / 驳回 —— 两种用法都支持</span></div>'
                : '') +
              (canArrive.length
                ? '<div style="margin-bottom:10px"><div class="page-sub">选择哪些到了（允许只到一部分，没到的留在批次里）：</div>' +
                    '<div class="inv-pick-list">' + pickable + '</div>' +
                    '<button class="btn primary" data-batch-arrive type="button" style="margin-top:8px">批量确认到货（逐条填信息）</button></div>'
                : '') +
              // 「打印这批标签」（第十六轮）：到货多少打多少，一次把这一批贴完
              (info.arrived
                ? '<div style="margin-bottom:10px"><button class="btn" data-batch-labels="' + UI.esc(batchId) +
                  '" type="button">打印这批的标签（' + info.arrived + ' 条已到货）</button> ' +
                  '<span class="hint">跳到标签页并只列这一批到货生成的物品</span></div>'
                : '') +
              (mine && info.invoiceIds.length
                ? '<div style="margin-bottom:10px"><button class="btn" data-batch-invoices type="button">打包下载本批发票（' +
                    info.invoiceIds.length + ' 张）</button></div>'
                : '') +
              (mine && noFile
                ? '<div>' +
                    '<div class="alert-item warn"><span class="who">' + noFile + ' 条还缺发票</span>' +
                    '<span>' + UI.esc(applicants.join('、') || '（这些申请没填申请人）') + '</span>' +
                    '<button class="btn small" data-batch-remind type="button">提醒他们补发票</button></div>' +
                    '<div class="hint" style="margin-top:6px">提醒走飞书私聊，只能发给<b>登录过这个应用</b>的人；' +
                    '发不出去的会当场告诉你。</div>' +
                  '</div>'
                : '') +
              (!pendingIds.length && !canArrive.length && !info.invoiceIds.length && !noFile && !info.arrived
                ? '<div class="hint">这一批暂时没有可做的动作。</div>'
                : '') +
            '</div>' +
          '</div>';

        function onMount(root) {
          root.addEventListener('click', function (e) {
            var t = e.target;

            var approve = t.closest ? t.closest('[data-batch-approve]') : null;
            if (approve) {
              UI.confirmDialog({
                title: '整批同意这 ' + pendingIds.length + ' 条？',
                okText: '整批同意',
                body: '同意之后它们就能下单采购了，申请的金额会各自占用所属兵种的预算。<br>' +
                  '如果其中某一条不合适，请改用上面每一行自己的「驳回」，并写清理由。'
              }).then(function (ok) {
                if (!ok) return null;
                return Ops.approveRequests(pendingIds).then(function (r) {
                  UI.toast('已同意 ' + r.approved.length + ' 条' +
                    (r.skipped ? '，跳过 ' + r.skipped + ' 条（已被处理）' : ''), 'ok');
                  global.FEVER.App.refresh();
                  return r;
                });
              }).catch(function (err) { UI.toast((err && err.message) || '整批同意失败', 'err'); });
              return;
            }

            var arrive = t.closest ? t.closest('[data-batch-arrive]') : null;
            if (arrive) {
              var pickedIds = UI.qsa('input[name="arrive-pick"]:checked', root).map(function (b) {
                return num(b.value);
              });
              if (!pickedIds.length) { UI.toast('先勾选哪些已经到货', 'warn'); return; }
              global.FEVER.Forms.openArriveWizard(pickedIds, {
                onDone: function () { global.FEVER.App.refresh(); }
              });
              return;
            }

            // 打印这批标签（第十六轮）：直接跳标签页，由它按批次筛好
            var labelsBtn = t.closest ? t.closest('[data-batch-labels]') : null;
            if (labelsBtn) {
              global.FEVER.App.goto('labels', { batchId: labelsBtn.getAttribute('data-batch-labels') });
              return;
            }

            var invs = t.closest ? t.closest('[data-batch-invoices]') : null;
            if (invs) {
              var App = global.FEVER.App;
              if (!App || !App.downloadAllInvoices) { UI.toast('这个环境下取不到打包功能', 'err'); return; }
              if (noFile) {
                UI.toast('本批还有 ' + noFile + ' 条没上传发票，打包里不会包含它们', 'warn');
              }
              App.downloadAllInvoices(info.invoiceIds);
              return;
            }

            var remind = t.closest ? t.closest('[data-batch-remind]') : null;
            if (remind) {
              if (!applicants.length) { UI.toast('这些申请没填申请人，没法按人提醒', 'warn'); return; }
              remind.disabled = true;
              DB.notifyInvoice(applicants, batchId).then(function (res) {
                remind.disabled = false;
                var results = (res && res.results) || [];
                var okNames = results.filter(function (r) { return r.sent; }).map(function (r) { return r.name; });
                var failed = results.filter(function (r) { return !r.sent; });
                var lines = [];
                if (okNames.length) lines.push('已提醒：' + okNames.join('、'));
                if (failed.length) {
                  lines.push('发不出去：' + failed.map(function (r) {
                    return r.name + (r.reason === 'not_found' ? '（还没登录过这个应用）' : '（发送失败）');
                  }).join('、'));
                }
                UI.openModal({
                  title: '提醒结果',
                  body: '<div style="line-height:1.9">' + (lines.length ? lines.join('<br>') : '没有任何人需要提醒') +
                    (failed.length ? '<br><br><span class="hint">发不出去的人，只能你自己在群里／私聊催一下 —— ' +
                      '飞书私聊要求对方先登录过一次这个应用，我们才拿得到他的身份。</span>' : '') +
                    '</div>'
                });
              }).catch(function (err) {
                remind.disabled = false;
                UI.toast((err && err.message) || '提醒失败', 'err');
              });
            }
          });
        }

        return {
          title: '批次 ' + batchId,
          crumb: [{ label: '物资总览', goto: 'home' }, { label: '采购申请', goto: 'purchases' }, { label: batchId }],
          html: html,
          onMount: onMount
        };
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
  global.FEVER.Views.cart = cart;
  global.FEVER.Views.batch = batch;
})(typeof globalThis !== 'undefined' ? globalThis : this);
