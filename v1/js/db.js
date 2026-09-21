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
    getSetting: getSetting,
    setSetting: setSetting
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.DB;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
