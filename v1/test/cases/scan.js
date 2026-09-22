/**
 * 扫码（第二版手机端）。
 *
 * 扫到码本身不难，容易出错的是**调度**：
 *   · 该按什么顺序试各个来源（飞书原生 > 摄像头 > …）
 *   · 某个来源失败（没给相机权限）之后，要不要继续试下一个
 *   · 用户主动取消之后，**绝对不能**再弹下一个来源的界面
 *     （点了取消又冒出摄像头，像个甩不掉的弹窗，是很糟的体验）
 *   · 一个来源都没有时，要给一句人话，而不是抛个 undefined
 * 这一组就盯这几条。真正开摄像头/调飞书的代码没法在 Node 里跑，
 * 所以这里用假的来源把调度逻辑单独拎出来测。
 */
'use strict';

const Scanner = require('../../js/scanner.js');

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual } = H;

  /**
   * 造一个可控的假扫码来源。
   * 计数必须**包在**最终那个 scan 外面 —— 写在默认的 scan 里的话，
   * 一旦用 over 换掉 scan，计数就永远是 0，断言会以"没被调用过"的假象失败。
   */
  function fake(over) {
    const calls = { count: 0 };
    const source = Object.assign({
      name: 'fake-' + Math.random().toString(36).slice(2, 8),
      label: '假来源',
      priority: 0,
      available: function () { return true; },
      scan: function () { return Promise.resolve('SCANNED'); }
    }, over);
    const inner = source.scan;
    source.scan = function () {
      calls.count += 1;
      return inner.apply(null, arguments);
    };
    return { source: source, calls: calls };
  }

  /** 让扫描肯定失败（模拟"没给相机权限"） */
  function failing(over) {
    return fake(Object.assign({
      scan: function () { return Promise.reject(new Error('没给权限')); }
    }, over));
  }

  function cancelled(over) {
    return fake(Object.assign({
      scan: function () {
        const err = new Error('已取消扫码');
        err.cancelled = true;
        return Promise.reject(err);
      }
    }, over));
  }

  /* ================= 注册表本身 ================= */

  test('扫码来源必须提供 available() 和 scan()，也要有名字', async () => {
    const reg = Scanner.create();
    let msg = '';
    try { reg.register({ name: 'x', available: () => true }); } catch (e) { msg = e.message; }
    assert(msg.indexOf('scan') !== -1, '缺 scan 应当报错，实际：' + msg);

    msg = '';
    try { reg.register({ name: 'x', scan: () => Promise.resolve('a') }); } catch (e) { msg = e.message; }
    assert(msg.indexOf('available') !== -1, '缺 available 应当报错，实际：' + msg);

    msg = '';
    try { reg.register({ available: () => true, scan: () => Promise.resolve('a') }); } catch (e) { msg = e.message; }
    assert(msg.indexOf('name') !== -1, '缺 name 应当报错，实际：' + msg);
  });

  test('同名来源是替换而不是叠加（飞书 tt 异步注入时会注册两次）', async () => {
    const reg = Scanner.create();
    reg.register({ name: 'dup', available: () => true, scan: () => Promise.resolve('a') });
    reg.register({ name: 'dup', available: () => true, scan: () => Promise.resolve('b') });
    const list = reg.available();
    assertEqual(list.length, 1, '同名来源只应留一个，实际 ' + list.length + ' 个');
    assertEqual(await reg.scan(), 'b', '应当留下后注册的那个');
  });

  test('available() 为假的来源不参与；available() 自己抛错也当作不可用', async () => {
    const reg = Scanner.create();
    reg.register({ name: 'no', available: () => false, scan: () => Promise.resolve('不该被调用') });
    reg.register({ name: 'boom', available: () => { throw new Error('探测就炸了'); }, scan: () => Promise.resolve('也不该被调用') });
    assertEqual(reg.available().length, 0, '两个都不该算可用');

    // 一个探测就抛错的来源，不能把整个扫码拖挂
    reg.register({ name: 'ok', available: () => true, scan: () => Promise.resolve('好使') });
    assertEqual(await reg.scan(), '好使');
  });

  test('create() 造出来的注册表互相独立', async () => {
    const a = Scanner.create();
    const b = Scanner.create();
    a.register({ name: 'only-a', available: () => true, scan: () => Promise.resolve('a') });
    assertEqual(a.available().length, 1);
    assertEqual(b.available().length, 0, 'b 不该看到 a 注册的来源');
    // 默认那份也不该被污染
    assertEqual(Scanner.available().length, 0, '默认注册表在 Node 环境里应当没有可用来源');
  });

  /* ================= 调度 ================= */

  test('按 priority 从高到低试，用第一个能出结果的', async () => {
    const reg = Scanner.create();
    const low = fake({ name: 'low', priority: 1, scan: () => Promise.resolve('低') });
    const high = fake({ name: 'high', priority: 100, scan: () => Promise.resolve('高') });
    reg.register(low.source);
    reg.register(high.source);

    assertEqual(reg.available().map((s) => s.name).join(','), 'high,low', '可用来源应按优先级排好');
    assertEqual(await reg.scan(), '高');
    assertEqual(low.calls.count, 0, '已经拿到结果就不该再试下一个来源');
  });

  test('前面的来源失败（比如没给相机权限）会继续试后面的', async () => {
    const reg = Scanner.create();
    const bad = failing({ name: 'camera-like', label: '摄像头', priority: 100 });
    const good = fake({ name: 'fallback', priority: 1, scan: () => Promise.resolve('退而求其次') });
    reg.register(bad.source);
    reg.register(good.source);

    assertEqual(await reg.scan(), '退而求其次', '一个来源失败不该让整次扫码失败');
    assertEqual(bad.calls.count, 1, '失败的来源被试过一次');
    assertEqual(good.calls.count, 1, '后备来源被试用');
  });

  test('扫码返回空文本不算成功，要接着试下一个', async () => {
    const reg = Scanner.create();
    reg.register(fake({ name: 'empty', priority: 100, scan: () => Promise.resolve('') }).source);
    reg.register(fake({ name: 'real', priority: 1, scan: () => Promise.resolve('真结果') }).source);
    assertEqual(await reg.scan(), '真结果', '空字符串应当被当作"没扫到"，而不是"扫到了空编码"');
  });

  test('用户主动取消就立刻停下，不再弹下一个来源的界面', async () => {
    const reg = Scanner.create();
    const userCancelled = cancelled({ name: 'feishu-like', priority: 100 });
    const camera = fake({ name: 'camera-like', priority: 10, scan: () => Promise.resolve('不该轮到它') });
    reg.register(userCancelled.source);
    reg.register(camera.source);

    let err = null;
    try { await reg.scan(); } catch (e) { err = e; }
    assert(err, '取消应当把错误抛出来，而不是静默返回空');
    assert(err.cancelled === true, '取消的错误要带 cancelled 标记，上层才知道是用户自己取消的');
    assertEqual(camera.calls.count, 0,
      '取消之后绝不能再弹摄像头 —— 点了取消又冒出相机，像甩不掉的弹窗');
  });

  test('一个来源都没有时给一句人话（NO_SCANNER）', async () => {
    const reg = Scanner.create();
    let err = null;
    try { await reg.scan(); } catch (e) { err = e; }
    assert(err, '应当抛错');
    assertEqual(err.code, 'NO_SCANNER', '错误码应当是 NO_SCANNER，实际 ' + err.code);
    assert(/不在飞书客户端里/.test(err.message) || /没法直接扫码/.test(err.message),
      '提示要说清是环境不支持，实际：' + err.message);
  });

  test('所有来源都失败时，把每个失败原因都带出来', async () => {
    const reg = Scanner.create();
    reg.register(failing({ name: 'a', label: '摄像头', priority: 100 }).source);
    reg.register(failing({ name: 'b', label: '飞书扫码', priority: 10 }).source);
    let err = null;
    try { await reg.scan(); } catch (e) { err = e; }
    assertEqual(err.code, 'SCAN_FAILED');
    assert(err.message.indexOf('摄像头') !== -1, '原因里应提到摄像头，实际：' + err.message);
    assert(err.message.indexOf('飞书扫码') !== -1, '原因里应提到飞书扫码，实际：' + err.message);
  });

  /* ================= 内置来源 ================= */

  test('默认注册表带摄像头来源，且在没有识别能力的环境里不冒充可用', async () => {
    // Node 里没有 BarcodeDetector，所以摄像头来源必须是"不可用" ——
    // 否则离线版在某些环境里会莫名其妙去要相机权限。
    const names = Scanner.available().map((s) => s.name);
    assertEqual(names.length, 0, 'Node 环境里默认注册表不该有可用来源，实际：' + names.join(','));
    assert(typeof global.BarcodeDetector !== 'function' || names.length > 0,
      '真支持 BarcodeDetector 的环境里，摄像头来源应当可用');
  });

  test('没有自带识别能力、但有本机解码库时，摄像头仍然可用（iPhone 的默认情况）', async () => {
    // 这是手机端扫码点不动的根因回归用例：
    // iOS Safari 没有 BarcodeDetector，原先摄像头来源直接判"不可用"，
    // 界面上连"开始扫码"都不该出现 —— 队员看到的就是点了没反应。
    // 装了 jsQR 之后，解码在本机做，有没有自带能力都得能扫。
    const modulePath = require.resolve('../../js/scanner.js');
    // Node 21+ 里 global.navigator 是只读的 getter，直接赋值会抛错，只能重定义
    const savedNav = Object.getOwnPropertyDescriptor(global, 'navigator');
    const saved = {
      jsQR: global.jsQR,
      document: global.document,
      hadDocument: 'document' in global
    };

    function setNavigator(value) {
      Object.defineProperty(global, 'navigator', {
        value: value, configurable: true, writable: true
      });
    }

    function reload() {
      delete require.cache[modulePath];
      return require(modulePath);
    }

    let names = [];
    try {
      global.jsQR = function () { return null; };
      setNavigator({ mediaDevices: { getUserMedia: function () {} } });
      global.document = { createElement: function () { return {}; } };
      names = reload().available().map((s) => s.name);
    } finally {
      if (savedNav) Object.defineProperty(global, 'navigator', savedNav);
      else delete global.navigator;
      if (saved.hadDocument) global.document = saved.document; else delete global.document;
      if (saved.jsQR === undefined) delete global.jsQR; else global.jsQR = saved.jsQR;
      reload();      // 用干净环境把默认注册表恢复回去，别污染后面的用例
    }

    assert(names.indexOf('camera') !== -1,
      '有 jsQR 就该能用摄像头（没有 BarcodeDetector 也算），实际可用：' + names.join('、'));
    assert(names.indexOf('photo') !== -1,
      '同时要留着「拍照识别」这条兜底，实际可用：' + names.join('、'));
  });

  test('既没有自带识别能力也没有解码库时，摄像头不冒充可用', async () => {
    const modulePath = require.resolve('../../js/scanner.js');
    const savedJsQR = global.jsQR;
    let names = [];
    try {
      delete global.jsQR;
      delete require.cache[modulePath];
      names = require(modulePath).available().map((s) => s.name);
    } finally {
      if (savedJsQR === undefined) delete global.jsQR; else global.jsQR = savedJsQR;
      delete require.cache[modulePath];
      require(modulePath);
    }
    assertEqual(names.length, 0,
      '没有解码办法时不该有可用来源（否则会去要相机权限却什么也认不出），实际：' + names.join('、'));
  });

  test('sources() 列出全部来源（含当前不可用的）—— 界面要靠它给兜底路做直达按钮', async () => {
    const reg = Scanner.create();
    reg.register({ name: 'usable', available: () => true, scan: () => Promise.resolve('a') });
    reg.register({ name: 'unusable', available: () => false, scan: () => Promise.resolve('b') });

    const all = reg.sources().map((s) => s.name);
    assert(all.indexOf('unusable') !== -1,
      '不可用的来源也要列出来 —— 否则界面没法判断"这条路存不存在"，实际：' + all.join('、'));
    assertEqual(reg.available().map((s) => s.name).join(','), 'usable', 'available() 仍然只给能用的');
    // 返回的是副本，界面拿去改不会动到注册表本身
    reg.sources().length = 0;
    assertEqual(reg.sources().length, 2, 'sources() 要给副本，不能被外部改坏');
  });

  test('摄像头打不开时把浏览器的报错翻成人话（权限被拒最常见）', async () => {
    const text = Scanner.cameraErrorText;
    assert(typeof text === 'function', '摄像头报错要能翻成人话，界面和排查都用得上');

    const denied = text({ name: 'NotAllowedError', message: 'Permission denied' });
    assert(/相机权限/.test(denied) && /拍照/.test(denied),
      '权限被拒要告诉人去哪里开、并给出替代办法，实际：' + denied);

    assert(/没找到可用的摄像头/.test(text({ name: 'NotFoundError' })),
      '没摄像头要说明白，实际：' + text({ name: 'NotFoundError' }));

    assert(/被别的应用占用/.test(text({ name: 'NotReadableError' })),
      '相机被占用要说明白，实际：' + text({ name: 'NotReadableError' }));

    // 认不出来的错误也不能丢掉原始信息，否则没法继续排查
    assert(/打不开摄像头/.test(text({ name: 'WeirdError', message: 'xyz' })) &&
      /xyz/.test(text({ name: 'WeirdError', message: 'xyz' })),
      '未知错误要保留原文，实际：' + text({ name: 'WeirdError', message: 'xyz' }));
  });

  /* ================= 整条链路：扫到的文本 → 编码 ================= */

  test('扫到的文本能按本系统的格式解析回编码', async () => {
    const code = (await Ops.inbound({
      categoryId: 'mechanical', name: '扫码链路测试件', quantity: 1,
      identityMode: 'single', operator: '测试'
    })).codes[0];

    // 打印出的二维码里放的就是这个文本，扫码拿回来的是同一串
    const payload = Rules.qrPayload(code);
    assertEqual(Rules.parseQrPayload(payload), code, '二维码文本应能解析回原编码');
    assertEqual(payload, 'FEVER:ITEM:' + code, '二维码内容格式应与第一版一致（已贴出去的标签不能失效）');
  });

  test('扫到别的二维码（不是本系统的标签）会得到 null，界面好据此提示', async () => {
    assertEqual(Rules.parseQrPayload('https://example.com'), null, '网址不该被当成本系统的标签');
    assertEqual(Rules.parseQrPayload('随便一段字'), null);
    assertEqual(Rules.parseQrPayload(''), null);
    assertEqual(Rules.parseQrPayload(null), null);
    // 扫码枪直接输出编码本身也要认
    const code = (await Ops.inbound({
      categoryId: 'hardware', name: '扫码枪测试件', quantity: 1,
      identityMode: 'single', operator: '测试'
    })).codes[0];
    assertEqual(Rules.parseQrPayload(code), code, '扫码枪直接吐编码时也要认');
  });

  test('扫到的编码能不能找到物品，决定了界面走"确认状态"还是"没有这件"', async () => {
    const code = (await Ops.inbound({
      categoryId: 'hardware', name: '存在性测试件', quantity: 1,
      identityMode: 'single', operator: '测试'
    })).codes[0];

    const found = await DB.get('items', Rules.parseQrPayload(Rules.qrPayload(code)));
    assert(found, '扫到自己的标签应当能定位到物品');
    assertEqual(found.code, code);

    const missing = await DB.get('items', Rules.parseQrPayload(Rules.qrPayload('ZZ-9999')));
    assertEqual(missing, undefined, '扫到不存在的编码应当查不到，界面要提示"没有这件"');
  });
};
