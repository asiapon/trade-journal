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
npm test          # vitest（DataLayer/行情适配器/JS 技能包）
npm run dev       # 本地开发（localhost:5173）
npm run build     # 构建 → dist/
npm run preview   # 预览构建产物
```

## 部署

见 [deploy/DEPLOY.md](deploy/DEPLOY.md)：`npm run deploy:cf`（Cloudflare）· `deploy:wb`（WorkBuddy 云端）· `deploy:self`（自托管）。三环境数据库独立，设置页「环境能力」面板自动显示当前后端能力。
