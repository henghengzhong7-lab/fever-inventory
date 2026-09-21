/**
 * M7 的浏览器端到端测试：设置页、备份导出、导入恢复、备份提醒。
 *
 * 导入确认框走的是真实界面（点"取消"和点"确定"两条路都验），
 * 不绕过确认直接调内部函数。
 */
(function (global) {
  'use strict';

  var E2E = global.E2E;
  var DB = global.FEVER.DB;
  var Rules = global.FEVER.Rules;
  var Ops = global.FEVER.Ops;
  var App = global.FEVER.App;
  var UI = global.FEVER.UI;

  function text(sel) {
    var node = document.querySelector(sel);
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function body() { return text('#view-root'); }
  function pageName() { return document.querySelector('#view-root').getAttribute('data-page'); }

  function goto(name) {
    App.goto(name);
    return E2E.waitUntil('切到 ' + name, function () { return pageName() === name; });
  }

  /**
   * 切到某一页并确保是"重新渲染过"的那一份。
   *
   * 光等 data-page 是不够的：如果本来就停在这一页，条件立刻成立，
   * 拿到的还是上一次渲染的旧内容（比如刚改完"上次备份时间"却还显示旧值）。
   * 每次渲染都会把 #view-root 整个换成一个新元素，所以判断元素换没换来最准。
   */
  function gotoFresh(name) {
    var before = document.querySelector('#view-root');
    App.goto(name);
    return E2E.waitUntil('切到 ' + name + '（重新渲染）', function () {
      var now = document.querySelector('#view-root');
      return now && now !== before && now.getAttribute('data-page') === name;
    });
  }

  function modal() {
    return E2E.waitUntil('弹窗打开', function () { return document.querySelector('.modal-mask'); })
      .then(function () { return document.querySelector('.modal-mask'); });
  }
  function waitModalGone() {
    return E2E.waitUntil('弹窗关闭', function () { return !document.querySelector('.modal-mask'); });
  }

  /** 造一条完整链路的数据：物品 + 采购申请 + 发票 + 流水 */
  async function seed() {
    await E2E.resetDb();
    await Rules.initCategories();
    await Ops.inbound({
      categoryId: 'mechanical', name: '步进电机', spec: '42BYGH', quantity: 5,
      identityMode: 'shared', operator: '李四', safetyStock: 2
    });
    await Ops.inbound({
      categoryId: 'vision', name: '工业相机', quantity: 1,
      identityMode: 'single', operator: '李四'
    });
    await Ops.lend({ code: 'MC-0001', qty: 1, operator: '李四', borrower: '张三', dueDate: '2030-01-01' });
    await App.refresh();
  }

  async function run() {
    /* ================= 设置页本身 ================= */

    await seed();

    await E2E.record('设置页显示各表真实条数', async function () {
      await goto('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份与恢复') !== -1; });
      var counts = {
        items: (await DB.getAll('items')).length,
        purchaseRequests: (await DB.getAll('purchaseRequests')).length,
        invoices: (await DB.getAll('invoices')).length,
        transactions: (await DB.getAll('transactions')).length
      };
      E2E.ok(body().indexOf('物品身份' + counts.items + ' 条') !== -1,
        '物品身份应显示 ' + counts.items + ' 条，实际页面：' + body().slice(0, 200));
      E2E.ok(body().indexOf('采购申请' + counts.purchaseRequests + ' 条') !== -1, '应显示采购申请条数');
      E2E.ok(body().indexOf('发票' + counts.invoices + ' 条') !== -1, '应显示发票条数');
      E2E.ok(body().indexOf('出入库流水' + counts.transactions + ' 条') !== -1, '应显示流水条数');
    });

    await E2E.record('没有备份过时，设置页出现备份提醒', async function () {
      await goto('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份与恢复') !== -1; });
      E2E.ok(body().indexOf('备份提醒') !== -1, '从未备份应出现备份提醒');
      E2E.ok(body().indexOf('还没有备份过') !== -1, '应说明还没备份过');
      E2E.ok(body().indexOf('从未备份') !== -1, '上次备份应显示从未备份');
    });

    await E2E.record('设置页说明数据存在哪里、什么情况会丢', async function () {
      await goto('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('关于数据安全') !== -1; });
      E2E.ok(body().indexOf('清除浏览器数据') !== -1, '应说明清除浏览器数据会看不到');
      E2E.ok(body().indexOf('不联网') !== -1, '应说明不联网');
    });

    /* ================= 备份提醒的时间判定 ================= */

    await E2E.record('超过 7 天没备份才提醒，刚备份过不提醒', async function () {
      // 刚备份过：不该再提醒
      await DB.setSetting('lastBackupAt', DB.nowIso());
      await gotoFresh('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份与恢复') !== -1; });
      E2E.ok(body().indexOf('备份提醒') === -1, '刚刚备份过不该出现备份提醒，实际：' + body().slice(0, 200));

      // 6 天前备份：仍在 7 天以内，不该提醒（边界）
      var sixDaysAgo = new Date(Date.now() - 6 * 86400000);
      await DB.setSetting('lastBackupAt', sixDaysAgo.toISOString());
      await gotoFresh('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份与恢复') !== -1; });
      E2E.ok(body().indexOf('备份提醒') === -1, '6 天前备份仍不该提醒');

      // 8 天前备份：应该提醒，并说明已经几天
      var eightDaysAgo = new Date(Date.now() - 8 * 86400000);
      await DB.setSetting('lastBackupAt', eightDaysAgo.toISOString());
      await gotoFresh('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份提醒') !== -1; });
      E2E.ok(body().indexOf('已经 8 天没备份了') !== -1,
        '8 天未备份应说明天数，实际：' + body().slice(0, 260));
    });

    /* ================= 导出备份 ================= */

    await E2E.record('导出备份生成 .json 文件且包含全部表与版本号', async function () {
      await E2E.resetDb();
      await Rules.initCategories();
      await Ops.inbound({
        categoryId: 'mechanical', name: '步进电机', quantity: 5,
        identityMode: 'shared', operator: '李四'
      });
      await App.refresh();

      var payload = await App.exportBackup(true);
      E2E.ok(payload, '应返回备份内容');
      E2E.ok(payload.formatVersion !== undefined, '备份里应带格式版本号');
      E2E.ok(payload.exportedAt, '备份里应带导出时间');
      DB.STORES.forEach(function (name) {
        E2E.ok(Array.isArray(payload.data[name]), '备份应包含表 ' + name);
      });
      E2E.ok(payload.data.items.length === 1, '应包含导出时那 1 件物品');
      E2E.ok(payload.data.categories.length === 4, '应包含四个大类配置');
      E2E.ok(payload.counts.items === 1, '统计里物品应为 1 条');
    });

    await E2E.record('导出备份后设置页的备份时间会更新', async function () {
      await App.exportBackup(true);
      await gotoFresh('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份与恢复') !== -1; });
      E2E.ok(body().indexOf('从未备份') === -1, '导出后不该还显示从未备份');
      var last = await DB.getSetting('lastBackupAt');
      E2E.ok(last, '数据库里应记下上次备份时间');
      E2E.ok(body().indexOf(UI.fmtTime(last).slice(0, 10)) !== -1, '设置页应显示上次备份的日期');
    });

    /* ================= 导入恢复：取消 ================= */

    await E2E.record('导入时点取消：数据完全没有变化', async function () {
      await seed();
      var backup = await Rules.exportAll();
      var before = {
        items: (await DB.getAll('items')).length,
        txns: (await DB.getAll('transactions')).length
      };
      // 导入前先把库改掉，这样"没变化"才有说服力
      await Rules.clearAll();
      await Rules.initCategories();
      await Ops.inbound({ categoryId: 'hardware', name: '临时件', quantity: 1, identityMode: 'shared', operator: '测试' });
      await App.refresh();
      var changed = (await DB.getAll('items')).length;
      E2E.ok(changed === 1, '清空后应只剩刚加的 1 件，实际 ' + changed);

      var p = App.importFromText(JSON.stringify(backup), 'test-backup.json');
      var mask = await modal();
      await E2E.waitUntil('确认框出现', function () { return mask.querySelector('[data-act="no"]'); });
      E2E.ok(mask.textContent.indexOf('test-backup.json') !== -1, '确认框应写出文件名');
      E2E.clickSelector('[data-act="no"]');
      await waitModalGone();
      var result = await p;
      E2E.ok(result === 'canceled', '取消时返回值应为 canceled，实际 ' + result);
      E2E.ok((await DB.getAll('items')).length === changed, '取消后数据不该有任何变化');
      E2E.ok(text('#toast-root').indexOf('已取消') !== -1, '应提示已取消');
    });

    /* ================= 导入恢复：确定 ================= */

    await E2E.record('导入非法文件被拒绝且数据不变', async function () {
      await seed();
      var before = (await DB.getAll('items')).length;
      var r1 = await App.importFromText('这不是 JSON', 'bad.json');
      E2E.ok(r1 === 'invalid', '解析失败应返回 invalid');
      var r2 = await App.importFromText(JSON.stringify({ nope: true }), 'bad2.json');
      E2E.ok(r2 === 'invalid', '缺少 data 应返回 invalid');
      E2E.ok(!document.querySelector('.modal-mask'), '非法文件不该弹出确认框');
      E2E.ok((await DB.getAll('items')).length === before, '被拒后数据不应变化');
      E2E.ok(text('#toast-root').indexOf('不能导入') !== -1, '应提示不能导入');
    });

    await E2E.record('导入备份后各表条数与备份完全一致', async function () {
      await seed();
      var backup = await Rules.exportAll();
      var want = {
        items: backup.data.items.length,
        purchaseRequests: backup.data.purchaseRequests.length,
        invoices: backup.data.invoices.length,
        transactions: backup.data.transactions.length,
        categories: backup.data.categories.length
      };

      // 先把数据全清掉，制造"数据没了，需要恢复"的场景
      await Rules.clearAll();
      await Rules.initCategories();
      await App.refresh();
      E2E.ok((await DB.getAll('items')).length === 0, '清空后应没有物品');

      var p = App.importFromText(JSON.stringify(backup), 'restore.json');
      var mask = await modal();
      await E2E.waitUntil('确认框出现', function () { return mask.querySelector('[data-act="yes"]'); });
      // 确认框里应写出这份备份有多少东西
      E2E.ok(mask.textContent.indexOf('物品 ' + want.items + ' 条') !== -1,
        '确认框应说明备份里有多少物品，实际：' + mask.textContent.replace(/\s+/g, ' ').slice(0, 300));
      E2E.clickSelector('[data-act="yes"]');
      await waitModalGone();
      var result = await p;
      E2E.ok(result === 'done', '确认导入应返回 done，实际 ' + result);

      var after = {
        items: (await DB.getAll('items')).length,
        purchaseRequests: (await DB.getAll('purchaseRequests')).length,
        invoices: (await DB.getAll('invoices')).length,
        transactions: (await DB.getAll('transactions')).length,
        categories: (await DB.getAll('categories')).length
      };
      Object.keys(want).forEach(function (k) {
        E2E.ok(after[k] === want[k], k + ' 恢复后应为 ' + want[k] + ' 条，实际 ' + after[k]);
      });

      var item = await DB.get('items', 'MC-0001');
      E2E.ok(item && item.name === '步进电机', '恢复后物品内容应完整');
      E2E.ok(item.inStockQty === 4 && item.lentQty === 1, '恢复后库存数字应完整（借出 1、在库 4）');
      var txns = await DB.getAll('transactions');
      E2E.ok(txns.some(function (t) { return t.type === 'lend' && t.borrower === '张三'; }),
        '恢复后借用流水应完整');
    });

    await E2E.record('导入成功后界面立刻刷新成恢复后的数据', async function () {
      await gotoFresh('settings');
      await E2E.waitUntil('设置页渲染', function () { return body().indexOf('备份与恢复') !== -1; });
      var n = (await DB.getAll('items')).length;
      E2E.ok(body().indexOf('物品身份' + n + ' 条') !== -1,
        '设置页应显示恢复后的条数 ' + n + '，实际：' + body().slice(0, 200));
      E2E.ok(body().indexOf('备份提醒') === -1, '刚导入完（等于刚备份过）不该再弹备份提醒');
    });

    await E2E.record('导入前会自动把当前数据导出一份作保险', async function () {
      await seed();
      // 先塞一件"当前数据"里才有的东西，导入后它应该消失，
      // 但它已经作为"导入前自动备份"的一部分被记录过。
      await Ops.inbound({ categoryId: 'hardware', name: '导入前才有的件', quantity: 1, identityMode: 'shared', operator: '测试' });
      await App.refresh();
      var backup = await Rules.exportAll();

      // 把当前库改成"另一套数据"
      await Rules.clearAll();
      await Rules.initCategories();
      await Ops.inbound({ categoryId: 'electronic', name: '导入前的旧货', quantity: 3, identityMode: 'shared', operator: '测试' });
      await App.refresh();
      var beforeCount = (await DB.getAll('items')).length;

      // 记录自动保险备份有没有真的发生：lastBackupAt 会被写一次
      await DB.setSetting('lastBackupAt', '2020-01-01T00:00:00.000Z');
      var p = App.importFromText(JSON.stringify(backup), 'insurance.json');
      var mask = await modal();
      await E2E.waitUntil('确认框出现', function () { return mask.querySelector('[data-act="yes"]'); });
      E2E.ok(mask.textContent.indexOf('自动导出一份作保险') !== -1,
        '确认框应说明会先自动备份，实际：' + mask.textContent.replace(/\s+/g, ' ').slice(0, 300));
      E2E.clickSelector('[data-act="yes"]');
      await waitModalGone();
      await p;

      var last = await DB.getSetting('lastBackupAt');
      E2E.ok(last !== '2020-01-01T00:00:00.000Z', '自动保险备份应刷新上次备份时间');
      // 导入的是那份 backup，所以"导入前的旧货"应该没了
      var items = await DB.getAll('items');
      E2E.ok(!items.some(function (i) { return i.name === '导入前的旧货'; }),
        '导入后应换成备份里的数据，旧货不该还在（导入前有 ' + beforeCount + ' 件）');
      E2E.ok(items.some(function (i) { return i.name === '导入前才有的件'; }),
        '备份里的物品应回来');
    });

    /* ================= 导出表格 ================= */

    await E2E.record('导出物品表格与流水表格能生成内容', async function () {
      await seed();
      var itemsCsv = global.FEVER.Stats.itemsCsv(await DB.getAll('items'));
      E2E.ok(itemsCsv.indexOf('编码') !== -1, '物品表格应含表头');
      E2E.ok(itemsCsv.indexOf('步进电机') !== -1, '物品表格应含物品名');
      var rows = await global.FEVER.Stats.filterTransactions({});
      var txnCsv = global.FEVER.Stats.transactionsCsv(rows);
      E2E.ok(txnCsv.indexOf('编码') !== -1, '流水表格应含表头');
      E2E.ok(txnCsv.indexOf('借出') !== -1, '流水表格应含借出记录');
    });

    E2E.finish();
  }

  run().catch(function (err) {
    E2E.record('测试主流程未抛异常', function () { E2E.fail(String(err && err.stack ? err.stack : err)); });
    E2E.finish();
  });
})(window);
