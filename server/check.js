'use strict';

/**
 * 自检脚本：把后端跟飞书对接的每一步单独跑一遍，并把飞书返回的原始内容打出来。
 * 出问题时先跑这个，能直接看出是凭证不对、权限没开，还是别的。
 *
 * 用法：node check.js
 *
 * 这个脚本**不会创建、修改、删除任何东西**——它只做只读探测。
 * 建表请用 `node init-base.js`。
 */

const fs = require('node:fs');
const path = require('node:path');
const feishu = require('./lib/feishu');
const store = require('./lib/store');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/** 探测权限用的假 app_token。它一定不存在，用来把「权限不足」和「文档不存在」区分开 */
const PROBE_TOKEN = 'probe_no_such_base_token';

function line(title) {
  console.log('\n===== ' + title + ' =====');
}

function showBody(err) {
  if (err && err.payload) {
    console.log('飞书原始返回：' + JSON.stringify(err.payload));
  }
  if (err && typeof err.feishuCode === 'number') {
    console.log('飞书错误码：' + err.feishuCode);
  }
  console.log('错误信息：' + (err && err.message ? err.message : err));
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('缺少 server/config.json，先填好 appId / appSecret。');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  line('1. 应用凭证（tenant_access_token）');
  try {
    const token = await feishu.tenantAccessToken(cfg);
    console.log('OK  凭证有效，令牌长度 ' + token.length);
  } catch (err) {
    console.log('FAIL');
    showBody(err);
    return;
  }

  line('2. 多维表格权限（只读探测，不会建任何东西）');
  let hasBitableScope = false;
  try {
    // 拿一个不存在的 app_token 去列数据表：
    //   权限没开 → 99991672（连业务层都没进）
    //   权限已开 → 会报「文档不存在」之类，说明请求已经进到业务层了
    await feishu.listTables(cfg, PROBE_TOKEN);
    hasBitableScope = true;
    console.log('OK  权限正常');
  } catch (err) {
    if (err && err.feishuCode === 99991672) {
      console.log('FAIL  bitable:app 权限还没开通（错误码 99991672）');
      console.log('  开通链接：https://open.feishu.cn/app/' + cfg.appId +
        '/auth?q=bitable:app,base:app:create&op_from=openapi&token_type=tenant');
      console.log('  开完记得去「版本管理与发布」重新发布，否则不生效。');
      showBody(err);
      return;
    }
    hasBitableScope = true;
    console.log('OK  权限正常（探测请求已被飞书受理，返回的是文档相关的错误，这是预期的）');
    console.log('    返回信息：' + (err && err.message ? err.message : err));
  }
  if (!hasBitableScope) return;

  line('3. 已有多维表格与数据表');
  if (!cfg.bitableAppToken) {
    console.log('尚未创建。运行下面这条命令，会自动建好多维表格和 ' +
      store.STORES.length + ' 张数据表：');
    console.log('  node init-base.js');
    return;
  }
  console.log('app_token = ' + cfg.bitableAppToken);
  console.log('地址：' + feishu.baseUrl(cfg.bitableAppToken));
  try {
    const tables = await feishu.listTables(cfg, cfg.bitableAppToken);
    const names = new Set(tables.map(function (t) { return t.name; }));
    console.log('共 ' + tables.length + ' 张表：');
    tables.forEach(function (t) { console.log('    ' + t.name + '  (' + t.table_id + ')'); });

    const missing = store.STORES
      .map(function (name) { return store.tableName(name); })
      .filter(function (n) { return !names.has(n); });
    if (missing.length) {
      console.log('\n缺少需要的表：' + missing.join('、'));
      console.log('再跑一次 `node init-base.js` 会把缺的补上（已存在的表不会被动）。');
    } else {
      console.log('\n6 张业务表齐全。');
    }
  } catch (err) {
    console.log('FAIL');
    showBody(err);
  }
}

main().catch(function (err) {
  console.error('自检脚本自己出错了：' + err);
  process.exit(1);
});
