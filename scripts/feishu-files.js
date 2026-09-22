'use strict';

/**
 * 飞书共享版要发布的运行时文件白名单。
 *
 * 分两部分，这是刻意分开的：
 *
 *   fromV1     —— 来自 v1/ 的界面与业务代码。与本地离线版**同一份文件**（构建时原样复制，
 *                 不做任何改写，两边永远一致）。飞书版和离线版共用它们，
 *                 避免"改一个功能要改两遍"。
 *
 *   fromFeishu —— 来自 feishu/js/ 的飞书版专有文件：
 *                 db-remote.js  数据层（数据从浏览器本地改为飞书多维表格）
 *                 feishu-auth.js 登录层（飞书客户端内免登）
 *
 * 之所以不把这两个文件放进 v1/js/，是因为 v1 有一条硬约束：
 * 它是纯离线版，代码里不允许出现任何联网调用（v1 的测试会逐文件检查）。
 * 放在 v1 外面，离线版就永远保持干净。
 *
 * index.html 与 js/feishu-config.js 由 build-feishu.js 现场生成，不在这里列。
 */
module.exports = {
  fromV1: [
    'css/style.css',
    'js/rules.js',
    'js/ops.js',
    'js/stats.js',
    'js/ui.js',
    'js/qr.js',
    'js/scanner.js',
    'js/views.js',
    'js/zip.js',
    'js/views-commerce.js',
    'js/actions.js',
    'js/app.js',
    'js/modules/mechanical.js',
    'js/modules/electronic.js',
    'js/modules/vision.js',
    'js/modules/hardware.js',
    'js/lib/qrcode.min.js',
    'js/lib/jsQR.js'
  ],
  fromFeishu: [
    'js/db-remote.js',
    'js/feishu-auth.js',
    'js/feishu-jsapi.js',
    'js/feishu-scan.js'
  ]
};
