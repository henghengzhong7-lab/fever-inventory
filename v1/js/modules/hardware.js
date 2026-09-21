/**
 * 硬件大类专属逻辑
 *
 * 这个类关心三件事：
 *   1) 工具借出去还没还（工具要记校准日期，到期要检）
 *   2) 耗材还剩多少（余量低于安全库存要报警）
 *   3) 框架结构件装在哪
 */
(function (global) {
  'use strict';

  function extra(item) { return item.extra || {}; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function UI() { return global.FEVER.UI; }

  function isTool(item) { return extra(item).isTool === '是'; }

  function isLowStock(item) {
    var safety = item.safetyStock;
    if (safety === null || safety === undefined || safety === '') return false;
    return num(item.inStockQty) < num(safety);
  }

  /** 卡片指标：在借工具数、低库存耗材数 */
  function cardMetrics(summary) {
    var items = summary.items || [];
    var lentTools = items.filter(function (i) { return isTool(i) && num(i.lentQty) > 0; }).length;
    var low = items.filter(isLowStock).length;
    var calDue = summary.reminders.filter(function (r) { return r.kind === 'tool_calibration'; }).length;
    return [
      { label: '在借工具', value: lentTools, alert: lentTools > 0 },
      { label: '耗材需补货', value: low, alert: low > 0 },
      { label: '工具待校准', value: calDue, alert: calDue > 0 }
    ];
  }

  /** 本类筛选：按工具 / 耗材、装配位置、低库存 */
  function filterControls() {
    return '' +
      '<div class="field"><label>类型</label>' +
        '<select class="select" name="f-kind" data-filter="hardware">' +
          '<option value="">全部</option>' +
          '<option value="tool">工具</option>' +
          '<option value="consumable">耗材</option>' +
        '</select></div>' +
      '<div class="field"><label>装配位置</label>' +
        '<input class="input" name="f-assemblePos" placeholder="如：底盘右侧" data-filter="hardware"></div>' +
      '<div class="field"><label>库存</label>' +
        '<select class="select" name="f-stock" data-filter="hardware">' +
          '<option value="">全部</option>' +
          '<option value="low">只看需补货</option>' +
          '<option value="lent">只看有在借</option>' +
        '</select></div>';
  }

  function matches(item, state) {
    var s = state || {};
    var e = extra(item);
    if (s['f-kind'] === 'tool' && !isTool(item)) return false;
    if (s['f-kind'] === 'consumable' && isTool(item)) return false;
    if (s['f-assemblePos'] && String(e.assemblePos || '').indexOf(s['f-assemblePos']) === -1) return false;
    if (s['f-stock'] === 'low' && !isLowStock(item)) return false;
    if (s['f-stock'] === 'lent' && num(item.lentQty) <= 0) return false;
    return true;
  }

  function listColumns() {
    return [
      { label: '类型', render: function (i) {
          return isTool(i)
            ? '<span class="badge-pill pill-info">工具</span>'
            : '<span class="badge-pill pill-shared">耗材 / 结构件</span>';
        } },
      { label: '余量 / 安全库存', render: function (i) {
          var safety = (i.safetyStock === null || i.safetyStock === undefined || i.safetyStock === '') ? '-' : num(i.safetyStock);
          var low = isLowStock(i);
          return '<span' + (low ? ' style="color:var(--danger);font-weight:700"' : '') + '>' +
            num(i.inStockQty) + ' / ' + safety + '</span>' + (low ? ' <span class="badge-pill pill-warn">需补货</span>' : '');
        } },
      { label: '装配位置', render: function (i) { return UI().esc(extra(i).assemblePos || '-'); } },
      { label: '最近校准', render: function (i) {
          var d = extra(i).lastCalibrationDate;
          if (!isTool(i)) return '-';
          return UI().esc(d || '未校准');
        } }
    ];
  }

  function detailSections(item, category) {
    var ui = UI();
    var e = extra(item);
    var rows = [
      ['是否工具', e.isTool], ['材质', e.material], ['表面处理', e.surfaceTreatment],
      ['安装孔位', e.mountingHoles], ['装配位置', e.assemblePos], ['重量', e.weight],
      ['最近校准日期', e.lastCalibrationDate]
    ];
    var html = '<h4 style="margin:16px 0 8px">硬件属性</h4><table class="grid"><tbody>' +
      rows.map(function (r) {
        return '<tr><th style="width:130px;background:#fafbfe">' + ui.esc(r[0]) + '</th><td>' + ui.esc(r[1] || '-') + '</td></tr>';
      }).join('') + '</tbody></table>';

    html += '<div class="alert-bar" style="margin-top:12px">';
    if (isLowStock(item)) {
      html += '<div class="alert-item warn"><span class="who">需补货</span><span>在库 ' + num(item.inStockQty) +
        '，已低于安全库存 ' + num(item.safetyStock) + '，建议尽快补。</span></div>';
    }
    if (isTool(item)) {
      var cal = global.FEVER.Rules.remindersFor(item, category, new Date())
        .filter(function (r) { return r.kind === 'tool_calibration'; });
      if (cal.length) {
        cal.forEach(function (r) {
          html += '<div class="alert-item warn"><span class="who">校准</span><span>' + ui.esc(r.text) + '</span></div>';
        });
      } else if (e.lastCalibrationDate) {
        html += '<div class="alert-item info"><span class="who">校准</span><span>上次校准 ' + ui.esc(e.lastCalibrationDate) + '，仍在周期内。</span></div>';
      }
      if (num(item.lentQty) > 0) {
        html += '<div class="alert-item warn"><span class="who">在借中</span><span>这把工具当前不在库，请到「借用台账」查看借用人。</span></div>';
      }
    }
    html += '</div>';
    return html;
  }

  function summaryLine(summary) {
    var items = summary.items || [];
    var tools = items.filter(isTool).length;
    var low = items.filter(isLowStock).length;
    return '共 ' + summary.itemKinds + ' 种（' + tools + ' 种工具），在库 ' + summary.inStockQty + ' 件' +
      (low ? '，' + low + ' 种需要补货' : '');
  }

  /** 工具检定台账：校准日期、距今天数、是否到期、当前是否在外 */
  function toolLedger(items, category, today) {
    var cycle = num(((category || {}).reminders || {}).toolCalibrationDays);
    var now = today || new Date();
    return (items || []).filter(isTool).map(function (i) {
      var last = extra(i).lastCalibrationDate || '';
      var age = last ? global.FEVER.Rules.daysBetween(last, now) : null;
      var due = cycle > 0 && (last ? (age !== null && age > cycle) : true);
      return {
        code: i.code, name: i.name, last: last, age: age, cycle: cycle, due: due,
        lentQty: num(i.lentQty), inStockQty: num(i.inStockQty)
      };
    }).sort(function (a, b) {
      if (a.due !== b.due) return a.due ? -1 : 1;
      return num(b.age) - num(a.age);
    });
  }

  /** 耗材余量表：在库余量与安全库存对照 */
  function consumableLevels(items) {
    return (items || []).filter(function (i) { return !isTool(i); }).map(function (i) {
      var raw = i.safetyStock;
      var safety = (raw === null || raw === undefined || raw === '') ? null : num(raw);
      var inStock = num(i.inStockQty);
      return {
        code: i.code, name: i.name, spec: i.spec,
        inStock: inStock, safety: safety,
        low: safety !== null && inStock < safety,
        out: inStock <= 0
      };
    }).sort(function (a, b) {
      if (a.low !== b.low) return a.low ? -1 : 1;
      return a.inStock - b.inStock;
    });
  }

  /** 本类专属工作区：工具校准 + 耗材余量 + 低库存报警 */
  function workspace(summary, category, today) {
    var ui = UI();
    var items = summary.items || [];
    var cat = category || summary.category;
    var tools = toolLedger(items, cat, today);
    var dueCount = tools.filter(function (r) { return r.due; }).length;
    var consumables = consumableLevels(items);
    var low = consumables.filter(function (r) { return r.low; });

    var html = '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">工具校准检定</h3>' +
      '<span class="page-sub" id="mod-hw-cal-note">' +
        '校准周期 ' + num((cat.reminders || {}).toolCalibrationDays) + ' 天' +
        (dueCount ? '　·　' + dueCount + ' 把已到期' : '　·　都在周期内') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-hw-cal">' +
      (tools.length ? ui.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + ui.esc(r.code) + '">' + ui.esc(r.code) + '</span>'; } },
        { label: '工具', render: function (r) { return ui.esc(r.name); } },
        { label: '最近校准', render: function (r) { return ui.esc(r.last || '从未校准'); } },
        { label: '距今天数', num: true, render: function (r) { return ui.esc(r.age === null ? '-' : r.age); } },
        { label: '校准状态', render: function (r) {
            return r.due
              ? '<span class="badge-pill pill-warn">已到期，需送检</span>'
              : '<span class="badge-pill pill-in_stock">周期内</span>'; } },
        { label: '在库 / 借出', render: function (r) {
            return ui.esc(r.inStockQty) + ' / ' + ui.esc(r.lentQty); } }
      ], tools, { rowClass: function (r) { return r.due ? 'row-low-stock' : ''; } })
        : '<div class="empty">本类还没有登记「是否工具 = 是」的物品</div>') +
      '</div></div>';

    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">耗材余量</h3>' +
      '<span class="page-sub" id="mod-hw-level-note">' +
        (consumables.length
          ? (low.length ? low.length + ' 种低于安全库存，需要补货' : '余量都在安全库存以上')
          : '本类还没有耗材 / 结构件') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-hw-level">' +
      (consumables.length ? ui.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + ui.esc(r.code) + '">' + ui.esc(r.code) + '</span>'; } },
        { label: '名称 / 规格', render: function (r) {
            return ui.esc(r.name) + (r.spec ? '<div class="hint">' + ui.esc(r.spec) + '</div>' : ''); } },
        { label: '余量', num: true, render: function (r) { return ui.esc(r.inStock); } },
        { label: '安全库存', num: true, render: function (r) {
            return ui.esc(r.safety === null ? '未设置' : r.safety); } },
        { label: '余量状态', render: function (r) {
            if (r.out) return '<span class="badge-pill pill-danger">已用完</span>';
            if (r.low) return '<span class="badge-pill pill-warn">需补货</span>';
            return '<span class="badge-pill pill-in_stock">充足</span>'; } }
      ], consumables, { rowClass: function (r) { return r.low ? 'row-low-stock' : ''; } })
        : '<div class="empty">本类还没有耗材或结构件</div>') +
      '</div></div>';

    var lentTools = tools.filter(function (r) { return r.lentQty > 0; });
    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">低库存报警</h3>' +
      '<span class="page-sub" id="mod-hw-alert-note">' +
        (low.length ? '这 ' + low.length + ' 种低于安全库存，建议尽快补' : '暂时没有需要补货的') +
        (lentTools.length ? '　·　另有 ' + lentTools.length + ' 把工具在外面' : '') +
      '</span></div>' +
      '<div class="panel-body" id="mod-hw-alert"><div class="alert-bar">' +
      (low.length ? low.map(function (r) {
        return '<div class="alert-item warn"><span class="who">' + ui.esc(r.name) + '</span>' +
          '<span><span class="code-cell" data-goto-item="' + ui.esc(r.code) + '">' + ui.esc(r.code) + '</span>' +
          ' 余量 ' + ui.esc(r.inStock) + '，安全库存 ' + ui.esc(r.safety) + '，需要补货</span></div>';
      }).join('') : '<div class="alert-item info"><span>所有耗材余量都在安全库存以上。</span></div>') +
      '</div></div></div>';

    return html;
  }

  var mod = {
    id: 'hardware',
    isTool: isTool,
    isLowStock: isLowStock,
    toolLedger: toolLedger,
    consumableLevels: consumableLevels,
    cardMetrics: cardMetrics,
    filterControls: filterControls,
    matches: matches,
    listColumns: listColumns,
    detailSections: detailSections,
    summaryLine: summaryLine,
    workspace: workspace
  };

  global.FEVER = global.FEVER || {};
  global.FEVER.Modules = global.FEVER.Modules || {};
  global.FEVER.Modules.hardware = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this);
