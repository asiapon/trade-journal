# 操作日志（trade-journal）

个人记账/自选/问答一体化的纯前端应用（Vite + ES Modules 构建，三环境部署同一份 dist）。

## 功能

- **总览**：大盘指数、持仓快照（移动加权平均）、今日盈亏
- **查询**：逐笔/按股票两种视图、费用明细、自然语言记一笔
- **自选**：多分组、排序、行情轮询
- **分析**：K线多源拉取（东财/腾讯）、技术指标、选股诊断
- **问答**：LLM Agent（免密云端模型/自定义模型）+ 技能工具
- **语音**：双引擎（Web Speech / MediaRecorder→ASR）
- **数据中心**：全市场名录、板块成分、K线库、周K聚合

## 架构

```
src/
├─ app.js        协调器（119 行：全局 LLM、版本、renderAll、classic 脚本桥）
├─ core/         data-layer（统一取数：注册表/single-flight/熔断/降级/健康）
│                capabilities（三环境能力探测）· netlog · stockdict · app-state · ui-state
├─ sources/      东财/腾讯行情适配器
├─ storage/      gateway（三环境 RPC 网关：WorkBuddy 云库 / 自托管 PG / CF D1）
├─ features/     journal · overview · watchlist · qa · diagnose · quotes · llm · me · voice · auth · jskills
└─ ui/           bind（事件委托/视图切换）· widgets · health-panel
public/          kline-store · analysis-extra · qa-tools · data-hub（经典脚本，经 app.js 桥共享符号）
deploy/          DEPLOY.md（三环境部署手册）+ cloudflare/ + selfhost/ + workbuddy 同步脚本
```

## 开发

```bash
npm install
npm test          # vitest（DataLayer/行情适配器/JS 技能包），20 用例
npm run dev       # 本地开发（localhost:5173）
npm run build     # 构建 → dist/
npm run preview   # 预览构建产物
```

## 发布与运维

所有脚本在 `scripts/` 下，统一入口是 `scripts/cli.mjs`：

```bash
node scripts/cli.mjs check            # 体检：构建 + 产物校验 + 测试
node scripts/cli.mjs cf deploy        # 发布到 Cloudflare Workers + D1（纯命令行上线）
node scripts/cli.mjs self install     # 在服务器上安装/升级自托管服务
node scripts/cli.mjs self status      # 服务状态
node scripts/cli.mjs help             # 完整命令列表
```

也有一批 npm 快捷方式：`npm run check`、`npm run deploy:cf`、`npm run self:backup`、
`npm run cf:status` 等，完整列表见 `package.json` 的 `scripts`。

凭据写在仓库根 `.env.local`，脚本启动时自动加载。该文件已被 git 忽略。

| 通道 | 纯命令行 | 数据库 | 独有能力 |
|---|:---:|---|---|
| Cloudflare | ✅ | D1 | — |
| 自托管 | ✅ | PostgreSQL | Python 技能包、服务端日志、定时采集 |

> WorkBuddy 托管的发布动作只能在客户端界面里点，无法脚本化，
> 相关命令已于 v3.20 移除（前端的云服务适配代码仍保留，见 `deploy/DEPLOY.md`）。

自托管提供完整运维脚本（Linux + Windows 双平台）：
安装 / 启动 / 停止 / 重启 / 状态 / 日志 / 备份 / 恢复 / 卸载 / 重置库 / 重置 PG 密码。

**同一份 `dist/` 可上任意环境**：前端启动时自动探测当前后端类型
（有 RPC 端点走 18 函数 RPC，否则走平台云服务 PostgREST），无需分别打包。
登录方式统一为用户名 + 密码。

- 运维手册：[scripts/OPS.md](scripts/OPS.md)
- 部署物说明：[deploy/DEPLOY.md](deploy/DEPLOY.md)

