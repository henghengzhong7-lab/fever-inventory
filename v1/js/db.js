/**
 * FEver 战队物资管理 —— 数据层
 *
 * 只用浏览器自带的 IndexedDB 存数据，不联网、不落本地文件（备份导出除外）。
 * 同时兼容两种加载方式：
 *   - 浏览器：<script src="js/db.js"></script>，通过全局 FEVER.DB 使用
 *   - Node 测试：require('./db.js') 直接拿到同一批函数
 */
(function (global) {
  'use strict';

  var DB_NAME = 'FEVER_INV_V1';
  var DB_VERSION = 1;
  var FORMAT_VERSION = 1;

  /** 所有表名，导出/导入与清空时按这个顺序处理 */
  var STORES = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];

  var dbInstance = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function txToPromise(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('事务被中断')); };
    });
  }

  /** 打开（首次会创建）数据库 */
  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        var database = event.target.result;

        if (!database.objectStoreNames.contains('categories')) {
          var cs = database.createObjectStore('categories', { keyPath: 'id' });
          cs.createIndex('sortOrder', 'sortOrder', { unique: false });
        }
        if (!database.objectStoreNames.contains('items')) {
          var is = database.createObjectStore('items', { keyPath: 'code' });
          is.createIndex('categoryId', 'categoryId', { unique: false });
          is.createIndex('status', 'status', { unique: false });
          is.createIndex('purchaseRequestId', 'purchaseRequestId', { unique: false });
          is.createIndex('name', 'name', { unique: false });
          is.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!database.objectStoreNames.contains('purchaseRequests')) {
          var ps = database.createObjectStore('purchaseRequests', { keyPath: 'id', autoIncrement: true });
          ps.createIndex('categoryId', 'categoryId', { unique: false });
          ps.createIndex('status', 'status', { unique: false });
          ps.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!database.objectStoreNames.contains('invoices')) {
          var ivs = database.createObjectStore('invoices', { keyPath: 'id', autoIncrement: true });
          ivs.createIndex('purchaseRequestId', 'purchaseRequestId', { unique: false });
          ivs.createIndex('invoiceNo', 'invoiceNo', { unique: false });
          ivs.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!database.objectStoreNames.contains('transactions')) {
          var ts = database.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          ts.createIndex('itemCode', 'itemCode', { unique: false });
          ts.createIndex('type', 'type', { unique: false });
          ts.createIndex('operator', 'operator', { unique: false });
          ts.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = function (event) { dbInstance = event.target.result; resolve(dbInstance); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('数据库被其他页面占用，请关闭其它同地址的标签页后重试')); };
    });
  }

  /**
   * 在一个事务里执行若干操作，返回 fn 的结果。
   *
   * fn 收到的是"已经绑定事务"的辅助方法（T），不是原始 store：
   *   T.get(store, key) / T.getAll(store) / T.getByIndex(store, index, value)
   *   T.add(store, data) / T.put(store, data) / T.remove(store, key) / T.count(store)
   * 这些方法可以在 fn 内任意组合、链式调用，全部落在同一个事务里，
   * 因此不会出现"跨事务写入半途失败留下脏数据"的问题。
   *
   * 注意：不要在 fn 里再调用 openDB 之外的独立事务函数（会死锁），
   * 需要多表操作时把表名都列进 storeNames。
   */
  function runTx(storeNames, mode, fn) {
    return openDB().then(function (database) {
      var names = Array.isArray(storeNames) ? storeNames : [storeNames];
      var tx = database.transaction(names, mode);
      var completed = txToPromise(tx);

      var T = {
        tx: tx,
        get: function (store, key) { return reqToPromise(tx.objectStore(store).get(key)); },
        getAll: function (store) { return reqToPromise(tx.objectStore(store).getAll()); },
        getByIndex: function (store, index, value) { return reqToPromise(tx.objectStore(store).index(index).getAll(value)); },
        add: function (store, data) { return reqToPromise(tx.objectStore(store).add(data)); },
        put: function (store, data) { return reqToPromise(tx.objectStore(store).put(data)); },
        remove: function (store, key) { return reqToPromise(tx.objectStore(store).delete(key)); },
        count: function (store) { return reqToPromise(tx.objectStore(store).count()); },
        clear: function (store) { return reqToPromise(tx.objectStore(store).clear()); }
      };

      var result;
      try {
        result = fn(T);
      } catch (err) {
        try { tx.abort(); } catch (e) { /* 事务可能已结束，忽略 */ }
        // 事务被中断后 completed 会以「事务被中断」拒绝，这里必须接住它：
        // 没人接就是一个未处理的 Promise 拒绝（Node 里直接让进程崩掉），
        // 而调用方真正该看到的是下面这个 err —— 它才说明"为什么失败"。
        // 这个坑是被一次同步抛错（在事务回调里做字段校验）踩出来的。
        completed.catch(function () {});
        return Promise.reject(err);
      }
      return Promise.resolve(result).then(function (value) {
        return completed.then(function () { return value; });
      }, function (err) {
        try { tx.abort(); } catch (e) { /* 事务可能已结束，忽略 */ }
        return completed.catch(function () {}).then(function () { throw err; });
      });
    });
  }

  function dbAdd(storeName, data) {
    return runTx(storeName, 'readwrite', function (T) { return T.add(storeName, data); });
  }

  function dbPut(storeName, data) {
    return runTx(storeName, 'readwrite', function (T) { return T.put(storeName, data); });
  }

  function dbGet(storeName, key) {
    return runTx(storeName, 'readonly', function (T) { return T.get(storeName, key); });
  }

  function dbGetAll(storeName) {
    return runTx(storeName, 'readonly', function (T) { return T.getAll(storeName); });
  }

  function dbGetByIndex(storeName, indexName, value) {
    return runTx(storeName, 'readonly', function (T) { return T.getByIndex(storeName, indexName, value); });
  }

  function dbDelete(storeName, key) {
    return runTx(storeName, 'readwrite', function (T) { return T.remove(storeName, key); });
  }

  function dbCount(storeName) {
    return runTx(storeName, 'readonly', function (T) { return T.count(storeName); });
  }

  /** 读取一个配置项 */
  function getSetting(key, fallback) {
    return dbGet('settings', key).then(function (row) {
      return row ? row.value : (fallback === undefined ? null : fallback);
    });
  }

  function setSetting(key, value) {
    return dbPut('settings', { key: key, value: value, updatedAt: nowIso() });
  }

  /**
   * 生成 count 个连续的新编码（第二十六轮：从 rules.js 搬到数据层）。
   *
   * 为什么搬到数据层：**发号这件事两个版本的做法必须不同** ——
   *   · 离线版（这个文件）：单机、没有并发，本地事务算号就够了（就是下面这段）
   *   · 飞书共享版：多个人同时在用，各自在本机算号就会撞（A、B 都算出 MC-0007）
   *     → 那边改成**向服务端领一段号**，服务端有串行队列，天生不会撞
   * 界面代码两边同一份，所以差异收在数据层的同名方法里。
   *
   * 这里沿用原来的做法与键名（`codeCounter:<前缀>`）：计数器与物品表放在同一个事务里，
   * 批量生成不会重号；物品被删掉也不会重号（编码不复用）。
   */
  function nextCodes(prefix, count) {
    var pre = String(prefix || 'IT');
    var n = Math.max(1, Number(count) || 1);
    var key = 'codeCounter:' + pre;
    return runTx(['settings', 'items'], 'readwrite', function (T) {
      return T.get('settings', key).then(function (row) {
        if (row && typeof row.value === 'number') return row.value;
        // 首次使用：扫描已有物品，从最大流水号继续，兼容导入的旧数据
        return T.getAll('items').then(function (items) {
          var max = 0;
          items.forEach(function (it) {
            if (!it.code || it.code.indexOf(pre + '-') !== 0) return;
            var parsed = parseInt(it.code.slice(pre.length + 1), 10);
            if (!isNaN(parsed) && parsed > max) max = parsed;
          });
          return max;
        });
      }).then(function (base) {
        var codes = [];
        for (var i = 1; i <= n; i += 1) {
          codes.push(pre + '-' + String(base + i).padStart(4, '0'));
        }
        return T.put('settings', { key: key, value: base + n, updatedAt: nowIso() })
          .then(function () { return codes; });
      });
    });
  }

  /**
   * 当前使用者是不是管理员。
  /**
   * 当前使用者是不是管理员。
   *
   * 离线版（这个文件）里返回**永远是 true**：数据就在本机、只有一个人用，
   * 没有"别人来批"这件事，把审批按钮藏起来只会让这个版本看起来是坏的。
   * 飞书共享版里由服务端判定（见 feishu/js/db-remote.js 的同名方法）——
   * 而且**服务端会强制校验**，前端这里只决定按钮要不要画出来。
   */
  function isAdmin() { return true; }

  /**
   * 当前使用者。离线版**没有登录这回事**，如实返回 null，
   * 不编一个假账号出来。
   *
   * 这个方法存在（而不是没有）是刻意的：飞书版的数据层（feishu/js/db-remote.js）
   * 有同名方法，两个数据层**接口必须一模一样** —— 界面代码是同一份，
   * 少一个方法就会在其中一个版本里变成 "currentUser is not a function"。
   * 调用方（rules.js 的 currentActor）据此把操作人写成「本机操作」。
   */
  function currentUser() { return null; }

  /* ==================== 发票 PDF（第十三轮） ==================== */

  /**
   * 保存一张发票附件。file 为 null（没传 PDF）时返回一组空引用，
   * 调用方（Ops.arrive）照常展开、不会往行里塞 undefined。
   *
   * 离线版没有服务器，PDF 的 base64 **直接存进发票行的 JSON 里**
   * （IndexedDB 装得下，备份导出导入也天然带着它）。
   * 飞书版（db-remote.js 的同名方法）是先传服务器、行里只留 fileRef ——
   * 多维表格的文本格放不下整份 PDF。这个差异被隔离在数据层，
   * 界面与 Ops 层看到的是同一个接口。
   */
  function saveInvoiceFile(file) {
    if (!file) {
      return Promise.resolve({ fileRef: '', fileData: '', fileName: '', fileSize: 0, fileMime: '' });
    }
    var mime = file.mime || 'application/pdf';
    var size = file.size || Math.floor(file.base64.length * 3 / 4);
    return Promise.resolve({
      fileRef: '',
      fileData: file.base64,
      fileName: file.name,
      fileSize: size,
      fileMime: mime
    });
  }

  /**
   * 取一张发票的 PDF 本体。没有附件时 resolve null。
   * 返回 { base64, fileName, mime }；界面拿它做下载 / 批量打包。
   */
  function loadInvoiceFile(invoice) {
    if (!invoice || !invoice.fileData) return Promise.resolve(null);
    return Promise.resolve({
      base64: invoice.fileData,
      fileName: invoice.fileName || '发票.pdf',
      mime: invoice.fileMime || 'application/pdf'
    });
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.DB = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    FORMAT_VERSION: FORMAT_VERSION,
    STORES: STORES,
    nowIso: nowIso,
    openDB: openDB,
    runTx: runTx,
    add: dbAdd,
    put: dbPut,
    get: dbGet,
    getAll: dbGetAll,
    getByIndex: dbGetByIndex,
    remove: dbDelete,
    count: dbCount,
    nextCodes: nextCodes,
    getSetting: getSetting,
    setSetting: setSetting,
    isAdmin: isAdmin,
    currentUser: currentUser,
    saveInvoiceFile: saveInvoiceFile,
    loadInvoiceFile: loadInvoiceFile,
    /**
     * 发送测试提醒（飞书提醒通道的诊断入口）。
     * 离线版没有服务端、没有飞书，永远不可能发提醒 —— 拒绝并把话说清楚。
     * 飞书版（db-remote.js）的同名方法会真发一条并返回飞书的原始结果。
     */
    notifyTest: function () {
      return Promise.reject(new Error('离线版没有飞书提醒。要测提醒，请在飞书里打开应用后到设置页再试'));
    },
    /**
     * 提醒申请人补发票（第十五轮）。
     * 离线版没有服务端、没有飞书，永远发不出去 —— 明确拒绝，
     * 界面据此显示"这台机器上发不了"，而不是假装提醒过了。
     */
    notifyInvoice: function () {
      return Promise.reject(new Error('离线版没有飞书提醒。要在飞书里打开应用，才能提醒队员补发票'));
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.DB;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
