/** 建库、表结构、大类初始化 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual, assertRejects } = H;

  test('事务回调里同步抛错：变成 Promise 拒绝，且不留未处理的拒绝', async () => {
    // 真踩过的坑（第十四周）：runTx 接住了"事务中断"，却没接住自己 abort 出来的
    // 那个拒绝 —— 于是一次同步抛错会变成一个未处理的 Promise 拒绝，
    // 在 Node 里直接让整个测试进程崩掉（连失败清单都打不出来）。
    // 这条用例就是防线：一旦回归，跑测试时会立刻崩，而不是留给线上偶发。
    await assertRejects(() => DB.runTx('settings', 'readwrite', function () {
      throw new Error('字段校验没过');
    }), '事务回调里的同步异常应被转成 Promise 拒绝');

    // 抛错之后库还能照常读写，说明事务被干净地中断了，没有卡住连接
    await DB.setSetting('probeAfterAbort', 'ok');
    assertEqual(await DB.getSetting('probeAfterAbort'), 'ok', '中断后数据库应仍然可用');
  });

  test('能打开数据库并创建全部表', async () => {
    const database = await DB.openDB();
    assert(database, '数据库应能打开');
    DB.STORES.forEach((name) => {
      assert(database.objectStoreNames.contains(name), '应包含表 ' + name);
    });
  });

  test('首次运行写入六个大类', async () => {
    await Rules.clearAll();
    const list = await Rules.initCategories();
    const ids = list.map((c) => c.id).sort();
    assertEqual(ids.join(','), 'electronic,general,hardware,mechanical,promo,vision',
      '应有六个大类（第十四周新增 宣传 promo / 通用 general）');
  });

  test('重复初始化不会重复写入', async () => {
    const list = await Rules.initCategories();
    assertEqual(list.length, 6, '重复初始化后仍是六个大类');
  });

  test('六个大类的编号前缀正确且互不重复', async () => {
    const list = await Rules.initCategories();
    const map = {};
    list.forEach((c) => { map[c.id] = Rules.prefixOf(c); });
    assertEqual(map.mechanical, 'MC');
    assertEqual(map.electronic, 'EL');
    assertEqual(map.vision, 'VS');
    assertEqual(map.hardware, 'HW');
    assertEqual(map.promo, 'PR');
    assertEqual(map.general, 'GN');
    // 前缀会印在标签上，重了就会出现"两张不同东西贴同一个码前缀"的混乱
    const prefixes = Object.keys(map).map((k) => map[k]);
    assertEqual(new Set(prefixes).size, prefixes.length, '大类前缀不能重复');
  });

  test('大类各有专属字段：四个专属模块类互不相同且够用，新增两类字段自成一套', async () => {
    const list = await Rules.initCategories();
    const byId = {};
    list.forEach((c) => { byId[c.id] = c; });

    // 有专属页面的四个大类：字段集合两两不同，且字段要够撑起专属页
    const four = ['mechanical', 'electronic', 'vision', 'hardware'].map((id) => byId[id]);
    const sets = four.map((c) => c.extraFields.map((f) => f.key).sort().join(','));
    assertEqual(new Set(sets).size, 4, '四个大类的专属字段应各不相同（不能是同一张表换名字）');
    four.forEach((c) => {
      assert(c.extraFields.length >= 5, c.name + ' 至少应有 5 个专属字段，实际 ' + c.extraFields.length);
    });

    // 新增的通用两类没有专属模块，字段少一些是正常的，但不能是空壳
    ['promo', 'general'].forEach((id) => {
      assert(byId[id], id + ' 应该存在');
      assert(byId[id].extraFields.length >= 2, byId[id].name + ' 至少要有 2 个专属字段');
    });
    assertEqual(byId.promo.extraFields.length > 0 && byId.general.extraFields.length > 0, true);
  });

  test('新增的两个大类默认同款共用，且不依赖专属模块', async () => {
    const list = await Rules.initCategories();
    const map = {};
    list.forEach((c) => { map[c.id] = c; });
    // 宣传与通用走通用清单 + 通用筛选，没有专属模块是刻意的（见 rules.js 注释）
    assertEqual(map.promo.defaultIdentityMode, 'shared');
    assertEqual(map.general.defaultIdentityMode, 'shared');
    assertEqual(map.promo.sortOrder, 5, '新大类应排在原有四个之后');
    assertEqual(map.general.sortOrder, 6);
  });

  test('视觉类默认单独建身份，其余默认同款共用', async () => {
    const list = await Rules.initCategories();
    const map = {};
    list.forEach((c) => { map[c.id] = c.defaultIdentityMode; });
    assertEqual(map.vision, 'single');
    assertEqual(map.mechanical, 'shared');
    assertEqual(map.electronic, 'shared');
    assertEqual(map.hardware, 'shared');
  });

  test('配置项能写入并读回', async () => {
    await DB.setSetting('lastBackupAt', '2026-09-21T00:00:00.000Z');
    const v = await DB.getSetting('lastBackupAt');
    assertEqual(v, '2026-09-21T00:00:00.000Z');
    const missing = await DB.getSetting('notExist', '默认值');
    assertEqual(missing, '默认值');
  });
};
