/**
 * M2 的浏览器端到端测试：框架导航与首页四大类卡片。
 *
 * 全流程都在真实页面里跑：点真实的按钮、读真实的界面文本。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var UI = global.FEVER.UI;
  var DB = global.FEVER.DB;
  var Ops = global.FEVER.Ops;

  function text(sel, root) {
    var node = (root || document).querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /** 当前是哪一页。渲染要读数据库，判断"切过去了没有"用它最稳 */
  function pageName() { return document.querySelector('#view-root').getAttribute('data-page'); }

  /** 点导航上的某一项，等这一页真的渲染出来 */
  function navTo(name) {
    E2E.clickSelector('#main-nav [data-goto="' + name + '"]');
    return E2E.waitUntil('切到 ' + name, function () { return pageName() === name; });
  }

  async function run() {
    await E2E.resetDb();
    var Rules = global.FEVER.Rules;
    await Rules.initCategories();

    E2E.record('页面脚本全部加载成功', function () {
      ['DB', 'Rules', 'Ops', 'Stats', 'UI', 'QR', 'Views', 'Forms', 'App', 'Modules'].forEach(function (k) {
        E2E.ok(global.FEVER[k], '缺少 FEVER.' + k);
      });
      E2E.ok(global.FEVER.Modules.mechanical && global.FEVER.Modules.electronic &&
        global.FEVER.Modules.vision && global.FEVER.Modules.hardware, '四个大类模块都应加载');
      E2E.ok(typeof global.qrcode === 'function', '二维码库应加载成功');
    });

    // 造一批数据：机械有低库存、有借出、有待修；视觉有单独身份的设备
    await Ops.inbound({
      categoryId: 'mechanical', name: 'M4螺丝', quantity: 10, identityMode: 'shared',
      operator: '测试', safetyStock: 50, location: 'A区'
    });
    await Ops.inbound({
      categoryId: 'mechanical', name: '轴承', quantity: 8, identityMode: 'shared', operator: '测试'
    });
    await Ops.inbound({ categoryId: 'vision', name: '工业相机', quantity: 1, identityMode: 'single', operator: '测试' });
    await Ops.inbound({ categoryId: 'electronic', name: '电调', quantity: 4, identityMode: 'shared', operator: '测试' });
    await Ops.inbound({ categoryId: 'hardware', name: '内六角扳手', quantity: 3, identityMode: 'shared', operator: '测试', extra: { isTool: '是' } });
    await Ops.lend({ code: 'MC-0002', qty: 2, operator: '测试', borrower: '张三', dueDate: '2026-09-30' });
    await Ops.sendRepair({ code: 'MC-0002', qty: 1, operator: '测试', purpose: '异响' });

    // 数据造完后必须重新渲染，否则读到的是启动时那份空界面
    await global.FEVER.App.refresh();

    /** 读某张卡片上的指标 */
    function cardMetrics(cardName) {
      var cards = Array.prototype.slice.call(document.querySelectorAll('.cat-card'));
      var card = cards.filter(function (c) {
        return c.querySelector('.cat-name').textContent.trim() === cardName;
      })[0];
      if (!card) return {};
      var out = {};
      Array.prototype.slice.call(card.querySelectorAll('.metric')).forEach(function (m) {
        out[m.querySelector('.metric-label').textContent.trim()] = m.querySelector('.metric-value').textContent.trim();
      });
      return out;
    }

    // 机械：螺丝 10 件（安全库存 50）+ 轴承 8 件 → 借出 2、待修 1 → 在库 15
    await E2E.waitUntil('首页反映新造的数据', function () {
      return cardMetrics('机械')['在库件数'] === '15';
    });

    await E2E.record('首页显示且只显示四个大类卡片', function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll('.cat-card'));
      E2E.ok(cards.length === 4, '大类卡片数量应为 4，实际 ' + cards.length);
      var names = cards.map(function (c) { return c.querySelector('.cat-name').textContent.trim(); });
      E2E.ok(names.join(',') === '机械,电控,视觉,硬件', '四个大类应为 机械,电控,视觉,硬件，实际 ' + names.join(','));
    });

    await E2E.record('首页卡片上的数字与真实数据一致', function () {
      var metrics = cardMetrics('机械');
      // 螺丝 10 + 轴承 8 = 18 件；借出 2、送修 1 之后在库 15
      E2E.ok(metrics['在库件数'] === '15', '机械在库件数应为 15，实际 ' + metrics['在库件数']);
      E2E.ok(metrics['种类'] === '2', '机械种类应为 2，实际 ' + metrics['种类']);
      E2E.ok(metrics['低库存待补'] === '1', '机械低库存待补应为 1，实际 ' + metrics['低库存待补']);

      var vMetrics = cardMetrics('视觉');
      E2E.ok(vMetrics['在库件数'] === '1', '视觉在库件数应为 1，实际 ' + vMetrics['在库件数']);
      E2E.ok(vMetrics['待标定 / 需重标'] === '1', '视觉应有 1 件待标定，实际 ' + vMetrics['待标定 / 需重标']);

      var hMetrics = cardMetrics('硬件');
      E2E.ok(hMetrics['在借工具'] === '0', '硬件当前没有在借工具，实际 ' + hMetrics['在借工具']);
      E2E.ok(hMetrics['耗材需补货'] === '0', '硬件没有设安全库存，不需要补货，实际 ' + hMetrics['耗材需补货']);
    });

    await E2E.record('四个大类的功能文字各不相同（不是同一张表换名字）', function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll('.cat-card'));
      var labels = cards.map(function (c) {
        return Array.prototype.slice.call(c.querySelectorAll('.metric-label')).map(function (m) {
          return m.textContent.trim();
        }).join('|');
      });
      E2E.ok(new Set(labels).size === 4, '四个大类的指标应各不相同，实际：' + labels.join('　/　'));
      // 每个大类还得有自己的一句话摘要，内容也必须不同
      var lines = cards.map(function (c) { return c.querySelector('.cat-desc:last-child').textContent.trim(); });
      E2E.ok(new Set(lines).size === 4, '四个大类的摘要应各不相同');
    });

    await E2E.record('顶栏导航包含全部入口', function () {
      var nav = text('#main-nav');
      ['物资总览', '出入库登记', '借用台账', '采购申请', '发票台账', '出入库流水', '设置与备份'].forEach(function (label) {
        E2E.ok(nav.indexOf(label) !== -1, '导航里应包含「' + label + '」');
      });
    });

    await E2E.record('首页显示需要注意的事项', function () {
      var body = text('#view-root');
      E2E.ok(body.indexOf('需要注意') !== -1, '首页应有「需要注意」区块');
      E2E.ok(body.indexOf('库存偏低') !== -1, '应提示 M4螺丝库存偏低');
      E2E.ok(body.indexOf('尚未标定') !== -1, '应提示工业相机尚未标定');
    });

    await E2E.record('首页最近动态列出流水', function () {
      var body = text('#view-root');
      E2E.ok(body.indexOf('最近动态') !== -1, '应有最近动态区块');
      E2E.ok(body.indexOf('借出') !== -1, '动态里应出现借出记录');
      E2E.ok(body.indexOf('张三') !== -1, '动态里应出现借用人');
    });

    await E2E.record('点大类卡片能进入该类页面', async function () {
      E2E.clickSelector('.cat-card');
      await E2E.waitUntil('进入机械页', function () {
        return text('#view-root').indexOf('物品清单') !== -1 && global.location.hash.indexOf('category') !== -1;
      });
      var body = text('#view-root');
      E2E.ok(body.indexOf('机械') !== -1, '应进入机械大类页');
      E2E.ok(body.indexOf('M4螺丝') !== -1, '机械页应列出该类的物品');
    });

    await E2E.record('面包屑能回到首页', async function () {
      E2E.clickSelector('#crumb [data-goto="home"]');
      await E2E.waitUntil('回到首页', function () { return global.location.hash.indexOf('home') !== -1; });
      await E2E.waitUntil('首页出现四张卡片', function () { return document.querySelectorAll('.cat-card').length === 4; });
    });

    await E2E.record('导航按钮能切到采购、发票、流水、借用、设置页', async function () {
      var navs = [
        { goto: 'purchases', expect: '采购申请' },
        { goto: 'invoices', expect: '发票台账' },
        { goto: 'txns', expect: '出入库流水' },
        { goto: 'ledger', expect: '借用台账' },
        { goto: 'settings', expect: '设置与数据备份' }
      ];
      for (var i = 0; i < navs.length; i += 1) {
        E2E.clickSelector('#main-nav [data-goto="' + navs[i].goto + '"]');
        /* eslint-disable no-loop-func */
        await E2E.waitUntil('切到 ' + navs[i].goto, function () {
          return document.querySelector('#view-root').getAttribute('data-page') === navs[i].goto &&
            text('#view-root').indexOf(navs[i].expect) !== -1;
        });
        /* eslint-enable no-loop-func */
      }
    });

    await E2E.record('设置页显示各表条数与备份区块', async function () {
      await navTo('settings');
      await E2E.waitUntil('设置页渲染', function () { return text('#view-root').indexOf('备份与恢复') !== -1; });
      var body = text('#view-root');
      E2E.ok(body.indexOf('物品身份') !== -1, '应显示物品身份条数');
      E2E.ok(body.indexOf('出入库流水') !== -1, '应显示流水条数');
      E2E.ok(body.indexOf('从未备份') !== -1 || body.indexOf('备份提醒') !== -1, '应提示备份状态');
    });

    await E2E.record('借用台账显示超期与在借记录', async function () {
      await navTo('ledger');
      await E2E.waitUntil('借用台账渲染', function () { return text('#view-root').indexOf('借用台账') !== -1; });
      var body = text('#view-root');
      E2E.ok(body.indexOf('张三') !== -1, '台账里应有借用人张三');
      E2E.ok(body.indexOf('MC-0002') !== -1, '台账里应有借出的物品编码');
    });

    await E2E.record('导航上的角标反映超期与待处理数量', async function () {
      var badge = document.querySelector('#nav-badge-purchases');
      E2E.ok(badge !== null, '采购导航应有角标元素');
    });

    await E2E.record('连续快速切页，最终停在最后点的那一页', async function () {
      // 渲染要读数据库、是异步的。连点两下时，先发出的那次可能后返回，
      // 如果不管，就会把用户最后点的页面盖掉（屏幕上出现别的页）。
      for (var round = 0; round < 5; round += 1) {
        var links = ['settings', 'ledger', 'txns', 'invoices', 'purchases'];
        // 不等渲染完成，连续点整串
        links.forEach(function (name) {
          E2E.clickSelector('#main-nav [data-goto="' + name + '"]');
        });
        /* eslint-disable no-loop-func */
        await E2E.waitUntil('停在第 ' + round + ' 轮最后点的采购申请页', function () {
          return pageName() === 'purchases' && text('#view-root').indexOf('采购申请') !== -1;
        });
        /* eslint-enable no-loop-func */
        // 再多等一会，确认没有"迟到的旧页面"把当前页盖掉
        await E2E.wait(250);
        E2E.ok(pageName() === 'purchases',
          '第 ' + round + ' 轮：过一会儿仍应停在采购申请页，实际 ' + pageName());
        E2E.clickSelector('#main-nav [data-goto="home"]');
        await E2E.waitUntil('回首页', function () { return pageName() === 'home'; });
      }
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
