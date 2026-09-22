'use strict';

/**
 * 性能探针：拆开测量「一次保存」里每个环节的真实耗时。
 *
 * 全程只读（只调 listTables / listRecords），不写任何数据。
 * 目的是判断瓶颈到底在飞书接口往返、还是在后端自身计算。
 *
 * 用法：node perf-probe.js
 */

const fs = require('node:fs');
const path = require('node:path');
const feishu = require('./lib/feishu');
const store = require('./lib/store');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function ms(n) {
  return String(Math.round(n)).padStart(6) + ' ms';
}

async function time(label, fn) {
  const t0 = process.hrtime.bigint();
  let out;
  try {
    out = await fn();
  } catch (err) {
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  ' + label.padEnd(38) + ms(dt) + '   [失败] ' + (err.message || err));
    return null;
  }
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  ' + label.padEnd(38) + ms(dt));
  return out;
}

function stats(list) {
  if (!list.length) return '(无样本)';
  const sorted = list.slice().sort((a, b) => a - b);
  const sum = list.reduce((a, b) => a + b, 0);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return '最小 ' + Math.round(sorted[0]) +
    '  中位 ' + Math.round(p(0.5)) +
    '  P90 ' + Math.round(p(0.9)) +
    '  最大 ' + Math.round(sorted[sorted.length - 1]) +
    '  平均 ' + Math.round(sum / list.length) + ' ms';
}

(async function main() {
  console.log('=== 0) 本机到飞书开放平台的基础延迟 ===');
  console.log('  （这个数值代表单次 HTTPS 往返，保存操作的耗时主要由它按倍数累积）');
  console.log();

  const t0 = Date.now();
  await time('第 1 次拿 tenant_access_token（冷启动）', () => feishu.tenantAccessToken(CFG));
  console.log('  总耗时 ' + ms(Date.now() - t0));
  await time('第 2 次拿 tenant_access_token（走缓存）', () => feishu.tenantAccessToken(CFG));

  console.log();
  console.log('=== 1) 列数据表（只调 1 次）===');
  const tables = await time('listTables', () => feishu.listTables(CFG, CFG.bitableAppToken));
  if (!tables) { console.log('  拿不到表列表，后续无法继续'); return; }
  console.log('  共 ' + tables.length + ' 张表：' + tables.map((t) => t.name).join('、'));

  console.log();
  console.log('=== 2) 逐张拉数据（这是服务重启后「首次访问」的真实成本）===');
  const perTable = [];
  let totalRecords = 0;
  for (const t of tables) {
    const rows = await time('listRecords  ' + t.name, () => feishu.listRecords(CFG, CFG.bitableAppToken, t.table_id));
    if (rows) {
      totalRecords += rows.length;
      console.log('       └ 这张表有 ' + rows.length + ' 条记录');
    }
  }
  console.log('  全部记录数：' + totalRecords);

  console.log();
  console.log('=== 3) 连续 12 次读取，看延迟是否稳定（验证连接有没有被复用）===');
  const first = tables[0];
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    const t1 = process.hrtime.bigint();
    await feishu.listRecords(CFG, CFG.bitableAppToken, first.table_id);
    samples.push(Number(process.hrtime.bigint() - t1) / 1e6);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('  ' + stats(samples));
  console.log('  明细：' + samples.map((v) => Math.round(v)).join(', '));

  console.log();
  console.log('=== 4) 后台连续快速发起（模拟多人同时保存，看会不会被限流）===');
  const burst = [];
  const burstStart = Date.now();
  for (let i = 0; i < 6; i += 1) {
    const t2 = process.hrtime.bigint();
    try {
      await feishu.listRecords(CFG, CFG.bitableAppToken, first.table_id);
      burst.push(Number(process.hrtime.bigint() - t2) / 1e6);
    } catch (err) {
      burst.push(Number(process.hrtime.bigint() - t2) / 1e6);
      console.log('  第 ' + (i + 1) + ' 次失败：' + (err.message || err));
    }
  }
  console.log('  ' + stats(burst));
  console.log('  6 次串行总耗时 ' + Math.round(Date.now() - burstStart) + ' ms');
  console.log('  明细：' + burst.map((v) => Math.round(v)).join(', '));

  console.log();
  console.log('=== 5) 结论参考 ===');
  console.log('  单次飞书接口往返中位值：约 ' + Math.round(burst.concat(samples).sort((a, b) => a - b)[Math.floor((burst.length + samples.length) / 2)]) + ' ms');
  console.log('  → 一次保存如果只动 1 张表，大致就是「1 次往返」的成本；');
  console.log('    如果同时有新增+修改+删除，或跨多张表，则按次数累加。');
})().catch(function (err) {
  console.log('探针异常：' + (err && err.message ? err.message : err));
  if (err && err.payload) console.log(JSON.stringify(err.payload));
});
