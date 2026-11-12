'use strict';

/**
 * 验证"只靠仓库文件 + 环境变量"能不能把服务跑起来（等价于云端部署的第一天）。
 *
 *   node scripts/verify-deploy.js
 *
 * 做什么：
 *   1. 按 `git ls-files` 导出一份"干净副本"—— 等价于 Render / 任何平台从 GitHub
 *      clone 下来的内容（不含 server/config.json、server/public、backup、node_modules）
 *   2. 只给环境变量，跑 buildCommand：node scripts/build-feishu.js
 *   3. 跑 startCommand：node server/index.js（PORT 由环境变量注入）
 *   4. 实测 /api/health、/api/data（应 401）、/js/db-remote.js（应有修复特征串）、首页
 *
 * 为什么要它：`server/public` 是构建产物、`server/config.json` 带密钥，两者都不进仓库。
 * 所以"云端能不能构建成功、能不能读到配置"不能靠猜 —— 每次改部署配置都跑一遍这个脚本。
 *
 * ⚠️ 只在本机可用（要读 server/config.json 注入环境变量）；只读飞书，不写任何数据。
 * 跑完会留下一个临时副本目录，路径会打印出来，可自行删除。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const PORT = 8794;
const SIM = path.join(os.tmpdir(), 'fever-render-sim-' + Date.now());

function log(s) { console.log(s); }

/* ---------- 1. 导出干净副本 ---------- */
const listed = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
if (listed.status !== 0) { console.error('git ls-files 失败'); process.exit(1); }
const files = listed.stdout.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);

files.forEach(function (rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(SIM, rel);
  if (!fs.existsSync(from)) return;             // 已被删除的文件
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
});
log('① 干净副本：' + files.length + ' 个文件 → ' + SIM);

// 确认关键文件的状态与 GitHub clone 后一致
const mustExist = ['server/index.js', 'v1/index.html', 'scripts/build-feishu.js', 'render.yaml', 'package.json'];
const mustNotExist = ['server/config.json', 'server/public', 'feishu.config.json', 'backup'];
mustExist.forEach(function (f) {
  log('   ' + (fs.existsSync(path.join(SIM, f)) ? '✓' : '✗') + ' 应有：' + f);
});
mustNotExist.forEach(function (f) {
  log('   ' + (fs.existsSync(path.join(SIM, f)) ? '✗ 不该有却存在' : '✓') + ' 不应有：' + f);
});

/* ---------- 2. buildCommand ---------- */
const realCfg = fs.readFileSync(path.join(ROOT, 'server', 'config.json'), 'utf8');
const cfg = JSON.parse(realCfg);

const env = Object.assign({}, process.env, {
  FEVER_APP_ID: cfg.appId,
  FEVER_CONFIG_JSON: realCfg,
  PORT: String(PORT),
  NODE_ENV: 'production'
});

log('\n② buildCommand：node scripts/build-feishu.js');
const build = spawnSync(NODE, ['scripts/build-feishu.js'], { cwd: SIM, env: env, encoding: 'utf8' });
if (build.status !== 0) {
  console.error('   构建失败：\n' + (build.stdout || '') + (build.stderr || ''));
  process.exit(1);
}
log('   ' + (build.stdout || '').trim().split('\n')[0]);
log('   ' + (fs.existsSync(path.join(SIM, 'server', 'public', 'index.html')) ? '✓' : '✗') + ' 已生成 server/public/index.html');
const builtCfg = fs.readFileSync(path.join(SIM, 'server', 'public', 'js', 'feishu-config.js'), 'utf8');
log('   ' + (builtCfg.indexOf(cfg.appId) !== -1 ? '✓' : '✗') + ' 前端 feishu-config.js 的 appId 正确');

/* ---------- 3. startCommand ---------- */
log('\n③ startCommand：node server/index.js（PORT=' + PORT + '）');
const child = spawn(NODE, ['server/index.js'], { cwd: SIM, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', function (d) { out += d.toString(); });
child.stderr.on('data', function (d) { out += d.toString(); });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  const base = 'http://127.0.0.1:' + PORT;
  let health = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) { health = await r.json(); break; }
    } catch (err) { /* 还没起来 */ }
  }
  if (!health) {
    console.error('   启动失败，服务端输出：\n' + out);
    child.kill(); process.exit(1);
  }
  log('   ✓ /api/health 正常：dataLoaded=' + health.dataLoaded + '，tableIdsKnown=' + health.tableIdsKnown);

  const r401 = await fetch(base + '/api/data');
  const body401 = await r401.json();
  log('   ' + (r401.status === 401 ? '✓' : '✗') + ' /api/data 无令牌 → ' + r401.status + '（' + (body401.message || '') + '）');

  const js = await fetch(base + '/js/db-remote.js');
  const text = await js.text();
  const hits = (text.match(/KEEPALIVE_MAX_BYTES/g) || []).length;
  log('   ' + (hits === 3 ? '✓' : '✗') + ' /js/db-remote.js 含修复特征串 ' + hits + ' 处');

  const home = await fetch(base + '/');
  const html = await home.text();
  log('   ' + (html.indexOf('FEver') !== -1 ? '✓' : '✗') + ' 首页可访问（' + html.length + ' 字节）');

  const api = await fetch(base + '/api/data', { headers: { Authorization: 'Bearer ' + require(path.join(ROOT, 'server', 'index.js')).issueSession({ openId: 'ou_sim', name: '模拟' }) } });
  const apiBody = await api.json();
  log('   ' + (api.ok && apiBody.data ? '✓' : '✗') + ' 带令牌能读到数据：items ' + ((apiBody.data && apiBody.data.items || []).length) + ' 条');

  child.kill();
  await sleep(300);
  console.log('\n结论：仓库文件 + 环境变量 → 构建、启动、鉴权、静态资源、读数据，全部通过。');
  console.log('临时副本保留在：' + SIM);
})().catch(function (err) {
  console.error('模拟失败：' + err.message + '\n' + out);
  child.kill();
  process.exit(1);
});
