/**
 * FEver 战队物资管理 —— 统计与关联查询
 *
 * 大类统计、流水筛选、单据互查都在这里。
 * 所有统计都是"实时从明细算出来"，不另存一份汇总，避免两边对不上。
 */
(function (global) {
  'use strict';

  var DB = global.FEVER && global.FEVER.DB ? global.FEVER.DB : (typeof require === 'function' ? require('./db.js') : null);
  var Rules = global.FEVER && global.FEVER.Rules ? global.FEVER.Rules : (typeof require === 'function' ? require('./rules.js') : null);

  function num(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  /** 一次读齐所有表，供界面渲染用（只读，不写） */
  function snapshot() {
    return DB.runTx(DB.STORES, 'readonly', function (T) {
      return DB.STORES.reduce(function (chain, name) {
        return chain.then(function (acc) {
          return T.getAll(name).then(function (rows) { acc[name] = rows; return acc; });
        });
      }, Promise.resolve({}));
    });
  }

  /**
   * 四个大类各自的指标。
   * 每个大类都会带上"该类自己关心的东西"，不是同一个模板换名字。
   */
  function categorySummaries(today) {
    return snapshot().then(function (data) {
      var now = today || new Date();
      return data.categories.slice().sort(function (a, b) {
        return num(a.sortOrder) - num(b.sortOrder);
      }).map(function (cat) {
        var items = data.items.filter(function (i) { return i.categoryId === cat.id; });
        var pending = data.purchaseRequests.filter(function (p) {
          return p.categoryId === cat.id && (p.status === 'pending' || p.status === 'ordered');
        });
        var reminders = [];
        items.forEach(function (i) {
          Rules.remindersFor(i, cat, now).forEach(function (r) {
            reminders.push({ code: i.code, name: i.name, kind: r.kind, level: r.level, text: r.text });
          });
        });
        return {
          category: cat,
          items: items,
          itemCount: items.length,
          totalQty: items.reduce(function (s, i) { return s + num(i.totalQty); }, 0),
          inStockQty: items.reduce(function (s, i) { return s + num(i.inStockQty); }, 0),
          lentQty: items.reduce(function (s, i) { return s + num(i.lentQty); }, 0),
          repairQty: items.reduce(function (s, i) { return s + num(i.repairQty); }, 0),
          itemKinds: items.length,
          lentKinds: items.filter(function (i) { return num(i.lentQty) > 0; }).length,
          repairKinds: items.filter(function (i) { return num(i.repairQty) > 0; }).length,
          lowStock: items.filter(function (i) {
            return i.safetyStock !== null && i.safetyStock !== undefined && i.safetyStock !== '' &&
              num(i.inStockQty) < num(i.safetyStock);
          }).length,
          pendingPurchases: pending.length,
          reminders: reminders
        };
      });
    });
  }

  /** 按条件筛选流水，最新的排在前面 */
  function filterTransactions(filters) {
    var f = filters || {};
    return DB.runTx(['transactions', 'items'], 'readonly', function (T) {
      return T.getAll('transactions').then(function (rows) {
        return T.getAll('items').then(function (items) {
          var nameOf = {};
          items.forEach(function (i) { nameOf[i.code] = i.name; });
          var out = rows.filter(function (t) {
            if (f.itemCode && t.itemCode !== f.itemCode) return false;
            if (f.type && t.type !== f.type) return false;
            if (f.operator && String(t.operator || '').indexOf(f.operator) === -1) return false;
            if (f.from && String(t.createdAt) < f.from) return false;
            if (f.to && String(t.createdAt).slice(0, 10) > f.to) return false;
            if (f.keyword) {
              var hay = [t.itemCode, t.operator, t.borrower, t.purpose, nameOf[t.itemCode]].join(' ');
              if (hay.indexOf(f.keyword) === -1) return false;
            }
            return true;
          });
          out.sort(function (a, b) {
            return String(b.createdAt).localeCompare(String(a.createdAt)) || (num(b.id) - num(a.id));
          });
          return out.map(function (t) {
            return Object.assign({}, t, { itemName: nameOf[t.itemCode] || '(物品已不存在)' });
          });
        });
      });
    });
  }

  /** 某张发票到货生成了哪些物品 */
  function itemsOfInvoice(invoiceId) {
    return DB.runTx('items', 'readonly', function (T) {
      return T.getAll('items').then(function (items) {
        return items.filter(function (i) { return i.invoiceId === invoiceId; });
      });
    });
  }

  /** 某张发票对应的采购申请，找不到时明确告知已删除 */
  function requestOfInvoice(invoice) {
    if (!invoice || !invoice.purchaseRequestId) return Promise.resolve({ request: null, missing: false });
    return DB.get('purchaseRequests', invoice.purchaseRequestId).then(function (req) {
      return { request: req || null, missing: !req };
    });
  }

  /**
   * 一个物品的全部关联信息：大类、来源采购申请、来源发票。
   * 上游被删掉时用 missing 标记，界面显示「来源已删除」，不报错。
   */
  function itemContext(code) {
    return DB.runTx(['items', 'categories', 'purchaseRequests', 'invoices', 'transactions'], 'readonly', function (T) {
      return T.get('items', code).then(function (item) {
        if (!item) return null;
        return T.get('categories', item.categoryId).then(function (category) {
          var pReq = item.purchaseRequestId ? T.get('purchaseRequests', item.purchaseRequestId) : Promise.resolve(null);
          var pInv = item.invoiceId ? T.get('invoices', item.invoiceId) : Promise.resolve(null);
          return Promise.all([pReq, pInv, T.getByIndex('transactions', 'itemCode', code)]).then(function (arr) {
            var txns = arr[2].slice().sort(function (a, b) {
              return String(b.createdAt).localeCompare(String(a.createdAt)) || (num(b.id) - num(a.id));
            });
            return {
              item: item,
              category: category || null,
              purchaseRequest: arr[0] || null,
              purchaseMissing: !!item.purchaseRequestId && !arr[0],
              invoice: arr[1] || null,
              invoiceMissing: !!item.invoiceId && !arr[1],
              transactions: txns
            };
          });
        });
      });
    });
  }

  function csvCell(v) {
    var s = (v === undefined || v === null) ? '' : String(v);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(headers, rows) {
    var lines = [headers.map(csvCell).join(',')];
    rows.forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    return lines.join('\r\n');
  }

  /** 导出表格数据供使用者自行存档或交给 Excel */
  function itemsCsv(items, categories) {
    var catName = {};
    (categories || []).forEach(function (c) { catName[c.id] = c.name; });
    return toCsv(
      ['编码', '名称', '规格', '大类', '存放位置', '总件数', '在库', '借出', '待修', '已领用', '状态', '安全库存', '身份模式'],
      items.map(function (i) {
        return [i.code, i.name, i.spec, catName[i.categoryId] || i.categoryId, i.location,
          num(i.totalQty), num(i.inStockQty), num(i.lentQty), num(i.repairQty), num(i.usedUpQty),
          Rules.STATUS_NAMES[i.status] || i.status, i.safetyStock === null || i.safetyStock === undefined ? '' : i.safetyStock,
          i.identityMode === 'single' ? '单独建身份' : '同款共用'];
      })
    );
  }

  function transactionsCsv(rows) {
    return toCsv(
      ['时间', '类型', '编码', '名称', '数量', '操作人', '借用人', '预计归还', '用途', '在库快照'],
      rows.map(function (t) {
        return [t.createdAt, Rules.TXN_TYPES[t.type] || t.type, t.itemCode, t.itemName || '',
          num(t.qty), t.operator, t.borrower, t.dueDate, t.purpose, t.snapshotInStock];
      })
    );
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Stats = {
    snapshot: snapshot,
    categorySummaries: categorySummaries,
    filterTransactions: filterTransactions,
    itemsOfInvoice: itemsOfInvoice,
    requestOfInvoice: requestOfInvoice,
    itemContext: itemContext,
    itemsCsv: itemsCsv,
    transactionsCsv: transactionsCsv
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Stats;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
