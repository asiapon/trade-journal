# 部署说明

> **运维操作请直接看 [`../scripts/OPS.md`](../scripts/OPS.md)** —— 三条通道的全部命令、
> 前置条件、故障排查都在那里。本文只说明「这个目录里放的是什么、为什么这样放」。

---

## deploy/ 是什么

**被部署的东西**（代码与配置），不是「怎么去部署」（那在 `scripts/`）。

```
deploy/
├── cloudflare/              部署到 Cloudflare Workers + D1
│   ├── src/worker.js        Worker 入口：静态资源 + 18 个 RPC 函数 + /api/*
│   ├── src/rpc.js           RPC 实现（SECURITY DEFINER 语义的 owner 隔离）
│   ├── schema.d1.sql        D1 建表脚本（幂等）
│   └── wrangler.toml        本地发布用的配置（deploy:cf 显式 -c 指定）
├── selfhost/                部署到自己的服务器（Express + PostgreSQL）
│   ├── server.js            后端主程序（API + 静态托管 + 定时采集）
│   ├── schema.sql           PG 建表 + 18 个函数
│   ├── ksync.js             每天 17:30 的 K 线增量采集
│   ├── skillpack.js         SKILL.md 技能包运行时（调 Python）
│   ├── logger.js            服务端日志落盘
│   ├── packs/               已安装的技能包
│   ├── logs/                运行日志（app-YYYY-MM-DD.log / server-out/err）
│   ├── .env                 运行配置（PORT / DATABASE_URL / ACCESS_KEY）
│   └── .env.example         配置模板
```

> 这个目录里**没有再放启停/安装脚本** —— 那些已统一到 `scripts/self/`。
> v3.18.x 及以前放在这里的 `install-*.sh`、`start-windows.ps1` 等都已迁走。
> v3.19 起 `stock-dict.json` 也移走了（此前 `deploy/` 下存过一份副本），
> 采集与前端现在共用 `public/stock-dict.json` 这一个源文件。

---

## 路径硬依赖（改结构前必看）

只有一处相对路径是硬绑定的：

| 文件 | 代码 | 实际指向 | 为什么不能改 |
|---|---|---|---|
| `selfhost/server.js:343` | `path.join(__dirname, '..', '..', 'dist')` | 仓库根 `dist/` | 静态托管的是**构建产物**。`dist/index.html` 里引用带 hash 的 `assets/index-*.js`，而 `public/` 连 `index.html` 都没有（它在仓库根，由 Vite 处理）。指向 `public/` 会白屏 |

`ksync.js` 读数据文件的路径**不是**硬依赖 —— 它按 `public/` → `dist/` → 旧
`deploy/` 位置 依次查找，三处内容相同，取到哪个都行（见源码 `dictPath()`）。

结论：`deploy/selfhost/` 必须留在 `deploy/` 下、`deploy/` 必须留在仓库根下（差一级
`../../dist` 就指错地方）。

---

## wrangler.toml 有两份，都要留

| 文件 | 谁在用 | main / assets |
|---|---|---|
| `deploy/cloudflare/wrangler.toml` | 本仓库的命令（`npm run deploy:cf` 显式 `-c`，cwd 在 CF 目录） | `src/worker.js` / `../../dist` |
| **仓库根 `wrangler.toml`** | **Cloudflare 自动构建**（平台执行裸 `npx wrangler deploy`，只在根目录找配置） | `deploy/cloudflare/src/worker.js` / `./dist` |

**删掉根目录那份，自动构建会失败**：wrangler 找不到配置 → 判定为新项目 →
进入交互式向导 → 试图把项目改造成纯静态站（`@cloudflare/vite-plugin`）→
报 `Cannot modify Vite config: could not find a valid plugins array`。
更糟的情况是向导"成功"，那样 `worker.js` 的 18 个 RPC 和 `/api/*` 全被绕过，
表现为「页面能开但没数据」，而且不报错。

两份的 `database_id` 必须一致：`npm run cf:bootstrap` 会同时写两份，
`npm run deploy:cf` 启动时校验并告警。

---

## 三条通道的能力差异

| 能力 | Cloudflare | 自托管 | WorkBuddy 托管 |
|---|:---:|:---:|:---:|
| 记账 / 自选 / 分析 / 问答 | ✅ | ✅ | ✅ |
| Python 技能包 | ❌ | ✅ | ❌ |
| 服务端日志文件 | ⚠️ 存 D1 | ✅ | ❌ 仅前端日志 |
| 定时采集（每天 17:30） | ❌ | ✅ | ❌ |
| 纯命令行发布 | ✅ | ✅ | ❌ 需界面 |
| 数据库 | D1 | PostgreSQL | 云库 |

设置页「环境能力」面板会按当前后端自动显示实际支持的能力。

---

## 后端是怎么选的（同一份 dist 通吃）

前端启动时自动探测，不需要为每个环境分别打包：

```
1. POST /.cloud/database/rest/rpc/app_has_users
2. 返回 JSON  → RPC 后端（Cloudflare / 自托管），走 18 函数 RPC
3. 否则       → 平台云服务，走 PostgREST
```

对应代码：

- `src/storage/gateway.js` — RPC 通道（`rpcStore`）
- `src/storage/cloud-adapter.js` — 平台云服务通道（`cloudStore`）
- `src/features/auth.js` — `selectBackend()` 决定用哪一套

> **登录方式始终是用户名 + 密码**。两套后端都实现
> `hasUsers / setupAdmin / login / changePassword / logout / listUsers`，
> 没有引入手机验证码 / 微信 / WorkBuddy 账号登录。

---

## 与运维无关的常见现象

| 现象 | 说明 |
|---|---|
| 构建时 4 个 `can't be bundled` 警告 | `public/` 下 `kline-store.js`/`qa-tools.js`/`analysis-extra.js`/`data-hub.js` 没有 `type="module"`，设计如此，通过 `app.js` 桥共享符号。**不是错误** |
| 页面能开但没数据 | 见 [`scripts/OPS.md` 故障排查](../scripts/OPS.md#故障排查) |
| 发布后仍是旧页面 | 浏览器缓存，Ctrl+Shift+R 强刷 |

---

## 应用源码结构（供参考）

```
src/
  core/         数据层 / 能力探测 / 应用状态
  features/     业务模块（journal / watchlist / qa / auth / me ...）
  storage/      gateway(RPC) + cloud-adapter(平台云服务)
  ui/           事件绑定 / 组件
public/         经典脚本（kline-store / qa-tools / analysis-extra / data-hub）
tests/          vitest（20 用例）
```
