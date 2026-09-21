/**
 * FEver 战队物资管理 —— 通用界面件
 *
 * 所有页面共用的东西都放这里：转义、轻提示、弹窗、确认框、表格渲染、筛选栏。
 * 界面代码统一用这里的方法生成 HTML，避免各处写法不一。
 */
(function (global) {
  'use strict';

  /** HTML 转义。所有来自数据的文本都要经过它，防止把标签当代码渲染 */
  function esc(value) {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  /** 把 ISO 时间显示成 2026-09-21 14:03 */
  function fmtTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    var s = String(iso);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  /** 今天，用于日期输入框默认值 */
  function todayStr() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 轻提示 */
  function toast(message, kind) {
    var root = qs('#toast-root');
    if (!root) { console.log(message); return; }
    var node = el('div', 'toast ' + (kind || 'ok'), esc(message));
    root.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .3s';
      node.style.opacity = '0';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 320);
    }, kind === 'err' ? 4200 : 2400);
  }

  var modalSeq = 0;

  /**
   * 打开弹窗。
   *   opts.title    标题
   *   opts.body     正文 HTML
   *   opts.footer   底部按钮 HTML（可选）
   *   opts.wide     宽版
   *   opts.onMount  弹窗插入后回调，用来绑定事件
   * 返回 { close }
   */
  function openModal(opts) {
    var mask = el('div', 'modal-mask');
    var id = 'modal-' + (modalSeq += 1);
    mask.id = id;
    mask.innerHTML =
      '<div class="modal' + (opts.wide ? ' wide' : '') + '">' +
        '<div class="modal-head">' +
          '<h3 class="modal-title">' + esc(opts.title || '') + '</h3>' +
          '<button class="modal-close" type="button" aria-label="关闭">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' + (opts.body || '') + '</div>' +
        (opts.footer ? '<div class="modal-foot">' + opts.footer + '</div>' : '') +
      '</div>';

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    mask.addEventListener('click', function (e) {
      if (e.target === mask) close();
    });
    mask.querySelector('.modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    qs('#modal-root').appendChild(mask);
    if (opts.onMount) opts.onMount(mask, close);
    var first = mask.querySelector('input, select, textarea');
    if (first && !opts.noAutoFocus) setTimeout(function () { first.focus(); }, 30);
    return { el: mask, close: close };
  }

  /** 确认框，返回 Promise<boolean> */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var settled = false;
      var m = openModal({
        title: opts.title || '请确认',
        body: '<div style="line-height:1.8">' + (opts.body || '') + '</div>',
        footer:
          '<button class="btn" data-act="no" type="button">' + esc(opts.cancelText || '取消') + '</button>' +
          '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" data-act="yes" type="button">' +
            esc(opts.okText || '确定') + '</button>',
        onMount: function (mask, close) {
          mask.querySelector('[data-act="no"]').addEventListener('click', function () { settled = true; close(); resolve(false); });
          mask.querySelector('[data-act="yes"]').addEventListener('click', function () { settled = true; close(); resolve(true); });
          var closer = mask.querySelector('.modal-close');
          closer.addEventListener('click', function () { if (!settled) { settled = true; resolve(false); } });
          mask.addEventListener('click', function (e) { if (e.target === mask && !settled) { settled = true; resolve(false); } });
        }
      });
      void m;
    });
  }

  /** 渲染表格。columns: [{key,label,cls,render(row),num}] */
  function table(columns, rows, opts) {
    var o = opts || {};
    if (!rows.length && o.emptyText) {
      return '<div class="empty">' + esc(o.emptyText) + '</div>';
    }
    var head = columns.map(function (c) {
      return '<th class="' + (c.num ? 'num' : '') + '">' + esc(c.label) + '</th>';
    }).join('');
    var body = rows.map(function (row, index) {
      var trCls = o.rowClass ? o.rowClass(row, index) : '';
      var tds = columns.map(function (c) {
        var value = c.render ? c.render(row, index) : esc(row[c.key]);
        return '<td class="' + (c.num ? 'num' : '') + (c.cls ? ' ' + c.cls : '') + '">' + value + '</td>';
      }).join('');
      return '<tr' + (trCls ? ' class="' + trCls + '"' : '') + '>' + tds + '</tr>';
    }).join('');
    return '<table class="grid"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  /** 状态徽标 */
  function statusPill(status) {
    var Rules = global.FEVER.Rules;
    var name = Rules.STATUS_NAMES[status] || status;
    return '<span class="badge-pill pill-' + esc(status) + '">' + esc(name) + '</span>';
  }

  function identityPill(mode) {
    if (mode === 'single') return '<span class="badge-pill pill-single">单独建身份</span>';
    return '<span class="badge-pill pill-shared">同款共用</span>';
  }

  /** 读取表单值 */
  function val(mask, name) {
    var node = mask.querySelector('[name="' + name + '"]');
    return node ? String(node.value).trim() : '';
  }

  function checked(mask, name) {
    var node = mask.querySelector('[name="' + name + '"]');
    return !!(node && node.checked);
  }

  /** 表单字段 HTML */
  function field(opts) {
    var o = opts;
    var control;
    if (o.type === 'select') {
      control = '<select class="select" name="' + esc(o.name) + '">' +
        (o.options || []).map(function (opt) {
          var value = typeof opt === 'string' ? opt : opt.value;
          var label = typeof opt === 'string' ? opt : opt.label;
          var sel = String(o.value || '') === String(value) ? ' selected' : '';
          return '<option value="' + esc(value) + '"' + sel + '>' + esc(label) + '</option>';
        }).join('') + '</select>';
    } else if (o.type === 'textarea') {
      control = '<textarea class="textarea" name="' + esc(o.name) + '" placeholder="' + esc(o.placeholder || '') + '">' + esc(o.value || '') + '</textarea>';
    } else {
      control = '<input class="input" type="' + esc(o.type || 'text') + '" name="' + esc(o.name) + '"' +
        ' value="' + esc(o.value === undefined || o.value === null ? '' : o.value) + '"' +
        (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') +
        (o.min !== undefined ? ' min="' + esc(o.min) + '"' : '') +
        (o.step ? ' step="' + esc(o.step) + '"' : '') + '>';
    }
    return '<div class="field' + (o.full ? ' full' : '') + '">' +
      '<label>' + esc(o.label) + (o.required ? ' <span class="req">*</span>' : '') + '</label>' +
      control +
      (o.hint ? '<span class="hint">' + esc(o.hint) + '</span>' : '') +
      '</div>';
  }

  /** 提醒条 HTML */
  function alertBar(alerts) {
    if (!alerts || !alerts.length) return '';
    return '<div class="alert-bar">' + alerts.map(function (a) {
      return '<div class="alert-item ' + esc(a.level || 'info') + '">' +
        '<span class="who">' + esc(a.name || a.code || '') + '</span>' +
        '<span>' + esc(a.text) + '</span>' +
        (a.code ? '<button class="btn small ghost" data-goto-item="' + esc(a.code) + '" type="button">查看</button>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  /** 下载文本文件（导出备份、导出表格都用它） */
  function downloadText(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /** 选择本地文件并读出文本内容 */
  function pickTextFile(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || '.json,application/json';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        var reader = new FileReader();
        reader.onload = function () { resolve({ name: file.name, text: String(reader.result) }); };
        reader.onerror = function () { resolve(null); };
        reader.readAsText(file, 'utf-8');
      });
      input.click();
    });
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.UI = {
    esc: esc,
    qs: qs,
    qsa: qsa,
    el: el,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    todayStr: todayStr,
    toast: toast,
    openModal: openModal,
    confirmDialog: confirmDialog,
    table: table,
    statusPill: statusPill,
    identityPill: identityPill,
    val: val,
    checked: checked,
    field: field,
    alertBar: alertBar,
    downloadText: downloadText,
    pickTextFile: pickTextFile
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
