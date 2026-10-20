# 运维手册

> 所有运维操作都在这里。三条通道、每种操作、命令与前置条件，一页看完。
> 不想记命令就双击 `publish.bat`（Windows）或跑 `./publish.sh`，弹菜单选编号。

---

## 目录职责（先理解这个，后面就不乱）

```
trade-journal/
├── publish.bat / publish.sh     ← 总入口：菜单 + 转发，不含逻辑
├── wrangler.toml                ← Cloudflare 自动构建必需（根目录，勿删）
├── .env.local                   ← 凭据（git 忽略，自己创建）
│
├── ops/                         ← 【运维】所有「怎么操作」
│   ├── cli.mjs                  ← 统一 CLI
│   ├── lib/                     ← 共用：路径、输出、构建、env 加载
│   ├── cf/                      ← Cloudflare 通道
│   ├── wb/                      ← WorkBuddy 通道
│   └── self/
│       ├── deploy.mjs           ← 把 dist 同步到服务器
│       ├── linux/               ← 服务器端脚本（11 个操作）
│       └── windows/             ← 服务器端脚本（11 个操作）
│
├── deploy/                      ← 【部署物】被部署的代码与配置
│   ├── cloudflare/              ← Worker + rpc.js + schema.d1.sql + wrangler
│   ├── selfhost/                ← 自托管后端运行时（server.js 等）
│   └── stock-dict.json          ← ksync.js 的硬依赖，勿删
│
└── scripts/                     ← 【开发期】一次性工具，日常不用
```

**为什么 `deploy/` 不能挪**：`server.js:343` 用 `path.join(__dirname,'..','..','dist')`
硬指仓库根，`ksync.js:69` 用 `__dirname/../stock-dict.json` 硬指 `deploy/`。
挪动这两个会让线上自托管直接 404。

---

## 入口：两种写法完全等价

```bash
# 封装脚本（推荐，短）
./publish.sh cf status          # Windows: publish.bat cf status

# 直接调 CLI（等价）
node ops/cli.mjs cf status
```

npm 也有一批快捷方式：`npm run cf:status`、`npm run self:backup`、`npm run wb:sync` 等，
完整列表见 `package.json` 的 `scripts`。

---

## 通道一：Cloudflare Workers + D1（唯一纯命令行上线）

**前置**：`.env.local` 里配 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。
Token 需要 `Workers Scripts:Edit` + `D1:Edit` 权限。

| 操作 | 命令 | 说明 |
|---|---|---|
| 首次初始化 | `cf bootstrap` | 建 D1 库 → 写 `database_id` 到两份 wrangler.toml → 远端建表。幂等 |
| 发布 | `cf deploy` | 构建 → 产物校验 → 测试 → `wrangler deploy` |
| 状态 | `cf status` | Worker 是否部署、最后修改时间、D1 表清单与行数、RPC 端点探测 |
| 日志 | `cf logs` | 实时流；`cf logs --once` 抓一段就退 |
| 删除 | `cf remove` | 删 Worker + D1（**数据全丢**），需输入 yes |

⚠️ **两份 `wrangler.toml` 必须同时存在**：

| 文件 | 谁在用 |
|---|---|
| `deploy/cloudflare/wrangler.toml` | 本仓库的命令（显式 `-c`，cwd 在 CF 目录） |
| `wrangler.toml`（仓库根） | **Cloudflare 自动构建**（平台执行裸 `npx wrangler deploy`，只找根目录） |

删掉根目录那份，自动构建会失败：wrangler 找不到配置 → 进入交互式向导 →
尝试把项目改造成纯静态站（`@cloudflare/vite-plugin`）→ 绕过 `worker.js` 的 18 个
RPC 函数和 `/api/*` → 表现为「页面能开但没数据」，而且不报错。

两份的 `database_id` 必须一致。`cf bootstrap` 会同时写两份，`cf deploy` 启动时校验。

---

## 通道二：自托管服务器（完整运维）

### 2.1 在服务器上操作（脚本在 `ops/self/linux/` 或 `ops/self/windows/`）

Linux 全部需要 `sudo`；Windows 需要**管理员 PowerShell**。

| 操作 | Linux | Windows | 说明 |
|---|---|---|---|
| 安装/升级 | `sudo ./install.sh` | `.\install.bat` | 幂等。重复跑=升级，保留数据与 .env |
| 启动 | `sudo ./start.sh` | `.\start.bat` | 已运行则跳过 |
| 停止 | `sudo ./stop.sh` | `.\stop.bat` | 本来没跑也算成功 |
| 重启 | `sudo ./restart.sh` | `.\restart.bat` | 改完 .env / 拉新代码后用 |
| 状态 | `./status.sh` | `.\status.bat` | 进程/端口/健康/数据库/自启/日志/磁盘 |
| 日志 | `./logs.sh -n 200 -f` | `.\logs.bat -Lines 200 -Follow` | 也支持 `--sys`/`-Err`/`--list` |
| 备份 | `sudo ./backup.sh` | `.\backup.bat` | 库 + .env + packs → `backups/`，自动清理旧份 |
| 恢复 | `sudo ./restore.sh <文件>` | `.\restore.bat <文件>` | **覆盖式**，恢复前自动先备份 |
| 卸载 | `sudo ./uninstall.sh` | `.\uninstall.bat` | 逐项确认；公共组件默认保留 |
| 重置库 | `sudo ./reset-db.sh` | `.\reset-db.bat` | 秒级清空重来，不卸载任何组件 |
| 重置PG密码 | `sudo ./reset-pg.sh` | `.\reset-pg.bat` | 救援用 |

也可以从仓库根一次调完，不用 cd：

```bash
node ops/cli.mjs self status      # 自动选当前平台的脚本
node ops/cli.mjs self backup
```

**安装脚本会做什么**（以 Linux 为例）：
装 curl/Node≥18/PostgreSQL → 建角色与库 → 导 schema → 建管理员 → npm install →
装 Python 依赖（技能包用）→ 写 `.env`（600 权限）→ 装 systemd 服务 →
清掉旧名 `stock-journal` 服务 → 启动 + 健康检查。

### 2.2 从本地把新版本推上去

```bash
node ops/cli.mjs self deploy              # 构建 + rsync/scp dist 到服务器
node ops/cli.mjs self deploy --restart    # 顺带重启远端服务
node ops/cli.mjs self deploy --no-build   # 用现有 dist，不重新构建
```

需要 `.env.local` 里有 `SELF_HOST=user@host`（可选 `SELF_PATH`，默认
`/opt/stockjournal/dist`）。

> 另一条路：直接在服务器上 `git pull && npm run build`，
> `server.js` 直接读 `dist/`，不需要同步。两种都行。

### 2.3 服务名说明

安装的服务叫 **`trade-journal`**。v3.10.x 的老脚本装的是 `stock-journal`，
新版 `status/start/stop` 会**自动识别旧名**并提示迁移，重跑 `install` 即可换过来。

---

## 通道三：WorkBuddy 托管（半自动）

**这条通道无法纯命令行上线**，只能准备文件，必须在界面点一次「发布」。

| 操作 | 命令 | 说明 |
|---|---|---|
| 同步 | `wb sync` | 构建 → 清空暂存目录 → 拷入 dist |
| 状态 | `wb status` | 对比暂存目录与 dist 的文件数/时间，告诉你需不需要重新 sync |

暂存目录：`C:/lyz/workspace/trade-journal-app`（在仓库外，可随时删除重建）。

---

## 开发与体检

| 命令 | 作用 |
|---|---|
| `dev check` | 构建 + 产物校验 + 20 个单测（发布前建议先跑） |
| `dev serve` | vite dev server，热更新，`localhost:5173` |
| `dev preview` | 构建后预览产物，`localhost:4173` |
| `dev env` | 生成 `.env.local` 模板 |

`dev check` 会拦三类问题：
1. 7 个静态资源缺失（`stock-dict.json` 等，少一个线上就废）
2. 产物残留已退役域名 `stock-journal-07300`（云库地址已 404）
3. 单元测试失败

---

## 凭据：`.env.local`

```ini
# Cloudflare
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=

# 自托管（可选）
SELF_HOST=root@1.2.3.4
SELF_PATH=/opt/stockjournal/dist
```

- 已被 `.gitignore` 忽略，不会提交
- `publish.bat` / `publish.sh` / `ops/cli.mjs` 启动时**自动加载**
- 已存在的环境变量优先，不会被文件覆盖（CI 里 export 的凭据安全）
- 生成模板：`./publish.sh` 选 12，或 `node ops/cli.mjs dev env`

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面能开但没数据 | 静态托管没后端 / Worker 被改造成纯静态站 | `cf status` 看 RPC 探测结果；确认根 `wrangler.toml` 在 |
| Cloudflare 构建 `Cannot modify Vite config` | 根目录缺 `wrangler.toml`，wrangler 进了向导 | 确认 `wrangler.toml` 已提交并 push |
| `cf deploy` 说缺凭据 | 没配 `.env.local` | `dev env` 生成后填 |
| 自托管启动后 502/无响应 | PG 没跑 / .env 密码与角色不一致 | `self status` → `self logs`；重跑 `install` 会同步密码 |
| 自托管端口被占 | 旧进程没退 | `self stop` 会按端口强杀 |
| 老机器上有 `stock-journal` 服务 | v3.10 时代的名字 | 重跑 `install` 自动迁移 |
| `logs` 报没有日志文件 | 服务从没启动过 | 先 `start`，或 `logs --sys` 看 journalctl |
| 备份文件太大 | `packs/` 含大文件 | `backup --out` 换盘，或手动只留 `db.dump` |
| PowerShell 脚本中文乱码/语法错 | ps1 无 BOM，PS5.1 按 GBK 读 | 跑 `node ops/_fix-ps1.mjs` |
| bat 双击闪退且生成奇怪文件 | bat 里有中文，`chcp` 期间 `>` 被当重定向 | bat 保持纯 ASCII，中文交给 node 输出 |

---

## 维护者注意事项

改这套脚本时容易踩的坑，都验证过了：

1. **`.bat` 必须纯 ASCII + CRLF**。中文写进 bat，`chcp 65001` 切换期间 cmd 会把
   提示语里的 `>` 当重定向，凭空生成文件。中文一律由 node/PS 输出。
2. **`.ps1` 必须带 UTF-8 BOM**。PS 5.1 无 BOM 时按系统 ANSI 读，中文注释变乱码
   导致语法报错（症状：`"宸插畨瑁?node"`）。改完跑 `node ops/_fix-ps1.mjs`。
3. **`.sh` 必须 LF**。Windows 上编辑过要确认 `git ls-files -s` 是 `100755`。
   `.gitattributes` 已锁定换行规则。
4. **PowerShell 脚本间调用要用子进程**。被 `&` 调用的脚本里 `exit` 会连带终止
   调用者，必须 `Start-Process -Wait -PassThru` 才能拿到退出码继续执行。
5. **`deploy/` 位置不可变**（见开头路径依赖说明）。
6. 生成 bat 垫片：`node ops/self/windows/_gen-bats.mjs`（改完 ps1 不用重跑，
   只有增删 ps1 时才需要）。
