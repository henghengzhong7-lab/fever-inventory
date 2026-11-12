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

  /**
   * 一个批次（一次打包提交）的发票情况（第十六轮）。
   *
   * 纯函数，**批次页与采购申请列表共用这一套口径** —— 两处各算一遍的话，
   * 迟早会出现"批次页说 3 张、列表页说 2 张"这种对不上的情况。
   *
   * 返回：
   *   { invoiceIds,   这一批有附件的发票（可直接打包下载的那些）
   *     total,        这一批登记过的发票总数
   *     requests,     这一批的申请条数
   *     arrived,      其中已到货的条数
   *     missingNames, 已到货但还没上传发票的申请人（去重、保持出现顺序）
   *     pendingNames, 还没到货的申请人 }
   */
  function batchInvoiceInfo(requests, invoices, batchId) {
    var id = String(batchId === undefined || batchId === null ? '' : batchId);
    var reqs = (requests || []).filter(function (r) { return String(r.batchId || '') === id; });
    var invs = invoices || [];
    var byReq = {};
    invs.forEach(function (iv) { byReq[String(iv.purchaseRequestId)] = iv; });

    var invoiceIds = [];
    var total = 0;
    var arrived = 0;
    var missingNames = [];
    var pendingNames = [];

    function pushName(list, name) {
      var v = String(name || '').trim();
      if (v && list.indexOf(v) === -1) list.push(v);
    }

    reqs.forEach(function (r) {
      var iv = byReq[String(r.id)];
      if (iv) {
        total += 1;
        if (iv.fileRef || iv.fileData) invoiceIds.push(iv.id);
        else if (r.status === 'arrived') pushName(missingNames, r.applicant);
      }
      if (r.status === 'arrived') arrived += 1;
      else if (r.status !== 'canceled') pushName(pendingNames, r.applicant);
    });

    return {
      invoiceIds: invoiceIds,
      total: total,
      requests: reqs.length,
      arrived: arrived,
      missingNames: missingNames,
      pendingNames: pendingNames
    };
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

  /* ================= 兵种预算 ================= */

  var BUDGET_KEY = 'budgetByTroop';

  /** 没选兵种的申请（老数据）归到这一档。空字符串是它在界面上的名字，也是汇总的键 */
  var UNSPECIFIED = '未指定';

  var RANGE_NAMES = { all: '全部', year: '本年', quarter: '本季', month: '本月' };

  /** 时间范围的起点（ISO 字符串）。'all' 返回空串表示不限 */
  function rangeStart(range, nowIso) {
    if (!range || range === 'all') return '';
    var d = nowIso ? new Date(nowIso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var y = d.getFullYear();
    if (range === 'year') return new Date(y, 0, 1).toISOString();
    if (range === 'quarter') return new Date(y, Math.floor(d.getMonth() / 3) * 3, 1).toISOString();
    if (range === 'month') return new Date(y, d.getMonth(), 1).toISOString();
    return '';
  }

  /**
   * 兵种预算汇总。纯函数：只吃数据和参数，不读库、不碰 DOM，方便直接断言。
   *
   * 口径（和需求一起定下来的，改之前先想清楚为什么）：
   *   · **已用（spent）= 审批通过的申请金额 + 直接入库的物品总价**。
   *     第二十五轮之前只算申请，于是「直接入库时填了总价」的东西（很多小件都这么进来）
   *     一分钱都没进预算 —— 使用者看到的就是"我明明花了钱，预算里没体现"。
   *     两档分开存：`used`（已同意申请）与 `direct`（直接入库），`spent = used + direct`，
   *     页面上显示 spent，明细查得到。
   *   · 待审批的不占预算 —— 管理员点「同意」那一刻才扣。剩余 = 预算 − spent。
   *   · 已取消、已驳回的不算，钱不会花出去。
   *   · 另外单列「已到货实际」（登记发票的金额），它和「已用」的差额就是
   *     申请预算和真实花销的偏差，是给管理员看的，不参与剩余额度的计算。
   *   · 没选兵种的老申请归到「未指定」一档，**照样计入总额** ——
   *     宁可多显示一行，也不要"明细加起来不等于总数"。
   *
   * @param {Array} requests 全部采购申请
   * @param {Object} budgets  兵种 → 预算额度（元），来自 settings.budgetByTroop
   * @param {String} range    'all' | 'year' | 'quarter' | 'month'
   * @param {String} nowIso   当前时间，传进来是为了让测试可控
   * @param {Array} invoices  全部发票，用来算「已到货实际」
   */
  function budgetSummary(requests, budgets, range, nowIso, invoices, items) {
    var map = budgets && typeof budgets === 'object' ? budgets : {};
    var start = rangeStart(range, nowIso);

    // 发票金额按来源申请归集。一张申请对应一张发票（到货时生成），
    // 万一有多张就累加 —— 多退少补、分开开票都算真实花销。
    var actualByReq = {};
    (invoices || []).forEach(function (iv) {
      if (!iv || iv.purchaseRequestId === undefined || iv.purchaseRequestId === null) return;
      var k = String(iv.purchaseRequestId);
      actualByReq[k] = num(actualByReq[k]) + num(iv.amount);
    });

    var rows = {};
    function rowOf(troop) {
      if (!rows[troop]) {
        rows[troop] = {
          troop: troop,
          budget: num(map[troop]),
          used: 0,        // 已同意申请的金额
          direct: 0,      // 直接入库买的东西（物品总价，按物品上的兵种归集）
          pending: 0,     // 待审批（不占预算，只做参考）
          actual: 0,      // 已到货的实际发票金额
          requests: 0,
          approvedCount: 0,
          pendingCount: 0
        };
      }
      return rows[troop];
    }

    // 先把配了额度的兵种都建出来，哪怕一条申请都没有 ——
    // 否则「这个兵种我明明给了预算，页面上却看不到」会让人以为设置没保存
    Object.keys(map).forEach(function (t) { if (t) rowOf(t); });

    (requests || []).forEach(function (r) {
      if (!r) return;
      if (r.status === 'canceled') return;             // 取消/驳回的钱不会花
      if (start && String(r.createdAt || '') < start) return;

      var troop = Rules.troopOf(r) || UNSPECIFIED;
      var row = rowOf(troop);
      var amount = num(r.budget);

      row.requests += 1;
      if (Rules.approvalOf(r) === 'approved') {
        row.used += amount;
        row.approvedCount += 1;
        if (r.status === 'arrived') {
          var paid = actualByReq[String(r.id)];
          // 到货了但还没登记发票金额时，先按申请预算记，别让这一笔凭空消失
          row.actual += paid === undefined ? amount : paid;
        }
      } else if (Rules.approvalOf(r) === 'pending') {
        row.pending += amount;
        row.pendingCount += 1;
      }
    });

    // 直接入库的物品：按它自己的兵种把钱记上（第二十五轮）
    (items || []).forEach(function (it) {
      if (!it) return;
      if (start && String(it.createdAt || '') < start) return;
      var price = num(it.totalPrice);
      if (price <= 0) return;                       // 没填价、或填了 0 的，不算花销
      var t = Rules.troopOf(it) || UNSPECIFIED;
      rowOf(t).direct += price;
    });

    var list = Object.keys(rows).map(function (k) { return rows[k]; });
    // 排序：有预算的先按兵种标准顺序，然后「未指定」永远垫底
    list.sort(function (a, b) {
      if (a.troop === UNSPECIFIED) return 1;
      if (b.troop === UNSPECIFIED) return -1;
      var ia = Rules.TROOPS.indexOf(a.troop);
      var ib = Rules.TROOPS.indexOf(b.troop);
      if (ia === -1) ia = 999;
      if (ib === -1) ib = 999;
      return ia - ib;
    });

    list.forEach(function (r) {
      r.spent = r.used + r.direct;                  // 已用 = 申请 + 直接入库
      r.remaining = r.budget - r.spent;
      r.usage = r.budget > 0 ? r.spent / r.budget : null;
      // 只有"真的配了预算"的才算超支。「未指定」永远没有额度，
      // 把它算进超支数会把告警数量灌水，而它的问题另有提示。
      r.over = r.troop !== UNSPECIFIED && r.budget > 0 && r.spent > r.budget;
    });

    var total = {
      budget: 0, used: 0, direct: 0, spent: 0, pending: 0, actual: 0,
      remaining: 0, over: 0, requests: 0, unspecifiedUsed: 0, unspecifiedCount: 0
    };
    list.forEach(function (r) {
      total.budget += r.budget;
      total.used += r.used;
      total.direct += r.direct;
      total.pending += r.pending;
      total.actual += r.actual;
      total.requests += r.requests;
      if (r.over) total.over += 1;
      if (r.troop === UNSPECIFIED) { total.unspecifiedUsed += r.spent; total.unspecifiedCount += r.requests; }
    });
    total.spent = total.used + total.direct;
    total.remaining = total.budget - total.spent;
    total.usage = total.budget > 0 ? total.spent / total.budget : null;

    return { rows: list, total: total, range: range || 'all', rangeName: RANGE_NAMES[range || 'all'] };
  }

  function money2(v) { return num(v).toFixed(2); }

  /**
   * 兵种预算导出（CSV，三段式）。和 budgetSummary 同口径、同样是纯函数：
   *
   *   第一段 兵种预算总表 —— 每个兵种一行，带「消费情况」标记
   *           （超支 / 已消费 / 未消费 / 无预算记录），一眼分出花没花。
   *   第二段 已消费明细 —— 每条已同意的申请一行：谁申请的、多少钱、到货实际。
   *           这是"已经消费的兵种的清单"落到每一笔的粒度。
   *   第三段 未消费预算 —— 还剩额度的兵种各剩多少（含分文未动的）。
   *
   * 口径提醒：已用 = 已同意的申请金额 **+ 直接入库的物品总价**（第二十五轮）；
   * 待审批不占预算；取消/驳回不算。
   */
  function budgetCsv(requests, budgets, range, nowIso, invoices, items) {
    var summary = budgetSummary(requests, budgets, range, nowIso, invoices, items);
    var parts = [];

    // —— 第一段：总表 ——
    parts.push(toCsv(
      // 多一列「直接入库」，把「已用」的构成摊开 —— 不然金额对不上会让人怀疑算错了
      ['兵种', '预算额度', '已用', '其中·已同意申请', '其中·直接入库', '剩余', '使用率', '待审批金额', '待审批条数', '已到货实际', '申请数', '消费情况'],
      summary.rows.map(function (r) {
        var state;
        if (r.over) state = '超支';
        else if (r.spent > 0) state = '已消费';
        else if (r.budget > 0) state = '未消费';
        else state = '无预算记录';
        return [r.troop, money2(r.budget), money2(r.spent), money2(r.used), money2(r.direct), money2(r.remaining),
          r.usage === null ? '' : Math.round(r.usage * 100) + '%',
          money2(r.pending), r.pendingCount, money2(r.actual), r.requests, state];
      })
    ));

    // —— 第二段：已消费明细（已同意的申请逐条列出）——
    // 发票实际金额按来源申请归集，与 budgetSummary 同一套算法
    var actualByReq = {};
    (invoices || []).forEach(function (iv) {
      if (!iv || iv.purchaseRequestId === undefined || iv.purchaseRequestId === null) return;
      actualByReq[String(iv.purchaseRequestId)] = num(actualByReq[String(iv.purchaseRequestId)]) + num(iv.amount);
    });
    var start = rangeStart(range, nowIso);
    var consumed = (requests || []).filter(function (r) {
      return r && r.status !== 'canceled' && Rules.approvalOf(r) === 'approved' &&
        (!start || String(r.createdAt || '') >= start);
    }).sort(function (a, b) {
      return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || (num(a.id) - num(b.id));
    });
    var detailRows = consumed.map(function (r) {
      var paid = actualByReq[String(r.id)];
      return [Rules.troopOf(r) || UNSPECIFIED, r.id, r.name, r.applicant || '',
        num(r.quantity), money2(r.budget),
        paid === undefined ? money2(r.budget) : money2(paid),
        r.status === 'arrived' ? '已到货' : '已同意未到货'];
    });
    if (!detailRows.length) detailRows = [['（还没有已同意的申请）', '', '', '', '', '', '', '']];
    parts.push('');
    parts.push('【已消费明细】');
    parts.push(toCsv(['兵种', '申请编号', '物品名称', '申请人', '数量', '申请金额', '到货实际', '状态'], detailRows));

    // —— 第三段：未消费预算 ——
    var unused = summary.rows.filter(function (r) { return r.budget > 0 && r.remaining > 0; })
      .map(function (r) { return [r.troop, money2(r.budget), money2(r.used), money2(r.remaining)]; });
    if (!unused.length) unused = [['（所有兵种的预算都已用完）', '', '', '']];
    parts.push('');
    parts.push('【未消费预算】');
    parts.push(toCsv(['兵种', '预算额度', '已用', '剩余'], unused));

    return parts.join('\r\n');
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Stats = {
    snapshot: snapshot,
    categorySummaries: categorySummaries,
    filterTransactions: filterTransactions,
    itemsOfInvoice: itemsOfInvoice,
    requestOfInvoice: requestOfInvoice,
    batchInvoiceInfo: batchInvoiceInfo,
    itemContext: itemContext,
    itemsCsv: itemsCsv,
    transactionsCsv: transactionsCsv,
    budgetSummary: budgetSummary,
    budgetCsv: budgetCsv,
    BUDGET_KEY: BUDGET_KEY,
    UNSPECIFIED: UNSPECIFIED,
    RANGE_NAMES: RANGE_NAMES,
    // 预算页要"点进申请数看是哪几次"，采购申请页据此把时间范围预置成同一个周期，
    // 两边必须用同一套口径 —— 所以把 rangeStart 也导出去，别各写一份
    rangeStart: rangeStart
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Stats;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
