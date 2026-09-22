'use strict';

/**
 * 会话令牌的单元测试 —— 重点是「跨进程」
 *
 * 之所以专门有这一条：线上最初用的是「发随机串、存在服务端 Map 里」的写法，
 * 服务端进程一重启（重新发布、空闲回收），所有队员手里的令牌就全失效，
 * 打开应用直接报「登录状态已失效」。
 * 所以这里必须验证：同一个令牌，在**另一个进程**里也能校验通过。
 *
 * 用法：node test-session.js
 */

const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const session = require('./lib/session');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.log('  ✗ ' + label + (detail ? '\n      → ' + detail : ''));
  }
}

// 用一份不依赖真实 config.json 的配置跑，避免把测试绑在具体凭证上
const CFG = { appSecret: 'test-app-secret-for-unit-test', sessionHours: 12 };

const USER = { openId: 'ou_unit_test', name: '单元测试', avatarUrl: 'https://example.com/a.png' };

console.log('会话令牌测试');

const token = session.issue(CFG, USER);

check('签发的令牌是 载荷.签名 两段结构', token.split('.').length === 2, token.slice(0, 40));
check('载荷是 base64url（不含 + / =）', !/[+/=]/.test(token.split('.')[0]), token.split('.')[0]);

const parsed = session.verify(token, session.secretOf(CFG));
check('自己签的令牌能校验通过', !!parsed);
check('身份信息（openId）能原样取回', parsed && parsed.openId === USER.openId, parsed && parsed.openId);
check('姓名能原样取回', parsed && parsed.name === USER.name, parsed && parsed.name);

/* ---- 各种非法输入都应该被拒 ---- */

check('空令牌被拒', session.verify('', session.secretOf(CFG)) === null);
check('null 被拒', session.verify(null, session.secretOf(CFG)) === null);
check('没有签名段的令牌被拒', session.verify('abcdef', session.secretOf(CFG)) === null);

// 改掉载荷里的一个字符，签名就对不上
const [body, mac] = token.split('.');
const tamperedBody = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
check('载荷被篡改的令牌被拒', session.verify(tamperedBody + '.' + mac, session.secretOf(CFG)) === null);

// 自己造一个载荷、但不改签名
const forged = Buffer.from(JSON.stringify({ openId: 'ou_hacker', name: '冒充者', exp: Date.now() + 1e9 }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
check('伪造载荷（拿不到密钥）被拒', session.verify(forged + '.' + mac, session.secretOf(CFG)) === null);

// 换一个 appSecret 就等于换密钥
check('换了密钥就校验不通过',
  session.verify(token, session.secretOf({ appSecret: 'another-secret' })) === null);

// 过期
const expired = session.issue({ appSecret: CFG.appSecret, sessionHours: -1 }, USER);
check('已过期的令牌被拒', session.verify(expired, session.secretOf(CFG)) === null);

/* ---- 关键：跨进程 ---- */

const script = [
  'const session = require(' + JSON.stringify(path.join(__dirname, 'lib', 'session.js')) + ');',
  'const parsed = session.verify(process.argv[1], session.secretOf(' + JSON.stringify(CFG) + '));',
  'process.stdout.write(parsed ? JSON.stringify(parsed) : "null");'
].join('\n');

let crossProcess = null;
let crossErr = '';
try {
  const out = execFileSync(process.execPath, ['-e', script, token], { encoding: 'utf8' });
  crossProcess = out === 'null' ? null : JSON.parse(out);
} catch (err) {
  crossErr = err.message;
}

check('令牌在另一个进程里同样有效（服务重启不掉线）',
  !!(crossProcess && crossProcess.openId === USER.openId),
  crossErr || '另一个进程返回 null');

/* ---- 密钥来源 ---- */

check('未配 sessionSecret 时由 appSecret 派生',
  session.secretOf(CFG) === session.secretOf(CFG) && session.secretOf(CFG).length === 64);
check('配了 sessionSecret 就优先用它',
  session.secretOf({ appSecret: 'x', sessionSecret: 'explicit' }) === 'explicit');

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
