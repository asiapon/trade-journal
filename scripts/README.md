# scripts/ —— 所有脚本

**运维操作看 [OPS.md](OPS.md)**（三通道操作矩阵、故障排查、维护者注意事项）。
本文件只说明「这里有哪些脚本、各自干什么」。

---

## 目录一览

```
scripts/
├── cli.mjs           统一 CLI 入口：node scripts/cli.mjs <通道> <操作>
├── OPS.md            运维手册（要干活看这个）
├── lib/              共用模块
│   ├── paths.mjs       全项目唯一的路径解析处
│   ├── ui.mjs          终端输出（颜色/步骤/表格）
│   ├── build.mjs       构建 + 产物校验 + 单测
│   └── env.mjs         加载 .env.local
├── cf/               Cloudflare 通道
│   ├── lib.mjs         wrangler 调用与 REST API 封装
│   ├── bootstrap.mjs   首次建 D1 + 建表
│   ├── deploy.mjs      发布
│   ├── status.mjs      Worker / D1 / 表行数 / RPC 探测
│   ├── logs.mjs        实时日志
│   └── remove.mjs      删除（危险）
├── self/             自托管通道
│   ├── deploy.mjs      把 dist 同步到服务器（rsync/scp）
│   ├── linux/          服务器端脚本 × 11
│   └── windows/        服务器端脚本 × 11（ps1 + bat 垫片）
└── dev/              开发期一次性工具
    ├── fix-ps1.mjs     给 ps1 补 UTF-8 BOM + 统一 CRLF
    ├── gen-bats.mjs    生成 windows/ 下的 bat 垫片
    └── split_app.py    v0.11 历史拆解脚本，仅留档
```

---

## 怎么跑

统一入口 `scripts/cli.mjs`，在仓库根执行：

```bash
node scripts/cli.mjs                    # 交互菜单
node scripts/cli.mjs cf deploy          # 发布到 Cloudflare
node scripts/cli.mjs self status        # 自托管服务状态
node scripts/cli.mjs help               # 完整命令列表
```

或用 npm 快捷方式（更短）：

```bash
npm run deploy:cf
npm run self:status
npm run check
```

> 根目录不再放 `publish.bat` / `publish.sh` 这类转发脚本 ——
> 它们只是把命令转给 `cli.mjs`，多一层没必要。直接调 cli 或 npm script 即可，
> 两个平台写法一致。

---

## 自托管服务器端脚本

跑在**服务器上**，不在本机（本机用 `self deploy` 推代码过去）。

| 操作 | Linux（`sudo`） | Windows（管理员） |
|---|---|---|
| 安装/升级 | `scripts/self/linux/install.sh` | `scripts\self\windows\install.bat` |
| 启动 / 停止 / 重启 | `start.sh` / `stop.sh` / `restart.sh` | `start.bat` / `stop.bat` / `restart.bat` |
| 状态 / 日志 | `status.sh` / `logs.sh` | `status.bat` / `logs.bat` |
| 备份 / 恢复 | `backup.sh` / `restore.sh` | `backup.bat` / `restore.bat` |
| 卸载 | `uninstall.sh` | `uninstall.bat` |
| 重置库 / 重置PG密码 | `reset-db.sh` / `reset-pg.sh` | `reset-db.bat` / `reset-pg.bat` |

也可以从仓库根一次调完（自动选当前平台）：

```bash
node scripts/cli.mjs self status
node scripts/cli.mjs self backup
```

---

## dev/ 里的工具什么时候用

| 工具 | 什么时候用 |
|---|---|
| `fix-ps1.mjs` | 改过任何 `.ps1` 后跑一次。PS 5.1 无 BOM 时按系统 ANSI 读，中文注释会变乱码导致语法报错 |
| `gen-bats.mjs` | 只有**增删** `self/windows/*.ps1` 时才跑；只改内容不用（bat 只是转发） |
| `split_app.py` | 不要跑。它依赖 v0.11 时 `src/app.js` 的结构，现在跑会破坏代码，仅留档回溯 |

---

## 改脚本前必读

`OPS.md` 末尾的「维护者注意事项」列了六个已验证的坑（bat 必须纯 ASCII、
ps1 必须带 BOM、PS 脚本间调用要走子进程等），改之前先扫一眼，能省掉大量排查时间。
