'use strict';

/**
 * 把线上（飞书多维表格）的全部数据导出一份**可恢复的**备份。
 *
 *   node scripts/backup-data.js            → 存到 backup/YYYY-MM-DD_HHmm/
 *   node scripts/backup-data.js D:/某目录   → 存到指定目录（比如网盘/U 盘）
 *
 * 产出三样东西：
 *   1. fever-backup-<时间>.json  —— 应用「设置 → 导入备份」能直接吃回去的格式
 *      （app / formatVersion / exportedAt / counts / data，与 Rules.exportAll 完全一致）
 *   2. items.csv                 —— 物品清单，Excel 直接打开（带 BOM，中文不乱码）
 *   3. transactions.csv          —— 出入库流水，同上
 *
 * 为什么要有它：数据虽然存在飞书多维表格里（应用挂了数据也不会丢），但**没有自动备份**
 * 就等于把"误操作/误删表"的风险全押在飞书的回收站上。这个脚本把数据落到你自己手里。
 *
 * 只读：只调 /api/data（GET），不写任何数据。
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const PORT = 8797;

function stamp(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes());
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(function (row) {
    lines.push(headers.map(function (h) { return csvCell(row[h]); }).join(','));
  });
  // Excel 不认 UTF-8 除非带 BOM —— 不带的话中文全是乱码
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const TXN_TYPE = {
  inbound: '入库', lend: '借出', return: '归还',
  consume: '领用', repair: '送修', repair_done: '修好回库'
};

async function main() {
  const outDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'backup', stamp(new Date()));

  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';

  // 借用后端模块自己签一个只读令牌（与线上同一套密钥派生，只用于本地读取）
  const mod = require(path.join(SERVER_DIR, 'index.js'));
  const server = mod.server;
  await new Promise(function (resolve) { server.listen(PORT, '127.0.0.1', resolve); });

  let body;
  try {
    const token = mod.issueSession({ openId: 'ou_backup', name: '备份脚本' });
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/data', {
      headers: { Authorization: 'Bearer ' + token }
    });
    body = await res.json();
    if (!body || !body.ok) throw new Error('读取失败：' + JSON.stringify(body).slice(0, 300));
  } finally {
    server.close();
  }

  const data = body.data || {};
  const stores = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];
  const counts = {};
  stores.forEach(function (name) { counts[name] = (data[name] || []).length; });

  const payload = {
    app: 'FEver 战队物资管理',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    counts: counts,
    data: data
  };

  fs.mkdirSync(outDir, { recursive: true });
  const base = 'fever-backup-' + stamp(new Date());
  const jsonPath = path.join(outDir, base + '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  // 物品清单（给人看的）
  const itemsCsv = toCsv(
    ['编码', '名称', '规格', '大类', '存放位置', '状态', '总数', '在库', '借出', '待修', '已领用', '总价', '入库时间', '备注'],
    (data.items || []).map(function (it) {
      return {
        '编码': it.code, '名称': it.name, '规格': it.spec,
        '大类': it.categoryId, '存放位置': it.location,
        '状态': it.status, '总数': it.totalQty, '在库': it.inStockQty,
        '借出': it.lentQty, '待修': it.repairQty, '已领用': it.usedUpQty,
        '总价': it.price, '入库时间': fmtTime(it.createdAt), '备注': it.remark
      };
    })
  );
  fs.writeFileSync(path.join(outDir, 'items.csv'), itemsCsv, 'utf8');

  // 流水（给人看的）
  const txCsv = toCsv(
    ['时间', '类型', '物品编码', '物品名称', '数量', '操作人', '借用人', '预计归还', '用途/说明'],
    (data.transactions || []).slice().sort(function (a, b) {
      return String(a.createdAt).localeCompare(String(b.createdAt));
    }).map(function (t) {
      return {
        '时间': fmtTime(t.createdAt), '类型': TXN_TYPE[t.type] || t.type,
        '物品编码': t.itemCode, '物品名称': t.itemName, '数量': t.qty,
        '操作人': t.operator, '借用人': t.borrower, '预计归还': t.dueDate, '用途/说明': t.purpose
      };
    })
  );
  fs.writeFileSync(path.join(outDir, 'transactions.csv'), txCsv, 'utf8');

  fs.writeFileSync(path.join(outDir, '备份说明.txt'),
    'FEver 战队物资管理 —— 数据备份\r\n' +
    '导出时间：' + fmtTime(payload.exportedAt) + '\r\n\r\n' +
    'fever-backup-*.json  完整数据，可在应用「设置 → 导入备份」里直接恢复（会整体替换现有数据）。\r\n' +
    'items.csv            物品清单，Excel 可直接打开。\r\n' +
    'transactions.csv     出入库流水，Excel 可直接打开。\r\n\r\n' +
    '各表条数：' + stores.map(function (n) { return n + ' ' + counts[n]; }).join('、') + '\r\n' +
    '建议把整个目录复制到网盘或 U 盘，别只留在本机。\r\n', 'utf8');

  console.log('备份完成：' + outDir);
  console.log('  ' + base + '.json（' + Math.round(fs.statSync(jsonPath).size / 1024) + ' KB，可导入恢复）');
  console.log('  items.csv（' + counts.items + ' 条）、transactions.csv（' + counts.transactions + ' 条）');
  console.log('  各表：' + stores.map(function (n) { return n + ' ' + counts[n]; }).join('、'));
}

main().catch(function (err) {
  console.error('备份失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
