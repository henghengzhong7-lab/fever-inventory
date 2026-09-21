'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const files = require('./pages-files.js');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'v1');
const outputRoot = path.join(projectRoot, 'dist');

function copyFile(relativePath) {
  const source = path.join(sourceRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
for (const file of files) copyFile(file);
fs.writeFileSync(path.join(outputRoot, '.nojekyll'), '');

const manifest = files.map((file) => {
  const contents = fs.readFileSync(path.join(outputRoot, file));
  const hash = crypto.createHash('sha256').update(contents).digest('hex');
  return `${hash}  ${file}`;
}).join('\n') + '\n';
fs.writeFileSync(path.join(outputRoot, 'INTEGRITY.sha256'), manifest);

console.log(`GitHub Pages 静态产物已生成：${path.relative(projectRoot, outputRoot)}`);
console.log(`已复制 ${files.length} 个运行时文件，并排除测试、缓存和本地服务端文件。`);
