/**
 * M3 的浏览器端到端测试：物品身份、二维码、标签打印、详情页、编辑。
 * 全程通过真实界面操作（点按钮、弹窗里填表），不是调内部函数。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var DB = global.FEVER.DB;
  var App = global.FEVER.App;

  function text(sel) {
    var node = document.querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /** 等弹窗出现并返回它 */
  function modal() {
    return E2E.waitUntil('弹窗打开', function () {
      return document.querySelector('.modal-mask');
    }).then(function () { return document.querySelector('.modal-mask'); });
  }

  function waitModalGone() {
    return E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
  }

  function fillIn(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"]');
    E2E.ok(node, '弹窗里应有字段 ' + name);
    E2E.setInput(node, value);
  }

  /**
   * 给下拉框选值，并**回读确认**（E2E.setSelect 会验选项存在）。
   * 下拉框和输入框不一样：设一个不存在的值，浏览器不报错，只是把 value 静默变成空串，
   * 于是页面认为"没填"，测试却以为填好了，最后只看到一句莫名其妙的"等待超时"。
   * 兵种改成细分之后（第十四周），这种写法就踩到过。
   */
  function pickIn(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"]');
    E2E.ok(node, '弹窗里应有下拉框 ' + name);
    E2E.setSelect(node, value);
  }

  function pickRadio(mask, name, value) {
    var node = mask.querySelector('[name="' + name + '"][value="' + value + '"]');
    E2E.ok(node, '应有选项 ' + name + '=' + value);
    node.checked = true;
  }

  /** 打开"新增物品"弹窗并等字段就绪 */
  function openNewItem() {
    return E2E.waitUntil('有新增入口', function () { return document.querySelector('[data-act="new-inbound"]'); })
      .then(function () {
        E2E.clickSelector('[data-act="new-inbound"]');
        return modal();
      })
      .then(function (mask) {
        return E2E.waitUntil('新增弹窗字段就绪', function () { return mask.querySelector('[name="categoryId"]'); })
          .then(function () { return mask; });
      });
  }

  async function run() {
    // 跨用例传递的临时状态（第二十三轮：编辑用例要用上一条建的物品编码）
    var seedCode = '';
    await E2E.resetDb();
    await global.FEVER.Rules.initCategories();
    await App.refresh();
    await E2E.waitUntil('首页就绪', function () { return document.querySelectorAll('.cat-card').length === 6; });

    await E2E.record('新增物品弹窗按大类给出专属字段', async function () {
      var mask = await openNewItem();
      // 默认机械：应有机械专属字段，不该有视觉字段
      await E2E.waitUntil('机械专属字段出现', function () { return mask.querySelector('[name="x-vehicle"]'); });
      E2E.ok(mask.querySelector('[name="x-material"]'), '机械应有材质字段');
      E2E.ok(mask.querySelector('[name="troop"]'), '直接入库也应有必填的兵种下拉（第十三轮）');
      E2E.ok(!mask.querySelector('[name="x-resolution"]'), '机械不该出现视觉的分辨率字段');

      // 切到视觉：字段应整体换掉
      fillIn(mask, 'categoryId', 'vision');
      await E2E.waitUntil('视觉专属字段出现', function () { return mask.querySelector('[name="x-resolution"]'); });
      E2E.ok(mask.querySelector('[name="x-lensMount"]'), '视觉应有镜头接口字段');
      E2E.ok(!mask.querySelector('[name="x-vehicle"]'), '视觉不该再出现机械的车型字段');

      var mode = mask.querySelector('[name="identityMode"]:checked');
      E2E.ok(mode && mode.value === 'single', '视觉类应默认「每件单独建身份」，实际 ' + (mode && mode.value));
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

    await E2E.record('不选兵种保存会被拦下（第十三轮：直接入库也必须选兵种）', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'mechanical');
      fillIn(mask, 'name', '没选兵种的件');
      fillIn(mask, 'quantity', '1');
      pickRadio(mask, 'identityMode', 'shared');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.waitUntil('出现选兵种的提示', function () {
        return document.getElementById('toast-root') &&
          text('#toast-root').indexOf('兵种') !== -1;
      }, 5000);
      E2E.ok(E2E.topModal() !== null, '弹窗不该关掉 —— 数据没保存，让使用者补上再交');
      var items = await DB.getAll('items');
      E2E.ok(items.length === 0, '没选兵种就不该有物品落库，实际 ' + items.length);
      await E2E.closeAllModals();
    });

    await E2E.record('入库 1 件单独建身份：生成 1 个编码', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'vision');
      await E2E.waitUntil('视觉字段切换完成', function () { return mask.querySelector('[name="x-resolution"]'); });
      pickIn(mask, 'troop', '其他');
      fillIn(mask, 'name', '工业相机');
      fillIn(mask, 'spec', '500万像素');
      fillIn(mask, 'location', '器材柜A');
      fillIn(mask, 'quantity', '1');
      fillIn(mask, 'x-resolution', '500万');
      fillIn(mask, 'x-lensMount', 'CS');
      pickRadio(mask, 'identityMode', 'single');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      E2E.ok(items.length === 1, '应生成 1 条物品，实际 ' + items.length);
      E2E.ok(items[0].code === 'VS-0001', '编码应为 VS-0001，实际 ' + items[0].code);
      E2E.ok(items[0].identityMode === 'single', '应是单独建身份');
      E2E.ok(items[0].totalQty === 1, '单独建身份数量应为 1');
      E2E.ok(items[0].extra.resolution === '500万', '专属字段应保存下来');
    });

    await E2E.record('入库 5 件同款共用：只生成 1 个编码、件数为 5', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'mechanical');
      await E2E.waitUntil('切回机械字段', function () { return mask.querySelector('[name="x-vehicle"]'); });
      // 第十四周：步兵细分为三类，下拉框里不再有旧的「步兵」
      pickIn(mask, 'troop', '轮腿步兵');
      fillIn(mask, 'name', 'M4螺丝');
      fillIn(mask, 'quantity', '5');
      fillIn(mask, 'safetyStock', '20');
      // 总价 / 购买时间（第十四周）：选填，这里填上看能不能存下来
      fillIn(mask, 'totalPrice', '38.60');
      fillIn(mask, 'purchaseDate', '2026-09-01');
      fillIn(mask, 'x-vehicle', '2026主车');
      pickRadio(mask, 'identityMode', 'shared');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      var screws = items.filter(function (i) { return i.name === 'M4螺丝'; });
      E2E.ok(screws.length === 1, '同款共用只应有 1 条身份，实际 ' + screws.length);
      E2E.ok(screws[0].code === 'MC-0001', '机械编码应为 MC-0001，实际 ' + screws[0].code);
      E2E.ok(screws[0].totalQty === 5 && screws[0].inStockQty === 5, '件数应为 5');
      E2E.ok(screws[0].totalPrice === 38.6, '总价应存成数字，实际 ' + screws[0].totalPrice);
      E2E.ok(screws[0].purchaseDate === '2026-09-01', '购买时间应存下来，实际 ' + screws[0].purchaseDate);
      E2E.ok(screws[0].extra.vehicle === '2026主车', '专属字段应保存');
    });

    await E2E.record('批量入库：单独建身份 3 件生成 3 个连续编码', async function () {
      var mask = await openNewItem();
      fillIn(mask, 'categoryId', 'vision');
      await E2E.waitUntil('视觉字段就绪', function () { return mask.querySelector('[name="x-resolution"]'); });
      pickIn(mask, 'troop', '哨兵');
      fillIn(mask, 'name', '镜头');
      fillIn(mask, 'quantity', '3');
      // 总价 / 购买时间故意不填：记不清价格也要能先把东西登进来
      pickRadio(mask, 'identityMode', 'single');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var items = await DB.getAll('items');
      var lenses = items.filter(function (i) { return i.name === '镜头'; }).map(function (i) { return i.code; }).sort();
      E2E.ok(lenses.join(',') === 'VS-0002,VS-0003,VS-0004', '应生成 VS-0002 到 VS-0004，实际 ' + lenses.join(','));
      var lens = await DB.get('items', 'VS-0002');
      E2E.ok(lens.totalPrice === null, '没填总价应是 null，实际 ' + lens.totalPrice);
      E2E.ok(lens.purchaseDate === '', '没填购买时间应是空字符串，实际 ' + lens.purchaseDate);
    });

    await E2E.record('大类页只列出本类物品', async function () {
      App.goto('category', { id: 'vision' });
      // 等"物品清单"表格真正渲染出来，而不是只等页面上出现某个词
      await E2E.waitUntil('视觉页表格出现', function () { return document.querySelector('#cat-table table'); });
      var body = text('#cat-table');
      E2E.ok(body.indexOf('工业相机') !== -1, '视觉页应有工业相机');
      E2E.ok(body.indexOf('镜头') !== -1, '视觉页应有镜头');
      E2E.ok(body.indexOf('M4螺丝') === -1, '视觉页的清单里不该出现机械的螺丝');
    });

    await E2E.record('物品详情页显示二维码，内容为 FEVER:ITEM:编码', async function () {
      App.goto('item', { code: 'VS-0001' });
      await E2E.waitUntil('详情页出现', function () { return text('#view-root').indexOf('工业相机') !== -1; });
      await E2E.waitUntil('二维码渲染出来', function () {
        var img = document.querySelector('#qr-holder img');
        return img && img.getAttribute('src').indexOf('data:image') === 0;
      });
      var payload = document.querySelector('#qr-holder').getAttribute('data-qr');
      E2E.ok(payload === 'FEVER:ITEM:VS-0001', '二维码内容应为 FEVER:ITEM:VS-0001，实际 ' + payload);
      var body = text('#view-root');
      E2E.ok(body.indexOf('单独建身份') !== -1, '详情页应显示身份方式');
      E2E.ok(body.indexOf('500万') !== -1, '详情页应显示视觉专属字段');
      E2E.ok(body.indexOf('CS') !== -1, '详情页应显示镜头接口');
      E2E.ok(body.indexOf('出入库履历') !== -1, '详情页应有履历区块');
      E2E.ok(body.indexOf('入库') !== -1, '履历里应有入库记录');
    });

    await E2E.record('编辑物品：编码不可改，其他字段可改', async function () {
      await E2E.waitUntil('详情页有编辑按钮', function () { return document.querySelector('[data-act="edit-item"]'); });
      E2E.clickSelector('[data-act="edit-item"]');
      var mask = await modal();
      await E2E.waitUntil('编辑弹窗就绪', function () { return mask.querySelector('[name="name"]'); });
      E2E.ok(!mask.querySelector('[name="code"]'), '弹窗里不应有编码输入框（编码不可改）');
      E2E.ok(text('.modal-body').indexOf('VS-0001') !== -1, '应提示当前编码');
      fillIn(mask, 'name', '工业相机(改)');
      fillIn(mask, 'location', '器材柜B');
      fillIn(mask, 'x-resolution', '1200万');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      var item = await DB.get('items', 'VS-0001');
      E2E.ok(item.name === '工业相机(改)', '名称应已更新');
      E2E.ok(item.location === '器材柜B', '位置应已更新');
      E2E.ok(item.extra.resolution === '1200万', '专属字段应已更新');
      E2E.ok(item.code === 'VS-0001', '编码不应改变');
    });

    await E2E.record('标签打印页：单张标签含二维码与文字信息', async function () {
      App.goto('labels', { code: 'VS-0001' });
      await E2E.waitUntil('标签页出现', function () { return document.querySelectorAll('.label-card').length >= 1; });
      var cards = document.querySelectorAll('.label-card');
      E2E.ok(cards.length === 1, '指定编码时只应打印 1 张，实际 ' + cards.length);
      var card = cards[0];
      var stored = await DB.get('items', 'VS-0001');
      E2E.ok(card.textContent.indexOf('VS-0001') !== -1, '标签上应有编码');
      E2E.ok(card.textContent.indexOf('工业相机') !== -1, '标签上应有名称');
      E2E.ok(card.textContent.indexOf('视觉') !== -1, '标签上应有大类');
      E2E.ok(card.textContent.indexOf(stored.location) !== -1,
        '标签上应显示存放位置「' + stored.location + '」，实际标签内容：' + card.textContent.replace(/\s+/g, ' '));
      await E2E.waitUntil('标签上的二维码渲染完成', function () {
        var img = card.querySelector('.label-qr img');
        return img && img.getAttribute('src').indexOf('data:image') === 0;
      });
    });

    await E2E.record('标签打印页：不指定编码时铺开全部物品', async function () {
      App.goto('labels', {});
      await E2E.waitUntil('全部标签出现', function () { return document.querySelectorAll('.label-card').length === 5; });
      var cards = document.querySelectorAll('.label-card');
      E2E.ok(cards.length === 5, '4 个视觉身份 + 1 个机械身份 = 5 张，实际 ' + cards.length);
      var codes = Array.prototype.slice.call(cards).map(function (c) {
        return c.querySelector('.label-code').textContent.trim();
      }).sort();
      E2E.ok(codes.join(',') === 'MC-0001,VS-0001,VS-0002,VS-0003,VS-0004', '标签编码应齐全，实际 ' + codes.join(','));
    });

    await E2E.record('标签页有打印按钮和打印提示', async function () {
      E2E.ok(document.querySelector('[data-act="do-print"]'), '应有打印按钮');
      E2E.ok(text('.page-head').indexOf('Ctrl+P') !== -1, '应提示用 Ctrl+P 打印');
    });

    await E2E.record('大类页搜索与筛选可用', async function () {
      App.goto('category', { id: 'vision' });
      await E2E.waitUntil('视觉页出现', function () { return document.querySelector('[name="f-keyword"]'); });
      E2E.setInput(document.querySelector('[name="f-keyword"]'), '镜头');
      await E2E.waitUntil('筛选后只剩镜头', function () {
        var body = text('#cat-table');
        return body.indexOf('镜头') !== -1 && body.indexOf('工业相机') === -1;
      });
      E2E.setInput(document.querySelector('[name="f-keyword"]'), '');
      await E2E.waitUntil('恢复全部', function () { return text('#cat-table').indexOf('工业相机') !== -1; });
    });

    await E2E.record('身份后期可改：同款共用 → 单独使用（拆成一件一码，已贴标签仍有效）', async function () {
      // MC-0001 是上面「入库 5 件同款共用」造的那一款，5 件共用一个码
      App.goto('item', { code: 'MC-0001' });
      await E2E.waitUntil('物品详情就绪', function () { return document.querySelector('[data-change-identity]'); });
      var btn = document.querySelector('[data-change-identity]');
      E2E.ok(btn.textContent.indexOf('单独') !== -1, '共用身份上应给出「改成单独使用」，实际：' + btn.textContent);
      E2E.click(btn);

      var mask = await modal();
      await E2E.waitUntil('确认框就绪', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.ok(mask.textContent.indexOf('不用重贴') !== -1, '要说明已经贴出去的标签继续有效');
      E2E.clickSelector('[data-act="yes"]', mask);
      await waitModalGone();

      await E2E.waitUntilAsync('拆成了 5 个身份', async function () {
        var all = await DB.getAll('items');
        return all.filter(function (i) { return i.name === 'M4螺丝'; }).length === 5;
      });
      var screws = (await DB.getAll('items')).filter(function (i) { return i.name === 'M4螺丝'; });
      E2E.ok(screws.every(function (i) { return i.identityMode === 'single' && i.totalQty === 1; }),
        '每个身份都应是单独使用且各 1 件');
      E2E.ok(screws.reduce(function (s, i) { return s + i.totalQty; }, 0) === 5, '总件数必须守恒');
      E2E.ok(screws.some(function (i) { return i.code === 'MC-0001'; }), '原编码 MC-0001 应保留下来');
    });

    await E2E.record('身份后期可改：单独使用 → 同款共用（合并，并写清作废哪些标签）', async function () {
      App.goto('item', { code: 'MC-0001' });
      await E2E.waitUntil('物品详情就绪', function () { return document.querySelector('[data-change-identity]'); });
      var btn = document.querySelector('[data-change-identity]');
      E2E.ok(btn.textContent.indexOf('共用') !== -1, '单独身份上应给出「改成同款共用」，实际：' + btn.textContent);
      E2E.click(btn);

      var mask = await modal();
      await E2E.waitUntil('合并弹窗就绪', function () { return mask.querySelector('input[name="merge-pick"]'); });
      E2E.ok(mask.textContent.indexOf('作废') !== -1, '必须先把「会作废标签」说清楚');
      var boxes = mask.querySelectorAll('input[name="merge-pick"]');
      E2E.ok(boxes.length === 5, '应列出 5 个同款身份（含自己），实际 ' + boxes.length);
      var next = mask.querySelector('[data-ok]');
      E2E.ok(next.textContent.indexOf('作废') !== -1, '按钮上要带后果，实际：' + next.textContent);
      E2E.click(next);

      var confirmMask = await modal();
      await E2E.waitUntil('二次确认就绪', function () { return confirmMask.querySelector('[data-act="yes"]'); });
      E2E.ok(confirmMask.textContent.indexOf('重贴') !== -1, '确认框要写明需要撕下来重贴');
      E2E.clickSelector('[data-act="yes"]', confirmMask);
      await E2E.waitUntil('弹窗全部关闭', function () { return !document.querySelector('.modal-mask'); });

      await E2E.waitUntilAsync('合成一个身份', async function () {
        var all = await DB.getAll('items');
        return all.filter(function (i) { return i.name === 'M4螺丝'; }).length === 1;
      });
      var merged = (await DB.getAll('items')).filter(function (i) { return i.name === 'M4螺丝'; })[0];
      E2E.ok(merged.identityMode === 'shared', '应变成同款共用');
      E2E.ok(merged.totalQty === 5 && merged.inStockQty === 5, '件数应合回 5，实际 ' + merged.totalQty);
      E2E.ok(merged.code === 'MC-0001', '默认保留编码最小的那个，实际 ' + merged.code);

      var log = await global.FEVER.Rules.getDeleteLog();
      E2E.ok(log.some(function (e) {
        return e.store === 'items' && e.reason && e.reason.indexOf('MC-0001') !== -1;
      }), '合并时删掉的身份要记进「删除记录」');
    });

    await E2E.record('标签打印可以挑选打哪几张：默认全选、可搜关键字、全不选时禁用', async function () {
      var all = await DB.getAll('items');
      App.goto('labels', {});
      await E2E.waitUntil('标签页就绪', function () { return document.querySelector('[data-act="pick-labels"]'); });
      await E2E.waitUntil('标签全部渲染', function () {
        return document.querySelectorAll('.label-card').length === all.length;
      });

      function count(mask) {
        var c = mask.querySelector('#label-pick-count');
        return c ? c.textContent : '';
      }

      E2E.clickSelector('[data-act="pick-labels"]');
      var mask = await modal();
      await E2E.waitUntil('挑选列表就绪', function () { return mask.querySelector('input[name="label-pick"]'); });
      E2E.ok(count(mask).indexOf('已选 ' + all.length + ' / 共 ' + all.length) !== -1,
        '打开时应沿用当前的选中（这里是全部），实际：' + count(mask));

      // 全不选：计数归零、确认按钮禁用
      E2E.clickSelector('[data-l-check="none"]', mask);
      E2E.ok(count(mask).indexOf('已选 0') !== -1, '全不选后应为 0，实际：' + count(mask));
      E2E.ok(mask.querySelector('[data-ok]').disabled === true, '一张都没选时确认按钮应禁用');

      // 按关键字筛，再全选 —— 只应勾上筛出来的那批
      E2E.setInput(mask.querySelector('[name="l-keyword"]'), '镜头');
      await E2E.waitUntil('筛选生效', function () {
        var n = mask.querySelectorAll('input[name="label-pick"]').length;
        return n > 0 && n < all.length;
      });
      var lensRows = mask.querySelectorAll('input[name="label-pick"]').length;
      E2E.clickSelector('[data-l-check="all"]', mask);
      E2E.ok(count(mask).indexOf('已选 ' + lensRows + ' /') !== -1,
        '筛选后的全选只作用于筛出来的这批，实际：' + count(mask));

      E2E.clickSelector('[data-ok]', mask);
      await E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
      await E2E.waitUntil('标签页只剩筛出来的那几张', function () {
        var cards = document.querySelectorAll('.label-card');
        return cards.length === lensRows &&
          Array.prototype.every.call(cards, function (c) {
            return c.querySelector('.label-name').textContent.trim() === '镜头';
          });
      });
      E2E.ok(text('.page-head').indexOf('共 ' + lensRows + ' 张标签') !== -1,
        '页头上的张数要跟着更新，实际：' + text('.page-head').slice(0, 80));
      E2E.ok(document.querySelectorAll('.label-qr img').length === lensRows, '剩下的每张都要有二维码');

      // 再打开一次：默认沿用刚才的选中（不是全选），改完能恢复全部
      E2E.clickSelector('[data-act="pick-labels"]');
      mask = await modal();
      await E2E.waitUntil('挑选列表就绪', function () { return mask.querySelector('input[name="label-pick"]'); });
      E2E.ok(count(mask).indexOf('已选 ' + lensRows + ' /') !== -1, '再次打开应沿用上次的选择');
      E2E.setInput(mask.querySelector('[name="l-keyword"]'), '');
      E2E.clickSelector('[data-l-check="all"]', mask);
      E2E.clickSelector('[data-ok]', mask);
      await E2E.waitUntil('恢复成全部标签', function () {
        return document.querySelectorAll('.label-card').length === all.length;
      });
    });

    await E2E.record('顶栏搜索：搜到物品进物品详情、搜到大类进大类页', async function () {
      App.goto('home');
      await E2E.waitUntil('顶栏有搜索入口', function () { return document.querySelector('[data-act="open-search"]'); });
      E2E.clickSelector('[data-act="open-search"]');
      var mask = await modal();
      await E2E.waitUntil('搜索框就绪', function () { return mask.querySelector('#search-input'); });
      E2E.ok(mask.textContent.indexOf('输入关键词') !== -1, '空关键词时该给一句引导，而不是空白');

      E2E.setInput(mask.querySelector('#search-input'), '工业相机');
      await E2E.waitUntil('搜到那件物品', function () { return mask.querySelector('[data-search-item="VS-0001"]'); });
      E2E.clickSelector('[data-search-item="VS-0001"]', mask);
      await E2E.waitUntil('落到物品详情', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item';
      });
      E2E.ok(text('#view-root').indexOf('VS-0001') !== -1, '打开的应该是搜到的那一件');

      // 搜大类：结果里给大类按钮，点进去是该大类的清单
      E2E.clickSelector('[data-act="open-search"]');
      mask = await modal();
      await E2E.waitUntil('搜索框就绪', function () { return mask.querySelector('#search-input'); });
      E2E.setInput(mask.querySelector('#search-input'), '视觉');
      await E2E.waitUntil('搜到大类', function () { return mask.querySelector('[data-search-cat="vision"]'); });
      E2E.clickSelector('[data-search-cat="vision"]', mask);
      await E2E.waitUntil('落到大类页', function () {
        var root = document.querySelector('#view-root');
        return root.getAttribute('data-page') === 'category' && text('#cat-table').indexOf('工业相机') !== -1;
      });

      // 搜不到时要说人话，而不是一片空白
      E2E.clickSelector('[data-act="open-search"]');
      mask = await modal();
      await E2E.waitUntil('搜索框就绪', function () { return mask.querySelector('#search-input'); });
      E2E.setInput(mask.querySelector('#search-input'), '这个词肯定搜不到xyz');
      await E2E.waitUntil('给出"没找到"', function () { return mask.textContent.indexOf('没找到') !== -1; });
      E2E.clickSelector('.modal-close', mask);
    });

    await E2E.record('导出标签图片：手机上打不开打印窗口时的出路（第十八轮）', async function () {
      App.goto('labels', {});
      await E2E.waitUntil('标签页就绪', function () { return document.querySelector('[data-act="save-labels"]'); });
      E2E.ok(document.querySelector('[data-act="do-print"]'), '仍要保留直接打印');
      E2E.clickSelector('[data-act="save-labels"]');
      var mask = await modal();
      await E2E.waitUntil('图片生成出来', function () {
        var img = mask.querySelector('img[alt="标签图"]');
        return !!img && img.src.indexOf('data:image/png') === 0 && img.src.length > 2000;
      }, 20000);
      var src = mask.querySelector('img[alt="标签图"]').src;
      E2E.ok(src.indexOf('data:image/png;base64,') === 0, '应是本地画出来的 PNG（不联网）');
      E2E.ok(src.length > 2000, '图片内容不该是空的，实际长度 ' + src.length);
      E2E.ok(mask.textContent.indexOf('长按') !== -1,
        '要告诉手机用户怎么保存，实际：' + mask.textContent.slice(0, 80));
      E2E.ok(!!mask.querySelector('[data-save]'), '电脑端还要有「下载图片」按钮');
      E2E.ok(mask.textContent.indexOf('Ctrl+P') !== -1,
        '电脑端要给出"打开图片再打印"的路子（飞书客户端里 window.print 是空操作）');

      // 下载必须走 Blob URL：标签多时 PNG 几 MB，Chrome 对超大的 data URL 下载会**静默失败**
      var realCreate = global.URL.createObjectURL;
      var realAnchorClick = global.HTMLAnchorElement.prototype.click;
      var created = null;
      var clicked = 0;
      global.URL.createObjectURL = function (blob) { created = blob; return 'blob:fake'; };
      global.HTMLAnchorElement.prototype.click = function () { clicked += 1; };
      try {
        E2E.clickSelector('[data-save]', mask);
        await E2E.waitUntil('下载被触发', function () { return created || clicked > 0; }, 10000);
      } finally {
        global.URL.createObjectURL = realCreate;
        global.HTMLAnchorElement.prototype.click = realAnchorClick;
      }
      E2E.ok(!!created, '应走 Blob URL 下载（data URL 太大时 Chrome 会静默失败，点下载没反应）');
      E2E.ok(created && created.type === 'image/png', 'Blob 应是 PNG，实际 ' + (created && created.type));
      E2E.ok(clicked > 0, '应真的触发了下载点击');

      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

await E2E.record('第一次打印：静默，不弹窗也不提示（第二十轮）', async function () {
      var Ops = global.FEVER.Ops;
      var code = 'MC-0001';
      var item = await DB.get('items', code);
      E2E.ok(item, '要有 MC-0001 可试');
      // ⚠️ 状态必须在**进页面前**摆好：标签页判断"打过没有"用的是它加载时那份数据，
      // 页面加载后再改数据层，它并不知道（栽过）。
      await DB.put('items', Object.assign({}, item, { printCount: 0, lastPrintedAt: '' }));

      // ⚠️ 先跳去别的页再进：上一个用例可能就停在同一条路由上，App.goto 会**原地重渲染**，
      // 等待条件会在旧页面上立刻为真，点击就落在旧闭包上（拿的是旧数据）。栽过两次。
      App.goto('home');
      await E2E.waitUntil('先离开标签页', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'home';
      });
      App.goto('labels', { code: code });
      await E2E.waitUntil('切到这一件的标签页', function () {
        return /共 1 张/.test(text('#label-summary')) &&
          document.querySelectorAll('#label-sheet .label-card').length === 1;
      });
      // 前面用例留下的旧提示会污染断言，先清掉（栽过）
      document.querySelector('#toast-root').innerHTML = '';
      E2E.clickSelector('[data-act="do-print"]');
      await E2E.wait(300);
      var mask = document.querySelector('.modal-mask');
      E2E.ok(!mask || mask.textContent.indexOf('已经打印过') === -1,
        '第一次打印不该问"是否再次打印"，实际弹了：' +
        (mask ? mask.textContent.replace(/\s+/g, ' ').slice(0, 80) : '无'));
      E2E.ok(text('#toast-root').trim() === '',
        '第一次打印不该弹提示，实际：' + text('#toast-root').slice(0, 60));
    });

    await E2E.record('已经打印过的，再打印会问一句「是否再次打印」', async function () {
      var Ops = global.FEVER.Ops;
      var code = 'MC-0001';
      var item = await DB.get('items', code);
      await DB.put('items', Object.assign({}, item, { printCount: 1, lastPrintedAt: '2026-10-06T09:00:00.000Z' }));

      // ⚠️ 先跳去别的页再进：上一个用例可能就停在同一条路由上，App.goto 会**原地重渲染**，
      // 等待条件会在旧页面上立刻为真，点击就落在旧闭包上（拿的是旧数据）。栽过两次。
      App.goto('home');
      await E2E.waitUntil('先离开标签页', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'home';
      });
      App.goto('labels', { code: code });
      await E2E.waitUntil('切到这一件的标签页', function () {
        return /共 1 张/.test(text('#label-summary')) &&
          document.querySelectorAll('#label-sheet .label-card').length === 1;
      });
      E2E.clickSelector('[data-act="do-print"]');
      var mask = await modal();
      await E2E.waitUntil('重复打印的询问', function () { return mask.querySelector('[data-act="yes"]'); });
      var txt = mask.textContent.replace(/\s+/g, ' ');
      E2E.ok(txt.indexOf('已经打印过') !== -1, '应问一句"已经打印过了"，实际：' + txt.slice(0, 80));
      E2E.ok(/1\s*\/\s*1\s*件/.test(txt), '要说清这批里有几件打过，实际：' + txt.slice(0, 80));
      E2E.clickSelector('[data-act="no"]', mask);
      await E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
      E2E.ok(Number((await DB.get('items', code)).printCount) === 1, '点了取消就不该再记一次打印');
    });

    await E2E.record('打印次数显示在物品详情与清单里，没有"确认已贴好"那一套', async function () {
      var Ops = global.FEVER.Ops;
      var code = 'MC-0001';
      var item = await DB.get('items', code);
      await Ops.markPrinted({ codes: [code], at: '2026-10-06T07:00:00.000Z' });
      await Ops.markPrinted({ codes: [code], at: '2026-10-06T08:00:00.000Z' });
      var want = Number((await DB.get('items', code)).printCount);

      App.goto('item', { code: code });
      await E2E.waitUntil('详情页出现打印记录', function () { return /标签已打印/.test(text('#view-root')); });
      var detailText = text('#view-root');
      E2E.ok(new RegExp('已打印\\s*' + want + '\\s*次').test(detailText),
        '详情页要显示打印次数 ' + want + '，实际：' + detailText.slice(0, 160));
      E2E.ok(detailText.indexOf('确认已贴好') === -1 && detailText.indexOf('待确认') === -1,
        '不该再有"待确认 / 确认已贴好"，实际：' + detailText.slice(0, 160));
      E2E.ok(!document.querySelector('[data-confirm-printed]'), '界面上不该再有确认按钮');

      App.goto('category', { id: item.categoryId });
      await E2E.waitUntil('清单渲染出来', function () { return document.querySelector('#cat-table'); });
      await E2E.waitUntil('状态列出现打印次数', function () {
        return text('#cat-table').indexOf('标签已打印 ' + want + ' 次') !== -1;
      });
      E2E.ok(text('#cat-table').indexOf('标签已打印 ' + want + ' 次') !== -1, '清单里应能看到打印次数');
    });
await E2E.record('新增物品要填添加人，并记到物品上（第二十三轮）', async function () {
      var cat = 'mechanical';
      App.goto('category', { id: cat });
      await E2E.waitUntil('分类页就绪', function () { return document.querySelector('[data-act="new-item"]'); });
      E2E.clickSelector('[data-act="new-item"]');
      var mask = await modal();
      await E2E.waitUntil('表单里出现添加人', function () { return mask.querySelector('[name="operator"]'); });

      // 默认值要自动带出（不是空框），但不管它具体是什么
      var opInput = mask.querySelector('[name="operator"]');
      E2E.ok(String(opInput.value || '').trim() !== '', '添加人应默认带出当前身份，不该是空框');

      // 什么都不填直接提交，应被拦住（兵种、名称、添加人都没填）
      E2E.clickSelector('[data-ok]', mask);
      E2E.ok(!!document.querySelector('.modal-mask'), '缺必填项时不该关掉弹窗');

      // 老老实实填一遍
      E2E.setSelect(mask.querySelector('[name="troop"]'), '舵轮机器人');
      E2E.setInput(mask.querySelector('[name="name"]'), '添加人测试件');
      E2E.setInput(mask.querySelector('[name="quantity"]'), '2');
      E2E.setInput(mask.querySelector('[name="operator"]'), '测试添加人');
      E2E.setInput(mask.querySelector('[name="totalPrice"]'), '12.34');
      E2E.setInput(mask.querySelector('[name="purchaseDate"]'), '2026-10-01');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();

      await E2E.waitUntilAsync('物品建好了', async function () {
        var items = await DB.getAll('items');
        return items.filter(function (i) { return i.name === '添加人测试件'; }).length >= 1;
      });
      var items = await DB.getAll('items');
      var item = items.filter(function (i) { return i.name === '添加人测试件'; })[0];
      E2E.ok(!!item, '应有这件物品');
      E2E.ok(item.addedBy === '测试添加人',
        '物品行上要记下添加人，实际：' + item.addedBy);

      // 详情页要能看到
      App.goto('item', { code: item.code });
      // ⚠️ 等 data-page 而不是等文字：这件物品的名字就叫「添加人测试件」，
      // 光等出现添加人会在分类页的旧列表上立刻成立（栽过）
      await E2E.waitUntil('真的切到详情页', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item';
      });
      await E2E.waitUntil('详情里出现添加人', function () { return text('#view-root').indexOf('添加人') !== -1; });
      var detail = text('#view-root');
      var seg = detail.slice(Math.max(0, detail.indexOf('添加人') - 20), detail.indexOf('添加人') + 40);
      E2E.ok(detail.indexOf('测试添加人') !== -1, '详情页要显示添加人姓名｜片段=' + seg.replace(/\s+/g,' '));
      seedCode = item.code;   // 留给下一条用例改价格
    });

    await E2E.record('入库后编辑：能改价格、购买时间、位置（第二十三轮）', async function () {
      var code = seedCode;
      E2E.ok(code, '上一条用例应该留下了一件物品');
      App.goto('item', { code: code });
      await E2E.waitUntil('真的切到详情页', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item';
      });
      await E2E.waitUntil('详情页就绪', function () { return document.querySelector('[data-act="edit-item"]'); });
      E2E.clickSelector('[data-act="edit-item"]');
      var mask = await modal();
      await E2E.waitUntil('编辑表单就绪', function () { return mask.querySelector('[name="totalPrice"]'); });

      // 这三样原来的编辑弹窗给不了（价格、购买时间），位置本来就能改
      E2E.ok(!!mask.querySelector('[name="purchaseDate"]'), '编辑弹窗要能改购买时间');
      E2E.ok(!!mask.querySelector('[name="location"]'), '位置早就能改，别被改坏了');
      E2E.ok(mask.textContent.indexOf('所属大类也不能改') !== -1,
        '要说清为什么大类改不了（编码前缀由大类决定），实际：' + mask.textContent.slice(0, 120));

      // 负数价格要被拦住
      E2E.setInput(mask.querySelector('[name="totalPrice"]'), '-5');
      E2E.clickSelector('[data-ok]', mask);
      await E2E.wait(150);
      E2E.ok(!!document.querySelector('.modal-mask'), '非法金额不该把弹窗关掉');
      E2E.ok(Number((await DB.get('items', code)).totalPrice) === 12.34,
        '被拦住时不该改掉原来的价格');

      // 正常改一遍
      E2E.setInput(mask.querySelector('[name="totalPrice"]'), '99.90');
      E2E.setInput(mask.querySelector('[name="purchaseDate"]'), '2026-09-15');
      E2E.setInput(mask.querySelector('[name="location"]'), 'B区2号柜');
      E2E.clickSelector('[data-ok]', mask);
      await waitModalGone();
      await E2E.waitUntilAsync('改动落库', async function () {
        var it = await DB.get('items', code);
        return Number(it.totalPrice) === 99.9;
      });
      var after = await DB.get('items', code);
      E2E.ok(Number(after.totalPrice) === 99.9, '总价应改成 99.9，实际 ' + after.totalPrice);
      E2E.ok(after.purchaseDate === '2026-09-15', '购买时间应改成 2026-09-15');
      E2E.ok(after.location === 'B区2号柜', '位置应改成 B区2号柜');
      E2E.ok(after.addedBy === '测试添加人', '编辑不该把添加人弄丢');

      await E2E.waitUntil('详情页显示新价格', function () {
        return text('#view-root').indexOf('99.90') !== -1;
      });
    });
await E2E.record('同名物品自动带出大类，且不丢已填内容（第二十四轮）', async function () {
      var anchor = (await DB.getAll('items')).filter(function (i) { return i.categoryId === 'mechanical'; })[0];
      E2E.ok(anchor, '要有件机械类的物品当锚点');

      // ⚠️ 先跳走再进：同路由 goto 是原地重渲染，等待条件会在旧页面上立刻为真
      App.goto('home');
      await E2E.waitUntil('先离开', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'home';
      });
      // 故意从「硬件」进去，好看出大类确实被自动切走
      App.goto('category', { id: 'hardware' });
      await E2E.waitUntil('硬件页就绪', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'category' &&
          document.querySelector('[data-act="new-item"]');
      });
      E2E.clickSelector('[data-act="new-item"]');
      var mask = await modal();
      await E2E.waitUntil('表单就绪', function () { return mask.querySelector('[name="name"]'); });
      E2E.ok(mask.querySelector('[name="categoryId"]').value === 'hardware', '初始大类应是进页时那个');

      // 先填两样别的，用来验证切大类时不会丢
      E2E.setInput(mask.querySelector('[name="spec"]'), 'M4x16');
      E2E.setInput(mask.querySelector('[name="location"]'), 'C区1号柜');

      // 输入与锚点同名的名称 → 大类自动切到它所在的大类
      E2E.setInput(mask.querySelector('[name="name"]'), anchor.name);
      await E2E.waitUntil('大类自动切过去', function () {
        return mask.querySelector('[name="categoryId"]').value === 'mechanical';
      }, 8000);
      E2E.ok(mask.querySelector('[name="spec"]').value === 'M4x16', '切大类不该把规格清掉');
      E2E.ok(mask.querySelector('[name="location"]').value === 'C区1号柜', '切大类不该把位置清掉');

      // 使用者自己改过大类之后，再动名称就不该再被自动切走
      E2E.setSelect(mask.querySelector('[name="categoryId"]'), 'hardware');
      E2E.setInput(mask.querySelector('[name="name"]'), anchor.name + '改一下');
      await E2E.wait(400);
      E2E.setInput(mask.querySelector('[name="name"]'), anchor.name);
      await E2E.wait(600);
      E2E.ok(mask.querySelector('[name="categoryId"]').value === 'hardware',
        '自己选过大类之后，不该再被自动改走（别跟人抢方向盘）');
      E2E.ok(mask.textContent.indexOf('已有同名物品') !== -1, '但同名提示仍然要给');

      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });

    await E2E.record('编辑物品改名撞名只提示、不动大类（大类本来就改不了）', async function () {
      var anchor = (await DB.getAll('items')).filter(function (i) { return i.categoryId === 'mechanical'; })[0];
      var other = (await DB.getAll('items')).filter(function (i) { return i.code !== anchor.code; })[0];
      E2E.ok(other, '要有第二件物品可试');

      App.goto('home');
      await E2E.waitUntil('先离开', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'home';
      });
      App.goto('item', { code: other.code });
      await E2E.waitUntil('真的切到详情页', function () {
        return document.querySelector('#view-root').getAttribute('data-page') === 'item';
      });
      E2E.clickSelector('[data-act="edit-item"]');
      var mask = await modal();
      await E2E.waitUntil('编辑表单就绪', function () { return mask.querySelector('[name="name"]'); });

      // 原样不改：不该冒出任何提示（得排除自己）
      E2E.setInput(mask.querySelector('[name="name"]'), other.name);
      await E2E.wait(500);
      E2E.ok(mask.querySelector('#ei-same-name').innerHTML === '',
        '名字没改，不该冒同名提示，实际：' + mask.querySelector('#ei-same-name').textContent.slice(0, 80));

      // 改成锚点的名字 → 提示（且大类字段压根不存在，改不了）
      E2E.setInput(mask.querySelector('[name="name"]'), anchor.name);
      await E2E.waitUntil('出现同名提示', function () {
        return mask.querySelector('#ei-same-name').textContent.indexOf('已有同名物品') !== -1;
      }, 8000);
      E2E.ok(!mask.querySelector('[name="categoryId"]'), '编辑弹窗里没有大类字段（本来就改不了）');
      E2E.clickSelector('.modal-close', mask);
      await waitModalGone();
    });
    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
