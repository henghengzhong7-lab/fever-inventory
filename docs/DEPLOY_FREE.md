# Render 免费部署（固定域名 · 代码零改动）

> 为什么走这条：**数据在飞书多维表格，后端不存文件**，所以不需要硬盘、不需要数据库服务器。
> 只要一个「域名固定、能跑 Node」的地方。Render 免费实例满足，且**后端代码一行不用改**。
>
> 域名固定后，飞书后台的白名单**只配一次**，以后换任何托管都不再动。

---

## 0. 前置条件（各 5 分钟）

| 需要 | 说明 |
| --- | --- |
| GitHub 账号 | 已有（仓库 `henghengzhong7-lab/fever-inventory`） |
| Render 账号 | https://render.com 用 GitHub 登录；免费实例要绑卡验证，**不扣费** |
| 飞书开发者后台权限 | 能改「安全设置」并**创建版本 → 发布** |

---

## 1. 把代码推到 GitHub

本机目前访问 github.com 会被代理拦断（`schannel: server closed abruptly`）。三条路任选：

**A. 修好代理后推（推荐）**
```bash
git push -u origin main
```
> 如果提示上游分支不存在，先确认仓库还在（浏览器打开 GitHub 看一眼）；仓库被删就先新建一个空仓库，
> 再 `git remote set-url origin <新地址>` 后推。

**B. 用 GitHub Desktop**：添加本地仓库 → Publish repository（私有仓库即可）。

**C. 浏览器上传**：GitHub 仓库页 → Add file → Upload files → 拖入整个项目目录
（注意**不要**传 `node_modules/`、`server/config.json`、`server/public/`、`backup/`）。

> ⚠️ 无论哪条路，**绝不能把 `server/config.json` 或 `feishu.config.json` 提交上去**——
> 里面有 `appSecret`。`.gitignore` 已经挡住了，别手动加回来。

---

## 2. 在 Render 建服务

### 方式一：Blueprint（有 `render.yaml`，最省事）
1. Render 控制台 → **New → Blueprint**
2. 选仓库 → Render 会读到根目录的 `render.yaml` → **Apply**
3. 它会自动创建服务，并在 Environment 里留两个待填变量（见第 3 步）

### 方式二：手动建 Web Service
| 配置项 | 填什么 |
| --- | --- |
| Language / Runtime | **Node** |
| Region | Singapore（没有就选 Oregon） |
| Branch | `main` |
| Root Directory | **留空**（构建脚本要读根目录的 `scripts/`） |
| Build Command | `node scripts/build-feishu.js` |
| Start Command | `node server/index.js` |
| Health Check Path | `/api/health` |
| Instance Type | **Free** |

> 为什么 Root Directory 要留空：`build-feishu.js` 会把 `v1/` 的前端构建进 `server/public/`，
> 而 `server/public/` 是构建产物、不进仓库。构建命令必须在仓库根目录跑。

---

## 3. 填环境变量（两个）

Render 服务页 → **Environment** → Add Environment Variable：

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `FEVER_APP_ID` | `cli_aa3a183f1c789cb4` | 构建时写进前端 `feishu-config.js` |
| `FEVER_CONFIG_JSON` | **把本机 `server/config.json` 的全部内容原样粘进来** | 后端运行时配置（含 appSecret、表格 token、管理员名单） |

`server/config.json` 长这样，整段粘贴即可（一行也行）：
```json
{
  "appId": "cli_...",
  "appSecret": "...",
  "bitableAppToken": "...",
  "tableIds": { "items": "tbl...", "...": "..." },
  "admins": ["陈亮", "钟德恒", "赵嘉贺"],
  "sessionHours": 12
}
```

> 不想整段粘？也可以分开填 `FEVER_APP_SECRET`、`FEVER_BITABLE_TOKEN`、`FEVER_ADMINS`
> （逗号分隔）。`tableIds` 不用填——服务端会自动从多维表格里发现表 ID。

填完点 **Manual Deploy → Deploy latest commit**。

---

## 4. 部署成功怎么验证

拿到域名（形如 `https://fever-inventory-xxxx.onrender.com`）后，本机执行：

```bash
# ① 服务活着，且能连上飞书
curl https://你的域名/api/health
#   期望：{"ok":true, ..., "feishuReachable":true}

# ② 无令牌必须被拒（说明鉴权生效）
curl -i https://你的域名/api/data
#   期望：HTTP 401，{"ok":false,"message":"登录状态已失效..."}

# ③ 前端是修复版（应有 3 处）
curl https://你的域名/js/db-remote.js | grep -c KEEPALIVE_MAX_BYTES
#   期望：3
```

三项都对，说明后端和前端都正常。

---

## 5. 保活（解决免费实例休眠）

免费实例 15 分钟无流量会休眠，下次打开要等 30–60 秒。用免费监控每 5 分钟打一次就没事：

1. 注册 https://uptimerobot.com（免费 50 个监控）
2. **Add New Monitor** → Monitor Type: **HTTP(s)**
3. URL 填 `https://你的域名/api/health`
4. Interval: **5 minutes** → 保存

> 这一步让实例一直热着，队员扫码不会遇到冷启动。

---

## 6. 飞书后台改域名（只做一次）

飞书开发者后台 → 你的应用：

1. **安全设置 → 重定向 URL**：把新域名加进去（保留原来的，验证通过后再删）
   `https://你的域名/`
2. **安全设置 → H5 可信域名**：填 `https://你的域名`（**要带 https://，不带路径**）
3. **版本管理与发布 → 创建版本 → 申请发布**（权限没变也要发一次新版本，配置才生效）
4. 等审核通过（自建应用通常几分钟）

> 为什么必须带 `https://` 且不带路径：飞书按完整 origin 校验，写错会静默失败，
> 表现是「扫码/免登没反应」而不是报错。

---

## 7. 上线后的四步实测（老规矩）

1. 逐字节比对：本地 `server/public` 与线上 `/js/*.js` 一致
2. 特征串：本轮修复的 `KEEPALIVE_MAX_BYTES` **应该存在**
3. `/api/data` 无令牌 → **401**
4. `/api/health` 的 `uptimeSec` 很小 → 是新容器

然后**用手机在飞书里打开**，做一次真实的：入库 → 删除 → 借出 → 归还。

---

## 8. 已知限制（必须知道）

| 限制 | 影响 | 应对 |
| --- | --- | --- |
| **发票 PDF 存在 `server/uploads/`** | 免费实例**重启/重新部署后文件丢失**，历史发票打不开 | 发票 PDF 另存网盘；后续可改存飞书云文档 |
| 15 分钟休眠 | 冷启动 30–60 秒 | 第 5 步保活 |
| 免费实例 750 小时/月 | 一个服务 24/7 = 730 小时，刚好够 | 别开第二个常驻服务 |
| 出站带宽 100GB/月 | 正常使用远不到 | — |
| 国内访问速度 | 比国内机房慢（100–300ms） | 可接受；以后有条件换国内服务器 |

---

## 9. 回滚

Render 服务页 → **Deploys** → 选上一个成功的部署 → **Rollback**。
或者本地 `git revert` 后重新推。

---

## 10. 数据备份（别忘）

部署完照样每周跑一次：

```bash
node scripts/backup-data.js D:/你的网盘目录
```

它会从线上拉全量数据，产出可导入恢复的 JSON + 两份 CSV。
