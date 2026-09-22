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

  /**
   * 把用户选的发票 PDF 读成 {name, mime, size, base64}。
   *
   * 校验放这里（而不是提交时）：拖错了文件当场就说，别让队员填完一整张表
   * 才被告诉"格式不对"。文件只在本地读，不联网 —— 上传是数据层的事。
   */
  function readFileBase64(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有选到文件')); return; }
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) {
        reject(new Error('发票目前只支持 PDF 文件，选中的是「' + (file.name || file.type || '未知') + '」'));
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        reject(new Error('发票文件太大（上限 20MB），压一压或换扫描件'));
        return;
      }
      var reader = new global.FileReader();
      reader.onload = function () {
        var base64 = String(reader.result || '').split(',')[1] || '';
        if (!base64) { reject(new Error('这个文件读不出内容')); return; }
        resolve({
          name: file.name || '发票.pdf',
          mime: file.type || 'application/pdf',
          size: file.size || 0,
          base64: base64
        });
      };
      reader.onerror = function () { reject(new Error('这个文件读不出来')); };
      reader.readAsDataURL(file);
    });
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
          '<div class="inline-row">' +
            '<input class="input" id="desk-code" placeholder="例如 MC-0001，或直接扫二维码" autocomplete="off">' +
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

  /**
   * 兵种下拉的选项。
   * 第一项是空值而不是默认选中第一个兵种 —— 兵种直接影响预算归属，
   * 让它必须由使用者主动选，不要「没注意就默认成了重装」。
   * （默认项靠 UI.field 的 value 命中空值来选中，是显式的，不依赖"浏览器会挑第一个"。）
   */
  function troopOptions() {
    return [''].concat(Rules.TROOPS).map(function (t) {
      return { value: t, label: t || '请选择兵种…' };
    });
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
            UI.field({ label: '兵种', name: 'troop', type: 'select', required: true,
              options: troopOptions(),
              hint: '买给哪个兵种用的就选哪个 —— 兵种预算按它汇总，跟采购申请一样不能空' }) +
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
        // 兵种必填：不选就不发请求，跟采购申请表单同一套做法
        var troop = UI.val(mask, 'troop');
        if (!troop) { UI.toast('请先选择兵种', 'warn'); return; }
        Ops.inbound({
          categoryId: UI.val(mask, 'categoryId'),
          troop: troop,
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
          UI.field({ label: '兵种', name: 'troop', type: 'select', required: true,
            options: troopOptions(),
            value: Rules.normalizeTroop(o.troop),
            hint: '买给哪个兵种用。兵种预算就是按这个字段汇总的，不能空着' }) +
          UI.field({ label: '物品名称', name: 'name', required: true, placeholder: '如：步进电机 NEMA17' }) +
          UI.field({ label: '规格 / 型号', name: 'spec', placeholder: '如：42BYGH 1.5A' }) +
          UI.field({ label: '申请数量', name: 'quantity', type: 'number', min: 1, value: 1, required: true }) +
          UI.field({ label: '预算（元）', name: 'budget', type: 'number', min: 0, step: '0.01', placeholder: '如：3000',
            hint: '同意后会计入该兵种的已用预算' }) +
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
        var troop = UI.val(mask, 'troop');
        // 校验顺序跟着表单从上往下走，提示才是「第一个没填的」，
        // 不然会指着一个已经填好的字段说没填。
        // 这里只是"立刻给反馈"，真正把关的是 Ops.createRequest —— 它会把
        // approval 一起设成待审批，漏掉那一步会让新申请被兼容规则误放行。
        if (!troop) { UI.toast('请先选择兵种', 'warn'); return; }
        if (!name) { UI.toast('请填写物品名称', 'warn'); return; }
        if (!applicant) { UI.toast('请填写申请人', 'warn'); return; }

        Ops.createRequest({
          categoryId: UI.val(mask, 'categoryId'),
          troop: troop,
          name: name,
          spec: UI.val(mask, 'spec'),
          quantity: UI.val(mask, 'quantity'),
          budget: UI.val(mask, 'budget'),
          purpose: UI.val(mask, 'purpose'),
          applicant: applicant
        }).then(function () {
          m.close();
          UI.toast('采购申请已提交（' + troop + '），等待管理员审批', 'ok');
          if (o.onDone) o.onDone();
        }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
      });
    });
  }

  /**
   * 同意一条采购申请。
   * 同意是「放行」：同意之后这条申请才能标记已下单、才能确认到货，
   * 它申请的金额也才开始占用该兵种的预算（预算是按"已同意"统计的）。
   * 只有管理员做得了这件事 —— 这里只是把请求发出去，
   * 真正的权限判定在服务端（见 server/index.js 的 adminOnlyReason）。
   */
  function approvePurchase(requestId, opts) {
    var o = opts || {};
    return DB.get('purchaseRequests', requestId).then(function (req) {
      if (!req) { UI.toast('找不到这条采购申请', 'err'); return null; }
      var troop = Rules.troopOf(req) || '未指定';
      return UI.confirmDialog({
        title: '同意这条采购申请？',
        okText: '同意',
        body: '同意后就能下单采购了。<br>金额 <b>' + UI.esc(req.budget === '' || req.budget === undefined ? '-' : req.budget) +
          '</b> 元会占用「<b>' + UI.esc(troop) + '</b>」兵种的预算。'
      }).then(function (ok) {
        if (!ok) return null;
        var now = DB.nowIso();
        req.approval = 'approved';
        req.approvedAt = now;
        req.updatedAt = now;
        return DB.put('purchaseRequests', req).then(function () {
          UI.toast('已同意', 'ok');
          if (o.onDone) o.onDone();
          return true;
        });
      });
    }).catch(function (err) { UI.toast(failMessage(err), 'err'); return null; });
  }

  /**
   * 驳回一条采购申请。**必须写理由** —— 申请人需要知道为什么被拒，
   * 否则他只会看到"提交了但没人管"。理由记在 approvalNote 上，申请详情里能看到。
   * 驳回同时把状态落到「已取消」：这条单子到此为止，不能再下单或到货。
   */
  function rejectPurchase(requestId, opts) {
    var o = opts || {};
    return DB.get('purchaseRequests', requestId).then(function (req) {
      if (!req) { UI.toast('找不到这条采购申请', 'err'); return null; }
      var m = UI.openModal({
        title: '驳回这条采购申请',
        body:
          '<div class="alert-item warn" style="margin-bottom:14px">' +
            '<span class="who">' + UI.esc(req.name) + '</span>' +
            '<span>申请人 ' + UI.esc(req.applicant || '-') +
              '，预算 ' + UI.esc(req.budget === '' || req.budget === undefined ? '-' : req.budget) + ' 元</span>' +
          '</div>' +
          '<div class="alert-item info" style="margin-bottom:14px">' +
            '<span>驳回后这条申请不能再下单或到货，它占用的兵种预算也会释放。</span></div>' +
          '<div class="form-grid">' +
            UI.field({ label: '驳回理由', name: 'note', type: 'textarea', full: true, required: true,
              placeholder: '如：本季度该兵种预算已用完，下季度再提' }) +
          '</div>',
        footer: '<button class="btn" data-cancel type="button">取消</button>' +
          '<button class="btn danger" data-ok type="button">确认驳回</button>'
      });

      m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.el.querySelector('[data-ok]').addEventListener('click', function () {
        var note = UI.val(m.el, 'note');
        if (!note) { UI.toast('请填写驳回理由', 'warn'); return; }
        var now = DB.nowIso();
        req.approval = 'rejected';
        req.approvalNote = note;
        req.approvedAt = now;
        req.status = 'canceled';
        req.updatedAt = now;
        DB.put('purchaseRequests', req).then(function () {
          m.close();
          UI.toast('已驳回', 'ok');
          if (o.onDone) o.onDone();
        }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
      });
    }).catch(function (err) { UI.toast(failMessage(err), 'err'); return null; });
  }

  /**
   * 设置各兵种的预算额度。
   *
   * 存在 settings 的 budgetByTroop 里（键值对），**完全不动多维表格的表结构** ——
   * 这正是当初把每条业务数据整条塞进一列 JSON 换来的好处：加这种配置项不需要改表，
   * 也就不会打断和飞书那边的关联。
   *
   * 只有管理员能改（服务端会拦），因为预算额度直接决定别人能不能报销。
   */
  function openEditBudgets(opts) {
    var o = opts || {};
    return DB.getSetting(Stats.BUDGET_KEY, {}).then(function (budgets) {
      var map = budgets && typeof budgets === 'object' ? budgets : {};
      var m = UI.openModal({
        title: '设置兵种预算',
        wide: true,
        body:
          '<div class="alert-item info" style="margin-bottom:14px">' +
            '<span>填每个兵种这段时间能用多少钱。留空表示没设额度 —— 没设额度不会算作超支，' +
            '但也就没有上下限提醒了。</span></div>' +
          '<div class="form-grid">' +
            Rules.TROOPS.map(function (t, i) {
              var v = map[t];
              return UI.field({
                label: t, name: 'budget-' + i, type: 'number', min: 0, step: '0.01',
                placeholder: '不限额就留空',
                value: v === undefined || v === null || v === '' ? '' : v
              });
            }).join('') +
          '</div>',
        footer: '<button class="btn" data-cancel type="button">取消</button>' +
          '<button class="btn primary" data-ok type="button">保存预算</button>'
      });

      m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.el.querySelector('[data-ok]').addEventListener('click', function () {
        var next = {};
        Rules.TROOPS.forEach(function (t, i) {
          var raw = UI.val(m.el, 'budget-' + i);
          var amount = num(raw);
          // 空 或 0 都不落库：一个兵种在表里"没有键"和"键是 0"在界面上会显示成两样东西，
          // 统一成"没有键"，免得出现一堆 0 元预算的兵种占着明细表
          if (raw !== '' && amount > 0) next[t] = amount;
        });
        DB.setSetting(Stats.BUDGET_KEY, next).then(function () {
          m.close();
          UI.toast('预算已保存', 'ok');
          if (o.onDone) o.onDone();
        }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
      });
    });
  }

  /* ================= 删除 ================= */

  /**
   * 删除一条记录的统一入口：二次确认 → 删掉 → 记一笔「删除记录」→ 刷新。
   *
   * 删除是不可逆的，所以三件事一件都不能少：
   *   1. 弹框里要把「删了会怎样」写清楚，不能只问一句"确定吗"；
   *   2. 删之前先把整条记录读出来当快照 —— 这是以后人工核对的唯一依据；
   *   3. 写入删除记录失败时**不能**反过来报"删除失败"：删除其实已经成功了，
   *      报假的失败会让使用者以为数据还在，反而更危险。
   */
  function deleteRecord(opts) {
    var o = opts || {};
    return DB.get(o.store, o.key).then(function (row) {
      if (!row) {
        UI.toast('这条记录已经不在了，可能刚刚被别人删掉', 'warn');
        if (o.onDone) o.onDone();
        return false;
      }
      var blocked = o.block ? o.block(row) : null;
      if (blocked) { UI.toast(blocked, 'warn'); return false; }

      var label = o.label ? o.label(row) : String(o.key);
      return UI.confirmDialog({
        title: o.title || '删除这条记录？',
        danger: true,
        okText: '删除',
        // 第一行永远写清"要删的是哪一条"。四个删除入口共用这一句 ——
        // 光问一句"确定吗"，使用者只能凭记忆判断，删错了都不会察觉。
        body: '<p style="margin:0 0 10px">要删除的是：<b>' + UI.esc(label) + '</b></p>' +
          (o.body || '删除后无法撤销。')
      }).then(function (ok) {
        if (!ok) return false;
        return DB.remove(o.store, o.key).then(function () {
          return Rules.logDeletion({
            store: o.store,
            key: o.key,
            label: label,
            reason: o.reason || '',
            snapshot: row
          });
        }).then(function (logged) {
          // logged 为 null 说明删除记录没写进去。这**不代表删除失败** ——
          // 东西已经删掉了；但也不能说"已记入删除记录"，那是假话。
          if (logged) UI.toast('已删除，并记入删除记录', 'ok');
          else UI.toast('已删除，但删除记录没写成功（详见控制台）', 'warn');
          if (o.onDone) o.onDone();
          return true;
        });
      });
    }).catch(function (err) { UI.toast(failMessage(err), 'err'); return false; });
  }

  /** 删除物品身份（连同它的二维码） */
  function deleteItem(code, opts) {
    var o = opts || {};
    return deleteRecord({
      store: 'items', key: code,
      title: '删除这件物品？',
      body: '删除后它的二维码就失效了，库存清单里也不会再出现它。<br>' +
        '<b>它的出入库履历会保留</b>——流水按设计只追加、不删除，' +
        '已经记下的那几条里仍然写着它的编码和名称。<br>' +
        '这次删除会记入「删除记录」，需要时能查回来。',
      label: function (row) { return row.code + ' ' + row.name; },
      block: Rules.blockItemDeletion,
      onDone: o.onDone
    });
  }

  /**
   * 批量删除物品（界面部分：预演 → 确认 → 落库）。
   *
   * 数据层在 Ops.deleteItemsBatch —— 整批一个事务，删物品与写删除记录一起提交，
   * 联网版因此只发一次写请求；详细理由见那边。
   * 这里只负责把"删哪些、跳过哪些、为什么"讲清楚，让人点得下去。
   */
  function deleteItemsBatch(codes, opts) {
    var o = opts || {};
    var want = (codes || []).slice();
    if (!want.length) { UI.toast('没有选中任何物品', 'warn'); return Promise.resolve(null); }

    return Ops.previewItemDeletion(want).then(function (info) {
      if (!info.deletable.length) {
        UI.toast(info.blocked.length
          ? '选中的 ' + info.blocked.length + ' 件都有实物在外面或待修，一件都不能删'
          : '这些物品已经不在了（可能刚被别人删掉）', 'warn');
        if (o.onDone) o.onDone();
        return null;
      }

      var LIST_MAX = 20;
      var names = info.deletable.slice(0, LIST_MAX).map(function (item) {
        return UI.esc(item.code + ' ' + item.name);
      });
      var blockedRows = info.blocked.slice(0, 8).map(function (b) {
        return UI.esc(b.item.code + ' ' + b.item.name) + ' —— ' + UI.esc(b.reason);
      });

      return UI.confirmDialog({
        title: '批量删除 ' + info.deletable.length + ' 件物品？',
        danger: true,
        okText: '删除这 ' + info.deletable.length + ' 件',
        // 第一行照旧写清"要删的是哪几条"。批量也不能只问一句"确定吗" ——
        // 一次删十几件，光靠记忆根本判断不了。
        body: '<p style="margin:0 0 10px">要删除的是：<b>' + names.join('、') +
            (info.deletable.length > LIST_MAX ? '…等共 ' + info.deletable.length + ' 件' : '') + '</b></p>' +
          (info.blocked.length
            ? '<p style="margin:0 0 4px;color:var(--warn)"><b>下面 ' + info.blocked.length +
              ' 件会被跳过</b>（还有实物在外面或待修，删了这几件就没人认领了）：</p>' +
              '<p style="margin:0 0 10px">' + blockedRows.join('<br>') +
              (info.blocked.length > 8 ? '<br>…等共 ' + info.blocked.length + ' 件' : '') + '</p>'
            : '') +
          (info.missing ? '<p>另有 ' + info.missing + ' 件已经不在了（可能刚被别人删掉），跳过。</p>' : '') +
          '<p>删除后这些物品的二维码就失效，库存清单里也不会再出现它们。<br>' +
          '<b>它们的出入库履历会保留</b>——流水按设计只追加、不删除。<br>' +
          '每一件都会单独记入「删除记录」，需要时能查回来。</p>'
      }).then(function (ok) {
        if (!ok) { UI.toast('已取消，一件都没有删', 'warn'); return null; }
        return Ops.deleteItemsBatch(info.deletable.map(function (i) { return i.code; }))
          .then(function (res) {
            // 以**实际结果**为准提示，而不是拿预演的数字：确认框弹出到我点确认之间，
            // 可能刚好有人把某件借出去了，那一件会被重新判定为"不能删"。
            var extra = res.blocked.length + info.blocked.length > 0
              ? '，跳过 ' + (res.blocked.length + info.blocked.length) + ' 件'
              : '';
            UI.toast('已删除 ' + res.removed.length + ' 件，并逐条记入删除记录' + extra, 'ok');
            if (o.onDone) o.onDone();
            return res.removed.length;
          });
      });
    }).catch(function (err) {
      // 事务失败 = 整体回滚，所以"一件都没删"是实话，不是糊弄
      UI.toast('批量删除失败，一件都没有删（数据已整体回滚）：' + failMessage(err), 'err');
      return null;
    });
  }

  /** 删除采购申请（任何状态都能删） */
  function deletePurchase(requestId, opts) {
    var o = opts || {};
    return deleteRecord({
      store: 'purchaseRequests', key: num(requestId),
      title: '删除这条采购申请？',
      body: '删除后这条申请不再出现，也不再占用兵种预算。<br>' +
        '已经到货入库的物品和出入库记录都会保留，它们上面会显示「来源已删除」。<br>' +
        '这次删除会记入「删除记录」。',
      label: function (row) { return '#' + row.id + ' ' + row.name; },
      onDone: o.onDone
    });
  }

  /** 删除发票 */
  function deleteInvoice(invoiceId, opts) {
    var o = opts || {};
    return deleteRecord({
      store: 'invoices', key: num(invoiceId),
      title: '删除这张发票？',
      body: '删除后发票台账里不再出现它。<br>' +
        '由它入库的物品会保留，来源那里显示「来源已删除」——' +
        '物品是实物，不该因为票据被删就跟着消失。<br>' +
        '这次删除会记入「删除记录」。',
      label: function (row) { return row.invoiceNo + '（' + (row.supplier || '无供应商') + '）'; },
      onDone: o.onDone
    });
  }

  /**
   * 删除一条出入库流水。
   * 流水原本是只追加的，这里开的是一道明确的例外：删得掉，但一定留痕。
   */
  function deleteTransaction(txnId, opts) {
    var o = opts || {};
    return deleteRecord({
      store: 'transactions', key: num(txnId),
      title: '删除这条出入库流水？',
      body: '<b>流水按原设计是只追加、不删除的</b>，删除它是为了给"登记错了"留一条出路。<br>' +
        '注意：<b>删除流水不会改动物品的库存数量</b>。如果这一条当时确实动过数量，' +
        '要另外用一次出入库操作把数量改回来，否则账实会对不上。<br>' +
        '这次删除会连同流水内容一起记入「删除记录」。',
      label: function (row) {
        return (Rules.TXN_TYPES[row.type] || row.type) + ' ' + row.itemCode + ' × ' + num(row.qty);
      },
      onDone: o.onDone
    });
  }

  /** 确认到货并入库 */
  function openArrive(requestId, opts) {
    var o = opts || {};
    DB.get('purchaseRequests', requestId).then(function (req) {
      if (!req) { UI.toast('找不到这条采购申请', 'err'); return; }
      // 没同意的申请不能到货。界面上本来就不画这个按钮，这里再挡一道 ——
      // 按钮的显示条件是"渲染那一刻"的判断，挡在这里才是"点下去那一刻"的判断。
      if (!Rules.isApproved(req)) {
        UI.toast(Rules.isPendingApproval(req)
          ? '这条申请还没经过管理员审批，暂时不能入库'
          : '这条申请已被驳回，不能入库', 'warn');
        return;
      }
      DB.get('categories', req.categoryId).then(function (cat) {
        var defaultMode = (cat && cat.defaultIdentityMode) || 'shared';
        /** 已选好的发票 PDF（读好 base64 缓存）；null = 没传 */
        var invoiceFile = null;

        function pdfMsg() { return m.el.querySelector('#arrive-pdf-msg'); }
        function paintPdf() {
          var node = pdfMsg();
          if (!node) return;
          node.innerHTML = invoiceFile
            ? '已选：<b>' + UI.esc(invoiceFile.name) + '</b>（' +
              Math.max(1, Math.round(invoiceFile.size / 1024)) + ' KB）　' +
              '<a href="javascript:void(0)" id="arrive-pdf-remove">移除</a>'
            : '把发票 PDF 拖到这里，或点击选择文件（也可以先不传）';
          var rm = node.querySelector('#arrive-pdf-remove');
          if (rm) rm.addEventListener('click', function (e) {
            e.stopPropagation();
            invoiceFile = null;
            paintPdf();
          });
        }

        /** 选了文件就立刻读成 base64 缓存起来 —— 提交时不再等 IO */
        function acceptFile(file) {
          readFileBase64(file).then(function (loaded) {
            invoiceFile = loaded;
            paintPdf();
          }).catch(function (err) {
            invoiceFile = null;
            UI.toast((err && err.message) || '这个文件读不出来', 'err');
          });
        }

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
              UI.field({ label: '发票金额（元）', name: 'amount', type: 'number', min: 0, step: '0.01',
                value: req.budget || '', required: true }) +
              UI.field({ label: '发票日期', name: 'invoiceDate', type: 'date', value: UI.todayStr() }) +
              '<div class="field full">' +
                '<label>发票 PDF</label>' +
                '<div class="pdf-drop" id="arrive-pdf-drop">' +
                  '<input type="file" accept="application/pdf,.pdf" id="arrive-pdf-input" hidden>' +
                  '<div class="pdf-drop-msg" id="arrive-pdf-msg"></div>' +
                '</div>' +
                '<span class="hint">从电脑桌面把 PDF 直接拖进来就行；手机上点一下选文件。发票号码、供应商不用再手填 —— 都在 PDF 里。</span>' +
              '</div>' +
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

        // 拖拽 + 点选两条路都接到同一个 acceptFile。
        // dragover 必须 preventDefault，否则浏览器会直接打开这个 PDF 而不是交给我们。
        var drop = m.el.querySelector('#arrive-pdf-drop');
        var input = m.el.querySelector('#arrive-pdf-input');
        if (drop) {
          ['dragenter', 'dragover'].forEach(function (evt) {
            drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add('dragging'); });
          });
          ['dragleave', 'drop'].forEach(function (evt) {
            drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove('dragging'); });
          });
          drop.addEventListener('drop', function (e) {
            var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) acceptFile(file);
          });
          drop.addEventListener('click', function () { if (input) input.click(); });
        }
        if (input) {
          input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            if (file) acceptFile(file);
          });
        }
        paintPdf();

        m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
        m.el.querySelector('[data-ok]').addEventListener('click', function () {
          var mask = m.el;
          var modeNode = UI.qs('[name="identityMode"]:checked', mask);
          var okBtn = mask.querySelector('[data-ok]');
          okBtn.disabled = true;
          Ops.arrive({
            requestId: requestId,
            quantity: UI.val(mask, 'quantity'),
            location: UI.val(mask, 'location'),
            amount: UI.val(mask, 'amount'),
            invoiceDate: UI.val(mask, 'invoiceDate'),
            invoiceFile: invoiceFile,
            identityMode: modeNode ? modeNode.value : defaultMode,
            operator: UI.val(mask, 'operator'),
            remark: UI.val(mask, 'remark')
          }).then(function (res) {
            m.close();
            UI.toast('已入库：' + res.codes.join('、') + '（发票已登记）', 'ok');
            if (o.onDone) o.onDone(res);
          }).catch(function (err) {
            UI.toast(failMessage(err), 'err');
            okBtn.disabled = false;
          });
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
    approvePurchase: approvePurchase,
    rejectPurchase: rejectPurchase,
    openEditBudgets: openEditBudgets,
    deleteRecord: deleteRecord,
    deleteItem: deleteItem,
    deleteItemsBatch: deleteItemsBatch,
    deletePurchase: deletePurchase,
    deleteInvoice: deleteInvoice,
    deleteTransaction: deleteTransaction,
    openActionDialog: openActionDialog,
    failMessage: failMessage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
