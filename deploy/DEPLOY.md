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

```bash
# 首次：建库 + 建表（需 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 环境变量）
export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...
npx wrangler d1 create trade-journal     # 把输出的 database_id 填进 deploy/cloudflare/wrangler.toml
npx wrangler d1 execute trade-journal --remote -y --file=deploy/cloudflare/schema.d1.sql
npm run deploy:cf                        # 构建 + 发布 → https://trade-journal.<子域>.workers.dev

# 语音/密钥（可选）
npx wrangler secret put ASR_API_KEY -c deploy/cloudflare/wrangler.toml
npx wrangler secret put TENCENT_SECRET_ID -c deploy/cloudflare/wrangler.toml
npx wrangler secret put TENCENT_SECRET_KEY -c deploy/cloudflare/wrangler.toml
```

能力差异（设置页「环境能力」面板自动显示）：③ 无 Python 技能包/定时采集；
① 无服务端日志（前端日志代替）；② 全功能。各环境数据库独立，互不相通。
