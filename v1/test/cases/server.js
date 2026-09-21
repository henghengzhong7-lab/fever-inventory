/**
 * 启动方式自检。
 *
 * 最重要的一条：端口必须固定。
 * 浏览器把 IndexedDB 按「协议 + 主机 + 端口」分开存，端口一变就是另一套数据库，
 * 使用者会以为数据丢了。所以这里盯着 server.js，不许它偷偷换端口。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER = path.resolve(__dirname, '..', '..', 'server.js');
const ROOT = path.resolve(__dirname, '..', '..', '..');

module.exports.register = function (H) {
  const { test, assert, assertEqual } = H;
  const code = fs.readFileSync(SERVER, 'utf8');

  test('启动脚本语法正确', async () => {
    new vm.Script(code, { filename: SERVER });
  });

  test('默认端口固定为 8321，且没有"端口被占就自动换"的逻辑', async () => {
    assert(/const DEFAULT_PORT = 8321;/.test(code), '默认端口应固定写成 8321');
    // 有条注释专门讲这件事，代码里也真的不再递增端口
    assert(!/startPort \+ attempt/.test(code), '不允许再出现"端口逐次加一"的换端口逻辑');
    assert(!/PORT_TRIES/.test(code), '不该再有重试换端口的上限常量');
  });

  test('端口被占用时给出明确提示，而不是静默换端口', async () => {
    assert(code.includes('EADDRINUSE'), '应显式处理端口被占用');
    assert(code.includes('已经在运行'), '被自己占用时应提示"已经在运行"');
    assert(code.includes('换端口会看不到原来的数据'), '应警告换端口的后果');
  });

  test('启动时打印的地址里写明端口，并提醒始终用同一个端口', async () => {
    assert(code.includes('请始终用这个地址'), '应提醒使用者固定用同一个地址');
    assert(/http:\/\/127\.0\.0\.1:' \+ port \+ '\/index\.html/.test(code), '应打印带端口的完整地址');
  });

  test('只监听本机，不监听局域网（不联网要求）', async () => {
    assert(/server\.listen\(startPort, '127\.0\.0\.1'/.test(code), '应只绑定 127.0.0.1');
    assert(!/0\.0\.0\.0/.test(code), '不该监听 0.0.0.0');
    // bat 里那个 nodejs.org 是"没装 Node 时"的提示链接，不属于应用自身联网
    const urls = code.match(/https?:\/\/[^\s'"]+/g) || [];
    urls.forEach((u) => {
      assert(u.startsWith('http://127.0.0.1'), 'server.js 不该出现外网地址，实际有 ' + u);
    });
  });

  test('双击启动的 bat 存在且指向 v1\\server.js', async () => {
    const bat = path.join(ROOT, '启动物资管理.bat');
    assert(fs.existsSync(bat), '根目录应有「启动物资管理.bat」');
    const text = fs.readFileSync(bat, 'utf8');
    assert(text.includes('v1\\server.js'), 'bat 应启动 v1\\server.js');
    assert(text.includes('chcp 65001'), 'bat 应设置 UTF-8，避免中文乱码');
  });
};
