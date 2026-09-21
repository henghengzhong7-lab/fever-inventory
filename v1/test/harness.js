/**
 * 极简测试框架：不依赖任何外部包，跑在 Node 里。
 * 提供 test(name, fn)、assert 系列、以及每个测试前清库的 hooks。
 */
'use strict';

const results = [];
let currentFile = '';

function test(name, fn) {
  results.push({ name, fn, file: currentFile });
}

function setFile(name) {
  currentFile = name;
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || '值不相等') + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((message || '结构不相等') + '：期望 ' + b + '，实际 ' + a);
  }
}

function assertMatch(text, re, message) {
  if (!re.test(String(text))) {
    throw new Error((message || '格式不匹配') + '：' + JSON.stringify(text) + ' 不匹配 ' + re);
  }
}

async function assertRejects(fn, message) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
  }
  if (!threw) throw new Error(message || '期望操作被拒绝，但成功了');
}

async function run() {
  let passed = 0;
  const failures = [];
  for (const t of results) {
    try {
      await t.fn();
      passed += 1;
      console.log('  \u2713 ' + t.name);
    } catch (err) {
      failures.push({ name: t.name, file: t.file, err });
      console.log('  \u2717 ' + t.name);
      console.log('      ' + (err && err.message ? err.message : err));
    }
  }
  console.log('');
  console.log('--------------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项，共 ' + results.length + ' 项');
  if (failures.length) {
    console.log('失败清单：');
    failures.forEach((f) => console.log('  - ' + f.name + '（' + f.file + '）: ' + f.err.message));
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
}

module.exports = { test, setFile, assert, assertEqual, assertDeepEqual, assertMatch, assertRejects, run };
