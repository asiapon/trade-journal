# 操作日志（trade-journal）部署手册

> 一句话：**想完全命令行发布，用 Cloudflare**（`npm run publish:cf`）。
> 其余两条通道要么需要 WorkBuddy 界面，要么需要一台自己的服务器。

---

## 快速开始：双击运行（不用记命令）

仓库根有两个等价的一键脚本，**功能完全一样，选你系统对应的那个**：

| 系统 | 脚本 | 怎么跑 |
|---|---|---|
| Windows | `publish.bat` | 双击，弹出菜单选序号 |
| Linux / macOS / Windows Git Bash | `publish.sh` | `./publish.sh` |

菜单项对应关系：

```
[1] 体检         构建 + 测试 + 产物校验（不改线上）
[2] 发布 CF      发布到 Cloudflare Workers + D1
[3] 本地预览     构建后起服务看效果（http://localhost:4173）
[4] 同步 WB      构建 + 拷到 WorkBuddy 发布目录（仍需界面点发布）
[5] 自托管       同步到自己的服务器
[6] 开发模式     vite dev，热更新（http://localhost:5173）
[7] CF 初始化    首次建 D1 库 + 建表
[8] 生成凭据     .env.local 模板
```

也可以直接带参数跳过菜单：

```bash
# Windows
publish.bat check
publish.bat cf

# Linux / macOS
./publish.sh check
./publish.sh cf
```

### 凭据放 `.env.local`，不用每次 set

跑一次菜单里的 `[8] 生成凭据`（或 `publish.bat env` / `./publish.sh env`），
会在仓库根生成 `.env.local`，填好即可：

```ini
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
SELF_HOST=
SELF_PATH=/opt/stockjournal/dist
```

两个脚本**启动时都会自动读这个文件**。它已在 `.gitignore` 里（`.env.local` 规则），
不会被提交。已存在的环境变量优先，不会被文件覆盖。

### 脚本会帮你检查什么

- `node` 是否存在、版本是否 ≥ 18（`publish.sh` 会硬拦）
- `node_modules/` 是否装了，没装就自动 `npm install`
- Cloudflare 凭据是否齐全，缺了会打印获取路径而不是直接报错

> `publish.bat` 末尾加 `--no-pause` 用于 CI 或被其它脚本调用，不等待按键：
> `publish.bat check --no-pause`

---

## 0. 发布前体检（任何通道都建议先跑）

```bash
npm run publish:check      # 或 publish.bat check / ./publish.sh check
```

它会做四件事，任一步失败就停：

1. `vite build` 构建到 `dist/`
2. 校验产物完整性（7 个静态资源 + assets 下的 JS/CSS 包）
3. 拦截**失效域名残留**（`stock-journal-07300` 已退役，产物里有就拒绝发布）
4. 跑 `vitest`（20 个用例）

---

## 1. Cloudflare Workers + D1 —— 纯命令行，推荐

**这是唯一不需要打开 WorkBuddy 的完整发布方式。**

### 首次准备（只做一次）

```powershell
# 1) 配置凭据（PowerShell）
$env:CLOUDFLARE_API_TOKEN="cfat_..."     # dash.cloudflare.com → My Profile → API Tokens
$env:CLOUDFLARE_ACCOUNT_ID="9ae97..."    # 账户 ID，在 Workers 概览页右下角

# 2) 建 D1 库并写回 database_id（幂等，可重跑）
npm run cf:bootstrap
```

`bootstrap` 会自动：查/建 D1 库 → 把 `database_id` 写进
`deploy/cloudflare/wrangler.toml` → 远端执行 `schema.d1.sql` 建表。

> 当前 `wrangler.toml` 里已有 `database_id = afdad2bf-...`，说明这一步做过了。

### 日常发布

```powershell
$env:CLOUDFLARE_API_TOKEN="cfat_..."
$env:CLOUDFLARE_ACCOUNT_ID="9ae97..."
npm run publish:cf
```

成功后会输出 Worker 地址（默认 `https://trade-journal.<你的子域>.workers.dev`）。

### 两份 wrangler.toml（别删根目录那份）

| 文件 | 谁在用 | main / assets 路径 |
|---|---|---|
| `deploy/cloudflare/wrangler.toml` | `npm run publish:cf`、`cf:bootstrap`（显式 `-c` 指定，cwd 在 CF 目录） | `src/worker.js` / `../../dist` |
| **仓库根 `wrangler.toml`** | **Cloudflare 自动构建**（平台执行裸 `npx wrangler deploy`，只找根目录） | `deploy/cloudflare/src/worker.js` / `./dist` |

两者内容等价、指向同一个 Worker 和同一个 D1。**删掉根目录那份，Cloudflare 自动构建会失败**——
它会因找不到配置而进入交互式向导，试图把项目改造成纯静态站（`@cloudflare/vite-plugin`），
从而绕过 `worker.js` 里的 RPC 函数和 `/api/*`，表现为「页面能开但没数据」。

`database_id` 两处必须一致；`cf:bootstrap` 会同时写两份，`publish:cf` 启动时会校验并在不一致时告警。

### 下线

```bash
npm run cf:delete        # 删 Worker + D1（会有二次确认）
```

> ⚠️ `cf:delete` 连 D1 库一起删，**记账数据会一并丢失**，删前先导出 JSON。

---

## 2. 自托管（PostgreSQL）—— 全功能，但需要服务器

这条通道能力最全：Python 技能包、服务端日志、每天 17:30 定时采集
（Cloudflare 没有定时采集，WorkBuddy 托管也没有）。

### 服务器首次安装

```bash
cd deploy/selfhost
npm install
cp .env.example .env          # 填 DATABASE_URL / ACCESS_KEY / ASR_API_KEY / TENCENT_*
psql -d tradejournal -f schema.sql
node server.js                # 默认 http://localhost:54444
```

Linux 用 `install-ubuntu.sh`，Windows 用 `install-windows.ps1` 一键装。

### 发布

```bash
SELF_HOST=root@your-host npm run publish:self
# 可选：SELF_PATH=/opt/stockjournal/dist
```

等同于 `scp dist/* user@host:/opt/stockjournal/dist/`，然后提示重启服务。

### 停止 / 启动（Windows）

```powershell
powershell -File deploy\selfhost\stop-windows.ps1
powershell -File deploy\selfhost\start-windows.ps1
```

---

## 3. WorkBuddy 托管 —— 需要界面点发布

```bash
npm run deploy:wb      # 构建 + 同步到 C:\lyz\workspace\trade-journal-app
```

然后必须在 WorkBuddy 里点「发布」才算上线。**这条通道无法纯命令行完成。**

线上地址：https://trade-journal-55799.app.workbuddy.host

> ⚠️ **静态发布 ≠ 有后端**。按 static 发布时只托管 HTML/JS，
> 同源 `/.cloud/database/rest/rpc` 会 404/403，页面表现为「有界面但没数据」。
> 要让这条通道可用，须在 App 上激活云服务，并确认 `publishableKey` 有效。

---

## 4. 环境能力对照

| 能力 | Cloudflare | 自托管 | WorkBuddy 托管 |
|---|:---:|:---:|:---:|
| 记账 / 自选 / 分析 / 问答 | ✅ | ✅ | ✅ |
| Python 技能包 | ❌ | ✅ | ❌ |
| 服务端日志文件 | ⚠️ 存 D1 | ✅ | ❌ 前端日志 |
| 定时采集（每天 17:30） | ❌ | ✅ | ❌ |
| 纯命令行发布 | ✅ | ✅ | ❌ |
| 数据库 | D1 | PostgreSQL | 云库 |

设置页「环境能力」面板会自动显示当前后端实际支持的能力。

---

## 5. 后端是怎么选的（同一份 dist 通吃）

前端在启动时**自动探测**当前环境，不需要为每个环境单独打包：

```
探测顺序：
  1. 请求 /.cloud/database/rest/rpc/app_has_users
  2. 返回 JSON → RPC 后端（Cloudflare / 自托管），走 18 函数 RPC
  3. 否则 → 平台云服务，走 PostgREST（cloud-adapter.js）
```

对应代码：

- `src/storage/gateway.js` — RPC 通道（`rpcStore`）
- `src/storage/cloud-adapter.js` — 平台云服务通道（`cloudStore`）
- `src/features/auth.js` — `selectBackend()` 决定用哪一套

> **登录方式始终是用户名 + 密码**。两套后端都实现
> `hasUsers / setupAdmin / login / changePassword / logout / listUsers`。

---

## 6. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面能开但没数据 | 静态托管无后端 | 改用 Cloudflare / 自托管，或激活云服务 |
| `invalid_client` 401 | 云服务凭证被网关拒绝 | 平台侧问题，非代码问题；换通道（CF/自托管） |
| 登录后数据为空 | RPC 与云服务后端用错 | 检查探测结果与 `S.backend` |
| `42501` | 表权限 / RLS 未配 | 补 GRANT 或 RLS 策略 |
| 构建报 `can't be bundled` | public/ 下 4 个经典脚本无 `type="module"` | **正常现象**，设计如此 |
| 发布后仍是旧页面 | 浏览器缓存 | 强刷 Ctrl+Shift+R |

---

## 7. 目录说明

```
src/            应用源码（ES Modules）
  core/         数据层 / 能力探测 / 状态
  features/     业务模块（journal / watchlist / qa / auth ...）
  storage/      gateway(RPC) + cloud-adapter(云服务)
  ui/           事件绑定 / 组件
public/         经典脚本（kline-store / qa-tools / analysis-extra / data-hub）
deploy/
  cloudflare/   Worker + D1（schema.d1.sql / wrangler.toml / src/）
  selfhost/     Express + PostgreSQL（server.js / schema.sql / 启停脚本）
  stock-dict.json  ← 定时采集用的股票宇宙清单（ksync.js 会读，勿删）
scripts/
  publish.mjs    ★ 统一发布入口（cf / self / wb / local / check）
  cloudflare.mjs cf:bootstrap / cf:delete
  sync-wb.mjs    同步到 WB 发布目录
  sync-self.mjs  scp 到服务器
tests/          vitest（20 用例）
```
