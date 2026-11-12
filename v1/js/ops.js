/**
 * FEver 战队物资管理 —— 业务流程层
 *
 * 入库、借出、归还、领用、送修、修好回库、采购到货入库。
 * 每个操作都：
 *   1) 在同一个 IndexedDB 事务里完成（改动物品 + 写流水 + 关联单据）
 *   2) 提交前校验库存恒等式，不成立就整体回滚
 *   3) 只追加流水，不修改历史记录
 *
 * 这一层不含界面代码，所以可以在 Node 里直接测。
 */
(function (global) {
  'use strict';

  var DB = global.FEVER && global.FEVER.DB ? global.FEVER.DB : (typeof require === 'function' ? require('./db.js') : null);
  var Rules = global.FEVER && global.FEVER.Rules ? global.FEVER.Rules : (typeof require === 'function' ? require('./rules.js') : null);

  var ALL_STORES = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];

  function fail(message) {
    var err = new Error(message);
    err.userMessage = message;
    throw err;
  }

  /**
   * 把"可能会同步抛错"的函数包成"总是返回 Promise"的形式。
   *
   * 必要性：校验（如"发票号码不能为空"）是在函数开头同步执行的，
   * 如果直接抛错，调用方写成 Ops.xxx().catch(...) 就接不到这个错，
   * 界面上既不会弹出提示，控制台还会报一个未捕获错误。
   * 包一层之后，所有失败都是 Promise 拒绝，界面统一走 catch 提示。
   */
  function guard(fn) {
    return function (input) {
      try {
        return Promise.resolve(fn(input));
      } catch (err) {
        return Promise.reject(err);
      }
    };
  }

  function n(v) {
    var x = Number(v);
    return isNaN(x) ? 0 : x;
  }

  /** 校验数量是正整数 */
  function requireQty(qty, label) {
    var q = n(qty);
    if (!(q > 0) || Math.floor(q) !== q) {
      fail((label || '数量') + '必须是大于 0 的整数');
    }
    return q;
  }

  function requireText(value, label) {
    var v = (value === undefined || value === null) ? '' : String(value).trim();
    if (!v) fail((label || '该项') + '不能为空');
    return v;
  }

  /**
   * 选填金额（第十四周，用于直接入库的「总价」）。
   * 空 → null；填了必须是 ≥ 0 的数字，乱填会被挡下。
   *
   * 之所以做成选填：有的东西买回来就忘了多少钱。
   * 逼着必填只会让人随手填个 0，账面上反而多出一堆假的 0 ——
   * "不知道"和"真的是 0 元"是两回事，null 才表达得清楚。
   */
  /**
   * 选填金额 —— 规则本身在 Rules.parseOptionalPrice（第二十三轮挪过去的），
   * 这里只把"不合法"翻译成抛错，好让 ops 这一层保持"先校验、后写库"的风格。
   * 编辑物品那边（app.js）用的是同一个纯函数，两边不会再跑偏。
   */
  function optionalPrice(value, label) {
    var r = Rules.parseOptionalPrice(value);
    if (!r.ok) fail((label ? label + '：' : '') + r.message);
    return r.value;
  }

  /** 选填日期：空 → ''；填了原样收下（日期输入框给的是 YYYY-MM-DD） */
  function optionalDate(value) {
    return Rules.parseOptionalDate(value).value;
  }

  /** 把一次变更写成流水（在已有事务里调用） */
  function writeTxn(T, record) {
    return T.add('transactions', {
      itemCode: record.itemCode,
      type: record.type,
      qty: record.qty,
      operator: record.operator,
      borrower: record.borrower || null,
      dueDate: record.dueDate || null,
      purpose: record.purpose || null,
      fromStatus: record.fromStatus || null,
      toStatus: record.toStatus || null,
      snapshotInStock: record.snapshotInStock,
      purchaseRequestId: record.purchaseRequestId || null,
      invoiceId: record.invoiceId || null,
      createdAt: DB.nowIso()
    });
  }

  /**
   * 校验并落库一条物品变更。
   * apply 接收物品副本，返回改过的副本；返回 null 表示拒绝。
   */
  function applyItemChange(T, code, apply) {
    return T.get('items', code).then(function (item) {
      if (!item) fail('未找到编码为 ' + code + ' 的物品');
      var before = Rules.statusOf(item);
      var draft = JSON.parse(JSON.stringify(item));
      var outcome = apply(draft);
      if (outcome === null) return null;
      draft.status = Rules.statusOf(draft);
      draft.updatedAt = DB.nowIso();
      var check = Rules.checkInvariant(draft);
      if (!check.ok) fail(check.message);
      return T.put('items', draft).then(function () {
        return { before: item, after: draft, fromStatus: before, toStatus: draft.status, outcome: outcome };
      });
    });
  }

  /**
   * 入库：新建物品身份。
   * identityMode 为 single 时，入库 N 件就生成 N 个各自独立的身份（各 1 件）；
   * 为 shared 时，生成 1 个身份、件数为 N（同款共用一个码）。
   *
   * 第十四周：新增两个**选填**字段 —— `totalPrice`（总价）与 `purchaseDate`（购买时间）。
   * 数量仍然是必填：它是库存账的基础，缺了没法记账；
   * 价格和日期只是台账信息，缺了不影响库存正确性。
   */
  function inbound(input) {
    var categoryId = requireText(input.categoryId, '所属大类');
    var name = requireText(input.name, '物品名称');
    var qty = requireQty(input.quantity, '入库数量');
    var identityMode = input.identityMode === 'single' ? 'single' : 'shared';
    var operator = requireText(input.operator, '操作人');
    // 兵种必填（第十三轮）：兵种是预算的归类键，直接入库的件不选兵种，
    // 那笔钱就会从兵种预算里静默漏掉 —— 跟采购申请一样不许空着。
    // 认不出的值 normalizeTroop 仍兜到「其他」，这里只拦「根本没选」。
    var troop = Rules.normalizeTroop(input.troop);
    if (!troop) fail('请选择兵种（重装、轮腿步兵、哨兵……至少选一个，兵种预算按它汇总）');
    // 选填字段的校验一律放在最前面（跟 requireQty 一样），**不要**挪进下面的事务里：
    // 事务回调里同步抛错会走 runTx 的"同步异常"分支，
    // 那条路径下事务的中断错误没人接，会变成一个未处理的 Promise 拒绝把进程带崩。
    // 放在这里既符合本文件"先校验、后写库"的约定，也绕开了那个坑。
    var totalPrice = optionalPrice(input.totalPrice, '总价');
    var purchaseDate = optionalDate(input.purchaseDate);

    return DB.get('categories', categoryId).then(function (category) {
      if (!category) fail('找不到大类：' + categoryId);
      var created = DB.nowIso();
      var totalCodes = identityMode === 'single' ? qty : 1;

      return Rules.nextCodes(category, totalCodes).then(function (codes) {
        return DB.runTx(ALL_STORES, 'readwrite', function (T) {
          var items = codes.map(function (code) {
            return {
              code: code,
              name: name,
              spec: (input.spec || '').trim(),
              categoryId: categoryId,
              location: (input.location || '').trim(),
              // 兵种必填；采购到货入库时由采购申请带过来（arrive 不走这里）
              troop: troop,
              identityMode: identityMode,
              totalQty: identityMode === 'single' ? 1 : qty,
              inStockQty: identityMode === 'single' ? 1 : qty,
              lentQty: 0,
              repairQty: 0,
              usedUpQty: 0,
              status: 'in_stock',
              safetyStock: input.safetyStock === '' || input.safetyStock === undefined || input.safetyStock === null
                ? null : n(input.safetyStock),
              // 总价与购买时间都是选填（第十四周）：记不清价格也能先把东西登进来
              totalPrice: totalPrice,
              purchaseDate: purchaseDate,
              remark: (input.remark || '').trim(),
              extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
              purchaseRequestId: input.purchaseRequestId || null,
              invoiceId: input.invoiceId || null,
              // 谁把这件东西录进系统的（第二十三轮）。记在物品行上，
              // 这样物品详情里能直接看到"添加人"，不用去翻流水。
              // 老数据没有这个键 —— 界面按"未记录"处理，不补假值。
              addedBy: operator,
              createdAt: created,
              updatedAt: created
            };
          });

          return items.reduce(function (chain, item) {
            return chain.then(function (acc) {
              var check = Rules.checkInvariant(item);
              if (!check.ok) fail(check.message);
              return T.add('items', item).then(function () {
                return writeTxn(T, {
                  itemCode: item.code,
                  type: 'inbound',
                  qty: item.totalQty,
                  operator: operator,
                  purpose: input.purpose || '入库',
                  fromStatus: null,
                  toStatus: 'in_stock',
                  snapshotInStock: item.inStockQty,
                  purchaseRequestId: item.purchaseRequestId,
                  invoiceId: item.invoiceId
                }).then(function () { acc.push(item); return acc; });
              });
            });
          }, Promise.resolve([]));
        });
      });
    }).then(function (items) {
      return { ok: true, items: items, codes: items.map(function (i) { return i.code; }) };
    });
  }

  /* ================= 身份方式后期更改（第十五轮） ================= */

  /** 一组身份里安全库存取"最严格"的那个：谁设过就用谁设的，都没设就是没设 */
  function strictestSafety(rows) {
    var seen = [];
    rows.forEach(function (r) {
      var v = r.safetyStock;
      if (v === null || v === undefined || v === '') return;
      seen.push(n(v));
    });
    return seen.length ? Math.max.apply(null, seen) : null;
  }

  /**
   * 把「同款共用」拆成一件一个身份。
   * 原编码保留 1 件（已经贴出去的那些标签**全部继续有效**），另发 N−1 个新编码。
   */
  function splitToSingle(item) {
    var blocked = Rules.blockItemDeletion(item);
    if (blocked) fail('现在不能拆：' + blocked);
    var qty = n(item.totalQty);
    var used = n(item.usedUpQty);
    if (used > 0) {
      fail('这一款已经有 ' + used + ' 件被领用/用掉了。拆分要给每一件都发一个新编码，' +
        '而领用掉的那些已经没有实物可贴 —— 先把剩下来的件数理清再拆。');
    }
    var created = DB.nowIso();

    // 只剩 1 件时不存在"拆"，把标记改掉就行，不必凭空发新码
    if (qty <= 1) {
      return DB.runTx('items', 'readwrite', function (T) {
        return T.put('items', Object.assign({}, item, {
          identityMode: 'single',
          totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0,
          status: 'in_stock', safetyStock: null, updatedAt: created
        }));
      }).then(function () {
        return { ok: true, mode: 'single', keptCode: item.code, newCodes: [] };
      });
    }

    return DB.get('categories', item.categoryId).then(function (category) {
      if (!category) fail('找不到大类：' + item.categoryId);
      return Rules.nextCodes(category, qty - 1).then(function (newCodes) {
        return DB.runTx(ALL_STORES, 'readwrite', function (T) {
          // 原编码留下 1 件；安全库存清掉 —— 它是"同款共用"才有的概念，
          // 一件一个身份时每件自己就是 1，算不出"低于某个数要补货"
          var head = Object.assign({}, item, {
            identityMode: 'single',
            totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0,
            status: 'in_stock', safetyStock: null, updatedAt: created
          });
          var ck = Rules.checkInvariant(head);
          if (!ck.ok) fail(ck.message);

          return T.put('items', head).then(function () {
            return newCodes.reduce(function (chain, c) {
              return chain.then(function () {
                var row = Object.assign({}, head, { code: c, createdAt: created, updatedAt: created });
                var check = Rules.checkInvariant(row);
                if (!check.ok) fail(check.message);
                return T.add('items', row);
              });
            }, Promise.resolve());
          }).then(function () {
            return { ok: true, mode: 'single', keptCode: item.code, newCodes: newCodes };
          });
        });
      });
    });
  }

  /**
   * 把多个「单独使用」的身份合并成一个「同款共用」。
   * 保留 keepCode（默认编码最小的那个，通常是最早贴的那张），其余编码删除、件数相加。
   * ⚠️ 被删掉的那些编码对应的**标签就作废了**，界面必须先把这个后果说清楚。
   */
  function mergeToShared(item, input) {
    var wanted = (input.codesToMerge || []).map(function (c) { return String(c).trim(); })
      .filter(function (c) { return !!c; });
    if (wanted.indexOf(item.code) === -1) wanted.push(item.code);
    if (wanted.length < 2) fail('合并至少要选两个身份');
    var keepWanted = input.keepCode ? String(input.keepCode).trim() : '';
    if (keepWanted && wanted.indexOf(keepWanted) === -1) fail('要保留的编码不在这批里');

    return DB.runTx('items', 'readonly', function (T) {
      return Promise.all(wanted.map(function (c) { return T.get('items', c); })).then(function (rows) {
        var missing = wanted.filter(function (c, i) { return !rows[i]; });
        if (missing.length) {
          fail('这些编码已经找不到了：' + missing.join('、') + '（可能刚被别人删掉，刷新页面后再试）');
        }
        var first = rows[0];
        rows.forEach(function (r) {
          if ((r.identityMode || 'shared') !== 'single') {
            fail('「' + r.code + '」不是单独身份，不能合进来');
          }
          if (r.name !== first.name || (r.spec || '') !== (first.spec || '') || r.categoryId !== first.categoryId) {
            fail('「' + r.code + '」和「' + first.code + '」不是同款（名称、规格、大类要一致），不能合并');
          }
          var blocked = Rules.blockItemDeletion(r);
          if (blocked) fail('「' + r.code + '」现在不能合并：' + blocked);
        });
        return rows;
      });
    }).then(function (rows) {
      var keep = rows.filter(function (r) { return r.code === keepWanted; })[0] || rows[0];
      var total = 0, inStock = 0, usedUp = 0;
      rows.forEach(function (r) {
        total += n(r.totalQty);
        inStock += n(r.inStockQty);
        usedUp += n(r.usedUpQty);
      });
      var drops = rows.filter(function (r) { return r.code !== keep.code; });
      var created = DB.nowIso();
      var merged = Object.assign({}, keep, {
        identityMode: 'shared',
        totalQty: total, inStockQty: inStock, lentQty: 0, repairQty: 0, usedUpQty: usedUp,
        status: inStock > 0 ? 'in_stock' : 'used_up',
        safetyStock: strictestSafety(rows),
        updatedAt: created
      });
      var check = Rules.checkInvariant(merged);
      if (!check.ok) fail(check.message);

      return DB.runTx(ALL_STORES, 'readwrite', function (T) {
        return T.put('items', merged).then(function () {
          return drops.reduce(function (chain, r) {
            return chain.then(function () { return T.remove('items', r.code); });
          }, Promise.resolve());
        });
      }).then(function () {
        // 留痕放在事务之后：写删除记录本身是一次独立的"读改写"，
        // 塞进同一个事务里会再开一个事务（IndexedDB 会直接把它挂掉）。
        // 语义与单条删除一致：东西确实合并掉了，日志万一没写上也不回头谎报失败。
        return drops.reduce(function (chain, r) {
          return chain.then(function () {
            return Rules.logDeletion({
              store: 'items', key: r.code,
              label: r.code + ' ' + r.name,
              reason: '身份合并进 ' + keep.code,
              snapshot: r
            });
          });
        }, Promise.resolve()).then(function () {
          return {
            ok: true, mode: 'shared', keptCode: keep.code,
            droppedCodes: drops.map(function (r) { return r.code; }),
            totalQty: total
          };
        });
      });
    });
  }

  /**
   * 改「身份方式」（第十五轮）：同款共用 ⇄ 单独使用，两个方向都支持。
   *
   * 为什么必须支持：一开始图省事选了"同款共用"，后来发现是贵重件、要一件一码；
   * 或者反过来，一堆单独身份其实是同一款耗材，想合起来记件数。
   * 没有这条出路，就只能把东西删了重登 —— 那会把历史流水和已贴的标签一起废掉。
   *
   * **不动库存、不写流水**：改身份不是一次出入库，件数一件不多一件不少
   * （每个写进去的行仍然要过 Rules.checkInvariant）。
   * 合并时删掉的行会记进「删除记录」，查得到。
   *
   * 前置条件全部复用 blockItemDeletion（还有实物在外面 / 待修就不许动），
   * 不另造一套判断 —— 规则只有一个来源，界面上说的和这里拦的才不会打架。
   *
   * 入参：
   *   { code, mode: 'single' | 'shared', keepCode?, codesToMerge? }
   *   拆分：给 code 即可。
   *   合并：codesToMerge 是整批要合并的编码（含要保留的那个），keepCode 指定留下谁；
   *        界面负责给出候选，这里只接受显式名单，避免"自动识别同款"把不相干的东西并进来。
   */
  function changeIdentity(input) {
    var code = requireText(input.code, '物品编码');
    var target = input.mode === 'single' ? 'single' : (input.mode === 'shared' ? 'shared' : null);
    if (!target) fail('要改成哪种身份方式？只能是同款共用或单独使用');

    return DB.get('items', code).then(function (item) {
      if (!item) fail('找不到物品 ' + code);
      var current = item.identityMode === 'single' ? 'single' : 'shared';
      if (current === target) {
        fail('「' + code + '」已经是「' + (target === 'single' ? '单独使用' : '同款共用') + '」了，不用再改');
      }
      return target === 'single' ? splitToSingle(item) : mergeToShared(item, input);
    });
  }

  /**
   * 找一件「单独身份」物品的同款候选（只读，一行都不改）。
   *
   * 判定规则必须与 mergeToShared 里那条**完全一致**（名称、规格、大类相同，
   * 且都是单独身份、当前没有借出/待修）—— 两处不一致的话，界面会列出一些
   * 点下去就被拒的选项，使用者只会觉得"这东西怎么时好时坏"。
   */
  function identityMergeCandidates(code) {
    var target = requireText(code, '物品编码');
    return DB.get('items', target).then(function (item) {
      if (!item) fail('找不到物品 ' + target);
      return DB.getAll('items').then(function (all) {
        return {
          item: item,
          candidates: all.filter(function (r) {
            if (r.code === item.code) return false;
            if ((r.identityMode || 'shared') !== 'single') return false;
            if (r.name !== item.name) return false;
            if ((r.spec || '') !== (item.spec || '')) return false;
            if (r.categoryId !== item.categoryId) return false;
            if (Rules.blockItemDeletion(r)) return false;
            return true;
          })
        };
      });
    });
  }

  /* ================= 标签打印记录（第十九轮） ================= */

  /**
   * 记录"这些标签刚打印过"。
   *
   * 存在**物品行**上，不拆到每一张：同款共用的一件东西（比如 MC-0001 有 5 件）
   * 整体算一次。理由是贴标签这件事人是一次贴一批，按单张记反而对不上现实。
   *
   * 只有两个字段：**打印次数**与**最近一次打印时间**。
   * ⚠️ 原来还有"待确认 / 确认已贴好"那一套，需求方明确说**不要**
   * （贴没贴好只有贴标签的人知道，让他多点一次确认纯属白事）—— 所以整套确认状态已删掉。
   *
   * 入参 { codes, at? }：codes 是物品编码数组（打印页传的就是本次实际打印的那些）。
   * at 只给测试用（固定时间好断言）。返回 { marked }：真正记上的条数。
   *
   * ⚠️ **只收一个对象**：对外的 Ops 方法都过了 guard()，而 guard 只透传第一个参数 ——
   * 写成 (codes, options) 的话 options 永远是 undefined（本轮真的踩了一次）。
   */
  function markPrinted(input) {
    var opts = input || {};
    var list = (opts.codes || []).map(function (v) { return String(v).trim(); })
      .filter(function (v) { return !!v; });
    if (!list.length) return Promise.resolve({ ok: true, marked: 0 });
    var now = opts.at || DB.nowIso();
    return DB.runTx('items', 'readwrite', function (T) {
      return list.reduce(function (chain, code) {
        return chain.then(function (marked) {
          return T.get('items', code).then(function (item) {
            // 编码可能刚被别人删了 —— 那种就跳过，不能因此让整次打印失败
            if (!item) return marked;
            var next = Object.assign({}, item, {
              printCount: n(item.printCount) + 1,
              lastPrintedAt: now,
              updatedAt: now
            });
            return T.put('items', next).then(function () { return marked + 1; });
          });
        });
      }, Promise.resolve(0)).then(function (marked) {
        return { ok: true, marked: marked, at: now };
      });
    });
  }

  /** 这批里"之前已经打印过"的件数 —— 打印页要靠它决定要不要先问一句（第二十轮定：不再有确认状态） */
  function printedBeforeCount(items) {
    return (items || []).filter(function (it) { return it && n(it.printCount) > 0; }).length;
  }
  /** 借出：在库件数转到借出件数 */
  function lend(input) {
    var code = requireText(input.code, '物品编码');
    var qty = requireQty(input.qty, '借出数量');
    var operator = requireText(input.operator, '操作人');
    var borrower = requireText(input.borrower, '借用人');
    var dueDate = requireText(input.dueDate, '预计归还日期');

    return DB.runTx(['items', 'transactions'], 'readwrite', function (T) {
      return applyItemChange(T, code, function (draft) {
        if (draft.inStockQty < qty) {
          fail('在库只有 ' + draft.inStockQty + ' 件，不够借出 ' + qty + ' 件');
        }
        draft.inStockQty -= qty;
        draft.lentQty += qty;
        return { qty: qty };
      }).then(function (res) {
        return writeTxn(T, {
          itemCode: code, type: 'lend', qty: qty, operator: operator,
          borrower: borrower, dueDate: dueDate, purpose: input.purpose || '',
          fromStatus: res.fromStatus, toStatus: res.toStatus, snapshotInStock: res.after.inStockQty
        }).then(function () { return { ok: true, item: res.after }; });
      });
    });
  }

  /** 归还：借出件数回到在库 */
  function giveBack(input) {
    var code = requireText(input.code, '物品编码');
    var operator = requireText(input.operator, '操作人');

    return DB.runTx(['items', 'transactions'], 'readwrite', function (T) {
      var qty;
      return applyItemChange(T, code, function (draft) {
        qty = input.qty === undefined || input.qty === null || input.qty === ''
          ? draft.lentQty : requireQty(input.qty, '归还数量');
        if (draft.lentQty < qty) {
          fail('借出登记只有 ' + draft.lentQty + ' 件，无法归还 ' + qty + ' 件');
        }
        draft.lentQty -= qty;
        draft.inStockQty += qty;
        return { qty: qty };
      }).then(function (res) {
        return writeTxn(T, {
          itemCode: code, type: 'return', qty: qty, operator: operator,
          purpose: input.purpose || '', fromStatus: res.fromStatus,
          toStatus: res.toStatus, snapshotInStock: res.after.inStockQty
        }).then(function () { return { ok: true, item: res.after }; });
      });
    });
  }

  /** 领用：耗材领走不还，在库件数减少并累计已领用 */
  function consume(input) {
    var code = requireText(input.code, '物品编码');
    var qty = requireQty(input.qty, '领用数量');
    var operator = requireText(input.operator, '操作人');

    return DB.runTx(['items', 'transactions'], 'readwrite', function (T) {
      return applyItemChange(T, code, function (draft) {
        if (draft.inStockQty < qty) {
          fail('在库只有 ' + draft.inStockQty + ' 件，不够领用 ' + qty + ' 件');
        }
        draft.inStockQty -= qty;
        draft.usedUpQty += qty;
        return { qty: qty };
      }).then(function (res) {
        return writeTxn(T, {
          itemCode: code, type: 'consume', qty: qty, operator: operator,
          borrower: input.taker || null, purpose: input.purpose || '',
          fromStatus: res.fromStatus, toStatus: res.toStatus, snapshotInStock: res.after.inStockQty
        }).then(function () { return { ok: true, item: res.after }; });
      });
    });
  }

  /** 送修：在库件数转到待修 */
  function sendRepair(input) {
    var code = requireText(input.code, '物品编码');
    var qty = requireQty(input.qty, '送修数量');
    var operator = requireText(input.operator, '操作人');

    return DB.runTx(['items', 'transactions'], 'readwrite', function (T) {
      return applyItemChange(T, code, function (draft) {
        if (draft.inStockQty < qty) {
          fail('在库只有 ' + draft.inStockQty + ' 件，不够送修 ' + qty + ' 件');
        }
        draft.inStockQty -= qty;
        draft.repairQty += qty;
        return { qty: qty };
      }).then(function (res) {
        return writeTxn(T, {
          itemCode: code, type: 'repair', qty: qty, operator: operator,
          purpose: input.purpose || '', fromStatus: res.fromStatus,
          toStatus: res.toStatus, snapshotInStock: res.after.inStockQty
        }).then(function () { return { ok: true, item: res.after }; });
      });
    });
  }

  /** 修好回库：待修件数回到在库 */
  function repairDone(input) {
    var code = requireText(input.code, '物品编码');
    var operator = requireText(input.operator, '操作人');

    return DB.runTx(['items', 'transactions'], 'readwrite', function (T) {
      var qty;
      return applyItemChange(T, code, function (draft) {
        qty = input.qty === undefined || input.qty === null || input.qty === ''
          ? draft.repairQty : requireQty(input.qty, '回库数量');
        if (draft.repairQty < qty) {
          fail('待修登记只有 ' + draft.repairQty + ' 件，无法回库 ' + qty + ' 件');
        }
        draft.repairQty -= qty;
        draft.inStockQty += qty;
        return { qty: qty };
      }).then(function (res) {
        return writeTxn(T, {
          itemCode: code, type: 'repair_done', qty: qty, operator: operator,
          purpose: input.purpose || '', fromStatus: res.fromStatus,
          toStatus: res.toStatus, snapshotInStock: res.after.inStockQty
        }).then(function () { return { ok: true, item: res.after }; });
      });
    });
  }

  /**
   * 采购到货：登记发票 + 生成物品并入库 + 标记申请已到货。
   * 四张表在同一个事务里写，任何一步失败都整体回滚。
   *
   * 第十三轮改动：发票号码、供应商名称**不再必填**（改由发票 PDF 承载票据信息），
   * 新增可选的 `invoiceFile`（{name, base64}）。PDF 本体怎么存由数据层决定：
   * 离线版直接存进行数据里（fileData），飞书版先传服务器、行里只留引用（fileRef）
   * —— 多维表格的文本格放不下整份 PDF，这个差异被隔离在数据层里面。
   */
  function arrive(input) {
    var requestId = n(input.requestId);
    if (!requestId) fail('缺少采购申请编号');
    var qty = requireQty(input.quantity, '到货数量');
    var invoiceNo = (input.invoiceNo || '').trim();
    var supplier = (input.supplier || '').trim();
    var amount = n(input.amount);
    if (!(amount > 0)) fail('发票金额必须大于 0');
    var operator = requireText(input.operator, '操作人');
    var file = input.invoiceFile || null;
    if (file) {
      if (!file.name || !file.base64) fail('发票附件不完整（缺文件名或内容）');
      // 数据层再拦一道类型：绕过表单（导入、手写调用）也塞不进非 PDF
      if (file.mime !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        fail('发票目前只支持 PDF 文件，收到的是「' + file.name + '」');
      }
    }

    return DB.get('purchaseRequests', requestId).then(function (request) {
      if (!request) fail('找不到采购申请 #' + requestId);
      if (request.status === 'arrived') fail('该申请已经确认过到货，不能重复入库');
      // 没同意的申请不能入库。这一条放在数据层而不是只放在界面上 ——
      // 界面上不画按钮只是"看起来不能点"，真正要挡住的是这一次调用。
      // 注意 Rules.approvalOf 对没有 approval 字段的老数据一律放行，
      // 所以这条新规则不会把引入审批之前的老单子卡住。
      if (!Rules.isApproved(request)) {
        fail(Rules.isPendingApproval(request)
          ? '这条采购申请还没经过管理员审批，不能入库'
          : '这条采购申请已被驳回，不能入库');
      }
      var identityMode = input.identityMode === 'single' ? 'single'
        : (input.identityMode === 'shared' ? 'shared' : null);

      // PDF 先落位（离线版是同步可得的引用；飞书版这一步会把文件传到服务器），
      // 成功之后才进事务 —— 上传失败就直接中止，不会留下没有附件的半套数据。
      return DB.saveInvoiceFile(file).then(function (stored) {
        return DB.get('categories', request.categoryId).then(function (category) {
          if (!category) fail('找不到大类：' + request.categoryId);
          if (!identityMode) identityMode = category.defaultIdentityMode || 'shared';
          var totalCodes = identityMode === 'single' ? qty : 1;
          return Rules.nextCodes(category, totalCodes).then(function (codes) {
            return DB.runTx(ALL_STORES, 'readwrite', function (T) {
              var created = DB.nowIso();
              var invoiceId;
              return T.add('invoices', Object.assign({
                purchaseRequestId: requestId,
                invoiceNo: invoiceNo,
                amount: amount,
                supplier: supplier,
                // invoiceDate 存的是**到货日期**（第十四周起界面上这么叫）。
                // 键名沿用旧名是为了不动历史数据，显示层统一由界面改口径。
                invoiceDate: input.invoiceDate || '',
                createdAt: created
              }, stored)).then(function (id) {
                invoiceId = id;
                var items = codes.map(function (code) {
                  return {
                    code: code,
                    name: request.name,
                    spec: request.spec || '',
                    categoryId: request.categoryId,
                    location: (input.location || '').trim(),
                    // 兵种从采购申请继承过来，预算与物品的口径才是一致的
                    troop: Rules.troopOf(request),
                    identityMode: identityMode,
                    totalQty: identityMode === 'single' ? 1 : qty,
                    inStockQty: identityMode === 'single' ? 1 : qty,
                    lentQty: 0,
                    repairQty: 0,
                    usedUpQty: 0,
                    status: 'in_stock',
                    safetyStock: null,
                    remark: (input.remark || '').trim(),
                    extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
                    purchaseRequestId: requestId,
                    invoiceId: invoiceId,
                    // 谁点的"确认到货"（第二十三轮）：和直接入库一样记在物品行上
                    addedBy: operator,
                    createdAt: created,
                    updatedAt: created
                  };
                });
                return items.reduce(function (chain, item) {
                  return chain.then(function (acc) {
                    var check = Rules.checkInvariant(item);
                    if (!check.ok) fail(check.message);
                    return T.add('items', item).then(function () {
                      return writeTxn(T, {
                        itemCode: item.code, type: 'inbound', qty: item.totalQty,
                        operator: operator, purpose: '采购到货入库',
                        fromStatus: null, toStatus: 'in_stock',
                        snapshotInStock: item.inStockQty,
                        purchaseRequestId: requestId, invoiceId: invoiceId
                      }).then(function () { acc.push(item); return acc; });
                    });
                  });
                }, Promise.resolve([]));
              }).then(function (items) {
                return T.put('purchaseRequests', Object.assign({}, request, {
                  status: 'arrived',
                  arrivedQty: qty,
                  invoiceId: invoiceId,
                  updatedAt: created
                })).then(function () {
                  return { ok: true, items: items, invoiceId: invoiceId, codes: items.map(function (i) { return i.code; }) };
                });
              });
            });
          });
        });
      });
    });
  }

  /**
   * 给一张已经登记过的发票补传 / 更换 PDF（第十四周）。
   *
   * 为什么需要它：发票常常比货晚到。到货登记那一刻手上可能只有金额和日期，
   * 硬要附件会让人卡在门口 —— 所以到货表单允许先空着，事后从这里补。
   *
   * 它**只更新发票记录的附件字段**：
   *   · 不动库存（东西早在到货时就入过库了）；
   *   · 不写流水（补一张票据不是一次出入库）。
   * 这两条是刻意的 —— 否则补传反而会把台账搅乱。
   *
   * 入参 { invoiceId, file }；file 与到货登记同格式：{ name, base64, mime, size }。
   * 已有附件时是"覆盖"，由界面负责先把这个后果说清楚。
   */
  function attachInvoiceFile(input) {
    var invoiceId = n(input && input.invoiceId);
    if (!invoiceId) fail('缺少发票编号');
    var file = (input && input.file) ? input.file : null;
    if (!file || !file.name || !file.base64) fail('没有选择发票文件');
    // 数据层再拦一道类型：绕过表单（导入、手写调用）也塞不进非 PDF
    if (file.mime !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      fail('发票目前只支持 PDF 文件，收到的是「' + file.name + '」');
    }

    return DB.get('invoices', invoiceId).then(function (invoice) {
      if (!invoice) fail('找不到发票 #' + invoiceId + '（可能已被删除）');
      // 先把文件落位（飞书版这一步会把 PDF 传到服务器），成功之后才改记录 ——
      // 上传失败就整体中止，不会留下"记录说换了、文件其实没有"的半套状态
      return DB.saveInvoiceFile(file).then(function (stored) {
        var next = Object.assign({}, invoice, stored, { updatedAt: DB.nowIso() });
        return DB.put('invoices', next).then(function () {
          return {
            ok: true, invoiceId: invoiceId, fileName: next.fileName,
            replaced: !!(invoice.fileRef || invoice.fileData)
          };
        });
      });
    });
  }

  /**
   * 借出台账：从流水推导"当前仍在借出状态"的清单。
   * 不单独存表，避免两边数据不一致。归还后自动从清单消失。
   *
   * **一次借出 = 一行**（按流水逐条排）。
   *
   * 原先这里是每个物品只留一行：`open[物品编码] = {...}`，后一次借出会把前一次**覆盖掉**。
   * 于是同款共用件（比如一箱电机、一批电池）先后借给两个人时，台账上只剩后借的那个，
   * 前一个人和数量凭空消失 —— 而物品上的 lentQty 又是实打实的 3 件。
   * 手机端扫码查物的"借给谁了"直接建立在台账上，这个洞会被放大成"扫码看到的信息是错的"。
   * 所以改成按笔记录，一行一笔未还的借出。
   *
   * 归还流水里没有"还的是哪一笔"这个信息，只能按**先借的先还**冲抵最早那笔未还的。
   * 对这个系统的用法（一批工具借出去、陆续还回来）来说，这个规则最贴近实际，
   * 也保证"全部归还后台账必然清空"（有测试守着）。
   */
  function lendLedger(today) {
    return DB.runTx(['transactions', 'items'], 'readonly', function (T) {
      return T.getAll('transactions').then(function (txns) {
        return T.getAll('items').then(function (items) {
          var byCode = {};
          items.forEach(function (i) { byCode[i.code] = i; });
          var sorted = txns.slice().sort(function (a, b) {
            return String(a.createdAt).localeCompare(String(b.createdAt)) || (a.id - b.id);
          });
          // 物品编码 → 该物品还没还完的借出，按借出先后排队
          var open = {};
          var ledger = [];
          sorted.forEach(function (t) {
            if (t.type === 'lend') {
              if (!open[t.itemCode]) open[t.itemCode] = [];
              open[t.itemCode].push({
                itemCode: t.itemCode,
                qty: n(t.qty),
                borrower: t.borrower || '',
                dueDate: t.dueDate || '',
                purpose: t.purpose || '',
                operator: t.operator || '',
                lentAt: t.createdAt,
                txnId: t.id,
                name: byCode[t.itemCode] ? byCode[t.itemCode].name : '(物品已不存在)',
                categoryId: byCode[t.itemCode] ? byCode[t.itemCode].categoryId : ''
              });
            } else if (t.type === 'return') {
              // 一次归还可能还掉好几笔（比如把几个人的都收回来一起登记）
              var left = n(t.qty);
              var queue = open[t.itemCode] || [];
              while (left > 0 && queue.length) {
                var head = queue[0];
                var take = left < head.qty ? left : head.qty;
                head.qty -= take;
                left -= take;
                if (head.qty <= 0) queue.shift();
              }
              if (!queue.length) delete open[t.itemCode];
            }
          });
          Object.keys(open).forEach(function (code) {
            open[code].forEach(function (row) {
              var info = Rules.overdueInfo(row.dueDate, today);
              row.overdue = info.overdue;
              row.overdueDays = info.days;
              ledger.push(row);
            });
          });
          // 超期的最前；同一天到期的按物品编码、再按借出先后排。
          // 加上后两级是为了**顺序稳定**：同一件东西借给两个人、到期日又填成同一天时，
          // 只比到期日的话谁在前取决于引擎的排序实现，页面看着会"随机跳"。
          ledger.sort(function (a, b) {
            if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
            return String(a.dueDate).localeCompare(String(b.dueDate)) ||
              String(a.itemCode).localeCompare(String(b.itemCode)) ||
              (a.txnId - b.txnId);
          });
          return ledger;
        });
      });
    });
  }

  global.FEVER = global.FEVER || {};
  /**
   * 新建一条采购申请。
   *
   * 放在数据层而不是让表单自己拼对象，是为了**保证新申请一定带 approval:'pending'**。
   * 这一条踩过坑：Rules.approvalOf 对没有 approval 字段的记录一律按「已同意」处理
   * （那是给引入审批之前的老数据留的兼容），所以表单里漏写这个字段，
   * 新提交的申请会被这条兼容规则悄悄放行 —— 界面上直接显示"已同意"，
   * 审批功能形同虚设，而且是**没有报错的**。集中在这里创建，就没有第二处会漏。
   *
   * 兵种必填：它是兵种预算的归类键，空着这笔钱就掉到「未指定」里去了。
   */
  /**
   * 把一份"申请输入"校验并整理成一行采购申请记录。
   *
   * **集中在这一个地方**，因为 formal 提交与「先存起来」的草稿必须同一套口径 ——
   * 上面那段注释记着一个真踩过的坑：approval 漏写会被兼容规则静默放行，
   * 界面上直接显示"已同意"、审批形同虚设，而且**不报错**。两处各写一遍迟早漏一处。
   *
   * extra.batchId 是打包提交的批次号（第十五轮）：单条提交时**不写这个键**，
   * 而不是写空串 —— 老数据没有这个字段，历史记录保持原样最干净。
   */
  function buildRequestRow(input, extra) {
    var categoryId = requireText(input.categoryId, '所属大类');
    var name = requireText(input.name, '物品名称');
    var applicant = requireText(input.applicant, '申请人');
    var troop = requireText(input.troop, '兵种');
    if (Rules.TROOPS.indexOf(troop) === -1) {
      fail('兵种只能是：' + Rules.TROOPS.join('、'));
    }
    var qty = requireQty(input.quantity, '申请数量');
    var budget = input.budget === undefined || input.budget === null ? '' : String(input.budget).trim();
    if (budget !== '') {
      // ⚠️ 不能写成 !(n(budget) >= 0)：本文件的 n() 会把"认不出来的字符串"折成 0，
      // 于是「乱写」这种输入会被当成 0 元通过校验，而且**原文照存**进预算字段 ——
      // 钱数里混进文本，后面所有汇总都只能读出 0，账面上却看不出来。
      // 这里必须老老实实判 NaN。
      var amount = Number(budget);
      if (isNaN(amount) || amount < 0) fail('预算要填一个不小于 0 的数字，或者留空');
    }
    var e = extra || {};
    var now = e.createdAt || DB.nowIso();

    var row = {
      categoryId: categoryId,
      troop: troop,
      name: name,
      spec: (input.spec || '').trim(),
      quantity: qty,
      budget: budget,
      // 购买链接（选填，第十四周）：过一遍 Rules.purchaseLink，
      // 挡掉伪协议并把没写协议的补成 https —— 它会被渲染成 <a href>，
      // 不能把原样的用户输入直接塞进去
      link: Rules.purchaseLink(input.link),
      purpose: (input.purpose || '').trim(),
      applicant: applicant,
      status: 'pending',
      approval: 'pending',
      createdAt: now,
      updatedAt: now
    };
    if (e.batchId) row.batchId = String(e.batchId);
    return row;
  }

  function createRequest(input) {
    return DB.add('purchaseRequests', buildRequestRow(input, {}));
  }

  /* ================= 打包提交（第十五轮） ================= */

  /**
   * 读「待提交清单」。入参 {key}（key 由 Rules.ownerKey 给出）；没有就是空数组。
   *
   * ⚠️ 这几个草稿接口都**只收一个对象**：对外暴露的 Ops 方法都过了 guard()，
   * 而 guard 只把**第一个**参数转给真正的实现 —— 写成 (key, input) 的话
   * input 永远是 undefined。要加参数就加进这个对象里。
   */
  function loadDraftCart(input) {
    var key = (input && input.key) || 'local';
    return DB.getSetting(Rules.draftCartKey(key), []).then(function (v) {
      return Array.isArray(v) ? v : [];
    });
  }

  /** 内部用（不对外暴露，所以可以多参数）：整份写回 */
  function saveDraftCart(key, list) {
    return DB.setSetting(Rules.draftCartKey(key), (list || []).slice());
  }

  /**
   * 往待提交清单里放一条。入参 {key, ...一条申请的字段}。
   * 走的是**和正式提交完全一样的校验**（buildRequestRow）—— 攒草稿时就拦住错数据，
   * 别让人填了十条，打包那一刻整批被拒。
   */
  function addToDraftCart(input) {
    var key = (input && input.key) || 'local';
    var row = buildRequestRow(input, {});
    return loadDraftCart({ key: key }).then(function (list) {
      var draft = {
        draftId: 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        categoryId: row.categoryId,
        troop: row.troop,
        name: row.name,
        spec: row.spec,
        quantity: row.quantity,
        budget: row.budget,
        link: row.link,
        purpose: row.purpose,
        applicant: row.applicant,
        createdAt: row.createdAt
      };
      list.push(draft);
      return saveDraftCart(key, list).then(function () {
        return { ok: true, draft: draft, count: list.length };
      });
    });
  }

  /** 从清单里删一条。入参 {key, draftId} */
  function removeFromDraftCart(input) {
    var key = (input && input.key) || 'local';
    var draftId = input && input.draftId;
    if (!draftId) fail('没有指定要删掉哪一条');
    return loadDraftCart({ key: key }).then(function (list) {
      var next = list.filter(function (d) { return d.draftId !== draftId; });
      return saveDraftCart(key, next).then(function () {
        return { ok: true, removed: list.length - next.length, count: next.length };
      });
    });
  }

  /**
   * 打包提交：把清单里**选中的**那几条一次性提交成正式申请，共享一个批次号。
   * 只清掉提交掉的，没钩的继续留在清单里。
   * applicant 传了就用它统一覆盖（打包提交时界面会问一次，默认取第一条的申请人）。
   */
  function submitDraftCart(input) {
    var key = input && input.key;
    var ids = (input && input.draftIds) || [];
    var want = {};
    ids.forEach(function (id) { want[id] = true; });
    var now = DB.nowIso();
    var batchId = Rules.newBatchId(now);
    var overrideApplicant = input && input.applicant ? requireText(input.applicant, '申请人') : '';

    return loadDraftCart({ key: key }).then(function (list) {
      var picked = list.filter(function (d) { return want[d.draftId]; });
      if (!picked.length) fail('没有选中要提交的物品');
      var rows = picked.map(function (d) {
        var src = overrideApplicant ? Object.assign({}, d, { applicant: overrideApplicant }) : d;
        return buildRequestRow(src, { batchId: batchId, createdAt: now });
      });
      return DB.runTx('purchaseRequests', 'readwrite', function (T) {
        return rows.reduce(function (chain, row) {
          return chain.then(function (acc) {
            return T.add('purchaseRequests', row).then(function (id) { acc.push(id); return acc; });
          });
        }, Promise.resolve([]));
      }).then(function (newIds) {
        var rest = list.filter(function (d) { return !want[d.draftId]; });
        return saveDraftCart(key, rest).then(function () {
          return { ok: true, batchId: batchId, ids: newIds, count: newIds.length };
        });
      });
    });
  }

  /**
   * 一批一起同意（第十五轮）。**一个事务写完**，别在飞书版打出 N 个往返。
   * 已经处理过（不是待审批）的跳过而不报错 —— 两个人同时点整批同意时，
   * 不该因为"有一条已经被别人批了"整批失败。
   */
  /**
   * 同意一批采购申请。
   *
   * ⚠️ 入参**只有 ids**。第二十三轮把这儿的第二个参数 `input` 删了 ——
   * 函数体从来没用过它，而且对外的 Ops 方法都过 guard()，而 guard 只透传第一个参数，
   * 所以它永远是 undefined。留着只会让人以为"能传决定（同意/驳回）进来"，
   * 结果传了也不生效。驳回走的是另一个入口。
   */
  function approveRequests(ids) {
    var list = (ids || []).map(function (v) { return n(v); }).filter(function (v) { return v > 0; });
    if (!list.length) fail('没有要同意的申请');
    var now = DB.nowIso();
    return DB.runTx('purchaseRequests', 'readwrite', function (T) {
      return list.reduce(function (chain, id) {
        return chain.then(function (acc) {
          return T.get('purchaseRequests', id).then(function (req) {
            if (!req || Rules.approvalOf(req) !== 'pending') return acc;
            return T.put('purchaseRequests', Object.assign({}, req, {
              approval: 'approved', approvedAt: now, updatedAt: now
            })).then(function () { acc.push(id); return acc; });
          });
        });
      }, Promise.resolve([]));
    }).then(function (done) {
      return { ok: true, approved: done, skipped: list.length - done.length };
    });
  }


  /* ================= 批量删除 ================= */

  /**
   * 批量删除的预演：先算清"哪些能删、哪些不能、哪些已经不在了"。
   * 只给确认框用，**只读**，不改任何东西。
   */
  function previewItemDeletion(codes) {
    var want = (codes || []).map(String);
    return DB.runTx(['items'], 'readonly', function (T) {
      return Promise.all(want.map(function (code) { return T.get('items', code); })).then(function (rows) {
        var found = rows.filter(function (r) { return !!r; });
        var part = Rules.partitionDeletable(found);
        return {
          deletable: part.deletable,
          blocked: part.blocked,
          missing: want.length - found.length
        };
      });
    });
  }

  /**
   * 批量删除物品：**整批只用一个事务** —— 删物品和写「删除记录」一起提交。
   *
   * 为什么必须整批一个事务：
   *   · 「删除记录」是**读当前 → 合并 → 写回**的读改写。逐条删就是每件一次读改写，
   *     几次读改写交错执行时，后写的会把先写的整份数组覆盖掉 —— 账直接丢。
   *     放进同一个事务里，读一次、合并一次、写一次，才能正确累加。
   *     （远程数据层确实会把同一小段时间内的写合并成一个请求，所以"少几次往返"
   *      并不是这里的理由；真正的理由是上面这条，以及下面这条原子性。）
   *   · 删除与留痕同生共死：要么这一批全删掉并且账都记上，要么一件都不动。
   *     不会留下"删了但没记"或"记了但没删"的中间状态；本地镜像也不会出现
   *     "删了一半"的中间态给界面看到。
   *     （单条删除走 actions.js 的 deleteRecord，那里刻意允许"删了但没记上"——
   *      因为删除已经发生，不能回头谎报"删除失败"；批量这边一开始就在同一个事务里，
   *      所以可以做到"记不上就整体回滚"，对审计更干净。）
   *
   * 会**重新判断一次**能不能删：从确认框弹出到点下确认之间，可能刚好有人
   * 把东西借出去了。所以返回的 removed 才是真实结果，不能拿预演当结论。
   *
   * 借出中 / 待修中的是**跳过**而不是让整批失败 —— 整批失败的话使用者只能
   * 一件件试，反而更容易在反复重选中删错。
   *
   * 返回 { removed: [编码...], blocked: [{item, reason}], missing: 数量 }
   */
  function deleteItemsBatch(codes) {
    var want = (codes || []).map(String);
    return DB.runTx(['items', 'settings'], 'readwrite', function (T) {
      return Promise.all(want.map(function (code) { return T.get('items', code); })).then(function (rows) {
        var found = rows.filter(function (r) { return !!r; });
        var part = Rules.partitionDeletable(found);

        // 删除记录与单条删除共用 buildDeletionEntry / mergeDeleteLog，
        // 所以两种路径留下的账长得一模一样，不会一个地方改了另一边没跟上。
        var entries = part.deletable.map(function (item) {
          return Rules.buildDeletionEntry({
            store: 'items',
            key: item.code,
            label: item.code + ' ' + item.name,
            reason: '批量删除',
            snapshot: item
          });
        });

        return T.get('settings', Rules.DELETE_LOG_KEY).then(function (row) {
          var current = (row && Array.isArray(row.value)) ? row.value : [];

          // 先删干净，最后写一次删除记录
          return part.deletable.reduce(function (chain, item) {
            return chain.then(function () { return T.remove('items', item.code); });
          }, Promise.resolve()).then(function () {
            if (!entries.length) return null;
            return T.put('settings', {
              key: Rules.DELETE_LOG_KEY,
              value: Rules.mergeDeleteLog(current, entries),
              updatedAt: DB.nowIso()
            });
          }).then(function () {
            return {
              removed: part.deletable.map(function (i) { return i.code; }),
              blocked: part.blocked,
              missing: want.length - found.length
            };
          });
        });
      });
    });
  }

  /**
   * 批量删除出入库流水的**预演**（第二十一轮）：只读，不删任何东西。
   * 存在的都会列出来；不在的（可能刚被别人删了）只报个数。
   */
  function previewTransactionDeletion(ids) {
    var want = (ids || []).map(function (v) { return n(v); }).filter(function (v) { return v > 0; });
    if (!want.length) return Promise.resolve({ deletable: [], missing: 0 });
    return DB.runTx(['transactions'], 'readonly', function (T) {
      return Promise.all(want.map(function (id) { return T.get('transactions', id); })).then(function (rows) {
        var found = rows.filter(function (r) { return !!r; });
        return { deletable: found, missing: want.length - found.length };
      });
    });
  }

  /**
   * 批量删除出入库流水：**整批一个事务**，删流水与写「删除记录」一起提交。
   *
   * 与「批量删除物品」完全同一套做法与理由（见 deleteItemsBatch 的注释）：
   * 删除记录是"读当前 → 合并 → 写回"的读改写，逐条删会互相覆盖；
   * 放一个事务里才能做到"要么这批全删且账都记上，要么一条都不动"。
   *
   * ⚠️ **与单条删除口径一致：不会改动物品的库存数量。**
   * 流水是账本，不是库存；删一条流水不等于把那次出入库撤销。
   * 真要改数量，应该另做一次出入库登记 —— 这一点在确认框里对使用者写明了。
   *
   * 不像物品那样有"能删/不能删"的分流：流水没有借出/待修那类前置状态，
   * 只有"已经被别人删了"这种竞态，按 missing 如实报出去。
   */
  function deleteTransactions(ids) {
    var want = (ids || []).map(function (v) { return n(v); }).filter(function (v) { return v > 0; });
    if (!want.length) fail('没有选中要删除的流水');
    return DB.runTx(['transactions', 'settings'], 'readwrite', function (T) {
      return Promise.all(want.map(function (id) { return T.get('transactions', id); })).then(function (rows) {
        var found = rows.filter(function (r) { return !!r; });
        var entries = found.map(function (t) {
          return Rules.buildDeletionEntry({
            store: 'transactions',
            key: t.id,
            label: Rules.txnLabel(t),
            reason: '批量删除',
            snapshot: t
          });
        });

        return T.get('settings', Rules.DELETE_LOG_KEY).then(function (row) {
          var current = (row && Array.isArray(row.value)) ? row.value : [];
          // 先删干净，最后写一次删除记录
          return found.reduce(function (chain, t) {
            return chain.then(function () { return T.remove('transactions', t.id); });
          }, Promise.resolve()).then(function () {
            if (!entries.length) return null;
            return T.put('settings', {
              key: Rules.DELETE_LOG_KEY,
              value: Rules.mergeDeleteLog(current, entries),
              updatedAt: DB.nowIso()
            });
          }).then(function () {
            return found.map(function (t) { return t.id; });
          });
        });
      });
    }).then(function (removed) {
      return { ok: true, removed: removed, missing: want.length - removed.length };
    });
  }

  global.FEVER.Ops = {
    previewItemDeletion: previewItemDeletion,
    deleteItemsBatch: guard(deleteItemsBatch),
    previewTransactionDeletion: guard(previewTransactionDeletion),
    deleteTransactions: guard(deleteTransactions),
    inbound: guard(inbound),
    lend: guard(lend),
    giveBack: guard(giveBack),
    consume: guard(consume),
    sendRepair: guard(sendRepair),
    repairDone: guard(repairDone),
    arrive: guard(arrive),
    attachInvoiceFile: guard(attachInvoiceFile),
    changeIdentity: guard(changeIdentity),
    identityMergeCandidates: guard(identityMergeCandidates),
    createRequest: guard(createRequest),
    // 打包提交（第十五轮）
    loadDraftCart: guard(loadDraftCart),
    addToDraftCart: guard(addToDraftCart),
    removeFromDraftCart: guard(removeFromDraftCart),
    submitDraftCart: guard(submitDraftCart),
    approveRequests: guard(approveRequests),
    // 标签打印记录（第十九轮）
    markPrinted: guard(markPrinted),
    printedBeforeCount: printedBeforeCount,
    lendLedger: lendLedger
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Ops;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
