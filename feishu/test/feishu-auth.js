/**
 * 飞书登录层（js/feishu-auth.js）的回归测试。
 *
 * 这个测试不联网、也不开浏览器：它用 vm 把真正的 feishu-auth.js
 * 放进一个假的 window 里跑，只提供它真正用到的那几个东西
 * （document 的一小撮方法、sessionStorage、fetch、飞书 JSSDK 的 tt）。
 *
 * 为什么专门给它写测试：登录层只在飞书客户端里才跑得起来，
 * 本地和 CI 都摸不到，所以它的缺陷**只有上线后才暴露**。
 * 真实发生过的一次：postJson 发 /api/me 时不带会话令牌，
 * 于是每次打开应用都白跑一个必定 401 的请求，然后丢掉明明有效的令牌、
 * 退回一次完整的飞书免登（用户看到的是「又要重新授权」）。
 * 下面 [1] 就是钉住这一条的。
 *
 * 运行：node feishu/test/feishu-auth.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = process.env.FEVER_AUTH_SRC
  ? path.resolve(process.env.FEVER_AUTH_SRC)
  : path.join(__dirname, '..', 'js', 'feishu-auth.js');
const CODE = fs.readFileSync(SOURCE, 'utf8');
const TOKEN_KEY = 'fever_inv_session_token';

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

/* ==================== 假环境 ==================== */

/**
 * 一小撮够用的假 DOM。
 * feishu-auth.js 只用到：getElementById、createElement、body.appendChild、
 * 直接给 .id 赋值、以及 innerHTML / style.display。真实 DOM 里
 * innerHTML 里写的 id 随后能被 getElementById 查到，这里用正则扫出来模拟。
 */
function createFakeDom() {
  const registry = new Map();

  function makeEl(tag) {
    const node = {
      tagName: tag,
      style: {},
      _html: '',
      parentNode: null,
      children: [],
      addEventListener: function () {},
      setAttribute: function (name, value) { if (name === 'id') this.id = value; },
      appendChild: function (child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      }
    };
    let id = '';
    Object.defineProperty(node, 'id', {
      get: function () { return id; },
      set: function (value) { id = String(value); registry.set(id, node); }
    });
    Object.defineProperty(node, 'innerHTML', {
      get: function () { return node._html; },
      set: function (value) {
        node._html = String(value);
        const re = /id="([^"]+)"/g;
        let m;
        while ((m = re.exec(node._html))) {
          if (!registry.has(m[1])) registry.set(m[1], makeEl('div'));
        }
      }
    });
    return node;
  }

  const body = makeEl('body');
  const document = {
    readyState: 'complete',
    body: body,
    createElement: function (tag) { return makeEl(tag); },
    getElementById: function (id) { return registry.get(id) || null; },
    addEventListener: function () {}
  };
  return { document: document, registry: registry };
}

function createSessionStorage(initial) {
  const box = new Map(Object.entries(initial || {}));
  return {
    box: box,
    getItem: function (k) { return box.has(k) ? box.get(k) : null; },
    setItem: function (k, v) { box.set(k, String(v)); },
    removeItem: function (k) { box.delete(k); }
  };
}

/** 假的 fetch：按路径给回包，并把每次请求（连同请求头）记下来供断言 */
function createFetch(routes) {
  const calls = [];
  const fetchMock = function (url, init) {
    const target = String(url);
    const headers = (init && init.headers) || {};
    const entry = { path: target, headers: headers, method: (init && init.method) || 'GET' };
    try {
      entry.body = init && init.body ? JSON.parse(init.body) : null;
    } catch (err) {
      entry.body = init ? init.body : null;
    }
    calls.push(entry);

    const route = routes[target];
    if (!route) {
      return Promise.reject(new Error('假后端没有为 ' + target + ' 配好回包'));
    }
    if (route instanceof Error) return Promise.reject(route);

    return Promise.resolve().then(function () {
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        text: function () { return Promise.resolve(route.text); }
      };
    });
  };
  fetchMock.calls = calls;
  fetchMock.to = function (p) { return calls.filter(function (c) { return c.path === p; }); };
  return fetchMock;
}

/**
 * 把 feishu-auth.js 放进假环境里跑一次。
 * options.inFeishu 给一个授权码生成函数；不传就当作「不在飞书里打开」。
 */
function boot(options) {
  const dom = createFakeDom();
  const storage = createSessionStorage(options.tokens);
  const fetchMock = createFetch(options.routes);

  // waitForBridge 会在「没有 tt」时轮询 3 秒。真实计时太慢，
  // 这里让每次轮询都把沙箱里的时钟往前推 5 秒，逻辑上立刻超时。
  const clock = { now: 0 };
  function SandboxDate() { return new Date(); }
  SandboxDate.now = function () { return clock.now; };

  const sandbox = {
    console: console,
    document: dom.document,
    sessionStorage: storage,
    location: { reload: function () {} },
    fetch: fetchMock,
    Date: SandboxDate,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    clearInterval: clearInterval,
    setInterval: function (fn) {
      return setInterval(function () { clock.now += 5000; fn(); }, 5);
    },
    Promise: Promise,
    JSON: JSON,
    Math: Math,
    Error: Error,
    FEVER_CONFIG: { appId: 'cli_test_app', apiBase: '' }
  };
  sandbox.globalThis = sandbox;

  if (options.inFeishu) {
    sandbox.tt = {
      requestAccess: function (opts) {
        Promise.resolve().then(function () { opts.success({ code: options.inFeishu }); });
      }
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: SOURCE });

  const auth = sandbox.FEVER.Auth;
  return {
    auth: auth,
    dom: dom,
    storage: storage,
    fetch: fetchMock,
    gateMessage: function () {
      const node = dom.registry.get('feishu-gate-message');
      return node ? node.innerHTML : '';
    },
    settle: function () {
      return auth.ready.then(
        function (user) { return { ok: true, user: user }; },
        function (err) { return { ok: false, error: err }; }
      );
    }
  };
}

function okJson(payload) { return { status: 200, text: JSON.stringify(payload) }; }
function errJson(status, payload) { return { status: status, text: JSON.stringify(payload) }; }

/* ==================== 用例 ==================== */

console.log('');
console.log('飞书登录层 · 端到端测试');
console.log('');

(async function () {

  /* ---------- [1] 带缓存令牌打开：/api/me 必须带上令牌 ---------- */
  console.log('[1] 同一次会话里再打开（本地有令牌）—— 必须拿它去问服务端');
  {
    const env = boot({
      tokens: { [TOKEN_KEY]: 'CACHED.SIGNED.TOKEN' },
      routes: {
        '/api/me': okJson({ ok: true, user: { name: '张三' } })
      }
    });
    const result = await env.settle();
    const me = env.fetch.to('/api/me');

    equal('只问了 /api/me 一次', me.length, 1);
    equal('没有去走免登', env.fetch.to('/api/login').length, 0);
    check('这次回归的核心：/api/me 带上了 X-Session-Token',
      me[0] && me[0].headers['X-Session-Token'] === 'CACHED.SIGNED.TOKEN',
      me[0] && me[0].headers['X-Session-Token']);
    check('同时也带了 Authorization（网关会覆盖它，但本地调试用得上）',
      me[0] && me[0].headers.Authorization === 'Bearer CACHED.SIGNED.TOKEN',
      me[0] && me[0].headers.Authorization);
    check('登录直接成功，没有闪一下授权页', result.ok === true, result.error && result.error.message);
    equal('拿回来的就是缓存的这个人', result.user && result.user.name, '张三');
    equal('有效令牌被保留', env.storage.box.get(TOKEN_KEY), 'CACHED.SIGNED.TOKEN');
  }
  console.log('');

  /* ---------- [2] 缓存令牌已失效：丢掉它，自动退回免登 ---------- */
  console.log('[2] 缓存令牌被服务端拒了 —— 应无感退回免登，并把新令牌存下来');
  {
    const env = boot({
      tokens: { [TOKEN_KEY]: 'STALE.TOKEN' },
      inFeishu: 'AUTH_CODE_FRESH',
      routes: {
        '/api/me': errJson(401, { ok: false, message: '登录状态已失效，请重新打开应用' }),
        '/api/login': okJson({ ok: true, token: 'BRAND.NEW.TOKEN', user: { name: '李四' } })
      }
    });
    const result = await env.settle();
    const me = env.fetch.to('/api/me');
    const login = env.fetch.to('/api/login');

    equal('先问了一次 /api/me', me.length, 1);
    check('问 /api/me 时带上了那个待验证的旧令牌（服务端才有得判）',
      me[0] && me[0].headers['X-Session-Token'] === 'STALE.TOKEN',
      me[0] && me[0].headers['X-Session-Token']);
    equal('随后走了免登', login.length, 1);
    equal('免登带上了飞书给的授权码', login[0] && login[0].body && login[0].body.code, 'AUTH_CODE_FRESH');
    check('免登请求本身不该再带旧令牌', !(login[0] && login[0].headers['X-Session-Token']),
      login[0] && login[0].headers['X-Session-Token']);
    equal('新令牌被存进了会话', env.storage.box.get(TOKEN_KEY), 'BRAND.NEW.TOKEN');
    equal('数据层能拿到新令牌', env.auth.token, 'BRAND.NEW.TOKEN');
    equal('用户是刚换回来的这位', result.user && result.user.name, '李四');
  }
  console.log('');

  /* ---------- [3] 没有缓存令牌：直接免登，别白问一次 /api/me ---------- */
  console.log('[3] 全新会话（本地没有令牌）—— 直接免登，不多打一次接口');
  {
    const env = boot({
      tokens: {},
      inFeishu: 'FIRST_CODE',
      routes: {
        '/api/login': okJson({ ok: true, token: 'T1', user: { name: '王五' } })
      }
    });
    const result = await env.settle();

    equal('没有去问 /api/me', env.fetch.to('/api/me').length, 0);
    equal('直接免登一次', env.fetch.to('/api/login').length, 1);
    equal('令牌已保存', env.storage.box.get(TOKEN_KEY), 'T1');
    equal('用户正确', result.user && result.user.name, '王五');
  }
  console.log('');

  /* ---------- [4] 不在飞书里打开：给一句看得懂的话 ---------- */
  console.log('[4] 直接在浏览器里打开 —— 提示「请在飞书里打开」，而不是白屏');
  {
    const env = boot({ tokens: {}, routes: {} });
    const result = await env.settle();
    const message = env.gateMessage();

    check('登录以 NOT_IN_FEISHU 失败', result.ok === false && result.error && result.error.code === 'NOT_IN_FEISHU',
      result.error && (result.error.code || result.error.message));
    check('界面明确说了请在飞书里打开', /请在飞书里打开这个应用/.test(message), message.slice(0, 90));
    check('并且告诉了用户从哪进', /飞书工作台/.test(message));
    equal('这种情形一个接口都不用打', env.fetch.calls.length, 0);
  }
  console.log('');

  /* ---------- [5] 服务端说令牌过期：renew() 强制重登 ---------- */
  console.log('[5] 数据层收到 401 后调 renew() —— 丢掉旧令牌，重新走一次免登');
  {
    const env = boot({
      tokens: { [TOKEN_KEY]: 'OLD.TOKEN' },
      inFeishu: 'RENEW_CODE',
      routes: {
        '/api/me': okJson({ ok: true, user: { name: '赵六' } }),
        '/api/login': okJson({ ok: true, token: 'RENEWED.TOKEN', user: { name: '赵六' } })
      }
    });
    await env.settle();
    equal('第一次是拿缓存的令牌进的', env.storage.box.get(TOKEN_KEY), 'OLD.TOKEN');

    const user = await env.auth.renew();
    const login = env.fetch.to('/api/login');

    equal('renew 触发了一次免登', login.length, 1);
    check('重登请求不带已经作废的旧令牌', !(login[0] && login[0].headers['X-Session-Token']),
      login[0] && login[0].headers['X-Session-Token']);
    equal('本地令牌换成了新的', env.storage.box.get(TOKEN_KEY), 'RENEWED.TOKEN');
    equal('对外暴露的令牌也是新的', env.auth.token, 'RENEWED.TOKEN');
    equal('重登后拿到的还是这个人', user && user.name, '赵六');
  }
  console.log('');

  /* ---------- [6] 网络不通：说人话，别白屏 ---------- */
  console.log('[6] 完全连不上服务器 —— 提示检查网络');
  {
    const env = boot({
      tokens: { [TOKEN_KEY]: 'ANY' },
      inFeishu: 'CODE',
      routes: {
        '/api/me': new Error('socket hang up'),
        '/api/login': new Error('socket hang up')
      }
    });
    const result = await env.settle();
    const message = env.gateMessage();

    check('登录失败给了可读原因', result.ok === false && !!result.error);
    check('提示里说了检查网络', /连不上服务器，请检查网络/.test(message), message.slice(0, 120));
    check('人话在前，原始异常只缩在括号里当线索', /\(socket hang up\)|（socket hang up）/.test(message));
    check('界面不会只剩一句英文异常', !/^<b>没能进入系统<\/b><br><span[^>]*>socket hang up<\/span>$/.test(message));
  }
  console.log('');

  /* ---------- [7] 服务端返回非 JSON：也要给一句人话 ---------- */
  console.log('[7] 服务端回了一段看不懂的内容（例如网关的 HTML 错误页）');
  {
    const env = boot({
      tokens: { [TOKEN_KEY]: 'ANY' },
      inFeishu: 'CODE2',
      routes: {
        '/api/me': { status: 200, text: '<html>502 Bad Gateway</html>' },
        '/api/login': okJson({ ok: true, token: 'AFTER.BAD', user: { name: '孙七' } })
      }
    });
    const result = await env.settle();

    equal('/api/me 的乱码让流程退回免登', env.fetch.to('/api/login').length, 1);
    equal('免登后照常进入系统', result.user && result.user.name, '孙七');
    check('界面没有被 HTML 片段污染成一张错误页',
      !/502 Bad Gateway/.test(env.gateMessage()), env.gateMessage().slice(0, 120));
  }
  console.log('');

  console.log('==================================================');
  console.log('结果：' + passed + ' 项通过，' + failed + ' 项失败');
  console.log('==================================================');
  process.exit(failed === 0 ? 0 : 1);

})().catch(function (err) {
  console.error('测试自身崩了：', err);
  process.exit(1);
});
