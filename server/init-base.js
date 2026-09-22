'use strict';

/**
 * 一次性初始化脚本：在指定的多维表格里建好 6 张数据表，并把 app_token / table_id 写回 config.json。
 *
 * 用法：
 *   node init-base.js                      # 用应用身份新建一个多维表格（表归应用所有）
 *   node init-base.js <链接或 app_token>    # 认领一个已有的多维表格（推荐：用你自己在飞书里建的那个）
 *
 * 为什么推荐用你自己建的：
 *   应用身份创建的表格，所有者是「应用」，协作者列表里只有应用自己——你在飞书里看不到它，
 *   也没法直接在飞书里翻台账。用你自己建的表格，数据就实实在在躺在你的空间里。
 *   代价只是要在那张表上把应用加为「可编辑」的文档协作者（一次即可）。
 *
 * 重复运行是安全的：已经存在的表不会被重建，也不会动里面的数据。
 */

const fs = require('node:fs');
const path = require('node:path');
const feishu = require('./lib/feishu');
const store = require('./lib/store');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');
const BASE_NAME = 'FEver 战队物资管理';

/** 飞书新建多维表格时会自动带一张空的「数据表」，建完业务表后把它清掉 */
const DEFAULT_TABLE_NAME = '数据表';

function fail(message) {
  console.error('\n[初始化失败] ' + message + '\n');
  process.exit(1);
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
      console.log('已根据 config.example.json 生成 config.json\n');
    }
    fail('请先打开 ' + CONFIG_PATH + ' ，填入飞书应用的 appId 和 appSecret。\n' +
      '  拿法：飞书开发者后台 → 你的应用 → 凭证与基础信息 → 应用凭证。');
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    fail('config.json 不是合法的 JSON：' + err.message);
  }
  if (!cfg.appId || !cfg.appSecret || cfg.appId.indexOf('cli_') !== 0) {
    fail('config.json 里的 appId / appSecret 还没填对。appId 以 cli_ 开头。');
  }
  cfg.tableIds = cfg.tableIds || {};
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * 从用户发来的东西里抠出 app_token。
 * 支持三种写法：完整链接、带 table 参数的链接、光秃秃的一串 token。
 */
function extractAppToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.indexOf('://') === -1 && raw.indexOf('/') === -1) return raw;
  // https://xxx.feishu.cn/base/XXXXXXXX?table=tblYYYY&view=vewZZZZ
  const byPath = /\/(?:base|bitable)\/([A-Za-z0-9]+)/.exec(raw);
  if (byPath) return byPath[1];
  return '';
}

async function ensureTables(cfg) {
  const existing = await feishu.listTables(cfg, cfg.bitableAppToken);
  const byName = new Map();
  existing.forEach(function (t) { byName.set(t.name, t); });

  for (const name of store.STORES) {
    const wanted = store.tableName(name);
    const hit = byName.get(wanted);
    if (hit) {
      cfg.tableIds[name] = hit.table_id;
      console.log('  已有数据表 ' + wanted + '  (' + hit.table_id + ')');
      continue;
    }
    const created = await feishu.createTable(cfg, cfg.bitableAppToken, wanted, store.tableFields());
    if (!created || !created.table_id) fail('创建数据表「' + wanted + '」失败：飞书没有返回 table_id。');
    cfg.tableIds[name] = created.table_id;
    console.log('  已创建数据表 ' + wanted + '  (' + created.table_id + ')');
  }
  saveConfig(cfg);
}

/**
 * 清掉飞书自带的空白「数据表」。
 * 只在它一条非空记录都没有、并且确实还有别的表时才删——多维表格不允许删掉最后一张表。
 */
async function dropDefaultTable(cfg) {
  let tables;
  try {
    tables = await feishu.listTables(cfg, cfg.bitableAppToken);
  } catch (err) {
    return;
  }
  const junk = tables.filter(function (t) { return t.name === DEFAULT_TABLE_NAME; });
  if (!junk.length) return;
  if (tables.length - junk.length < 1) {
    console.log('  （只剩「' + DEFAULT_TABLE_NAME + '」一张表，保留不删）');
    return;
  }

  for (const table of junk) {
    let records;
    try {
      records = await feishu.listRecords(cfg, cfg.bitableAppToken, table.table_id);
    } catch (err) {
      console.log('  （读「' + DEFAULT_TABLE_NAME + '」失败，跳过：' + err.message + '）');
      continue;
    }
    const dirty = records.filter(function (r) {
      return Object.keys(r.fields || {}).length > 0;
    });
    if (dirty.length) {
      console.log('  （「' + DEFAULT_TABLE_NAME + '」里有 ' + dirty.length + ' 条非空记录，保留不动）');
      continue;
    }
    try {
      await feishu.deleteTable(cfg, cfg.bitableAppToken, table.table_id);
      console.log('  已清掉飞书自带的空白表「' + DEFAULT_TABLE_NAME + '」');
    } catch (err) {
      console.log('  （删「' + DEFAULT_TABLE_NAME + '」失败，不影响使用：' + err.message + '）');
    }
  }
}

/** 建好之后，检查应用对这张表到底有没有读写权限 */
async function verifyAccess(cfg) {
  try {
    await feishu.listTables(cfg, cfg.bitableAppToken);
  } catch (err) {
    const code = err && err.feishuCode;
    if (code === 91402 || code === 1254005 || /not\s*found/i.test(err.message || '')) {
      fail('应用没有这张多维表格的权限。\n' +
        '  在飞书里打开那张表 → 右上角「···」→「更多」→「添加文档应用」→ 选中这个自建应用，' +
        '权限选「可编辑」，然后重跑本脚本。');
    }
    fail('访问多维表格失败：' + err.message);
  }
}

async function main() {
  const cfg = readConfig();
  const adopt = extractAppToken(process.argv[2] || process.env.BITABLE_APP_TOKEN || '');

  if (process.argv[2] && !adopt) {
    fail('没能从「' + process.argv[2] + '」里认出 app_token。\n' +
      '  直接把飞书里那张多维表格的链接整条粘过来就行，形如 https://xxx.feishu.cn/base/AbCdEf123456?table=xxx');
  }

  console.log('正在连接飞书开放平台……');

  // 第一步：拿到应用身份的令牌，顺便验证凭证是否正确
  let token;
  try {
    token = await feishu.tenantAccessToken(cfg);
  } catch (err) {
    if (err.feishuCode === 10003 || err.feishuCode === 10014) {
      fail('App ID 或 App Secret 不正确（飞书错误码 ' + err.feishuCode + '）。');
    }
    fail('连不上飞书或凭证有误：' + err.message);
  }
  console.log('凭证验证通过（tenant_access_token 长度 ' + token.length + '）');

  // 第二步：确定用哪张多维表格
  if (adopt) {
    cfg.bitableAppToken = adopt;
    saveConfig(cfg);
    console.log('使用指定的多维表格：' + adopt);
    await verifyAccess(cfg);
    console.log('  权限正常');
  } else if (!cfg.bitableAppToken) {
    console.log('config.json 里还没有 bitableAppToken，正在新建一个多维表格……');
    let app;
    try {
      app = await feishu.createApp(cfg, BASE_NAME, cfg.folderToken);
    } catch (err) {
      if (err.feishuCode === 99991672 || err.feishuCode === 1061002 || /permission/i.test(err.message || '')) {
        fail('创建多维表格被拒绝：应用缺少「查看、评论、编辑和管理多维表格」权限。\n' +
          '  请到飞书开发者后台 → 权限管理，开通 bitable:app，然后重新发布一次。');
      }
      fail('创建多维表格失败：' + err.message);
    }
    if (!app || !app.app_token) fail('飞书没有返回 app_token，多维表格可能没建成功。');
    cfg.bitableAppToken = app.app_token;
    saveConfig(cfg);
    console.log('多维表格已创建：' + feishu.baseUrl(app.app_token));
    console.log('  ⚠️ 注意：这张表的所有者是「应用」，你在飞书里看不到它。');
    console.log('  想让它出现在你自己的空间里，请改用：node init-base.js <你自己建的表链接>');
  } else {
    console.log('复用 config.json 里已有的多维表格：' + cfg.bitableAppToken);
    await verifyAccess(cfg);
  }

  // 第三步：逐张对齐数据表
  console.log('\n对齐数据表：');
  await ensureTables(cfg);

  // 第四步：清掉飞书自带的空白表
  await dropDefaultTable(cfg);

  console.log('\n初始化完成。');
  console.log('多维表格地址：' + feishu.baseUrl(cfg.bitableAppToken));
  console.log('\n下一步：');
  console.log('  在飞书里打开上面这个链接，应该能看到 ' + store.STORES.length + ' 张表头为「FEver·」的数据表。');
  console.log('  想只看台账不看 JSON，把「摘要」列拖到前面，或者隐藏掉「数据」列即可。');
}

main().catch(function (err) {
  console.error('\n[初始化失败] ' + (err && err.message ? err.message : err));
  if (err && err.payload) console.error(JSON.stringify(err.payload).slice(0, 500));
  process.exit(1);
});
