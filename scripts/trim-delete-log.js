#!/usr/bin/env node
/**
 * 修剪线上的「删除记录」（settings 里的 deleteLog）——运维脚本，可重复执行。
 *
 * ## 为什么需要它
 * 每次删除物品都会往 deleteLog 追加一票（含**整条物品快照**），它是全系统唯一
 * 持续长大的写入体。而删除的写请求是「删物品 + 写 deleteLog」同一个批次发出的，
 * 前端写请求带 `keepalive`，浏览器对它的上限是 **65536 字节（且在飞请求共享）**。
 *
 * 2026-10-20 实测：线上 deleteLog **122 票 / 65317 字节** → 删除请求体约 **65599 字节**
 * → 超出上限 63 字节 → **请求被浏览器整个拒发** → 前端兜底成
 * 「服务器异常 / 连不上服务器，稍后重试」→ 每次删除必失败。
 *
 * 线上跑的还是旧代码（发布通道不通），所以短期内只能靠**修剪这个字段**让删除恢复。
 * 只要把它控制在几十票，删除就一直能用 —— 这就是"稳定并长期工作"的那道闸。
 *
 * ## 用法
 *   node scripts/trim-delete-log.js                # 预览（不写线上）
 *   node scripts/trim-delete-log.js --apply        # 真写：保留最近 30 票
 *   node scripts/trim-delete-log.js --apply --keep=40
 *
 * ## 安全约定
 *   · 默认 **dry-run**，必须显式 `--apply` 才写线上
 *   · 写之前把**完整原值**备份到 `backup/trim-<时间>/deleteLog-before.json`
 *   · 只动 settings 里 `deleteLog` 一行，不碰任何业务数据
 *   · **最后一票永远保留**（那是刚才那次删除的留痕）
 *   · 写回后立刻回读校验票数与字节数
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const keepArg = args.find((a) => a.startsWith('--keep='));
const KEEP = Math.max(1, Number(keepArg ? keepArg.split('=')[1] : 30) || 30);

/** 与前端一致的"UTF-8 字节数"（不能用 String.length：汉字 length=1、字节数=3） */
function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function main() {
  const mod = require(path.join(ROOT, 'server', 'index.js'));
  const base = process.env.FEVER_BASE || 'https://fever-inventory.app.workbuddy.host';
  const token = mod.issueSession({ name: '运维·修剪删除记录', openId: 'ou_maintenance' });
  const headers = { 'Content-Type': 'application/json', 'X-Session-Token': token };

  console.log('目标：' + base);
  console.log('参数：保留最近 ' + KEEP + ' 票，' + (APPLY ? '**会写线上**' : '仅预览（加 --apply 才写）'));
  console.log('');

  // ---- 1. 读线上 ----
  const res = await fetch(base + '/api/data', { headers });
  if (!res.ok) throw new Error('读数据失败：HTTP ' + res.status);
  const body = await res.json();
  const settings = (body.data && body.data.settings) || [];
  const row = settings.filter((r) => r && r.key === 'deleteLog')[0];

  if (!row || !Array.isArray(row.value)) {
    console.log('线上没有 deleteLog（或格式不是数组），无需修剪。');
    return;
  }

  const all = row.value;
  const before = bytesOf(all);
  const kept = all.slice(-KEEP);
  const after = bytesOf(kept);

  console.log('当前：' + all.length + ' 票，' + before + ' 字节（' + (before / 1024).toFixed(1) + ' KB）');
  console.log('修剪后：' + kept.length + ' 票，' + after + ' 字节（' + (after / 1024).toFixed(1) + ' KB）');
  console.log('将丢弃 ' + (all.length - kept.length) + ' 票最老的记录');

  // 删除请求体的粗估：deleteLog 之外还有物品/流水等 op，实测余量约 300 字节
  const estBody = after + 300;
  const LIMIT = 65536;
  console.log('→ 预估删除请求体：约 ' + estBody + ' 字节，上限 ' + LIMIT
    + ' → ' + (estBody > LIMIT ? '❌ 仍然超限' : '✓ 安全（余量 ' + (LIMIT - estBody) + ' 字节）'));

  if (all.length <= KEEP) {
    console.log('');
    console.log('票数已经不超过 ' + KEEP + '，无需修剪。');
    return;
  }

  if (!APPLY) {
    console.log('');
    console.log('（预览模式，未写入。确认无误后加 --apply 执行）');
    return;
  }

  // ---- 2. 写前备份完整原值 ----
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13).replace(/(\d{8})(\d{2})/, '$1_$2');
  const dir = path.join(ROOT, 'backup', 'trim-' + stamp);
  fs.mkdirSync(dir, { recursive: true });
  const backupFile = path.join(dir, 'deleteLog-before.json');
  fs.writeFileSync(backupFile, JSON.stringify(all, null, 2), 'utf8');
  console.log('');
  console.log('已备份完整原值 → ' + path.relative(ROOT, backupFile) + '（' + all.length + ' 票）');

  // ---- 3. 写回（走与业务相同的一条通道：/api/write + put settings） ----
  const writeRes = await fetch(base + '/api/write', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ops: [{
        type: 'put',
        store: 'settings',
        data: {
          key: 'deleteLog',
          value: kept,
          updatedAt: new Date().toISOString()
        }
      }]
    })
  });
  const writeBody = await writeRes.json().catch(() => ({}));
  if (!writeRes.ok || writeBody.ok === false) {
    throw new Error('写入失败：HTTP ' + writeRes.status + ' ' + (writeBody.message || ''));
  }
  console.log('写回成功（HTTP ' + writeRes.status + '）');

  // ---- 4. 回读校验 ----
  const check = await fetch(base + '/api/data', { headers });
  const checkBody = await check.json();
  const row2 = ((checkBody.data && checkBody.data.settings) || []).filter((r) => r && r.key === 'deleteLog')[0];
  const now = row2 && Array.isArray(row2.value) ? row2.value : [];
  const nowBytes = bytesOf(now);
  console.log('');
  console.log('回读校验：' + now.length + ' 票，' + nowBytes + ' 字节 → '
    + (now.length === kept.length ? '✓ 票数一致' : '✗ 票数不符（期望 ' + kept.length + '）'));
  console.log('现在可以去网页上试删一件物品了。');
}

main().catch((err) => {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
