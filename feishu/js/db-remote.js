/**
 * FEver 战队物资管理 —— 数据层（飞书共享版）
 *
 * 和本地离线版 v1/js/db.js 提供**完全相同**的接口，所以界面那 15 个运行时文件
 * 一行都不用改，换掉这一个文件就从「各存各的」变成「全队共用一份」。
 *
 * 怎么做到的：
 *   - 打开页面时一次性把全部数据拉下来，在内存里建一份镜像（战队规模千级记录，一次几百 KB）；
 *   - 所有读操作走内存镜像，所以和本地 IndexedDB 一样是"同步就有结果"的写法；
 *   - runTx 里的写操作先在镜像上演算，等这一次事务的逻辑跑完，再把整批变更
 *     打包成一个请求交给服务端——这也正是 v1 里"多表原子写"的语义。
 *
 * 为什么要打成一个请求：多维表格没有事务，逐条写会中途失败留半套数据。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 关于「点了确认要等好几秒」这件事（2026-09-21 改）
 *
 * 实测到的两个硬数字，决定了这里的设计：
 *   1. 托管平台网关对**每个请求**固定收约 550ms（下一个 1.4KB 的静态文件也一样，
 *      TCP 连接复用了也一样）——这一段我们改不了。
 *   2. 飞书多维表格「写」一次要 2.3~3.9 秒（「读」是 0.9 秒），
 *      写比读慢 2.5~3.8 倍，而且这是飞书 API 本身的速度。
 *
 * 两者相加，一次确认就是 3~4 秒。**这段等待没法靠优化消掉，只能不让人等。**
 *
 * 所以写入改成「本地立即生效 + 后台提交」：
 *   · runTx 在镜像上算完就立刻返回，界面马上关弹窗、出提示、刷新列表（0 等待）；
 *   · 变更攒成一个队列，同一个动作里的多个 runTx（比如「先占编码、再落库」两步）
 *     会被合并成**一个** /api/write 请求，少一次网关往返、少一次飞书写入；
 *   · 提交失败时不会装作没事：左下角角标变红写清原因，自动从服务器重拉一份对齐，
 *     并重新画一次界面——**界面显示的永远是服务器上真实存在的数据**。
 *
 * 「可追溯」没有打折：写入仍然原样进多维表格，带操作人和时间；
 * 变的只是界面不再干等。想退回「等服务器确认才返回」的老行为，
 * 在 feishu.config.json 里加 "strictWrites": true 即可（导入备份、清库这类
 * 大事务**本来就走**等确认的老路径，见 NEEDS_CONFIRM 的判断）。
 * ─────────────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  var FORMAT_VERSION = 1;
  var STORES = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];

  /** 每张表的主键字段名（对应 v1/js/db.js 里的 keyPath） */
  var KEY_PATH = {
    categories: 'id',
    items: 'code',
    purchaseRequests: 'id',
    invoices: 'id',
    transactions: 'id',
    settings: 'key'
  };

  /** 主键由服务端分配的自增表（对应 IndexedDB 的 autoIncrement） */
  var AUTO_ID = { purchaseRequests: true, invoices: true, transactions: true };

  /** 索引字段名，对应 db.js 里 createIndex 的定义 */
  var INDEX_FIELDS = {
    categories: { sortOrder: 'sortOrder' },
    items: {
      categoryId: 'categoryId', status: 'status', purchaseRequestId: 'purchaseRequestId',
      name: 'name', updatedAt: 'updatedAt'
    },
    purchaseRequests: { categoryId: 'categoryId', status: 'status', createdAt: 'createdAt' },
    invoices: { purchaseRequestId: 'purchaseRequestId', invoiceNo: 'invoiceNo', createdAt: 'createdAt' },
    transactions: { itemCode: 'itemCode', type: 'type', operator: 'operator', createdAt: 'createdAt' },
    settings: {}
  };

  var CONFIG = global.FEVER_CONFIG || {};

  /**
   * 大事务的判断阈值。
   * 一次导入备份会带几千条 put、还会带 clear，这种操作**必须**当场知道成败，
   * 不能后台悄悄做（失败了使用者还以为恢复成功了）。所以这类走"等服务器确认"的老路径。
   */
  var NEEDS_CONFIRM_OPS = 300;

  /** 攒一小会儿再发，好把同一个动作里的多个 runTx 合并成一个请求 */
  var FLUSH_DELAY_MS = 120;
  /** 但最多攒这么久，不能让改动在本地悬着不发 */
  var FLUSH_MAX_WAIT_MS = 800;

  /** 内存镜像：{ store: [行, 行, ...] } */
  var mirror = null;
  /** 自增表的下一个可用编号 */
  var counters = {};
  var opening = null;
  var session = { token: '', user: null };
  var lastSyncedAt = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function list(store) {
    if (!mirror) throw new Error('数据还没加载完，请稍候');
    if (!mirror[store]) mirror[store] = [];
    return mirror[store];
  }

  function keyOfRow(store, row) {
    var name = KEY_PATH[store];
    if (!name) throw new Error('未知的数据表：' + store);
    var value = row ? row[name] : undefined;
    if (value === undefined || value === null || value === '') {
      throw new Error('记录缺少主键「' + name + '」：' + store);
    }
    return String(value);
  }

  function indexOfKey(store, key) {
    var rows = list(store);
    var target = String(key);
    for (var i = 0; i < rows.length; i += 1) {
      if (String(rows[i][KEY_PATH[store]]) === target) return i;
    }
    return -1;
  }

  function maxId(store) {
    var max = 0;
    list(store).forEach(function (row) {
      var id = Number(row.id);
      if (!isNaN(id) && id > max) max = id;
    });
    return max;
  }

  /* ==================== 与服务端通信 ==================== */

  function apiBase() {
    var cfg = global.FEVER_CONFIG || {};
    return String(cfg.apiBase || '').replace(/\/+$/, '');
  }

  /** 令牌失效时重新走一次免登（feishu-auth.js 的 renew 会忽略本地缓存，强制重新登录） */
  function renewToken() {
    var auth = global.FEVER && global.FEVER.Auth;
    if (!auth || !auth.renew) return Promise.reject(new Error('登录模块不支持重新登录'));
    return auth.renew().then(function () {
      session.token = auth.token || '';
      return session.token;
    });
  }

  function api(path, options, isRetry) {
    var headers = { 'Content-Type': 'application/json' };
    if (session.token) {
      // 令牌放在自定义头里。**不要改回只用 Authorization**：
      // 线上网关会给每个请求注入它自己的 Authorization，把我们的令牌覆盖掉，
      // 结果服务端永远认不出队员身份（表现为「登录状态已失效」）。
      // Authorization 同时带一份，供本地直连等没有网关的场景使用。
      headers['X-Session-Token'] = session.token;
      headers.Authorization = 'Bearer ' + session.token;
    }
    var init = { method: (options && options.method) || 'GET', headers: headers };
    if (options && options.body !== undefined) init.body = options.body;
    // keepalive：写请求带上它，队员点完确认立刻切走/关页面，请求也照样发得出去。
    // ⚠️ 但调用方必须先量体型：浏览器只允许 keepalive 的正文 ≤64KB（多个在飞
    // 请求共享这 64KB），超限会**直接拒发**而不是降级。判定见 flushNow 里的
    // KEEPALIVE_MAX_BYTES —— 大写入（如带着「删除记录」的删除）不要带它。
    if (options && options.keepalive) init.keepalive = true;

    return global.fetch(apiBase() + path, init).then(function (res) {
      return res.text().then(function (text) {
        var body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (err) {
          body = { ok: false, message: '服务端返回了看不懂的内容：' + text.slice(0, 200) };
        }
        if (!res.ok || body.ok === false) {
          // 401 = 服务端认不出这个令牌（多半是它重新部署过）。自动重新免登一次再重试，
          // 队员看不到任何异常；重登也失败才把错误抛出去。
          if (res.status === 401 && !isRetry) {
            return renewToken().then(function () {
              return api(path, options, true);
            }, function () {
              var expired = new Error(body.message || '登录状态已失效，请重新打开应用');
              expired.status = 401;
              throw expired;
            });
          }
          var error = new Error(body.message || ('服务端返回 ' + res.status));
          error.status = res.status;
          error.conflict = !!body.conflict;
          throw error;
        }
        return body;
      });
    }, function (err) {
      throw new Error('连不上服务器，请检查网络后重试（' + (err && err.message ? err.message : err) + '）');
    });
  }

  /** 登录完成后才允许访问数据；登录由 feishu-auth.js 负责 */
  function readyAuth() {
    var auth = global.FEVER && global.FEVER.Auth;
    if (!auth || !auth.ready) {
      return Promise.reject(new Error('登录模块没有加载，页面文件可能不完整'));
    }
    return auth.ready.then(function (user) {
      session.token = auth.token || '';
      session.user = user || null;
      return user;
    });
  }

  function applySequences(body) {
    if (!body || !body.sequences) return;
    STORES.forEach(function (name) {
      if (!AUTO_ID[name]) return;
      var seq = Number(body.sequences[name]);
      if (!isNaN(seq) && seq > 0) counters[name] = Math.max(counters[name] || 1, seq);
    });
  }

  function loadAll() {
    return api('/api/data').then(function (body) {
      var data = body.data || {};
      mirror = {};
      STORES.forEach(function (name) {
        mirror[name] = Array.isArray(data[name]) ? data[name] : [];
      });
      counters = {};
      STORES.forEach(function (name) {
        if (!AUTO_ID[name]) return;
        var seq = body.sequences ? Number(body.sequences[name]) : NaN;
        counters[name] = !isNaN(seq) && seq > 0 ? seq : maxId(name) + 1;
      });
      lastSyncedAt = Date.now();
      prewarmIds();   // 第二十八轮：顺手把记录号领一段，第一次写入不用等
      return null;
    });
  }

  function reload() {
    return loadAll();
  }

  /** 打开（首次会把全部数据拉下来）。接口与 v1/js/db.js 的 openDB 一致 */
  function openDB() {
    if (mirror) return Promise.resolve(null);
    if (opening) return opening;
    opening = readyAuth().then(function () {
      return loadAll();
    }).then(function () {
      opening = null;
      return null;
    }, function (err) {
      opening = null;
      throw err;
    });
    return opening;
  }

  /* ==================== 写入提交队列 ==================== */

  /**
   * 待提交的批次。每一项形如 { ops: [...], waiters: [...] }。
   * 为什么是「批次」而不是一个扁平数组：每个 runTx 是一次业务事务，
   * 里面可能有多张表的多条 op；一批要么全发要么全不发，语义不能串。
   */
  var chunks = [];
  var flushTimer = null;
  var firstQueuedAt = 0;
  var inFlight = 0;
  /** 正在飞行中的那批 op 条数，只用来给角标显示进度 */
  var inFlightOps = 0;
  /** 写失败后正在从服务器重拉数据（重拉期间不能算「已落定」） */
  var realigning = 0;
  var failedState = null;

  function pendingOps() {
    var n = inFlightOps;
    chunks.forEach(function (c) { n += c.ops.length; });
    return n;
  }

  function hasUncommitted() {
    return inFlight > 0 || realigning > 0 || chunks.length > 0 || !!flushTimer;
  }

  /**
   * 「所有改动都落定」的 Promise（成功或失败都算落定）。
   * 界面用不到它（界面根本不等），但测试和排查要用：
   * 想知道「现在服务器上的数据和界面上的是不是一致」，等它就对了。
   */
  var settleWaiters = [];

  function whenSettled() {
    if (!hasUncommitted()) return Promise.resolve();
    return new Promise(function (resolve) { settleWaiters.push(resolve); });
  }

  function drainSettleWaiters() {
    if (hasUncommitted()) return;
    var list = settleWaiters;
    settleWaiters = [];
    list.forEach(function (resolve) { resolve(); });
  }

  /** 清空/整体替换 = 破坏性大事务，必须等服务器确认 */
  function needsConfirm(ops) {
    if (CONFIG.strictWrites) return true;
    if (ops.length > NEEDS_CONFIRM_OPS) return true;
    for (var i = 0; i < ops.length; i += 1) {
      if (ops[i] && ops[i].type === 'clear') return true;
    }
    return false;
  }

  /**
   * 把一批 ops 放进待提交队列。
   * waitNeeded 为 true 时返回一个「服务器确认后才 settle」的 Promise；
   * 否则返回 null —— 调用方立刻把本地算出来的结果交给界面，写入在后台完成。
   */
  function enqueueChunk(ops, waitNeeded) {
    var chunk = { ops: ops, waiters: [] };
    chunks.push(chunk);
    if (!firstQueuedAt) firstQueuedAt = Date.now();
    scheduleFlush();
    updatePill();
    if (!waitNeeded) return null;
    return new Promise(function (resolve, reject) {
      chunk.waiters.push({ resolve: resolve, reject: reject });
    });
  }

  /**
   * 攒一小会儿再发。
   * 「先占编码、再落库」这两步之间只隔了几个微任务，所以都会被收进同一批，
   * 于是一次确认只发一个请求 —— 少一次网关往返、少一次飞书写入。
   */
  function scheduleFlush() {
    if (flushTimer || inFlight) return;
    if (!chunks.length) return;
    var waited = firstQueuedAt ? Date.now() - firstQueuedAt : 0;
    var delay = Math.max(0, Math.min(FLUSH_DELAY_MS, FLUSH_MAX_WAIT_MS - waited));
    flushTimer = global.setTimeout(function () {
      flushTimer = null;
      flushNow();
    }, delay);
  }

  /**
   * keepalive 请求的正文上限。
   *
   * 浏览器的规矩：带 keepalive 的请求正文**上限 64KB**，而且同一时刻在飞的
   * 多个 keepalive 请求**共享**这 64KB。超了不会"降级"，而是**整个请求被拒**
   * （TypeError: Failed to fetch）——界面看到的就是"连不上服务器，请检查网络后重试"。
   *
   * 这里取一半：一次大的加一次小的在飞，也不至于越过浏览器的红线。
   */
  var KEEPALIVE_MAX_BYTES = 32 * 1024;

  /**
   * 正文的 UTF-8 字节数。不能直接用 text.length —— 一个汉字在 JS 里算 1、
   * 在线上算 3 字节，拿 length 比会把明显超限的请求误判成"还能用 keepalive"。
   * TextEncoder 所有目标环境都有；兜底那条宁可算大（算大了只是不用 keepalive，
   * 不会因此失败）。
   */
  function payloadBytes(text) {
    try {
      if (global.TextEncoder) return new global.TextEncoder().encode(text).length;
      return encodeURIComponent(text).replace(/%[0-9A-Fa-f]{2}/g, '_').length;
    } catch (err) {
      return text.length * 3;
    }
  }

  function flushNow() {
    if (flushTimer) {
      global.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (inFlight || !chunks.length) return;

    var batch = chunks;
    chunks = [];
    firstQueuedAt = 0;

    var ops = [];
    var waiters = [];
    batch.forEach(function (c) {
      ops.push.apply(ops, c.ops);
      waiters.push.apply(waiters, c.waiters);
    });

    var payload = JSON.stringify({ ops: ops });
    // keepalive 只发给小请求。
    //
    // ⚠️ 为什么必须挑体型：浏览器给 keepalive 请求定了 64KB 的正文上限（多个
    // 在飞请求共享这 64KB），**超限不降级、直接拒发**，界面收到"连不上服务器"。
    // 删除物品就栽在这——它的写入带着「删除记录」，每票存一条整条物品快照，
    // 攒到一百多票时正文就过了 66KB，从那以后每次删除都必失败，物品删不掉。
    // 大请求改走普通 fetch：照样发得出去，代价只是"点完确认瞬间关页面"这一下
    // 可能被打断（那种请求本来就要等服务器确认，使用者也在看着屏幕）。
    var useKeepalive = payloadBytes(payload) <= KEEPALIVE_MAX_BYTES;

    inFlight += 1;
    inFlightOps += ops.length;
    updatePill();

    api('/api/write', {
      method: 'POST',
      body: payload,
      keepalive: useKeepalive
    }).then(function (body) {
      inFlight -= 1;
      inFlightOps -= ops.length;
      applySequences(body);
      lastSyncedAt = Date.now();
      failedState = null;
      // 回到「已同步」再淡出，让人知道刚才那一下确实落库了
      if (pillVisible()) markSynced();
      waiters.forEach(function (w) { w.resolve(body); });
      if (chunks.length) scheduleFlush();
      updatePill();
      drainSettleWaiters();
    }, function (err) {
      inFlight -= 1;
      inFlightOps -= ops.length;
      // 这一批没写进去。队列里还没发的那些是建立在它之上的（比如已经占掉的编码），
      // 一并丢掉；稍后从服务器重拉一份，手上这些就不成立了。
      var dropped = chunks.length;
      chunks = [];
      firstQueuedAt = 0;
      lastSyncedAt = 0;
      waiters.forEach(function (w) { w.reject(err); });
      handleWriteFailure(err, dropped, waiters.length > 0);
    });
  }

  /** 写入失败：如实告诉使用者，并把界面拉回服务器上的真实状态 */
  function handleWriteFailure(err, droppedChunks, reportedByCaller) {
    var reason = (err && err.message) ? err.message : String(err);
    var extra = droppedChunks ? '（另有 ' + droppedChunks + ' 处后续改动一并撤销）' : '';
    failedState = { message: reason + extra };
    pillSyncedAt = 0;
    realigning += 1;

    // 等服务器确认的那类大事务，调用方自己会把错误提示给使用者（界面有 catch），
    // 这里就不再重复弹一次。角标照常变红 —— 那是不该被忽略的持久信号。
    if (!reportedByCaller) {
      notify('保存失败：' + reason + extra + '　已从服务器重新拉取数据，请重新操作一次。', 'err');
    }

    reload().then(function () {
      realigning = 0;
      redraw();
      updatePill();
      drainSettleWaiters();
    }, function () {
      realigning = 0;
      failedState = { message: reason + '（而且没能重新拉取数据，请重新打开应用）' };
      updatePill();
      drainSettleWaiters();
    });
  }

  function notify(text, kind) {
    var UI = global.FEVER && global.FEVER.UI;
    if (UI && UI.toast) UI.toast(text, kind || 'err');
  }

  /** 重画当前页面。有弹窗挡着就不画，免得把正在填的表单冲掉 */
  function redraw() {
    if (!global.document) return;
    var modalRoot = global.document.querySelector('#modal-root');
    var busy = modalRoot && modalRoot.children && modalRoot.children.length > 0;
    if (busy) return;
    var App = global.FEVER && global.FEVER.App;
    if (App && App.refresh) App.refresh();
  }

  /* ==================== 同步状态角标 ==================== */

  /**
   * 左下角一个小角标，说明「刚才那一下到底落库了没有」。
   * 为什么需要它：界面不再等服务器，就必须有个地方如实交代后台的成败 ——
   * 否则「已保存」和「真的进了多维表格」之间就没有任何可见的凭据了。
   * 全部同步完会自动消失，不占地方。
   */
  var PILL_ID = 'fever-sync-pill';
  var pillHideTimer = null;
  var pillSyncedAt = 0;

  function pillElement() {
    if (!global.document || !global.document.body) return null;
    var node = global.document.getElementById(PILL_ID);
    if (node) return node;
    // 打印标签时不要把小角标一起打出来。这里注入一小段样式，
    // 而不是去改 v1 的 style.css（那个文件要保持一行不动）
    if (!global.document.getElementById(PILL_ID + '-style')) {
      var style = global.document.createElement('style');
      style.id = PILL_ID + '-style';
      style.textContent = '@media print{#' + PILL_ID + '{display:none !important}}';
      global.document.head.appendChild(style);
    }
    node = global.document.createElement('div');
    node.id = PILL_ID;
    node.setAttribute('style',
      'position:fixed;left:14px;bottom:14px;z-index:9998;display:none;' +
      'max-width:min(78vw,380px);padding:7px 13px;border-radius:999px;' +
      'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.16);user-select:none;transition:opacity .2s;pointer-events:none');
    node.addEventListener('click', function () {
      if (failedState) { failedState = null; updatePill(); }
    });
    global.document.body.appendChild(node);
    return node;
  }

  function pillVisible() {
    var node = global.document && global.document.getElementById(PILL_ID);
    return !!(node && node.style.display !== 'none');
  }

  function showPill(text, colors, title) {
    var node = pillElement();
    if (!node) return;
    if (pillHideTimer) { global.clearTimeout(pillHideTimer); pillHideTimer = null; }
    node.textContent = text;
    node.title = title || '';
    node.style.background = colors.bg;
    node.style.color = colors.fg;
    node.style.boxShadow = colors.ring ? ('0 0 0 1px ' + colors.ring + ', 0 6px 20px rgba(0,0,0,.16)') : '0 6px 20px rgba(0,0,0,.16)';
    node.style.cursor = colors.clickable ? 'pointer' : 'default';
    // 只有「可以点掉」的状态才接收鼠标，平时完全不挡底下的界面
    node.style.pointerEvents = colors.clickable ? 'auto' : 'none';
    node.style.display = 'block';
    node.style.opacity = '1';
  }

  function hidePillLater(delayMs) {
    if (pillHideTimer) global.clearTimeout(pillHideTimer);
    pillHideTimer = global.setTimeout(function () {
      pillHideTimer = null;
      var node = global.document && global.document.getElementById(PILL_ID);
      if (!node) return;
      if (hasUncommitted() || failedState) return;
      node.style.opacity = '0';
      pillHideTimer = global.setTimeout(function () {
        pillHideTimer = null;
        if (!hasUncommitted() && !failedState) node.style.display = 'none';
      }, 220);
    }, delayMs);
  }

  function markSynced() {
    pillSyncedAt = Date.now();
    showPill('已同步到飞书', { bg: '#eef7ee', fg: '#2b6b3f', ring: '#cfe6d4' }, '改动已经写进多维表格');
    hidePillLater(1400);
  }

  function updatePill() {
    if (failedState) {
      showPill('同步失败 · 点这里关掉', { bg: '#fdecec', fg: '#a4272b', ring: '#f3c9c9', clickable: true },
        failedState.message);
      return;
    }
    var n = pendingOps();
    if (n > 0) {
      showPill('同步中 · ' + n + ' 项', { bg: '#eef3ff', fg: '#2c4d99', ring: '#d3e0f7' },
        '正在写入多维表格，界面已经先更新了');
      return;
    }
    if (pillVisible() && Date.now() - pillSyncedAt > 1500) hidePillLater(400);
  }

  /* ==================== 事务 ==================== */

  /**
   * 在一个"事务"里执行若干操作。
   * 与 IndexedDB 版的区别：变更不是逐条落盘，而是等 fn 跑完后整批提交。
   * 好处是 fn 内部可以随意读到自己刚写进去的数据（镜像已经改了），
   * 这和 IndexedDB 同一事务内读写互相可见的行为是一样的。
   */
  function runTx(storeNames, mode, fn) {
    return openDB().then(function () {
      var names = Array.isArray(storeNames) ? storeNames : [storeNames];
      var writable = mode === 'readwrite';
      var ops = [];
      // 只拷贝这次事务会碰到的表，避免每次操作都复制整库
      var backup = {};
      if (writable) {
        names.forEach(function (name) {
          backup[name] = clone(list(name));
        });
      }

      function rollbackLocally() {
        Object.keys(backup).forEach(function (name) {
          mirror[name] = backup[name];
        });
      }

      var T = {
        get: function (store, key) {
          var index = indexOfKey(store, key);
          return Promise.resolve(index === -1 ? undefined : clone(list(store)[index]));
        },
        getAll: function (store) {
          return Promise.resolve(clone(list(store)));
        },
        getByIndex: function (store, index, value) {
          var field = (INDEX_FIELDS[store] || {})[index];
          if (!field) return Promise.resolve([]);
          return Promise.resolve(list(store).filter(function (row) {
            return row[field] === value;
          }).map(clone));
        },
        add: function (store, data) {
          var row = clone(data);
          // 自增 id 由服务端发（第二十八轮）：先从号池取一个，再定主键
          return ensureRowId(store, row).then(function () {
            var key = allocateKey(store, row);
            if (indexOfKey(store, key) !== -1) {
              var dup = new Error('已经有一条主键相同的记录：' + key);
              dup.name = 'ConstraintError';
              throw dup;
            }
            list(store).push(row);
            ops.push({ type: 'add', store: store, data: row });
            return AUTO_ID[store] ? Number(row.id) : key;
          });
        },
        put: function (store, data) {
          var row = clone(data);
          // put 一个不存在的键等于插入 —— 同样要先有 id
          return ensureRowId(store, row).then(function () {
            var key = allocateKey(store, row);
            var index = indexOfKey(store, key);
            if (index === -1) list(store).push(row);
            else list(store)[index] = row;
            ops.push({ type: 'put', store: store, data: row });
            return AUTO_ID[store] ? Number(row.id) : key;
          });
        },
        remove: function (store, key) {
          var index = indexOfKey(store, key);
          if (index !== -1) list(store).splice(index, 1);
          ops.push({ type: 'delete', store: store, key: String(key) });
          return Promise.resolve();
        },
        count: function (store) {
          return Promise.resolve(list(store).length);
        },
        clear: function (store) {
          mirror[store] = [];
          ops.push({ type: 'clear', store: store });
          return Promise.resolve();
        }
      };

      var result;
      try {
        result = fn(T);
      } catch (err) {
        if (writable) rollbackLocally();
        return Promise.reject(err);
      }

      return Promise.resolve(result).then(function (value) {
        if (!writable || !ops.length) {
          // 只读事务，或者这次没有任何实际写入（比如启动时检查大类是否齐全）
          return value;
        }

        var mustWait = needsConfirm(ops);
        var confirmed = enqueueChunk(ops, mustWait);

        // 常规写入：本地镜像已经是最终状态，界面要的数据都在手上，直接返回。
        // 真正落库在后台进行，成败由左下角角标和失败提示交代。
        if (!confirmed) return value;

        // 大事务（导入备份、清空）等服务器确认，失败了也不许界面显示成成功
        return confirmed.then(function () { return value; }, function (err) {
          rollbackLocally();
          throw err;
        });
      }, function (err) {
        if (writable) rollbackLocally();
        throw err;
      });
    });
  }

  /* ---------- 记录 id 也由服务端发（第二十八轮） ---------- */

  /**
   * id 号池：表名 → 一批已经领回来的记录号，逐次发放，用完再领。
   *
   * 为什么连 id 也要领：申请号 / 发票号 / 流水号原来是**本机计数器**分配的
   * （见下面 allocateKey 里的 counters），而**每次添加物品都会写一条入库流水** ——
   * 两个人同时添加，几乎必然分到同一个流水 id，服务端只能 409 拒绝
   * （「编号 N 已被占用」）。上一轮只把物品编码改成服务端发号，漏了 id 这一半。
   *
   * 段大小取 5（不是编码那边的 20）：记录号是**显示给使用者看的**（申请 #12），
   * 一次领 20 个会让号一下跳过一大段，看着奇怪；5 个只跳几个，代价可接受。
   * 池子同样放内存：同设备两个标签页共用 localStorage 会从同一段取号。
   */
  var ID_RESERVE_CHUNK = 10;
  /** 池里少于这么多就顺手补满（补是后台的，不挡使用者操作） */
  var ID_POOL_LOW = 3;
  /** 补池节流：距上次补不足这么久就不再补（死循环的最后一道闸） */
  var ID_FILL_COOLDOWN = 30000;
  var idPool = {};
  /** 正在领号的 Promise（同一张表别重复领） */
  var idFilling = {};
  /** 每张表上次领号的时间（用于节流） */
  var idFilledAt = {};

/** 号池里这个号是不是已经被本地镜像里的记录占了 */
  function idTaken(store, id) {
    return list(store).some(function (r) { return Number(r.id) === Number(id); });
  }

  /**
   * 补池的**节流**：距上次补不足 ID_FILL_COOLDOWN 毫秒就不再补。
   *
   * ⚠️ 这一条是"死循环"的最后一道闸：只要出现过"领来的号全被占用"，
   * 没有节流就会变成"取号 → 发现池空 → 补池 → 号又被占用 → 再补……"
   * 每一步都是一次 HTTP 请求，单人操作也会被拖垮。
   */
  function scheduleFill(store) {
    var now = Date.now();
    if (idFilledAt[store] && now - idFilledAt[store] < ID_FILL_COOLDOWN) return;
    idFilledAt[store] = now;
    fillIdPool(store).catch(function () { /* 补池失败不影响主流程 */ });
  }

  /** 真去服务端领一段号 —— **全文件只有这一处**发领号请求 */
  function fetchIds(store, count) {
    if (idFilling[store]) return idFilling[store];   // 同一张表别重复领
    idFilling[store] = api('/api/reserve-ids', {
      method: 'POST',
      body: JSON.stringify({ store: store, count: Math.max(count, ID_RESERVE_CHUNK) })
    }).then(function (body) {
      var ids = (body && body.ids) || [];
      if (!ids.length) throw new Error('服务端没有发下来编号，请重试');
      return ids;
    }).then(function (ids) {
      delete idFilling[store];
      return ids;
    }, function (err) {
      delete idFilling[store];
      throw err;
    });
    return idFilling[store];
  }

  /**
   * 取 count 个号。
   *
   * 池里有就从池里取（**零网络**）；池空时**最多领一次**。
   *
   * ⚠️ 三个必须守住的地方（第二十九轮各踩一个）：
   *   ① **不递归**。领来的号若已被本地占用就丢掉，剩下的不够也**不再领**——
   *      上一轮写成 `return takeIds(store, count)`，一旦池里的号与本地镜像重叠
   *      （改之前本机计数器造出来的老数据就是这样），就会无限递归、无限发请求。
   *   ② **过滤只在领号时做一次**，不是每次取号都做（否则每步都扫全表，
   *      而且会出现"取走一个、发现下一个也被占"的连锁）。
   *   ③ **补池要节流**（scheduleFill），不给死循环留出口。
   */
  function takeIds(store, count) {
    var n = Math.max(1, count || 1);
    var pool = idPool[store] || [];
    if (pool.length) {
      var out = pool.slice(0, n);
      idPool[store] = pool.slice(n);
      if (idPool[store].length < ID_POOL_LOW) scheduleFill(store);
      return Promise.resolve(out);
    }
    return fetchIds(store, n).then(function (ids) {
      var usable = ids.filter(function (id) { return !idTaken(store, id); });
      if (!usable.length) throw new Error('服务端发下来的编号已被占用，请点左下角同步一次');
      idPool[store] = usable.slice(n);
      if (idPool[store].length < ID_POOL_LOW) scheduleFill(store);
      return usable.slice(0, n);
    });
  }

  /** 自增表的记录还没有编号 → 从号池取一个（池空时会触发一次领号） */
  function ensureRowId(store, row) {
    if (!AUTO_ID[store]) return Promise.resolve();
    var id = Number(row && row.id);
    if (!isNaN(id) && id > 0) return Promise.resolve();
    return takeIds(store, 1).then(function (ids) { row.id = ids[0]; });
  }

  /** 把某张表的号池补满（**纯补充，不消费**） */
  function fillIdPool(store) {
    if ((idPool[store] || []).length >= ID_POOL_LOW) return Promise.resolve();
    return fetchIds(store, ID_RESERVE_CHUNK).then(function (ids) {
      var fresh = ids.filter(function (id) { return !idTaken(store, id); });
      if (fresh.length) idPool[store] = (idPool[store] || []).concat(fresh);
    });
  }

  /** 预热：三张自增表的号池不够就补（失败静默，真到写入时还会再领一次） */
  function prewarmIds() {
    Object.keys(AUTO_ID).forEach(function (name) { scheduleFill(name); });
  }
  /** 给一条新记录定主键。自增表的 id 上面已经领好了；下面的兜底只在极少数
   *  没走 add/put 的路径上才会用到（正常路径不会再自己造号）。 */
  function allocateKey(store, row) {
    var name = KEY_PATH[store];
    if (AUTO_ID[store]) {
      var id = Number(row.id);
      if (!id || isNaN(id) || id <= 0) {
        id = counters[store] || (maxId(store) + 1);
        counters[store] = id + 1;
        row.id = id;
      } else if (id >= (counters[store] || 0)) {
        counters[store] = id + 1;
      }
      return id;
    }
    return keyOfRow(store, row);
  }

  /* ==================== 单条便捷方法（与 db.js 同名同义） ==================== */

  function dbAdd(storeName, data) {
    return runTx(storeName, 'readwrite', function (T) { return T.add(storeName, data); });
  }

  function dbPut(storeName, data) {
    return runTx(storeName, 'readwrite', function (T) { return T.put(storeName, data); });
  }

  function dbGet(storeName, key) {
    return runTx(storeName, 'readonly', function (T) { return T.get(storeName, key); })
      .then(function (row) { return row; });
  }

  function dbGetAll(storeName) {
    return runTx(storeName, 'readonly', function (T) { return T.getAll(storeName); });
  }

  function dbGetByIndex(storeName, indexName, value) {
    return runTx(storeName, 'readonly', function (T) { return T.getByIndex(storeName, indexName, value); });
  }

  function dbDelete(storeName, key) {
    return runTx(storeName, 'readwrite', function (T) { return T.remove(storeName, key); });
  }

  function dbCount(storeName) {
    return runTx(storeName, 'readonly', function (T) { return T.count(storeName); });
  }

  /* ==================== 编码发放（第二十六轮） ==================== */

  /**
   * 编码号池：一次向服务端领一段，逐次发放，用完再领。
   *
   * 为什么改成这样：原来前端各自在本机算号（读本地镜像里的计数器），
   * 两个人同时添加物品时都会算出 MC-0007 —— 服务端只能拒掉后一个（409），
   * 界面弹"编号已被占用…请重新操作一次"并重拉全量数据（线上约 1.4 秒）。
   * 使用者感受到的就是「编号被占用 + 卡一下 + 得重来一遍」。
   *
   * 现在号由**服务端**发（它所有写都过一条串行队列，两个请求不可能拿到同一段），
   * 前端一次领一段存着用：正常添加入库**完全不碰网络**，也不会再撞号。
   *
   * 代价：编码**会跳号**（这段没用完就作废，下次从下一段接着发）。
   * 编码只是标识，跳号不影响扫码、统计与标签。
   *
   * 池子放**内存**、不放 localStorage：同一台设备开两个标签页时，
   * 共用一份 localStorage 会让两个页面从同一段里号 —— 那正是要避免的事。
   */
  var RESERVE_CHUNK = 20;
  var codePool = {};

  /** 池子空了就去服务端领一段（至少够这次要的） */
  function refillCodes(prefix, need) {
    var want = Math.max(need, RESERVE_CHUNK);
    return api('/api/reserve-codes', {
      method: 'POST',
      body: JSON.stringify({ prefix: prefix, count: want })
    }).then(function (body) {
      var codes = (body && body.codes) || [];
      if (!codes.length) throw new Error('服务端没有发下来编码，请重试');
      codePool[prefix] = codes.slice();
      return codes.length;
    });
  }

  /**
   * 取 count 个连号：池子里够就直接发（0 等待），不够就领一段再发。
   * 领号失败**照实抛错** —— 宁可不入库，也绝不瞎编一个号（那必然撞）。
   */
  function nextCodes(prefix, count) {
    var pre = String(prefix || 'IT');
    var n = Math.max(1, Number(count) || 1);
    var pool = codePool[pre] || [];
    if (pool.length >= n) {
      codePool[pre] = pool.slice(n);
      return Promise.resolve(pool.slice(0, n));
    }
    return refillCodes(pre, n).then(function () { return nextCodes(pre, n); });
  }


  function getSetting(key, fallback) {
    return dbGet('settings', key).then(function (row) {
      return row ? row.value : (fallback === undefined ? null : fallback);
    });
  }

  function setSetting(key, value) {
    return dbPut('settings', { key: key, value: value, updatedAt: nowIso() });
  }

  /* ==================== 发票 PDF（第十三轮） ==================== */

  /**
   * 保存发票附件。**与离线版 db.js 的同名方法接口一致** ——
   * 区别只在实现：飞书版先把 PDF 传到服务器（server/uploads/），
   * 发票行里只放 fileRef 引用。多维表格的文本格放不下整份 PDF，
   * 而表结构不能动，所以文件本体必须放服务端。
   *
   * file 为 null（没传 PDF）时返回一组空引用，调用方照常展开。
   */
  function saveInvoiceFile(file) {
    if (!file) {
      return Promise.resolve({ fileRef: '', fileData: '', fileName: '', fileSize: 0, fileMime: '' });
    }
    return api('/api/upload', {
      method: 'POST',
      // 正文走 JSON（与 api() 的 401 自动重登共用同一条路），base64 由服务端还原成 PDF
      body: JSON.stringify({ name: file.name, mime: file.mime || 'application/pdf', base64: file.base64 })
    }).then(function (res) {
      if (!res || !res.fileRef) throw new Error('服务器没有返回发票文件的引用');
      return {
        fileRef: res.fileRef,
        fileData: '',
        fileName: file.name,
        fileSize: file.size || Math.floor(file.base64.length * 3 / 4),
        fileMime: file.mime || 'application/pdf'
      };
    });
  }

  /**
   * 取一张发票的 PDF 本体。没有附件时 resolve null。
   * 文件在服务器上：带令牌 GET /api/file/<ref>，二进制转回 base64 给界面。
   * 下载不走 api() —— 它会把响应当 JSON 解析，而这里是 PDF 二进制。
   */
  function loadInvoiceFile(invoice) {
    if (!invoice || !invoice.fileRef) return Promise.resolve(null);
    var headers = {};
    if (session.token) {
      // 与 api() 同一个规矩：自定义头优先，网关会覆盖 Authorization
      headers['X-Session-Token'] = session.token;
      headers.Authorization = 'Bearer ' + session.token;
    }
    return global.fetch(apiBase() + '/api/file/' + encodeURIComponent(invoice.fileRef), { headers: headers })
      .then(function (res) {
        if (!res.ok) throw new Error('取不到发票文件（服务端返回 ' + res.status + '）');
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new global.FileReader();
          reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
          reader.onerror = function () { reject(new Error('发票文件读不出来')); };
          reader.readAsDataURL(blob);
        });
      })
      .then(function (base64) {
        return {
          base64: base64,
          fileName: invoice.fileName || '发票.pdf',
          mime: invoice.fileMime || 'application/pdf'
        };
      });
  }

  /* ==================== 多人协作：切回页面时自动对齐 ==================== */

  /**
   * 队友刚登记完的东西，你这边需要重新拉一次才看得到。
   * 这里在页面重新获得焦点时自动对齐。
   *
   * 注意：**本地还有没落库的改动时绝不能重拉** —— 服务器上还没有那些数据，
   * 拉回来会把使用者刚登记的东西从界面上抹掉。所以先让写入队列清空。
   */
  function startAutoSync() {
    if (!global.document || !global.document.addEventListener) return;
    var MIN_INTERVAL = 15000;

    function maybeSync() {
      if (!mirror) return;
      if (global.document.visibilityState === 'hidden') return;
      if (hasUncommitted()) return;
      if (Date.now() - lastSyncedAt < MIN_INTERVAL) return;
      loadAll().then(function () {
        redraw();
      }).catch(function () { /* 网络抖动就跳过，下次再同步 */ });
    }

    global.document.addEventListener('visibilitychange', maybeSync);
    global.addEventListener('focus', maybeSync);

    // 页面要被关掉/切走：把还没发出去的改动立刻发出去。
    // 请求带 keepalive，所以即使页面正在卸载，它也能发完。
    global.addEventListener('pagehide', function () { flushNow(); });
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'hidden') flushNow();
    });
  }

  /* ==================== 导出 ==================== */

  global.FEVER = global.FEVER || {};
  global.FEVER.DB = {
    DB_NAME: 'FEVER_INV_V1',
    DB_VERSION: 1,
    FORMAT_VERSION: FORMAT_VERSION,
    STORES: STORES,
    nowIso: nowIso,
    openDB: openDB,
    runTx: runTx,
    add: dbAdd,
    put: dbPut,
    get: dbGet,
    getAll: dbGetAll,
    getByIndex: dbGetByIndex,
    remove: dbDelete,
    count: dbCount,
    nextCodes: nextCodes,
    getSetting: getSetting,
    setSetting: setSetting,
    /**
     * 当前使用者是不是管理员。
     * 身份来自服务端（登录时、以及恢复会话时都会取回），队员改不了 —— 页面上连
     * 自己的姓名都是飞书给的。注意它**只决定审批按钮画不画**；真按下去能不能成，
     * 由服务端 applyOps 强制校验，改前端代码绕不过去。
     */
    isAdmin: function () { return !!(session.user && session.user.isAdmin); },
    saveInvoiceFile: saveInvoiceFile,
    loadInvoiceFile: loadInvoiceFile,
    /**
     * 发送测试提醒（与离线版 db.js 同名同义 —— 接口必须一一对应）。
     * 服务端会真发一条私聊给当前登录的人，并把飞书的原始结果返回；
     * 配了群机器人时管理员还能顺带测群通道。设置页的「发送测试提醒」按钮用它。
     */
    notifyTest: function () {
      return api('/api/notify-test', { method: 'POST' });
    },
    /**
     * 提醒申请人补发票（第十五轮）。服务端拿姓名去登录名单里认 openId，
     * **认不出来的会如实回报**（results 里 sent:false / reason:'not_found'）——
     * 界面要照着说"某某还没登录过应用，提醒发不出去"，不能一概显示"已提醒"。
     */
    notifyInvoice: function (names, batchId) {
      return api('/api/notify-invoice', {
        method: 'POST',
        body: JSON.stringify({ names: names || [], batchId: batchId || '' })
      });
    },
    /* 飞书共享版特有的能力，界面不用，但排查问题时有用 */
    reload: reload,
    syncNow: function () { return loadAll(); },
    currentUser: function () { return session.user; },
    backendBase: apiBase,
    /** 还有多少条改动没落库（0 表示服务器和界面已经一致） */
    pendingOps: pendingOps,
    /** 立刻把待提交队列发出去（调试用；正常情况不用手动调） */
    flushNow: flushNow,
    /** 等所有改动落定（成功或失败都算）。仅测试与排查用 */
    whenSettled: whenSettled
  };

  startAutoSync();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.DB;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
