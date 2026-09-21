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
   */
  function inbound(input) {
    var categoryId = requireText(input.categoryId, '所属大类');
    var name = requireText(input.name, '物品名称');
    var qty = requireQty(input.quantity, '入库数量');
    var identityMode = input.identityMode === 'single' ? 'single' : 'shared';
    var operator = requireText(input.operator, '操作人');

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
              identityMode: identityMode,
              totalQty: identityMode === 'single' ? 1 : qty,
              inStockQty: identityMode === 'single' ? 1 : qty,
              lentQty: 0,
              repairQty: 0,
              usedUpQty: 0,
              status: 'in_stock',
              safetyStock: input.safetyStock === '' || input.safetyStock === undefined || input.safetyStock === null
                ? null : n(input.safetyStock),
              remark: (input.remark || '').trim(),
              extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
              purchaseRequestId: input.purchaseRequestId || null,
              invoiceId: input.invoiceId || null,
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
   */
  function arrive(input) {
    var requestId = n(input.requestId);
    if (!requestId) fail('缺少采购申请编号');
    var qty = requireQty(input.quantity, '到货数量');
    var invoiceNo = requireText(input.invoiceNo, '发票号码');
    var supplier = requireText(input.supplier, '供应商名称');
    var amount = n(input.amount);
    if (!(amount > 0)) fail('发票金额必须大于 0');
    var operator = requireText(input.operator, '操作人');

    return DB.get('purchaseRequests', requestId).then(function (request) {
      if (!request) fail('找不到采购申请 #' + requestId);
      if (request.status === 'arrived') fail('该申请已经确认过到货，不能重复入库');
      var identityMode = input.identityMode === 'single' ? 'single'
        : (input.identityMode === 'shared' ? 'shared' : null);

      return DB.get('categories', request.categoryId).then(function (category) {
        if (!category) fail('找不到大类：' + request.categoryId);
        if (!identityMode) identityMode = category.defaultIdentityMode || 'shared';
        var totalCodes = identityMode === 'single' ? qty : 1;
        return Rules.nextCodes(category, totalCodes).then(function (codes) {
          return DB.runTx(ALL_STORES, 'readwrite', function (T) {
            var created = DB.nowIso();
            var invoiceId;
            return T.add('invoices', {
              purchaseRequestId: requestId,
              invoiceNo: invoiceNo,
              amount: amount,
              supplier: supplier,
              invoiceDate: input.invoiceDate || '',
              createdAt: created
            }).then(function (id) {
              invoiceId = id;
              var items = codes.map(function (code) {
                return {
                  code: code,
                  name: request.name,
                  spec: request.spec || '',
                  categoryId: request.categoryId,
                  location: (input.location || '').trim(),
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
  }

  /**
   * 借出台账：从流水推导"当前仍在借出状态"的清单。
   * 不单独存表，避免两边数据不一致。归还后自动从清单消失。
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
          var open = {};
          var ledger = [];
          sorted.forEach(function (t) {
            if (t.type === 'lend') {
              open[t.itemCode] = {
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
              };
            } else if (t.type === 'return' && open[t.itemCode]) {
              open[t.itemCode].qty -= n(t.qty);
              if (open[t.itemCode].qty <= 0) delete open[t.itemCode];
            }
          });
          Object.keys(open).forEach(function (code) {
            var row = open[code];
            var info = Rules.overdueInfo(row.dueDate, today);
            row.overdue = info.overdue;
            row.overdueDays = info.days;
            ledger.push(row);
          });
          ledger.sort(function (a, b) {
            if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
            return String(a.dueDate).localeCompare(String(b.dueDate));
          });
          return ledger;
        });
      });
    });
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Ops = {
    inbound: guard(inbound),
    lend: guard(lend),
    giveBack: guard(giveBack),
    consume: guard(consume),
    sendRepair: guard(sendRepair),
    repairDone: guard(repairDone),
    arrive: guard(arrive),
    lendLedger: lendLedger
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Ops;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
