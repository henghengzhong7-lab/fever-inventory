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

  /**
   * 「把 PDF 拖进来 / 点一下选文件」这一块区域的工厂（第十四周抽出来）。
   *
   * 为什么抽出来：到货登记和"补传发票"要用同一套交互。
   * 拖拽那一串事件（dragenter/dragover 必须 preventDefault，否则浏览器
   * 会直接把 PDF 打开而不是交给我们）写两遍，迟早会有一处漏掉某个事件。
   *
   * ids 由调用方给：到货表单那三个 id（arrive-pdf-*）被端到端测试直接引用，
   * 不能改；补传弹窗用自己的一组。返回的 get() 拿到的是读好的 base64 缓存
   * （选择时就读完，提交时不再等 IO），没选就是 null。
   */
  function makePdfPicker(ids, placeholder) {
    var picked = null;

    function msgNode(mask) { return mask.querySelector('#' + ids.msg); }

    function paint(mask) {
      var node = msgNode(mask);
      if (!node) return;
      node.innerHTML = picked
        ? '已选：<b>' + UI.esc(picked.name) + '</b>（' +
          Math.max(1, Math.round(picked.size / 1024)) + ' KB）　' +
          '<a href="javascript:void(0)" id="' + ids.remove + '">移除</a>'
        : UI.esc(placeholder);
      var rm = node.querySelector('#' + ids.remove);
      if (rm) rm.addEventListener('click', function (e) {
        e.stopPropagation();
        picked = null;
        paint(mask);
      });
    }

    function accept(mask, file) {
      readFileBase64(file).then(function (loaded) {
        picked = loaded;
        paint(mask);
      }).catch(function (err) {
        picked = null;
        UI.toast((err && err.message) || '这个文件读不出来', 'err');
      });
    }

    return {
      html: '<div class="pdf-drop" id="' + ids.drop + '">' +
        '<input type="file" accept="application/pdf,.pdf" id="' + ids.input + '" hidden>' +
        '<div class="pdf-drop-msg" id="' + ids.msg + '"></div>' +
        '</div>',
      /** 弹窗插进 DOM 之后调用：绑事件并画一遍初始状态 */
      wire: function (mask) {
        var drop = mask.querySelector('#' + ids.drop);
        var input = mask.querySelector('#' + ids.input);
        if (drop) {
          ['dragenter', 'dragover'].forEach(function (evt) {
            drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add('dragging'); });
          });
          ['dragleave', 'drop'].forEach(function (evt) {
            drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove('dragging'); });
          });
          drop.addEventListener('drop', function (e) {
            var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) accept(mask, file);
          });
          drop.addEventListener('click', function () { if (input) input.click(); });
        }
        if (input) {
          input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            if (file) accept(mask, file);
          });
        }
        paint(mask);
      },
      get: function () { return picked; },
      /** 直接塞一份已经读好的文件（「沿用上一张发票 PDF」用它），并重画 */
      set: function (file, mask) { picked = file || null; paint(mask); },
      repaint: function (mask) { paint(mask); }
    };
  }

  /** 到货登记那张表单的 PDF 区域 id —— 端到端测试直接按它们找元素，别改 */
  var ARRIVE_PDF_IDS = {
    drop: 'arrive-pdf-drop', input: 'arrive-pdf-input',
    msg: 'arrive-pdf-msg', remove: 'arrive-pdf-remove'
  };

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
   *
   * 用 TROOP_OPTIONS 而不是 TROOPS（第十四周）：步兵已细分成轮腿/过洞/可折叠，
   * 老的「步兵」只留给历史数据，不再作为新选项出现。
   * current 传编辑对象的现有兵种：历史值会被临时补进选项，
   * 否则编辑一条老记录时下拉框选不中它，一保存兵种就被静默改掉。
   */
  function troopOptions(current) {
    return [''].concat(Rules.troopChoices(current)).map(function (t) {
      return { value: t, label: t || '请选择兵种…' };
    });
  }

  /** 新增物品 */
  function openNewItem(opts) {
    var o = opts || {};
    // 第二十四轮：同名物品要归同一个大类 —— 所以这里要按名称查现有的物品
    return Promise.all([DB.getAll('categories'), DB.getAll('items')]).then(function (arr) {
      var categories = arr[0];
      var existingItems = arr[1] || [];
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
            // 添加人（第二十三轮）：写入物品行（addedBy）与这次入库的流水。
            // 默认带出当前登录人 —— 飞书里就是你自己；离线版给「本机操作」。
            // 允许改，是为了帮别人代录时不至于把账记到自己头上。
            UI.field({ label: '添加人', name: 'operator', required: true,
              value: o.operator || Rules.currentActor(),
              hint: '默认是你自己；帮别人代录时改成实际添加的人' }) +
            // 总价 / 购买时间都是选填（第十四周）：有的东西买回来就忘了多少钱，
            // 逼着填只会让人随手填 0，账面反而更不准。数量保持必填 —— 它是库存账的基础。
            UI.field({ label: '总价（元）', name: 'totalPrice', type: 'number', min: 0, step: '0.01',
              hint: '选填。记不清价格就先留空' }) +
            UI.field({ label: '购买时间', name: 'purchaseDate', type: 'date',
              hint: '选填。填了在物品详情里能看到' }) +
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
        body: '<div id="ni-same-name"></div><div id="ni-body"></div>',
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

      /* ---------- 同名物品归同一个大类（第二十四轮） ---------- */

      /** 抓出当前表单已填的值 —— 切大类会重建表单，得先存着再回填 */
      function snapshotForm() {
        var snap = {};
        UI.qsa('[name]', m.el).forEach(function (node) {
          if (node.type === 'radio') { if (node.checked) snap[node.name] = node.value; return; }
          snap[node.name] = node.value;
        });
        return snap;
      }
      function restoreForm(snap) {
        Object.keys(snap).forEach(function (name) {
          var node = m.el.querySelector('[name="' + name + '"]');
          if (!node) return;
          if (node.type === 'radio') { node.checked = (node.value === snap[name]); return; }
          node.value = snap[name];
        });
      }

      /** 使用者自己改过大类之后，就不再自动帮他切 —— 别跟人抢方向盘 */
      var categoryTouched = false;

      /** 换大类并保住已经填好的内容（规格、位置、数量……） */
      function switchCategory(catId) {
        var sel = m.el.querySelector('[name="categoryId"]');
        if (!sel || sel.value === catId) return;
        var snap = snapshotForm();
        // ⚠️ 必须把 categoryId 从快照里摘掉：不然回填时会把刚切过去的大类又写回旧值，
        // 表现就是"点了没反应"（本人踩过，整条用例超时）
        delete snap.categoryId;
        sel.value = catId;
        paint();
        restoreForm(snap);
      }

      function categoryName(id) {
        var c = categories.filter(function (x) { return x.id === id; })[0];
        return (c && c.name) || id;
      }

      /**
       * 名称一改就查同名：
       *   · 有同名 → 自动把大类带成它们所在的那个（前提是使用者没手动改过大类），并说清楚
       *   · 同名散在多个大类里 → 如实列出来，让他自己判断
       *   · 没同名 → 清掉提示
       * 提示框在 #ni-body **外面**，所以切大类重建表单时不会被冲掉。
       */
      function checkSameName() {
        var box = m.el.querySelector('#ni-same-name');
        if (!box) return;
        var typed = String(UI.val(m.el, 'name') || '').trim();
        var same = Rules.sameNameItems(existingItems, typed);
        if (!same.length) { box.innerHTML = ''; return; }

        var counts = {};
        same.forEach(function (it) { counts[it.categoryId] = (counts[it.categoryId] || 0) + 1; });
        var ids = Object.keys(counts);
        var desc = ids.map(function (id) { return '「' + categoryName(id) + '」' + counts[id] + ' 件'; }).join('、');
        // 目标大类 = 同名物品最多的那个（并列时取排在前面的）
        var target = ids.slice().sort(function (a, b) { return counts[b] - counts[a]; })[0];

        box.innerHTML = '<div class="alert-item info"><span class="who">已有同名物品</span><span>' +
          '库里已经有 ' + same.length + ' 件叫「' + UI.esc(typed) + '」的，在 ' + UI.esc(desc) + '。' +
          (categoryTouched
            ? '你要放到别的类也行 —— 但同名散在几个类里，以后清点和搜索都会别扭。'
            : '已自动把所属大类切到「' + UI.esc(categoryName(target)) + '」；要放别的类自己改。') +
          '</span></div>';

        if (!categoryTouched) switchCategory(target);
      }

      var sameNameTimer = null;
      function onNameInput() {
        // 打字过程中不必每个字都查，停一下再查
        if (sameNameTimer) clearTimeout(sameNameTimer);
        sameNameTimer = setTimeout(checkSameName, 200);
      }

      paint();
      m.el.addEventListener('input', function (e) {
        if (e.target.name === 'name') onNameInput();
      });
      m.el.addEventListener('change', function (e) {
        if (e.target.name === 'categoryId') { categoryTouched = true; paint(); }
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
        // 添加人必填（第二十三轮）：不能空着，也不再用「前台登记」这种假名字兜底
        var operator = UI.val(mask, 'operator');
        if (!operator) { UI.toast('请填写添加人姓名', 'warn'); return; }
        Ops.inbound({
          categoryId: UI.val(mask, 'categoryId'),
          troop: troop,
          name: UI.val(mask, 'name'),
          spec: UI.val(mask, 'spec'),
          location: UI.val(mask, 'location'),
          quantity: UI.val(mask, 'quantity'),
          safetyStock: UI.val(mask, 'safetyStock'),
          totalPrice: UI.val(mask, 'totalPrice'),
          purchaseDate: UI.val(mask, 'purchaseDate'),
          identityMode: pickedMode ? pickedMode.value : 'shared',
          remark: UI.val(mask, 'remark'),
          extra: extra,
          operator: operator
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
            options: troopOptions(o.troop),
            value: Rules.normalizeTroop(o.troop),
            hint: '买给哪个兵种用。兵种预算就是按这个字段汇总的，不能空着' }) +
          UI.field({ label: '物品名称', name: 'name', required: true, placeholder: '如：步进电机 NEMA17' }) +
          UI.field({ label: '规格 / 型号', name: 'spec', placeholder: '如：42BYGH 1.5A' }) +
          UI.field({ label: '申请数量', name: 'quantity', type: 'number', min: 1, value: 1, required: true }) +
          UI.field({ label: '预算（元）', name: 'budget', type: 'number', min: 0, step: '0.01', placeholder: '如：3000',
            hint: '同意后会计入该兵种的已用预算' }) +
          // 购买链接（选填）。占位符刻意不写成完整网址：离线版有"应用文件里不准出现外网地址"的自检
          UI.field({ label: '购买链接', name: 'link', placeholder: '粘贴商品页地址，如 item.taobao.com/xxx',
            hint: '选填。填了之后在列表里可以直接点开去下单；不写协议也会自动补上' }) +
          UI.field({ label: '申请人', name: 'applicant', required: true, placeholder: '填写申请人姓名' }) +
          UI.field({ label: '用途说明', name: 'purpose', type: 'textarea', full: true, placeholder: '买回来做什么用' }) +
        '</div>',
        footer: '<button class="btn" data-cancel type="button">取消</button>' +
          '<button class="btn" data-draft type="button">先存起来</button>' +
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
          link: UI.val(mask, 'link'),
          purpose: UI.val(mask, 'purpose'),
          applicant: applicant
        }).then(function () {
          m.close();
          UI.toast('采购申请已提交（' + troop + '），等待管理员审批', 'ok');
          if (o.onDone) o.onDone();
        }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
      });

      // 「先存起来」（第十五轮）：不提交，放进待提交清单，攒够了再打包提交 ——
      // 校验与提交同一套（troop/name/applicant 必填），只是不落成正式申请
      m.el.querySelector('[data-draft]').addEventListener('click', function () {
        var mask = m.el;
        var name = UI.val(mask, 'name');
        var applicant = UI.val(mask, 'applicant');
        var troop = UI.val(mask, 'troop');
        if (!troop) { UI.toast('请先选择兵种', 'warn'); return; }
        if (!name) { UI.toast('请填写物品名称', 'warn'); return; }
        if (!applicant) { UI.toast('请填写申请人', 'warn'); return; }
        Ops.addToDraftCart({
          key: Rules.ownerKey(DB.currentUser()),
          categoryId: UI.val(mask, 'categoryId'),
          troop: troop,
          name: name,
          spec: UI.val(mask, 'spec'),
          quantity: UI.val(mask, 'quantity'),
          budget: UI.val(mask, 'budget'),
          link: UI.val(mask, 'link'),
          purpose: UI.val(mask, 'purpose'),
          applicant: applicant
        }).then(function (r) {
          m.close();
          UI.toast('已存进待提交清单（共 ' + r.count + ' 条），攒够了到「待提交」打包提交', 'ok');
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
      // 列哪些兵种：常规选项 + 已经配过额度的历史兵种（如老的「步兵」）。
      // 不列历史兵种的话，它压着的那笔预算在界面上就成了"只能看、不能改"。
      var troops = Rules.budgetTroops(map);
      var m = UI.openModal({
        title: '设置兵种预算',
        wide: true,
        body:
          '<div class="alert-item info" style="margin-bottom:14px">' +
            '<span>填每个兵种这段时间能用多少钱。留空表示没设额度 —— 没设额度不会算作超支，' +
            '但也就没有上下限提醒了。</span></div>' +
          '<div class="form-grid">' +
            troops.map(function (t, i) {
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
        troops.forEach(function (t, i) {
          var raw = UI.val(m.el, 'budget-' + i);
          var amount = num(raw);
          // 空 或 0 都不落库：一个兵种在表里"没有键"和"键是 0"在界面上会显示成两样东西，
          // 统一成"没有键"，免得出现一堆 0 元预算的兵种占着明细表
          if (raw !== '' && amount > 0) next[t] = amount;
        });
        // 没出现在表单里的键（更早改过名的兵种、手改过的数据）原样带过去，
        // 不能因为界面上不再列它就把这笔钱悄悄清掉。
        Object.keys(map).forEach(function (t) {
          if (troops.indexOf(t) === -1) next[t] = map[t];
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
   * 批量删除出入库流水（第二十一轮）。
   *
   * 与单条删除**完全同一口径**：谁都能删、**不改动物品的库存数量**、逐条记入「删除记录」。
   * 差别只在"整批一个事务"（理由见 Ops.deleteTransactions 的注释：删除记录是读改写，
   * 逐条删会互相覆盖）。
   *
   * 确认框第一行照旧把**要删的是哪几条**列出来 —— 一次删二十条，
   * 光问一句"确定吗"，谁都判断不了自己到底删了什么。
   */
  function deleteTransactionsBatch(ids, opts) {
    var o = opts || {};
    return Ops.previewTransactionDeletion(ids).then(function (info) {
      if (!info.deletable.length) {
        UI.toast(info.missing
          ? '选中的 ' + info.missing + ' 条都已经不在了（可能刚被别人删掉）'
          : '没有选中任何流水', 'warn');
        if (o.onDone) o.onDone();
        return null;
      }

      var LIST_MAX = 20;
      var names = info.deletable.slice(0, LIST_MAX).map(function (t) {
        return UI.esc(Rules.txnLabel(t));
      });

      return UI.confirmDialog({
        title: '批量删除 ' + info.deletable.length + ' 条出入库流水？',
        danger: true,
        okText: '删除这 ' + info.deletable.length + ' 条',
        body: '<p style="margin:0 0 10px">要删除的是：<b>' + names.join('、') +
            (info.deletable.length > LIST_MAX ? '…等共 ' + info.deletable.length + ' 条' : '') + '</b></p>' +
          (info.missing ? '<p>另有 ' + info.missing + ' 条已经不在了（可能刚被别人删掉），跳过。</p>' : '') +
          '<p><b>流水按原设计是只追加、不删除的</b>，删它们是为了给「登记错了」留一条出路。<br>' +
          '<b>删除流水不会改动物品的库存数量</b>。如果某一条当时确实动过数量，' +
          '要另外用一次出入库操作把数量改回来，否则账实会对不上。<br>' +
          '每一条都会单独记入「删除记录」，需要时能查回来。</p>'
      }).then(function (ok) {
        if (!ok) { UI.toast('已取消，一条都没有删', 'warn'); return null; }
        return Ops.deleteTransactions(ids).then(function (res) {
          // 以**实际删掉的**为准提示，不拿预演的数字当结论
          var extra = res.missing ? '，跳过 ' + res.missing + ' 条（已被别人删掉）' : '';
          UI.toast('已删除 ' + res.removed.length + ' 条流水，并逐条记入删除记录' + extra, 'ok');
          if (o.onDone) o.onDone();
          return res.removed.length;
        });
      });
    }).catch(function (err) {
      // 事务失败 = 整体回滚，所以"一条都没删"是实话，不是糊弄
      UI.toast('批量删除失败，一条都没有删（数据已整体回滚）：' + failMessage(err), 'err');
      return null;
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
        return Rules.txnLabel(row);
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
        // 发票 PDF 区域：拖拽 / 点选这套交互与「补传发票」共用，见 makePdfPicker
        var pdf = makePdfPicker(ARRIVE_PDF_IDS, '把发票 PDF 拖到这里，或点击选择文件（也可以先不传）');
        // 批量到货时上一条用过的发票 PDF（第十五轮）：一次采购一张票，省掉重复选文件
        var lastFile = o.lastFile || null;

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
              // 这一栏是「到货日期」（第十四周由「发票日期」改名）。
              // 字段名刻意仍叫 invoiceDate：它是发票行上的一个已有键，
              // 改名要连带迁移所有历史数据，风险大、收益为零。
              // 界面上一切显示它的地方都统一说「到货日期」。
              UI.field({ label: '到货日期', name: 'invoiceDate', type: 'date', value: UI.todayStr() }) +
              '<div class="field full">' +
                '<label>发票 PDF</label>' +
                pdf.html +
                (lastFile
                  ? '<div style="margin-top:8px">' +
                      '<button class="btn small" data-use-last type="button">沿用上一张发票 PDF</button> ' +
                      '<span class="hint">' + UI.esc(lastFile.name) + '　一次采购一张票时就点这个，不用重复选文件</span>' +
                    '</div>'
                  : '') +
                '<span class="hint">从电脑桌面把 PDF 直接拖进来就行；手机上点一下选文件。发票号码、供应商不用再手填 —— 都在 PDF 里。没拿到发票也可以先空着，之后在采购申请页点「补传发票」补上。</span>' +
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

        // 拖拽 + 点选两条路都由 picker 负责（dragover 必须 preventDefault，
        // 否则浏览器会直接打开这个 PDF 而不是交给我们）
        pdf.wire(m.el);
        var useLastBtn = m.el.querySelector('[data-use-last]');
        if (useLastBtn) {
          useLastBtn.addEventListener('click', function () { pdf.set(lastFile, m.el); });
        }

        m.el.querySelector('[data-cancel]').addEventListener('click', function () {
          m.close();
          if (o.onCancel) o.onCancel();
        });
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
            invoiceFile: pdf.get(),
            identityMode: modeNode ? modeNode.value : defaultMode,
            operator: UI.val(mask, 'operator'),
            remark: UI.val(mask, 'remark')
          }).then(function (res) {
            m.close();
            UI.toast('已入库：' + res.codes.join('、') + '（发票已登记）', 'ok');
            if (o.onDone) o.onDone(res, pdf.get());
          }).catch(function (err) {
            UI.toast(failMessage(err), 'err');
            okBtn.disabled = false;
          });
        });
      });
    });
  }

  /** 补传发票那张弹窗用的 PDF 区域 id（与到货表单分开，两处可以同时开着） */
  var UPLOAD_PDF_IDS = {
    drop: 'upload-pdf-drop', input: 'upload-pdf-input',
    msg: 'upload-pdf-msg', remove: 'upload-pdf-remove'
  };

  /**
   * 补传 / 更换发票 PDF（第十四周）。
   *
   * 真实场景：发票往往比货晚到。到货登记那一刻手上只有金额和日期，
   * 硬要附件等于让人卡在门口 —— 所以到货表单允许先不传，
   * 这里给一条事后补齐的路：只更新发票记录的附件字段，
   * **不动库存、不写流水**（票据补上了，东西早就入过库了）。
   *
   * 已经有附件时也允许再传一次，等于"换一份更清楚的扫描件"，
   * 但界面上会先把"覆盖"这件事说清楚。
   */
  function openUploadInvoice(invoiceId, opts) {
    var o = opts || {};
    var id = num(invoiceId);
    if (!id) { UI.toast('没有指定要补传的发票', 'err'); return; }
    DB.get('invoices', id).then(function (inv) {
      if (!inv) { UI.toast('找不到这张发票', 'err'); return; }
      var has = !!(inv.fileRef || inv.fileData);
      var pdf = makePdfPicker(UPLOAD_PDF_IDS, '把发票 PDF 拖到这里，或点击选择文件');
      var m = UI.openModal({
        title: has ? '更换发票 PDF' : '补传发票 PDF',
        wide: true,
        body:
          '<div class="alert-item info" style="margin-bottom:14px">' +
            '<span class="who">' + UI.esc(Rules.invoiceLabel(inv)) + '</span>' +
            '<span>金额 ' + UI.esc(num(inv.amount).toFixed(2)) + ' 元' +
              (inv.invoiceDate ? '　到货日期 ' + UI.esc(inv.invoiceDate) : '') + '</span>' +
          '</div>' +
          (has
            ? '<div class="alert-item warn" style="margin-bottom:14px"><span class="who">已经有附件了</span>' +
              '<span>现在上传的会替换掉原来那份（不影响金额、日期和库存）。</span></div>'
            : '') +
          '<div class="field full"><label>发票 PDF</label>' + pdf.html +
            '<span class="hint">只收 PDF，单个不超过 20MB。补传只补票据，不会改动库存和流水。</span></div>',
        footer: '<button class="btn" data-cancel type="button">取消</button>' +
          '<button class="btn primary" data-ok type="button">' + (has ? '替换' : '上传') + '</button>'
      });

      pdf.wire(m.el);
      m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.el.querySelector('[data-ok]').addEventListener('click', function () {
        var file = pdf.get();
        if (!file) { UI.toast('先选一个 PDF 文件', 'warn'); return; }
        var btn = m.el.querySelector('[data-ok]');
        btn.disabled = true;
        Ops.attachInvoiceFile({ invoiceId: id, file: file }).then(function () {
          m.close();
          UI.toast('发票已' + (has ? '替换' : '补传') + '：' + file.name, 'ok');
          if (o.onDone) o.onDone();
        }).catch(function (err) {
          UI.toast(failMessage(err), 'err');
          btn.disabled = false;
        });
      });
    });
  }

  /* ================= 改「身份方式」（第十五轮） ================= */

  /**
   * 共用 → 单独：只确认一次。
   * 这个方向**不动任何已经贴出去的标签**（原编码留着继续用，新码是新贴的），
   * 所以风险低，一个确认框说清"会发生什么"就够了。
   */
  function openIdentitySplit(item, o) {
    var qty = num(item.totalQty);
    var newCount = Math.max(0, qty - 1);
    UI.confirmDialog({
      title: '改成一件一码？',
      okText: newCount ? ('拆成 ' + qty + ' 个身份') : '改成单独使用',
      body:
        '「' + UI.esc(item.name) + '」（' + UI.esc(item.code) + '）现在是同款共用，一共 ' + qty + ' 件。<br><br>' +
        (newCount
          ? '· 原编码 <b>' + UI.esc(item.code) + '</b> 保留其中 1 件，另外新发 <b>' + newCount + '</b> 个编码；<br>' +
            '· <b>已经贴出去的标签全部继续有效</b>，不用重贴；<br>'
          : '· 只有 1 件，不存在拆分，只是把身份方式改成「单独使用」；<br>') +
        '· 库存件数一件不变（还是 ' + qty + ' 件）；<br>' +
        '· 安全库存会被清掉 —— 那个只在同款共用时才有意义。'
    }).then(function (ok) {
      if (!ok) return null;
      return Ops.changeIdentity({ code: item.code, mode: 'single' }).then(function (r) {
        UI.toast(r.newCodes.length
          ? '已拆成单独身份：保留 ' + r.keptCode + '，新发 ' + r.newCodes.join('、')
          : '已改成单独使用', 'ok');
        if (o.onDone) o.onDone(r);
        return r;
      });
    }).catch(function (err) { UI.toast(failMessage(err), 'err'); return null; });
  }

  /**
   * 单独 → 共用：先挑合并哪些、留哪个，再确认一次。
   * 这个方向**会作废被删编码对应的标签**（贴出去的那几张得撕下来重贴），
   * 所以必须两步，而且两处都把后果写成原话，不能让"下一步"看起来像普通操作。
   */
  function openIdentityMerge(item, candidates, o) {
    if (!candidates.length) {
      UI.toast('没找到可以合并的同款（要求名称、规格、大类都一样，且都没借出、没待修）', 'warn');
      return;
    }
    var all = [item].concat(candidates).slice().sort(function (a, b) {
      return String(a.code).localeCompare(String(b.code));
    });
    var defaultKeep = all[0].code;

    var m = UI.openModal({
      title: '合并成「同款共用」',
      wide: true,
      body:
        '<div class="alert-item warn" style="margin-bottom:14px">' +
          '<span class="who">会作废标签</span>' +
          '<span>合并后只留一个编码，<b>其余编码的标签就作废了</b>，贴在实物上的那几张要撕下来重贴。' +
          '请只勾选确实是同一款的东西。</span>' +
        '</div>' +
        '<div class="field full"><label>合并哪些身份</label>' +
          '<div class="inv-pick-list">' +
            all.map(function (r) {
              return '<label class="inv-pick-row">' +
                '<input type="checkbox" name="merge-pick" value="' + UI.esc(r.code) + '" checked>' +
                '<span class="inv-pick-name">' + UI.esc(r.code) + '　' + UI.esc(r.name) +
                  '<span class="hint">' + UI.esc(r.location || '没写位置') +
                  '　在库 ' + num(r.inStockQty) + ' / 共 ' + num(r.totalQty) + '</span></span>' +
                '</label>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="field"><label>保留哪个编码</label>' +
          '<select class="select" name="keep-code">' +
            all.map(function (r) {
              return '<option value="' + UI.esc(r.code) + '"' + (r.code === defaultKeep ? ' selected' : '') + '>' +
                UI.esc(r.code) + '　' + UI.esc(r.location || '没写位置') + '</option>';
            }).join('') +
          '</select>' +
          '<span class="hint">留着贴得最清楚的那张 —— 其余几张会被作废。</span>' +
        '</div>',
      footer: '<button class="btn" data-cancel type="button">取消</button>' +
        '<button class="btn primary" data-ok type="button">下一步</button>'
    });
    var mask = m.el;

    function picked() {
      return UI.qsa('input[name="merge-pick"]:checked', mask).map(function (b) { return b.value; });
    }
    function paint() {
      var n = picked().length;
      var btn = mask.querySelector('[data-ok]');
      btn.disabled = n < 2;
      btn.textContent = n < 2 ? '至少选两个' : ('下一步（会作废 ' + (n - 1) + ' 张标签）');
    }
    mask.addEventListener('change', paint);
    paint();

    mask.querySelector('[data-cancel]').addEventListener('click', m.close);
    mask.querySelector('[data-ok]').addEventListener('click', function () {
      var codes = picked();
      var keep = UI.val(mask, 'keep-code');
      if (codes.indexOf(keep) === -1) { UI.toast('保留的编码必须在勾选的名单里', 'warn'); return; }
      m.close();
      var drops = codes.filter(function (c) { return c !== keep; });
      UI.confirmDialog({
        title: '确认合并？',
        okText: '合并（作废 ' + drops.length + ' 张标签）',
        danger: true,
        body:
          '保留 <b>' + UI.esc(keep) + '</b>，件数合成一个；<br>' +
          '这些编码会被删除：<b>' + drops.map(function (c) { return UI.esc(c); }).join('、') + '</b><br>' +
          '<b>这几张标签贴在实物上的就认不出来了，需要撕下来重贴。</b><br>' +
          '库存总件数不变，删除会记进「删除记录」。'
      }).then(function (ok2) {
        if (!ok2) return null;
        return Ops.changeIdentity({ code: item.code, mode: 'shared', codesToMerge: codes, keepCode: keep })
          .then(function (r) {
            UI.toast('已合并：保留 ' + r.keptCode + '，作废 ' + r.droppedCodes.join('、'), 'ok');
            if (o.onDone) o.onDone(r);
            return r;
          });
      }).catch(function (err) { UI.toast(failMessage(err), 'err'); return null; });
    });
  }

  /** 改「身份方式」的入口：按当前模式决定走拆分还是合并 */
  function openChangeIdentity(code, opts) {
    var o = opts || {};
    Ops.identityMergeCandidates(code).then(function (res) {
      if ((res.item.identityMode || 'shared') === 'shared') return openIdentitySplit(res.item, o);
      return openIdentityMerge(res.item, res.candidates, o);
    }).catch(function (err) { UI.toast(failMessage(err), 'err'); });
  }

  /**
   * 批量确认到货的向导（第十五轮）：把勾选的那几条**一条一条**走完。
   *
   * 为什么不做成一张大表一起填：每条都有自己的到货数量、存放位置、发票金额与日期、
   * 发票 PDF、身份方式，挤在一张表里手机上根本没法用；而且"按顺序添加相应的物品信息"
   * 本来就是需求方的原话。走完一条自动开下一条，中途点取消就停下 ——
   * **已经走完的那些已经落库了**，不会白填。
   *
   * 「沿用上一张发票 PDF」把上一条用过的附件带过来：一次采购开一张票的时候，
   * 十件东西不用把同一个 PDF 选十遍。
   */
  function openArriveWizard(ids, opts) {
    var o = opts || {};
    var list = (ids || []).slice();
    var done = [];
    var lastFile = null;

    function step() {
      if (!list.length) {
        UI.toast('批量到货完成：共入库 ' + done.length + ' 条', 'ok');
        if (o.onDone) o.onDone(done);
        return;
      }
      var id = list.shift();
      openArrive(id, {
        lastFile: lastFile,
        onDone: function (res, file) {
          done.push({ requestId: id, codes: res.codes });
          lastFile = file || lastFile;
          // 停一下再开下一条：上一条的提示得让人看见，也留出喘口气的时间
          setTimeout(step, 300);
        },
        onCancel: function () {
          UI.toast('已停止，还剩 ' + (list.length + 1) + ' 条没走（走完的那 ' + done.length + ' 条已入库）', 'warn');
          if (o.onDone) o.onDone(done);
        }
      });
    }
    step();
  }

  /**
   * 待提交清单 → 打包提交（第十五轮）。
   * 只问一件事：这批算谁申请的。提交后它们共享一个批次号，
   * 管理员**只收到一条飞书提醒**，审批、到货、发票打包都按这一批走。
   */
  function openSubmitCartDialog(draftIds, opts) {
    var o = opts || {};
    var ids = (draftIds || []).slice();
    if (!ids.length) { UI.toast('先勾选要提交的物品', 'warn'); return; }
    var user = DB.currentUser();
    var m = UI.openModal({
      title: '打包提交采购申请',
      body:
        '<div class="alert-item info" style="margin-bottom:12px">' +
          '<span class="who">' + ids.length + ' 条一起提交</span>' +
          '<span>提交后管理员<b>只会收到一条</b>飞书提醒，审批也可以整批点。</span>' +
        '</div>' +
        '<div class="form-grid">' +
          UI.field({ label: '申请人', name: 'applicant', required: true,
            value: o.defaultApplicant || (user && user.name) || '',
            placeholder: '这批东西算谁申请的',
            hint: '会覆盖清单里每一条原来的申请人 —— 一批东西一般是一个人报的' }) +
        '</div>',
      footer: '<button class="btn" data-cancel type="button">取消</button>' +
        '<button class="btn primary" data-ok type="button">打包提交</button>'
    });
    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-ok]').addEventListener('click', function () {
      var applicant = UI.val(m.el, 'applicant');
      if (!applicant) { UI.toast('请填写申请人', 'warn'); return; }
      var btn = m.el.querySelector('[data-ok]');
      btn.disabled = true;
      Ops.submitDraftCart({
        key: Rules.ownerKey(DB.currentUser()),
        draftIds: ids,
        applicant: applicant
      }).then(function (res) {
        m.close();
        UI.toast('已打包提交 ' + res.count + ' 条（批次 ' + res.batchId + '），等管理员审批', 'ok');
        if (o.onDone) o.onDone(res);
      }).catch(function (err) {
        UI.toast(failMessage(err), 'err');
        btn.disabled = false;
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

  /**
   * 看"直接入库"花了哪些钱（第二十六轮）。
   *
   * 起因：兵种预算里「已用」现在 = 已同意申请 + 直接入库的物品总价，
   * 但直接入库那部分**没有采购申请可以跳过去** —— 使用者只看得到一个金额，
   * 不知道这笔钱买了什么。这里弹一份明细：哪些件、多少钱、什么时候、谁录的，
   * 每条的编码可以点进物品详情（接着往下看）。
   *
   * 口径与预算页当前选的时间范围一致 —— 复用 Stats.rangeStart，
   * 绝不各写一套，否则明细加起来的数跟表格里的对不上，反而更糊涂。
   */
  function openDirectItems(opts) {
    var o = opts || {};
    var troop = String(o.troop || '');
    var range = o.range || 'all';
    return DB.getAll('items').then(function (items) {
      var Stats = global.FEVER.Stats;
      var start = Stats.rangeStart(range, DB.nowIso());
      var list = (items || []).filter(function (it) {
        if (!it) return false;
        if (start && String(it.createdAt || '') < start) return false;
        if ((Rules.troopOf(it) || Stats.UNSPECIFIED) !== troop) return false;
        // 没填总价的件不占预算，明细里也不该出现（否则跟表格里的金额对不上）
        return num(it.totalPrice) > 0;
      }).sort(function (a, b) {
        return String(a.createdAt || '') < String(b.createdAt || '') ? 1 : -1;   // 新的在前
      });

      var sum = list.reduce(function (s, it) { return s + num(it.totalPrice); }, 0);
      var rangeName = Stats.RANGE_NAMES[range] || '全部';

      var inner = list.length
        ? UI.table([
            { label: '编码', render: function (it) {
                return '<span class="code-cell" data-goto-item="' + UI.esc(it.code) + '">' +
                  UI.esc(it.code) + '</span>'; } },
            { label: '名称 / 规格', render: function (it) {
                return UI.esc(it.name) +
                  (it.spec ? '<div class="hint">' + UI.esc(it.spec) + '</div>' : ''); } },
            { label: '总价', num: true, render: function (it) {
                return '¥' + num(it.totalPrice).toFixed(2); } },
            { label: '入库时间', render: function (it) { return UI.esc(UI.fmtTime(it.createdAt)); } },
            { label: '添加人', render: function (it) { return UI.esc(it.addedBy || '未记录'); } }
          ], list)
        : '<div class="hint">按当前口径没找到「' + UI.esc(troop) + '」的直接入库记录。</div>';

      UI.openModal({
        title: '直接入库的钱　·　' + troop + '　（' + rangeName + '）',
        wide: true,
        body: '<div class="hint" style="margin-bottom:8px">' +
            '这是「' + UI.esc(troop) + '」直接入库买的东西（新增物品时填了「总价」的那些）' +
            '：共 <b>' + list.length + '</b> 件，合计 <b>¥' + sum.toFixed(2) + '</b>。' +
            '没填总价的件不占预算，所以不在这里。点编码可以进物品详情。</div>' + inner,
        footer: '<button class="btn" data-cancel type="button">关闭</button>',
        onMount: function (mask, close) {
          var cancel = mask.querySelector('[data-cancel]');
          if (cancel) cancel.addEventListener('click', close);
          // 点编码跳物品详情时**先把这份明细关掉**：
          // 全局分发只负责 goto，不关弹框，于是弹框会盖在详情页上面 ——
          // 看起来就像"点了没反应"（同一个坑在本项目踩过不止一次）。
          // 局部监听先于 document 上的分发执行，所以这里关、那边跳，顺序是对的。
          mask.addEventListener('click', function (e) {
            var hit = e.target.closest ? e.target.closest('[data-goto-item]') : null;
            if (hit) close();
          });
        }
      });
    });
  }

  global.FEVER.Forms = {
    openNewItem: openNewItem,
    openNewPurchase: openNewPurchase,
    openArrive: openArrive,
    openArriveWizard: openArriveWizard,
    openSubmitCartDialog: openSubmitCartDialog,
    openUploadInvoice: openUploadInvoice,
    openChangeIdentity: openChangeIdentity,
    approvePurchase: approvePurchase,
    rejectPurchase: rejectPurchase,
    openEditBudgets: openEditBudgets,
    deleteRecord: deleteRecord,
    deleteItem: deleteItem,
    deleteItemsBatch: deleteItemsBatch,
    deletePurchase: deletePurchase,
    deleteInvoice: deleteInvoice,
    deleteTransaction: deleteTransaction,
    deleteTransactionsBatch: deleteTransactionsBatch,
    /** 第二十六轮：看"直接入库"买了哪些东西（预算页里「入库 ¥X」点进来的明细） */
    openDirectItems: openDirectItems,
    openActionDialog: openActionDialog,
    failMessage: failMessage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
