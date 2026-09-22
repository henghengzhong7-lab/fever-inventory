/**
 * FEver 战队物资管理 —— 业务规则层
 *
 * 这里放"规则"，不放界面：大类配置、编码生成、状态与库存自洽、
 * 提醒判定、备份导出与导入。所有规则都能在 Node 里直接测。
 */
(function (global) {
  'use strict';

  var DB = global.FEVER && global.FEVER.DB ? global.FEVER.DB : (typeof require === 'function' ? require('./db.js') : null);

  /** 四种流水类型的中文名，界面与导出都用它 */
  var TXN_TYPES = {
    inbound: '入库',
    lend: '借出',
    return: '归还',
    consume: '领用',
    repair: '送修',
    repair_done: '修好回库'
  };

  var STATUS_NAMES = {
    in_stock: '在库',
    lent: '借出',
    repairing: '损坏待修',
    used_up: '已用完'
  };

  var INVOICE_STATUS_NAMES = {
    pending: '待购买',
    ordered: '已下单',
    arrived: '已到货',
    canceled: '已取消'
  };

  /* ---------- 采购申请的审批 ---------- */

  /** 审批状态。三个值都是终态中的一种，流转只由管理员触发 */
  var APPROVALS = ['pending', 'approved', 'rejected'];

  var APPROVAL_NAMES = {
    pending: '待审批',
    approved: '已同意',
    rejected: '已驳回'
  };

  /**
   * 取一条采购申请的审批状态。
   *
   * **老数据没有 approval 字段，一律视为「已同意」。**
   * 这不是偷懒，是"加功能不能弄坏原有流程"的关键一条：这些申请是在引入审批
   * 之前建的（甚至已经在途了），如果按"没批过"处理，上线当天所有在途的单子
   * 会一起卡住，还得逐条补点一次同意。引入新规则时不追溯改判历史数据。
   *
   * 认不出来的值（比如手改过表、或者以后加了新状态）一律按「待审批」处理 ——
   * 宁可多让管理员点一次，也不放过一条没批的申请。
   */
  function approvalOf(req) {
    if (!req) return 'approved';
    var raw = req.approval === undefined || req.approval === null ? '' : String(req.approval).trim();
    if (!raw) return 'approved';
    return APPROVALS.indexOf(raw) === -1 ? 'pending' : raw;
  }

  /** 这条申请能不能往下走（下单、到货）。只有「已同意」能走 */
  function isApproved(req) { return approvalOf(req) === 'approved'; }

  /** 是不是还等着管理员处理 */
  function isPendingApproval(req) { return approvalOf(req) === 'pending'; }

  /* ---------- 删除记录 ---------- */

  /**
   * 删除记录存在 settings 里的一张追加表里。
   *
   * 为什么删东西还要留账：这套系统的硬要求是「可追溯」——出入库流水被刻意做成
   * 只追加、不可改写，就是为了这条。后加的删除功能不能把这个前提拆掉，
   * 所以每删一条都记一笔：谁、什么时候、删了什么、以及**被删对象的完整快照**。
   * 有了快照，删掉的流水也还能查回来（人工恢复的最小信息量）。
   */
  var DELETE_LOG_KEY = 'deleteLog';

  /** 只留最近这些条，免得 settings 那一列无限长下去 */
  var DELETE_LOG_MAX = 300;

  /** 当前操作人。离线版没有登录，如实写成「本机操作」而不是编一个名字 */
  function currentActor() {
    var user = null;
    if (DB && typeof DB.currentUser === 'function') {
      try { user = DB.currentUser(); } catch (err) { user = null; }
    }
    return (user && (user.name || user.openId)) || '本机操作';
  }

  /** 各种删除对象在记录里显示成什么 */
  var DELETE_LABELS = {
    items: '物品',
    purchaseRequests: '采购申请',
    invoices: '发票',
    transactions: '出入库流水'
  };

  /**
   * 写 settings 的"安全版"：失败只告警，不抛出。
   *
   * 只给「删除记录」这一类**附带动作**用。它们记的是已经发生的事实 ——
   * 东西确实删掉了 —— 记日志失败不该反过来让调用方以为主操作也失败了，
   * 那会让人以为数据还在，反而更危险。主操作成没成功由它自己的 Promise 说话。
   */
  function setSettingSafe(key, value) {
    return Promise.resolve().then(function () {
      return DB.setSetting(key, value);
    }).then(function () { return true; }, function (err) {
      if (global.console && console.warn) {
        console.warn('[设置写入] ' + key + ' 保存失败：' + (err && err.message ? err.message : err));
      }
      return false;
    });
  }

  /**
   * 把一次删除动作做成「删除记录」里的一行。
   *
   * 单独抽出来是因为**批量删除**也要用同一套格式：它在一个事务里一次写 N 条，
   * 不能去调 logDeletion（那个函数自己会另起一次写）。抽成纯函数之后，
   * 单条删和批量删留下的记录长得一模一样，不会一个地方改了另一边没跟上。
   */
  function buildDeletionEntry(entry) {
    var e = entry || {};
    return {
      at: e.at || DB.nowIso(),
      by: e.by || currentActor(),
      store: e.store,
      key: String(e.key),
      label: (DELETE_LABELS[e.store] || e.store) + ' ' + (e.label || e.key),
      reason: e.reason || '',
      snapshot: e.snapshot === undefined ? null : e.snapshot
    };
  }

  /**
   * 把新记录并进已有记录，并裁到上限（只留最近的）。
   *
   * 裁的是**最老的**那批：删除记录是审计线索，越近的越可能被用到。
   */
  function mergeDeleteLog(current, fresh) {
    var rows = (Array.isArray(current) ? current : []).concat(fresh || []);
    if (rows.length > DELETE_LOG_MAX) rows = rows.slice(rows.length - DELETE_LOG_MAX);
    return rows;
  }

  /**
   * 记一条删除。**必须在事务之外调用** —— 它自己会写 settings。
   * 写日志失败不能把已经完成的删除回滚（删除本身是成功的），所以这里吞掉错误、
   * 只在控制台留痕：宁可少一条审计记录，也不能让界面显示"删除失败"而其实删掉了。
   *
   * 批量删除走的是另一条路（见 actions.js 的 deleteItemsBatch）：它把删除和留痕
   * 放进**同一个事务**，一次写完 —— 联网版因此只发一次写请求，N 件不会变成 N 次往返。
   */
  function logDeletion(entry) {
    var row = buildDeletionEntry(entry);
    return getDeleteLog().then(function (list) {
      return setSettingSafe(DELETE_LOG_KEY, mergeDeleteLog(list, [row]));
    }).then(function (ok) {
      // ok 为 false 表示日志没写进去（setSettingSafe 已经告警过）。
      // 这时如实返回 null 而不是假装记上了 —— 调用方不用因此改口说"删除失败"
      // （东西确实删掉了），但界面可以据此提示"这次没记上"，别让人以为有据可查。
      return ok ? row : null;
    }, function (err) {
      if (global.console && console.warn) {
        console.warn('[删除记录] 读取失败，删除本身已经完成：' + (err && err.message ? err.message : err));
      }
      return null;
    });
  }

  function getDeleteLog() {
    return DB.getSetting(DELETE_LOG_KEY, []).then(function (value) {
      return Array.isArray(value) ? value : [];
    });
  }

  function clearDeleteLog() { return setSettingSafe(DELETE_LOG_KEY, []); }

  /**
   * 这件物品能不能删。能删返回 null，不能删返回原因（人话）。
   *
   * 拦两种情形：**还有实物在别人手上或待修**。这时候删掉物品身份，
   * 那些东西就没人认领了 —— 数量对不上，而且再也没法从系统里找到是谁借的。
   * 只躺在库里的（含已领用/已用完）可以删：它们已经不影响追踪了。
   */
  function blockItemDeletion(item) {
    if (!item) return '找不到这件物品';
    if (num(item.lentQty) > 0) {
      return '还有 ' + num(item.lentQty) + ' 件借在外面没还。等它们还回来再删，否则这几件东西就没人认领了。';
    }
    if (num(item.repairQty) > 0) {
      return '还有 ' + num(item.repairQty) + ' 件在待修。先把它们处理掉再删。';
    }
    return null;
  }

  /* ================= 批量操作 ================= */

  /**
   * 把一堆物品分成「能删的」和「被拦住的」。
   *
   * 批量删除**不能做成"有一件不能删就整批失败"**：那样使用者只能一件件试，
   * 反而更容易在反复重选中删错。要明确告诉他哪几件跳过了、为什么 ——
   * 所以这里返回的是分区结果，不是一个 yes/no。
   */
  function partitionDeletable(items) {
    var deletable = [];
    var blocked = [];
    (items || []).forEach(function (item) {
      if (!item) return;
      var reason = blockItemDeletion(item);
      if (reason) blocked.push({ item: item, reason: reason });
      else deletable.push(item);
    });
    return { deletable: deletable, blocked: blocked };
  }

  /**
   * 按给定的编码顺序把物品挑出来。
   *
   * **顺序要紧**：批量打印时标签按勾选顺序排下来，人撕下来贴的时候才连得上；
   * 所以这里不做排序、也不丢顺序，只按 codes 走一遍。
   * 找不到的编码直接跳过（可能刚被别人删了），不补空位。
   */
  function pickByCodes(items, codes) {
    var byCode = {};
    (items || []).forEach(function (item) {
      if (item && item.code) byCode[String(item.code)] = item;
    });
    return (codes || []).map(function (code) {
      return byCode[String(code)];
    }).filter(function (item) { return !!item; });
  }

  /**
   * 编码列表 ↔ 地址栏片段。
   *
   * 批量打印是把"选中了哪几件"记在地址栏里的（`#labels/batch/MC-0001,VS-0002`）——
   * 这样刷新、后退、把链接发给别人，都能回到同一批标签；存在内存里就会在刷新后
   * 悄悄退回"打印全部"，那是会浪费一整叠标签纸的错误。
   *
   * 每个编码单独编码，所以编码里就算有逗号也不会把列表切错。
   */
  function encodeCodeList(codes) {
    return (codes || []).map(function (code) { return encodeURIComponent(String(code)); }).join(',');
  }

  function decodeCodeList(text) {
    return String(text === undefined || text === null ? '' : text)
      .split(',')
      .filter(function (part) { return part !== ''; })
      .map(function (part) { return decodeURIComponent(part); });
  }

  /**
   * 兵种选项。
   *
   * 采购申请必须选一个，兵种预算板块就按它来归类、汇总。
   * 顺序是有意的：常用的排前面，「其他」永远放最后一个 ——
   * 它是兜底选项，不该被误选；界面上也把它画成最后一个。
   *
   * 注意：这串值会**原样写进采购申请**并成为预算的归类键，
   * 所以以后要改名（比如「前哨战」改成「前哨站」）必须同时提供
   * 旧值的迁移映射，否则已经存在的申请会掉到预算之外 ——
   * 见 troopOf() 里的兼容处理。
   */
  var TROOPS = ['重装', '步兵', '哨兵', '飞镖', '无人机', '雷达', '前哨战', '能量机关', '其他'];

  /** 兜底兵种：认不出来的兵种一律归到这里，保证预算汇总不会漏账 */
  var TROOP_FALLBACK = '其他';

  /**
   * 把任意值规范成一个合法兵种。
   * 空值 → ''（表示未指定）；不认识的值 → 「其他」。
   */
  function normalizeTroop(value) {
    var raw = value === undefined || value === null ? '' : String(value).trim();
    if (!raw) return '';
    return TROOPS.indexOf(raw) === -1 ? TROOP_FALLBACK : raw;
  }

  /**
   * 取一条采购申请（或物品）的兵种。
   * 老数据没有 troop 字段，返回 '' 表示「未指定」，由调用方决定怎么显示；
   * 认不出来的值（比如用过后来删掉的兵种名）统一归到「其他」。
   */
  function troopOf(record) {
    return record ? normalizeTroop(record.troop) : '';
  }

  /**
   * 一张发票在界面上显示的名字。
   * 发票号码改为选填后（第十三轮），没填号的发票不能显示成空白按钮 ——
   * 回退到 PDF 文件名，再不行用登记序号。所有显示发票入口的地方都用这一个函数，
   * 别各写各的回退（漏一处，界面上就多一个点不开的空按钮）。
   */
  function invoiceLabel(inv) {
    if (!inv) return '';
    return inv.invoiceNo || inv.fileName || ('发票 #' + inv.id);
  }

  /**
   * 四个大类的配置。extraFields 是大类专属字段，
   * reminders 是该大类的提醒默认值（天数），都可以在界面上改。
   */
  var CATEGORY_DEFS = [
    {
      id: 'mechanical',
      name: '机械',
      icon: '⚙',
      prefix: 'MC',
      sortOrder: 1,
      description: '结构件、标准件、传动件',
      defaultIdentityMode: 'shared',
      searchFields: ['vehicle', 'assemblePos'],
      reminders: { calibrationDays: 0, toolCalibrationDays: 0, spareCycleDays: 365 },
      extraFields: [
        { key: 'vehicle', label: '适配车型', type: 'text', placeholder: '如：2026赛季主车' },
        { key: 'assemblePos', label: '装配位置', type: 'text', placeholder: '如：底盘左侧' },
        { key: 'material', label: '材质', type: 'text', placeholder: '如：铝合金6061' },
        { key: 'size', label: '尺寸规格', type: 'text', placeholder: '如：100x50x20mm' },
        { key: 'loadCapacity', label: '承重/载荷', type: 'text', placeholder: '如：5kg' },
        { key: 'lifespan', label: '预计寿命', type: 'text', placeholder: '如：10000次' },
        { key: 'maintenanceCycle', label: '维护周期', type: 'text', placeholder: '如：每500次' }
      ]
    },
    {
      id: 'electronic',
      name: '电控',
      icon: '⚡',
      prefix: 'EL',
      sortOrder: 2,
      description: '电路板、控制器、传感器、电池',
      defaultIdentityMode: 'shared',
      searchFields: ['interfaceType'],
      reminders: { calibrationDays: 0, toolCalibrationDays: 0, spareCycleDays: 180 },
      extraFields: [
        { key: 'voltage', label: '工作电压', type: 'text', placeholder: '如：24V' },
        { key: 'current', label: '工作电流', type: 'text', placeholder: '如：2A' },
        { key: 'power', label: '功率', type: 'text', placeholder: '如：50W' },
        { key: 'interfaceType', label: '接口类型', type: 'text', placeholder: '如：CAN/RS485/USB' },
        { key: 'safetyLevel', label: '安全等级', type: 'select', options: ['一般', '注意', '高压危险'] },
        { key: 'lastReplaceDate', label: '最近更换日期', type: 'date' },
        { key: 'batteryCycles', label: '电池循环次数', type: 'number', placeholder: '如：120' },
        { key: 'batteryHealth', label: '电池健康状况', type: 'select', options: ['良好', '一般', '衰减明显'] }
      ]
    },
    {
      id: 'vision',
      name: '视觉',
      icon: '◎',
      prefix: 'VS',
      sortOrder: 3,
      description: '相机、镜头、光源',
      defaultIdentityMode: 'single',
      searchFields: ['lensMount', 'cameraPair'],
      reminders: { calibrationDays: 90, toolCalibrationDays: 0, spareCycleDays: 365 },
      extraFields: [
        { key: 'resolution', label: '分辨率', type: 'text', placeholder: '如：500万像素' },
        { key: 'frameRate', label: '帧率', type: 'text', placeholder: '如：60fps' },
        { key: 'focalLength', label: '焦距/视场角', type: 'text', placeholder: '如：12mm/60°' },
        { key: 'lensMount', label: '镜头接口', type: 'select', options: ['CS', 'C', 'M12', '其它'] },
        { key: 'cameraPair', label: '配套相机', type: 'text', placeholder: '如：配 VS-0002' },
        { key: 'calibrationStatus', label: '标定状态', type: 'select', options: ['未标定', '已标定', '需重新标定'] },
        { key: 'lastCalibrationDate', label: '最近标定日期', type: 'date' }
      ]
    },
    {
      id: 'hardware',
      name: '硬件',
      icon: '🔧',
      prefix: 'HW',
      sortOrder: 4,
      description: '工具、耗材、框架',
      defaultIdentityMode: 'shared',
      searchFields: ['assemblePos'],
      reminders: { calibrationDays: 0, toolCalibrationDays: 180, spareCycleDays: 365 },
      extraFields: [
        { key: 'material', label: '材质', type: 'text', placeholder: '如：45号钢' },
        { key: 'surfaceTreatment', label: '表面处理', type: 'text', placeholder: '如：阳极氧化' },
        { key: 'mountingHoles', label: '安装孔位', type: 'text', placeholder: '如：M4x4孔' },
        { key: 'assemblePos', label: '装配位置', type: 'text', placeholder: '如：底盘右侧' },
        { key: 'weight', label: '重量', type: 'text', placeholder: '如：200g' },
        { key: 'isTool', label: '是否工具', type: 'select', options: ['否', '是'] },
        { key: 'lastCalibrationDate', label: '最近校准日期', type: 'date' }
      ]
    }
  ];

  var CATEGORY_PREFIX = { mechanical: 'MC', electronic: 'EL', vision: 'VS', hardware: 'HW' };

  /**
   * 首次运行时写入四个大类配置。
   * 已存在的大类不会被覆盖，避免把使用者改过的字段定义冲掉。
   */
  function initCategories() {
    return DB.runTx('categories', 'readwrite', function (T) {
      return T.getAll('categories').then(function (existing) {
        var haveIds = existing.map(function (c) { return c.id; });
        var toAdd = CATEGORY_DEFS.filter(function (def) { return haveIds.indexOf(def.id) === -1; });
        if (toAdd.length === 0) return existing;
        var created = DB.nowIso();
        return toAdd.reduce(function (chain, def) {
          return chain.then(function () {
            var row = JSON.parse(JSON.stringify(def));
            row.createdAt = created;
            return T.add('categories', row);
          });
        }, Promise.resolve()).then(function () {
          // 同一事务内能读到自己刚写入的数据
          return T.getAll('categories');
        });
      });
    });
  }

  /** 编码前缀：优先用大类配置里的 prefix */
  function prefixOf(category) {
    if (category && category.prefix) return category.prefix;
    if (category && CATEGORY_PREFIX[category.id]) return CATEGORY_PREFIX[category.id];
    return 'IT';
  }

  function pad4(n) {
    return String(n).padStart(4, '0');
  }

  function counterKey(prefix) {
    return 'codeCounter:' + prefix;
  }

  /**
   * 生成 count 个连续的新编码。
   * 用计数器而不是"取最大值+1"，即使物品被删掉也不会重号（PRD 要求编码不复用）。
   * 计数器在同一个事务里读改写，批量生成不会重号。
   */
  function nextCodes(category, count) {
    var prefix = prefixOf(category);
    var n = Math.max(1, Number(count) || 1);
    var key = counterKey(prefix);
    // 计数器与物品表放在同一个事务里，批量生成不会重号
    return DB.runTx(['settings', 'items'], 'readwrite', function (T) {
      return T.get('settings', key).then(function (row) {
        if (row && typeof row.value === 'number') return row.value;
        // 首次使用：扫描已有物品，从最大流水号继续，兼容导入的旧数据
        return T.getAll('items').then(function (items) {
          var max = 0;
          items.forEach(function (it) {
            if (!it.code || it.code.indexOf(prefix + '-') !== 0) return;
            var parsed = parseInt(it.code.slice(prefix.length + 1), 10);
            if (!isNaN(parsed) && parsed > max) max = parsed;
          });
          return max;
        });
      }).then(function (base) {
        var codes = [];
        for (var i = 1; i <= n; i += 1) codes.push(prefix + '-' + pad4(base + i));
        return T.put('settings', { key: key, value: base + n, updatedAt: DB.nowIso() }).then(function () {
          return codes;
        });
      });
    });
  }

  /** 二维码里放的文本，第二版手机端按同样格式解析 */
  function qrPayload(code) {
    return 'FEVER:ITEM:' + code;
  }

  /** 从扫码结果里解析出编码，不是本系统的码就返回 null */
  function parseQrPayload(text) {
    if (!text) return null;
    var trimmed = String(text).trim();
    if (trimmed.indexOf('FEVER:ITEM:') === 0) return trimmed.slice('FEVER:ITEM:'.length).trim() || null;
    if (/^[A-Z]{2}-\d{4,}$/.test(trimmed)) return trimmed;
    return null;
  }

  /** 按数量派生一个"主状态"，用于列表徽标 */
  function statusOf(item) {
    if (!item) return 'in_stock';
    if (item.inStockQty > 0) return 'in_stock';
    if (item.lentQty > 0) return 'lent';
    if (item.repairQty > 0) return 'repairing';
    return 'used_up';
  }

  /**
   * 库存自洽校验：在库 + 借出 + 待修 + 已领用 = 总数。
   * 任何一次改动后都必须成立，否则拒绝提交。
   */
  function checkInvariant(item) {
    var sum = num(item.inStockQty) + num(item.lentQty) + num(item.repairQty) + num(item.usedUpQty);
    var total = num(item.totalQty);
    if (sum !== total) {
      return {
        ok: false,
        message: '库存数量不自洽：在库 ' + num(item.inStockQty) + ' + 借出 ' + num(item.lentQty) +
          ' + 待修 ' + num(item.repairQty) + ' + 已领用 ' + num(item.usedUpQty) + ' = ' + sum +
          '，但总数是 ' + total
      };
    }
    if (item.identityMode === 'single' && total !== 1) {
      return { ok: false, message: '单独建身份的物品总数只能是 1，当前是 ' + total };
    }
    ['inStockQty', 'lentQty', 'repairQty', 'usedUpQty', 'totalQty'].forEach(function () {});
    var negatives = ['inStockQty', 'lentQty', 'repairQty', 'usedUpQty'].filter(function (k) { return num(item[k]) < 0; });
    if (negatives.length) return { ok: false, message: '数量不能为负数：' + negatives.join('、') };
    return { ok: true };
  }

  function num(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  /** 打包全部数据，供"导出备份"使用 */
  function exportAll() {
    return DB.runTx(DB.STORES, 'readonly', function (T) {
      return DB.STORES.reduce(function (chain, name) {
        return chain.then(function (acc) {
          return T.getAll(name).then(function (rows) { acc[name] = rows; return acc; });
        });
      }, Promise.resolve({})).then(function (data) {
        return {
          app: 'FEver 战队物资管理',
          formatVersion: DB.FORMAT_VERSION,
          exportedAt: DB.nowIso(),
          counts: DB.STORES.reduce(function (acc, n) { acc[n] = data[n].length; return acc; }, {}),
          data: data
        };
      });
    });
  }

  /** 校验备份文件的形状，导入前先挡掉明显不对的文件 */
  function validateBackup(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, message: '文件内容不是有效的备份数据' };
    if (!payload.data || typeof payload.data !== 'object') return { ok: false, message: '备份里缺少 data 字段' };
    var missing = DB.STORES.filter(function (n) { return !Array.isArray(payload.data[n]); });
    if (missing.length) return { ok: false, message: '备份里缺少这些表的数据：' + missing.join('、') };
    return { ok: true };
  }

  /**
   * 用备份数据整体替换现有数据。
   * 全部表在同一个事务里清空并写入，中途失败会整体回滚，不会留下半套数据。
   */
  function importAll(payload) {
    var check = validateBackup(payload);
    if (!check.ok) return Promise.reject(new Error(check.message));
    return DB.runTx(DB.STORES, 'readwrite', function (T) {
      return DB.STORES.reduce(function (chain, name) {
        return chain.then(function () {
          return T.clear(name).then(function () {
            var rows = payload.data[name];
            return rows.reduce(function (inner, row) {
              return inner.then(function () { return T.put(name, row); });
            }, Promise.resolve());
          });
        });
      }, Promise.resolve()).then(function () {
        return DB.STORES.reduce(function (chain, name) {
          return chain.then(function (acc) {
            return T.count(name).then(function (c) { acc[name] = c; return acc; });
          });
        }, Promise.resolve({}));
      });
    }).then(function (counts) {
      return { ok: true, counts: counts };
    });
  }

  /** 清空全部数据（导入前做保险备份、以及测试用） */
  function clearAll() {
    return DB.runTx(DB.STORES, 'readwrite', function (T) {
      return DB.STORES.reduce(function (chain, name) {
        return chain.then(function () { return T.clear(name); });
      }, Promise.resolve());
    });
  }

  function daysBetween(fromIso, toDate) {
    if (!fromIso) return null;
    var from = new Date(fromIso);
    if (isNaN(from.getTime())) return null;
    var ms = toDate.getTime() - from.getTime();
    return Math.floor(ms / 86400000);
  }

  /** 今天零点，用于按"天"比较 */
  function startOfDay(date) {
    var d = date ? new Date(date) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** 超过多少天没备份就该提醒了 */
  var BACKUP_REMIND_DAYS = 7;

  /**
   * 该不该提醒备份。
   * 返回 { need: 布尔, days: 距上次备份的天数（没备份过为 null） }
   * 从没备份过要提醒；超过 7 天要提醒；刚好第 7 天不提醒。
   */
  function backupReminder(lastBackupAt, today) {
    if (!lastBackupAt) return { need: true, days: null };
    var days = daysBetween(lastBackupAt, today || new Date());
    if (days === null) return { need: true, days: null };
    return { need: days >= BACKUP_REMIND_DAYS, days: days };
  }

  /**
   * 借用是否超期。返回 { overdue: 布尔, days: 超期天数 }
   * dueDate 为空表示没设归还日期，不算超期。
   */
  function overdueInfo(dueDate, today) {
    if (!dueDate) return { overdue: false, days: 0 };
    var due = startOfDay(dueDate);
    var now = startOfDay(today);
    var diff = Math.floor((now.getTime() - due.getTime()) / 86400000);
    return diff > 0 ? { overdue: true, days: diff } : { overdue: false, days: 0 };
  }

  /**
   * 判断一个物品有没有提醒事项，返回提醒数组。
   *   低库存：件数低于安全库存
   *   标定到期：视觉类超过标定周期没标定
   *   校准到期：硬件类工具超过校准周期没校准
   *   更换到期：电控类易损件超过更换周期
   */
  function remindersFor(item, category, today) {
    var out = [];
    var now = today || new Date();
    var stock = num(item.inStockQty);
    var safety = num(item.safetyStock);
    if (item.safetyStock !== undefined && item.safetyStock !== null && item.safetyStock !== '' && stock < safety) {
      out.push({ kind: 'low_stock', level: 'warn', text: '库存偏低（在库 ' + stock + '，安全库存 ' + safety + '）' });
    }
    var rem = (category && category.reminders) || {};
    var extra = item.extra || {};

    if (num(rem.calibrationDays) > 0) {
      var lastCal = extra.lastCalibrationDate;
      if (!lastCal) {
        out.push({ kind: 'calibration', level: 'warn', text: '尚未标定' });
      } else {
        var ageCal = daysBetween(lastCal, now);
        if (ageCal !== null && ageCal > num(rem.calibrationDays)) {
          out.push({ kind: 'calibration', level: 'warn', text: '已 ' + ageCal + ' 天未标定（周期 ' + num(rem.calibrationDays) + ' 天）' });
        }
      }
    }

    if (num(rem.toolCalibrationDays) > 0 && extra.isTool === '是') {
      var lastTool = extra.lastCalibrationDate;
      if (!lastTool) {
        out.push({ kind: 'tool_calibration', level: 'warn', text: '工具尚未校准' });
      } else {
        var ageTool = daysBetween(lastTool, now);
        if (ageTool !== null && ageTool > num(rem.toolCalibrationDays)) {
          out.push({ kind: 'tool_calibration', level: 'warn', text: '工具已 ' + ageTool + ' 天未校准（周期 ' + num(rem.toolCalibrationDays) + ' 天）' });
        }
      }
    }

    if (num(rem.spareCycleDays) > 0 && extra.lastReplaceDate) {
      var ageRep = daysBetween(extra.lastReplaceDate, now);
      if (ageRep !== null && ageRep > num(rem.spareCycleDays)) {
        out.push({ kind: 'spare_cycle', level: 'info', text: '易损件已 ' + ageRep + ' 天未更换（周期 ' + num(rem.spareCycleDays) + ' 天）' });
      }
    }

    if (extra.safetyLevel === '高压危险') {
      out.push({ kind: 'safety', level: 'danger', text: '高压危险，操作注意' });
    }
    return out;
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Rules = {
    TXN_TYPES: TXN_TYPES,
    STATUS_NAMES: STATUS_NAMES,
    INVOICE_STATUS_NAMES: INVOICE_STATUS_NAMES,
    TROOPS: TROOPS,
    TROOP_FALLBACK: TROOP_FALLBACK,
    normalizeTroop: normalizeTroop,
    troopOf: troopOf,
    invoiceLabel: invoiceLabel,
    APPROVALS: APPROVALS,
    APPROVAL_NAMES: APPROVAL_NAMES,
    approvalOf: approvalOf,
    isApproved: isApproved,
    isPendingApproval: isPendingApproval,
    DELETE_LOG_KEY: DELETE_LOG_KEY,
    DELETE_LOG_MAX: DELETE_LOG_MAX,
    DELETE_LABELS: DELETE_LABELS,
    currentActor: currentActor,
    buildDeletionEntry: buildDeletionEntry,
    mergeDeleteLog: mergeDeleteLog,
    logDeletion: logDeletion,
    getDeleteLog: getDeleteLog,
    clearDeleteLog: clearDeleteLog,
    blockItemDeletion: blockItemDeletion,
    partitionDeletable: partitionDeletable,
    pickByCodes: pickByCodes,
    encodeCodeList: encodeCodeList,
    decodeCodeList: decodeCodeList,
    CATEGORY_DEFS: CATEGORY_DEFS,
    initCategories: initCategories,
    prefixOf: prefixOf,
    nextCodes: nextCodes,
    qrPayload: qrPayload,
    parseQrPayload: parseQrPayload,
    statusOf: statusOf,
    checkInvariant: checkInvariant,
    num: num,
    exportAll: exportAll,
    validateBackup: validateBackup,
    importAll: importAll,
    clearAll: clearAll,
    daysBetween: daysBetween,
    startOfDay: startOfDay,
    BACKUP_REMIND_DAYS: BACKUP_REMIND_DAYS,
    backupReminder: backupReminder,
    overdueInfo: overdueInfo,
    remindersFor: remindersFor
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Rules;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
