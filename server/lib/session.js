'use strict';

/**
 * 会话令牌 —— 自签名的无状态令牌
 *
 * 为什么不用「发一个随机串、存在服务端 Map 里」这种常见写法：
 *   那种令牌的生命周期绑在**某一个进程的内存**上。托管环境会重启进程（重新发布、
 *   空闲回收、崩溃拉起），只要进程一换，所有队员手里的令牌立刻失效 ——
 *   现象就是打开应用报「登录状态已失效」，但重新登录又好了，反复出现。
 *
 * 这里改成把身份信息本身写成载荷、再用服务端密钥签名：
 *   token = base64url(载荷) + '.' + base64url(HMAC-SHA256(载荷))
 * 校验只需要密钥，不需要记住任何东西。进程换了、实例多了都照样认。
 * 密钥不落盘（由 appSecret 派生），所以「重新发布」也不会把大家踢下线。
 *
 * 载荷本身是可读的（base64 不是加密）——里面只放 openId / 姓名 / 过期时间，
 * 这些信息本来就会显示在前端界面上，不构成额外泄露。真正的防伪靠签名：
 * 改一个字节，签名就对不上。
 */

const crypto = require('node:crypto');

/** 密钥派生的固定前缀。换掉它会一次性作废所有已发出的令牌 */
const DERIVE_LABEL = 'fever-inventory/session/v1';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * 从配置里取签名密钥。
 * 优先用显式的 sessionSecret（方便轮换）；没配就从 appSecret 派生 ——
 * appSecret 本来就是这个服务最核心的机密，且重新部署时不变，正好合适。
 */
function secretOf(cfg) {
  if (cfg.sessionSecret) return String(cfg.sessionSecret);
  return crypto.createHmac('sha256', DERIVE_LABEL).update(String(cfg.appSecret)).digest('hex');
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + mac;
}

/**
 * 校验令牌。任何一处不对都返回 null（不区分「过期」和「伪造」，
 * 免得给攻击者额外信息）。调用方拿到 null 就回 401。
 */
function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());

  // 定长比较，避免按字节提前返回泄露信息
  const got = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return null;
  if (!crypto.timingSafeEqual(got, want)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !payload.openId) return null;
  if (!payload.exp || Date.now() > payload.exp) return null;

  return {
    openId: payload.openId,
    name: payload.name || '',
    avatarUrl: payload.avatarUrl || '',
    expiresAt: payload.exp
  };
}

/** 给某个用户签发令牌 */
function issue(cfg, user) {
  const hours = Number(cfg.sessionHours) || 12;
  return sign({
    openId: String(user.openId || ''),
    name: String(user.name || ''),
    avatarUrl: String(user.avatarUrl || ''),
    iat: Date.now(),
    exp: Date.now() + hours * 3600 * 1000
  }, secretOf(cfg));
}

module.exports = {
  issue: issue,
  verify: verify,
  secretOf: secretOf
};
