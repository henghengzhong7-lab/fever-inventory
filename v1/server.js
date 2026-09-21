/**
 * FEver 战队物资管理 —— 本地静态服务
 *
 * 用途：用本机 Node 起一个只监听 127.0.0.1 的静态文件服务，
 * 让浏览器能以 http:// 方式打开应用。原因是浏览器在 file:// 方式下
 * 不允许使用 IndexedDB（存储会卡住），所以必须走本地 http。
 *
 * 完全离线：不访问外网，不监听局域网，只服务本目录下的文件。
 *
 * 用法：
 *   node server.js                  正常运行并自动打开浏览器
 *   node server.js --no-open        只起服务，不打开浏览器（测试用）
 *   node server.js --port 9000      指定端口
 *
 * 【重要】端口必须固定，不能"被占用就自动换一个"。
 * 浏览器把 IndexedDB 按「协议 + 主机 + 端口」分开存放：
 *   http://127.0.0.1:8321 和 http://127.0.0.1:8322 是两套互不相通的数据。
 * 如果端口悄悄换了，使用者会以为"东西全没了"。
 * 所以本服务只认 8321，端口被占时宁可报错说清楚，也不偷偷换端口。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
const portArgIndex = argv.indexOf('--port');

/** 固定端口：数据就是按这个端口存的，换了端口等于换了数据库 */
const DEFAULT_PORT = 8321;
const startPort = portArgIndex >= 0 ? Number(argv[portArgIndex + 1]) : DEFAULT_PORT;

/** 用来判断"8321 上跑的是不是我们这个应用" */
const APP_MARKER = 'x-fever-app';
const APP_MARKER_VALUE = 'FEver-Inventory-V1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 找不到文件');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 带上这个标记，启动时才能判断占着端口的是不是我们自己
      [APP_MARKER]: APP_MARKER_VALUE,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  // 只允许访问本目录内的文件，防止路径穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 越界访问');
    return;
  }
  sendFile(res, filePath);
});

function openBrowser(url) {
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe')
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (found) {
    spawn(found, [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** 端口被占时，问一句"占着的是不是我们自己"，决定提示怎么写 */
function probeExisting(port, cb) {
  const req = http.request(
    { host: '127.0.0.1', port: port, path: '/index.html', method: 'GET', timeout: 1500 },
    (res) => {
      const mine = res.headers[APP_MARKER] === APP_MARKER_VALUE;
      res.resume();
      cb(mine);
    }
  );
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.on('error', () => cb(false));
  req.end();
}

function reportPortTaken(port) {
  probeExisting(port, (mine) => {
    console.error('');
    console.error('  无法启动：端口 ' + port + ' 已经被占用了。');
    console.error('');
    if (mine) {
      console.error('  看起来 FEver 战队物资管理已经在运行了。');
      console.error('  请直接使用这个地址，不要重复启动：');
      console.error('    http://127.0.0.1:' + port + '/index.html');
    } else {
      console.error('  这个端口被别的程序占用了。');
    }
    console.error('');
    console.error('  【重要】请不要换成别的端口来启动。');
    console.error('  浏览器是按「地址 + 端口」分开保存数据的，换端口会看不到原来的数据，');
    console.error('  看起来就像"东西全丢了"。请先把占用 ' + port + ' 的程序关掉再启动。');
    console.error('');
    process.exitCode = 1;
  });
}

server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') reportPortTaken(startPort);
  else {
    console.error('启动失败：' + err.message);
    process.exitCode = 1;
  }
});

server.listen(startPort, '127.0.0.1', () => {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/index.html';
  console.log('==============================================');
  console.log(' FEver 战队物资管理已启动');
  console.log(' 请在浏览器中使用：' + url);
  console.log(' 数据保存在本机浏览器里，关掉本窗口不影响数据。');
  console.log(' 【重要】请始终用这个地址（端口 ' + port + '）。');
  console.log('         换端口会看不到原来的数据。');
  console.log(' 用完直接关闭本窗口即可。');
  console.log('==============================================');
  if (!noOpen) openBrowser(url);
});
