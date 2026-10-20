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

## 发布

**最省事的方式：双击 `publish.bat`（Windows）或跑 `./publish.sh`（Linux/macOS）**，
弹菜单选序号即可，不用记命令、不用打开 WorkBuddy。

| 系统 | 脚本 | 说明 |
|---|---|---|
| Windows | `publish.bat` | 双击运行；末尾加 `--no-pause` 可供脚本调用 |
| Linux/macOS/Git Bash | `publish.sh` | `chmod +x` 已设置好 |

凭据写在仓库根 `.env.local`（跑一次菜单里的「生成凭据」会创建模板），
两个脚本启动时自动加载。该文件已被 git 忽略。

也可以直接用命令行入口 `scripts/publish.mjs`，会先构建 → 校验产物 → 跑测试，任一失败即中止：

```bash
npm run publish:check    # 只体检不发布
npm run publish:cf       # Cloudflare Workers + D1 ← 纯命令行，推荐
npm run publish:self     # 自托管（需要 SELF_HOST=user@host）
npm run deploy:wb        # 同步到 WorkBuddy 发布目录（仍需界面点发布）
npm run publish:local    # 本地构建 + 预览
```

| 通道 | 纯命令行 | 数据库 | 独有能力 |
|---|:---:|---|---|
| Cloudflare | ✅ | D1 | — |
| 自托管 | ✅ | PostgreSQL | Python 技能包、服务端日志、定时采集 |
| WorkBuddy | ❌ 需界面 | 云库 | — |

**同一份 `dist/` 可上任意环境**：前端启动时自动探测当前后端类型
（有 RPC 端点走 18 函数 RPC，否则走平台云服务 PostgREST），无需分别打包。
登录方式统一为用户名 + 密码。

详见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。

