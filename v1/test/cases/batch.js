/**
 * 批量打印与批量删除。
 *
 * 这两件事都是"一次对很多东西动手"，所以风险不在单条正确性，而在：
 *   · 选中集合有没有丢（刷新后还剩不剩 —— 靠地址栏，见 app.js routeToHash）
 *   · 批量删除留下的账，和单条删除是不是同一套（审计不能两套格式）
 *   · 该被拦住的（借出中/待修中）有没有被顺手删掉
 *   · 联网版会不会因为"一件一个来回"而慢到像卡死（所以整批只用一个事务）
 * 这一组就盯这几条。
 */
'use strict';

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertDeepEqual } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  /** 入库一件并返回它的编码 */
  async function makeItem(over) {
    const res = await Ops.inbound(Object.assign({
      categoryId: 'mechanical', name: '物品', quantity: 1,
      identityMode: 'shared', operator: '测试'
    }, over));
    return res.codes[0];
  }

  /* ================= 纯函数：选中集合 ================= */

  test('pickByCodes 按给定顺序取，而不是按库里的顺序', async () => {
    const items = [{ code: 'A' }, { code: 'B' }, { code: 'C' }];
    const picked = Rules.pickByCodes(items, ['C', 'A']);
    assertDeepEqual(picked.map((i) => i.code), ['C', 'A'],
      '批量打印要按勾选顺序出标签，人撕下来挨着贴才对得上');
  });

  test('pickByCodes 跳过已经不存在的编码，不补空位', async () => {
    const items = [{ code: 'A' }, { code: 'B' }];
    const picked = Rules.pickByCodes(items, ['A', 'GONE', 'B']);
    assertDeepEqual(picked.map((i) => i.code), ['A', 'B'], '找不到的直接跳过');
    assertEqual(picked.length, 2);
  });

  test('pickByCodes 空输入返回空数组，不炸', async () => {
    assertEqual(Rules.pickByCodes([], ['A']).length, 0);
    assertEqual(Rules.pickByCodes([{ code: 'A' }], []).length, 0);
    assertEqual(Rules.pickByCodes(null, null).length, 0);
  });

  test('编码列表编解码往返一致（这是刷新后选中集合不丢的保证）', async () => {
    const codes = ['MC-0001', 'VS-0002', 'HW-0010'];
    assertDeepEqual(Rules.decodeCodeList(Rules.encodeCodeList(codes)), codes);
  });

  test('编码里带逗号/中文/斜杠也不会把列表切错', async () => {
    // 编码正常是 MC-0001 这种，但导入的旧数据可能不守规矩 —— 不能因此串位
    const codes = ['A,B', '中文-0001', 'C/D', 'E%2C'];
    assertDeepEqual(Rules.decodeCodeList(Rules.encodeCodeList(codes)), codes,
      '每个编码单独编码，逗号分隔才安全');
  });

  test('空的编码列表解出来是空数组，而不是 [""]', async () => {
    assertDeepEqual(Rules.decodeCodeList(''), []);
    assertDeepEqual(Rules.decodeCodeList(undefined), []);
  });

  /* ================= 纯函数：能不能删 ================= */

  test('partitionDeletable 把能删的和被拦的分开', async () => {
    const part = Rules.partitionDeletable([
      { code: 'A', lentQty: 0, repairQty: 0 },
      { code: 'B', lentQty: 2, repairQty: 0 },
      { code: 'C', lentQty: 0, repairQty: 1 }
    ]);
    assertDeepEqual(part.deletable.map((i) => i.code), ['A']);
    assertDeepEqual(part.blocked.map((b) => b.item.code), ['B', 'C']);
  });

  test('被拦住的原因是具体的人话，不是一句"不能删"', async () => {
    const part = Rules.partitionDeletable([
      { code: 'B', lentQty: 3, repairQty: 0 },
      { code: 'C', lentQty: 0, repairQty: 2 }
    ]);
    assert(/3 件借在外面/.test(part.blocked[0].reason), '要说清借出几件：' + part.blocked[0].reason);
    assert(/2 件在待修/.test(part.blocked[1].reason), '要说清待修几件：' + part.blocked[1].reason);
  });

  test('partitionDeletable 忽略空值，不会因为一条脏数据整批报错', async () => {
    const part = Rules.partitionDeletable([null, { code: 'A', lentQty: 0, repairQty: 0 }, undefined]);
    assertEqual(part.deletable.length, 1);
    assertEqual(part.blocked.length, 0);
  });

  /* ================= 预演 ================= */

  test('预演如实分出：能删的 / 被拦的 / 已经不在了的', async () => {
    await fresh();
    const a = await makeItem({ name: '能删的' });
    const b = await makeItem({ name: '借出去的' });
    await Ops.lend({ code: b, qty: 1, operator: '测试', borrower: '张三', dueDate: '2026-12-31' });

    const info = await Ops.previewItemDeletion([a, b, 'MC-9999']);
    assertDeepEqual(info.deletable.map((i) => i.code), [a]);
    assertDeepEqual(info.blocked.map((x) => x.item.code), [b]);
    assertEqual(info.missing, 1, 'MC-9999 不存在，要算进 missing');
  });

  test('预演是只读的：跑完东西一件都没少', async () => {
    await fresh();
    const a = await makeItem({});
    await Ops.previewItemDeletion([a]);
    assert(await DB.get('items', a), '预演不该删掉任何东西');
  });

  /* ================= 批量删除 ================= */

  test('批量删除：选中的都删掉了，没选的原样还在', async () => {
    await fresh();
    const a = await makeItem({ name: 'A' });
    const b = await makeItem({ name: 'B' });
    const keep = await makeItem({ name: '留着' });

    const res = await Ops.deleteItemsBatch([a, b]);
    assertDeepEqual(res.removed, [a, b]);
    assertEqual(await DB.get('items', a), undefined, 'A 应已删除');
    assertEqual(await DB.get('items', b), undefined, 'B 应已删除');
    assert(await DB.get('items', keep), '没选中的必须还在');
  });

  test('批量删除：逐条留痕，一条不少', async () => {
    await fresh();
    const a = await makeItem({ name: 'A' });
    const b = await makeItem({ name: 'B' });
    const c = await makeItem({ name: 'C' });

    await Ops.deleteItemsBatch([a, b, c]);
    const log = await Rules.getDeleteLog();
    assertEqual(log.length, 3, '删三件就该有三笔账，实际 ' + log.length);
    assertDeepEqual(log.map((r) => r.key).sort(), [a, b, c].sort());
  });

  test('批量删除留的账与单条删除格式完全一致（审计不能两套写法）', async () => {
    await fresh();
    const a = await makeItem({ name: '批量删的' });
    const b = await makeItem({ name: '单条删的' });

    await Ops.deleteItemsBatch([a]);
    const batchRow = (await Rules.getDeleteLog())[0];

    const item = { code: b, name: '单条删的' };
    const singleRow = await Rules.logDeletion({
      store: 'items', key: b, label: b + ' 单条删的', snapshot: item
    });

    assertDeepEqual(Object.keys(batchRow).sort(), Object.keys(singleRow).sort(),
      '两种路径写出来的字段必须一样');
    assertEqual(batchRow.label, '物品 ' + a + ' 批量删的', 'label 同样带类型前缀');
    assert(/^物品 /.test(singleRow.label), '单条那条也带前缀');
    assertEqual(batchRow.by, '本机操作', '离线版操作人如实写');
    assertEqual(batchRow.store, 'items');
  });

  test('批量删除：快照能还原被删的内容', async () => {
    await fresh();
    const a = await makeItem({ name: '快照件', quantity: 7, safetyStock: 3 });
    await Ops.deleteItemsBatch([a]);

    const row = (await Rules.getDeleteLog())[0];
    assert(row.snapshot, '必须留快照 —— 那是以后人工还原的唯一依据');
    assertEqual(row.snapshot.code, a);
    assertEqual(row.snapshot.name, '快照件');
    assertEqual(row.snapshot.totalQty, 7);
    assertEqual(row.snapshot.safetyStock, 3);
  });

  test('批量删除：借出中的被跳过，其他照样删掉（不是整批失败）', async () => {
    await fresh();
    const ok1 = await makeItem({ name: '在库1' });
    const lent = await makeItem({ name: '借出的' });
    const ok2 = await makeItem({ name: '在库2' });
    await Ops.lend({ code: lent, qty: 1, operator: '测试', borrower: '张三', dueDate: '2026-12-31' });

    const res = await Ops.deleteItemsBatch([ok1, lent, ok2]);
    assertDeepEqual(res.removed.sort(), [ok1, ok2].sort(), '能删的要照删');
    assertDeepEqual(res.blocked.map((b) => b.item.code), [lent], '借出的要被跳过并报出来');
    assert(await DB.get('items', lent), '借出的那件必须还在，否则实物没人认领');
    assertEqual(await DB.get('items', ok1), undefined);
  });

  test('批量删除：待修中的同样被跳过', async () => {
    await fresh();
    const a = await makeItem({ name: '送去修的' });
    await Ops.sendRepair({ code: a, qty: 1, operator: '测试', reason: '断路' });

    const res = await Ops.deleteItemsBatch([a]);
    assertEqual(res.removed.length, 0);
    assertEqual(res.blocked.length, 1);
    assert(await DB.get('items', a), '待修中的不能被批量删掉');
  });

  test('批量删除：编码不存在就当没选过，不报错、不算删成功', async () => {
    await fresh();
    const a = await makeItem({});
    const res = await Ops.deleteItemsBatch([a, 'MC-9999']);
    assertDeepEqual(res.removed, [a]);
    assertEqual(res.missing, 1, '不存在的要如实算进 missing');
  });

  test('批量删除：空选中的话一件事都不发生', async () => {
    await fresh();
    const a = await makeItem({});
    const res = await Ops.deleteItemsBatch([]);
    assertDeepEqual(res.removed, []);
    assert(await DB.get('items', a));
    assertEqual((await Rules.getDeleteLog()).length, 0, '不该凭空多出删除记录');
  });

  test('批量删除物品不会连带删掉它的出入库履历', async () => {
    await fresh();
    const a = await makeItem({ name: '有履历的' });
    await Ops.deleteItemsBatch([a]);

    const txns = await DB.getAll('transactions');
    const mine = txns.filter((t) => t.itemCode === a);
    assert(mine.length >= 1, '流水按设计只追加，删物品不该把履历一起抹掉');
  });

  test('批量删除写进删除记录的行数 = 实际删掉的件数（不会多记也不会少记）', async () => {
    await fresh();
    const ok1 = await makeItem({});
    const lent = await makeItem({});
    await Ops.lend({ code: lent, qty: 1, operator: '测试', borrower: '张三', dueDate: '2026-12-31' });

    const res = await Ops.deleteItemsBatch([ok1, lent, 'MC-9999']);
    const log = await Rules.getDeleteLog();
    assertEqual(log.length, res.removed.length, '有几条实实在在删了，就该有几笔账');
    assertEqual(log.length, 1);
  });

  test('批量删除的账超出上限时只留最近 300 条', async () => {
    await fresh();
    // 先塞满，再加进来 5 条就该触发裁剪
    const old = [];
    for (let i = 0; i < 298; i += 1) {
      old.push({ at: DB.nowIso(), by: '旧', store: 'items', key: 'OLD-' + i, label: '物品 OLD-' + i, reason: '', snapshot: null });
    }
    await DB.setSetting(Rules.DELETE_LOG_KEY, old);

    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push(await makeItem({ name: '批' + i }));
    }
    await Ops.deleteItemsBatch(codes);

    const log = await Rules.getDeleteLog();
    assertEqual(log.length, Rules.DELETE_LOG_MAX, '应被裁到上限，实际 ' + log.length);
    assertEqual(log[log.length - 1].key, codes[4], '最新的那条要留下');
    assert(!log.some((r) => r.key === 'OLD-0'), '最老的应被挤出去');
    codes.forEach((c) => assert(log.some((r) => r.key === c), '本批的 ' + c + ' 应该都在'));
  });

  test('批量删除在一个事务里完成：写删除记录失败就整体回滚，不留半批', async () => {
    await fresh();
    const a = await makeItem({});
    const b = await makeItem({});

    // 拦住批量删除的写事务，只让写 settings 那一步炸掉。
    // 这样能验出"删除与留痕同生共死"：不能出现删了东西却没记上账的状态。
    const realRunTx = DB.runTx;
    let patched = false;
    DB.runTx = function (names, mode, fn) {
      const list = Array.isArray(names) ? names : [names];
      if (list.indexOf('items') !== -1 && list.indexOf('settings') !== -1) {
        patched = true;
        return realRunTx.call(DB, names, mode, function (T) {
          const wrapped = Object.assign({}, T, {
            put: function (storeName, data) {
              if (String(storeName) === 'settings') throw new Error('模拟写盘失败');
              return T.put(storeName, data);
            }
          });
          return fn(wrapped);
        });
      }
      return realRunTx.call(DB, names, mode, fn);
    };

    let threw = false;
    try {
      await Ops.deleteItemsBatch([a, b]);
    } catch (err) {
      threw = true;
    } finally {
      DB.runTx = realRunTx;
    }

    assert(patched, '这条用例本身要能拦到批量删除的写事务，否则等于空转');
    assert(threw, '写删除记录失败时，整批应当失败而不是"删了但没记账"');
    assert(await DB.get('items', a), '回滚后 A 必须还在');
    assert(await DB.get('items', b), '回滚后 B 必须还在');
    assertEqual((await Rules.getDeleteLog()).length, 0, '回滚后不该留下半截账');
  });

  /* ================= 与单条删除共用同一套积木 ================= */

  test('buildDeletionEntry 是纯函数：不改输入、字段齐全', async () => {
    await fresh();
    const input = { store: 'items', key: 'MC-0001', label: 'MC-0001 螺丝', snapshot: { a: 1 } };
    const row = Rules.buildDeletionEntry(input);
    assertEqual(input.label, 'MC-0001 螺丝', '不该改动传进来的对象');
    assertEqual(row.key, 'MC-0001');
    assertEqual(row.store, 'items');
    assertEqual(row.label, '物品 MC-0001 螺丝');
    assertDeepEqual(row.snapshot, { a: 1 });
    assert(!!row.at && !isNaN(new Date(row.at).getTime()), 'at 要是合法时间');
  });

  test('mergeDeleteLog 裁掉的是最老的，不是最新的', async () => {
    const current = [{ key: '1' }, { key: '2' }, { key: '3' }];
    const merged = Rules.mergeDeleteLog(current, [{ key: '4' }, { key: '5' }]);
    assertDeepEqual(merged.map((r) => r.key), ['1', '2', '3', '4', '5'], '没超上限就不裁');

    // 造一个刚好超上限的情形
    const many = [];
    for (let i = 0; i < Rules.DELETE_LOG_MAX; i += 1) many.push({ key: 'k' + i });
    const trimmed = Rules.mergeDeleteLog(many, [{ key: 'NEW' }]);
    assertEqual(trimmed.length, Rules.DELETE_LOG_MAX);
    assertEqual(trimmed[trimmed.length - 1].key, 'NEW', '最新的留下');
    assertEqual(trimmed[0].key, 'k1', '最老的 k0 被挤掉');
  });
};
