/**
 * 离线与"不联网"要求的自检（对照 AC-01、AC-35）。
 *
 * 做法：把全部前端文件扫一遍，看有没有指向外网的地址、有没有登录、
 * 有没有调用摄像头、有没有手机端专用写法。
 * 这类问题靠人工点页面很难发现，扫文件最可靠。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const V1 = path.resolve(__dirname, '..', '..');

/** 应用自己的文件（不含测试目录、依赖目录） */
function listAppFiles(dir, out) {
  const acc = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    if (ent.name === 'node_modules' || ent.name === 'test' || ent.name === '.git') return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listAppFiles(full, acc);
    else if (/\.(js|html|css|json|bat)$/.test(ent.name)) acc.push(full);
  });
  return acc;
}

module.exports.register = function (H) {
  const { test, assert } = H;
  const files = listAppFiles(V1);

  function read(f) { return fs.readFileSync(f, 'utf8'); }
  function rel(f) { return path.relative(V1, f).replace(/\\/g, '/'); }

  test('应用文件里没有指向外网的地址（不联网要求）', async () => {
    const offenders = [];
    files.forEach((f) => {
      const text = read(f);
      // 注释里的说明性网址（比如安装 Node 的提示）不算联网行为，
      // 这里只找"会真的去请求"的写法：fetch / XHR / script src / link href / import
      const patterns = [
        /https?:\/\/(?!127\.0\.0\.1)[^\s'"<>)]+/g
      ];
      patterns.forEach((re) => {
        (text.match(re) || []).forEach((u) => {
          offenders.push(rel(f) + ' → ' + u);
        });
      });
    });
    // 允许清单：这些不是应用自身的网络请求
    const allowed = [
      'nodejs.org',            // 只在"没装 Node"的提示里出现
      'www.w3.org',            // SVG 命名空间，不是网络请求
      'schemas.android.com',
      'openai.com',
      'localhost'
    ];
    const real = offenders.filter((o) => !allowed.some((a) => o.includes(a)));
    assert(real.length === 0, '不该出现外网地址，发现：' + real.join('；'));
  });

  test('应用代码里没有 fetch / XMLHttpRequest / WebSocket 等联网调用', async () => {
    const offenders = [];
    files.filter((f) => /\.(js|html)$/.test(f)).forEach((f) => {
      const text = read(f);
      ['fetch(', 'XMLHttpRequest', 'new WebSocket', 'EventSource', 'navigator.sendBeacon',
        'importScripts('].forEach((needle) => {
          if (text.includes(needle)) offenders.push(rel(f) + ' → ' + needle);
        });
      // 允许 XHR 出现在注释里说明"我们不联网"，但代码里不能有
      if (/^\s*(var|const|let|function).*XMLHttpRequest/m.test(text)) {
        offenders.push(rel(f) + ' → XMLHttpRequest（代码里出现）');
      }
    });
    assert(offenders.length === 0, '不该有联网调用，发现：' + offenders.join('；'));
  });

  test('没有登录 / 账号相关界面（不需要登录）', async () => {
    const offenders = [];
    files.filter((f) => /\.(js|html)$/.test(f)).forEach((f) => {
      const text = read(f);
      // 只找"真的有登录界面"的写法。
      // 「本系统不需要登录」这种说明文字是好事，不能算问题。
      const bad = [
        /type\s*=\s*["']password["']/,
        /name\s*=\s*["'](username|password|account)["']/,
        /\b(signIn|signUp|logIn|registerAccount)\s*\(/,
        /登录界面|账号密码|请输入用户名/
      ];
      bad.forEach((re) => {
        if (re.test(text)) offenders.push(rel(f) + ' → ' + re);
      });
    });
    assert(offenders.length === 0, '不该有登录相关代码，发现：' + offenders.join('；'));
  });

  test('摄像头与扫码只出现在指定的扫码模块里（不散落各处，也不依赖在线服务）', async () => {
    // 第一版的约束是"一律不准调用摄像头"。第二版要扫码，这条自然要放开，
    // 但不是简单删掉 —— 放开成"只准集中在 js/scanner.js"：
    // 摄像头 API 散着写的话，随便打开哪一页都可能弹相机授权，没人说得清是什么触发的。
    const CAMERA = ['getUserMedia', 'enumerateDevices', 'BarcodeDetector'];
    const scattered = [];
    files.filter((f) => /\.(js|html)$/.test(f)).forEach((f) => {
      if (rel(f) === 'js/scanner.js') return;      // 扫码模块就是它该待的地方
      const text = read(f);
      CAMERA.forEach((needle) => {
        if (text.includes(needle)) scattered.push(rel(f) + ' → ' + needle);
      });
    });
    assert(scattered.length === 0,
      '摄像头调用只应出现在 js/scanner.js，发现：' + scattered.join('；'));

    // 二维码必须在本机解，不能把拍到的图传到在线识别服务去
    const online = [];
    ['html5-qrcode', 'qrserver.com', 'zxing', 'jsqr-cdn'].forEach((needle) => {
      files.forEach((f) => {
        if (read(f).toLowerCase().includes(needle.toLowerCase())) {
          online.push(rel(f) + ' → ' + needle);
        }
      });
    });
    assert(online.length === 0, '不该依赖在线扫码服务，发现：' + online.join('；'));
  });

  test('手机端写法集中在样式文件里，且不允许禁用缩放', async () => {
    const html = read(path.join(V1, 'index.html'));
    // 只看 viewport 这个 meta 标签本身。之前是拿整份 HTML 做子串匹配，
    // 结果连注释里提一句"不写 user-scalable=no"都会被判违规 —— 太粗。
    const tag = (/<meta[^>]*name=["']viewport["'][^>]*>/i.exec(html) || [''])[0];
    assert(tag, '第二版要能在手机上用，首页必须有 viewport 的 meta 标签');

    // 禁用缩放（user-scalable=no / maximum-scale=1）会让看不清小字的人没法放大，
    // 无障碍上的代价太大，明确不许。
    ['user-scalable=no', 'user-scalable=0', 'maximum-scale=1'].forEach((bad) => {
      assert(tag.indexOf(bad) === -1, 'viewport 里不允许禁用缩放（出现了 ' + bad + '）');
    });

    // 手机断点只允许收在 css 里，别散进 js / html —— 散出去以后没人找得全
    const scattered = [];
    files.filter((f) => /\.(js|html)$/.test(f)).forEach((f) => {
      const media = read(f).match(/@media[^{]*max-width[^{]*/g) || [];
      media.forEach((m) => scattered.push(rel(f) + ' → ' + m.trim()));
    });
    assert(scattered.length === 0, '手机断点应写在 css 里，发现：' + scattered.join('；'));

    const css = read(path.join(V1, 'css', 'style.css'));
    assert(/@media\s*\(max-width:\s*720px\)/.test(css), '样式里应有手机断点（720px）');
  });

  test('页面引入的脚本全部来自本地目录，没有 CDN 依赖', async () => {
    const offenders = [];
    files.filter((f) => /\.html$/.test(f)).forEach((f) => {
      const text = read(f);
      const srcs = text.match(/<script[^>]+src="([^"]+)"/g) || [];
      srcs.forEach((tag) => {
        const m = /src="([^"]+)"/.exec(tag);
        const src = m ? m[1] : '';
        if (!src.startsWith('/') && !src.startsWith('js/') && !src.startsWith('../')) {
          offenders.push(rel(f) + ' → ' + src);
        }
      });
    });
    assert(offenders.length === 0, '脚本都应来自本地，发现：' + offenders.join('；'));
  });

  test('二维码是本地生成的（不依赖在线二维码服务）', async () => {
    const qrLib = path.join(V1, 'js', 'lib', 'qrcode.min.js');
    assert(fs.existsSync(qrLib), '应自带本地二维码库 js/lib/qrcode.min.js');
    assert(fs.statSync(qrLib).size > 5000, '本地二维码库应有实际内容');

    const qr = read(path.join(V1, 'js', 'qr.js'));
    assert(qr.includes('global.qrcode'), '渲染应调用本地二维码库');
    // 生成的是 data URL（本机算出来的图），不是某个在线图片地址
    assert(qr.includes('createDataURL') || qr.includes('dataUrl'), '应生成 data URL 而不是外链图片');

    const rules = read(path.join(V1, 'js', 'rules.js'));
    assert(rules.includes("'FEVER:ITEM:'"), '二维码内容格式应定义在本地 rules.js 里');

    const html = read(path.join(V1, 'index.html'));
    assert(html.includes('lib/qrcode.min.js'), '页面应引用本地二维码库');
  });

  test('主页面引入了全部应用脚本（打开就能用）', async () => {
    const html = read(path.join(V1, 'index.html'));
    ['db.js', 'rules.js', 'ops.js', 'stats.js', 'ui.js', 'qr.js', 'scanner.js', 'views.js',
      'views-commerce.js', 'actions.js', 'app.js'].forEach((n) => {
        assert(html.includes('js/' + n), '主页面应引入 ' + n);
      });
    ['mechanical', 'electronic', 'vision', 'hardware'].forEach((n) => {
      assert(html.includes('js/modules/' + n + '.js'), '主页面应引入大类模块 ' + n);
    });
  });
};
