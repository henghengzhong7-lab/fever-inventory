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
