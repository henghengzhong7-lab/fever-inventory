/**
 * 飞书共享版数据层（js/db-remote.js）的端到端测试。
 *
 * 这个测试不联网：它用一个「假后端」模拟 server/index.js 的语义
 *（全量 /api/data、批量 /api/write、自增编号、编号冲突拒绝），
 * 然后把真正的 rules.js / ops.js 挂上去跑一遍。
 *
 * 目的只有一个：证明换成远程数据层之后，现有业务代码的行为**没有变化**。
 *
 * 运行：node feishu/test/remote-db.js
 */
'use strict';

const path = require('node:path');

const STORES = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];
const KEY_PATH = {
  categories: 'id', items: 'code', purchaseRequests: 'id',
  invoices: 'id', transactions: 'id', settings: 'key'
};
const AUTO = { purchaseRequests: true, invoices: true, transactions: true };

let passed = 0;
let failed = 0;

function check(label, condition, extra) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}

function equal(label, actual, expected) {
  check(label + '（期望 ' + JSON.stringify(expected) + '）', actual === expected, actual);
}

/* ==================== 假后端 ==================== */

function createFakeBackend() {
  const data = {};
  STORES.forEach(function (name) { data[name] = []; });

  let writeCount = 0;
  let reserveCount = 0;
  let reserveSpans = [];
  let lastOps = [];
  let writeDelayMs = 0;
  const writeBodies = [];
  /** 每个写请求的形态：{ keepalive, bytes, opCount } —— keepalive 的正文上限就是这里钉的 */
  const writeRequests = [];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function sequences() {
    const out = {};
    STORES.forEach(function (name) {
      if (!AUTO[name]) return;
      let max = 0;
      data[name].forEach(function (row) {
        const id = Number(row.id);
        if (!isNaN(id) && id > max) max = id;
      });
      out[name] = max + 1;
    });
    return out;
  }

  function response(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      text: function () { return Promise.resolve(JSON.stringify(payload)); }
    };
  }

  function fetchMock(url, init) {
    const target = String(url);
    const method = (init && init.method) || 'GET';
    return Promise.resolve().then(function () {
      if (target.indexOf('/api/data') !== -1) {
        return response(200, { ok: true, sequences: sequences(), data: JSON.parse(JSON.stringify(data)) });
      }
      // 领一段编码（第二十六轮）：水位存在 settings 的 codeCounter:<前缀> 里，
      // 和真实服务端同一套规则（没有水位行时从物品表扫最大号）
      // 领一段记录 id（第二十八轮）：水位存 settings 的 idCounter:<表名>，
      // 与真实服务端同一套规则（没有水位行时从该表现有最大 id 往后接）
      if (target.indexOf('/api/reserve-ids') !== -1) {
        const rb = JSON.parse(init.body || '{}');
        const rStore = String(rb.store || '');
        const rCount = Math.max(1, Math.min(200, Number(rb.count) || 1));
        if (!AUTO[rStore]) {
          return response(400, { ok: false, message: '这张表不用自增编号：' + rStore });

          return;
        }
        const rKey = 'idCounter:' + rStore;
        const rRow = data.settings.filter(function (r) { return r.key === rKey; })[0];
        let rBase = rRow && typeof rRow.value === 'number' ? rRow.value : 0;
        if (!rRow) {
          data[rStore].forEach(function (r) {
            const n = Number(r.id);
            if (!isNaN(n) && n > rBase) rBase = n;
          });
        }
        const rIds = [];
        for (let ri = 1; ri <= rCount; ri += 1) rIds.push(rBase + ri);
        if (rRow) { rRow.value = rBase + rCount; } else {
          data.settings.push({ key: rKey, value: rBase + rCount, updatedAt: new Date().toISOString() });
        }
          return response(200, { ok: true, store: rStore, ids: rIds, from: rBase + 1, to: rBase + rCount });

        return;
      }
      if (target.indexOf('/api/reserve-codes') !== -1) {
        reserveCount += 1;
        const body = JSON.parse(init.body);
        const prefix = String(body.prefix || '').toUpperCase();
        const count = Math.max(1, Number(body.count) || 1);
        const counterKey = 'codeCounter:' + prefix;
        const row = data.settings.filter(function (r) { return r.key === counterKey; })[0];
        let base = row && typeof row.value === 'number' ? row.value : 0;
        if (!row) {
          data.items.forEach(function (it) {
            if (!it.code || it.code.indexOf(prefix + '-') !== 0) return;
            const parsed = parseInt(it.code.slice(prefix.length + 1), 10);
            if (!isNaN(parsed) && parsed > base) base = parsed;
          });
        }
        const codes = [];
        for (let i = 1; i <= count; i += 1) {
          codes.push(prefix + '-' + String(base + i).padStart(4, '0'));
        }
        if (row) { row.value = base + count; } else {
          data.settings.push({ key: counterKey, value: base + count, updatedAt: new Date().toISOString() });
        }
        reserveSpans.push([base + 1, base + count]);
        return response(200, { ok: true, prefix: prefix, codes: codes, from: base + 1, to: base + count });
      }
      if (target.indexOf('/api/write') !== -1) {
        const body = JSON.parse(init.body);
        writeCount += 1;
        lastOps = body.ops;
        writeBodies.push(body.ops);
        // 真实浏览器还会按 keepalive 的体型规矩拒发请求（>64KB 直接 TypeError）。
        // Node 的 fetch 不执行这条规矩，所以在这里如实记下来，由用例断言。
        writeRequests.push({
          keepalive: !!(init && init.keepalive),
          bytes: Buffer.byteLength(String(init.body || ''), 'utf8'),
          opCount: body.ops.length
        });
        // 模拟飞书那一侧的真实耗时：写比读慢得多，这里让"界面要不要等"变得可观测
        return sleep(writeDelayMs).then(function () {
          for (const op of body.ops) {
            const list = data[op.store];
            const keyName = KEY_PATH[op.store];
            if (op.type === 'add') {
              const clash = list.some(function (r) {
                return String(r[keyName]) === String(op.data[keyName]);
              });
              if (clash) {
                return response(409, { ok: false, conflict: true, message: '编号已被占用' });
              }
              list.push(op.data);
            } else if (op.type === 'put') {
              const index = list.findIndex(function (r) {
                return String(r[keyName]) === String(op.data[keyName]);
              });
              if (index === -1) list.push(op.data);
              else list[index] = op.data;
            } else if (op.type === 'delete') {
              data[op.store] = list.filter(function (r) {
                return String(r[keyName]) !== String(op.key);
              });
            } else if (op.type === 'clear') {
              data[op.store] = [];
            } else {
              return response(400, { ok: false, message: '不认识的操作类型 ' + op.type });
            }
          }
          return response(200, { ok: true, sequences: sequences() });
        });
      }
      if (target.indexOf('/api/me') !== -1) {
        return response(200, { ok: true, user: { name: '测试队员', openId: 'ou_test' } });
      }
      if (target.indexOf('/api/login') !== -1) {
        return response(200, { ok: true, token: 't', user: { name: '测试队员', openId: 'ou_test' } });
      }
      return response(404, { ok: false, message: '没有这个接口：' + target });
    });
  }

  return {
    fetch: fetchMock,
    data: data,
    setWriteDelay: function (ms) { writeDelayMs = ms; },
    stats: function () {
      return {
        writeCount: writeCount, lastOps: lastOps, writeBodies: writeBodies,
        writeRequests: writeRequests,
        reserveCount: reserveCount, reserveSpans: reserveSpans
      };
    }
  };
}

/* ==================== 准备运行环境 ==================== */

const backend = createFakeBackend();

globalThis.fetch = backend.fetch;
globalThis.FEVER_CONFIG = { appId: 'cli_test', apiBase: '' };
globalThis.FEVER = globalThis.FEVER || {};
globalThis.FEVER.Auth = {
  ready: Promise.resolve({ name: '测试队员', openId: 'ou_test' }),
  token: 'test-session',
  user: { name: '测试队员' }
};

// 加载被测的数据层（它会把自己挂到 globalThis.FEVER.DB 上）
require(path.join(__dirname, '..', 'js', 'db-remote.js'));

// rules.js / ops.js 会优先从 globalThis.FEVER.DB 取数据层，所以拿到的是远程版。
// 这两个文件来自 v1/——飞书版用的就是离线版那一份，没有副本。
const v1Js = path.join(__dirname, '..', '..', 'v1', 'js');
const Rules = require(path.join(v1Js, 'rules.js'));
const Ops = require(path.join(v1Js, 'ops.js'));
const Stats = require(path.join(v1Js, 'stats.js'));
const DB = globalThis.FEVER.DB;

// 入库必填兵种（功能13）之后，老用例没写 troop 的统一补默认值；
// 与 v1/test/test.js 的垫层一致，显式传 troop:'' 的用例仍走数据层真规则。
const realInbound = Ops.inbound;
Ops.inbound = function (input) {
  return realInbound(Object.assign({ troop: '其他' }, input));
};

/* ==================== 测试 ==================== */

async function main() {
  console.log('\n飞书共享版数据层 · 端到端测试\n');

  console.log('[1] 打开"数据库"（全量拉取建镜像）');
  await DB.openDB();
  equal('openDB 后 items 为空', (await DB.getAll('items')).length, 0);

  console.log('\n[2] 初始化大类（对应 app.js 启动时的 Rules.initCategories）');
  const cats = await Rules.initCategories();
  equal('六个大类已写入', cats.length, 6);
  equal('第二次初始化不会重复写入', (await Rules.initCategories()).length, 6);

  console.log('\n[3] 入库（shared 模式：N 件共用一个编码）');
  const inbound = await Ops.inbound({
    categoryId: 'mechanical', name: '测试螺丝', quantity: 10,
    identityMode: 'shared', operator: '张三', location: 'A 柜'
  });
  equal('生成了 1 个编码', inbound.codes.length, 1);
  equal('编码按规则生成', inbound.codes[0], 'MC-0001');
  const afterInbound = await DB.get('items', 'MC-0001');
  equal('在库 10 件', afterInbound.inStockQty, 10);
  equal('总数 10 件', afterInbound.totalQty, 10);
  equal('产生 1 条流水', (await DB.getAll('transactions')).length, 1);

  console.log('\n[4] 借出（改物品 + 写流水，多表一次提交）');
  await Ops.lend({
    code: 'MC-0001', qty: 3, operator: '李四', borrower: '王五', dueDate: '2026-10-01'
  });
  const afterLend = await DB.get('items', 'MC-0001');
  equal('在库剩 7 件', afterLend.inStockQty, 7);
  equal('借出 3 件', afterLend.lentQty, 3);
  equal('库存自洽（7+3=10）', afterLend.inStockQty + afterLend.lentQty, afterLend.totalQty);
  equal('借出台账能看到这条', (await Ops.lendLedger()).length, 1);

  console.log('\n[5] 超出库存要失败，并且不留脏数据');
  let rejected = false;
  try {
    await Ops.lend({ code: 'MC-0001', qty: 99, operator: '李四', borrower: '王五', dueDate: '2026-10-01' });
  } catch (err) {
    rejected = true;
  }
  check('借超被拒绝', rejected);
  const afterFail = await DB.get('items', 'MC-0001');
  equal('被拒绝后在库仍是 7 件', afterFail.inStockQty, 7);
  equal('流水没有多出来', (await DB.getAll('transactions')).length, 2);

  console.log('\n[6] 归还');
  await Ops.giveBack({ code: 'MC-0001', qty: 3, operator: '李四' });
  const afterBack = await DB.get('items', 'MC-0001');
  equal('在库回到 10 件', afterBack.inStockQty, 10);
  equal('借出清零', afterBack.lentQty, 0);
  equal('借出台账清空', (await Ops.lendLedger()).length, 0);

  console.log('\n[7] 编码计数器（保证不复用、不重号）');
  const second = await Ops.inbound({
    categoryId: 'mechanical', name: '第二件物品', quantity: 2,
    identityMode: 'shared', operator: '张三'
  });
  equal('第二个编码是 MC-0002', second.codes[0], 'MC-0002');
  const single = await Ops.inbound({
    categoryId: 'vision', name: '相机', quantity: 3,
    identityMode: 'single', operator: '张三'
  });
  equal('单独建身份时 3 件生成 3 个码', single.codes.length, 3);
  equal('视觉类前缀正确', single.codes[0], 'VS-0001');

  console.log('\n[8] 采购到货（发票 + 物品 + 申请，四表一起写）');
  const reqId = await DB.add('purchaseRequests', {
    categoryId: 'electronic', name: '电调', spec: '60A', quantity: 4,
    budget: '800', applicant: '赵六', purpose: '备件', status: 'ordered',
    createdAt: DB.nowIso(), updatedAt: DB.nowIso()
  });
  equal('采购申请拿到自增编号', typeof reqId, 'number');
  const arrived = await Ops.arrive({
    requestId: reqId, quantity: 4, invoiceNo: 'INV-001', supplier: '某供应商',
    amount: 760, operator: '张三', identityMode: 'shared'
  });
  check('到货生成了发票号', typeof arrived.invoiceId === 'number', arrived.invoiceId);
  const reqAfter = await DB.get('purchaseRequests', reqId);
  equal('申请状态变成已到货', reqAfter.status, 'arrived');
  equal('申请指向的发票号一致', reqAfter.invoiceId, arrived.invoiceId);
  const itemAfterArrive = await DB.get('items', arrived.codes[0]);
  equal('物品也指向同一张发票', itemAfterArrive.invoiceId, arrived.invoiceId);
  equal('物品关联到采购申请', itemAfterArrive.purchaseRequestId, reqId);

  console.log('\n[9] 备份导出 / 导入恢复');
  const backup = await Rules.exportAll();
  equal('备份包含六张表', Object.keys(backup.data).length, 6);
  check('备份里有物品', backup.data.items.length > 0, backup.data.items.length);
  const beforeImport = backup.data.items.length;
  const imported = await Rules.importAll(backup);
  equal('导入后物品数量不变', imported.counts.items, beforeImport);
  equal('导入后流水数量不变', imported.counts.transactions, backup.data.transactions.length);

  console.log('\n[10] 与服务端的交互次数（用于判断有没有在做无谓的请求）');
  await DB.whenSettled();
  const stats = backend.stats();
  check('发生过写请求', stats.writeCount > 0, stats.writeCount);
  check('每次写都是批量 ops', Array.isArray(stats.lastOps), typeof stats.lastOps);

  console.log('\n[11] 编号冲突：本地已有的当场拒绝，服务器上的异步对齐');
  // 模拟「队友刚提交、我这边编号过期」：直接往假后端塞一条占号记录
  backend.data.items.push({ code: 'MC-0900', name: '别人刚登记的', categoryId: 'mechanical' });
  // 镜像里还没有这条，所以本地这关过得去 —— 冲突只有服务器知道。
  // 写入是后台进行的，所以这里不会抛错，而是稍后由角标报出来并把镜像拉回真实状态。
  await DB.runTx('items', 'readwrite', function (T) {
    return T.add('items', { code: 'MC-0900', name: '我这边重复的', categoryId: 'mechanical' });
  });
  await DB.whenSettled();
  equal('服务器拒绝后镜像已重新对齐（看到的是别人的记录）',
    (await DB.get('items', 'MC-0900')).name, '别人刚登记的');
  // 镜像里已经有了，第二次重复提交属于本地就能查出来的错，必须当场拒绝
  let localDup = null;
  try {
    await DB.runTx('items', 'readwrite', function (T) {
      return T.add('items', { code: 'MC-0900', name: '再来一条', categoryId: 'mechanical' });
    });
  } catch (err) {
    localDup = err;
  }
  check('本地已有的编号仍然当场拒绝', !!localDup, localDup && localDup.message);

  console.log('\n[12] 写入不阻塞界面（本次改动的核心）');
  console.log('     让假后端慢 500ms，模拟飞书写入的真实耗时');
  backend.setWriteDelay(500);
  await DB.whenSettled();

  const t0 = Date.now();
  await Ops.lend({
    code: 'MC-0001', qty: 1, operator: '李四', borrower: '王五', dueDate: '2026-10-01'
  });
  const blocking = Date.now() - t0;
  check('runTx 不等服务器就返回（' + blocking + 'ms，应当远小于 500ms）', blocking < 200, blocking + 'ms');
  equal('返回时本地镜像里已经是最新状态', (await DB.get('items', 'MC-0001')).inStockQty, 9);

  const t1 = Date.now();
  await DB.whenSettled();
  const settled = Date.now() - t1;
  check('后台确实把它落库了（等待 ' + settled + 'ms 后服务器上有了）',
    backend.data.transactions.filter(function (t) { return t.itemCode === 'MC-0001' && t.type === 'lend'; }).length > 0);
  equal('落定后没有遗留未提交的改动', DB.pendingOps(), 0);

  console.log('\n[13] 同一个动作里的多个写请求被合并成一个');
  // 入库内部是「先占编码（写 settings）+ 再落库（写 items/transactions）」两步，
  // 以前是 2 个请求，合并后应该是 1 个 —— 少一次网关往返、少一次飞书写。
  const beforeMerge = backend.stats().writeCount;
  await Ops.inbound({
    categoryId: 'mechanical', name: '合并测试件', quantity: 1,
    identityMode: 'shared', operator: '张三'
  });
  await DB.whenSettled();
  const mergeDelta = backend.stats().writeCount - beforeMerge;
  equal('入库一步只发了 1 个写请求（旧版是 2 个）', mergeDelta, 1);
  const merged = backend.stats().writeBodies[backend.stats().writeBodies.length - 1];
  // 第二十六轮：**占编码不再由前端做**（改成服务端发号，见 [18]），
  // 所以这个请求里只剩落库类的 op —— 恰好要断言「没有 settings 计数器那一笔」，
  // 因为那一笔正是撞号的来源（两个客户端各写各的计数器）。
  const hasCounterOp = merged.some(function (op) {
    return op.store === 'settings' && op.data && String(op.data.key || '').indexOf('codeCounter:') === 0;
  });
  check('请求里不再有「前端自己占编码」那一笔（改由服务端发号）', !hasCounterOp, hasCounterOp);
  check('落库的 op 都在（items + transactions）', merged.length >= 2, merged.length);

  console.log('\n[14] 导入备份这类大事务仍然等服务器确认');
  const backup2 = await Rules.exportAll();
  const beforeImport2 = Date.now();
  await Rules.importAll(backup2);
  const importCost = Date.now() - beforeImport2;
  check('importAll 等到了服务器确认（' + importCost + 'ms，应当不小于 500ms）', importCost >= 500, importCost + 'ms');

  console.log('\n[15] 四项新增功能在远程数据层上同样成立');
  console.log('     （这些功能都是往记录的 JSON 里加键，没有动多维表格的表结构）');

  // 1) 新建申请：兵种和「待审批」都必须真的落到服务器上
  const newReqId = await Ops.createRequest({
    categoryId: 'electronic', troop: '步兵', name: '新电调', quantity: 1,
    budget: '600', applicant: '张三', purpose: '备用'
  });
  await DB.whenSettled();
  const reqOnServer = backend.data.purchaseRequests.filter(function (r) {
    return String(r.id) === String(newReqId);
  })[0];
  check('新申请已经落到服务器上（不只是改了本地镜像）', !!reqOnServer, newReqId);
  equal('服务器上带着兵种字段', reqOnServer && reqOnServer.troop, '步兵');
  equal('服务器上是「待审批」（不靠"没有字段"被静默放行）', reqOnServer && reqOnServer.approval, 'pending');
  check('审批判定在远程数据上也一致',
    !Rules.isApproved(reqOnServer) && Rules.isPendingApproval(reqOnServer));

  // 2) 未审批不能入库：这条闸在远程数据层上同样有效
  let blocked = null;
  try {
    await Ops.arrive({
      requestId: newReqId, quantity: 1, invoiceNo: 'INV-X', amount: 1,
      supplier: '某供应商', operator: '张三', identityMode: 'shared'
    });
  } catch (err) { blocked = err; }
  check('待审批的申请在远程数据层上也入不了库', !!blocked, blocked && blocked.message);
  await DB.whenSettled();
  check('服务器上没有因为这次失败的入库多出发票',
    !backend.data.invoices.some(function (iv) { return iv.invoiceNo === 'INV-X'; }));

  // 3) 删除：本地镜像和服务器两边都要真的没
  const snapshot = reqOnServer;
  await DB.remove('purchaseRequests', newReqId);
  await DB.whenSettled();
  equal('本地镜像里已经删掉', await DB.get('purchaseRequests', newReqId), undefined);
  check('服务器上也已经删掉（删除是同步到飞书的）',
    !backend.data.purchaseRequests.some(function (r) { return String(r.id) === String(newReqId); }));

  // 4) 删除记录：写进 settings，也要能过服务器 —— 否则审计只在本地，等于没有
  await Rules.logDeletion({
    store: 'purchaseRequests', key: newReqId, label: '#' + newReqId + ' 新电调', snapshot: snapshot
  });
  await DB.whenSettled();
  const logOnServer = backend.data.settings.filter(function (s) {
    return s.key === Rules.DELETE_LOG_KEY;
  })[0];
  check('删除记录已经写到服务器上', !!logOnServer, logOnServer && logOnServer.key);
  equal('服务器上的删除记录有 1 条', logOnServer && logOnServer.value.length, 1);
  equal('删除记录里留着被删内容的快照', logOnServer && logOnServer.value[0].snapshot.name, '新电调');
  const remoteUser = DB.currentUser();
  check('远程数据层能拿到飞书登录身份', !!remoteUser, remoteUser);
  equal('删除记录里的操作人取自登录身份（不是「本机操作」）',
    logOnServer && logOnServer.value[0].by, remoteUser && remoteUser.name);

  // 5) 兵种预算额度：同样是 settings 里的一个键，不动表结构
  await DB.setSetting('budgetByTroop', { 步兵: 10000 });
  await DB.whenSettled();
  const budgetOnServer = backend.data.settings.filter(function (s) { return s.key === 'budgetByTroop'; })[0];
  check('兵种预算写到了服务器上', !!budgetOnServer, budgetOnServer && budgetOnServer.key);
  equal('预算额度原样保留', budgetOnServer && budgetOnServer.value['步兵'], 10000);

  // 6) 权限：飞书版里"是不是管理员"由服务端给，远程数据层如实反映
  equal('接口给出的身份不是管理员时，isAdmin() 就是 false', DB.isAdmin(), false);

  console.log('\n[16] 批量删除：整批一个事务，删除记录只写一次、不丢账');
  console.log('     （删除记录是「读当前 → 合并 → 写回」的读改写：逐条删会让几次读改写交错，');
  console.log('       后写的把先写的冲掉，账就丢了。所以整批必须落在同一次提交里）');

  // 三件可删的 + 一件借出去的
  const del1 = (await Ops.inbound({ categoryId: 'hardware', name: '批量删1', quantity: 1, identityMode: 'single', operator: '张三' })).codes[0];
  const del2 = (await Ops.inbound({ categoryId: 'hardware', name: '批量删2', quantity: 1, identityMode: 'single', operator: '张三' })).codes[0];
  const del3 = (await Ops.inbound({ categoryId: 'hardware', name: '批量删3', quantity: 1, identityMode: 'single', operator: '张三' })).codes[0];
  const onLoan = (await Ops.inbound({ categoryId: 'hardware', name: '借出去的', quantity: 1, identityMode: 'single', operator: '张三' })).codes[0];
  await Ops.lend({ code: onLoan, qty: 1, operator: '张三', borrower: '王五', dueDate: '2030-01-01' });
  await DB.whenSettled();

  const writesBefore = backend.stats().writeCount;
  const batchResult = await Ops.deleteItemsBatch([del1, del2, del3, onLoan]);
  await DB.whenSettled();

  equal('三件删掉', batchResult.removed.length, 3);
  equal('借出去的那件被跳过（不是整批失败）', batchResult.blocked.length, 1);
  equal('整批只占用 1 次写请求', backend.stats().writeCount - writesBefore, 1);

  // 这一组才是「一个事务」的真实证据：整批的 op 一起提交，
  // 删除记录（settings 的 put）只出现一次，而不是每件一次。
  const lastOps = backend.stats().lastOps || [];
  const itemDeletes = lastOps.filter(function (op) { return op.type === 'delete' && op.store === 'items'; });
  const logPuts = lastOps.filter(function (op) {
    return op.type === 'put' && op.store === 'settings' && op.data && op.data.key === Rules.DELETE_LOG_KEY;
  });
  equal('三件删除落在同一次提交里', itemDeletes.length, 3);
  equal('删除记录只提交一次（不是每件一次读改写 —— 交错会互相覆盖）', logPuts.length, 1);

  [del1, del2, del3].forEach(function (code) {
    check('服务器上已经删掉 ' + code,
      !backend.data.items.some(function (i) { return i.code === code; }));
  });
  check('借出去的那件还在服务器上（删了就没法追是谁借的）',
    backend.data.items.some(function (i) { return i.code === onLoan; }));

  const remoteLog = backend.data.settings.filter(function (s) {
    return s.key === Rules.DELETE_LOG_KEY;
  })[0];
  const batchRows = (remoteLog ? remoteLog.value : []).filter(function (r) {
    return [del1, del2, del3].indexOf(r.key) !== -1;
  });
  equal('服务器上的删除记录多了 3 条（逐条留痕，不是只记一笔"批量删了3件"）', batchRows.length, 3);
  check('每一条都带被删内容的快照', batchRows.every(function (r) { return !!r.snapshot; }));
  equal('批量删除的账也标了原因', batchRows[0] && batchRows[0].reason, '批量删除');
  equal('批量删除的操作人取自登录身份（不是「本机操作」）',
    batchRows[0] && batchRows[0].by, DB.currentUser() && DB.currentUser().name);

  console.log('\n[17] 手机端与电脑端是同一个后端的两扇窗（"数据保持一致"的真正凭据）');
  console.log('     （不是手机存一份、电脑存一份再想办法对齐 —— 那样迟早对不上；');
  console.log('       而是**只有一份数据在服务器上**，手机和电脑都只是它的窗口）');

  const remotePath = path.join(__dirname, '..', 'js', 'db-remote.js');

  /**
   * 再开一个"客户端"，相当于另一台设备上的那个应用。
   *
   * db-remote.js 每次 require 都会造一份新的镜像与提交队列，挂在 global.FEVER.DB 上；
   * 规则层/业务层在加载时就抓走了第一份，不受影响。
   * 所以拿走新实例之后要把原来那一份还回去，别把"电脑端"弄丢了。
   */
  function openAnotherClient() {
    delete require.cache[require.resolve(remotePath)];
    const keep = globalThis.FEVER.DB;
    delete globalThis.FEVER.DB;
    require(remotePath);
    const second = globalThis.FEVER.DB;
    globalThis.FEVER.DB = keep;
    return second;
  }

  // 1) 电脑端入库一件东西
  const shared = await Ops.inbound({
    categoryId: 'mechanical', name: '两端共用件', quantity: 3,
    identityMode: 'shared', operator: '张三', location: 'A 柜'
  });
  await DB.whenSettled();
  const sharedCode = shared.codes[0];

  // 2) 手机上打开同一个应用：应当**立刻**看到，不需要任何"同步"操作
  const phone = openAnotherClient();
  await phone.openDB();
  const phoneItem = await phone.get('items', sharedCode);
  check('手机端打开就能看到电脑端刚入库的东西（不需要任何同步设置）', !!phoneItem, phoneItem && phoneItem.code);
  equal('手机端看到的名称与电脑端一致', phoneItem && phoneItem.name, '两端共用件');
  equal('手机端看到的存放位置与电脑端一致', phoneItem && phoneItem.location, 'A 柜');

  // 3) 手机端改了位置（扫码查物页上"确认放在哪"改的就是这个字段）
  phoneItem.location = 'B 柜第三层';
  phoneItem.updatedAt = phone.nowIso();
  await phone.put('items', phoneItem);
  await phone.whenSettled();

  // 4) 电脑端重新拉一次（切回页面、回到前台时会自动拉），应当看到手机端改的
  await DB.syncNow();
  const desktopItem = await DB.get('items', sharedCode);
  equal('手机端改的存放位置，电脑端重新拉取后就看到了', desktopItem && desktopItem.location, 'B 柜第三层');
  const desktopCtx = await Stats.itemContext(sharedCode);
  equal('电脑端详情页读到的位置与手机端改的一致（同一份数据）',
    desktopCtx && desktopCtx.item.location, 'B 柜第三层');

  // 5) 电脑端登记借出，手机端重拉后能查到借给谁
  //    —— 扫码查物页答"借给谁了"读的就是这几条流水
  await Ops.lend({ code: sharedCode, qty: 2, operator: '张三', borrower: '李四', dueDate: '2030-01-01' });
  await DB.whenSettled();
  await phone.syncNow();
  const phoneTxns = await phone.getByIndex('transactions', 'itemCode', sharedCode);
  const phoneLend = phoneTxns.filter(function (t) { return t.type === 'lend'; })[0];
  equal('电脑端登记的借出，手机端重拉后查得到借给谁', phoneLend && phoneLend.borrower, '李四');
  equal('借出数量也对得上', phoneLend && phoneLend.qty, 2);
  const phoneItem2 = await phone.get('items', sharedCode);
  equal('手机端看到的在库/借出数量与电脑端一致', phoneItem2 && phoneItem2.inStockQty, 1);
  equal('手机端看到的借出数与电脑端一致', phoneItem2 && phoneItem2.lentQty, 2);

  console.log('\n[18] 编码由服务端发号：领一段用一段，两个客户端不会撞号（第二十六轮）');

  // 这一节的由来：原来编码序号是前端各自在本机算的，两个人同时添加物品就会
  // 都算出同一个号 → 服务端 409 → 界面提示"请重新操作一次"并重拉全量数据。
  // 现在改成「服务端发号 + 前端领一段存着用」，这里钉住三件事：
  //   ① 领一段之后连续取号**不再打网络**（所以入库不会再有额外等待）
  //   ② 发出的号不重复
  //   ③ 池子用尽后再领，新段与旧段**不重叠**（这是"永远不会撞"的依据）
  const reserveBefore = backend.stats().reserveCount;
  const zzCodesA = await DB.nextCodes('ZZ', 3);
  const afterFirst = backend.stats().reserveCount;
  equal('第一次取号会去服务端领一段', afterFirst - reserveBefore, 1);
  equal('拿到 3 个号', zzCodesA.length, 3);
  check('号是连号且形如 ZZ-0001', /^ZZ-\d{4}$/.test(zzCodesA[0]) && zzCodesA[2].endsWith(String(Number(zzCodesA[0].slice(3)) + 2).padStart(4, '0')), zzCodesA.join(','));

  // 池子里应该还剩（一段 20 个，用掉 3 个）
  const zzCodesB = await DB.nextCodes('ZZ', 5);
  equal('池子里还有货时不再打网络', backend.stats().reserveCount - afterFirst, 0);
  const zzAll = zzCodesA.concat(zzCodesB);
  equal('发出的号互不重复', new Set(zzAll).size, zzAll.length);

  // 把这一段用光，逼它再领一段 —— 新段必须接在旧段后面，不能回头
  const zzCodesC = await DB.nextCodes('ZZ', 12);   // 3+5+12 = 20，正好用光这一段
  const spans = backend.stats().reserveSpans;
  equal('用过一段后应该只领过一次', spans.length >= 1, true);
  // ⚠️ stats() 返回的是同一个数组引用，得先存个长度快照（拿引用比 length 永远相等）
  const zzSpansBefore = backend.stats().reserveSpans.length;
  const zzCodesD = await DB.nextCodes('ZZ', 2);
  const spans2 = backend.stats().reserveSpans;
  // ⚠️ stats() 返回的是同一个数组引用，不能拿它跟之前的引用比 length（那永远相等）
  check('池子用尽后会再领一段', spans2.length > zzSpansBefore, spans2.length + ' vs ' + zzSpansBefore);
  const lastSpan = spans2[spans2.length - 1];
  const prevSpan = spans2[spans2.length - 2];
  check('新领的一段与上一段不重叠（' + JSON.stringify(prevSpan) + ' → ' + JSON.stringify(lastSpan) + '）',
    lastSpan[0] > prevSpan[1], lastSpan[0]);
  const lastCode = Number(zzCodesD[0].slice(3));
  check('新段里的号比上一段最大号还大', lastCode > prevSpan[1], lastCode + ' vs ' + prevSpan[1]);

  // 全部号一起看一遍：一个都不能重（这是"绝不撞号"的直接证据）
  const zzEverything = zzAll.concat(zzCodesC).concat(zzCodesD);
  equal('整个过程中发出的号一个都没重复', new Set(zzEverything).size, zzEverything.length);

  // 入库也走同一条路：领号 + 落库，且落库那一步是正常写请求
  const writeBefore = backend.stats().writeCount;
  const inboundRes = await Ops.inbound({
    categoryId: 'mechanical', name: '发号机制测试件', quantity: 1,
    identityMode: 'shared', operator: '张三'
  });
  await DB.whenSettled();
  check('入库仍然正常拿到编码', /^MC-\d{4}$/.test(inboundRes.codes[0]), inboundRes.codes[0]);
  equal('入库仍然只发一个写请求', backend.stats().writeCount - writeBefore, 1);

  console.log('\n[19] 记录 id 也由服务端发：连续写入不撞号（第二十八轮）');
  // 起因：流水 id 原来是本机计数器分配的，而每次入库都会写一条流水 ——
  // 两人同时入库几乎必然分到同一个 id（服务端 409「编号 N 已被占用」）。
  const zzWritesBefore = backend.stats().writeCount;
  const zzIdsBefore = (await DB.getAll('transactions')).map(function (t) { return Number(t.id); });
  for (let zz = 0; zz < 3; zz += 1) {
    await Ops.inbound({
      categoryId: 'mechanical', name: '发号测试件' + zz, quantity: 1,
      identityMode: 'shared', operator: '张三'
    });
    await DB.whenSettled();
  }
  const zzIdsAfter = (await DB.getAll('transactions')).map(function (t) { return Number(t.id); });
  const zzNew = zzIdsAfter.filter(function (id) { return zzIdsBefore.indexOf(id) === -1; });
  check('三次入库新增的流水号一个都不重复（' + zzNew.join(',') + '）',
    new Set(zzNew).size === zzNew.length, zzNew);
  equal('每次入库仍然只发一个写请求', backend.stats().writeCount - zzWritesBefore, 3);
  const zzServerIds = backend.data.transactions.map(function (t) { return Number(t.id); });
  check('服务器上也没有重复的 id（' + zzServerIds.length + ' 条）',
    new Set(zzServerIds).size === zzServerIds.length, zzServerIds);

  console.log('\n[20] 预热只补不消耗：反复同步不会把号池抽干（第二十九轮）');
  // 起因：上一轮的 prewarmIds 写成 takeIds(name,1) —— 那是"取走一个号"、返回值还被丢掉，
  // 于是每次 loadAll 都白扔号，池子见底后每次写记录都要真去领号（一次飞书写往返）→ 单人操作也卡。
  // 这里钉住两件事：反复同步不重复领号；池子够用时连续写入不额外领号。
  const zzResBefore = backend.stats().reserveCount;
  await DB.syncNow();
  await DB.syncNow();
  await DB.syncNow();
  const zzResAfter = backend.stats().reserveCount;
  check('反复同步不会每次都去领号（期间领号 ' + (zzResAfter - zzResBefore) + ' 次）',
    zzResAfter - zzResBefore <= 1, zzResAfter - zzResBefore);

  const zzWBefore = backend.stats().reserveCount;
  for (let zz = 0; zz < 8; zz += 1) {
    await DB.add('transactions', {
      itemCode: 'X', type: 'lend', qty: 1, operator: '测试',
      createdAt: new Date().toISOString()
    });
  }
  await DB.whenSettled();
  const zzSpent = backend.stats().reserveCount - zzWBefore;
  check('连续写 8 条期间领号次数很少（实际 ' + zzSpent + ' 次，池里够用就该是 0）',
    zzSpent <= 1, zzSpent);
  const zzAllIds = (await DB.getAll('transactions')).map(function (t) { return Number(t.id); });
  check('这 8 条的号互不重复（共 ' + zzAllIds.length + ' 条）',
    new Set(zzAllIds).size === zzAllIds.length, zzAllIds.join(','));

  console.log('\n[21] 号池不会「越补越领」：本地已有相同 id 时领号次数必须有上界（第二十九轮）');
  // 这一条钉的是我自己造的故障：本地镜像里已有 id=1（改系统之前是本机计数器造号，
  // 与服务端水位并不一致），而服务端又发来同一段 → 过滤后池空。
  // 上一版实现是 `return takeIds(store, count)` 递归 + 「池低就补」，
  // 于是"取号 → 发现不够 → 领 → 号又被占用 → 再领…"每一步都是一次 HTTP 请求，
  // 单人操作也会被拖垮。这里用"领号请求次数"当上界来测。
  backend.data.transactions.push({
    id: 1, itemCode: 'X', type: 'lend', qty: 1,
    operator: '别人', createdAt: new Date().toISOString()
  });
  await DB.syncNow();

  const fillBefore = backend.stats().reserveCount;
  for (let zz = 0; zz < 3; zz += 1) {
    await DB.add('transactions', {
      itemCode: 'X', type: 'lend', qty: 1, operator: '测试',
      createdAt: new Date().toISOString()
    });
  }
  await DB.whenSettled();
  const spent = backend.stats().reserveCount - fillBefore;
  check('3 次写入期间的领号请求不超过 3 次（实际 ' + spent + '；旧实现会无上限递归）',
    spent <= 3, spent);

  // ⚠️ 表里现在**故意**有一个重复的 id（上面塞进去那条），所以不能断言'整表无重复'。
  // 该断言的是：新写入的 3 条互不相同，且都避开了那个已被占用的 1 ——
  // 这才真正验证了'跳过本地已占用号'这道防御在生效。
  const ids21 = (await DB.getAll('transactions')).map(function (t) { return Number(t.id); });
  const fresh21 = ids21.slice(-3);
  check('新写入的 3 条：互不相同且都避开了本地已占用的 1（实际 ' + fresh21.join(',') + '）',
    new Set(fresh21).size === 3 && fresh21.every(function (id) { return id > 1; }), fresh21.join(','));

  console.log('\n[22] 大写入不带 keepalive：请求体超过浏览器上限时不能再被直接拒发');
  // 这一条钉的是一个真实故障（线上 2026-10 出现：物品删不掉，提示"连不上服务器"）：
  //   浏览器规定**带 keepalive 的请求正文 ≤64KB**，且同一时刻在飞的多个 keepalive
  //   请求**共享**这 64KB。超限不降级 —— 整个请求被拒（TypeError: Failed to fetch），
  //   界面看到的就是"连不上服务器，请检查网络后重试"。
  //   删除物品的写入带着「删除记录」：每票存一条整条物品快照。线上攒到 122 票时
  //   正文 66,019 字节，越过 65,536 的上限 —— 从那以后每次删除必失败，物品删不掉。
  // 修法：flushNow 先量体型，超 KEEPALIVE_MAX_BYTES 的走普通 fetch，小的才用 keepalive。

  // 1) 造一件可删的物品
  const klInbound = await Ops.inbound({
    categoryId: 'mechanical', name: '大写入测试件', quantity: 1,
    identityMode: 'single', operator: '张三'
  });
  await DB.whenSettled();
  const klCode = klInbound.codes[0];
  const klRow = await DB.get('items', klCode);   // 快照要在删之前取

  // 2) 把「删除记录」垫到线上真实量级（一百多票，每票一条整条物品快照）
  const klFatLog = [];
  for (let kl = 0; kl < 240; kl += 1) {
    klFatLog.push({
      at: '2026-10-01T00:00:00.000Z',
      by: '历史操作',
      store: 'items',
      key: 'MC-9' + String(kl).padStart(3, '0'),
      label: '物品 MC-9' + String(kl).padStart(3, '0') + '历史已删物品',
      reason: '',
      snapshot: {
        code: 'MC-9' + String(kl).padStart(3, '0'),
        name: '历史已删物品',
        spec: '规格型号一长串文字，让快照占够体积',
        categoryId: 'mechanical',
        location: 'A 柜第三层',
        identityMode: 'single',
        totalQty: 1, inStockQty: 1, lentQty: 0, repairQty: 0, usedUpQty: 0,
        status: 'in_stock',
        remark: '删除记录回归用例垫数据用，不是真物品'
      }
    });
  }
  await DB.setSetting(Rules.DELETE_LOG_KEY, klFatLog);
  await DB.whenSettled();

  // 3) 走真实删除路径：删物品 + 写删除记录，两条 op 合成同一个写请求
  const klWriteBefore = backend.stats().writeRequests.length;
  await DB.remove('items', klCode);
  await Rules.logDeletion({
    store: 'items', key: klCode, label: '物品 ' + klCode + ' 大写入测试件',
    reason: '回归', snapshot: klRow
  });
  await DB.whenSettled();
  const klWrites = backend.stats().writeRequests.slice(klWriteBefore);
  const klBig = klWrites.filter(function (r) { return r.bytes > 64 * 1024; });
  check('删除的写请求体确实越过了浏览器 keepalive 的 64KB 上限（' +
    (klBig[0] ? klBig[0].bytes + ' 字节' : '没有') + '；线上就是这么坏的）',
    klBig.length >= 1, klWrites.map(function (r) { return r.bytes; }).join(','));
  check('越过上限的请求没有带 keepalive（带了会被浏览器整个拒发）',
    klBig.length > 0 && klBig.every(function (r) { return !r.keepalive; }));
  check('物品在服务器上真的删掉了（请求正常送达，没有被拒发）',
    !backend.data.items.some(function (i) { return i.code === klCode; }));
  const klFinalLog = backend.data.settings.filter(function (s) {
    return s.key === Rules.DELETE_LOG_KEY;
  })[0].value;
  const klFinalChars = JSON.stringify(klFinalLog).length;
  check('这次的删除记录也写上了（' + klFinalLog.length + ' 票 / ' + klFinalChars + ' 字符）',
    klFinalLog.length > 200 && klFinalChars <= Rules.DELETE_LOG_MAX_CHARS,
    '票数 ' + klFinalLog.length + '、字符 ' + klFinalChars +
    '（超过飞书 10 万字符上限那一格就写不进去了）');

  // 4) 小写入照旧带 keepalive —— 修的是"别让大请求撞上限"，不是把 keepalive 关掉
  await DB.setSetting('keepaliveProbe', { hello: 1 });
  await DB.whenSettled();
  const klSmall = backend.stats().writeRequests[backend.stats().writeRequests.length - 1];
  check('小写入仍然带 keepalive（队员点完确认就关页面也发得出去）',
    !!klSmall.keepalive && klSmall.bytes < 32 * 1024,
    'keepalive=' + klSmall.keepalive + ' bytes=' + klSmall.bytes);

  console.log('\n结果：' + passed + ' 项通过，' + failed + ' 项失败\n');
  process.exit(failed === 0 ? 0 : 1);
}


main().catch(function (err) {
  console.error('\n测试崩了：', err && err.stack ? err.stack : err);
  process.exit(1);
});
