/**
 * FEver 战队物资管理 —— 扫码
 *
 * 第二版手机端要扫码。扫到码不难，难的是"在什么环境里用什么办法扫"。
 * 这里做成**多个来源依次尝试**，按体验从好到差排：
 *
 *   1. 飞书客户端里：走飞书原生扫码（tt.scanCode）。
 *      不用申请相机权限、iOS 和 Android 都行，是主路径。
 *      离线版里没有飞书桥，这个来源自然不会注册 —— 它由 feishu/js/feishu-scan.js 提供。
 *   2. 浏览器自带识别能力（BarcodeDetector + 摄像头）：
 *      Android Chrome 等支持，桌面版开着摄像头的电脑也能用。
 *   3. 都不可用时：由界面提示手动输入编码（扫码枪、码磨损了、环境不支持时用）。
 *      这一步不在这里实现 —— 它是界面上的一个输入框，不属于"扫码来源"。
 *
 * 为什么来源要做成可注册的：飞书那套 API 只在飞书客户端里有，
 * 而 v1（离线版）有一条硬约束 —— 代码里不许出现任何联网/客户端桥调用。
 * 把飞书来源放在 v1 外面、用时再注册，离线版就一直干净。
 *
 * 本文件自身不做任何联网调用。
 */
(function (global) {
  'use strict';

  /**
   * 造一个扫码注册表。
   *
   * 做成工厂（而不是直接写一个全局单例）是为了能各用各的：
   * 应用用默认那一个；测试每次 create() 一个干净的，
   * 互不干扰 —— 不然先跑的用例注册了假的扫码来源，后面的用例就会被带偏。
   */
  function makeRegistry() {
    /**
     * 已注册的来源。每项形如：
     *   { name, label, priority, available(): boolean, scan(opts): Promise<文本> }
     * scan 里用户主动取消时，抛出的错误要带 cancelled = true。
     */
    var sources = [];

    /**
     * 注册一个扫码来源；priority 越大越先尝试。
     * 同名会替换掉旧的：飞书的 tt 是异步注入的，注册可能被调用两次，
     * 不去重的话"飞书扫码"会出现在列表里两遍，看起来莫名其妙。
     */
    function register(source) {
      if (!source || typeof source.scan !== 'function' || typeof source.available !== 'function') {
        throw new Error('扫码来源必须同时提供 available() 和 scan()');
      }
      if (!source.name) throw new Error('扫码来源必须有 name');
      sources = sources.filter(function (s) { return s.name !== source.name; });
      sources.push(source);
      sources.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
      return source;
    }

    /** 当前环境里真正能用的来源（available() 自己抛错就当不可用，别把整个扫码拖挂） */
    function available() {
      return sources.filter(function (s) {
        try { return !!s.available(); } catch (err) { return false; }
      });
    }

    /**
     * 扫码，返回识别到的**原始文本**（解析成编码交给 Rules.parseQrPayload）。
     *
     * 依次尝试各个可用来源：
     *   · 某个来源报错（比如没给相机权限）→ 记下原因，继续试下一个；
     *   · 用户主动取消 → 立刻停下，**不再**弹下一个来源的界面
     *     （否则点了取消又冒出摄像头，像甩不掉的弹窗）；
     *   · 全都不成 → 抛一个把每个来源失败原因都带上的错误，方便排查。
     */
    function scan(opts) {
      var list = available();
      if (!list.length) {
        var none = new Error('这个环境没法直接扫码（浏览器不支持，也不在飞书客户端里）');
        none.code = 'NO_SCANNER';
        return Promise.reject(none);
      }

      var errors = [];
      return list.reduce(function (chain, src) {
        return chain.then(function (text) {
          if (text) return text;
          return Promise.resolve()
            .then(function () { return src.scan(opts); })
            .then(function (t) { return t || null; }, function (err) {
              if (err && err.cancelled) throw err;
              errors.push((src.label || src.name) + '：' + (err && err.message ? err.message : err));
              return null;
            });
        });
      }, Promise.resolve(null)).then(function (text) {
        if (text) return text;
        var failed = new Error('扫码没成功。' + errors.join('；'));
        failed.code = 'SCAN_FAILED';
        throw failed;
      });
    }

    return {
      register: register,
      available: available,
      scan: scan,
      /**
       * 全部已注册的来源（含当前不可用的）。
       * 界面要用它做"只走某一条路"的按钮 —— 比如 iOS 上必须在用户点击的同步栈里
       * 触发文件选择，不能等异步链转一圈之后再弹。
       */
      sources: function () { return sources.slice(); }
    };
  }

  /* ==================== 内置来源 ==================== */

  /**
   * 本机解码库（js/lib/jsQR.js）在不在。
   *
   * 为什么必须有它：手机上的浏览器识别能力**差得离谱** ——
   * 系统自带的 BarcodeDetector 只有一部分安卓 Chrome 有，iOS Safari 根本没有。
   * 之前摄像头来源把它当成唯一解码办法，结果 iPhone 上「开始扫码」点了没反应：
   * 来源直接判定为不可用，连摄像头都不开。装上 jsQR 之后，
   * 解码在本机算（不联网、不传图），有没有自带能力都能扫。
   */
  function hasJsQR() {
    return typeof global.jsQR === 'function';
  }

  function canOpenCamera() {
    return !!(global.navigator && global.navigator.mediaDevices &&
      typeof global.navigator.mediaDevices.getUserMedia === 'function');
  }

  function detectorSupported() {
    return typeof global.BarcodeDetector === 'function' && canOpenCamera();
  }

  /** 实时扫码能不能用：开得了摄像头，且至少有一种解码办法 */
  function cameraSupported() {
    return canOpenCamera() && (detectorSupported() || hasJsQR());
  }

  /**
   * 摄像头打不开时，把浏览器的报错翻成人话。
   *
   * 为什么值得单独写：手机上"扫不了"最常见的其实是**权限没给**（很多人第一次点了拒绝，
   * 之后浏览器再也不问，页面只剩"打不开摄像头"），以及**在某些内置浏览器里根本不许网页开相机**。
   * 不说清楚的话，使用者只会觉得"这个应用扫不了"，然后就放弃了。
   */
  function cameraErrorText(err) {
    var name = String((err && err.name) || '');
    var msg = String((err && err.message) || err || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '没拿到摄像头权限（之前点过「拒绝」的话浏览器不会再问——去手机设置里把相机权限打开；' +
        '也可以直接点「拍照 / 选图」，照样能扫）';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '这台设备上没找到可用的摄像头，改用「拍照 / 选图」';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '摄像头被别的应用占用了（关掉别的相机应用再试），或改用「拍照 / 选图」';
    }
    if (name === 'OverconstrainedError') return '这台设备的摄像头不支持所需的拍摄参数';
    if (!global.isSecureContext && /getUserMedia|undefined/.test(msg)) {
      return '网页必须用 https 打开才能调摄像头，当前不是安全环境';
    }
    return '打不开摄像头：' + msg;
  }

  /** 解码用画布：一把锁一份，多个来源不会互相抢 */
  var sharedCanvas = null;
  var sharedCtx = null;
  function canvasFor(w, h) {
    var doc = global.document;
    if (!sharedCanvas) {
      sharedCanvas = doc.createElement('canvas');
      sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (sharedCanvas.width !== w || sharedCanvas.height !== h) {
      sharedCanvas.width = w;
      sharedCanvas.height = h;
    }
    return sharedCtx;
  }

  /** 把 video 的当前画面缩到最长边 maxSide 后画进画布 —— 图小一点，手机解码快很多 */
  function grabFrame(video, maxSide) {
    var vw = video.videoWidth || 0;
    var vh = video.videoHeight || 0;
    if (!vw || !vh) return null;
    var scale = Math.min(1, maxSide / Math.max(vw, vh));
    var w = Math.max(1, Math.round(vw * scale));
    var h = Math.max(1, Math.round(vh * scale));
    var ctx = canvasFor(w, h);
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return { width: w, height: h };
  }

  /** 用本机解码库认一帧；认不出返回 null（不是错误，继续下一帧） */
  function decodeFrame(ctx, w, h) {
    if (!ctx) return null;
    var image;
    try {
      image = ctx.getImageData(0, 0, w, h);
    } catch (err) {
      return null;   // 画面还没准备好，下一帧再来
    }
    var found = global.jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
    return (found && found.data) ? String(found.data) : null;
  }

  /** 建一个通用遮罩：取景界面 + 提示 + 取消按钮 */
  function makeOverlay(inner) {
    var doc = global.document;
    var overlay = doc.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML =
      '<div class="scan-stage">' + inner +
        '<button class="btn scan-cancel" type="button">取消</button>' +
      '</div>';
    doc.body.appendChild(overlay);
    return overlay;
  }

  /**
   * 开摄像头实时识别。
   *
   * 界面自己画（一个全屏遮罩 + 取景框），因为这个来源是"自带 UI 的能力"——
   * 交给调用方去画的话，每个调用点都得重复一遍，还不一致。
   * 结束（识别到 / 取消 / 出错）时一定把相机轨道关掉，否则手机的相机指示灯会一直亮着。
   *
   * 两条解码路：
   *   · 浏览器自带 BarcodeDetector —— 快，但只有部分安卓有；
   *   · 本机 jsQR 抓帧 —— 慢一点，但 iOS 和老安卓也能用。
   */
  function scanWithCamera() {
    return new Promise(function (resolve, reject) {
      var doc = global.document;
      if (!doc || !doc.body) { reject(new Error('当前环境没有界面，无法开摄像头')); return; }

      var overlay = makeOverlay(
        '<video class="scan-video" playsinline muted></video>' +
        '<div class="scan-frame"></div>' +
        '<div class="scan-hint">把物品上的二维码对准框内</div>'
      );

      var video = overlay.querySelector('.scan-video');
      var stream = null;
      var detector = null;
      var raf = 0;
      var timer = 0;
      var finished = false;

      function cleanup() {
        if (raf && global.cancelAnimationFrame) global.cancelAnimationFrame(raf);
        if (timer) global.clearTimeout(timer);
        raf = 0;
        timer = 0;
        if (stream && stream.getTracks) {
          stream.getTracks().forEach(function (t) { try { t.stop(); } catch (err) { /* 已停 */ } });
        }
        stream = null;
        if (video) video.srcObject = null;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
      function finish(text) { if (finished) return; finished = true; cleanup(); resolve(text); }
      function abort(err) { if (finished) return; finished = true; cleanup(); reject(err); }

      overlay.querySelector('.scan-cancel').addEventListener('click', function () {
        var err = new Error('已取消扫码');
        err.cancelled = true;
        abort(err);
      });

      if (detectorSupported()) {
        try {
          detector = new global.BarcodeDetector({ formats: ['qr_code'] });
        } catch (err) {
          detector = null;
        }
      }

      /** 自带识别：逐帧问它 */
      function tickDetector() {
        if (finished) return;
        detector.detect(video).then(function (codes) {
          if (finished) return;
          if (codes && codes.length && codes[0] && codes[0].rawValue) {
            finish(String(codes[0].rawValue));
            return;
          }
          raf = global.requestAnimationFrame(tickDetector);
        }, function () {
          // 某一帧识别失败很正常（画面糊、还没对上焦），继续下一帧就行
          if (finished) return;
          raf = global.requestAnimationFrame(tickDetector);
        });
      }

      /**
       * 本机解码：定间隔抓帧（180ms）而不是每一帧都解 ——
       * 手机上逐帧解会明显发烫、掉帧，而对准二维码本来就要一两秒，慢一点无感。
       */
      function tickJsQR() {
        if (finished) return;
        var frame = grabFrame(video, 640);
        if (frame) {
          var ctx = sharedCtx;
          var text = decodeFrame(ctx, frame.width, frame.height);
          if (text) { finish(text); return; }
        }
        timer = global.setTimeout(tickJsQR, 180);
      }

      // 优先用后置摄像头 —— 手机上前置对着自己，扫码基本没法用
      global.navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      })
        .then(function (s) {
          if (finished) { s.getTracks().forEach(function (t) { t.stop(); }); return null; }
          stream = s;
          video.srcObject = s;
          // iOS 上必须 playsinline + 显式 play()，否则画面是全黑的（看着像失败）
          return (video.play && video.play()) || null;
        })
        .then(function () {
          if (finished) return;
          if (detector) tickDetector();
          else if (hasJsQR()) tickJsQR();
          else abort(new Error('这个浏览器既没有自带识别能力，也没有加载到本机解码库'));
        })
        .catch(function (err) {
          abort(new Error(cameraErrorText(err)));
        });
    });
  }

  /**
   * 拍照 / 从相册选一张图来认。
   *
   * 存在的理由很实际：**有摄像头的浏览器不等于允许网页开着摄像头** ——
   * 队员可能拒过一次权限、系统设置里把相机权限关了、或者用的是某些内置浏览器，
   * 那些情况下 getUserMedia 直接失败。而"拍照上传"这条路几乎所有手机浏览器都支持，
   * 图也不出手机（本机解码），是最后一道能自己站住的兜底。
   */
  function photoSupported() {
    return hasJsQR() && !!global.document;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      if (!global.URL || !global.URL.createObjectURL) {
        reject(new Error('这个浏览器不支持读取本地图片'));
        return;
      }
      var url = global.URL.createObjectURL(file);
      var img = new global.Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () {
        try { global.URL.revokeObjectURL(url); } catch (err) { /* 无所谓 */ }
        reject(new Error('这张图读不出来，换一张试试'));
      };
      img.src = url;
    });
  }

  function decodeImage(img) {
    var iw = img.naturalWidth || img.width || 0;
    var ih = img.naturalHeight || img.height || 0;
    if (!iw || !ih) return null;
    var scale = Math.min(1, 1200 / Math.max(iw, ih));
    var w = Math.max(1, Math.round(iw * scale));
    var h = Math.max(1, Math.round(ih * scale));
    var ctx = canvasFor(w, h);
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return decodeFrame(ctx, w, h);
  }

  function scanWithPhoto(opts) {
    return new Promise(function (resolve, reject) {
      var doc = global.document;
      if (!doc || !doc.body) { reject(new Error('当前环境没有界面，无法选图')); return; }

      var overlay = makeOverlay(
        '<div class="scan-hint">拍一张物品标签，或从相册里选一张它的照片</div>' +
        '<input class="scan-file" type="file" accept="image/*" capture="environment" hidden>' +
        '<button class="btn primary scan-pick" type="button">拍照 / 选图</button>'
      );

      var input = overlay.querySelector('.scan-file');
      var pickBtn = overlay.querySelector('.scan-pick');
      var hint = overlay.querySelector('.scan-hint');
      var finished = false;
      var objectUrl = '';

      function cleanup() {
        if (objectUrl) { try { global.URL.revokeObjectURL(objectUrl); } catch (err) { /* 无所谓 */ } }
        objectUrl = '';
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
      function finish(text) { if (finished) return; finished = true; cleanup(); resolve(text); }
      function abort(err) { if (finished) return; finished = true; cleanup(); reject(err); }

      overlay.querySelector('.scan-cancel').addEventListener('click', function () {
        var err = new Error('已取消扫码');
        err.cancelled = true;
        abort(err);
      });

      function pick() {
        if (!input) { abort(new Error('这个浏览器不支持选择图片')); return; }
        input.value = '';
        input.click();
      }
      if (pickBtn) pickBtn.addEventListener('click', pick);

      if (input) {
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) return;                       // 用户只是关掉了选择器
          if (hint) hint.textContent = '正在认这张图……';
          loadImage(file).then(function (loaded) {
            objectUrl = loaded.url;
            var text = decodeImage(loaded.img);
            if (text) { finish(text); return; }
            if (hint) hint.textContent = '这张图里没认出二维码。拍清楚一点、把整个码拍进去，再试一次。';
            if (pickBtn) pickBtn.disabled = false;
          }).catch(function (err) {
            if (hint) hint.textContent = (err && err.message) ? err.message : '这张图读不出来';
            if (pickBtn) pickBtn.disabled = false;
          });
        });
      }

      // 进来就直接把选择器递上去 —— 少点一次按钮。
      // 用户关掉选择器也不算失败：遮罩还在，可以再点「拍照 / 选图」或取消。
      // autoPick:false 只给自动化测试用（无头浏览器点不出系统文件选择器）。
      if (!(opts && opts.autoPick === false)) pick();
    });
  }

  var defaultRegistry = makeRegistry();

  defaultRegistry.register({
    name: 'camera',
    label: '摄像头',
    priority: 10,
    available: cameraSupported,
    scan: scanWithCamera
  });

  defaultRegistry.register({
    name: 'photo',
    label: '拍照识别',
    priority: 5,
    available: photoSupported,
    scan: scanWithPhoto
  });

  global.FEVER = global.FEVER || {};
  global.FEVER.Scanner = {
    register: defaultRegistry.register,
    available: defaultRegistry.available,
    scan: defaultRegistry.scan,
    /**
     * 全部已注册的来源（含当前不可用的）。
     * 界面要用它做"只走某一条路"的按钮 —— 比如 iOS 上必须在用户点击的同步栈里
     * 触发文件选择，不能等异步链转一圈之后再弹。
     */
    sources: defaultRegistry.sources,
    /** 另造一个干净的注册表（测试用；也可用于将来需要独立一套扫码来源的场景） */
    create: makeRegistry,
    /** 摄像头报错翻成人话（界面/排查都要用） */
    cameraErrorText: cameraErrorText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.FEVER.Scanner;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
