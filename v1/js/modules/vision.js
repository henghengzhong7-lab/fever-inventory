/**
 * 视觉大类专属逻辑
 *
 * 这个类关心三件事：
 *   1) 每台相机 / 每个镜头都是独立的一件（单独建身份，一件一码）
 *   2) 镜头配哪台相机（配套关系）
 *   3) 标定有没有过期（超期要重新标定）
 * 视觉设备贵重，借用超期会重点提醒。
 */
(function (global) {
  'use strict';

  function extra(item) { return item.extra || {}; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function UI() { return global.FEVER.UI; }

  /** 是否属于贵重设备（需要重点提示借用超期） */
  function isPrecious(item) {
    return item.identityMode === 'single';
  }

  function calibrationState(item, category, today) {
    var rem = global.FEVER.Rules.remindersFor(item, category, today || new Date());
    return rem.filter(function (r) { return r.kind === 'calibration'; });
  }

  /** 卡片指标：待标定件数与在借贵重设备数 */
  function cardMetrics(summary) {
    var items = summary.items || [];
    var needCal = summary.reminders.filter(function (r) { return r.kind === 'calibration'; }).length;
    var lentPrecious = items.filter(function (i) { return isPrecious(i) && Number(i.lentQty) > 0; }).length;
    return [
      { label: '待标定 / 需重标', value: needCal, alert: needCal > 0 },
      { label: '在借贵重设备', value: lentPrecious, alert: lentPrecious > 0 }
    ];
  }

  /** 本类筛选：按镜头接口、标定状态、配套相机 */
  function filterControls() {
    return '' +
      '<div class="field"><label>镜头接口</label>' +
        '<select class="select" name="f-lensMount" data-filter="vision">' +
          '<option value="">全部</option><option value="CS">CS</option><option value="C">C</option>' +
          '<option value="M12">M12</option><option value="其它">其它</option>' +
        '</select></div>' +
      '<div class="field"><label>标定状态</label>' +
        '<select class="select" name="f-calibrationStatus" data-filter="vision">' +
          '<option value="">全部</option><option value="未标定">未标定</option>' +
          '<option value="已标定">已标定</option><option value="需重新标定">需重新标定</option>' +
        '</select></div>' +
      '<div class="field"><label>配套相机</label>' +
        '<input class="input" name="f-cameraPair" placeholder="如：VS-0002" data-filter="vision"></div>';
  }

  function matches(item, state) {
    var s = state || {};
    var e = extra(item);
    if (s['f-lensMount'] && String(e.lensMount || '') !== s['f-lensMount']) return false;
    if (s['f-calibrationStatus'] && String(e.calibrationStatus || '') !== s['f-calibrationStatus']) return false;
    if (s['f-cameraPair'] && String(e.cameraPair || '').indexOf(s['f-cameraPair']) === -1) return false;
    return true;
  }

  function listColumns() {
    return [
      { label: '分辨率 / 帧率', render: function (i) {
          var e = extra(i);
          return UI().esc([e.resolution, e.frameRate].filter(Boolean).join(' / ') || '-');
        } },
      { label: '镜头接口', render: function (i) {
          var m = extra(i).lensMount;
          return m ? '<span class="badge-pill pill-info">' + UI().esc(m) + '</span>' : '-';
        } },
      { label: '配套相机', render: function (i) { return UI().esc(extra(i).cameraPair || '-'); } },
      { label: '标定', render: function (i) {
          var e = extra(i);
          var status = e.calibrationStatus || '未标定';
          var stale = e.calibrationStatus === '需重新标定';
          var cls = stale ? 'pill-warn' : (status === '已标定' ? 'pill-in_stock' : 'pill-info');
          return '<span class="badge-pill ' + cls + '">' + UI().esc(status) + '</span>' +
            (e.lastCalibrationDate ? '<div class="hint">' + UI().esc(e.lastCalibrationDate) + '</div>' : '');
        } }
    ];
  }

  function detailSections(item, category) {
    var ui = UI();
    var e = extra(item);
    var rows = [
      ['分辨率', e.resolution], ['帧率', e.frameRate], ['焦距 / 视场角', e.focalLength],
      ['镜头接口', e.lensMount], ['配套相机', e.cameraPair],
      ['标定状态', e.calibrationStatus], ['最近标定日期', e.lastCalibrationDate]
    ];
    var html = '<h4 style="margin:16px 0 8px">视觉属性</h4><table class="grid"><tbody>' +
      rows.map(function (r) {
        return '<tr><th style="width:130px;background:#fafbfe">' + ui.esc(r[0]) + '</th><td>' + ui.esc(r[1] || '-') + '</td></tr>';
      }).join('') + '</tbody></table>';

    html += '<div class="alert-bar" style="margin-top:12px">';
    var cal = calibrationState(item, category, new Date());
    cal.forEach(function (r) {
      html += '<div class="alert-item warn"><span class="who">标定</span><span>' + ui.esc(r.text) + '</span></div>';
    });
    if (isPrecious(item)) {
      html += '<div class="alert-item info"><span class="who">贵重设备</span><span>单独追踪的一件一码设备，借出请登记借用人，归还请及时确认。</span></div>';
      if (Number(item.lentQty) > 0) {
        html += '<div class="alert-item danger"><span class="who">当前在借</span><span>这台设备现在不在库存里，请到「借用台账」确认去向与归还日期。</span></div>';
      }
    }
    html += '</div>';
    return html;
  }

  function summaryLine(summary) {
    var items = summary.items || [];
    var single = items.filter(isPrecious).length;
    return '共 ' + summary.itemKinds + ' 件设备（' + single + ' 件单独追踪），在库 ' + summary.inStockQty +
      (summary.lentQty ? '，在外借出 ' + summary.lentQty + ' 件' : '');
  }

  /** 标定看板：每件设备最近标定日期、距今天数、是否超周期、要不要重新标定 */
  function calibrationBoard(items, category, today) {
    var cycle = num(((category || {}).reminders || {}).calibrationDays);
    var now = today || new Date();
    return (items || []).map(function (i) {
      var e = extra(i);
      var last = e.lastCalibrationDate || '';
      var age = last ? global.FEVER.Rules.daysBetween(last, now) : null;
      var overdue = cycle > 0 && (last ? (age !== null && age > cycle) : true);
      var status = e.calibrationStatus || '未标定';
      return {
        code: i.code, name: i.name, spec: i.spec,
        last: last, age: age, cycle: cycle,
        status: (overdue && status !== '需重新标定') ? '需重新标定' : status,
        overdue: overdue || status === '需重新标定',
        precious: isPrecious(i),
        lentQty: num(i.lentQty)
      };
    }).sort(function (a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return num(b.age) - num(a.age);
    });
  }

  /** 镜头与相机配套关系：按「配套相机」字段把设备两两对上 */
  function pairing(items) {
    var list = items || [];
    var byCode = {};
    list.forEach(function (i) { byCode[i.code] = i; });

    var pairs = [];
    list.forEach(function (i) {
      var target = String(extra(i).cameraPair || '').trim();
      if (!target) return;
      // 配套相机字段里可能写「配 VS-0002」这种，取出里面的编码
      var m = target.match(/[A-Z]{2}-\d{4}/);
      var code = m ? m[0] : target;
      var other = byCode[code] || null;
      pairs.push({
        fromCode: i.code, fromName: i.name,
        toCode: code, toName: other ? other.name : null,
        resolved: !!other
      });
    });
    return pairs;
  }

  /** 本类专属工作区：标定看板 + 配套关系 + 贵重设备去向 */
  function workspace(summary, category, today) {
    var UI = global.FEVER.UI;
    var items = summary.items || [];
    var cat = category || summary.category;
    var board = calibrationBoard(items, cat, today);
    var overdueCount = board.filter(function (r) { return r.overdue; }).length;

    var html = '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">标定看板</h3>' +
      '<span class="page-sub" id="mod-vis-cal-note">' +
        '标定周期 ' + num((cat.reminders || {}).calibrationDays) + ' 天' +
        (overdueCount ? '　·　' + overdueCount + ' 件需重新标定' : '　·　都在周期内') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-vis-cal">' +
      (board.length ? UI.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.code) + '">' + UI.esc(r.code) + '</span>'; } },
        { label: '名称', render: function (r) {
            return UI.esc(r.name) + (r.spec ? '<div class="hint">' + UI.esc(r.spec) + '</div>' : ''); } },
        { label: '最近标定', render: function (r) { return UI.esc(r.last || '从未'); } },
        { label: '距今天数', num: true, render: function (r) {
            return UI.esc(r.age === null ? '-' : r.age); } },
        { label: '标定状态', render: function (r) {
            var cls = r.overdue ? 'pill-warn' : (r.status === '已标定' ? 'pill-in_stock' : 'pill-info');
            return '<span class="badge-pill ' + cls + '">' + UI.esc(r.status) + '</span>'; } }
      ], board, { rowClass: function (r) { return r.overdue ? 'row-low-stock' : ''; } })
        : '<div class="empty">本类还没有设备</div>') +
      '</div></div>';

    var pairs = pairing(items);
    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">镜头与相机配套</h3>' +
      '<span class="page-sub" id="mod-vis-pair-note">' +
        (pairs.length ? pairs.length + ' 组配套关系' : '还没有登记「配套相机」') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-vis-pair">' +
      (pairs.length ? UI.table([
        { label: '本件', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.fromCode) + '">' + UI.esc(r.fromCode) + '</span>' +
              ' <span class="hint">' + UI.esc(r.fromName) + '</span>'; } },
        { label: '配套', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.toCode) + '">' + UI.esc(r.toCode) + '</span>' +
              (r.resolved ? ' <span class="hint">' + UI.esc(r.toName) + '</span>'
                : ' <span class="badge-pill pill-warn">库里没有这件</span>'); } }
      ], pairs) : '<div class="empty">还没有登记「配套相机」的物品</div>') +
      '</div></div>';

    var precious = items.filter(isPrecious);
    var lentOut = precious.filter(function (i) { return num(i.lentQty) > 0; });
    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">贵重设备去向</h3>' +
      '<span class="page-sub" id="mod-vis-precious-note">' +
        (lentOut.length ? '有 ' + lentOut.length + ' 件贵重设备当前在外借出，请重点跟进' : '贵重设备都在库') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-vis-precious">' +
      (precious.length ? UI.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.code) + '">' + UI.esc(r.code) + '</span>'; } },
        { label: '名称', render: function (r) { return UI.esc(r.name); } },
        { label: '在库 / 借出', render: function (r) {
            return UI.esc(num(r.inStockQty)) + ' / ' + UI.esc(num(r.lentQty)); } },
        { label: '当前状态', render: function (r) {
            return num(r.lentQty) > 0
              ? '<span class="badge-pill pill-danger">在外借出</span>'
              : '<span class="badge-pill pill-in_stock">在库</span>'; } }
      ], precious, { rowClass: function (r) { return num(r.lentQty) > 0 ? 'row-low-stock' : ''; } })
        : '<div class="empty">本类还没有单独追踪的贵重设备</div>') +
      '</div></div>';

    return html;
  }

  var mod = {
    id: 'vision',
    isPrecious: isPrecious,
    calibrationState: calibrationState,
    calibrationBoard: calibrationBoard,
    pairing: pairing,
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
  global.FEVER.Modules.vision = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this);
