'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const files = require('./pages-files.js');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'v1');
const outputRoot = path.join(projectRoot, 'dist');
const manifestPath = path.join(outputRoot, 'INTEGRITY.sha256');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(manifestPath)) {
  throw new Error('缺少 dist/INTEGRITY.sha256，请先运行 npm run build:pages');
}

const manifest = new Map(
  fs.readFileSync(manifestPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match) throw new Error(`完整性清单格式错误：${line}`);
      return [match[2], match[1]];
    })
);

for (const file of files) {
  const source = path.join(sourceRoot, file);
  const output = path.join(outputRoot, file);
  if (!fs.existsSync(output)) throw new Error(`发布产物缺少文件：${file}`);
  const sourceHash = hash(source);
  const outputHash = hash(output);
  if (sourceHash !== outputHash) throw new Error(`源码与发布产物不一致：${file}`);
  if (manifest.get(file) !== outputHash) throw new Error(`完整性清单不匹配：${file}`);
}

if (manifest.size !== files.length) {
  throw new Error(`完整性清单文件数量异常：${manifest.size}，预期 ${files.length}`);
}

console.log(`发布完整性校验通过：${files.length} 个运行时文件逐字节一致。`);
