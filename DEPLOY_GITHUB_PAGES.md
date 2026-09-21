# GitHub Pages 上线与飞书接入

## 〇、线上地址（当前状态）

| 项目 | 值 |
| --- | --- |
| 仓库 | https://github.com/henghengzhong7-lab/fever-inventory |
| 分支 | `main` |
| 访问地址 | **https://henghengzhong7-lab.github.io/fever-inventory/** |
| Pages 来源 | `GitHub Actions`（由工作流自动开启，无需手工设置） |

注意：末尾的 `/` 不能省略。仓库名不是 `henghengzhong7-lab.github.io`，所以这是「项目站点」，必须带 `/fever-inventory/` 路径。

## 一、当前版本的边界

这版应用是纯静态前端，数据使用浏览器 `IndexedDB` 保存。部署到 GitHub Pages 后：

- 可以获得一个公网 HTTPS 地址，并在飞书网页应用中打开。
- 同一台设备、同一浏览器、同一个域名下的数据可以持续保存。
- 不同队员、不同浏览器或不同设备之间不会自动共享库存数据。
- 当前版本不包含飞书登录，也不包含云端数据库。

如果要让全队共用一套库存，需要下一阶段增加后端 API、用户身份和云端数据库；仅部署静态页面无法解决数据同步问题。

## 二、发布到 GitHub Pages

### 1. 创建仓库

在 GitHub 新建一个仓库，例如 `fever-inventory`。如果使用 GitHub Free，仓库建议设为公开。本仓库已建好：`henghengzhong7-lab/fever-inventory`（公开）。

不要把 `v1/_m0/`、浏览器缓存、备份文件或包含真实物资数据的文件提交到仓库。

### 2. 首次提交并推送

在项目根目录执行：

```powershell
git init
git add .
git commit -m "prepare GitHub Pages deployment"
git branch -M main
git remote add origin https://github.com/henghengzhong7-lab/fever-inventory.git
git push -u origin main
```

推送后，`.github/workflows/pages.yml` 会自动构建并发布 `dist`。工作流按顺序执行：

1. `npm ci` 安装依赖（**必需**：测试依赖 `fake-indexeddb`，不装会在测试步骤报 `Cannot find module 'fake-indexeddb/auto'`）。
2. `npm run build:pages` 生成 `dist`。
3. `npm run verify:pages` 逐字节校验 `v1` 与 `dist`。
4. `npm test` 与 `npm --prefix v1 test` 跑测试。
5. `actions/configure-pages`（`enablement: true`）自动开启 Pages。
6. `actions/upload-pages-artifact` + `actions/deploy-pages` 发布。

### 3. 打开 Pages

**通常不需要手工操作**：工作流里的 `actions/configure-pages@v5` 带 `enablement: true`，第一次运行时会自动把 `Settings` → `Pages` 的 `Source` 设为 `GitHub Actions`。

如果要手工确认或修改，进入 GitHub 仓库的 `Settings` → `Pages`：

1. `Build and deployment` 的 `Source` 选择 `GitHub Actions`。
2. 等待 `Deploy to GitHub Pages` 工作流完成。
3. 项目地址是：

```text
https://henghengzhong7-lab.github.io/fever-inventory/
```

如果仓库名是 `<你的账号>.github.io`，地址则是：

```text
https://<你的账号>.github.io/
```

### 4. 本地预览发布产物

```powershell
npm run build:pages
node v1/server.js --no-open
```

发布前可以检查 `dist` 是否只包含运行时文件。`dist` 默认被 `.gitignore` 排除，因为线上由 GitHub Actions 生成。

## 三、配置飞书开放平台

在飞书开放平台创建“网页应用”或企业内部使用的网页应用：

1. 将 GitHub Pages 地址填入应用的“首页地址/应用主页”一类配置：
   `https://henghengzhong7-lab.github.io/fever-inventory/`。
2. 如果平台要求配置可信域名，填主机名，不要填路径：`henghengzhong7-lab.github.io`，而不是完整 URL。
3. 如果平台要求重定向地址，填写完整 HTTPS 地址，并使用最终会访问的路径：
   `https://henghengzhong7-lab.github.io/fever-inventory/`。
4. 发布或启用应用后，将应用分配给测试人员或企业内部成员。
5. 在飞书客户端中打开应用，验证首次初始化、扫码、导出备份和刷新后的数据持久化。

GitHub Pages 自带 `github.io` HTTPS 域名，通常可以先用于测试。若企业要求自有域名，可在 GitHub Pages 中配置自定义域名，并在域名 DNS 服务商处添加 GitHub 要求的 DNS 记录，再开启 HTTPS 强制跳转。

## 四、上线前必须确认

- 当前数据不是团队共享数据；不要把它当作多人同时编辑的正式库存系统。
- GitHub 仓库和 Pages 网站默认公开，仓库里不要提交采购价格、供应商、成员信息或真实备份文件。
- 在飞书内使用时，每位用户可能拥有独立的浏览器存储；不要用不同设备分别录入同一份库存。
- 上线前先用测试数据验证二维码扫描权限、浏览器 IndexedDB、导出备份和导入恢复。

## 五、避免代码和发布结果被篡改

GitHub Pages 的发布只读取 `main` 分支；工作流会先逐字节比对 `v1` 与 `dist`，再执行测试。建议同时在 GitHub 仓库设置：

- 保护 `main` 分支：禁止直接推送，要求 Pull Request 和检查通过后才能合并。
- 只给必要人员写权限，开启 GitHub 账号双重验证，不在仓库提交任何 Token 或密钥。
- `Settings` → `Pages` 只保留 `GitHub Actions` 发布来源，不要手工上传另一套页面。
- 每次发布前检查 Actions 的完整性校验和测试结果；任一步失败，页面不会更新。
- 需要回滚时只回滚到已验证的提交，不直接修改线上文件。

需要注意：静态网页的 JavaScript 会发送到用户浏览器，用户可以在自己的浏览器开发者工具里临时修改页面。这不等于 GitHub Pages 上的源文件被改动；如果要防止用户伪造库存、审计操作或绕过权限，必须把数据校验和权限放到后端，不能只依赖前端代码。

## 六、下一阶段建议

如果目标是“全队在飞书里共用一套物资数据”，建议保留 GitHub Pages 作为前端，增加：

1. 云端数据库：物品、库存流水、采购申请、借用记录。
2. 后端 API：增删改查、库存事务和备份接口。
3. 飞书身份认证：按成员身份记录操作人，并按角色授权。
4. 并发控制：避免两个人同时出库导致库存数量错误。
