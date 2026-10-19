# trade-journal（操作日志）三环境部署手册

> 前置：`npm run build`（产物 dist/）。三环境共用同一份 18 函数 RPC 契约，数据库互相独立。

## ① 自托管（全功能：Python 技能包 + 服务端日志 + 定时采集）

物料：`deploy/selfhost/`（server.js 已指向 `../../dist`，含 `/api/capabilities` 能力自报）

```bash
# 本机首次
cd deploy/selfhost && npm install        # express + pg
cp .env.example .env                     # 填 DATABASE_URL / ACCESS_KEY / ASR_API_KEY / TENCENT_*
psql -d stockjournal -f schema.sql       # 建库（PostgreSQL）
node server.js                           # http://localhost:54444
```

```bash
# 云服务器更新（git pull 后）
npm run build && npm run deploy:self
```

`npm run deploy:self` = 构建 + 把 dist/ 打包同步到服务器（`SELF_HOST` 环境变量填
`user@host`，目标路径默认 `/opt/stockjournal/dist`，可在 scripts/sync-self.mjs 改）。
K线定时采集（每天 SYNC_AT）与 Python 技能包（/api/pack/*）只有此环境有。

## ② WorkBuddy 云端（保域名发布）

```bash
npm run build && npm run deploy:wb       # 构建 + 同步到发布目录
```

然后让助手对 `C:\lyz\workspace\stock-journal` 目录执行 WorkBuddy 发布
（域名 stock-journal-07300.app.workbuddy.host 绑定该目录，不可换目录直发）。
注意：① 的云库是独立数据库——首次使用需重新初始化管理员，或从②导出 JSON 导入。

## ③ Cloudflare（Workers + D1）

环境变量（三组脚本都需要）：

```powershell
$env:CLOUDFLARE_API_TOKEN="cfat_..."      # dash.cloudflare.com → My Profile → API Tokens（需 D1/Workers 编辑权限）
$env:CLOUDFLARE_ACCOUNT_ID="9ae97..."
```

```bash
npm run cf:bootstrap    # 首次：确保 D1 → 写 database_id → 远端建表（幂等可重跑）
npm run deploy:cf       # 日常：构建 + 发布
npm run cf:delete       # 删除部署：Worker + D1（交互确认；--yes 跳过）
```

语音/密钥（可选）：`npx wrangler secret put ASR_API_KEY -c deploy/cloudflare/wrangler.toml`（同 TENCENT_SECRET_ID/KEY）。

能力差异（设置页「环境能力」面板自动显示）：③ 无 Python 技能包/定时采集；
① 无服务端日志（前端日志代替）；② 全功能。各环境数据库独立，互不相通。

## 附2：删除 / 下线各环境部署

| 环境 | 删除方式 |
|---|---|
| ③ Cloudflare | `npm run cf:delete`（删 Worker + D1 全部数据，交互确认；重装 `npm run cf:bootstrap && npm run deploy:cf`） |
| ① WorkBuddy | 让助手执行下线（unpublish），或自己：设置 → 数据管理 → 应用 → 删除应用（域名随之释放，**不可恢复**） |
| ② 自托管 | 用 stop-windows.ps1 停服务（站点即下线；数据在 PG 里不受影响，再启动即恢复） |

注：CF 的 cf:delete 会连 D1 库一起删（已单独确认）；①删除应用会连云库一起释放，删前先导出 JSON。

## 附：JS 技能包（三环境通用，v0.12.0）

与 SKILL.md/Python 技能包（仅②自托管可执行）互补：JS 技能在 ①②③ 全部可用（浏览器沙箱，零服务端依赖）。安装入口：**设置 → 技能 → JS 技能包**，粘贴一个 SKILL.json 直链即可。

SKILL.json 格式：

```json
{
  "id": "demo-skill",
  "name": "演示技能",
  "version": "1.0.0",
  "description": "一句话说明",
  "tools": [ { "name": "tool_a", "description": "给问答 Agent 的工具说明（它会据此决定何时调用）" } ],
  "code": "const t = { async tool_a(args, ctx) { const r = await ctx.http('https://api.example.com/x'); const j = await r.json(); return JSON.stringify(j); } }; return t;"
}
```

约定：`code` 在 `new Function('ctx', code)` 沙箱里执行，**必须 return 一个 `{ 工具名: async (args, ctx) => 结果文本 }` 对象**；沙箱只提供 `ctx.http(url, opts)`（10s 超时）、`ctx.now()`、`ctx.utils.esc`，无 DOM/存储访问；单次执行 15s 超时；≤20 个技能、单技能 code ≤256KB；同 id 重装即更新。安装后问答 Agent 自动多出一个 `jskill` 工具。
