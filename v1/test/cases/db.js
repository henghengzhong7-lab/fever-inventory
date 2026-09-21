/** 建库、表结构、四个大类初始化 */
'use strict';

module.exports.register = function (H, DB, Rules) {
  const { test, assert, assertEqual } = H;

  test('能打开数据库并创建全部表', async () => {
    const database = await DB.openDB();
    assert(database, '数据库应能打开');
    DB.STORES.forEach((name) => {
      assert(database.objectStoreNames.contains(name), '应包含表 ' + name);
    });
  });

  test('首次运行写入四个大类', async () => {
    await Rules.clearAll();
    const list = await Rules.initCategories();
    const ids = list.map((c) => c.id).sort();
    assertEqual(ids.join(','), 'electronic,hardware,mechanical,vision', '应有四个大类');
  });

  test('重复初始化不会重复写入', async () => {
    const list = await Rules.initCategories();
    assertEqual(list.length, 4, '重复初始化后仍是四个大类');
  });

  test('四个大类的编号前缀正确', async () => {
    const list = await Rules.initCategories();
    const map = {};
    list.forEach((c) => { map[c.id] = Rules.prefixOf(c); });
    assertEqual(map.mechanical, 'MC');
    assertEqual(map.electronic, 'EL');
    assertEqual(map.vision, 'VS');
    assertEqual(map.hardware, 'HW');
  });

  test('四个大类都有各自不同的专属字段', async () => {
    const list = await Rules.initCategories();
    const sets = list.map((c) => c.extraFields.map((f) => f.key).sort().join(','));
    const unique = new Set(sets);
    assertEqual(unique.size, 4, '四个大类的专属字段应各不相同（不能是同一张表换名字）');
    list.forEach((c) => {
      assert(c.extraFields.length >= 5, c.name + ' 至少应有 5 个专属字段，实际 ' + c.extraFields.length);
    });
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
