/**
 * 语法自检：把 js 目录下所有脚本交给 Node 做一次解析。
 * 这样界面脚本里的低级语法错误也能在自动测试阶段被抓住，
 * 不用等打开浏览器才发现。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS_ROOT = path.resolve(__dirname, '..', '..', 'js');

function listJs(dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(full));
    else if (ent.name.endsWith('.js')) out.push(full);
  });
  return out;
}

module.exports.register = function (H) {
  const { test, assert } = H;

  const files = listJs(JS_ROOT);

  test('js 目录下至少包含全部页面脚本', async () => {
    const names = files.map((f) => path.basename(f));
    ['db.js', 'rules.js', 'ops.js', 'stats.js', 'ui.js', 'qr.js', 'views.js',
      'views-commerce.js', 'actions.js', 'app.js'].forEach((n) => {
        assert(names.includes(n), '应存在脚本 ' + n);
      });
  });

  files.forEach((file) => {
    const rel = path.relative(JS_ROOT, file).replace(/\\/g, '/');
    test('语法检查 js/' + rel, async () => {
      const code = fs.readFileSync(file, 'utf8');
      // 只做语法解析，不执行（app.js 依赖浏览器环境）
      new vm.Script(code, { filename: file });
    });
  });
};
