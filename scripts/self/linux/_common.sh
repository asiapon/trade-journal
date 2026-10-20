#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/_common.sh —— Linux 自托管脚本共用
# -----------------------------------------------------------------------------
#  被同目录下所有 .sh 通过 source 引入，不单独执行。
#  统一解析路径、服务名、端口，并统一输出风格。
# =============================================================================

set -uo pipefail

# ---------- 脚本原始参数 ----------
# source 不改变位置参数，所以这里的 "$@" 就是调用脚本时传的参数。
# early_help 与 need_root 靠它判断是否在请求帮助。
SCRIPT_ARGV=("$@")

# ---------- 路径 ----------
# scripts/self/linux/ → 上溯三级到仓库根
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$_SELF_DIR/../../.." && pwd)"
DEPLOY_DIR="$REPO/deploy/selfhost"
ENV_FILE="$DEPLOY_DIR/.env"
SERVICE_TEMPLATE="$DEPLOY_DIR/trade-journal.service"

# ---------- 服务名 ----------
# 历史遗留：v3.10.x 的 install 装的叫 stock-journal，模板文件却叫 trade-journal。
# 这里优先认新名，找不到再回退旧名，保证老机器也能被管到。
SERVICE=""
detect_service() {
  if [ -n "$SERVICE" ]; then return 0; fi
  if systemctl list-unit-files 2>/dev/null | grep -qx "trade-journal.service"; then
    SERVICE="trade-journal"
  elif systemctl list-unit-files 2>/dev/null | grep -qx "stock-journal.service"; then
    SERVICE="stock-journal"
    warn "检测到旧服务名 stock-journal（v3.10 时代安装），建议重跑 install.sh 迁移到 trade-journal"
  else
    SERVICE="trade-journal"   # 都没装，用新名
  fi
}

# ---------- 端口 ----------
read_port() {
  local p=3000
  if [ -f "$ENV_FILE" ]; then
    local v
    v="$(grep -E '^\s*PORT\s*=' "$ENV_FILE" 2>/dev/null | tail -1 | sed -E 's/^[^=]*=\s*//')"
    case "$v" in
      ''|*[!0-9]*) : ;;
      *) p="$v" ;;
    esac
  fi
  printf '%s' "$p"
}

# ---------- 输出 ----------
if [ -t 1 ]; then
  C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[36m'
  C_D=$'\033[90m'; C_BD=$'\033[1m'; C_0=$'\033[0m'
else
  C_G=''; C_R=''; C_Y=''; C_B=''; C_D=''; C_BD=''; C_0=''
fi

title() { printf '\n%s%s%s\n%s\n' "$C_BD" "$1" "$C_0" "$C_D$(printf '─%.0s' $(seq 1 50))$C_0"; }
step()  { printf '\n%s▶ %s%s\n' "$C_B" "$1" "$C_0"; }
ok()    { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; }
warn()  { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$1"; }
info()  { printf '  %s·%s %s\n' "$C_D" "$C_0" "$1"; }
bad()   { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1" >&2; }
die()   { printf '\n  %s✗ %s%s\n' "$C_R" "$1" "$C_0" >&2; exit 1; }
footer(){ printf '\n%s\n' "$C_D$(printf '─%.0s' $(seq 1 50))$C_0"; for l in "$@"; do printf '  %s\n' "$l"; done; printf '%s\n' "$C_D$(printf '─%.0s' $(seq 1 50))$C_0"; }

# ---------- 权限 ----------
# --help 不该被 root 检查拦住：非特权用户也应该能看用法。
# 自动打印脚本头部的注释块（跳过 shebang，遇到第一行非注释即停）。
early_help() {
  local script="${1:-$0}"
  for a in "${SCRIPT_ARGV[@]:-}"; do
    case "$a" in
      -h|--help)
        awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$script" 2>/dev/null
        exit 0
        ;;
    esac
  done
}

need_root() {
  for a in "${SCRIPT_ARGV[@]:-}"; do
    case "$a" in -h|--help) return 0 ;; esac
  done
  [ "$(id -u)" -eq 0 ] || die "请用 sudo 运行：sudo $0"
}

# ---------- 依赖 ----------
require_deployed() {
  [ -f "$DEPLOY_DIR/server.js" ] || die "找不到后端服务：$DEPLOY_DIR/server.js（仓库不完整？）"
}
