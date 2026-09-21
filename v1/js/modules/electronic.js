/**
 * 电控大类专属逻辑
 *
 * 这个类关心三件事：
 *   1) 安全 —— 高压、电池这类东西要显眼警示
 *   2) 易损件什么时候该换
 *   3) 电池用了多少循环、健康怎么样
 */
(function (global) {
  'use strict';

  function extra(item) { return item.extra || {}; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function UI() { return global.FEVER.UI; }

  function isDangerous(item) {
    return extra(item).safetyLevel === '高压危险';
  }

  function needsAttention(item) {
    return extra(item).safetyLevel === '注意';
  }

  /** 卡片指标：危险件数与待换件数 */
  function cardMetrics(summary) {
    var items = summary.items || [];
    var danger = items.filter(isDangerous).length;
    var spare = summary.reminders.filter(function (r) { return r.kind === 'spare_cycle'; }).length;
    return [
      { label: '高压危险件', value: danger, alert: danger > 0 },
      { label: '待更换易损件', value: spare, alert: spare > 0 }
    ];
  }

  /** 本类筛选：按安全等级、接口类型、是否电池 */
  function filterControls() {
    return '' +
      '<div class="field"><label>安全等级</label>' +
        '<select class="select" name="f-safetyLevel" data-filter="electronic">' +
          '<option value="">全部</option><option value="一般">一般</option>' +
          '<option value="注意">注意</option><option value="高压危险">高压危险</option>' +
        '</select></div>' +
      '<div class="field"><label>接口类型</label>' +
        '<input class="input" name="f-interfaceType" placeholder="如：CAN" data-filter="electronic"></div>' +
      '<div class="field"><label>类别</label>' +
        '<select class="select" name="f-kind" data-filter="electronic">' +
          '<option value="">全部</option>' +
          '<option value="battery">只看电池</option>' +
          '<option value="danger">只看高压危险</option>' +
        '</select></div>';
  }

  function matches(item, state) {
    var s = state || {};
    var e = extra(item);
    if (s['f-safetyLevel'] && String(e.safetyLevel || '') !== s['f-safetyLevel']) return false;
    if (s['f-interfaceType'] && String(e.interfaceType || '').indexOf(s['f-interfaceType']) === -1) return false;
    if (s['f-kind'] === 'battery' && !e.batteryHealth && !e.batteryCycles) return false;
    if (s['f-kind'] === 'danger' && !isDangerous(item)) return false;
    return true;
  }

  function listColumns() {
    return [
      { label: '电压 / 电流', render: function (i) {
          var e = extra(i);
          return UI().esc([e.voltage, e.current].filter(Boolean).join(' / ') || '-');
        } },
      { label: '接口', render: function (i) { return UI().esc(extra(i).interfaceType || '-'); } },
      { label: '安全等级', render: function (i) {
          var level = extra(i).safetyLevel;
          if (!level) return '-';
          var cls = level === '高压危险' ? 'pill-danger' : (level === '注意' ? 'pill-warn' : 'pill-info');
          return '<span class="badge-pill ' + cls + '">' + UI().esc(level) + '</span>';
        } },
      { label: '电池', render: function (i) {
          var e = extra(i);
          if (!e.batteryCycles && !e.batteryHealth) return '-';
          return UI().esc((e.batteryCycles ? e.batteryCycles + ' 次' : '') +
            (e.batteryHealth ? ' / ' + e.batteryHealth : ''));
        } }
    ];
  }

  function detailSections(item, category) {
    var ui = UI();
    var e = extra(item);
    var rows = [
      ['工作电压', e.voltage], ['工作电流', e.current], ['功率', e.power],
      ['接口类型', e.interfaceType], ['安全等级', e.safetyLevel],
      ['电池循环次数', e.batteryCycles], ['电池健康状况', e.batteryHealth],
      ['最近更换日期', e.lastReplaceDate]
    ];
    var html = '<h4 style="margin:16px 0 8px">电控属性</h4><table class="grid"><tbody>' +
      rows.map(function (r) {
        return '<tr><th style="width:130px;background:#fafbfe">' + ui.esc(r[0]) + '</th><td>' + ui.esc(r[1] || '-') + '</td></tr>';
      }).join('') + '</tbody></table>';

    html += '<div style="margin-top:12px" class="alert-bar">';
    if (isDangerous(item)) {
      html += '<div class="alert-item danger"><span class="who">高压危险</span><span>含高压电路或锂电池，操作前请断电放电，佩戴护目镜。</span></div>';
    } else if (needsAttention(item)) {
      html += '<div class="alert-item warn"><span class="who">注意</span><span>该件处理时需留意。</span></div>';
    }
    var spare = global.FEVER.Rules.remindersFor(item, category, new Date())
      .filter(function (r) { return r.kind === 'spare_cycle'; });
    spare.forEach(function (r) {
      html += '<div class="alert-item warn"><span>' + ui.esc(r.text) + '</span></div>';
    });
    if (e.batteryHealth === '衰减明显') {
      html += '<div class="alert-item warn"><span>电池衰减明显，建议尽早更换，避免比赛中掉电。</span></div>';
    }
    html += '</div>';
    void num;
    return html;
  }

  function summaryLine(summary) {
    var items = summary.items || [];
    var danger = items.filter(isDangerous).length;
    return '共 ' + summary.itemKinds + ' 种，在库 ' + summary.inStockQty + ' 个' +
      (danger ? '，其中 ' + danger + ' 种为高压危险件' : '');
  }

  /** 电池清单：循环次数与健康状况，衰减明显的重点标出 */
  function batteryList(items) {
    return (items || []).filter(function (i) {
      var e = extra(i);
      return e.batteryCycles || e.batteryHealth;
    }).map(function (i) {
      var e = extra(i);
      var cycles = e.batteryCycles === undefined || e.batteryCycles === '' ? null : num(e.batteryCycles);
      return {
        code: i.code, name: i.name,
        cycles: cycles,
        health: e.batteryHealth || '未填',
        decayed: e.batteryHealth === '衰减明显',
        // 经验阈值：循环超过 300 次就要留意
        worn: cycles !== null && cycles >= 300
      };
    }).sort(function (a, b) { return num(b.cycles) - num(a.cycles); });
  }

  /** 易损件清单：上次更换日期 + 已用天数 + 是否超周期 */
  function spareParts(items, category, today) {
    var cycle = num(((category || {}).reminders || {}).spareCycleDays);
    var now = today || new Date();
    return (items || []).filter(function (i) {
      return !!extra(i).lastReplaceDate;
    }).map(function (i) {
      var last = extra(i).lastReplaceDate;
      var age = global.FEVER.Rules.daysBetween(last, now);
      return {
        code: i.code, name: i.name, last: last,
        age: age === null ? null : age,
        cycle: cycle,
        due: cycle > 0 && age !== null && age > cycle
      };
    }).sort(function (a, b) { return num(b.age) - num(a.age); });
  }

  /** 本类专属工作区：安全警示 + 易损件周期 + 电池健康 */
  function workspace(summary, category, today) {
    var UI = global.FEVER.UI;
    var items = summary.items || [];
    var cat = category || summary.category;
    var dangerous = items.filter(isDangerous);

    var html = '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">安全等级警示</h3>' +
      '<span class="page-sub" id="mod-elec-safety-note">' +
        (dangerous.length ? dangerous.length + ' 种高压危险件，借用与操作前请确认断电' : '本类暂无高压危险件') +
      '</span></div>' +
      '<div class="panel-body" id="mod-elec-safety">' +
      '<div class="alert-bar">' +
      (dangerous.length ? dangerous.map(function (i) {
        var e = extra(i);
        return '<div class="alert-item danger"><span class="who">高压危险</span>' +
          '<span><span class="code-cell" data-goto-item="' + UI.esc(i.code) + '">' + UI.esc(i.code) + '</span> ' +
          UI.esc(i.name) + (e.voltage ? '　' + UI.esc(e.voltage) : '') +
          '　操作前请断电放电，佩戴护目镜</span></div>';
      }).join('') : '<div class="alert-item info"><span>目前没有标记为「高压危险」的电控件。</span></div>') +
      '</div></div></div>';

    var spares = spareParts(items, cat, today);
    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">易损件更换周期</h3>' +
      '<span class="page-sub">周期默认 ' + num((cat.reminders || {}).spareCycleDays) + ' 天，超期会提示更换</span></div>' +
      '<div class="panel-body tight" id="mod-elec-spares">' +
      (spares.length ? UI.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.code) + '">' + UI.esc(r.code) + '</span>'; } },
        { label: '名称', render: function (r) { return UI.esc(r.name); } },
        { label: '最近更换', render: function (r) { return UI.esc(r.last); } },
        { label: '已用天数', num: true, render: function (r) {
            return UI.esc(r.age === null ? '-' : r.age); } },
        { label: '状态', render: function (r) {
            return r.due
              ? '<span class="badge-pill pill-warn">已超周期，建议更换</span>'
              : '<span class="badge-pill pill-in_stock">周期内</span>'; } }
      ], spares, { rowClass: function (r) { return r.due ? 'row-low-stock' : ''; } })
        : '<div class="empty">还没有登记过「最近更换日期」的易损件</div>') +
      '</div></div>';

    var batteries = batteryList(items);
    html += '<div class="panel"><div class="panel-head">' +
      '<h3 class="panel-title">电池健康</h3>' +
      '<span class="page-sub" id="mod-elec-battery-note">' +
        (batteries.length ? '循环次数与健康状况，衰减明显的建议尽早更换' : '本类还没有登记电池信息') +
      '</span></div>' +
      '<div class="panel-body tight" id="mod-elec-battery">' +
      (batteries.length ? UI.table([
        { label: '编码', render: function (r) {
            return '<span class="code-cell" data-goto-item="' + UI.esc(r.code) + '">' + UI.esc(r.code) + '</span>'; } },
        { label: '名称', render: function (r) { return UI.esc(r.name); } },
        { label: '循环次数', num: true, render: function (r) {
            return UI.esc(r.cycles === null ? '未填' : r.cycles); } },
        { label: '健康状况', render: function (r) {
            var cls = r.decayed ? 'pill-danger' : (r.health === '良好' ? 'pill-in_stock' : 'pill-info');
            return '<span class="badge-pill ' + cls + '">' + UI.esc(r.health) + '</span>'; } },
        { label: '提示', render: function (r) {
            if (r.decayed) return '<span class="badge-pill pill-danger">衰减明显，建议更换</span>';
            if (r.worn) return '<span class="badge-pill pill-warn">循环偏高，留意续航</span>';
            return '-'; } }
      ], batteries, { rowClass: function (r) { return r.decayed ? 'row-low-stock' : ''; } })
        : '<div class="empty">本类还没有登记电池循环次数或健康状况</div>') +
      '</div></div>';

    return html;
  }

  var mod = {
    id: 'electronic',
    isDangerous: isDangerous,
    needsAttention: needsAttention,
    batteryList: batteryList,
    spareParts: spareParts,
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
  global.FEVER.Modules.electronic = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this);
