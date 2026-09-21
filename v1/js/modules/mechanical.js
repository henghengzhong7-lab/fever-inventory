/**
 * 机械大类专属逻辑
 *
 * 这个类关心三件事：
 *   1) 这个件装在哪台车的哪个位置（装配位置检索）
 *   2) 标准件还剩多少个（同款共用 + 安全库存）
 *   3) 哪些件该补货了
 */
(function (global) {
  'use strict';

  function extra(item) { return item.extra || {}; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  /** 首页卡片上额外展示的指标：低库存件数 */
  function cardMetrics(summary) {
    return [
      { label: '低库存待补', value: summary.lowStock, alert: summary.lowStock > 0 }
    ];
  }

  /** 本类特有的筛选控件：按车型与装配位置找件 */
  function filterControls() {
    return '' +
      '<div class="field"><label>适配车型</label>' +
        '<input class="input" name="f-vehicle" placeholder="如：2026主车" data-filter="mechanical"></div>' +
      '<div class="field"><label>装配位置</label>' +
        '<input class="input" name="f-assemblePos" placeholder="如：底盘左侧" data-filter="mechanical"></div>' +
      '<div class="field"><label>库存类型</label>' +
        '<select class="select" name="f-stockType" data-filter="mechanical">' +
          '<option value="">全部</option>' +
          '<option value="standard">只看标准件（同款共用）</option>' +
          '<option value="low">只看低库存</option>' +
        '</select></div>';
  }

  /** 判断一个物品是否命中本类筛选条件 */
  function matches(item, state) {
    var s = state || {};
    var e = extra(item);
    if (s['f-vehicle'] && String(e.vehicle || '').indexOf(s['f-vehicle']) === -1) return false;
    if (s['f-assemblePos'] && String(e.assemblePos || '').indexOf(s['f-assemblePos']) === -1) return false;
    if (s['f-stockType'] === 'standard' && item.identityMode !== 'shared') return false;
    if (s['f-stockType'] === 'low') {
      var safety = item.safetyStock;
      if (safety === null || safety === undefined || safety === '') return false;
      if (num(item.inStockQty) >= num(safety)) return false;
    }
    return true;
  }

  /** 物品表里本类特有的列：装在哪 */
  function listColumns() {
    return [
      { label: '适配车型', render: function (i) { return global.FEVER.UI.esc(extra(i).vehicle || '-'); } },
      { label: '装配位置', render: function (i) { return global.FEVER.UI.esc(extra(i).assemblePos || '-'); } },
      {
        label: '材质 / 尺寸',
        render: function (i) {
          var e = extra(i);
          return global.FEVER.UI.esc([e.material, e.size].filter(Boolean).join(' / ') || '-');
        }
      }
    ];
  }

  /** 详情页里本类的展示块 */
  function detailSections(item, category) {
    var UI = global.FEVER.UI;
    var Rules = global.FEVER.Rules;
    var e = extra(item);
    var rows = [
      ['适配车型', e.vehicle], ['装配位置', e.assemblePos], ['材质', e.material],
      ['尺寸规格', e.size], ['承重 / 载荷', e.loadCapacity], ['预计寿命', e.lifespan],
      ['维护周期', e.maintenanceCycle]
    ];
    var html = '<h4 style="margin:16px 0 8px">机械属性</h4><table class="grid"><tbody>' +
      rows.map(function (r) {
        return '<tr><th style="width:130px;background:#fafbfe">' + UI.esc(r[0]) + '</th><td>' + UI.esc(r[1] || '-') + '</td></tr>';
      }).join('') + '</tbody></table>';

    var stockLine;
    if (item.identityMode === 'shared') {
      var safety = (item.safetyStock === null || item.safetyStock === undefined || item.safetyStock === '')
        ? '未设置' : num(item.safetyStock);
      var low = (item.safetyStock !== null && item.safetyStock !== undefined && item.safetyStock !== '' && num(item.inStockQty) < num(item.safetyStock));
      stockLine = '<div class="alert-item ' + (low ? 'warn' : 'info') + '" style="margin-top:10px">' +
        '标准件库存：在库 ' + num(item.inStockQty) + ' 个，安全库存 ' + UI.esc(safety) + (low ? ' —— 需要补货' : '') +
        '</div>';
    } else {
      var rem = global.FEVER.Rules.remindersFor(item, category, new Date());
      stockLine = '<div class="alert-item info" style="margin-top:10px">该件为单独追踪件，请整件借还。</div>' +
        (rem.length ? UI.alertBar(rem.map(function (r) { return { level: r.level, text: r.text }; })) : '');
    }
    return html + stockLine + (function () { void Rules; return ''; })();
  }

  /** 本类摘要一句话 */
  function summaryLine(summary) {
    return '共 ' + summary.itemKinds + ' 种，在库 ' + summary.inStockQty + ' 个' +
      (summary.lowStock ? '，' + summary.lowStock + ' 种低于安全库存' : '');
  }

  /**
   * 标准件库存对照表：同款共用的件按"款"列出在库与安全库存。
   * 低于安全库存的标记出来，让机械页一眼看出该补哪些标准件。
   */
  function standardStock(items) {
    return (items || []).filter(function (i) {
      return i.identityMode === 'shared';
    }).map(function (i) {
      var raw = i.safetyStock;
      var safety = (raw === null || raw === undefined || raw === '') ? null : num(raw);
      var inStock = num(i.inStockQty);
      return {
        code: i.code, name: i.name, spec: i.spec,
        inStock: inStock, safety: safety,
        low: safety !== null && inStock < safety
      };
    });
  }

  /** 装配位置索引：把本类物品按装配位置归堆，方便按位置找件 */
  function positionIndex(items) {
    var map = {};
    (items || []).forEach(function (i) {
      var pos = String(extra(i).assemblePos || '').trim();
      if (!pos) return;
      if (!map[pos]) map[pos] = [];
      map[pos].push(i);
    });
    return Object.keys(map).sort().map(function (pos) {
      return { position: pos, items: map[pos] };
    });
  }

  /** 本类专属工作区：标准件库存 + 装配位置索引 */
  function workspace(summary) {
    var UI = global.FEVER.UI;
    var items = summary.items || [];
    var std = standardStock(items);
    var lowCount = std.filter(function (r) { return r.low; }).length;
    var index = positionIndex(items);

    var html = '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">标准件库存</h3>' +
      '<span class="page-sub" id="mod-mech-stock-note">' +
        (std.length ? (lowCount ? lowCount + ' 种低于安全库存，需要补货' : '都在安全库存以上') : '本类还没有同款共用的标准件') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-mech-stock">' +
      (std.length ? UI.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.code) + '">' + UI.esc(r.code) + '</span>'; } },
        { label: '名称 / 规格', render: function (r) {
            return UI.esc(r.name) + (r.spec ? '<div class="hint">' + UI.esc(r.spec) + '</div>' : ''); } },
        { label: '在库', num: true, render: function (r) { return UI.esc(r.inStock); } },
        { label: '安全库存', num: true, render: function (r) {
            return UI.esc(r.safety === null ? '未设置' : r.safety); } },
        { label: '状态', render: function (r) {
            return r.low
              ? '<span class="badge-pill pill-warn">需补货</span>'
              : '<span class="badge-pill pill-in_stock">充足</span>'; } }
      ], std, { rowClass: function (r) { return r.low ? 'row-low-stock' : ''; } })
        : '<div class="empty">本类还没有同款共用的标准件</div>') +
      '</div></div>';

    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">装配位置索引</h3>' +
      '<span class="page-sub">按装在哪台车的哪个位置找件，点编码进详情</span></div>' +
      '<div class="panel-body" id="mod-mech-pos">' +
      (index.length ? '<div class="pos-index">' + index.map(function (g) {
        return '<div class="pos-group">' +
          '<div class="pos-name">' + UI.esc(g.position) +
            '<span class="pos-count">' + g.items.length + ' 种</span></div>' +
          '<div class="pos-items">' + g.items.map(function (i) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(i.code) + '">' +
              UI.esc(i.code) + '</span><span class="hint"> ' + UI.esc(i.name) + '</span>';
          }).join('　') + '</div></div>';
      }).join('') + '</div>'
        : '<div class="empty">还没有填过「装配位置」的物品</div>') +
      '</div></div>';

    return html;
  }

  var mod = {
    id: 'mechanical',
    standardStock: standardStock,
    positionIndex: positionIndex,
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
  global.FEVER.Modules.mechanical = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this);
