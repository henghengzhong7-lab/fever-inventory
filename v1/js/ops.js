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
    // 兵种必填（第十三轮）：兵种是预算的归类键，直接入库的件不选兵种，
    // 那笔钱就会从兵种预算里静默漏掉 —— 跟采购申请一样不许空着。
    // 认不出的值 normalizeTroop 仍兜到「其他」，这里只拦「根本没选」。
    var troop = Rules.normalizeTroop(input.troop);
    if (!troop) fail('请选择兵种（重装、步兵、哨兵……至少选一个，兵种预算按它汇总）');

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
  function createRequest(input) {
    var categoryId = requireText(input.categoryId, '所属大类');
    var name = requireText(input.name, '物品名称');
    var applicant = requireText(input.applicant, '申请人');
    var troop = requireText(input.troop, '兵种');
    if (Rules.TROOPS.indexOf(troop) === -1) {
      fail('兵种只能是：' + Rules.TROOPS.join('、'));
    }
    var qty = requireQty(input.quantity, '申请数量');
    var budget = input.budget === undefined || input.budget === null ? '' : String(input.budget).trim();
    if (budget !== '' && !(n(budget) >= 0)) fail('预算要填一个不小于 0 的数字');
    var now = DB.nowIso();

    return DB.add('purchaseRequests', {
      categoryId: categoryId,
      troop: troop,
      name: name,
      spec: (input.spec || '').trim(),
      quantity: qty,
      budget: budget,
      purpose: (input.purpose || '').trim(),
      applicant: applicant,
      status: 'pending',
      approval: 'pending',
      createdAt: now,
      updatedAt: now
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

  global.FEVER.Ops = {
    previewItemDeletion: previewItemDeletion,
    deleteItemsBatch: guard(deleteItemsBatch),
    inbound: guard(inbound),
    lend: guard(lend),
    giveBack: guard(giveBack),
    consume: guard(consume),
    sendRepair: guard(sendRepair),
    repairDone: guard(repairDone),
    arrive: guard(arrive),
    createRequest: guard(createRequest),
    lendLedger: lendLedger
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Ops;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
