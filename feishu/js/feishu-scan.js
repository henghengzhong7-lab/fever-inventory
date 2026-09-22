/**
 * 飞书版专有：把飞书客户端的**原生扫码**注册成 FEVER.Scanner 的一个来源。
 *
 * 为什么单独放一个文件、不写进 v1/js/scanner.js：
 *   v1 是纯离线版，有一条硬约束 —— 代码里不许出现任何客户端桥 / 联网调用，
 *   v1 的测试会逐文件检查。这里用到 window.tt，只有飞书客户端里才有。
 *   放在 v1 外面，离线版就永远干净，而两边的扫码界面与解析逻辑仍是同一份。
 *
 * tt.scanCode 官方支持"网页应用"能力：Android / iOS 飞书 V3.44.0+。
 * 它不需要申请相机权限，是手机端扫码的主路径。
 */
(function (global) {
  'use strict';

  var registered = false;

  function feishuReady() {
    return !!(global.tt && typeof global.tt.scanCode === 'function');
  }

  /**
   * 等 h5sdk 初始化完。
   * 没有引入 JSSDK 时直接返回 —— 能不能扫由 available() 说了算。
   */
  function whenSdkReady() {
    if (!global.h5sdk || typeof global.h5sdk.ready !== 'function') return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(); } }
      try { global.h5sdk.ready(done); } catch (err) { done(); }
      // 兜底：SDK 偶发不回调，不能让扫码永远停在"准备中"
      global.setTimeout(done, 3000);
    });
  }

  /** 用户自己按了返回 / 取消 —— 要能认出来，上层才不会再弹一个摄像头出来 */
  function isCancel(err) {
    var msg = String((err && (err.errMsg || err.errString || err.message)) || '').toLowerCase();
    return msg.indexOf('cancel') !== -1 || msg.indexOf('取消') !== -1;
  }

  /**
   * 等 JSAPI 鉴权（feishu-jsapi.js 负责）。
   *
   * 为什么必须等：`tt.scanCode` 是要鉴权的接口，没过鉴权去调基本就是失败。
   * 但**等不到也不放弃** —— 鉴权失败照样试着扫一次，
   * 万一这个版本/这台机器上它是免鉴权的，别把能用的路堵死；
   * 真失败时再把鉴权的原因一起说出来，排查的人一眼看得到。
   */
  function waitJsapi() {
    var jsapi = global.FEVER && global.FEVER.FeishuJsapi;
    if (!jsapi || !jsapi.ready) return Promise.resolve({ ok: false, error: '鉴权模块没加载' });
    return jsapi.ready.then(function (ok) {
      return { ok: !!ok, error: jsapi.state ? jsapi.state.error : '' };
    }, function (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  function scanWithFeishu() {
    var auth = { ok: false, error: '' };
    return whenSdkReady()
      .then(waitJsapi)
      .then(function (result) {
        auth = result || auth;
        return new Promise(function (resolve, reject) {
          if (!feishuReady()) {
            reject(new Error('当前不在飞书客户端里，或飞书版本过低（网页应用扫码需要 V3.44.0 以上）'));
            return;
          }
          var settled = false;
          function ok(text) { if (!settled) { settled = true; resolve(text); } }
          function bad(e) {
            if (settled) return;
            settled = true;
            // 鉴权没过就把原因带出来 —— 否则使用者只看到"没完成"，不知道该找管理员配可信域名
            if (!auth.ok && auth.error && e && !e.cancelled) {
              e.message = e.message + '（JSAPI 鉴权没通过：' + auth.error + '）';
            }
            reject(e);
          }

          try {
            global.tt.scanCode({
              // 只认二维码：物品标签就是二维码，开着一堆条码格式反而容易扫错东西
              scanType: ['qrCode'],
              success: function (res) {
                if (res && res.result) ok(String(res.result));
                else bad(new Error('飞书没有返回扫码结果'));
              },
              fail: function (err) {
                var e = new Error('飞书扫码没有完成：' +
                  ((err && (err.errMsg || err.errString)) || '未知原因'));
                if (isCancel(err)) e.cancelled = true;
                bad(e);
              }
            });
          } catch (err) {
            bad(err);
          }
        });
      });
  }

  function boot() {
    if (registered) return;
    if (!global.FEVER || !global.FEVER.Scanner) return;   // 界面层还没起来，等下一次
    global.FEVER.Scanner.register({
      name: 'feishu',
      label: '飞书扫码',
      priority: 100,          // 在飞书里就以它为准，别去弹摄像头
      available: feishuReady,
      scan: scanWithFeishu
    });
    registered = true;
  }

  boot();
  // tt 有时是 JSSDK 异步注入的，晚一点再试一次
  global.setTimeout(boot, 1500);
})(typeof globalThis !== 'undefined' ? globalThis : this);
