# 人情录 · Cloudflare 单域名版

> 把「人情录」（原飞牛 OS 应用）的前端与接口搬到 **Cloudflare**：静态页面、API、数据库全在 Cloudflare 上，数据存进你自己的 **D1**，不依赖 NAS、不依赖任何服务器。
>
> 在线示例（本仓库 owner）：<https://rq.fuxicun.top>　演示账号：（手机号 18000000000，密码 12345678）
>
> **fork 本仓库后，照着下面的「控制台部署（推荐）」在网页上点几下即可上线**，不用装命令行、不用手工建表——Worker 首次访问会自动建齐所有表。

---

## 目录

- [核心功能](#核心功能)
- [部署前须知](#部署前须知)
- [控制台部署（推荐，全程网页操作）](#控制台部署推荐全程网页操作)
- [命令行部署（进阶）](#命令行部署进阶)
- [wrangler.toml 配置说明](#wranglertoml-配置说明)
- [管理后台](#管理后台)
- [日常使用](#日常使用)
- [备份与迁移](#备份与迁移)
- [API 一览](#api-一览)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [版权与致谢](#版权与致谢)

---

## 核心功能

- **手机号 + 密码账号**：注册后 7 天免登录，任意设备登录同一手机号看到同一本账。密码以加盐哈希存在你自己的 D1，服务端不存明文。
- **游客模式**：不注册也能记，数据存在本机浏览器；注册时自动并入账号。
- **微信小程序 / 第三方客户端**：设置页生成接口密钥（`X-Api-Key`），与网页端读写同一本账。
- **统计分析**：收支总览、往来联系人、年度报告、账本导出（Excel 表格 `.xls`，兼容 CSV）。
- **AI 记账**：配置自己的大模型 API Key，用自然语言批量记一笔（支持浏览器直连兜底应对限流）。
- **个人中心**：头像菜单里改昵称、改密码、换绑定手机号（账本数据自动迁移）。
- **意见反馈 & 忘记密码**：账本内「写反馈」直达开发者；登录页「忘记密码」可一键发信给管理员邮箱、或提交**站内重置申请**（无需登录），由管理员在后台处理。
- **管理后台 `/admin`**：管理所有用户（含帮用户重置密码）、按账号编辑任意用户的数据/配置、单账号独立导入导出、全站备份还原、查看全栈操作日志、**查看并处理意见反馈与密码重置申请**、设置忘记密码用的**联系邮箱**。

## 部署前须知

- 需要：一个 **Cloudflare 账号**（免费版够用）+ 一个 **GitHub 账号**（用来 fork 本仓库）。
- 费用：免费额度足够个人/家庭自用（Workers + D1 都有免费层）。
- 本项目**无需本地构建前端**：`www/` 里是编译好的静态文件，已随仓库提交。
- 上游原项目不公开前端源码，本项目用的是其编译产物并做了云端适配；如需重建前端，保持 `/api/*` 契约与 `www/index.html` 中的 `fetch` 注入逻辑即可。
- **密钥不入仓库**：本仓库为**公开仓库**，`ADMIN_KEY`、`JWT_SECRET` 等敏感值**不写在任何代码/配置/文档里**，一律在 Cloudflare 后台以「加密 Secret」设置与保管（见第 4 步）。仓库里只有"怎么设"的说明，没有值本身。

## 控制台部署（推荐，全程网页操作）

### 第 1 步：创建 D1 数据库

1. 打开 <https://dash.cloudflare.com> → 左侧 **Databases → D1**（找不到就在顶部搜索框输入 `D1`）。
2. **Create database**，名称随意（如 `ledger`），Region 随意。
3. 创建完成后，页面会显示 **Database ID（UUID）**——**复制备用**，下一步要填。

> 表结构不用手动建：Worker 上线后第一次 API 请求会自动建齐（`schema.sql` 仅在你坚持手工建表时才需要，可用控制台的 **Remote → Queries** 粘贴执行）。

### 第 2 步：fork 仓库并填入数据库 ID

1. 在本仓库 GitHub 页面点右上角 **Fork**，fork 到你自己的账号。
2. 在你 fork 的仓库里打开 `wrangler.toml`（网页上点铅笔图标编辑），把 `database_id` 换成第 1 步复制的 UUID：

   ```toml
   name = "xiaozhou-ledger-web"     # Worker 名，可改，但要与后面创建 Worker 时一致

   [[d1_databases]]
   binding = "DB"
   database_name = "ledger"          # 你第 1 步填的库名
   database_id = "<你的 UUID>"       # ← 换成第 1 步复制的 Database ID
   ```

   > 可选参数（`MAX_ACCOUNTS`、`REGISTER_COOLDOWN_MINUTES`、`DISABLE_DEMO` 等不敏感的）可在这个文件里加 `[vars]` 段，写法见下方[「wrangler.toml 配置说明」](#wranglertoml-配置说明)。敏感密钥（`ADMIN_KEY`、`JWT_SECRET`）不要写进本文件，见第 4 步。

3. 点 **Commit changes** 提交。**必须先提交，再做第 4 步的接 Git 自动部署。**

### 第 3 步：创建 Worker

控制台 → **Workers & Pages → Create → Worker**：

- 名称填 `xiaozhou-ledger-web`（与 `wrangler.toml` 里的 `name` 一致；改了别的名字就要同步改 `wrangler.toml`）。
- 创建时若让你选模板或写初始代码，**留空/随便填即可**——第 5 步接 Git 后，仓库里的代码会被部署上去覆盖掉，初始模板不影响最终结果。

创建后先不部署，下一步设置环境变量。

### 第 4 步：配置环境变量与密钥

进入刚创建的 Worker → **Settings → Variables and Secrets**。本仓库是**公开仓库**，`ADMIN_KEY`、`JWT_SECRET` 等密钥**一律用「加密 Secret」（`Encrypted Secrets` 标签）**，不要写进代码/配置/文档：

- **加密 Secret（公开仓库默认且推荐）**：不进 git、`wrangler deploy` 不会清掉，公开仓库下最安全。代价是值只在**添加那一刻**显示一次，之后显示「已加密」无法回看，只能整值覆盖——所以**自己留一份私人备忘**（忘了就重设一个新值，不用找回旧值）。
- 代码里读的都是 `env.XXX`，加密 Secret 直接注入到 `env`，**无需改任何代码**。

> ⚠️ 改完密钥后**必须触发一次部署**才生效：往 GitHub push 任意改动（CI 自动 `wrangler deploy`）或本地 `npx wrangler deploy`。单纯在后台改值不部署，运行中仍是旧值。
>
> （对比）只有当**仓库是私有的、且你希望控制台随时看到/改值**时，才考虑「明文 Variable」（`Variables` 标签）。注意 CI 的 `wrangler deploy` 会清掉未写进 `[vars]` 的明文 Variable，需重新设置——所以公开仓库别用明文。

**要配置的项目（公开仓库 + CI 自动部署场景）：**

| 名称 | 值 | 必填 | 存法 |
| --- | --- | --- | --- |
| `ADMIN_KEY` | 管理口令。网页管理后台 `/admin` 与命令行管理接口共用这一把 | **必设** | **加密 Secret** |
| `JWT_SECRET` | 登录令牌签名密钥。不设则回退到内置默认值，公网有登录令牌被伪造的风险 | 强烈建议设 | **加密 Secret** |
| `MAX_ACCOUNTS` | 数字，如 `100`。限制可注册账号总数；不设 = 不限 | 可选 | 写进 `wrangler.toml [vars]`（不敏感，可入库） |
| `REGISTER_COOLDOWN_MINUTES` | 数字，如 `60`。同一设备两次注册的最小间隔分钟；不设 = 不限 | 可选 | 写进 `wrangler.toml [vars]`（不敏感，可入库） |
| `DISABLE_DEMO` | 设为 `1` 关闭演示账号。默认不设 = 首次部署自动创建一个测试账号 + 模拟账本 | 可选 | 写进 `wrangler.toml [vars]`（不敏感，可入库） |

- **演示账号（默认开启）**：首次部署后，Worker 会自动创建一个测试账号用于效果展示——手机号 `18000000000`、密码 `12345678`，内含 7 种事由各 2 个活动、6 种关系全覆盖的 28 条随机礼金记录（金额 100–500 元、姓名/日期随机）。数据隔离在该账号下，不影响真实用户；管理员可在后台「用户管理」清空它。正式对外使用建议设 `DISABLE_DEMO=1` 关闭（若已生成，关掉后需手动删除该账号），或部署前就设好该变量。
- **最简自用**：只设 `ADMIN_KEY` + `JWT_SECRET` 两个加密 Secret 即可，其余全跳过。
- **密钥值不要写进本仓库任何文件**（仓库公开，写进去即泄露）：`ADMIN_KEY`、`JWT_SECRET` 都在 **CF 后台**设置（Dash → Worker → Settings → **Encrypted Secrets** → 逐个 Add），值由你自己生成、自己保管，**另存一份私人备忘**（加密 Secret 添加后控制台读不回值，忘价值只能整值重设）。
  生成一段 64 位随机串：终端跑 `openssl rand -hex 32`，把它填入（`ADMIN_KEY`、`JWT_SECRET` 各自生成，别用同一个；`ADMIN_KEY` 别用弱口令如人名拼音）。
- ⚠️ **为什么敏感值必须用加密 Secret、不能用明文 Variable**：本仓库接了 GitHub 自动部署，每次构建都执行 `wrangler deploy`，而 `wrangler.toml` 里没有 `[vars]` 段——**部署会按 toml 全量同步、清掉后台所有明文 Variable**。加密 Secret 不受影响、部署永远保留，且不进 git，是公开仓库下唯一"可见性换安全"的取舍：控制台看不到值，但你自己有备忘。
- ⚠️ 备份导出/导入是**明文**的，**不需要** `BACKUP_SECRET`（老版本曾需要，现已移除）。
- ⚠️ **更换 `JWT_SECRET` 会让当前所有用户的登录态全部失效**，需各自重新登录一次（前端会自动清掉失效令牌）。

### 第 5 步：接 GitHub 自动部署

Worker → **Settings → Builds → Connect to Git**，按顺序填：

**① 连接到仓库**

| 界面项 | 填什么 |
| --- | --- |
| Git 帐户 | 选你刚才授权 GitHub 时登录的账号 |
| 存储库 | 选你 **fork 的仓库**（如 `xiaozhou-ledger-test`） |
| 分支 | `main` |

**② 构建配置**

CF 后台会自动带出两个默认命令，本项目的情况如下：

| 界面项 | CF 默认值 | 本项目怎么处理 | 说明 |
| --- | --- | --- | --- |
| 构建命令（Build command，可选） | `npm run build` | **建议留空**；保持默认也没问题 | 前端是预编译好的静态文件（`www/`），无需真正构建。本项目 `package.json` 已内置一个空 `build` 脚本，**即使你忘记留空、保持 CF 默认的 `npm run build`，也会正常通过**（只是打印一句提示，不做任何事）。 |
| 部署命令（Deploy command） | `npx wrangler deploy` | **保持不变** | 这就是部署 Worker 的正确命令。 |

> 构建命令那栏**留空**最干净；万一你没注意、保留了默认的 `npm run build` 也完全没问题——已做兼容，不会报错。
>
> ⚠️ 「启用预览（Enable preview deployments）」默认开启，它会用 `npx wrangler preview`（CF 默认值）为 PR 生成预览部署。本项目不需要预览环境，可**关掉**避免预览任务因该命令报错；开着也不影响 `main` 分支的正式部署。

**③ 保存并验证**

点保存后 CF 会立即触发第一次构建部署（几分钟）。以后你往 `main` push 任何改动，都会自动重新部署。

> 不想接 Git？也可以本地装 Node 后手动部署，见下面「命令行部署」。

### 第 6 步：验证

```bash
curl https://你的Worker地址/api/health
# → {"ok":true,"service":"xiaozhou-ledger-web","dbReady":true,...}
```

- `dbReady: true` = 数据库表已就绪。
- 浏览器打开 Worker 地址（形如 `https://xiaozhou-ledger-web.<你的子域>.workers.dev`），能看到「人情录」首页即部署成功。先记一笔游客账验证读写。
- 打开 `/admin`，输入 `ADMIN_KEY` 登录，确认管理后台可用。

### （可选）绑定自有域名

Worker → **Settings → Domains & Routes → Add → Custom Domain**：

- 域名已托管在 Cloudflare：直接填域名（或子域），CF 自动配 DNS；
- 域名不在 CF：按提示在你的 DNS 服务商添加 `CNAME` 记录指向 CF 提供的地址。

生效后 `https://你的域名` 就是站点地址，`https://你的域名/admin` 是管理后台。

## 命令行部署（进阶）

习惯 CLI 的话，可跳过上面的网页步骤：

```bash
# 1. 克隆你 fork 的仓库（注意仓库名是 xiaozhou-ledger，不是 Worker 名）
git clone https://github.com/你的用户名/xiaozhou-ledger.git
cd xiaozhou-ledger
npm install

# 2. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 3. 创建数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create xiaozhou-ledger-web

# 4. 设置密钥（交互式输入）
npx wrangler secret put ADMIN_KEY
npx wrangler secret put JWT_SECRET

# 5. 可选变量（也可在 Dashboard 的 Variables 面板填；非敏感，建议写进 wrangler.toml [vars]）
# npx wrangler secret put MAX_ACCOUNTS
# npx wrangler secret put REGISTER_COOLDOWN_MINUTES
# npx wrangler secret put DISABLE_DEMO

# 6. 部署（表会在首次请求时自动创建）
npx wrangler deploy
```

验证：`curl https://你的地址/api/health`。

## wrangler.toml 配置说明

`wrangler.toml` 是 Worker 的"总开关"，告诉 Cloudflare：程序入口在哪、连哪个数据库、静态文件怎么托管、要不要开日志。完整配置如下（**敏感密钥不写在这里**，见下方说明）：

```toml
# ① Worker 名称（全局唯一，也是 CF 控制台里的项目名）
name = "xiaozhou-ledger-web"

# ② 入口文件：所有 /api 路由、JWT 校验、D1 读写都在这个文件里
main = "src/index.js"

# ③ 运行时行为版本（像 Node LTS），保持即可，别随意升 "latest"
compatibility_date = "2026-11-14"

# ④ D1 数据库绑定：代码里用 env.DB 访问；fork 后【必须】把 database_id 换成你自己的
[[d1_databases]]
binding = "DB"
database_name = "xiaozhou-ledger-web"
database_id = "<你的 D1 数据库 UUID>"

# ⑤ 静态资源托管（单域名方案）：www/ 下的文件直接下发，不走 Worker
[assets]
directory = "www"                              # 静态根目录
binding = "ASSETS"                             # 代码里读静态文件的句柄
not_found_handling = "single-page-application"  # 未匹配路径回落 index.html（SPA 深链）
run_worker_first = ["/api/*"]                 # 这些路径先走 Worker 代码、再查静态

# ⑥ 可观测性：开启后 CF 记录日志/追踪，免费版保留 7 天，方便排查
[observability]
enabled = true

# ⑦ 可选变量（非敏感，可写进仓库；敏感密钥 ADMIN_KEY/JWT_SECRET 绝不写这里）
#    下面给出全部可用变量及「示例默认值」——按需删改，不需要的直接删掉整段 [vars]。
#    注意：明文 Variable 必须写在这个 [vars] 段里，否则每次 wrangler deploy 会被清掉。
[vars]
MAX_ACCOUNTS = "100"                 # 可注册账号总数上限；不设 = 不限
REGISTER_COOLDOWN_MINUTES = "60"     # 同设备两次注册最小间隔(分钟)；不设 = 不限
DISABLE_DEMO = "0"                   # "1"=关闭演示账号；不设/"0"=首次部署自动生成测试账号 18000000000/12345678
```

**每个字段的作用：**

| 字段 | 作用 | 注意事项 |
| --- | --- | --- |
| `name` | Worker 标识 | 全局唯一；改它要同步改 CI 构建引用 |
| `main` | HTTP 请求进来执行的文件 | 本项目的全部后端逻辑 |
| `compatibility_date` | 锁定运行时行为版本 | 升级 Cloudflare 新特性时才改 |
| `[[d1_databases]].binding` | 代码里的库句柄名（`env.DB`） | 与 `src/index.js` 里的引用一致即可 |
| `[[d1_databases]].database_id` | 连到哪份数据 | **fork 后必改**成自己的 UUID，否则连到别人的库 |
| `[assets].directory` | 静态文件根目录 | 即编译好的前端 `www/` |
| `[assets].not_found_handling` | 找不到文件时怎么办 | `single-page-application` 让前端路由深链可打开 |
| `[assets].run_worker_first` | 哪些路径优先走 Worker | `/api/*` 全由后端处理，不走静态 |
| `[observability].enabled` | 是否记录日志 | 排查问题很有用，建议开 |
| `[vars].MAX_ACCOUNTS` | 可注册账号总数上限 | 可选；不设 = 不限 |
| `[vars].REGISTER_COOLDOWN_MINUTES` | 同设备两次注册的最小间隔（分钟） | 可选；不设 = 不限 |
| `[vars].DISABLE_DEMO` | 设为 `"1"` 关闭演示账号 | 可选；不设/`"0"` = 首次部署自动生成测试账号 |

**敏感变量怎么办（`ADMIN_KEY`、`JWT_SECRET`）：**

- **不要写进本文件**。仓库公开，写进去就等于公开了密钥。
- 它们在 **CF 后台 → Worker → Settings → Encrypted Secrets** 里设置（见[第 4 步](#第-4-步配置环境变量与密钥)）。加密 Secret 不受 `wrangler deploy` 影响、不进 git。
- 只有**非敏感**的可选参数（`MAX_ACCOUNTS`、`REGISTER_COOLDOWN_MINUTES`、`DISABLE_DEMO`）才建议写进本文件的 `[vars]` 段（随仓库走、部署保留）：

  ```toml
  [vars]
  MAX_ACCOUNTS = "100"
  REGISTER_COOLDOWN_MINUTES = "60"
  DISABLE_DEMO = "0"
  ```

> ⚠️ 记住这个坑：**明文 Variable 若没写进 `wrangler.toml [vars]`，每次 `wrangler deploy`（CI 自动部署）都会把它清掉**；而加密 Secret 不会被清。所以公开仓库 + CI 场景，敏感值一律走加密 Secret。

## 管理后台

浏览器打开 **`https://你的域名/admin`**，输入 `ADMIN_KEY` 登录（与命令行接口同一把密钥）。验证通过后签发 12 小时有效的管理员令牌存于本机浏览器，期间不用重复输入；密钥本身不会写进浏览器存储。

功能：

- **用户管理**：分页查看注册用户（默认每页 10 条，可选 10/20/50），按**手机号/昵称搜索**；新增用户；改昵称；**重置任意用户密码**；**更换用户手机号**（用户换号时，会同步迁移该账号全部账本数据）；删除用户及名下全部数据。
- **账号数据管理（按账号编辑）**：输入某用户手机号即可载入该账号，分页查看（默认每页 10 条，可选 10/20/50）并**增删改其礼金、活动**；编辑其 **AI/小程序配置**（baseUrl、模型、API Key）、**小程序接口密钥**（重新生成/改端口/清空）、**查看其设备访问**（按操作日志 IP+UA 统计的浏览器/小程序访问痕迹，只读）与**遗留旧设备绑定**（旧 PIN 体系，可解除）。
- **单账号导入/导出**：对任意单个账号做独立的全栈备份导出与导入（含账本、AI 配置、密钥），不触碰其他账号。
- **全站备份/还原**：导出全站数据（所有用户 + 账本 + 配置）为明文 JSON；导入时可选「合并」（保留现有数据）或「覆盖还原」（清空后重建）。换实例迁移、灾难恢复都靠它。
- **全栈操作日志**：系统自动记录**所有用户**的写操作、登录注册、配置修改、备份等动作（含操作人、结果码、IP、设备标识）；纯只读刷页面与 `/api/health` 自动跳过以省配额。后台分页查看（默认每页 10 条，可选 10/20/50/100/200），按操作人/动作/**起止日期**筛选、**导出日志为 JSON**；「日志保留天数」（默认 30）由系统**惰性自动清理**过期日志，另有「清空全部日志」按钮一键全清。
- **意见反馈 / 密码重置**：后台「意见反馈」卡片汇总用户从账本「写反馈」和登录页「忘记密码」提交的**全部反馈与密码重置申请**（按 web/小程序来源、待处理/已处理区分）。密码重置申请会显示目标手机号，点「帮用户重置」即可设新密码（再告知用户），处理后点「标记已处理」。
- **联系邮箱（忘记密码引导）**：后台设置一个邮箱，登录页「忘记密码」弹窗会据此引导用户"发信给管理员"；未设置则只显示"提交站内重置申请"。

> ⚠️ `ADMIN_KEY` 权限极高（能改所有人密码、删所有数据、导出全站），务必用强随机串，不要用弱口令。

同一把密钥也可用于命令行：

```bash
# 重置某账号密码
curl -X POST https://你的域名/api/admin/reset-password \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000","password":"新密码"}'

# 清空某账号（账号方可重新注册）
curl -X POST https://你的域名/api/admin/purge-account \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000"}'
```

未设置 `ADMIN_KEY` 时，网页后台和这两个接口都不可用。

### 全栈操作日志

- 记录位置：管理后台 →「全栈操作日志」卡片。数据存于 D1 的 `logs` 表（随首次请求自动建表），写入是 best-effort——日志写失败绝不影响业务主流程。
- **记录什么（降级矩阵，省 D1 写配额）**：
  - **必记**：写类操作（活动/礼金/用户/配置的增删改、登录/注册、改昵称/密码/手机号/解绑设备、AI 配置与接口密钥操作、备份导入导出、意见反馈等），以及**所有失败请求（401/403/404/429/5xx，含撞库/越权信号，管理员鉴权失败也记）**。
  - **跳过（纯只读 GET 不记，管理员与普通用户一视同仁）**：`/api/health`、`/api/session`、`/api/account/check`、`/api/overview`、活动/礼金/联系人的分页读取、CSV/年度报告、配置与密钥的"查询"、**以及管理员在后台翻日志页/查用户列表等只读 GET**（`GET /api/admin/*`）——这些不改变数据，不记日志，避免每次翻页都堆一条 `GET /api/admin/logs`。
  - 每条含：操作人（`user:手机号`/`dev:设备号`/`admin`/`anonymous`）、动作、方法/路径、HTTP 状态码、成败、**来源 IP**、**设备标识（User-Agent）**、备注。
  - **数据变更类操作会写明细**（「备注」列直接可读）：新增/改/删活动与礼金会记录对象姓名、关系、收/随、金额（元）、支付方式、日期、所属活动；「改」操作以「旧值 → 新值」对照；删活动还会注明**级联删除了几条礼金**；AI 解析会记解析出几条待记记录。这样审计时能看到"到底改了什么"，而不只是"做了什么操作"。
- **日志保留时长**：后台设「日志保留 X 天」（默认 30，1–365 可调，存于 `admin_settings`）。系统会在每次管理操作时**惰性自动清理**超过保留天数的旧日志（内部 1 小时节流，无需 Cloudflare 定时任务）。另有「清空全部日志」按钮可一键删除全部日志（与保留天数自动清理互相独立）。
- **导出日志**：后台「导出日志」可把日志（可按起止日期/操作人过滤）下载为 JSON，便于存档或离线分析。
- **筛选**：后台日志页支持按操作人、动作、**起止日期**筛选 + 分页。

## 日常使用

1. 打开站点 → 右上角头像（或设置页账号按钮）→「绑定手机号（登录/注册）」→ 填手机号、密码（8–32 位）、可选昵称。
2. 换设备登录同一手机号即看到同一本账；7 天内免输密码。
3. **忘记密码**：登录页点「忘记密码？」，弹窗可**一键复制管理员邮箱**发信求助，或**直接提交站内重置申请**（填手机号即可，无需登录）。管理员在 `/admin`「意见反馈」里看到申请后点「帮用户重置」设新密码（或按命令行 `/api/admin/reset-password`），再把新密码告知用户。
4. 账号菜单 →「个人中心」：改昵称、改密码、换绑定手机号（账本数据自动迁移）。
5. （可选）绑小程序：设置 →「接口密钥」→ 生成密钥 → 扫「绑定二维码」。换密钥后旧密钥立即失效，小程序需重新绑定。

## 备份与迁移

### 用户级：全栈备份（设置页）

「设置 → 导出/导入全栈备份」导出一个**明文 JSON**，包含该账号的活动、礼金、AI 配置（含 API Key）、小程序接口密钥。

- 不需要任何密钥，换账号、换实例都能直接导入；导入后数据归属当前登录账号，按「账号+类型+日期」去重。
- ⚠️ 备份文件是明文且含凭证，等同于账号密码，请妥善保管，勿发公开渠道。

### 管理员级：全站备份（`/admin`）

管理后台可导出/导入**整个站点**的全部数据（所有用户及账本），用于换实例迁移或灾难恢复。导入分「合并」和「覆盖」两种，覆盖前务必先导出当前数据留底。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 `dbReady`） |
| POST | `/api/account/register` | 注册（`phone`/`password`/`name`/`importDevice`；受注册上限与冷却限制） |
| POST | `/api/account/login` | 登录，发 7 天 JWT |
| GET | `/api/account/check?phone=` | 查询手机号是否已注册 |
| DELETE | `/api/account/device` | 解除本机设备绑定 |
| POST | `/api/account/profile` | 改昵称（`name`；需登录，换发 JWT） |
| POST | `/api/account/password` | 改密码（`oldPassword`/`newPassword`；需登录） |
| POST | `/api/account/phone` | 换手机号（`newPhone`/`password`；需登录，账本数据原子迁移） |
| GET | `/api/session` | 会话信息 |
| GET/POST | `/api/events` | 活动列表 / 新建 |
| POST/DELETE | `/api/events/:id` | 更新 / 删除活动（级联删礼金） |
| GET/POST | `/api/gifts` | 礼金列表 / 新建 |
| GET/PUT/DELETE | `/api/gifts/:id` | 查询 / 更新 / 删除 |
| GET | `/api/overview` | 总览统计 |
| GET | `/api/people` | 联系人汇总 |
| GET | `/api/report/yearly?year=` | 年度报告 |
| GET | `/api/export/csv?type=&format=` | 账本导出：`type=gifts/events/people`；`format=xls` 导出 Excel 表格（`.xls`，SpreadsheetML，网页「导出账本」即用此项），默认 `format=csv` 导出 CSV（向后兼容） |
| GET/POST | `/api/ai/config`、`POST /api/ai/parse` | AI 配置 / 解析（自带模型 Key） |
| GET/POST | `/api/export/backup`、`/api/import/backup` | 用户级全栈备份（明文，无需密钥） |
| POST | `/api/feedback` | 意见反馈（账本「写反馈」，存 D1） |
| GET | `/api/account/forgot` | 忘记密码：读管理员设置的联系邮箱（公开，无需登录） |
| POST | `/api/account/forgot/request` | 提交密码重置申请（公开，无需登录，进后台反馈面板） |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥状态 / 生成 / 端口 |
| GET | `/api/membership` | 会员信息（Web 部署视为永久版） |
| POST | `/api/admin/login` | 管理员登录（`adminKey` 或 `X-Admin-Key`）→ 返回 `X-Admin-Token` |
| GET | `/api/admin/users?size=&page=&q=` | 用户列表（分页 + 按手机号/昵称搜索，默认 10/页；需 `X-Admin-Token`） |
| POST | `/api/admin/user/create` | 新增用户 |
| POST | `/api/admin/user/update` | 改昵称/密码/手机号（`newPhone` 换号时自动迁移该账号全部数据） |
| POST | `/api/admin/user/delete` | 删除用户及全部数据 |
| GET | `/api/admin/export-all` | 全站备份导出 |
| POST | `/api/admin/import-all` | 全站备份导入（multipart：`file`，可选 `merge=1`） |
| GET | `/api/admin/account/data?phone=&kind=&page=&size=` | 按账号查看：`kind=gifts/events` 分页列表（默认 10/页，可选 10/20/50）；`kind=settings/apikey` 配置对象；`kind=device` 返回 `deviceAccess`（按操作日志 IP+UA 去重的访问设备，只读统计）+ `devices`（旧 PIN 体系遗留绑定，一般空） |
| POST | `/api/admin/account/event` | 按账号新增/更新活动（`phone`，有 `id` 为改） |
| POST | `/api/admin/account/event/delete` | 按账号删除活动（级联删礼金，`phone`+`id`） |
| POST | `/api/admin/account/gift` | 按账号新增/更新礼金（`phone`，有 `id` 为改） |
| POST | `/api/admin/account/gift/delete` | 按账号删除礼金（`phone`+`id`） |
| POST | `/api/admin/account/settings` | 按账号改 AI 配置（`baseUrl`/`model`/`apiKey`，Key 留空保留原值） |
| POST | `/api/admin/account/apikey` | 按账号管理密钥：`action=rotate/port/clear`，默认查看 |
| POST | `/api/admin/account/device` | 按账号解除设备绑定（`phone`+`deviceId`） |
| GET | `/api/admin/account/export?phone=` | 单账号全栈备份导出 |
| POST | `/api/admin/account/import?phone=` | 单账号全栈备份导入（multipart：`file`） |
| GET | `/api/admin/logs?limit=&page=&actor=&action=&from=&to=` | 全栈操作日志（默认 10/页，可选 10/20/50/100/200；按操作人/动作/起止日期过滤） |
| GET | `/api/admin/logs/export?from=&to=&actor=` | 导出日志为 JSON 文件（可按起止日期/操作人过滤） |
| POST | `/api/admin/logs/purge` | 清理日志：`{days:N}` 删 N 天前旧日志；`{days:0}`/缺省清空全部日志 |
| GET | `/api/admin/settings` | 读管理员运行参数（日志保留天数、上次清理时间、日志条数） |
| POST | `/api/admin/settings` | 存管理员运行参数（`{logRetentionDays}` 1–365、`{contactEmail}` 忘记密码联系邮箱） |
| GET | `/api/admin/feedbacks?limit=&page=&kind=&status=` | 查看意见反馈/重置申请（`kind=reset/suggestion`、`status=new/done`） |
| POST | `/api/admin/feedback/resolve?id=` | 标记某条反馈已处理 |
| POST | `/api/admin/feedback/delete?id=` | 删除某条反馈记录（防积压占库） |
| POST | `/api/admin/feedback/purge` | 批量清理反馈：body `{all:true}` 清空全部；缺省只删「已处理」 |
| POST | `/api/admin/reset-password`、`/api/admin/purge-account` | 命令行管理（需 `X-Admin-Key`） |

**用户认证头**（按优先级）：`X-Api-Key`/`X-Token`/`Authorization: Bearer`（JWT 或小程序密钥）→ `X-Ledger-Token`（设备/游客）。不同账号数据相互隔离。
**管理认证**：`/api/admin/login` 用 `ADMIN_KEY` 换 `X-Admin-Token`（12 小时）；旧的两个命令行接口直接用 `X-Admin-Key`。
**跨域**：默认反射请求方 `Origin`（认证全走自定义头，不用 Cookie）。如需收紧，改 `src/index.js` 里的 `corsHeaders` 为固定白名单。

## 常见问题

- **首页显示"无法识别身份/页面加载异常"**：多半是浏览器缓存了旧版页面。强制刷新（Ctrl+F5）；若是刚设置/更换了 `JWT_SECRET`，会自动清除失效登录态，重新登录一次即可。
- **`/api/health` 的 `dbReady` 是 false**：数据库还没建表。随便请求一次任意 `/api` 接口会触发自动建表；或手动执行 `schema.sql`。确认 `wrangler.toml` 的 `database_id` 填的是你自己的库。
- **导出备份报 400／"未配置密钥"**：当前版本备份是明文，**不需要**任何密钥。若还看到这个报错，说明部署的还是旧代码，重新部署最新代码。
- **`/admin` 打不开或登录失败**：确认已设置加密 Secret `ADMIN_KEY`，且输入的值与你设的完全一致（注意空格/换行）。若刚做过一次 CI 部署后登录失败，多半是误用了明文 Variable 被部署清掉了，改回加密 Secret 即可。
- **加密 Secret 在控制台看不到值**：这是 Cloudflare 的设计，值只在添加那一刻显示一次，之后只能整值覆盖、无法回看。忘了值就翻你自己留的私密备忘，或在后台直接重新设一个新值（`wrangler deploy` 后生效）。**不要用明文 Variable 来"留个能看的"——公开仓库 + CI 场景下明文 Variable 每次部署会被清空。**
- **改了后台变量/密钥但没生效**：加密 Secret 修改后必须**触发一次部署**（往 GitHub push 任意改动，或本地 `npx wrangler deploy`）才应用到运行中的 Worker；单纯在后台改值不部署，运行中仍是旧值。
- **小程序连不上**：设置页确认接口密钥已生成、端口正确；换过密钥要在小程序重新绑定。
- **注册报"尝试过于频繁"**：同一手机号连续输错密码 20 次会封 5 分钟（内存级），等一会儿或让管理员重置密码。

## 已知限制

- 无短信/邮箱验证，手机号仅作"自报 + 密码"身份；忘记密码只能由管理员重置。
- 微信支付购买入口不可用（Web 部署视为永久版）。
- 小程序客户端源码与原作者云端网关不在本仓库；服务端已兼容其接口契约，端到端绑定取决于官方小程序是否直连你的配置地址。
- 前端为官方编译产物，未重新打包；仅做了云端文案适配、API 地址/设备标识/二维码协议自适应与账号 UI 注入。静态资源引用带 `?v=` 版本号，改动后浏览器会自动加载新版本。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端（`src/`）为根据前端接口契约重新实现的独立作品。
