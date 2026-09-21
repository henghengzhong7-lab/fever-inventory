/**
 * 浏览器端到端测试的小工具。
 *
 * 做法：用本机 Node 起一个只监听 127.0.0.1 的静态服务，
 * 再用本机 Chrome 的无头模式打开页面，把页面里的测试结果读回来。
 * 完全离线，不装任何依赖。
 *
 * 页面侧的脚本负责执行操作、收集结果，
 * 并把结果写进 <pre id="e2e-out">，读回来就是测试报告。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function findChrome() {
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe')
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('没有找到 Chrome 或 Edge，无法运行浏览器端测试');
  return found;
}

function createServer(extraRoutes) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('bad');
      return;
    }

    if (extraRoutes && extraRoutes[urlPath]) {
      const body = extraRoutes[urlPath](req);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    // 测试专用的"闸门"：一直不回应，拖住页面 load 事件，
    // 让浏览器等测试跑完（测试结束时会把这个请求换成 data URL）。
    if (urlPath === '/e2e-hang') return;

    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
}

/** 打开一个页面并把 <pre id="e2e-out"> 的内容取回来 */
function openPage(url, opts) {
  const o = opts || {};
  const chrome = findChrome();
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--user-data-dir=' + o.profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,BackForwardCache',
    '--dump-dom', url
  ];
  return new Promise((resolve, reject) => {
    const cp = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    cp.stdout.on('data', (d) => { out += d.toString('utf8'); });
    cp.on('error', reject);
    cp.on('close', () => resolve(out));
  });
}

/** 从 DOM 文本里抠出测试输出 */
function extract(dom) {
  // 注意：<pre> 后面还会带 style / data-done 等属性，匹配时不能写死
  const m = dom.match(/<pre id="e2e-out"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * 打开一个测试页面。
 *
 * port 传 0（默认）时用系统随机端口，适合"每次都是干净数据"的用例。
 * 但浏览器是按「协议 + 主机 + 端口」分区存 IndexedDB 的，
 * 要验证"关掉浏览器再打开数据还在"，两次打开必须用同一个端口。
 */
async function runPage(server, routePath, profile, port) {
  await new Promise((resolve) => server.listen(port || 0, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  const url = 'http://127.0.0.1:' + actualPort + routePath;
  const dom = await openPage(url, { profile });
  server.close();
  return { dom, text: extract(dom) };
}

module.exports = { ROOT, createServer, openPage, extract, runPage, findChrome };
