/**
 * 跑「写入体验」浏览器端到端测试。
 *
 *   node feishu/test/e2e-async.js
 *
 * 做法和 v1 那套端到端测试一样：用本机 Node 起一个只监听 127.0.0.1 的静态服务，
 * 再用本机 Chrome 的无头模式打开测试页，把页面里的测试报告读回来。
 * 完全离线，不装任何依赖，也**不碰真实的多维表格**（接口由页面里的假后端顶替）。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe')
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('没有找到 Chrome 或 Edge，无法运行浏览器端测试');
  return found;
}

function createServer() {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('bad');
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

function openPage(url, profile) {
  const chrome = findChrome();
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--user-data-dir=' + profile,
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

function extract(dom) {
  const m = dom.match(/<pre id="e2e-out"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

(async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/feishu/test/e2e-async.html';
  const profile = path.join(os.tmpdir(), 'fever-e2e-' + Date.now());

  let dom;
  try {
    dom = await openPage(url, profile);
  } finally {
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const text = extract(dom);
  if (!text) {
    console.error('没有读到测试报告。页面可能没跑起来。');
    console.error(dom.slice(0, 2000));
    process.exit(1);
  }
  console.log(text);
  const m = text.match(/通过 (\d+) 项，失败 (\d+) 项/);
  process.exit(m && Number(m[2]) === 0 ? 0 : 1);
})().catch(function (err) {
  console.error('跑不起来：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
