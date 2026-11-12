/**
 * 打包提交的通知合并（第十五轮）。
 *
 * 需求方的原话是：「打包后提交采购申请后，管理员只收到一次飞书提醒」。
 * 十件东西发十条私聊，谁都会去把提醒关掉 —— 那提醒就等于没有。
 *
 * 用假 feishu 顶替 lib/feishu.js：不真发消息、不碰真实数据。
 * 跑法：cd server && node test-batch-notify.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const sent = [];
const fakeFeishu = {
  baseUrl: function (token) { return 'fake://base/' + token; },
  async tenantAccessToken() { return 'fake-token'; },
  async sendMessage(cfg, openId, text) {
    sent.push({ openId: openId, text: String(text || '') });
    return true;
  },
  async sendGroupWebhook() { return true; },
  async listTables() { return []; },
  async listRecords() { return []; },
  async batchCreate() { return []; },
  async batchUpdate() { return []; },
  async batchDelete() { return []; }
};

const feishuPath = require.resolve('./lib/feishu');
const stub = new Module(feishuPath, null);
stub.filename = feishuPath;
stub.loaded = true;
stub.exports = fakeFeishu;
require.cache[feishuPath] = stub;

const mod = require('./index.js');

/**
 * ⛔ 保护：known-users.json 在发布目录内，发布工具**不读 .gitignore**。
 * 测试只要碰了它，编出来的假 openId 就会跟着上线，顶掉真实登录记录
 * （假的 at 时间戳更新 → 那个人从此收不到飞书提醒）。
 * 所以这里先把原文件备份，跑完原样写回；并且全程只用内存里的假身份。
 */
const KNOWN_PATH = path.join(__dirname, 'known-users.json');
let knownBackup = null;
try { knownBackup = fs.readFileSync(KNOWN_PATH); } catch (err) { knownBackup = null; }
function restoreKnownUsers() {
  try {
    if (knownBackup === null) { if (fs.existsSync(KNOWN_PATH)) fs.unlinkSync(KNOWN_PATH); }
    else fs.writeFileSync(KNOWN_PATH, knownBackup);
  } catch (err) {
    console.warn('[测试] 没能还原 known-users.json，请手动检查：' + err.message);
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}
function settle() { return new Promise(function (r) { setTimeout(r, 20); }); }

/** 造一条"刚提交"的事件 */
function submitted(over) {
  return Object.assign({
    type: 'submitted',
    request: { id: 1, name: '打包件', quantity: 1, applicant: '王五', budget: '100', batchId: '' }
  }, over);
}

async function main() {
  console.log('\n打包提交 · 提醒合并测试\n');
  console.log('[1] 先让一个管理员登录过（否则私聊发不出去，数不出收件人）');
  // config.json 的 admins 里写的是姓名，靠登录记录反查 openId
  const admins = mod.adminOpenIds();
  if (!admins.length) {
    // ⚠️ 用纯内存的口子，**不要**调 rememberUser —— 它会写 known-users.json，
    // 而那个文件在发布目录里，编出来的假 openId 会跟着上线、顶掉真人（见文件头说明）
    mod.__setKnownUsers({ ou_admin_test: { name: '陈亮', at: '2026-01-01T00:00:00.000Z' } });
  }
  const adminCount = mod.adminOpenIds().length;
  check('至少认出一个管理员 openId', adminCount >= 1, adminCount);

  console.log('\n[2] 同一个批次的两条：管理员只收到一条提醒');
  sent.length = 0;
  mod.dispatchPurchaseNotifications([
    submitted({ request: { id: 1, name: '甲', quantity: 1, applicant: '王五', budget: '300', batchId: 'B-20261006-AAAA' } }),
    submitted({ request: { id: 2, name: '乙', quantity: 2, applicant: '王五', budget: '200', batchId: 'B-20261006-AAAA' } })
  ], { name: '管理员' });
  await settle();
  check('只发出一条（每个管理员一条）', sent.length === adminCount, '实际 ' + sent.length + ' 条 / 管理员 ' + adminCount + ' 人');
  const batchText = sent[0] ? sent[0].text : '';
  check('提醒里写了这一批有几条', batchText.indexOf('2 条采购申请') !== -1, batchText.slice(0, 60));
  check('提醒里带了批次号', batchText.indexOf('B-20261006-AAAA') !== -1, batchText.slice(0, 80));
  check('提醒里列了物品', batchText.indexOf('甲') !== -1 && batchText.indexOf('乙') !== -1, batchText.slice(0, 80));

  console.log('\n[3] 没带批次号的两条提交：照旧各发一条（不能把不相干的合并）');
  sent.length = 0;
  mod.dispatchPurchaseNotifications([
    submitted({ request: { id: 3, name: '丙', quantity: 1, applicant: '甲', budget: '10' } }),
    submitted({ request: { id: 4, name: '丁', quantity: 1, applicant: '甲', budget: '10' } })
  ], { name: '管理员' });
  await settle();
  check('两条各发一条', sent.length === adminCount * 2, '实际 ' + sent.length);

  console.log('\n[4] 两条不同的批次：各自合并，互不串台');
  sent.length = 0;
  mod.dispatchPurchaseNotifications([
    submitted({ request: { id: 5, name: '戊', quantity: 1, applicant: '甲', batchId: 'B-A' } }),
    submitted({ request: { id: 6, name: '己', quantity: 1, applicant: '甲', batchId: 'B-B' } })
  ], { name: '管理员' });
  await settle();
  check('两个批次发两条', sent.length === adminCount * 2, '实际 ' + sent.length);
  const texts = sent.map(function (s) { return s.text; }).join('||');
  check('两条分别带各自的批次号', texts.indexOf('B-A') !== -1 && texts.indexOf('B-B') !== -1);

  console.log('\n[5] 一大批（8 条）时提醒不会变成一份长清单');
  sent.length = 0;
  const many = [];
  for (let i = 1; i <= 8; i += 1) {
    many.push(submitted({ request: { id: 100 + i, name: '件' + i, quantity: 1, applicant: '甲', batchId: 'B-MANY' } }));
  }
  mod.dispatchPurchaseNotifications(many, { name: '管理员' });
  await settle();
  check('仍然只发一条', sent.length === adminCount, '实际 ' + sent.length);
  const manyText = sent[0] ? sent[0].text : '';
  check('只列前 5 件，其余用「等」带过', manyText.indexOf('件5') !== -1 && manyText.indexOf('件6') === -1,
    manyText.slice(0, 120));
  check('总数仍然是 8 条', manyText.indexOf('8 条采购申请') !== -1, manyText.slice(0, 60));

  console.log('\n[6] 批准事件不受影响：一条申请一条通知');
  sent.length = 0;
  mod.dispatchPurchaseNotifications([
    { type: 'approved', request: { id: 9, name: '庚', quantity: 1, applicant: '李四', budget: '10',
      batchId: 'B-20261006-AAAA', requesterOpenId: 'ou_member_test' } }
  ], { name: '管理员' });
  await settle();
  check('批准照发（哪怕它属于某个批次）', sent.length === 1, '实际 ' + sent.length);
  check('发给的是申请人本人', sent[0] && sent[0].openId === 'ou_member_test', sent[0] && sent[0].openId);

  console.log('\n--------------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  restoreKnownUsers();
  if (fail > 0) process.exitCode = 1;
}

main().catch(function (err) {
  console.error('测试运行失败：' + (err && err.stack ? err.stack : err));
  restoreKnownUsers();
  process.exitCode = 1;
});
