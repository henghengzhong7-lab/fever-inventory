/**
 * 对外接口自检：代码里用到的 Rules.xxx / Stats.xxx / DB.xxx / Ops.xxx / UI.xxx
 * 是不是真的存在。
 *
 * 为什么要专门有这一组：
 *   模块内部定义了函数、却忘了加进最后的导出对象，是个**静默**错误 ——
 *   文件语法没问题、其他单测也照过，只有在浏览器里点到那一个按钮时才会炸成
 *   "xxx is not a function"。实测踩过两次（Rules.isPendingApproval、
 *   一次登录层的导出），两次都是靠浏览器端到端测试才发现的，代价是十几分钟。
 *   这里改成静态扫一遍：所有引用一次性列出来，缺哪个直接报名字。
 *
 * 做法：只扫"界面层"（views / actions / app）对这些模块的引用 ——
 * 它们是消费方，引用什么就必须存在什么。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JS_ROOT = path.resolve(__dirname, '..', '..', 'js');

/** 要检查的模块名 → 这个模块所在的文件（用来从源码里兜底提取导出名） */
const MODULES = {
  Rules: 'rules.js',
  Stats: 'stats.js',
  Ops: 'ops.js',
  DB: 'db.js',
  UI: 'ui.js'
};

/** 被检查的消费方文件 */
const CONSUMERS = ['views.js', 'views-commerce.js', 'actions.js', 'app.js', 'ops.js', 'stats.js', 'rules.js'];

/** 从源码里抠出 `global.FEVER.X = { ... }` 这个对象里所有键名 */
function exportedKeysFromSource(file) {
  const code = fs.readFileSync(file, 'utf8');
  const start = code.indexOf('global.FEVER.UI = {');
  if (start === -1) return null;
  const end = code.indexOf('\n  };', start);
  if (end === -1) return null;
  const block = code.slice(start, end);
  const keys = [];
  const re = /^\s*([A-Za-z_$][\w$]*)\s*:/gm;
  let m;
  while ((m = re.exec(block))) keys.push(m[1]);
  return keys;
}

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert } = H;

  // 能 require 到的就用真实的导出对象；require 不动的（比如 ui.js 依赖浏览器环境）
  // 退回到从源码里提取键名 —— 效果差一点，但照样能挡住"漏导出"
  const loaded = { Rules, Stats: null, Ops, DB, UI: null };
  try { loaded.Stats = require('../../js/stats.js'); } catch (err) { /* 下面兜底 */ }
  try { loaded.UI = require('../../js/ui.js'); } catch (err) { /* 下面兜底 */ }

  function keysOf(name) {
    const mod = loaded[name];
    if (mod) {
      const keys = Object.keys(mod);
      // 有些脚本只在 window 上挂东西、没有 module.exports，
      // require 回来是个空对象 —— 那不算"拿到了导出"，要退回去读源码
      if (keys.length) return keys;
    }
    return exportedKeysFromSource(path.join(JS_ROOT, MODULES[name]));
  }

  test('每个模块都能列出自己的导出（自检本身别是空转）', async () => {
    Object.keys(MODULES).forEach((name) => {
      const keys = keysOf(name);
      assert(Array.isArray(keys), name + ' 的导出列表应该能拿到');
      assert(keys.length > 0, name + ' 一个导出都没有，说明提取方式失效了');
    });
  });

  test('界面层引用的模块方法全都存在', async () => {
    const problems = [];

    CONSUMERS.forEach((file) => {
      const full = path.join(JS_ROOT, file);
      if (!fs.existsSync(full)) return;
      const code = fs.readFileSync(full, 'utf8');

      Object.keys(MODULES).forEach((name) => {
        const keys = keysOf(name);
        if (!keys) return;
        // 只在这个文件确实把该模块引进来（var X = ...FEVER.X）时才检查，
        // 免得把别的文件里叫 Rules 的局部变量也算进来
        if (!new RegExp('(?:var|const|let)\\s+' + name + '\\s*=').test(code)) return;

        const re = new RegExp('\\b' + name + '\\.([A-Za-z_$][\\w$]*)', 'g');
        const seen = new Set();
        let m;
        while ((m = re.exec(code))) {
          const prop = m[1];
          if (seen.has(prop)) continue;
          seen.add(prop);
          if (keys.indexOf(prop) === -1) {
            problems.push(file + ' 用了 ' + name + '.' + prop + '，但 ' + MODULES[name] + ' 没有导出它');
          }
        }
      });
    });

    assert(problems.length === 0,
      '引用了不存在的导出（在浏览器里会变成 "xxx is not a function"）：\n      ' + problems.join('\n      '));
  });

  test('模块之间引用到的导出同样存在', async () => {
    // 只查模块自己引用的部分（上一条已经覆盖 views/actions/app），
    // 单独再走一遍是为了让"哪个文件漏导出"这件事定位得更直接
    const problems = [];
    ['rules.js', 'stats.js', 'ops.js'].forEach((file) => {
      const code = fs.readFileSync(path.join(JS_ROOT, file), 'utf8');
      Object.keys(MODULES).forEach((name) => {
        if (MODULES[name] === file) return;                     // 自己引用自己不算
        const keys = keysOf(name);
        if (!keys) return;
        if (!new RegExp('(?:var|const|let)\\s+' + name + '\\s*=').test(code)) return;
        const re = new RegExp('\\b' + name + '\\.([A-Za-z_$][\\w$]*)', 'g');
        const seen = new Set();
        let m;
        while ((m = re.exec(code))) {
          const prop = m[1];
          if (seen.has(prop)) continue;
          seen.add(prop);
          if (keys.indexOf(prop) === -1) {
            problems.push(file + ' 用了 ' + name + '.' + prop + '，但 ' + MODULES[name] + ' 没导出');
          }
        }
      });
    });
    assert(problems.length === 0, '模块间引用了不存在的导出：\n      ' + problems.join('\n      '));
  });
};
