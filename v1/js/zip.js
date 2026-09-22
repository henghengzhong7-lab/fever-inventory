/**
 * 最小可用的 ZIP 打包器（仅 store，不压缩）。
 *
 * 为什么自己写而不是引一个库：
 *   · 离线版有条硬约束 —— 不许引入任何联网/CDN 依赖，库必须是本地文件；
 *   · PDF 本来就是压缩过的格式，再压缩一次几乎没有收益，
 *     store 模式的 ZIP 格式非常小：本地文件头 + 中央目录 + CRC32，两百行写完；
 *   · 电脑端和飞书版共用这一份（界面代码同源），两端都能批量下载发票。
 */
(function (global) {
  'use strict';

  /** CRC32 查表 —— ZIP 的每个条目都要带校验和，错了解包工具会报文件损坏 */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** 编成 UTF-8 字节（文件名可能带中文） */
  function utf8(str) {
    // TextEncoder 现代浏览器都有；没有就退回手动编码
    if (global.TextEncoder) return new global.TextEncoder().encode(str);
    return new Uint8Array(unescape(encodeURIComponent(str)).split('').map(function (ch) {
      return ch.charCodeAt(0);
    }));
  }

  function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
  function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

  /** 把 Date 拆成 DOS 时间的两个字段（ZIP 里时间就这么存） */
  function dosDateTime(date) {
    var d = date || new Date();
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    var day = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time, day: day };
  }

  function push(list, bytes) { list.push(bytes); }

  /**
   * 打包。files: [{ name: '目录/文件名.pdf', bytes: Uint8Array, date?: Date }]
   * 返回 Uint8Array（交给 UI.downloadBytes 落成 .zip）。
   *
   * 重名不在这里去重 —— 调用方负责给文件名编号（见 views-commerce.js 的批量下载），
   * 因为"重名了怎么办"是业务决定（覆盖？加序号？），不是格式决定。
   */
  function buildZip(files) {
    var chunks = [];       // 本地文件头 + 数据（也用于算偏移）
    var central = [];      // 中央目录
    var offset = 0;

    (files || []).forEach(function (file) {
      var nameBytes = utf8(file.name);
      var data = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
      var crc = crc32(data);
      var dt = dosDateTime(file.date);

      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0),   // 签名 / 版本 / UTF-8 标志 / store
        u16(dt.time), u16(dt.day), u32(crc),
        u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0)
      );
      push(chunks, new Uint8Array(local));
      push(chunks, nameBytes);
      push(chunks, data);

      var entry = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
        u16(dt.time), u16(dt.day), u32(crc),
        u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset)
      );
      push(central, new Uint8Array(entry));
      push(central, nameBytes);

      offset += local.length + nameBytes.length + data.length;
    });

    var centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = [].concat(
      u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(centralSize), u32(offset), u16(0)
    );

    var total = offset + centralSize + end.length;
    var out = new Uint8Array(total);
    var pos = 0;
    chunks.concat(central, [new Uint8Array(end)]).forEach(function (c) {
      out.set(c, pos);
      pos += c.length;
    });
    return out;
  }

  global.FEVER = global.FEVER || {};
  global.FEVER.Zip = { build: buildZip };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Zip;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
