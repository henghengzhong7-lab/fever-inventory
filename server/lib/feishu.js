'use strict';

/**
 * 飞书开放平台 API 封装（只依赖 Node 内置 fetch，不引第三方包）。
 *
 * 这个模块只做「怎么跟飞书说话」，不含任何业务判断：
 *   - access_token 的获取与缓存（tenant / app）
 *   - 免登 code 换取 user_access_token（按 v3 → v2 → v1 依次降级尝试）
 *   - 读用户信息
 *   - 多维表格的增删改查
 *
 * 所有请求都带重试：多维表格在多人在线时会返回「写冲突」「请求过快」，
 * 这类错误重试一次基本就过了，不该直接甩给使用者。
 */

const crypto = require('node:crypto');

const OPEN_HOST = 'https://open.feishu.cn';
const ACCOUNTS_HOST = 'https://accounts.feishu.cn';

/** 可以安全重试的错误码：频率限制 / 写冲突 / 数据未就绪 / 服务端抖动 */
const RETRYABLE = new Set([1254290, 1254291, 1254607, 1255040, 1255001, 1255002, 1255003, 20050]);

/** 授权码本身有问题时，换端点重试没有意义 */
const FATAL_AUTH_CODES = new Set([20003, 20004, 20010, 20065, 20066, 20067, 20068, 20071, 20024, 20036]);

const AUTH_ERROR_TEXT = {
  20001: '免登请求参数不完整',
  20002: '应用凭证（App ID / App Secret）不正确',
  20003: '授权码无效，请重新打开应用',
  20004: '授权码已过期（有效期 5 分钟），请重新打开应用',
  20005: '用户身份令牌无效',
  20010: '该用户没有这个应用的使用权限，请让管理员把 TA 加入可用范围',
  20024: '授权码与 App ID 不匹配，请检查后端配置的是不是同一个应用',
  20050: '飞书服务端临时出错，请稍后重试',
  20065: '授权码已被使用过，请重新打开应用',
  20066: '用户状态异常（可能已离职或冻结）',
  20067: 'scope 列表里有重复项',
  20068: 'scope 列表包含用户未授权的权限'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FeishuError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.name = 'FeishuError';
    this.feishuCode = typeof code === 'number' ? code : -1;
    this.payload = payload || null;
  }
}

function authErrorText(body) {
  const code = body && typeof body.code === 'number' ? body.code : -1;
  if (AUTH_ERROR_TEXT[code]) return AUTH_ERROR_TEXT[code];
  const raw = (body && (body.error_description || body.msg)) || '';
  return raw ? '换取用户身份失败：' + raw : '换取用户身份失败（错误码 ' + code + '）';
}

async function rawRequest(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = { code: -1, msg: '飞书返回了非 JSON 内容：' + text.slice(0, 300) };
  }
  return { status: res.status, body: body || {} };
}

/**
 * 带重试的请求。成功时返回响应体，失败时抛 FeishuError（message 可以直接给使用者看）。
 */
async function request(url, options, attempt) {
  const tries = attempt || 0;
  let result;
  try {
    result = await rawRequest(url, options);
  } catch (err) {
    if (tries < 4) {
      await sleep(400 * Math.pow(2, tries));
      return request(url, options, tries + 1);
    }
    throw new FeishuError('连不上飞书开放平台：' + (err && err.message ? err.message : err), -1, null);
  }

  const body = result.body;
  const code = typeof body.code === 'number' ? body.code : -1;
  if (code === 0) return body;

  if (RETRYABLE.has(code) && tries < 4) {
    await sleep(400 * Math.pow(2, tries));
    return request(url, options, tries + 1);
  }

  throw new FeishuError(
    body.msg || body.error_description || ('飞书接口返回错误码 ' + code),
    code,
    body
  );
}

function jsonOptions(method, token, payload) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const options = { method: method, headers: headers };
  if (payload !== undefined) options.body = JSON.stringify(payload);
  return options;
}

/* ==================== access token ==================== */

const tokenCache = {
  tenant: null,
  tenantExpireAt: 0,
  app: null,
  appExpireAt: 0
};

/** 以应用身份调用接口用的令牌，两小时过期，这里提前 2 分钟续期 */
async function tenantAccessToken(cfg) {
  const now = Date.now();
  if (tokenCache.tenant && now < tokenCache.tenantExpireAt - 120000) return tokenCache.tenant;

  const body = await request(
    OPEN_HOST + '/open-apis/auth/v3/tenant_access_token/internal',
    jsonOptions('POST', null, { app_id: cfg.appId, app_secret: cfg.appSecret })
  );
  tokenCache.tenant = body.tenant_access_token;
  tokenCache.tenantExpireAt = now + (body.expire || 7200) * 1000;
  return tokenCache.tenant;
}

/** 换 user_access_token 时用的应用身份令牌 */
async function appAccessToken(cfg) {
  const now = Date.now();
  if (tokenCache.app && now < tokenCache.appExpireAt - 120000) return tokenCache.app;

  const body = await request(
    OPEN_HOST + '/open-apis/auth/v3/app_access_token/internal',
    jsonOptions('POST', null, { app_id: cfg.appId, app_secret: cfg.appSecret })
  );
  tokenCache.app = body.app_access_token;
  tokenCache.appExpireAt = now + (body.expire || 7200) * 1000;
  return tokenCache.app;
}

/**
 * 免登 code → user_access_token。
 *
 * 飞书的令牌端点换过三代：v3 在 accounts.feishu.cn，v2 在 open.feishu.cn，
 * v1 需要先拿 app_access_token 再换。文档把 v2 也标成了历史版本，所以这里
 * 按 v3 → v2 → v1 依次尝试，哪个通用哪个——比赌某一个是现役端点稳。
 */
async function exchangeUserToken(cfg, code, redirectUri) {
  const payload = {
    grant_type: 'authorization_code',
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    code: code
  };
  if (redirectUri) payload.redirect_uri = redirectUri;

  const errors = [];
  const endpoints = [
    ACCOUNTS_HOST + '/oauth/v3/token',
    OPEN_HOST + '/open-apis/authen/v2/oauth/token'
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await rawRequest(endpoint, jsonOptions('POST', null, payload));
      const body = res.body;
      if (body.code === 0 && body.access_token) {
        return {
          accessToken: body.access_token,
          expiresIn: body.expires_in || 7200,
          via: endpoint
        };
      }
      const err = new FeishuError(authErrorText(body), body.code, body);
      if (FATAL_AUTH_CODES.has(err.feishuCode)) throw err;
      errors.push(err);
    } catch (err) {
      if (err instanceof FeishuError && FATAL_AUTH_CODES.has(err.feishuCode)) throw err;
      errors.push(err);
    }
  }

  // v1 兜底：先拿 app_access_token，再换用户令牌
  try {
    const appToken = await appAccessToken(cfg);
    const res = await rawRequest(
      OPEN_HOST + '/open-apis/authen/v1/access_token',
      jsonOptions('POST', appToken, { grant_type: 'authorization_code', code: code })
    );
    const body = res.body;
    if (body.code === 0 && body.data && body.data.access_token) {
      return {
        accessToken: body.data.access_token,
        expiresIn: body.data.expires_in || 7200,
        via: 'authen/v1/access_token'
      };
    }
    throw new FeishuError(authErrorText(body), body.code, body);
  } catch (err) {
    errors.push(err);
  }

  throw errors.find((e) => e instanceof FeishuError && FATAL_AUTH_CODES.has(e.feishuCode)) ||
    errors[0] ||
    new FeishuError('换取用户身份失败', -1, null);
}

/* ==================== 网页应用 JSAPI 鉴权（扫码要用） ==================== */

/**
 * 端内扫码（`tt.scanCode`）属于**需要鉴权**的 JSAPI：
 * 前端必须拿服务端算出的签名去 `h5sdk.config` 过一遍，否则调了也只是失败。
 * 与免登不同 —— 免登用的 `tt.requestAccess` 是免鉴权接口，所以之前没发现问题。
 *
 * 鉴权三件套：jsapi_ticket（两小时有效，缓存起来）+ 随机串 + 时间戳，
 * 与飞书官方一致的顺序做 sha1：
 *   jsapi_ticket=xxx&noncestr=xxx&timestamp=xxx&url=当前页面地址
 */
const jsapiCache = { ticket: null, expireAt: 0 };

async function jsapiTicket(cfg) {
  const now = Date.now();
  if (jsapiCache.ticket && now < jsapiCache.expireAt - 120000) return jsapiCache.ticket;

  const token = await tenantAccessToken(cfg);
  const body = await request(
    OPEN_HOST + '/open-apis/jssdk/ticket/get',
    jsonOptions('POST', token, { app_id: cfg.appId })
  );
  const data = body.data || {};
  const ticket = data.ticket || body.ticket || '';
  if (!ticket) {
    throw new FeishuError('飞书没有返回 JSAPI 临时凭证（jsapi_ticket）', -1, body);
  }
  jsapiCache.ticket = ticket;
  jsapiCache.expireAt = now + (Number(data.expire_in) || 7200) * 1000;
  return ticket;
}

/**
 * 鉴权签名。抽成单独的函数（而不是埋在 jsapiConfig 里）是为了能单测：
 * 字段顺序错一位、少一个 &，签名就对不上，而前端只会得到一个"鉴权失败"，
 * 根本看不出是顺序错了 —— 这种错必须能在不联网的情况下测出来。
 */
function jsapiSignature(ticket, nonceStr, timestamp, pageUrl) {
  const verifyStr = 'jsapi_ticket=' + ticket +
    '&noncestr=' + nonceStr +
    '&timestamp=' + timestamp +
    '&url=' + pageUrl;
  return crypto.createHash('sha1').update(verifyStr, 'utf8').digest('hex');
}

/**
 * 鉴权用的时间戳 —— **毫秒级**（13 位）。
 *
 * 为什么单独抽一个函数：飞书 h5sdk.config 的 timestamp 官方文档写的是毫秒，
 * 而用秒级（10 位）算出来的签名**看着完全正常**（接口不报错、签名长度也对），
 * 客户端鉴权却一定失败。表现就是「电脑浏览器里扫码好好的，飞书里点了没反应」，
 * 排查时极容易被当成"可信域名没配"。抽出来是为了让测试能直接把它钉死。
 */
function jsapiTimestamp() {
  return Date.now();
}

/** 前端 h5sdk.config 需要的那四个参数 */
async function jsapiConfig(cfg, pageUrl) {
  const ticket = await jsapiTicket(cfg);
  const nonceStr = crypto.randomBytes(8).toString('hex');
  const timestamp = jsapiTimestamp();
  return {
    appId: cfg.appId,
    timestamp: timestamp,
    nonceStr: nonceStr,
    signature: jsapiSignature(ticket, nonceStr, timestamp, pageUrl)
  };
}

/* ==================== 发消息（采购审批提醒，第十三轮） ==================== */

/**
 * 给一个人发文本消息（按 open_id 定位）。
 *
 * 权限：飞书后台要给应用开「以应用的身份发消息」（im:message），没开的话这里会抛
 * FeishuError —— 调用方（index.js 的通知钩子）会接住并记日志，**绝不影响业务本身**：
 * 提醒发不出去，申请照样能提交、照样能批。
 */
async function sendMessage(cfg, openId, text) {
  const token = await tenantAccessToken(cfg);
  await request(
    OPEN_HOST + '/open-apis/im/v1/messages?receive_id_type=open_id',
    jsonOptions('POST', token, {
      receive_id: openId,
      msg_type: 'text',
      // content 是个"JSON 字符串里的 JSON"，飞书就这么设计的
      content: JSON.stringify({ text: String(text || '') })
    })
  );
  return true;
}

/**
 * 发到群聊的自定义机器人 webhook（可选，与 sendMessage 完全独立的一条路）。
 *
 * 为什么有这条路：应用机器人发的消息落在「与应用的会话」里，有队员反馈不够显眼；
 * 群消息则是实打实的群聊，谁都能第一时间看见。群主在
 * 「群设置 → 群机器人 → 添加自定义机器人」拿到 webhook 地址，
 * 填进 config.json 的 groupWebhook 就行 —— 不需要任何权限、不需要 openId。
 * 没配置时返回 false（调用方照常发应用消息，不算错误）。
 * 可选 cfg.groupWebhookAtAll：消息末尾 @所有人（自定义机器人的 <at user_id="all">）。
 */
async function sendGroupWebhook(cfg, text) {
  const hook = String((cfg && cfg.groupWebhook) || '').trim();
  if (!hook) return false;
  let content = String(text || '');
  if (cfg.groupWebhookAtAll) content += ' <at user_id="all">所有人</at>';
  const result = await rawRequest(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ msg_type: 'text', content: { text: content } })
  });
  const body = result.body || {};
  // 新版返回 {code:0}，老版返回 {StatusCode:0}，两种都认
  if (body.code === 0 || body.StatusCode === 0) return true;
  throw new FeishuError(
    body.msg || body.errmsg || ('群机器人返回了不认识的内容：' + JSON.stringify(body).slice(0, 200)),
    typeof body.code === 'number' ? body.code : -1,
    body
  );
}

/** 用 user_access_token 读用户信息（姓名、头像、open_id） */
async function getUserInfo(userAccessToken) {
  const body = await request(
    OPEN_HOST + '/open-apis/authen/v1/user_info',
    jsonOptions('GET', userAccessToken)
  );
  const d = body.data || {};
  if (!d.open_id) throw new FeishuError('飞书没有返回用户标识（open_id）', -1, body);
  return {
    openId: d.open_id,
    unionId: d.union_id || '',
    name: d.name || d.en_name || '（未命名）',
    avatarUrl: d.avatar_url || ''
  };
}

/* ==================== 多维表格 ==================== */

const BITABLE = OPEN_HOST + '/open-apis/bitable/v1/apps';
const PAGE_SIZE = 500;
/** 官方限制单次最多 1000 条，这里留一半余量，减少单请求耗时过高导致的超时 */
const WRITE_CHUNK = 500;

/** 全量拉一张表（自动翻页） */
async function listRecords(cfg, appToken, tableId) {
  const token = await tenantAccessToken(cfg);
  const rows = [];
  let pageToken = '';
  for (let guard = 0; guard < 200; guard += 1) {
    let url = BITABLE + '/' + appToken + '/tables/' + tableId + '/records?page_size=' + PAGE_SIZE;
    if (pageToken) url += '&page_token=' + encodeURIComponent(pageToken);
    const body = await request(url, jsonOptions('GET', token));
    const data = body.data || {};
    (data.items || []).forEach((row) => rows.push(row));
    if (!data.has_more) return rows;
    pageToken = data.page_token || '';
    if (!pageToken) return rows;
  }
  throw new FeishuError('多维表格单表记录过多，翻页超过上限', -1, null);
}

async function batchCreate(cfg, appToken, tableId, records) {
  const token = await tenantAccessToken(cfg);
  const created = [];
  for (let i = 0; i < records.length; i += WRITE_CHUNK) {
    const chunk = records.slice(i, i + WRITE_CHUNK);
    const body = await request(
      BITABLE + '/' + appToken + '/tables/' + tableId + '/records/batch_create',
      jsonOptions('POST', token, { records: chunk })
    );
    const data = body.data || {};
    (data.records || []).forEach((r) => created.push(r));
  }
  return created;
}

async function batchUpdate(cfg, appToken, tableId, records) {
  const token = await tenantAccessToken(cfg);
  const updated = [];
  for (let i = 0; i < records.length; i += WRITE_CHUNK) {
    const chunk = records.slice(i, i + WRITE_CHUNK);
    const body = await request(
      BITABLE + '/' + appToken + '/tables/' + tableId + '/records/batch_update',
      jsonOptions('POST', token, { records: chunk })
    );
    const data = body.data || {};
    (data.records || []).forEach((r) => updated.push(r));
  }
  return updated;
}

async function batchDelete(cfg, appToken, tableId, recordIds) {
  const token = await tenantAccessToken(cfg);
  for (let i = 0; i < recordIds.length; i += WRITE_CHUNK) {
    const chunk = recordIds.slice(i, i + WRITE_CHUNK);
    await request(
      BITABLE + '/' + appToken + '/tables/' + tableId + '/records/batch_delete',
      jsonOptions('POST', token, { records: chunk })
    );
  }
}

/** 列出多维表格里的所有数据表（初始化时用来判断表建好了没有） */
async function listTables(cfg, appToken) {
  const token = await tenantAccessToken(cfg);
  const body = await request(
    BITABLE + '/' + appToken + '/tables?page_size=100',
    jsonOptions('GET', token)
  );
  return (body.data && body.data.items) || [];
}

/** 新建数据表 */
async function createTable(cfg, appToken, name, fields) {
  const token = await tenantAccessToken(cfg);
  const body = await request(
    BITABLE + '/' + appToken + '/tables',
    jsonOptions('POST', token, {
      table: {
        name: name,
        default_view_name: '表格',
        fields: fields
      }
    })
  );
  return body.data;
}

/**
 * 删除数据表（连同表里的记录）。
 *
 * 只用在一种场景：飞书新建多维表格时会自动带一张空的「数据表」，
 * 我们建好自己的业务表之后要把这张多余的清掉。
 * 多维表格不允许删掉最后一张表，所以调用前确认还有别的表存在。
 */
async function deleteTable(cfg, appToken, tableId) {
  const token = await tenantAccessToken(cfg);
  const body = await request(
    BITABLE + '/' + appToken + '/tables/' + tableId,
    jsonOptions('DELETE', token)
  );
  return body.data;
}

/** 新建多维表格；folder_token 为空时建在应用的「我的空间」 */
async function createApp(cfg, name, folderToken) {
  const token = await tenantAccessToken(cfg);
  const payload = { name: name };
  if (folderToken) payload.folder_token = folderToken;
  const body = await request(BITABLE, jsonOptions('POST', token, payload));
  return body.data && body.data.app;
}

/** 改名（自检建的表想留下来复用时用得上） */
async function renameApp(cfg, appToken, name) {
  const token = await tenantAccessToken(cfg);
  const body = await request(BITABLE + '/' + appToken, jsonOptions('PATCH', token, { name: name }));
  return body.data;
}

/**
 * 删除整个多维表格。会连同里面的数据一起删掉，不可恢复。
 * 只用在「清掉自检建的空表」这种场景，调用前务必确认 app_token 是真的没用。
 */
async function deleteApp(cfg, appToken) {
  const token = await tenantAccessToken(cfg);
  const body = await request(BITABLE + '/' + appToken, jsonOptions('DELETE', token));
  return body.data;
}

/** 拼一个多维表格的网页地址，方便直接发给队员 */
function baseUrl(appToken) {
  return 'https://feishu.cn/base/' + appToken;
}

module.exports = {
  FeishuError: FeishuError,
  tenantAccessToken: tenantAccessToken,
  exchangeUserToken: exchangeUserToken,
  getUserInfo: getUserInfo,
  sendMessage: sendMessage,
  sendGroupWebhook: sendGroupWebhook,
  jsapiConfig: jsapiConfig,
  jsapiSignature: jsapiSignature,
  jsapiTimestamp: jsapiTimestamp,
  listRecords: listRecords,
  batchCreate: batchCreate,
  batchUpdate: batchUpdate,
  batchDelete: batchDelete,
  listTables: listTables,
  createTable: createTable,
  deleteTable: deleteTable,
  createApp: createApp,
  renameApp: renameApp,
  deleteApp: deleteApp,
  baseUrl: baseUrl
};
