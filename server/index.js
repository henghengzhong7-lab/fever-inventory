'use strict';

/**
 * FEver 战队物资管理 —— 飞书共享版后端
 *
 * 只做三件事：换飞书身份、读写多维表格、把「谁改的」记下来。
 * 界面上长什么样、业务规则怎么走，全在前端（与本地离线版是同一套代码）。
 *
 * 为什么必须有这个服务：
 *   1. 免登 code 换 user_access_token 需要 app_secret，前端代码是公开的，放不了；
 *   2. 读写多维表格必须带 access_token，前端同样拿不到；
 *   3. 「谁改的」这类审计信息只能服务端写。
 *
 * 关于并发：多维表格没有事务、也没有自增锁，官方明确不建议对同一张表并发读写（会报
 * 1254291 Write conflict）。所以这里用一条串行队列把所有写请求排成队，一个处理完才处理
 * 下一个；再配合「写前先校验编号有没有被占用」，多人同时登记也不会串号或算错数量。
 *
 * 注意：内存里保存了一份数据的镜像（启动后首次访问时加载）。**数据镜像**这套设计假定
 * 单实例运行，当前托管环境就是单实例；如果以后要多实例，需要把镜像换成每次直读多维表格。
 * 会话令牌不受这个限制 —— 它是自签名的无状态令牌（见 lib/session.js），
 * 进程重启或换实例都不会让队员掉线。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const feishu = require('./lib/feishu');
const store = require('./lib/store');
const session = require('./lib/session');

/* ==================== 配置 ==================== */

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[启动失败] 找不到 ' + CONFIG_PATH);
    console.error('请先复制 config.example.json 为 config.json，并填入飞书应用的 App ID / App Secret。');
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[启动失败] config.json 不是合法的 JSON：' + err.message);
    process.exit(1);
  }
  if (!cfg.appId || !cfg.appSecret) {
    console.error('[启动失败] config.json 里缺 appId 或 appSecret。');
    console.error('在飞书开发者后台 → 你的应用 → 凭证与基础信息 里可以拿到这两个值。');
    process.exit(1);
  }
  if (!cfg.bitableAppToken) {
    console.error('[启动失败] config.json 里还没有 bitableAppToken。');
    console.error('先运行一次 `npm run init:base` 创建多维表格，脚本会把 app_token 自动写回来。');
    process.exit(1);
  }
  cfg.allowedOrigins = cfg.allowedOrigins && cfg.allowedOrigins.length ? cfg.allowedOrigins : ['*'];
  cfg.allowedOpenIds = cfg.allowedOpenIds || [];
  // 管理员名单：写姓名或 openId 都行（见 isAdminUser）。空数组 = 没有人能审批。
  cfg.admins = Array.isArray(cfg.admins) ? cfg.admins : [];
  cfg.sessionHours = cfg.sessionHours || 12;
  // 诊断端点默认不存在。它只在**本地调试**时开启（见 probe-auth.js），
  // 线上环境绝不配置这个值 —— 它能签发自造身份的令牌，不能对外暴露。
  cfg.diagKey = cfg.diagKey || process.env.FEVER_DIAG_KEY || '';
  return cfg;
}

/* ==================== 全局状态 ==================== */

/** 用来判断进程有没有被重启过：每次启动都会变 */
const INSTANCE_ID = crypto.randomBytes(4).toString('hex');
const STARTED_AT = Date.now();

const STATE = {
  data: null,
  /** 每张表：业务主键 → 多维表格 record_id。更新/删除要靠它定位到具体那一行 */
  recordIds: {},
  sequences: {},
  loadedAt: 0,
  loading: null
};

/**
 * 会话令牌是**自签名的**，校验只靠密钥，不依赖内存（见 lib/session.js）。
 * 这样进程重启、重新发布、换成多实例，队员手里的令牌都还有效 ——
 * 用「发随机串存 Map」的写法时，这里每次重新部署都会把所有在线的人踢下线。
 */
function issueSession(user) {
  return session.issue(CONFIG, user);
}

function readSession(token) {
  return session.verify(token, session.secretOf(CONFIG));
}

/* ==================== 管理员 ==================== */

/** 比对时统一去掉首尾空白、忽略大小写（openId 大小写其实固定，但抄错大小写不该算错人） */
function sameIdentity(a, b) {
  const x = String(a === undefined || a === null ? '' : a).trim().toLowerCase();
  const y = String(b === undefined || b === null ? '' : b).trim().toLowerCase();
  return !!x && x === y;
}

/**
 * 判断一个人是不是管理员。
 *
 * 名单里写姓名或 openId 都认 —— 两种都从**服务端**取回的飞书用户信息里比对，
 * 不是队员自己填的东西，所以冒名顶替不了（前端连姓名都改不了，姓名是飞书给的）。
 * 两种都支持的理由很简单：写姓名省事，写 openId 精确，配置成本几乎为零。
 *
 * 刻意**不把 isAdmin 写进会话令牌**：那样改了名单就得等大家重新登录才生效；
 * 每次请求现算，名单一改立刻生效。
 */
function isAdminUser(user) {
  if (!user) return false;
  return CONFIG.admins.some(function (entry) {
    return sameIdentity(entry, user.name) || sameIdentity(entry, user.openId);
  });
}

/* ==================== 串行写队列 ==================== */

let queueTail = Promise.resolve();

/** 把所有写任务排成一条队，前一个（无论成功失败）结束才轮到下一个 */
function enqueue(task) {
  const result = queueTail.then(task, task);
  queueTail = result.then(function () {}, function () {});
  return result;
}

/* ==================== 数据加载 ==================== */

const TABLE_ID_CACHE = {};

/** 表名 → table_id。config 里存了就用存的，没存就现查一次并写回配置 */
/** 正在解析表 ID 的 Promise：并发调用时只发一次 listTables，其余共用这一次的结果 */
let tableIdResolving = null;

/**
 * 一次 listTables 把所有数据表的 ID 都解析并存下来。
 * 为什么要合并：并发拉数据时如果每张表都各调一次 listTables，
 * 就会同时打出 6 个请求；实测这会显著拖慢首次加载。
 */
function resolveAllTableIds() {
  if (tableIdResolving) return tableIdResolving;

  tableIdResolving = feishu.listTables(CONFIG, CONFIG.bitableAppToken).then(function (tables) {
    const missing = [];
    store.STORES.forEach(function (key) {
      const wanted = store.tableName(key);
      const hit = tables.find(function (t) { return t.name === wanted; });
      if (hit) TABLE_ID_CACHE[key] = hit.table_id;
      else missing.push(wanted);
    });
    if (missing.length) {
      throw new Error('多维表格里找不到数据表「' + missing.join('、') + '」，请先运行 npm run init:base');
    }

    CONFIG.tableIds = CONFIG.tableIds || {};
    let dirty = false;
    store.STORES.forEach(function (key) {
      if (CONFIG.tableIds[key] !== TABLE_ID_CACHE[key]) {
        CONFIG.tableIds[key] = TABLE_ID_CACHE[key];
        dirty = true;
      }
    });
    // 存下来可以让下次启动省掉一次 listTables（能省约 0.6 秒）
    if (dirty) persistConfig();
  }).finally(function () {
    tableIdResolving = null;
  });

  return tableIdResolving;
}

async function tableIdOf(name) {
  if (TABLE_ID_CACHE[name]) return TABLE_ID_CACHE[name];
  if (CONFIG.tableIds && CONFIG.tableIds[name]) {
    TABLE_ID_CACHE[name] = CONFIG.tableIds[name];
    return TABLE_ID_CACHE[name];
  }
  await resolveAllTableIds();
  if (TABLE_ID_CACHE[name]) return TABLE_ID_CACHE[name];
  throw new Error('多维表格里找不到数据表「' + store.tableName(name) + '」，请先运行 npm run init:base');
}

function persistConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + '\n');
  } catch (err) {
    console.error('[警告] 配置回写失败：' + err.message);
  }
}

/** 从全量数据里算出每张自增表的下一个可用编号 */
function computeSequences(data) {
  const seq = {};
  store.STORES.forEach(function (name) {
    if (!store.SPECS[name].autoId) return;
    let max = 0;
    data[name].forEach(function (row) {
      const id = Number(row.id);
      if (!isNaN(id) && id > max) max = id;
    });
    seq[name] = max + 1;
  });
  return seq;
}

/** 表 ID 都已知就不要再打 listTables（能省约 0.6 秒） */
async function ensureTableIds() {
  const allKnown = store.STORES.every(function (key) {
    return TABLE_ID_CACHE[key] || (CONFIG.tableIds && CONFIG.tableIds[key]);
  });
  if (allKnown) {
    store.STORES.forEach(function (key) {
      if (!TABLE_ID_CACHE[key]) TABLE_ID_CACHE[key] = CONFIG.tableIds[key];
    });
    return;
  }
  await resolveAllTableIds();
}

/** 从多维表格一次性拉全部数据，建内存镜像 */
async function loadAll(force) {
  if (!force && STATE.data) return STATE.data;
  if (STATE.loading) return STATE.loading;

  STATE.loading = (async function () {
    await ensureTableIds();

    // 6 张表并行拉。
    // 实测（数据量 24 条）：串行 6144ms → 并行 1409ms，快 4.4 倍。
    // 原先担心「并发读同一个文档会互相拖慢甚至报错」，实测飞书侧扛得住，
    // 而冷启动的等待是使用者最能直接感知的，所以按并行来。
    const pulled = await Promise.all(store.STORES.map(function (name) {
      return feishu.listRecords(CONFIG, CONFIG.bitableAppToken, TABLE_ID_CACHE[name])
        .then(function (records) { return { name: name, records: records }; });
    }));

    const data = store.emptyData();
    const recordIds = {};
    pulled.forEach(function (item) {
      store.assignRows(data, item.name, item.records);
      const index = new Map();
      item.records.forEach(function (record) {
        const key = store.readText((record.fields || {})[store.FIELD.KEY]);
        if (key) index.set(key, record.record_id);
      });
      recordIds[item.name] = index;
    });

    STATE.data = data;
    STATE.recordIds = recordIds;
    STATE.sequences = computeSequences(data);
    STATE.loadedAt = Date.now();
    // 启动/重载后把设置表里的登录名单合并回来（发布清掉本地文件后的兜底）
    mergeKnownUsersFromStore(data);
    return data;
  })();

  try {
    return await STATE.loading;
  } finally {
    STATE.loading = null;
  }
}

function invalidate() {
  // 写操作之后镜像就是最新的，不需要重新拉；这里只用来标记「有人改过」
  STATE.loadedAt = Date.now();
}

/* ==================== 写操作 ==================== */

/**
 * 哪些改动属于「只有管理员能做」。
 * 加在这里的东西，服务端会**强制**校验——前端把按钮藏起来只是体验，
 * 真按下去能不能成，只看这张表。
 * 判断口径：某条记录里这几个字段的值和改动前不一样，就算敏感改动。
 */
const ADMIN_ONLY_FIELDS = {
  purchaseRequests: ['approval']
};

/**
 * settings 表里哪些键属于"只有管理员能改"。
 * 注意**不能**把整张 settings 表都设成管理员专属：lastBackupAt 是任何人
 * 导出备份时都会写的一个时间戳，把它一起管起来会让普通队员导出备份直接报 403。
 */
const ADMIN_ONLY_SETTINGS = ['budgetByTroop'];

/** 返回"需要管理员权限才能做的事"，不需要就返回 null */
function adminOnlyReason(op, data) {
  if (!op || op.type !== 'put' || !op.data || typeof op.data !== 'object') return null;

  const list = (data && data[op.store]) || [];
  const key = String(store.keyOf(op.store, op.data));
  const before = list.filter(function (r) { return String(store.keyOf(op.store, r)) === key; })[0];
  const norm = function (v) { return v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); };

  if (op.store === 'settings') {
    if (ADMIN_ONLY_SETTINGS.indexOf(String(op.data.key || '')) === -1) return null;
    if (norm(before && before.value) === norm(op.data.value)) return null;   // 值没变就不算改动
    return '改兵种预算';
  }

  const fields = ADMIN_ONLY_FIELDS[op.store];
  if (!fields) return null;

  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (norm(before ? before[f] : undefined) !== norm(op.data[f])) return '审批采购申请';
  }
  return null;
}

/* ==================== 采购审批的飞书提醒（第十三轮） ==================== */

/**
 * 队员提交购买申请 → 提醒管理员来审；管理员批准 → 提醒申请人。
 *
 * 设计上认了三条死理：
 *   1. **提醒发不出去绝不能挡业务** —— 发消息是 fire-and-forget，抛错只记日志。
 *      飞书权限没开、网络抖了，申请照样能提交、照样能批。
 *   2. **收件人要能从姓名反查到 openId** —— config.json 的 admins 是姓名或 openId
 *      混写的，发消息只认 openId。姓名那部分靠"登录记录"反查：谁登录过一次，
 *      name→openId 的对应关系就记在 known-users.json 里。没登录过的管理员收不到
 *      （日志里有提示），但名单写 openId 的人永远收得到。
 *   3. **事件只认 approval 字段的真实变化** —— 普通编辑（改数量、改用途）带着
 *      原样的 approval 字段写回来，不算审批动作，不该触发提醒。
 */

const KNOWN_USERS_PATH = path.join(__dirname, 'known-users.json');
const KNOWN_USERS_KEY = 'knownUsers';   // 存进多维表格设置表的主键
const DEFAULT_APP_URL = 'https://fever-inventory.app.workbuddy.host/';
let knownUsers = {};

function loadKnownUsers() {
  try {
    knownUsers = JSON.parse(fs.readFileSync(KNOWN_USERS_PATH, 'utf8')) || {};
  } catch (err) {
    knownUsers = {};
  }
}
loadKnownUsers();

/**
 * 把设置表里的登录名单合并进内存。
 *
 * ⭐ 为什么设置表里还要存一份：known-users.json 在沙箱的 server 目录里，
 * **每次重新发布都会被清掉**——名单一丢，按姓名写的管理员就反查不到 openId，
 * 私聊提醒全部哑火（2026-09-22 实测踩过）。设置表在多维表格里，跨发布持久，
 * 所以登录名单以它为准，本地文件只当启动时的快补充。
 */
function mergeKnownUsersFromStore(data) {
  const row = ((data && data.settings) || []).filter(function (r) { return r && r.key === KNOWN_USERS_KEY; })[0];
  const stored = row && row.value && typeof row.value === 'object' ? row.value : null;
  if (!stored) return;
  Object.keys(stored).forEach(function (openId) {
    const v = stored[openId];
    if (!v || !v.name) return;
    const cur = knownUsers[openId];
    if (!cur || String(v.at || '') >= String(cur.at || '')) knownUsers[openId] = v;
  });
}

/** 把登录名单同步进多维表格设置表（跨发布持久）。失败只记日志，不影响登录 */
function persistKnownUsers() {
  if (!STATE.data || !STATE.recordIds || !STATE.recordIds.settings) return;
  const row = { key: KNOWN_USERS_KEY, value: knownUsers, updatedAt: new Date().toISOString() };
  Promise.resolve(tableIdOf('settings')).then(function (tableId) {
    const fields = store.rowToFields('settings', row, '系统(登录名单)', row.updatedAt);
    const rid = STATE.recordIds.settings.get(KNOWN_USERS_KEY);
    const writeP = rid
      ? feishu.batchUpdate(CONFIG, CONFIG.bitableAppToken, tableId, [{ record_id: rid, fields: fields }])
      : feishu.batchCreate(CONFIG, CONFIG.bitableAppToken, tableId, [{ fields: fields }])
        .then(function (created) {
          if (created && created[0] && created[0].record_id) {
            STATE.recordIds.settings.set(KNOWN_USERS_KEY, created[0].record_id);
          }
        });
    return writeP.then(function () {
      // 同步进内存镜像，别让 settings 行和真实存储脱节
      if (STATE.data) {
        const list = STATE.data.settings;
        const hit = list.filter(function (r) { return r && r.key === KNOWN_USERS_KEY; })[0];
        if (hit) hit.value = knownUsers;
        else list.push(row);
      }
    });
  }).catch(function (err) {
    console.warn('[提醒] 登录名单写入设置表失败（本地文件仍有效，不影响使用）：' + ((err && err.message) || err));
  });
}

/** 登录成功时记一笔 name→openId，供按姓名写的管理员名单反查收件人 */
function rememberUser(user) {
  if (!user || !user.openId || !user.name) return;
  const cur = knownUsers[user.openId];
  if (cur && cur.name === user.name) return;
  knownUsers[user.openId] = { name: user.name, at: new Date().toISOString() };
  try {
    fs.writeFileSync(KNOWN_USERS_PATH, JSON.stringify(knownUsers, null, 2));
  } catch (err) {
    console.warn('[提醒] 记录登录名单失败（不影响使用）：' + err.message);
  }
  persistKnownUsers();
}

/** 管理员名单 → openId 列表。名单里的 openId 直接用，姓名去登录记录里认 */
function adminOpenIds() {
  const ids = [];
  (CONFIG.admins || []).forEach(function (entry) {
    const e = String(entry || '').trim();
    if (!e) return;
    if (/^ou_/.test(e)) {
      if (ids.indexOf(e) === -1) ids.push(e);
      return;
    }
    Object.keys(knownUsers).forEach(function (openId) {
      if (knownUsers[openId] && sameIdentity(knownUsers[openId].name, e) && ids.indexOf(openId) === -1) {
        ids.push(openId);
      }
    });
  });
  return ids;
}

/** 与前端 rules.js 的 approvalOf 同语义：老数据没有 approval 视为已同意 */
function approvalOf(row) {
  if (!row || !row.approval) return 'approved';
  if (row.approval === 'approved' || row.approval === 'rejected') return row.approval;
  return 'pending';
}

/** 给某个 openId 发消息。失败只记日志 —— 提醒永远不该挡业务 */
function notifyOpenId(openId, text) {
  if (!openId || !/^ou_/.test(openId)) return;
  feishu.sendMessage(CONFIG, openId, text).catch(function (err) {
    console.warn('[提醒] 发送给 ' + openId + ' 失败（业务不受影响）：' +
      ((err && err.message) || err) + (err && err.feishuCode ? '（飞书错误码 ' + err.feishuCode + '）' : ''));
  });
}

/**
 * 发到群聊（config.json 的 groupWebhook，群自定义机器人，可选）。
 * 与应用私聊互为补充：私聊安静、群聊显眼。没配置就什么都不做。
 */
function notifyGroup(text) {
  if (!CONFIG.groupWebhook) return;
  feishu.sendGroupWebhook(CONFIG, text).catch(function (err) {
    console.warn('[提醒] 发到群失败（业务不受影响）：' + ((err && err.message) || err));
  });
}

function appUrl() {
  return String(CONFIG.webAppUrl || DEFAULT_APP_URL);
}

/**
 * 从一次成功的写入里挑出要提醒的事。
 * before 是写之前的镜像，after 是写之后的 —— 对比才认得出"真的批了"。
 */
function collectPurchaseEvents(ops, before, after) {
  const events = [];
  const spec = store.SPECS.purchaseRequests;
  const byKey = function (list, key) {
    return (list || []).filter(function (r) { return String(spec.keyOf(r)) === key; })[0] || null;
  };
  (ops || []).forEach(function (op) {
    if (!op || !op.data || op.store !== 'purchaseRequests') return;
    const key = String(store.keyOf('purchaseRequests', op.data));
    const beforeRow = byKey(before.purchaseRequests, key);
    const afterRow = byKey(after.purchaseRequests, key);
    if (!afterRow) return;

    // 新提交的申请（待审批）→ 提醒管理员
    if (op.type === 'add' && approvalOf(afterRow) === 'pending') {
      events.push({ type: 'submitted', request: afterRow });
      return;
    }
    // 审批状态真实地"从待审变成已同意" → 提醒申请人（驳回不提醒，按需求只做批准）
    if (approvalOf(beforeRow) === 'pending' && approvalOf(afterRow) === 'approved') {
      events.push({ type: 'approved', request: afterRow });
    }
  });
  return events;
}

/** 把事件发出去。同步返回，内部异步发 —— applyOps 不等它 */
function dispatchPurchaseNotifications(events, approver) {
  events.forEach(function (ev) {
    const req = ev.request;
    const desc = req.name + ' ×' + (req.quantity || '?') + '（' + (req.applicant || '未知申请人') +
      ' 申请，预算 ' + (req.budget || '-') + ' 元）';
    if (ev.type === 'submitted') {
      const text = '【FEver 物资】' + (req.requesterName || req.applicant || '有队员') +
        ' 提交了采购申请：' + desc + '，等你审批。打开应用处理：' + appUrl();
      adminOpenIds().forEach(function (openId) { notifyOpenId(openId, text); });
      notifyGroup(text);
      return;
    }
    // 批准事件：收件人优先用提交申请时记下的 openId；
    // 老申请没有这个键，退而用申请人姓名去登录记录里认
    let target = req.requesterOpenId;
    if (!target && req.applicant) {
      Object.keys(knownUsers).forEach(function (openId) {
        if (!target && knownUsers[openId] && sameIdentity(knownUsers[openId].name, req.applicant)) {
          target = openId;
        }
      });
    }
    if (!target) {
      console.warn('[提醒] 找不到申请人 ' + (req.applicant || '?') +
        ' 的飞书身份（老数据且本人还没登录过），这条批准通知发不出去');
      return;
    }
    const approvedText = '【FEver 物资】你申请的 ' + desc +
      ' 已被 ' + (approver.name || '管理员') + ' 批准，可以下单采购了。详情见：' + appUrl();
    notifyOpenId(target, approvedText);
    notifyGroup(approvedText);
  });
}

/**
 * 发送测试提醒（登录后可用）。把「提醒到底通不通」从猜变成点一下就知道：
 *   · 给当前登录的人真发一条私聊，并把飞书的原始结果（含错误码）原样返回
 *   · 配了群机器人的话，管理员还能顺带测一次群通道
 * 这是诊断「收不到提醒」的第一站：飞书返回什么，界面就显示什么。
 */
async function handleNotifyTest(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  if (req.method !== 'POST') { sendJson(req, res, 405, { ok: false, message: '请用 POST' }); return; }

  const result = { ok: true, dm: null, group: null };
  // 名单解析结果：admins 写的是姓名时，靠登录记录反查 openId。
  // 这个数是 0 就说明"名单里的人都还没登录过（或发布把名单清了）"，私聊发不出去是名单问题不是通道问题
  result.adminCount = adminOpenIds().length;
  try {
    await feishu.sendMessage(CONFIG, session.openId,
      '【FEver 物资】这是一条测试提醒。能看到它，说明你的飞书消息通道是通的。');
    result.dm = { ok: true };
  } catch (err) {
    result.dm = {
      ok: false,
      error: String((err && err.message) || err),
      feishuCode: err && err.feishuCode !== undefined ? err.feishuCode : null
    };
  }

  if (!CONFIG.groupWebhook) {
    result.group = { ok: false, skipped: '未配置群机器人（config.json 的 groupWebhook）' };
  } else if (isAdminUser(session)) {
    try {
      await feishu.sendGroupWebhook(CONFIG,
        '【FEver 物资】（测试）' + (session.name || '管理员') + ' 正在验证群提醒通道，看到这条说明群提醒已通。');
      result.group = { ok: true };
    } catch (err) {
      result.group = { ok: false, error: String((err && err.message) || err) };
    }
  } else {
    result.group = { ok: false, skipped: '群通道只由管理员测试' };
  }

  sendJson(req, res, 200, result);
}

/**
 * 一次 /write 请求里可能带多个 store、多种操作（对应前端的 runTx）。 * 处理原则：
 *   - 全部在内存镜像上先演一遍，算出最终要提交给多维表格的变更
 *   - 自增编号先校验有没有被占用；占用了就整批拒绝，让前端重新拉数据后再来一次
 *     （不做「服务端悄悄换号」，否则记录之间的引用会指错）
 *   - 校验通过后再落库，落库失败则把镜像回滚成操作前的样子
 *
 * 第二个参数是「谁在改」：
 *   · 传字符串 —— 只当操作人名字记下来（旧写法，等价于"没有管理员权限"）；
 *   · 传 {name, openId, isAdmin} —— 完整身份，用于上面那张权限表。
 */
async function applyOps(ops, actor) {
  const who = (typeof actor === 'string' || !actor)
    ? { name: String(actor || ''), openId: '', isAdmin: false }
    : { name: String(actor.name || ''), openId: String(actor.openId || ''), isAdmin: !!actor.isAdmin };
  const operator = who.openId ? who.name + '(' + who.openId + ')' : who.name;

  const mirror = await loadAll(false);
  // 在副本上演算，只有全部校验通过、并且真的写进多维表格之后才替换镜像。
  // 中途因为编号冲突抛错时，前端拿到的镜像不会被改脏。
  const data = JSON.parse(JSON.stringify(mirror));
  const nowIso = new Date().toISOString();

  // 权限预检放在最前面：不合格就整批拒绝，一个字节都不写。
  if (!who.isAdmin) {
    for (const op of ops) {
      const reason = adminOnlyReason(op, mirror);
      if (reason) {
        const err = new Error('只有管理员能' + reason + '。你当前登录的账号没有审批权限。');
        err.forbidden = true;
        throw err;
      }
    }
  }

  // 每张表要新建 / 更新 / 删除的内容
  const plan = {};
  const reserved = {};
  store.STORES.forEach(function (name) {
    plan[name] = { create: [], update: [], delete: [], clearAll: false };
    reserved[name] = new Set();
  });

  function requireNewKey(name, row) {
    const key = store.keyOf(name, row);
    if (STATE.recordIds[name].has(key) || reserved[name].has(key)) {
      const err = new Error('编号 ' + key + ' 已被占用，可能刚刚有别人登记过。请刷新页面后重试。');
      err.conflict = true;
      throw err;
    }
    reserved[name].add(key);
    return key;
  }

  for (const op of ops) {
    const name = op.store;
    if (!store.isStore(name)) throw new Error('未知的数据表：' + name);
    const spec = store.SPECS[name];

    if (op.type === 'clear') {
      plan[name].clearAll = true;
      data[name] = [];
      continue;
    }

    if (op.type === 'add') {
      const row = op.data;
      if (!row || typeof row !== 'object') throw new Error('add 操作缺少数据');
      requireNewKey(name, row);
      // 新采购申请记下提交人的飞书身份（存进行数据 JSON，不动表结构）——
      // 批准的时候要靠它把"你申请的件批好了"送回到提交人那里
      if (name === 'purchaseRequests' && who.openId && !row.requesterOpenId) {
        row.requesterOpenId = who.openId;
        if (who.name && !row.requesterName) row.requesterName = who.name;
      }
      data[name].push(row);
      plan[name].create.push(row);
      if (spec.autoId) {
        const id = Number(row.id);
        if (!isNaN(id) && id >= (STATE.sequences[name] || 1)) STATE.sequences[name] = id + 1;
      }
      continue;
    }

    if (op.type === 'put') {
      const row = op.data;
      if (!row || typeof row !== 'object') throw new Error('put 操作缺少数据');
      const key = store.keyOf(name, row);
      const list = data[name];
      const index = list.findIndex(function (r) { return String(spec.keyOf(r)) === key; });
      if (index === -1) {
        // IndexedDB 的 put 遇到不存在的键会插入，这里保持一致
        requireNewKey(name, row);
        data[name].push(row);
        plan[name].create.push(row);
      } else {
        list[index] = row;
        const rid = STATE.recordIds[name].get(key);
        if (rid) plan[name].update.push({ record_id: rid, row: row });
        else plan[name].create.push(row);
      }
      continue;
    }

    if (op.type === 'delete') {
      const key = String(op.key);
      data[name] = data[name].filter(function (r) { return String(spec.keyOf(r)) !== key; });
      const rid = STATE.recordIds[name].get(key);
      if (rid) plan[name].delete.push({ record_id: rid, key: key });
      continue;
    }

    throw new Error('不认识的操作类型：' + op.type);
  }

  // 真正写库。中途失败就把内存镜像恢复成操作前的样子，保证前端看到的和库里一致
  try {
    // 表与表之间并行，同一张表内保持串行：
    //   · 实测两张不同的表同时写不会报写冲突，耗时与只写一张表相当（1242ms）
    //   · 同一张表内并发写才是飞书明确会冲突的场景，所以表内一律排队
    // 一次保存通常涉及 1~2 张表，并行后这部分的耗时基本被压到「一次往返」。
    await Promise.all(store.STORES.map(async function (name) {
      const item = plan[name];
      const hasChange = item.clearAll || item.create.length || item.update.length || item.delete.length;
      if (!hasChange) return;
      const tableId = await tableIdOf(name);

      if (item.clearAll) {
        const allIds = Array.from(STATE.recordIds[name].values());
        if (allIds.length) {
          await feishu.batchDelete(CONFIG, CONFIG.bitableAppToken, tableId, allIds);
        }
        STATE.recordIds[name].clear();
      }
      if (item.delete.length) {
        await feishu.batchDelete(
          CONFIG,
          CONFIG.bitableAppToken,
          tableId,
          item.delete.map(function (entry) { return entry.record_id; })
        );
        item.delete.forEach(function (entry) { STATE.recordIds[name].delete(entry.key); });
      }
      if (item.create.length) {
        const payload = item.create.map(function (row) {
          return { fields: store.rowToFields(name, row, operator, nowIso) };
        });
        const created = await feishu.batchCreate(CONFIG, CONFIG.bitableAppToken, tableId, payload);
        created.forEach(function (record, i) {
          const row = item.create[i];
          if (!row || !record || !record.record_id) return;
          STATE.recordIds[name].set(store.keyOf(name, row), record.record_id);
        });
      }
      if (item.update.length) {
        const payload = item.update.map(function (entry) {
          return { record_id: entry.record_id, fields: store.rowToFields(name, entry.row, operator, nowIso) };
        });
        await feishu.batchUpdate(CONFIG, CONFIG.bitableAppToken, tableId, payload);
      }
    }));
  } catch (err) {
    // 多维表格没有事务，落库可能已经写了一半，重新拉一遍才是准的
    STATE.data = null;
    try {
      await loadAll(true);
    } catch (reloadErr) {
      console.error('[回滚后重新加载失败，先用旧镜像顶着]', reloadErr);
      STATE.data = mirror;
      STATE.sequences = computeSequences(mirror);
    }
    throw err;
  }

  STATE.data = data;
  STATE.sequences = computeSequences(data);
  invalidate();

  // 业务已经落库，这才轮到提醒 —— 派发是异步的，不阻塞本次写入的响应
  const events = collectPurchaseEvents(ops, mirror, data);
  if (events.length) dispatchPurchaseNotifications(events, who);

  return { sequences: STATE.sequences };
}

/* ==================== HTTP 工具 ==================== */

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowed = CONFIG.allowedOrigins;
  const ok = allowed.indexOf('*') !== -1 || allowed.indexOf(origin) !== -1;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (ok && origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, corsHeaders(req)));
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > (limitBytes || 4 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ==================== 发票 PDF（第十三轮） ==================== */

/**
 * 发票 PDF 落在服务端本地目录，多维表格的「数据」列里只存一个文件引用。
 *
 * 为什么不把 PDF 塞进表格：DATA 列是文本类型，一份几百 KB 的 PDF 转 base64
 * 就是几百万个字符，早超出单元格上限。而「不动表结构」是底线 —— 加附件列不行，
 * 塞 JSON 也不行，所以文件本体放 uploads/，行里放 fileRef。
 *
 * 注意：上传与业务写入**不在一个事务里**（跨系统做不到）。
 * 顺序是"先上传、成功后前端才提交到货"——最坏情况是留下一份没人引用的孤儿文件，
 * 不会出现"发票行说有附件、服务器上却没有"。
 */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;   // 发票 PDF 的实际上限
const UPLOAD_BODY_LIMIT = 30 * 1024 * 1024;  // base64 之后 +33%，再留余量

const SAFE_REF = /^[A-Za-z0-9._-]+$/;

async function handleUpload(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  if (req.method !== 'POST') { sendJson(req, res, 405, { ok: false, message: '请用 POST' }); return; }

  let body;
  try {
    body = await readBody(req, UPLOAD_BODY_LIMIT);
  } catch (err) {
    sendJson(req, res, 413, { ok: false, message: '发票文件太大（上限 20MB）' });
    return;
  }

  const name = String((body && body.name) || '发票.pdf');
  const mime = String((body && body.mime) || 'application/pdf');
  const base64 = String((body && body.base64) || '');
  if (!base64) { sendJson(req, res, 400, { ok: false, message: '缺文件内容（base64）' }); return; }
  if (mime !== 'application/pdf' && !/\.pdf$/i.test(name)) {
    sendJson(req, res, 400, { ok: false, message: '发票目前只支持 PDF 文件' });
    return;
  }

  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) { sendJson(req, res, 400, { ok: false, message: '文件内容是空的' }); return; }
  if (buf.length > UPLOAD_MAX_BYTES) {
    sendJson(req, res, 413, { ok: false, message: '发票文件太大（上限 20MB）' });
    return;
  }
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // 引用只含安全字符，后面取文件时还要再校验一遍（防路径穿越）
  const ref = 'inv_' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + '.pdf';
  fs.writeFileSync(path.join(UPLOAD_DIR, ref), buf);
  console.log('[发票] ' + session.name + ' 上传了 ' + name + '（' + Math.round(buf.length / 1024) + 'KB）');
  sendJson(req, res, 200, { ok: true, fileRef: ref, size: buf.length });
}

function handleFileDownload(req, res, pathname) {
  const session = requireSession(req, res);
  if (!session) return;
  if (req.method !== 'GET') { sendJson(req, res, 405, { ok: false, message: '请用 GET' }); return; }

  const ref = pathname.slice('/api/file/'.length);
  // 白名单字符 + 拼出来必须在 uploads 目录里 —— 双保险防 ../ 穿越
  if (!SAFE_REF.test(ref) || !ref.endsWith('.pdf')) {
    sendJson(req, res, 400, { ok: false, message: '文件引用不合法' });
    return;
  }
  const target = path.join(UPLOAD_DIR, ref);
  if (!target.startsWith(UPLOAD_DIR)) {
    sendJson(req, res, 403, { ok: false, message: '路径不合法' });
    return;
  }
  fs.readFile(target, function (err, buf) {
    if (err) {
      sendJson(req, res, 404, { ok: false, message: '找不到这份发票文件（可能已过期清理）' });
      return;
    }
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=300'
    }, corsHeaders(req)));
    res.end(buf);
  });
}

/**
 * 从请求里挑出「我们自己的」会话令牌候选。
 *
 * 为什么要拿两个头、还要挨个试：
 *   线上网关（腾讯 STGW/EdgeOne）会给每个请求**注入它自己的 Authorization**，
 *   把前端发的 `Authorization: Bearer <我们的令牌>` 整个覆盖掉。
 *   实测服务端收到的是网关的 JWT（eyJhbGciOiJIUzI1N...），不是队员的令牌，
 *   于是每次请求都判成未登录 —— 现象就是打开应用报「登录状态已失效」。
 *   所以自定义头优先，Authorization 作为备选（本地直连、或换托管环境时仍然可用）。
 *   两个都不对就 401，不存在「猜中」的可能。
 */
function candidateTokens(req) {
  const found = [];

  const custom = req.headers['x-session-token'];
  if (custom) found.push(String(Array.isArray(custom) ? custom[0] : custom).trim());

  const raw = req.headers.authorization;
  if (raw) {
    const text = String(Array.isArray(raw) ? raw[0] : raw).trim();
    const match = /^(?:Bearer\s+)?(\S+)$/i.exec(text);
    if (match) found.push(match[1]);
  }

  return found.filter(function (t) { return t; });
}

/** 逐个候选令牌校验，返回第一个有效的会话 */
function currentSession(req) {
  const tokens = candidateTokens(req);
  for (let i = 0; i < tokens.length; i += 1) {
    const parsed = readSession(tokens[i]);
    if (parsed) return parsed;
  }
  return null;
}

function requireSession(req, res) {
  const current = currentSession(req);
  if (!current) {
    const tried = candidateTokens(req).length;
    console.warn('[会话] 拒绝 ' + req.method + ' ' + req.url + ' —— ' +
      (tried ? '带了的 ' + tried + ' 个令牌都校验不通过（已过期，或签名密钥变了）'
             : '请求里没有带令牌'));
    sendJson(req, res, 401, { ok: false, message: '登录状态已失效，请重新打开应用' });
    return null;
  }
  return current;
}

/* ==================== 接口 ==================== */

async function handleLogin(req, res) {
  const body = await readBody(req);
  const code = body && body.code;
  if (!code) {
    sendJson(req, res, 400, { ok: false, message: '缺少免登授权码' });
    return;
  }

  const exchanged = await feishu.exchangeUserToken(CONFIG, code, CONFIG.redirectUri);
  const user = await feishu.getUserInfo(exchanged.accessToken);

  // 可用范围已经在飞书应用那边限制了；这里再留一道白名单，方便临时封掉某个人
  if (CONFIG.allowedOpenIds.length && CONFIG.allowedOpenIds.indexOf(user.openId) === -1) {
    sendJson(req, res, 403, {
      ok: false,
      message: '你不在这个系统的使用名单里。请联系管理员把你加入应用可用范围。',
      user: user
    });
    return;
  }

  const token = issueSession(user);
  rememberUser(user);
  console.log('[登录] ' + user.name + '(' + user.openId + ') 取得会话' +
    (isAdminUser(user) ? '（管理员）' : ''));
  // isAdmin 每次现算，不进令牌 —— 改了名单立刻生效，不用等大家重新登录
  sendJson(req, res, 200, {
    ok: true,
    token: token,
    user: Object.assign({}, user, { isAdmin: isAdminUser(user) })
  });
}

/**
 * 网页应用 JSAPI 鉴权参数。
 *
 * 手机端扫码走飞书原生 `tt.scanCode`，它**必须**先过一遍 JSAPI 鉴权
 * （前端拿这里的四个参数去调 h5sdk.config），不然点了扫码就是没反应。
 * 签名只跟「应用身份 + 当前页面地址」有关，不含队员个人信息，
 * 但仍然要求已登录 —— 别把内部系统的签名参数敞给任何人拿。
 */
async function handleJsapiConfig(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return;
  const pageUrl = String(url.searchParams.get('url') || '').trim();
  if (!pageUrl) {
    sendJson(req, res, 400, { ok: false, message: '缺少 url 参数（要签名的页面地址）' });
    return;
  }
  if (!/^https?:\/\//i.test(pageUrl)) {
    sendJson(req, res, 400, { ok: false, message: 'url 必须带上 http/https 前缀' });
    return;
  }
  const signed = await feishu.jsapiConfig(CONFIG, pageUrl);
  sendJson(req, res, 200, Object.assign({ ok: true }, signed));
}

async function handleData(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const data = await loadAll(false);
  sendJson(req, res, 200, {
    ok: true,
    serverTime: new Date().toISOString(),
    sequences: STATE.sequences,
    data: data
  });
}

async function handleWrite(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  const ops = body && body.ops;
  if (!Array.isArray(ops)) {
    sendJson(req, res, 400, { ok: false, message: '写请求里缺少 ops 数组' });
    return;
  }
  if (!ops.length) {
    // 前端只做了读操作（比如启动时初始化大类），不产生任何写入
    await loadAll(false);
    sendJson(req, res, 200, { ok: true, sequences: STATE.sequences });
    return;
  }

  const result = await enqueue(function () {
    return applyOps(ops, {
      name: session.name,
      openId: session.openId,
      isAdmin: isAdminUser(session)
    });
  });

  sendJson(req, res, 200, { ok: true, sequences: result.sequences });
}

/* ==================== 诊断（临时） ==================== */

/**
 * 只在 config.json 里配了 diagKey 时才存在，否则一律 404。
 * 用来回答一个问题：队员的请求到达服务端时，是不是**没有带上令牌**，
 * 或者半路被反向代理剥掉了请求头。
 */
async function handleDiag(req, res, url) {
  const key = url.searchParams.get('key') || req.headers['x-diag-key'] || '';
  if (!CONFIG.diagKey || String(key) !== String(CONFIG.diagKey)) {
    sendJson(req, res, 404, { ok: false, message: '找不到页面' });
    return;
  }

  const tokens = candidateTokens(req);

  if (req.method === 'POST') {
    // 造一个会话令牌，用来验证「认证链路」本身通不通（绕开飞书免登）
    const body = await readBody(req);
    const minted = issueSession({
      openId: String((body && body.openId) || 'ou_diag_probe'),
      name: String((body && body.name) || '诊断探针')
    });
    sendJson(req, res, 200, { ok: true, token: minted, instance: INSTANCE_ID });
    return;
  }

  function peek(header) {
    const raw = req.headers[header];
    if (!raw) return null;
    const text = String(Array.isArray(raw) ? raw[0] : raw);
    return text.length > 28 ? text.slice(0, 28) + '…(' + text.length + '字符)' : text;
  }

  sendJson(req, res, 200, {
    ok: true,
    instance: INSTANCE_ID,
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    nowIso: new Date().toISOString(),
    // 关键：原样回报服务端实际收到的请求头，用来判断代理有没有剥头/换头
    headerNames: Object.keys(req.headers).sort(),
    auth: {
      authorizationRaw: peek('authorization'),
      xSessionTokenRaw: peek('x-session-token'),
      xProbeRaw: peek('x-probe'),
      candidates: tokens.map(function (t) { return t.slice(0, 16) + '…'; }),
      matchedIndex: (function () {
        for (let i = 0; i < tokens.length; i += 1) if (readSession(tokens[i])) return i;
        return -1;
      })(),
      sessionValid: !!currentSession(req)
    }
  });
}

/* ==================== 静态文件 ==================== */

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, urlPath) {
  if (!fs.existsSync(PUBLIC_DIR)) {
    sendJson(req, res, 404, { ok: false, message: '前端文件还没构建（缺少 server/public）' });
    return;
  }
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(req, res, 403, { ok: false, message: '路径不合法' });
    return;
  }
  fs.readFile(target, function (err, buf) {
    if (err) {
      // 单页应用：找不到的文件一律回到首页（# 路由在浏览器侧处理）
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), function (err2, indexBuf) {
        if (err2) {
          sendJson(req, res, 404, { ok: false, message: '找不到页面' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Cache-Control': 'no-cache'
        });
        res.end(indexBuf);
      });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(buf);
  });
}

/* ==================== 服务器 ==================== */

const CONFIG = loadConfig();

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const route = (function () {
    if (pathname === '/api/health') return 'health';
    if (pathname === '/api/login') return 'login';
    if (pathname === '/api/me') return 'me';
    if (pathname === '/api/data') return 'data';
    if (pathname === '/api/write') return 'write';
    if (pathname === '/api/jsapi-config') return 'jsapiConfig';
    if (pathname === '/api/upload') return 'upload';
    if (pathname === '/api/notify-test') return 'notifyTest';
    if (/^\/api\/file\//.test(pathname)) return 'file';
    if (pathname === '/api/_diag') return 'diag';
    return null;
  })();

  if (!route) {
    serveStatic(req, res, pathname);
    return;
  }

  Promise.resolve().then(async function () {
    if (route === 'health') {
      const payload = {
        ok: true,
        service: 'FEver 物资管理 · 飞书共享版后端',
        instance: INSTANCE_ID,
        pid: process.pid,
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeSec: Math.round(process.uptime()),
        dataLoaded: !!STATE.data,
        loadedAt: STATE.loadedAt ? new Date(STATE.loadedAt).toISOString() : null,
        prewarmMs: STATE.prewarmMs || null,
        tableIdsKnown: store.STORES.every(function (k) { return !!TABLE_ID_CACHE[k]; }),
        base: feishu.baseUrl(CONFIG.bitableAppToken)
      };

      // 带 ?probe=1 时顺便量一次「本服务到飞书」的真实往返耗时（只读，不改数据）。
      // 排查「保存慢」时先看这个数：它就是单次保存耗时的基本单位。
      if (url.searchParams.get('probe') === '1') {
        const t0 = Date.now();
        try {
          await feishu.listTables(CONFIG, CONFIG.bitableAppToken);
          payload.feishuReachable = true;
        } catch (err) {
          payload.feishuReachable = false;
          payload.feishuError = String((err && err.message) || err);
        }
        payload.feishuRoundTripMs = Date.now() - t0;
      }

      sendJson(req, res, 200, payload);
      return;
    }
    if (route === 'diag') {
      return handleDiag(req, res, url);
    }
    if (route === 'login') {
      if (req.method !== 'POST') { sendJson(req, res, 405, { ok: false, message: '请用 POST' }); return; }
      return handleLogin(req, res);
    }
    if (route === 'me') {
      const session = requireSession(req, res);
      if (session) {
        sendJson(req, res, 200, {
          ok: true,
          user: { openId: session.openId, name: session.name, isAdmin: isAdminUser(session) }
        });
      }
      return;
    }
    if (route === 'data') {
      if (req.method !== 'GET') { sendJson(req, res, 405, { ok: false, message: '请用 GET' }); return; }
      return handleData(req, res);
    }
    if (route === 'jsapiConfig') {
      if (req.method !== 'GET') { sendJson(req, res, 405, { ok: false, message: '请用 GET' }); return; }
      return handleJsapiConfig(req, res, url);
    }
    if (route === 'upload') {
      return handleUpload(req, res);
    }
    if (route === 'notifyTest') {
      return handleNotifyTest(req, res);
    }
    if (route === 'file') {
      return handleFileDownload(req, res, pathname);
    }
    if (route === 'write') {
      if (req.method !== 'POST') { sendJson(req, res, 405, { ok: false, message: '请用 POST' }); return; }
      return handleWrite(req, res);
    }
  }).catch(function (err) {
    const conflict = !!(err && err.conflict);
    const forbidden = !!(err && err.forbidden);
    console.error('[' + route + '] ' + (err && err.stack ? err.stack : err));
    sendJson(req, res, conflict ? 409 : (forbidden ? 403 : 500), {
      ok: false,
      conflict: conflict,
      forbidden: forbidden,
      message: (err && err.message) ? err.message : '服务端出错',
      detail: err && err.feishuCode ? { feishuCode: err.feishuCode } : undefined
    });
  });
});

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';

// 只有直接 `node index.js` 才监听端口；被 require 进来时（跑端到端测试）不占端口
if (require.main === module) {
  server.listen(PORT, HOST, function () {
    console.log('FEver 物资管理 · 飞书共享版后端已启动：http://' + HOST + ':' + PORT);
    console.log('多维表格：' + feishu.baseUrl(CONFIG.bitableAppToken));
    console.log('管理员名单：' + (CONFIG.admins.length
      ? CONFIG.admins.join('、')
      : '（空 —— 没人能同意/驳回采购申请，请在 config.json 的 admins 里填姓名或 openId）'));

    // 启动即预热。
    // 托管平台会把闲置的容器回收，之后第一个打开应用的人要等整个加载过程。
    // 这里端口一可用就去后台拉数据，让这段等待和平台自身的启动流程重叠——
    // 使用者打开页面时通常已经加载好了。loadAll 内部共享同一个 Promise，
    // 所以预热和你真实的请求不会各拉一遍。
    const warmStart = Date.now();
    loadAll(true).then(function () {
      STATE.prewarmMs = Date.now() - warmStart;
      console.log('数据预热完成，用时 ' + STATE.prewarmMs + ' ms');
    }, function (err) {
      console.error('预热失败（不影响使用，第一个真实请求会重试）：' +
        (err && err.message ? err.message : err));
    });
  });
}

process.on('unhandledRejection', function (reason) {
  console.error('[未处理的 Promise 拒绝]', reason);
});

// 端到端测试要直接调用内部逻辑（自己拿真实多维表格跑一遍），所以这里把关键口子暴露出来。
// 这些对象不改变任何运行时行为，只是让测试能绕过飞书免登（本地没有飞书客户端，拿不到授权码）。
module.exports = {
  server: server,
  applyOps: applyOps,
  loadAll: loadAll,
  computeSequences: computeSequences,
  issueSession: issueSession,
  isAdminUser: isAdminUser,
  adminOnlyReason: adminOnlyReason,
  rememberUser: rememberUser,
  adminOpenIds: adminOpenIds,
  collectPurchaseEvents: collectPurchaseEvents,
  STATE: STATE,
  CONFIG: CONFIG,
  mergeKnownUsersFromStore: mergeKnownUsersFromStore,
  /** 测试钩子：把内存里的登录名单清空，模拟"重新发布把本地文件清掉了" */
  resetKnownUsers: function () { knownUsers = {}; }
};
