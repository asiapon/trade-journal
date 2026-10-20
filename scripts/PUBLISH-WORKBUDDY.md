# WorkBuddy 应用发布手册

> 这份文件的存在原因：2026-10-20 连续三次「发布成功」但用户打开是空壳 / 本地模式。
> 每次都是发完就说成功，没在用户视角验证。下面每一步都带验证命令，**跳过验证就等于没做**。

---

## 适用场景

- 首次把本项目发布到 WorkBuddy 云端
- 用户删掉旧应用后要「按新应用重新发布」
- 换应用后页面显示「云服务未启用」或「本地模式」

> 发布动作通过 MCP 工具完成（`workbuddy_sites_deploy` / `workbuddy_cloud_service`），
> 不是命令行脚本。**没有命令行凭证可以脱离客户端发布** —— 这是平台限制。

---

## 一次成功的判断标准

只有这两条都成立才算发布完成，缺一不可：

1. `node scripts/dev/verify-deploy.mjs ...` **全绿**（下面第 8 步）
2. 浏览器打开看到**「首次初始化」或登录页**，而不是右下角「本地模式」徽标

第 2 条只能人眼看，但第 1 条全绿时第 2 条基本都是对的（已实测）。

---

## 核心认知：三个东西是分开的

这是最容易搞混的地方，也是我出错三次的根源：

| 东西 | 谁提供 | 激活后就有吗 |
|---|---|---|
| **托管环境**（能打开页面） | `workbuddy_sites_deploy` 发布 | ✅ 有 |
| **云服务环境**（数据库/认证可用） | `workbuddy_cloud_service` activate | ❌ 激活只是给环境，**表要自己建** |
| **表与函数**（9 表 + 19 函数） | 手动执行 schema | ❌ 必须自己建 |

「页面能打开」≠「后端能用」。纯静态发布 + 没激活云服务 = 页面能开但没数据。

---

## 步骤

### 1. 查应用现状

```
workbuddy_cloud_service  action=inspect  directory=<发布目录>
```

看返回的 `activated` 和 `applications` 列表，拿到 `applicationId`。

**若 `activated: false`** → 后面第 2 步必须做。
**若应用列表为空** → 用户真删干净了，得先 create。

### 2. 激活云服务（如未激活）

```
workbuddy_cloud_service  action=activate
  applicationMode=reuse  applicationId=wbapp_xxx
  directory=<发布目录>  intent=<用用户的话概括，如"记账和登录">
```

会弹 UI 确认框，由用户决定，不要自己用文字问。

成功后返回 `publicConfig`，记下两个值：
- `endpoint`（形如 `https://xxx.app.workbuddy.host`）
- `publishableKey`（形如 `wbpk_xxx_yyy`）

### 3. 改前端配置（三处，必须全改）

文件：`src/storage/gateway.js`

```js
export const CLOUD_CONFIG = {
  endpoint: '<publicConfig.endpoint>',          // ← 改
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: '<publicConfig.publishableKey>',  // ← 改
};
...
export const ACCESS_KEY = CLOUD_CONFIG.publishableKey;  // ← 保持这样，别再独立硬编码
```

**坑**：`ACCESS_KEY` 历史上是一个独立硬编码的旧 key，和 `publishableKey` 不是同一个。
请求头 `x-wb-webapp-access-key` 用的是 `ACCESS_KEY`，只改 `publishableKey` 会一直 401。
现在已改成复用，别再拆开。

**验证**：

```bash
grep -rn "55799\|wbpk_" src/ | grep -v "wbpk_kQyb" # 应无旧值（当前应用 key 除外）
```

`src/core/capabilities.js` 里的 file:// 兜底已改为引用 `CLOUD_CONFIG.endpoint`，不用单独改。

### 4. 构建 + 体检

```bash
node scripts/cli.mjs dev check
```

会拦：静态资源缺失 / 退役域名残留 / 单测失败。

**验证**：产物里的 key 必须是新的

```bash
grep -o "wbpk_[A-Za-z0-9_]*" dist/assets/*.js | sort -u
# 应只有一个，且等于新应用的 publishableKey
```

### 5. 建库（9 表 + 19 函数）

> 激活云服务**不会**建表。这步跳过，页面会报错或查询全空。

用 `workbuddy_cloudservice_db_exec_sql`，`mode=migrate`，逐批执行。

**关键：schema.sql 的前 3 条要跳过** —— 云服务环境已有 `auth` schema 和 `auth.uid()`：

```
① CREATE EXTENSION pgcrypto        ← 跳过
② CREATE SCHEMA auth               ← 跳过
③ CREATE FUNCTION auth.uid()       ← 跳过
```

其余 33 条拆 4 批，用 DO 块批量执行：

```sql
DO $wrap$
BEGIN
  EXECUTE $q$ CREATE TABLE ... $q$;
  EXECUTE $q$ CREATE TABLE ... $q$;
END
$wrap$;
```

**踩过的坑：定界符必须留空格**

```sql
EXECUTE $q$ ... AS $function$ SELECT ... $function$ $q$;
                                        ↑ 这里必须有空格
```

写成 `$function$$q$` 会被 PG 词法分析器判成「未闭合的 dollar-quote」直接报错。
`END $$$q$` 同理，要写成 `END $$ $q$`。

**拆语句也要认 `$tag$` 而不是只认 `$$`** —— 只认 `$$` 会把函数体切碎
（36 条会被误切成 253 条）。

**验证**：

```sql
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname LIKE 'app\_%') AS app_fns,
  public.app_has_users() AS probe
```

期望：`tables=9`、`app_fns=15`、`probe` 返回 **`{"ok":true,"data":false}`**（不是 `false`！）

### 6. 准备干净的发布目录

产物目录里**不能有任何旧应用标记**，否则会报 `SITES_APP_NOT_FOUND`：

```bash
rm -rf /path/to/publish-dir && mkdir -p /path/to/publish-dir
cp -r dist/* /path/to/publish-dir/
ls -1a /path/to/publish-dir | grep -E "^\.(wbapp|workbuddy)"   # 必须为空
```

**坑**：平台按**目录路径**记应用绑定。同一个目录如果曾发布到已删除的应用，
再发布会被拒绝（"为避免悄悄更换分享链接"），且不能在本会话内绕过。
换一个全新目录路径即可。

### 7. 发布

```
workbuddy_sites_deploy
  directory=<发布目录>
  appId=<applicationId>        ← 复用，保住域名与云服务 Origin
  language=static
  appName=<简短中文名>
  domainPrefix=<英文短横线 slug>  ← 第一次建应用时确定，事后不可改
  userAskedToPublish=true      ← 仅当用户本轮明确要求发布
```

### 8. 必跑自检（不要跳过）

```bash
node scripts/dev/verify-deploy.mjs <发布域名> \
  --key <publishableKey> --sharecode <码>
```

五项检查：

| # | 检查 | 失败含义 |
|---|---|---|
| ① | 页面 200 + 引用了 `assets/index-*.js` | 域名错 / 发布没生效 / 发的是源码不是 dist |
| ② | 产物 endpoint 与发布域名一致 | 前端还指向旧应用域名 |
| ③ | 产物 key 唯一且等于期望值 | 还带旧 key，或两个 key 并存 |
| ④ | `app_has_users` 返回 `{ok,...}` 信封 | **见下面「裸值」坑** |
| ⑤ | RPC 路径不带 query 也能通 | 路径拼错 |

**全绿才可以说"发布成功"**。非 0 退出码时不要向用户报告成功。

### 9. 人眼确认

浏览器打开 `https://xxx.app.workbuddy.host/?sharecode=xxx`：

- ✅ 看到「首次初始化」页签（库里没账号）或登录页 → 成功
- ❌ 右下角显示「本地模式」/ 直接进了主界面且无登录 → 失败，回第 3 步查配置

---

## 四个坑（都是真踩过的）

### 坑 1：以为「发布成功」= 「能用」

`workbuddy_sites_deploy` 返回 `verified: true` 只代表**文件上传成功**，
不代表前端能连上数据库。必须走完第 2、5 步并跑第 8 步自检。

### 坑 2：激活云服务 ≠ 建表

`workbuddy_cloud_service action=activate` 只 provision 环境并返回 `publicConfig`。
`db_list_tables` 会返回 `[]`。表必须自己执行 schema 建。

### 坑 3（最隐蔽）：`app_has_users` 返回裸 boolean

前端 `features/auth.js`：

```js
const r = await rpc('app_has_users');
if (!r || !r.ok) throw new Error('后端不可用');  // 裸 false 让 !r 成立 → 抛
return !!r.data;
```

`boot()` 的 catch 把**任何**异常都当「云端不可达」，静默 `setStore(localStore)` 进本地模式。
页面上不显示任何错误，只看得到「本地模式」徽标。

**正确写法**（三处实现必须同形）：

```sql
-- PostgreSQL（selfhost + 云服务）
RETURNS jsonb AS SELECT jsonb_build_object('ok', true, 'data', EXISTS (SELECT 1 FROM app_users))
```

```js
// Cloudflare（deploy/cloudflare/src/rpc.js）
return { ok: true, data: !!r.n };
```

改返回类型时必须先 `DROP FUNCTION`，PG 不允许 `CREATE OR REPLACE` 改返回类型。

### 坑 4：发布目录残留旧应用标记

目录里有 `.wbapp_<旧appId>.genie` 或 `.workbuddy/applications.yaml` 指向已删应用时，
发布会返回 `SITES_APP_NOT_FOUND`，且提示「这个目录不能再发布」。
解决：换一个全新目录路径，并确保里面没有这些标记文件。

---

## 两个平台行为（不是 bug，别去修）

**`sharecode`**：每条发布链接都带 `?sharecode=xxx`，是平台分享凭证。
不带会被 403。同一应用重发布复用同一个码。它不影响云服务 Origin 校验
（Origin 只看域名，不含 query）。

**RPC 路径不能带 query**：`/.cloud/database/rest/rpc/xxx?sharecode=x` 会 400。
前端用相对路径 `/.cloud/database/rest/rpc/xxx`，天然不带 query，所以没问题。

---

## 下次让我重新发布时，直接照这个说

> 按 `scripts/PUBLISH-WORKBUDDY.md` 走，发布完跑 `verify-deploy.mjs`，全绿再回报。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/storage/gateway.js` | 三处配置（endpoint / publishableKey / ACCESS_KEY） |
| `src/core/capabilities.js` | 环境能力探测，file:// 兜底域名 |
| `src/features/auth.js` | `selectBackend()` / `hasUsers()`，失败会静默降级 |
| `deploy/selfhost/schema.sql` | PostgreSQL 版 schema（自托管 + 云服务共用） |
| `deploy/cloudflare/src/rpc.js` | D1 版函数实现（契约参照） |
| `scripts/dev/verify-deploy.mjs` | 发布后自检 |
