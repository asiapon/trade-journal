#!/usr/bin/env bash
# =============================================================================
#  操作日志 · 一键发布（Linux / macOS / Windows Git Bash）
# -----------------------------------------------------------------------------
#  用法：
#    ./publish.sh              交互式菜单
#    ./publish.sh check        只体检（构建 + 测试 + 产物校验）
#    ./publish.sh cf           发布到 Cloudflare Workers + D1
#    ./publish.sh local        本地构建并起预览服务
#    ./publish.sh wb           构建 + 同步到 WorkBuddy 发布目录
#    ./publish.sh self         同步到自托管服务器
#    ./publish.sh dev          启动开发服务器（热更新）
#    ./publish.sh cf-bootstrap 首次：建 D1 库 + 远端建表
#    ./publish.sh cf-delete    删除 Cloudflare 部署（含 D1，数据会丢）
#    ./publish.sh env          生成 .env.local 模板
#
#  凭据文件：脚本同目录 .env.local（已在 .gitignore 里，不会提交）
# =============================================================================
set -uo pipefail

# 切到脚本所在目录，保证从哪里调用都行
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_D=$'\033[90m'; C_B=$'\033[1m'; C_0=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$1"; }
err()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1" >&2; }

# ---------- 0. Node 前置检查 ----------
if ! command -v node >/dev/null 2>&1; then
  err "找不到 node 命令。请先安装 Node.js 18+：https://nodejs.org/"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  err "Node 版本过低（当前 v$(node -p 'process.versions.node')），需要 18+"
  exit 1
fi

# ---------- 1. 加载 .env.local ----------
# 已是环境变量的值优先，不被文件覆盖
if [ -f .env.local ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    # 去掉 key 两端空白
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -z "$key" ] && continue
    # 去掉 val 两端空白与可能的引号
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    if [ -z "${!key:-}" ] && [ -n "$val" ]; then
      export "$key=$val"
    fi
  done < .env.local
  ok "已加载 .env.local"
fi

# ---------- 2. 依赖检查 ----------
if [ ! -d node_modules ]; then
  warn "还没装依赖，正在执行 npm install ..."
  npm install || { err "npm install 失败"; exit 1; }
fi

# ---------- 3. 生成凭据模板 ----------
make_env() {
  if [ -f .env.local ]; then
    warn ".env.local 已存在，不覆盖。当前内容："
    echo
    sed 's/^/    /' .env.local
    return 0
  fi
  cat > .env.local <<'TPL'
# 发布凭据（本文件已被 .gitignore 忽略，不会提交到 git）
# 填完直接跑 ./publish.sh cf，不用再手动 export

# Cloudflare：dash.cloudflare.com -> My Profile -> API Tokens
# 权限至少需要 Workers Scripts:Edit + D1:Edit
CLOUDFLARE_API_TOKEN=

# 账户 ID：Cloudflare 控制台 Workers 概览页右下角
CLOUDFLARE_ACCOUNT_ID=

# 自托管用（user@host 形式），不用可留空
SELF_HOST=
SELF_PATH=/opt/stockjournal/dist
TPL
  chmod 600 .env.local 2>/dev/null
  ok "已生成 .env.local（权限 600），填好凭据再跑发布"
  echo "    ${C_D}编辑：nano .env.local${C_0}"
}

# ---------- 4. 菜单 ----------
CMD="${1:-}"
if [ -z "$CMD" ]; then
  echo
  echo "  ${C_B}操作日志 · 发布工具${C_0}"
  echo "  ============================================"
  echo
  echo "    [1] 体检      构建 + 测试 + 产物校验（不改线上）"
  echo "    [2] 发布 CF   发布到 Cloudflare Workers + D1"
  echo "    [3] 本地预览  构建后起服务看效果"
  echo "    [4] 同步 WB   构建 + 拷到 WorkBuddy 发布目录"
  echo "    [5] 自托管    同步到自己的服务器"
  echo "    [6] 开发模式  热更新，改代码即时生效"
  echo "    [7] CF 初始化 首次建 D1 库 + 建表"
  echo "    [8] 生成凭据模板 .env.local"
  echo "    [0] 退出"
  echo
  printf '  请输入序号后回车：'
  read -r SEL
  case "$SEL" in
    1) CMD=check ;;
    2) CMD=cf ;;
    3) CMD=local ;;
    4) CMD=wb ;;
    5) CMD=self ;;
    6) CMD=dev ;;
    7) CMD=cf-bootstrap ;;
    8) CMD=env ;;
    0|'') exit 0 ;;
    *) err "序号无效：$SEL"; exit 1 ;;
  esac
fi

# ---------- 5. 分发 ----------
echo
echo "  ${C_B}>>${C_0} 执行：$CMD"
echo

case "$CMD" in
  dev)          exec npm run dev ;;
  cf-bootstrap) exec node scripts/cloudflare.mjs bootstrap ;;
  cf-delete)    exec node scripts/cloudflare.mjs delete ;;
  env)          make_env; exit 0 ;;
  check|cf|local|wb|self)
                exec node scripts/publish.mjs "$CMD" ;;
  *)
    err "未知命令：$CMD"
    echo "  可用：check | cf | local | wb | self | dev | cf-bootstrap | cf-delete | env"
    exit 1 ;;
esac
