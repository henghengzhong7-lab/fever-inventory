/**
 * FEver 战队物资管理 —— 二维码渲染
 *
 * 用本地库 js/lib/qrcode.min.js 生成，不联网、不调用任何外部服务。
 * 渲染结果是 <img>（data URL），方便直接打印和显示。
 */
(function (global) {
  'use strict';

  var DEFAULT_SIZE = 240;

  function ensureLib() {
    if (typeof global.qrcode !== 'function') {
      throw new Error('二维码库没加载出来（js/lib/qrcode.min.js）');
    }
    return global.qrcode;
  }

  /**
   * 生成二维码图片的 data URL。
   * 内容过长时自动降级纠错等级，尽量保证能生成出来。
   */
  function dataUrl(text, opts) {
    var o = opts || {};
    var qrcode = ensureLib();
    var size = o.size || DEFAULT_SIZE;
    var levels = o.level ? [o.level] : ['M', 'L'];
    var lastErr = null;
    for (var i = 0; i < levels.length; i += 1) {
      try {
        var qr = qrcode(0, levels[i]);
        qr.addData(String(text));
        qr.make();
        return {
          url: qr.createDataURL(o.cellSize || 4, o.margin || 8),
          text: String(text),
          size: size,
          level: levels[i]
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('二维码生成失败');
  }

  /** 把某个占位元素替换成二维码图片 */
  function render(holder, opts) {
    if (!holder) return null;
    var payload = holder.getAttribute('data-qr');
    if (!payload) return null;
    try {
      var res = dataUrl(payload, opts);
      holder.innerHTML = '<img alt="物品二维码" src="' + res.url + '" style="width:100%;max-width:220px">';
      return res;
    } catch (err) {
      holder.innerHTML = '<div class="alert-item danger">二维码生成失败：' + String(err.message || err) + '</div>';
      return null;
    }
  }

  /** 渲染页面上所有带 data-qr 的元素 */
  function renderAll(root, opts) {
    var list = (root || document).querySelectorAll('[data-qr]');
    Array.prototype.slice.call(list).forEach(function (node) { render(node, opts); });
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.QR = { dataUrl: dataUrl, render: render, renderAll: renderAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
