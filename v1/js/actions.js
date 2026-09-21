/**
 * FEver 战队物资管理 —— 操作台页面与各类表单弹窗
 *
 * 状态类操作（借出 / 归还 / 领用 / 送修 / 修好回库）全部走同一个操作台：
 * 先输入编号识别物品 → 选动作 → 填表 → 看"本次变化" → 提交。
 */
(function (global) {
  'use strict';

  var UI = global.FEVER.UI;
  var DB = global.FEVER.DB;
  var Rules = global.FEVER.Rules;
  var Ops = global.FEVER.Ops;
  var Stats = global.FEVER.Stats;

  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  /** 统一处理"用户填的东西不对"这类错误 */
  function failMessage(err) {
    if (!err) return '操作失败';
    return err.userMessage || err.message || String(err);
  }

  /* ================= 出入库登记操作台 ================= */

  function desk() {
    var html =
      '<div class="page-head">' +
        '<div><h1 class="page-title">出入库登记</h1>' +
        '<p class="page-sub">输入物品编号（可以用扫码枪直接扫，也可以手工输入）→ 选动作 → 填表 → 提交</p></div>' +
        '<div class="page-actions"><button class="btn" data-goto="ledger" type="button">借用台账</button>' +
        '<button class="btn" data-goto="txns" type="button">全部流水</button></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-body">' +
        '<div class="field"><label>物品编号 <span class="req">*</span></label>' +
          '<div style="display:flex;gap:8px">' +
            '<input class="input" id="desk-code" placeholder="例如 MC-0001，或直接扫二维码" autocomplete="off" style="max-width:320px">' +
            '<button class="btn primary" id="desk-lookup" type="button">识别</button>' +
          '</div>' +
          '<span class="hint">输入完直接按回车也行。</span>' +
        '</div>' +
      '</div></div>' +
      '<div id="desk-result"></div>';

    function onMount(root) {
      var codeInput = root.querySelector('#desk-code');
      var resultBox = root.querySelector('#desk-result');

      function lookup() {
        var raw = String(codeInput.value || '').trim();
        var code = Rules.parseQrPayload(raw) || raw;
        if (!code) {
          UI.toast('请先输入物品编号', 'warn');
          return;
        }
        DB.get('items', code).then(function (item) {
          if (!item) {
            resultBox.innerHTML = '<div class="panel"><div class="panel-body">' +
              '<div class="alert-item danger"><span class="who">未找到该物品</span>' +
              '<span>编号 ' + UI.esc(code) + ' 在库里没有对应记录，请核对编号，或先到对应大类里新增物品。</span></div>' +
              '</div></div>';
            return;
          }
          codeInput.value = code;
          renderItem(item);
        });
      }

      function renderItem(item) {
        DB.get('categories', item.categoryId).then(function (cat) {
          var actions = [];
          if (num(item.inStockQty) > 0) {
            actions.push({ key: 'lend', label: '借出', desc: '借出去，以后要还' });
            actions.push({ key: 'consume', label: '领用', desc: '领走就用掉，不还' });
            actions.push({ key: 'consume-repair', label: '送修', desc: '坏了，标记为损坏待修' });
          }
          if (num(item.lentQty) > 0) actions.push({ key: 'return', label: '归还', desc: '还回来了' });
          if (num(item.repairQty) > 0) actions.push({ key: 'repair-done', label: '修好回库', desc: '修好了放回库存' });

          var actionButtons = actions.length
            ? '<div class="page-actions">' + actions.map(function (a) {
                return '<button class="btn" data-desk-act="' + UI.esc(a.key) + '" type="button" title="' + UI.esc(a.desc) + '">' +
                  UI.esc(a.label) + '</button>';
              }).join('') + '</div>'
            : '<div class="alert-item warn">这件物品当前没有可执行的动作。</div>';

          resultBox.innerHTML =
            '<div class="panel">' +
              '<div class="panel-head"><h3 class="panel-title">' +
                '<span class="code-cell" data-goto-item="' + UI.esc(item.code) + '">' + UI.esc(item.code) + '</span> ' +
                UI.esc(item.name) + '</h3>' + UI.statusPill(item.status) + '</div>' +
              '<div class="panel-body">' +
                '<table class="grid"><tbody>' +
                  '<tr><th style="width:130px;background:#fafbfe">大类</th><td>' + UI.esc(cat ? cat.name : '-') + '</td></tr>' +
                  '<tr><th style="background:#fafbfe">规格</th><td>' + UI.esc(item.spec || '-') + '</td></tr>' +
                  '<tr><th style="background:#fafbfe">身份</th><td>' + UI.identityPill(item.identityMode) + '</td></tr>' +
                  '<tr><th style="background:#fafbfe">件数</th><td>在库 ' + UI.esc(num(item.inStockQty)) +
                    ' / 借出 ' + UI.esc(num(item.lentQty)) + ' / 待修 ' + UI.esc(num(item.repairQty)) +
                    ' / 已领用 ' + UI.esc(num(item.usedUpQty)) + '</td></tr>' +
                  '<tr><th style="background:#fafbfe">存放位置</th><td>' + UI.esc(item.location || '-') + '</td></tr>' +
                '</tbody></table>' +
              '</div>' +
              '<div class="panel-body">' + actionButtons + '</div>' +
            '</div>';
          resultBox.__item = item;
          resultBox.__category = cat;
        });
      }

      root.querySelector('#desk-lookup').addEventListener('click', lookup);
      codeInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); lookup(); }
      });
      root.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-desk-act]') : null;
        if (!btn) return;
        var item = resultBox.__item;
        if (!item) return;
        var act = btn.getAttribute('data-desk-act');
        var map = { lend: 'lend', consume: 'consume', return: 'giveBack', 'consume-repair': 'sendRepair', 'repair-done': 'repairDone' };
        var fn = map[act] || act;
        global.FEVER.Forms.openActionDialog({ action: fn, item: item, onDone: function () { lookup(); } });
      });
    }

    return {
      title: '出入库登记',
      crumb: [{ label: '物资总览', goto: 'home' }, { label: '出入库登记' }],
      html: html,
      onMount: onMount
    };
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Views = global.FEVER.Views || {};
  global.FEVER.Views.desk = desk;

  /* ================= 表单弹窗 ================= */

  function categoryOptions(categories, selected) {
    return categories.slice().sort(function (a, b) { return num(a.sortOrder) - num(b.sortOrder); })
      .map(function (c) {
        return { value: c.id, label: c.icon + ' ' + c.name, selected: c.id === selected };
      });
  }

  /** 按显示顺序排序后的大类列表（机械、电控、视觉、硬件） */
  function sortedCategories(categories) {
    return categories.slice().sort(function (a, b) { return num(a.sortOrder) - num(b.sortOrder); });
  }

  /** 新增物品 */
  function openNewItem(opts) {
    var o = opts || {};
    DB.getAll('categories').then(function (categories) {
      var ordered = sortedCategories(categories);
      var selected = o.categoryId || (ordered[0] && ordered[0].id);

      function buildBody(catId) {
        var cat = categories.filter(function (c) { return c.id === catId; })[0];
        var mode = (cat && cat.defaultIdentityMode) || 'shared';
        var special = (cat && cat.extraFields || []).map(function (f) {
          return UI.field({
            label: f.label, name: 'x-' + f.key,
            type: f.type === 'select' ? 'select' : (f.type || 'text'),
            options: f.type === 'select' ? [''].concat(f.options || []) : undefined,
            placeholder: f.placeholder || ''
          });
        }).join('');
        return '' +
          '<div class="form-grid">' +
            UI.field({ label: '所属大类', name: 'categoryId', type: 'select', required: true,
              options: categoryOptions(categories, catId), value: catId }) +
            UI.field({ label: '物品名称', name: 'name', required: true, placeholder: '如：步进电机 NEMA17' }) +
            UI.field({ label: '规格 / 型号', name: 'spec', placeholder: '如：42BYGH 1.5A' }) +
            UI.field({ label: '存放位置', name: 'location', placeholder: '如：A区3号柜' }) +
            UI.field({ label: '入库数量', name: 'quantity', type: 'number', min: 1, value: 1, required: true }) +
            UI.field({ label: '安全库存', name: 'safetyStock', type: 'number', min: 0,
              hint: '同款共用时低于此数会提示补货；单独建身份可不填' }) +
            '<div class="field full"><label>身份方式 <span class="req">*</span></label>' +
              '<div class="checkline"><input type="radio" name="identityMode" value="shared"' + (mode === 'shared' ? ' checked' : '') + '>' +
                '<label>同款共用一个身份（耗材、小件，用件数记账）</label></div>' +
              '<div class="checkline"><input type="radio" name="identityMode" value="single"' + (mode === 'single' ? ' checked' : '') + '>' +
                '<label>每件单独建身份（贵重、要单独追踪的，一件一个二维码）</label></div>' +
              '<span class="hint" id="mode-hint"></span>' +
            '</div>' +
            UI.field({ label: '备注', name: 'remark', type: 'textarea', full: true }) +
          '</div>' +
          (special ? '<hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">' +
            '<h4 style="margin:0 0 10px">' + UI.esc(cat.name) + '专属属性</h4><div class="form-grid">' + special + '</div>' : '');
      }

      var m = UI.openModal({
        title: '新增物品',
        wide: true,
        body: '<div id="ni-body"></div>',
        footer: '<button class="btn" data-cancel type="button">取消</button>' +
          '<button class="btn primary" data-ok type="button">保存并入库</button>'
      });

      function paint() {
        var current = UI.val(m.el, 'categoryId') || selected;
        UI.qs('#ni-body', m.el).innerHTML = buildBody(current);
        var cat = categories.filter(function (c) { return c.id === current; })[0];
        var hint = m.el.querySelector('#mode-hint');
        if (hint && cat) {
          hint.textContent = cat.id === 'vision'
            ? '这一类设备默认按「每件单独建身份」。'
            : '这一类默认按「同款共用」，整件贵重的可以改成单独建身份。';
        }
      }

      paint();
      m.el.addEventListener('change', function (e) {
        if (e.target.name === 'categoryId') paint();
      });
      m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.el.querySelector('[data-ok]').addEventListener('click', function () {
        var mask = m.el;
        var extra = {};
        UI.qsa('[name^="x-"]', mask).forEach(function (node) {
          extra[node.name.slice(2)] = String(node.value).trim();
        });
        var pickedMode = UI.qs('[name="identityMode"]:checked', mask);
        Ops.inbound({
          categoryId: UI.val(mask, 'categoryId'),
          name: UI.val(mask, 'name'),
          spec: UI.val(mask, 'spec'),
          location: UI.val(mask, 'location'),
          quantity: UI.val(mask, 'quantity'),
          safetyStock: UI.val(mask, 'safetyStock'),
          identityMode: pickedMode ? pickedMode.value : 'shared',
          remark: UI.val(mask, 'remark'),
          extra: extra,
          operator: o.operator || '前台登记'
        }).then(function (res) {
          m.close();
          UI.toast('已入库：' + res.codes.join('、'), 'ok');
          if (o.onDone) o.onDone(res);
        }).catch(function (err) {
          UI.toast(failMessage(err), 'err');
        });
      });
    });
  }

  /** 新建采购申请 */
  function openNewPurchase(opts) {
    var o = opts || {};
    DB.getAll('categories').then(function (categories) {
      var ordered = sortedCategories(categories);
      var selected = o.categoryId || (ordered[0] && ordered[0].id);
      var m = UI.openModal({
        title: '新建采购申请',
        wide: true,
        body: '<div class="form-grid">' +
          UI.field({ label: '所属大类', name: 'categoryId', type: 'select', required: true,
            options: categoryOptions(categories, selected), value: selected }) +
          UI.field({ label: '物品名称', name: 'name', required: true, placeholder: '如：步进电机 NEMA17' }) +
          UI.field({ label: '规格 / 型号', name: 'spec', placeholder: '如：42BYGH 1.5A' }) +
          UI.field({ label: '申请数量', name: 'quantity', type: 'number', min: 1, value: 1, required: true }) +
          UI.field({ label: '预算（元）', name: 'budget', type: 'number', min: 0, step: '0.01', placeholder: '如：3000' }) +
          UI.field({ label: '申请人', name: 'applicant', required: true, placeholder: '填写申请人姓名' }) +
          UI.field({ label: '用途说明', name: 'purpose', type: 'textarea', full: true, placeholder: '买回来做什么用' }) +
        '</div>',
        footer: '<button class="btn" data-cancel type="button">取消</button>' +
          '<button class="btn primary" data-ok type="button">提交申请</button>'
      });

      m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.el.querySelector('[data-ok]').addEventListener('click', function () {
        var mask = m.el;
        var name = UI.val(mask, 'name');
        var applicant = UI.val(mask, 'applicant');
        if (!name) { UI.toast('请填写物品名称', 'warn'); return; }
        if (!applicant) { UI.toast('请填写申请人', 'warn'); return; }
        var now = DB.nowIso();
        DB.add('purchaseRequests', {
          categoryId: UI.val(mask, 'categoryId'),
          name: name,
          spec: UI.val(mask, 'spec'),
          quantity: num(UI.val(mask, 'quantity')) || 1,
          budget: UI.val(mask, 'budget'),
          purpose: UI.val(mask, 'purpose'),
          applicant: applicant,
          status: 'pending',
          createdAt: now,
          updatedAt: now
        }).then(function () {
          m.close();
          UI.toast('采购申请已提交', 'ok');
          if (o.onDone) o.onDone();
        }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
      });
    });
  }

  /** 确认到货并入库 */
  function openArrive(requestId, opts) {
    var o = opts || {};
    DB.get('purchaseRequests', requestId).then(function (req) {
      if (!req) { UI.toast('找不到这条采购申请', 'err'); return; }
      DB.get('categories', req.categoryId).then(function (cat) {
        var defaultMode = (cat && cat.defaultIdentityMode) || 'shared';
        var m = UI.openModal({
          title: '确认到货并入库',
          wide: true,
          body:
            '<div class="alert-item info" style="margin-bottom:14px">' +
              '<span class="who">' + UI.esc(req.name) + '</span>' +
              '<span>申请数量 ' + UI.esc(num(req.quantity)) + '，申请人 ' + UI.esc(req.applicant || '-') +
              '，预算 ' + UI.esc(req.budget || '-') + ' 元</span>' +
            '</div>' +
            '<div class="form-grid">' +
              UI.field({ label: '实际到货数量', name: 'quantity', type: 'number', min: 1, value: num(req.quantity) || 1, required: true }) +
              UI.field({ label: '存放位置', name: 'location', placeholder: '如：A区3号柜' }) +
              UI.field({ label: '发票号码', name: 'invoiceNo', required: true, placeholder: '发票上的号码' }) +
              UI.field({ label: '发票金额（元）', name: 'amount', type: 'number', min: 0, step: '0.01',
                value: req.budget || '', required: true })
              + UI.field({ label: '供应商名称', name: 'supplier', required: true, placeholder: '如：某科技公司' }) +
              UI.field({ label: '发票日期', name: 'invoiceDate', type: 'date', value: UI.todayStr() }) +
              '<div class="field full"><label>身份方式 <span class="req">*</span></label>' +
                '<div class="checkline"><input type="radio" name="identityMode" value="shared"' + (defaultMode === 'shared' ? ' checked' : '') + '>' +
                  '<label>同款共用一个身份（生成 1 个编号，记件数）</label></div>' +
                '<div class="checkline"><input type="radio" name="identityMode" value="single"' + (defaultMode === 'single' ? ' checked' : '') + '>' +
                  '<label>每件单独建身份（按到货数量生成多个编号，一件一码）</label></div>' +
              '</div>' +
              UI.field({ label: '操作人', name: 'operator', required: true, value: o.operator || '', placeholder: '谁登记入库' }) +
              UI.field({ label: '备注', name: 'remark' }) +
            '</div>',
          footer: '<button class="btn" data-cancel type="button">取消</button>' +
            '<button class="btn primary" data-ok type="button">确认到货并入库</button>'
        });

        m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
        m.el.querySelector('[data-ok]').addEventListener('click', function () {
          var mask = m.el;
          var modeNode = UI.qs('[name="identityMode"]:checked', mask);
          Ops.arrive({
            requestId: requestId,
            quantity: UI.val(mask, 'quantity'),
            location: UI.val(mask, 'location'),
            invoiceNo: UI.val(mask, 'invoiceNo'),
            amount: UI.val(mask, 'amount'),
            supplier: UI.val(mask, 'supplier'),
            invoiceDate: UI.val(mask, 'invoiceDate'),
            identityMode: modeNode ? modeNode.value : defaultMode,
            operator: UI.val(mask, 'operator'),
            remark: UI.val(mask, 'remark')
          }).then(function (res) {
            m.close();
            UI.toast('已入库：' + res.codes.join('、') + '（发票已登记）', 'ok');
            if (o.onDone) o.onDone(res);
          }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
        });
      });
    });
  }

  /** 借出 / 归还 / 领用 / 送修 / 修好回库 的填写弹窗 */
  var ACTION_DEFS = {
    lend: {
      title: '借出登记', fn: 'lend', needQty: true, needOperator: true,
      fields: [
        { label: '借用人', name: 'borrower', required: true, placeholder: '谁借走的' },
        { label: '预计归还日期', name: 'dueDate', type: 'date', required: true, value: UI.todayStr() },
        { label: '用途', name: 'purpose', full: true, placeholder: '借去做什么' }
      ]
    },
    consume: {
      title: '领用登记', fn: 'consume', needQty: true, needOperator: true,
      fields: [
        { label: '领用人', name: 'taker', required: true, placeholder: '谁领走的' },
        { label: '用途', name: 'purpose', full: true, placeholder: '领去做什么' }
      ]
    },
    sendRepair: {
      title: '送修登记', fn: 'sendRepair', needQty: true, needOperator: true,
      fields: [
        { label: '故障说明', name: 'purpose', full: true, required: true, placeholder: '如：电机异响、板子烧了' }
      ]
    },
    giveBack: {
      title: '归还登记', fn: 'giveBack', needQty: true, needOperator: true,
      fields: [
        { label: '归还说明', name: 'purpose', full: true, placeholder: '如：完好归还' }
      ]
    },
    repairDone: {
      title: '修好回库', fn: 'repairDone', needQty: true, needOperator: true,
      fields: [
        { label: '维修说明', name: 'purpose', full: true, placeholder: '如：换了电机' }
      ]
    }
  };

  function openActionDialog(opts) {
    var action = opts.action;
    var item = opts.item;
    var def = ACTION_DEFS[action];
    if (!def) { UI.toast('不支持的操作：' + action, 'err'); return; }

    var max = action === 'giveBack' ? num(item.lentQty)
      : (action === 'repairDone' ? num(item.repairQty)
        : (action === 'lend' || action === 'consume' || action === 'sendRepair' ? num(item.inStockQty) : 1));

    var qtyField = def.needQty
      ? UI.field({
          label: '数量', name: 'qty', type: 'number', min: 1, value: max || 1, required: true,
          hint: '最多可填 ' + max + '（当前 ' + (action === 'giveBack' ? '借出' : (action === 'repairDone' ? '待修' : '在库')) + ' ' + max + ' 件）'
        })
      : '';

    var m = UI.openModal({
      title: def.title + '　·　' + item.code + ' ' + item.name,
      body: '<div class="form-grid">' +
          qtyField +
          def.fields.map(function (f) { return UI.field(f); }).join('') +
          (def.needOperator ? UI.field({ label: '操作人', name: 'operator', required: true, placeholder: '谁办理的这次登记' }) : '') +
        '</div>' +
        '<div id="act-preview" class="alert-item info" style="margin-top:14px"></div>',
      footer: '<button class="btn" data-cancel type="button">取消</button>' +
        '<button class="btn primary" data-ok type="button">确认提交</button>'
    });

    /** 提交前把"这次操作会带来什么变化"先算给使用者看 */
    var previewBox = m.el.querySelector('#act-preview');
    var mode = item.identityMode === 'single' ? 'single' : 'shared';
    function preview() {
      var q = num(UI.val(m.el, 'qty')) || (mode === 'single' ? 1 : 0);
      var inStock = num(item.inStockQty), lent = num(item.lentQty), repair = num(item.repairQty), used = num(item.usedUpQty);
      var after = { inStock: inStock, lent: lent, repair: repair, used: used };
      if (action === 'lend') { after.inStock = inStock - q; after.lent = lent + q; }
      else if (action === 'giveBack') { after.lent = lent - q; after.inStock = inStock + q; }
      else if (action === 'consume') { after.inStock = inStock - q; after.used = used + q; }
      else if (action === 'sendRepair') { after.inStock = inStock - q; after.repair = repair + q; }
      else if (action === 'repairDone') { after.repair = repair - q; after.inStock = inStock + q; }
      previewBox.innerHTML = '本次变化：在库 ' + inStock + ' → <b>' + after.inStock + '</b>' +
        '　借出 ' + lent + ' → <b>' + after.lent + '</b>' +
        '　待修 ' + repair + ' → <b>' + after.repair + '</b>' +
        '　已领用 ' + used + ' → <b>' + after.used + '</b>';
    }
    preview();
    m.el.addEventListener('input', preview);
    m.el.addEventListener('change', preview);

    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-ok]').addEventListener('click', function () {
      var mask = m.el;
      var payload = { code: item.code };
      if (def.needQty) payload.qty = UI.val(mask, 'qty');
      if (def.needOperator) payload.operator = UI.val(mask, 'operator');
      def.fields.forEach(function (f) { payload[f.name] = UI.val(mask, f.name); });
      Ops[def.fn](payload).then(function () {
        m.close();
        UI.toast(def.title + '成功', 'ok');
        if (opts.onDone) opts.onDone();
      }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
    });
  }

  global.FEVER.Forms = {
    openNewItem: openNewItem,
    openNewPurchase: openNewPurchase,
    openArrive: openArrive,
    openActionDialog: openActionDialog,
    failMessage: failMessage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
