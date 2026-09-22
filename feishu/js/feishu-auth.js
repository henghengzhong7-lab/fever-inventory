/**
 * FEver 战队物资管理 —— 飞书登录层
 *
 * 职责：
 *   1. 在飞书客户端里调用 JSSDK 拿免登授权码，交给后端换成用户身份；
 *   2. 不在飞书里打开时，给出明确提示（而不是白屏或者一句看不懂的报错）；
 *   3. 把「当前是谁」暴露给数据层，供服务端记录操作人。
 *
 * 注意：这里**不碰后端密钥**。授权码只在前端和后端之间传一次，
 * 换成正式令牌的步骤全在服务端做（app_secret 不能出现在网页里）。
 */
(function (global) {
  'use strict';

  var cfg = global.FEVER_CONFIG || {};
  var APP_ID = cfg.appId || '';
  var API_BASE = String(cfg.apiBase || '').replace(/\/+$/, '');
  var TOKEN_KEY = 'fever_inv_session_token';
  var GATE_ID = 'feishu-gate';

  var state = { user: null, token: '', done: false };

  var resolveReady;
  var rejectReady;

  var auth = {
    /** 登录完成的 Promise，数据层会等它 */
    ready: null,
    token: '',
    user: null,
    isFeishu: function () { return !!(global.tt || global.h5sdk); },
    currentUser: function () { return state.user; },
    retry: function () { return boot(); },
    /** 强制重新登录（忽略本地缓存的令牌）。数据层收到 401 时会调它 */
    renew: function () { return renew(); }
  };

  auth.ready = new Promise(function (resolve, reject) {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 避免控制台出现「未处理的 Promise 拒绝」噪音，真正的错误走界面提示
  auth.ready.catch(function () {});

  /* ==================== 遮罩 ==================== */

  function gateElement() {
    var node = document.getElementById(GATE_ID);
    if (node) return node;
    node = document.createElement('div');
    node.id = GATE_ID;
    node.setAttribute('style',
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(15,20,30,.55);backdrop-filter:blur(2px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif');
    node.innerHTML = '<div id="feishu-gate-card" style="max-width:420px;width:calc(100% - 48px);' +
      'background:#fff;color:#1f2430;border-radius:14px;padding:26px 24px;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.28);text-align:center;line-height:1.7"></div>';
    document.body.appendChild(node);
    return node;
  }

  function showGate(html, isError) {
    if (!document.body) return;
    var node = gateElement();
    node.style.display = 'flex';
    var card = document.getElementById('feishu-gate-card');
    var box = document.getElementById('feishu-gate-message');
    if (box) {
      box.innerHTML = html;
      var actions = document.getElementById('feishu-gate-actions');
      if (actions) actions.style.display = isError ? 'block' : 'none';
      return;
    }
    card.innerHTML =
      '<div style="font-size:15px;margin-bottom:6px;font-weight:600">FEver 战队物资管理</div>' +
      '<div id="feishu-gate-message" style="font-size:14px;color:#4a5262;margin-top:10px">' + html + '</div>' +
      '<div id="feishu-gate-actions" style="display:none;margin-top:18px">' +
      '<button type="button" id="feishu-gate-retry" style="border:0;border-radius:8px;padding:10px 20px;' +
      'background:#3370ff;color:#fff;font-size:14px;cursor:pointer">重试</button></div>';
    var retry = document.getElementById('feishu-gate-retry');
    // 刷新整个页面重来：比在已失败的 Promise 链上原地重试干净得多
    if (retry) retry.addEventListener('click', function () { global.location.reload(); });
  }

  function hideGate() {
    var node = document.getElementById(GATE_ID);
    if (node && node.parentNode) node.style.display = 'none';
  }

  /* ==================== 会话令牌 ==================== */

  function readToken() {
    try {
      return global.sessionStorage ? (global.sessionStorage.getItem(TOKEN_KEY) || '') : '';
    } catch (err) {
      return '';
    }
  }

  function saveToken(token) {
    try {
      if (global.sessionStorage) global.sessionStorage.setItem(TOKEN_KEY, token);
    } catch (err) { /* 隐私模式下写不了，忽略即可，这次会话仍然能用 */ }
  }

  function clearToken() {
    try {
      if (global.sessionStorage) global.sessionStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* 同上 */ }
  }

  /* ==================== 与后端对话 ==================== */

  function postJson(path, payload) {
    var headers = { 'Content-Type': 'application/json' };
    // 已经拿到令牌就带上。
    // **别去掉这一段**：/api/me 的用途就是"本地缓存的令牌还有效吗"，
    // 不带令牌它必然 401 —— 线上网关还会顺手注入它自己的 Authorization，
    // 于是服务端看到的是「带了 1 个令牌但校验不通过」。
    // 结果就是每次打开应用都白跑一个必定失败的请求，然后丢掉明明有效的令牌、
    // 退回一次完整的飞书免登。这一条是靠线上日志
    // 「[会话] 拒绝 POST /api/me —— 带了的 1 个令牌都校验不通过」定位的。
    if (state.token) {
      headers['X-Session-Token'] = state.token;
      headers.Authorization = 'Bearer ' + state.token;
    }
    return global.fetch(API_BASE + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (err) {
          throw new Error('服务端返回了看不懂的内容，请稍后重试');
        }
        if (!res.ok || body.ok === false) throw new Error(body.message || ('服务端返回 ' + res.status));
        return body;
      });
    }, function (err) {
      throw new Error('连不上服务器，请检查网络（' + (err && err.message ? err.message : err) + '）');
    });
  }

  /** 拿免登授权码；按官方的建议，新版接口不可用时降级到旧接口 */
  function requestCode() {
    return new Promise(function (resolve, reject) {
      if (!APP_ID) {
        reject(new Error('前端没有配置飞书 App ID，请联系管理员重新构建页面'));
        return;
      }
      if (!global.tt) {
        var notInFeishu = new Error('NOT_IN_FEISHU');
        notInFeishu.code = 'NOT_IN_FEISHU';
        reject(notInFeishu);
        return;
      }

      var settled = false;
      function ok(code) {
        if (settled) return;
        settled = true;
        if (code) resolve(code);
        else reject(new Error('飞书没有返回授权码'));
      }
      function bad(error) {
        if (settled) return;
        settled = true;
        var errno = error && error.errno;
        if (errno === 103) {
          legacyAuthCode(ok, bad);
          settled = false;
          return;
        }
        if (errno === 104) {
          reject(new Error('你拒绝了授权，无法进入系统。重新打开应用即可再试一次。'));
          return;
        }
        reject(new Error('飞书免登失败：' + ((error && (error.errString || error.errMsg)) || '未知原因')));
      }

      if (global.tt.requestAccess) {
        global.tt.requestAccess({ appID: APP_ID, scopeList: [], success: function (res) { ok(res.code); }, fail: bad });
      } else {
        legacyAuthCode(ok, bad);
      }
    });
  }

  function legacyAuthCode(ok, bad) {
    if (!global.tt || !global.tt.requestAuthCode) {
      bad({ errString: '当前飞书客户端版本过低，不支持网页应用免登，请升级飞书后再试' });
      return;
    }
    global.tt.requestAuthCode({ appId: APP_ID, success: function (res) { ok(res.code); }, fail: bad });
  }

  /* ==================== 主流程 ==================== */

  function finish(user) {
    state.user = user;
    state.done = true;
    auth.user = user;
    auth.token = state.token;
    hideGate();
    resolveReady(user);
    return user;
  }

  function failWith(err) {
    var message = err && err.message ? err.message : String(err);
    var isOutside = err && err.code === 'NOT_IN_FEISHU';
    var html = isOutside
      ? '<b>请在飞书里打开这个应用</b><br>' +
        '<span style="font-size:13px">这个地址只对飞书客户端有效。请回到飞书工作台，' +
        '点击「FEver 战队物资管理」图标进入；直接把它粘到浏览器里是打不开的。</span>'
      : '<b>没能进入系统</b><br><span style="font-size:13px">' + escapeHtml(message) + '</span>';
    showGate(html, true);
    if (!state.done) rejectReady(err);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var running = null;

  function boot() {
    if (running) return running;
    running = (function () {
      if (!document.body) {
        return Promise.reject(new Error('页面还没准备好'));
      }
      showGate('正在与飞书核对身份……');

      // 同一次会话里已经登录过，先拿本地的令牌试一次，避免闪屏
      var cached = readToken();
      if (cached) {
        state.token = cached;
        auth.token = cached;
        return postJson('/api/me').then(function (body) {
          return finish(body.user || { name: '队员' });
        }).catch(function () {
          state.token = '';
          auth.token = '';
          clearToken();
          return loginFlow();
        });
      }
      return loginFlow();
    })().catch(function (err) {
      failWith(err);
      throw err;
    }).then(function (value) {
      running = null;
      return value;
    }, function (err) {
      running = null;
      throw err;
    });
    return running;
  }

  /**
   * 等 JSSDK 把自己挂到 window 上。飞书的网页应用容器会注入 window.tt，
   * 但脚本是异步加载的，页面刚打开那一瞬间可能还没有——不等就会误判成「不在飞书里」。
   */
  function waitForBridge(timeoutMs) {
    if (global.tt) return Promise.resolve();
    return new Promise(function (resolve) {
      var start = Date.now();
      var timer = setInterval(function () {
        if (global.tt || Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }

  function loginFlow() {
    var waitSdk = global.h5sdk && global.h5sdk.ready
      ? new Promise(function (resolve) { global.h5sdk.ready(function () { resolve(); }); })
      : Promise.resolve();

    return waitForBridge(3000).then(function () {
      return waitSdk;
    }).then(function () {
      return requestCode();
    }).then(function (code) {
      showGate('正在确认你的身份……');
      return postJson('/api/login', { code: code });
    }).then(function (body) {
      state.token = body.token;
      auth.token = body.token;
      saveToken(body.token);
      return finish(body.user);
    });
  }

  /* ==================== 启动 ==================== */

  /**
   * 强制重新登录：丢掉本地缓存的令牌，重新找飞书要一次授权码。
   * 数据层收到 401（服务端重新部署过、或令牌过期）时会走这里，队员无感。
   * 同一个时刻只允许有一次重登在进行，多个并发请求不要各自去要码。
   */
  var renewing = null;

  function renew() {
    if (renewing) return renewing;
    clearToken();
    state.token = '';
    auth.token = '';
    state.done = false;
    showGate('正在重新确认你的身份……');
    renewing = loginFlow().then(function (user) {
      renewing = null;
      return user;
    }, function (err) {
      renewing = null;
      throw err;
    });
    return renewing;
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Auth = auth;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot().catch(function () {}); });
  } else {
    boot().catch(function () {});
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
