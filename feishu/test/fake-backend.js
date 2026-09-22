/**
 * 飞书共享版端到端测试用的「假后端」。
 *
 * 只存在于测试页里，用来顶替 server/index.js：
 *   - 实现 /api/data、/api/write、/api/me、/api/login 四个接口
 *   - /api/write 可以注入延迟和失败，用来观察「界面会不会等」
 *   - 全程在浏览器内存里，不联网、不碰真实多维表格
 */
(function (window) {
  'use strict';

  var STORES = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];
  var KEY_PATH = {
    categories: 'id', items: 'code', purchaseRequests: 'id',
    invoices: 'id', transactions: 'id', settings: 'key'
  };
  var AUTO = { purchaseRequests: true, invoices: true, transactions: true };

  window.FEVER_CONFIG = { appId: 'cli_test', apiBase: '' };
  window.FEVER = window.FEVER || {};
  window.FEVER.Auth = {
    ready: Promise.resolve({ name: '测试队员', openId: 'ou_test' }),
    token: 'test-session',
    user: { name: '测试队员' }
  };

  var backend = {
    data: {},
    /** 模拟飞书写入的耗时：写一次要 2~4 秒是实测值，这里默认调小一点好跑 */
    writeDelayMs: 600,
    /** 还有几次写请求要故意失败 */
    failNextWrites: 0,
    /** 收到过的写请求（用来数「一次操作发了几个请求」） */
    writes: [],
    /** 收到过的全部请求路径 */
    requests: []
  };
  STORES.forEach(function (name) { backend.data[name] = []; });

  function sequences() {
    var out = {};
    STORES.forEach(function (name) {
      if (!AUTO[name]) return;
      var max = 0;
      backend.data[name].forEach(function (row) {
        var id = Number(row.id);
        if (!isNaN(id) && id > max) max = id;
      });
      out[name] = max + 1;
    });
    return out;
  }

  function response(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      text: function () { return Promise.resolve(JSON.stringify(payload)); }
    };
  }

  function applyOps(ops) {
    for (var i = 0; i < ops.length; i += 1) {
      var op = ops[i];
      var list = backend.data[op.store];
      var keyName = KEY_PATH[op.store];
      if (op.type === 'add') {
        var clash = list.some(function (r) { return String(r[keyName]) === String(op.data[keyName]); });
        if (clash) return { status: 409, body: { ok: false, conflict: true, message: '编号 ' + op.data[keyName] + ' 已被占用' } };
        list.push(op.data);
      } else if (op.type === 'put') {
        var index = -1;
        for (var j = 0; j < list.length; j += 1) {
          if (String(list[j][keyName]) === String(op.data[keyName])) { index = j; break; }
        }
        if (index === -1) list.push(op.data);
        else list[index] = op.data;
      } else if (op.type === 'delete') {
        backend.data[op.store] = list.filter(function (r) { return String(r[keyName]) !== String(op.key); });
      } else if (op.type === 'clear') {
        backend.data[op.store] = [];
      } else {
        return { status: 400, body: { ok: false, message: '不认识的操作类型 ' + op.type } };
      }
    }
    return { status: 200, body: { ok: true, sequences: sequences() } };
  }

  window.fetch = function (url, init) {
    var target = String(url);
    var options = init || {};
    backend.requests.push({ url: target, method: options.method || 'GET' });

    return new Promise(function (resolve) {
      if (target.indexOf('/api/write') !== -1) {
        var body = JSON.parse(options.body);
        backend.writes.push(body.ops);
        window.setTimeout(function () {
          if (backend.failNextWrites > 0) {
            backend.failNextWrites -= 1;
            resolve(response(500, { ok: false, message: '模拟的飞书写入失败' }));
            return;
          }
          var result = applyOps(body.ops);
          resolve(response(result.status, result.body));
        }, backend.writeDelayMs);
        return;
      }
      if (target.indexOf('/api/data') !== -1) {
        resolve(response(200, {
          ok: true, sequences: sequences(), data: JSON.parse(JSON.stringify(backend.data))
        }));
        return;
      }
      if (target.indexOf('/api/me') !== -1) {
        resolve(response(200, { ok: true, user: { name: '测试队员', openId: 'ou_test' } }));
        return;
      }
      if (target.indexOf('/api/login') !== -1) {
        resolve(response(200, { ok: true, token: 't', user: { name: '测试队员', openId: 'ou_test' } }));
        return;
      }
      resolve(response(404, { ok: false, message: '没有这个接口：' + target }));
    });
  };

  window.__FAKE__ = backend;
})(window);
