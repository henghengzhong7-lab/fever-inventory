# 2026-10-07 改动日志（第二十四 ~ 第二十九轮）

> 只记**做了什么、为什么**；踩坑与规矩见 `docs/HANDOFF_2026-10-07.md` 与 `.workbuddy/memory/`。

## 第二十四轮 —— 同名归同一大类 + 视觉类不做标定（已上线 15:04）

**需求**：① 相同名称的东西要所属一类；② 视觉的物品不需要标定，直接删除。

- `v1/js/rules.js`：新增纯函数 `nameKey()`（归一化：忽略首尾/全角空格、连续空白、英文大小写）与 `sameNameItems()`。
- `v1/js/actions.js`：`openNewItem` 改为读 items → 名称输入防抖 200ms → 查同名 → **自动把大类切到同名物品所在处**并提示；使用者手动改过大类后不再自动切（`categoryTouched`）。切大类会重建表单，故加 `snapshotForm`/`restoreForm` 保住已填内容。
- `v1/js/app.js`：`openEditItem` 改名撞名**只提示**（排除自己）。
- `v1/js/rules.js` 的 `CATEGORY_DEFS`：视觉类 `calibrationDays: 0`，并从专属字段摘掉「标定状态」。
- `v1/js/rules.js`：新增 `fixVisionCalibration()`——**定向、幂等**的迁移（只动视觉类那两个键，已是新样子就不写库）。因为 `initCategories` 只补缺的大类、不覆盖已有的，只改默认值对老库无效。
- `v1/js/modules/vision.js`：删掉标定看板、标定列、标定筛选、卡片指标、详情里的标定两行与提醒块，以及 `calibrationState()` / `calibrationBoard()`。
- 同步 6 处盯着标定的既有测试（模块/联动/首页/四大类页）。
- 修复：`switchCategory` 回填时把旧 `categoryId` 写回去（表现为"点了没反应"）→ 切之前 `delete snap.categoryId`。

## 第二十五轮 —— 兵种扩充 + 预算口径（已上线 15:04）

**需求**：① 兵种里再加「英雄」「小轮腿」；② 兵种预算里加上其他已经花了的。

- `v1/js/rules.js`：`TROOPS` 加 `小轮腿`（跟轮腿类后）与 `英雄`（跟三个机器人后）。同步 `cases/troop.js` 的完整兵种表与 PRD 清单。
- 问过用户"加上哪笔钱"→ 选「直接入库花的钱」。
- `v1/js/stats.js`：`budgetSummary` / `budgetCsv` 增加 `items` 参数与 `direct` 档（物品总价按物品上的兵种归集，按 `createdAt` 参与范围筛选，没填价/填 0/乱填不计）；`spent = used + direct`，`remaining / usage / over` 全部改用 spent；total 同步加 `direct`/`spent`。
- `v1/js/views-commerce.js`：预算页读 items、指标与表格显示 `spent` 并摊开构成。
- `v1/js/app.js`：导出 CSV 处补 `T.getAll('items')`。
- 测试：`cases/budget.js` +7 项；同步 2 处"预期变更"的断言。

## 第二十六轮 —— 物品编码改由服务端发号（已上线 15:13）

**问题**：编号被占用 + 添加物品卡顿。

- 诊断：`computeSequences` 只管各表记录 id，**物品编码序号一直由前端在本机算** → 两人同时添加都算出同一个号 → 服务端 409 → 前端提示"请重新操作一次"并重拉全量（1.4s）。
- 问过用户"发号怎么做"→ 选「服务端发号 + 本地领一段」。
- `server/index.js`：新增 `allocateCodes(prefix, count, actor)`（**不进队列**，`enqueue` 内再 `enqueue` 会死锁）与 `POST /api/reserve-codes`；水位存 settings 的 `codeCounter:<前缀>`，走 `applyOps` **落库** → 重启不重发旧号。
- `v1/js/db.js`：新增 `nextCodes(prefix, count)`（原本在 rules 里）。
- `v1/js/rules.js`：`nextCodes` 改为委托 `DB.nextCodes`；删死代码 `pad4` / `counterKey`。
- `feishu/js/db-remote.js`：内存号池（`RESERVE_CHUNK = 20`），池够就 0 网络；**不放 localStorage**（同设备两个标签页会从同一段取号）。
- 抽出公共内核 `allocateSpan(counterKey, count, computeBase, actor)`；前缀校验 `/^[A-Z]{1,4}$/`。
- 新增 `server/test-reserve.js`（18 项）：老库从最大号往后发、水位确实落库、**模拟重启不重发旧号**、**两请求零重叠**、不同前缀互不干扰、非法前缀被拒。
- 飞书层新增 [18] 段（13 项）：领一段后不再打网络、号不重复、**新段与旧段不重叠**（`[1,20]→[21,40]`）、入库仍只发一个写请求。
- **两份假后端都加了新接口**（只加一份会让另一套测试跑不起来）。
- 代价：编码会跳号。

## 第二十七轮 —— 预算里能看"直接入库"的明细（已上线 15:13）

**需求**：兵种预算里不能看直接入库的详情，要能看。

- `v1/js/actions.js`：新增 `openDirectItems({troop, range})`，列出该兵种**填了总价**的物品（编码/名称规格/总价/入库时间/添加人 + 件数合计），每条编码可点进物品详情；时间范围复用 `Stats.rangeStart`（与预算表同口径）。
- 决定做弹框而非跳页面：兵种跨大类，物品清单页是按大类的、也没有兵种筛选。
- `v1/js/views-commerce.js`：「入库 ¥X」改为可点按钮 `data-budget-direct`。
- `v1/js/app.js`：分发到 `Forms.openDirectItems`。
- 弹框里点编码跳转时**自己关弹框**（全局分发只 goto、不关弹框，否则弹框盖在新页面上像"点了没反应"）；顺手补 `[data-cancel]` 的手动绑定。
- 测试：扩展既有的预算用例（标题/兵种/物品名/件数合计/添加人 + 点编码跳详情且弹框已关）。

## 第二十八轮 —— 记录 id 也由服务端发号（已上线 16:46）

**用户反馈**："现在还会出现编号占用的问题，还不如改之前好呢"。

- **根因（我上一轮漏掉的一半）**：申请号/发票号/流水号仍是前端本机计数器分配的（`db-remote.js` 的 `allocateKey`：`id = counters[store] || maxId+1`），而**每次添加物品都会写一条入库流水** → 两人同时添加几乎必然撞同一个流水 id。编码撞号要"同前缀同号"（概率小），流水 id 是几乎必撞。
- `server/index.js`：新增 `allocateIds(store, count, actor)` 与 `POST /api/reserve-ids`；水位键 `idCounter:<表名>`；非自增表直接 400。
- `feishu/js/db-remote.js`：新增 `idPool` / `takeIds` / `ensureRowId`，`T.add` / `T.put` 改为先领 id 再定主键。**段大小取 5**（记录号显示给使用者看，一次领 20 会跳过一大段）；`loadAll` 成功后 `prewarmIds()` 预热。
- 两道防御：**服务端算水位取 `max(水位, 数据实际最大值)`**；**前端取号时跳过本地镜像里已存在的号**。
- `server/test-reserve.js` 加 [8] 段（8 项，含"水位落后于数据时取数据最大值"）；飞书层加 [19] 段（3 项）。
- 修掉的测试暴露问题：`ConstraintError: 主键 12`（池子预留号与本地已有记录撞）→ 就是上面那两道防御。

## 第二十九轮 —— 卡顿修复（**已就绪，未上线**）

**用户反馈**："我一个人用都特别卡"、"点开物品详情也很慢"、"连着点也每次都慢"。

### 第一次尝试：预热把号池抽干
- `prewarmIds` 写成 `takeIds(name, 1)`——那是**消费**（取走一个号）、返回值还被丢掉 → 每次 `loadAll` 白扔 3 个号 → 池子见底 → 每次写记录都要真去领号（一次飞书写往返）→ 单人卡。
- 改为 `fillIdPool()`（只补不消费 + `idFilling` 防并发），段 5→10，`ID_POOL_LOW = 3` 时后台补。**已上线**。

### 第二次尝试：找到真正的死循环
- 先量后猜：线上 `/api/data` 62ms、数据量极小、详情页不发网络请求、只读事务直接返回、无轮询、写入后不重拉全量 → 静态找不到慢点 → 回头复查自己的号池代码。
- **根因**：`takeIds` 里"过滤本地已占用号" + "池低就补" + "递归"三者叠加 → 池里领来的号与本地镜像重叠时（改系统之前本机计数器造号的老数据，线上真实存在）无限领号，每步一次 HTTP 请求。
- **修法**（三条缺一不可）：不递归（最多领一次）；过滤只在领号时做一次；补池节流 `ID_FILL_COOLDOWN = 30000`。抽出 `fetchIds()` 作为唯一发领号请求处。
- 修的过程中还犯了个错：整块替换时把 `ensureRowId` 一起吞掉了，测试当场抓住并补回。
- 测试：飞书层加 [21] 段（2 项，直接钉此 bug：3 次写入期间领号请求 **0 次**；新号避开被占用的号）。→ 飞书层 **101 项**。
- ⚠️ 一个测试项跑不了：`test-session.js` 的"令牌跨进程有效"需要 spawn 子进程，本机 `spawnSync(process.execPath)` 返回 **EBUSY**，与本次改动无关。
- 尝试加"性能探针"到 `feishu/test/async-cases.js`，但那个测试页只加载数据层、`window.FEVER.App` 不存在，探针永远跳过 → 已从仓库中移除（该文件现只保留第十四轮的历史改动）。
- **上线状态**：`dist-feishu` 已含修复，`server/public`（发布目录）不含 → 差一步 `build-feishu.js`。用户选择"前端先不动"，故未发布。
- 环境变化：Node 运行时目录从 `22.22.2-3` 变为 `22.22.2-6`。
