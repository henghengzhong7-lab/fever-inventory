/**
 * 飞书版专有：给网页应用做 **JSAPI 鉴权**。
 *
 * 为什么要有这个文件（这是手机端扫码点不动的真正原因之一）：
 *   免登用的 `tt.requestAccess` 是**免鉴权**接口，所以之前一路都好好的；
 *   但扫码用的 `tt.scanCode` 是**需要鉴权**的 JSAPI —— 前端不拿服务端算出的签名
 *   去 `h5sdk.config` 过一遍，调用就只是失败（表现为「点了扫码没反应」）。
 *
 *   鉴权要成立还有个前提：飞书开发者后台 → 安全设置 → **H5 可信域名**
 *   里得填本应用的地址（要带 https://）。没配的话签名算得再对也过不去，
 *   所以下面的失败提示里把这条写进去，免得只知道"失败了"不知道该改哪里。
 *
 * 这个文件只做鉴权一件事，且**失败不阻塞主流程**：
 * 鉴权没过，扫码会退到摄像头 / 拍照识别，不会把整个应用卡住。
 */
(function (global) {
  'use strict';

  var cfg = global.FEVER_CONFIG || {};

  /** 页面地址（去掉 # 及其后面）：飞书签名要求的就是这一段 */
  function pageUrl() {
    var href = (global.location && global.location.href) ? String(global.location.href) : '';
    return href.split('#')[0];
  }

  function apiBase() {
    return String(cfg.apiBase || '').replace(/\/+$/, '');
  }

  function waitForLogin() {
    var auth = global.FEVER && global.FEVER.Auth;
    if (auth && auth.ready) return auth.ready;
    return Promise.reject(new Error('登录模块没起来'));
  }

  function fetchSigned() {
    return waitForLogin().then(function () {
      var auth = global.FEVER && global.FEVER.Auth;
      var token = (auth && auth.token) || '';
      var headers = { 'Content-Type': 'application/json' };
      if (token) {
        // 与数据层同一个规矩：自定义头优先，网关会覆盖 Authorization
        headers['X-Session-Token'] = token;
        headers.Authorization = 'Bearer ' + token;
      }
      var url = apiBase() + '/api/jsapi-config?url=' + encodeURIComponent(pageUrl());
      return global.fetch(url, { method: 'GET', headers: headers });
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = {};
        try { body = text ? JSON.parse(text) : {}; } catch (err) { body = { ok: false }; }
        if (!res.ok || body.ok === false) {
          throw new Error(body.message || ('服务端返回 ' + res.status));
        }
        return body;
      });
    });
  }

  function config(signed) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function done(err) {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        if (err) reject(err); else resolve(true);
      }
      // SDK 偶发不回调（比如容器版本太老），不能让扫码永远停在"准备中"
      var timer = global.setTimeout(function () {
        done(new Error('JSAPI 鉴权超时（飞书没有返回结果）'));
      }, 8000);

      try {
        global.h5sdk.config({
          appId: signed.appId,
          // 毫秒级时间戳：服务端已经按毫秒算的签名，这里原样传，不要再除 1000
          timestamp: Number(signed.timestamp),
          nonceStr: signed.nonceStr,
          signature: signed.signature,
          jsApiList: ['scanCode'],
          onSuccess: function () { done(null); },
          onFail: function (err) {
            var msg = String((err && (err.errMsg || err.errString || err.message)) || '未知原因');
            done(new Error('JSAPI 鉴权失败：' + msg +
              '。请让管理员在飞书开发者后台 → 安全设置 → H5 可信域名里填上 ' +
              'https://' + ((global.location && global.location.hostname) || '本应用域名')));
          }
        });
      } catch (err) {
        done(err);
      }
    });
  }

  /**
   * 等 JSSDK 初始化完再 config。
   *
   * h5sdk 这个对象在脚本一加载就有了，但**内部未必就绪** ——
   * 这时候调 config 会被静默忽略（不报错、也不回调），表现出来就是
   * "鉴权好像跑了，但扫码照样不行"。所以先等 ready，等不到再硬着头皮试。
   */
  function waitSdkReady() {
    if (!global.h5sdk || typeof global.h5sdk.ready !== 'function') return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(); } }
      try { global.h5sdk.ready(done); } catch (err) { done(); }
      global.setTimeout(done, 3000);
    });
  }

  var state = { ok: false, error: '', done: false, stage: 'init' };

  var ready = (function () {
    if (!global.h5sdk || typeof global.h5sdk.config !== 'function') {
      state.done = true;
      state.stage = 'no-sdk';
      state.error = '页面没有加载到飞书 JSSDK（可能不在飞书客户端里）';
      return Promise.resolve(false);
    }
    state.stage = 'signing';
    return waitSdkReady()
      .then(function () { state.stage = 'config'; return fetchSigned(); })
      .then(function (signed) { return config(signed); })
      .then(function () {
        state.ok = true;
        state.done = true;
        state.stage = 'ok';
        return true;
      })
      .catch(function (err) {
        state.done = true;
        state.stage = 'fail';
        state.error = (err && err.message) ? err.message : String(err);
        // 鉴权失败不算致命错误：扫码会退到摄像头 / 拍照识别
        console.warn('[飞书 JSAPI 鉴权] ' + state.error);
        return false;
      });
  })();

  global.FEVER = global.FEVER || {};
  global.FEVER.FeishuJsapi = {
    /** 鉴权是否完成（resolve 出 true/false，永不 reject） */
    ready: ready,
    state: state
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
