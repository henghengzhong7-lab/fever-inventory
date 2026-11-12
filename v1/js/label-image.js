/**
 * 把选中的标签画成一张 PNG 图片（第十八轮）。
 *
 * **为什么不是 PDF**：jsPDF 内置的 14 种字体只有拉丁字母，中文必须整份嵌字库
 * （约 10MB，且它不能做子集化 —— 以后新物品名里出现的字不在字库里就变方块），
 * 手机首次打开会明显变重。canvas 用系统字体画中文又快又好，代价只是位图 ——
 * 标签尺寸小，按 300dpi 出图打印完全够用。
 *
 * **不联网**：全部在本地画，不调任何外部服务（v1 的硬约束）。
 * 字体名是系统字体名，不构成联网；二维码由 js/qr.js 本地生成。
 */
(function (global) {
  'use strict';

  // A4 @300dpi 的可用区域（去掉页边距）
  var MARGIN = 120;
  var GAP = 60;
  var COLS = 3;
  var ROWS_PER_PAGE = 8;          // 一张图最多 8 行 = 24 张标签
  var CARD_W = 700;
  var CARD_H = 460;
  var QR_SIZE = 300;

  var FONT = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif';

  /**
   * 排版计算：几列几行、画布多大。
   * 纯函数（不碰 canvas），好直接测 —— 布局算错了导出就是废纸。
   */
  function layout(count) {
    var n = Math.max(1, num(count));
    var rows = Math.max(1, Math.ceil(n / COLS));
    return {
      count: n,
      cols: COLS,
      rows: rows,
      cardW: CARD_W,
      cardH: CARD_H,
      gap: GAP,
      margin: MARGIN,
      width: MARGIN * 2 + COLS * CARD_W + (COLS - 1) * GAP,
      height: MARGIN * 2 + rows * CARD_H + (rows - 1) * GAP
    };
  }

  function num(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  /** 把一张卡片的多行文字画在给定区域里，超出宽度就省略 */
  function drawText(ctx, text, x, y, maxW, font, color) {
    if (!text) return y;
    ctx.font = font;
    ctx.fillStyle = color || '#1f2430';
    var line = text;
    // 中文按字符截断比按像素截断可控（不会切出半个字）
    while (line.length > 1 && ctx.measureText(line).width > maxW) {
      line = line.slice(0, -1);
    }
    if (line !== text) line += '…';
    ctx.fillText(line, x, y);
    return y;
  }

  /** 把二维码图片加载成 HTMLImageElement（data URL，不联网） */
  function loadImage(dataUrl) {
    return new Promise(function (resolve) {
      if (!dataUrl) { resolve(null); return; }
      var img = new global.Image();
      img.onload = function () { resolve(img); };
      // 画不出来也不能让整张图失败：留一个空位，总比什么都没有强
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  /**
   * 画一整张标签图。
   * cards: [{ code, name, spec, categoryName, location, qrDataUrl }]
   * 返回 Promise<HTMLCanvasElement>
   */
  function render(cards) {
    var list = cards || [];
    if (!list.length) return Promise.reject(new Error('没有可导出的标签'));
    if (list.length > COLS * ROWS_PER_PAGE) {
      return Promise.reject(new Error('一次最多导出 ' + (COLS * ROWS_PER_PAGE) + ' 张，请分批选择'));
    }
    return Promise.all(list.map(function (c) { return loadImage(c.qrDataUrl); }))
      .then(function (images) {
        var L = layout(list.length);
        var canvas = global.document.createElement('canvas');
        canvas.width = L.width;
        canvas.height = L.height;
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('这个浏览器不支持生成图片');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, L.width, L.height);
        ctx.textBaseline = 'top';

        list.forEach(function (card, i) {
          var col = i % L.cols;
          var row = Math.floor(i / L.cols);
          var x = L.margin + col * (L.cardW + L.gap);
          var y = L.margin + row * (L.cardH + L.gap);

          // 卡片：白底 + 浅灰描边 + 裁切线（撕下来时好对着裁）
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, L.cardW, L.cardH);
          ctx.strokeStyle = '#c8cdd8';
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 1.5, y + 1.5, L.cardW - 3, L.cardH - 3);
          ctx.strokeStyle = '#e3e6ee';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, y + L.cardH - 46);
          ctx.lineTo(x + L.cardW, y + L.cardH - 46);
          ctx.stroke();

          var img = images[i];
          if (img) {
            ctx.drawImage(img, x + 24, y + 30, QR_SIZE, QR_SIZE);
          } else {
            // 没画出来就写字，别留一个空白方块让人以为标签是空的
            ctx.fillStyle = '#a0a6b4';
            ctx.font = '24px ' + FONT;
            ctx.fillText('二维码生成失败', x + 24, y + 150);
          }

          var tx = x + QR_SIZE + 48;
          var tw = L.cardW - (QR_SIZE + 48) - 24;
          var ty = y + 34;
          ty = drawText(ctx, card.code, tx, ty, tw, '700 40px ' + FONT, '#10131a') + 18;
          ty = drawText(ctx, card.name, tx, ty, tw, '600 34px ' + FONT) + 14;
          if (card.spec) ty = drawText(ctx, card.spec, tx, ty, tw, '28px ' + FONT, '#4a5162') + 12;
          ty = drawText(ctx, card.categoryName || '', tx, ty, tw, '26px ' + FONT, '#6b7280') + 10;
          drawText(ctx, card.location || '', tx, ty, tw, '26px ' + FONT, '#6b7280');
        });

        return canvas;
      });
  }

  /**
   * 触发下载。
   *
   * 走 **Blob URL** 而不是 data URL：标签多的时候 PNG 动不动几 MB，
   * Chrome 对超大的 data URL 下载会**静默失败**（点了没反应，也不报错）——
   * 那就正好变成"又点了没反应"，比不给下载还气人。
   * toBlob 在所有目标浏览器上都可用；万一不可用再退回 data URL。
   */
  function download(canvas, filename) {
    var name = filename || '标签.png';
    function click(href, revoke) {
      try {
        var a = global.document.createElement('a');
        a.href = href;
        a.download = name;
        global.document.body.appendChild(a);
        a.click();
        global.document.body.removeChild(a);
        if (revoke) setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
        return true;
      } catch (err) {
        return false;
      }
    }
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) { click(canvas.toDataURL('image/png')); return; }
        if (!click(URL.createObjectURL(blob), true)) click(canvas.toDataURL('image/png'));
      }, 'image/png');
      return true;
    }
    return click(canvas.toDataURL('image/png'));
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.LabelImage = {
    layout: layout,
    render: render,
    download: download,
    MAX_PER_IMAGE: COLS * ROWS_PER_PAGE
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.LabelImage;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
