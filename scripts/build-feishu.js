'use strict';

/**
 * 构建「飞书共享版」静态产物。
 *
 *   npm run build:feishu
 *
 * 做的事情：
 *   1. 把 v1/ 里的界面运行时文件原样复制过去（一行不改）
 *   2. 用 db-remote.js 替换 db.js，并注入 feishu-auth.js 与飞书配置
 *   3. 生成一份 index.html（多引入 JSSDK、配置、登录层）
 *   4. 同步一份到 server/public/，这样后端可以直接把前端一起伺服，
 *      前端和接口同域，不需要处理跨域，队员也只要记一个地址
 *
 * 与 GitHub Pages 那条线完全独立：dist/ 由 build:pages 生成，互不影响。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const manifest = require('./feishu-files.js');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'v1');
const feishuRoot = path.join(projectRoot, 'feishu');
const outputRoot = path.join(projectRoot, 'dist-feishu');
const serverPublic = path.join(projectRoot, 'server', 'public');
const configPath = path.join(projectRoot, 'feishu.config.json');
const examplePath = path.join(projectRoot, 'feishu.config.example.json');

/** 飞书网页应用的 JSSDK。它负责往页面里注入 window.tt（免登、扫码等能力都靠它） */
const DEFAULT_JSSDK = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.16.js';

function fail(message) {
  console.error('\n[构建失败] ' + message + '\n');
  process.exit(1);
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, configPath);
    }
    fail('请先填写 feishu.config.json：\n' +
      '   appId   —— 飞书应用的 App ID（cli_ 开头）\n' +
      '   apiBase —— 后端地址；如果前后端同域（用后端伺服前端）就留空字符串\n' +
      ' 文件已经帮你生成好了：' + configPath);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    fail('feishu.config.json 不是合法的 JSON：' + err.message);
  }
  if (!cfg.appId || String(cfg.appId).indexOf('cli_') !== 0) {
    fail('feishu.config.json 里的 appId 还没填对（应该以 cli_ 开头）。\n' +
      '  拿法：飞书开发者后台 → 你的应用 → 凭证与基础信息 → 应用凭证 → App ID。');
  }
  cfg.apiBase = String(cfg.apiBase || '').replace(/\/+$/, '');
  cfg.jssdkUrl = cfg.jssdkUrl || DEFAULT_JSSDK;
  return cfg;
}

function copyFile(sourceDir, relativePath) {
  const source = path.join(sourceDir, relativePath);
  const destination = path.join(outputRoot, relativePath);
  if (!fs.existsSync(source)) fail('缺少源文件：' + path.relative(projectRoot, source));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

/** 把离线版的 index.html 改造成飞书版：换数据层、加 JSSDK 和登录层 */
function buildIndexHtml(cfg) {
  const source = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8');
  let html = source;

  const dbTag = '<script src="js/db.js"></script>';
  if (html.indexOf(dbTag) === -1) {
    fail('v1/index.html 里找不到 <script src="js/db.js"></script>，无法替换数据层。\n' +
      '  如果首页结构改过，请同步更新 scripts/build-feishu.js。');
  }
  html = html.replace(dbTag, '<script src="js/db-remote.js"></script>');

  const firstLib = '<script src="js/lib/qrcode.min.js"></script>';
  if (html.indexOf(firstLib) === -1) fail('v1/index.html 里找不到二维码库的引入位置。');
  html = html.replace(
    firstLib,
    '<script src="' + cfg.jssdkUrl + '"></script>\n' +
    '  <script src="js/feishu-config.js"></script>\n' +
    '  ' + firstLib
  );

  const appTag = '<script src="js/app.js"></script>';
  if (html.indexOf(appTag) === -1) fail('v1/index.html 里找不到 js/app.js 的引入位置。');
  // 登录层与飞书扫码都放在 app.js 之前：app.js 一启动就会读数据库，
  // 那时登录必须已经在进行中了；扫码来源也要在界面用到它之前注册好。
  // feishu-jsapi.js 夹在两者之间：它要等登录拿令牌，而扫码又要等它鉴权完。
  html = html.replace(appTag,
    '<script src="js/feishu-auth.js"></script>\n  ' +
    '<script src="js/feishu-jsapi.js"></script>\n  ' +
    '<script src="js/feishu-scan.js"></script>\n  ' + appTag);

  const destination = path.join(outputRoot, 'index.html');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, html);
}

function buildRuntimeConfig(cfg) {
  const payload = {
    appId: cfg.appId,
    apiBase: cfg.apiBase
  };
  const destination = path.join(outputRoot, 'js', 'feishu-config.js');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination,
    '/* 由 scripts/build-feishu.js 生成，请勿手改；要改就改根目录的 feishu.config.json */\n' +
    'window.FEVER_CONFIG = ' + JSON.stringify(payload, null, 2) + ';\n');
}

function writeManifest() {
  const published = manifest.fromV1
    .concat(manifest.fromFeishu, ['index.html', 'js/feishu-config.js'])
    .sort();
  const lines = published.map(function (file) {
    const contents = fs.readFileSync(path.join(outputRoot, file));
    const hash = crypto.createHash('sha256').update(contents).digest('hex');
    return hash + '  ' + file;
  }).join('\n') + '\n';
  fs.writeFileSync(path.join(outputRoot, 'INTEGRITY.sha256'), lines);
  return published.length;
}

/**
 * 递归复制目录。
 * 这里不用 fs.cpSync：在本机的 Node 22 上它会让进程无输出地异常退出（退出码 127），
 * 手工 readdir + copyFile 反而稳。和 build-pages.js 用的是同一套做法。
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, destination);
    else fs.copyFileSync(source, destination);
  }
}

function syncToServer() {
  fs.rmSync(serverPublic, { recursive: true, force: true });
  copyTree(outputRoot, serverPublic);
}

const cfg = readConfig();

fs.rmSync(outputRoot, { recursive: true, force: true });
manifest.fromV1.forEach(function (file) { copyFile(sourceRoot, file); });
manifest.fromFeishu.forEach(function (file) { copyFile(feishuRoot, file); });
buildIndexHtml(cfg);
buildRuntimeConfig(cfg);
const count = writeManifest();
syncToServer();

console.log('飞书共享版已构建：' + path.relative(projectRoot, outputRoot));
console.log('  · 运行时文件 ' + count + ' 个');
console.log('  · 界面与业务代码 ' + manifest.fromV1.length + ' 个，直接取自 v1/（与离线版共用同一份，构建时原样复制不加工）');
console.log('  · 飞书版专有 ' + manifest.fromFeishu.length + ' 个：' + manifest.fromFeishu.join('、'));
console.log('  · 后端地址：' + (cfg.apiBase || '同域（由后端一并伺服前端）'));
console.log('  · 已同步一份到 ' + path.relative(projectRoot, serverPublic) + '，可直接随后端一起发布');
