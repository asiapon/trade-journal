#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/uninstall.sh —— 卸载自托管服务
# -----------------------------------------------------------------------------
#  用法：
#    sudo ./uninstall.sh             逐项询问（推荐）
#    sudo ./uninstall.sh --purge     连数据库一起删（危险，数据全丢）
#    sudo ./uninstall.sh --keep-db   只删服务与文件，数据库一定保留
#    sudo ./uninstall.sh --dry-run   只打印会删什么，不实际执行
#
#  原则：应用自己的东西逐项确认；Node/PostgreSQL/Python 等公共组件默认保留。
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
title "自托管 · 卸载"

PURGE=0
KEEP_DB=0
DRY=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --keep-db) KEEP_DB=1 ;;
    --dry-run|-n) DRY=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$a" ;;
  esac
done

DB_NAME="${DB_NAME:-tradejournal}"
DB_USER="${DB_USER:-tradejournal}"
detect_service

# dry-run 时不真的执行
run() {
  if [ "$DRY" = 1 ]; then info "[dry-run] $*"; else "$@"; fi
}

ask() {   # 回车 = 否，仅 y/Y = 是
  [ "$PURGE" = 1 ] && return 0
  [ "$DRY" = 1 ] && { info "[dry-run] 会询问：卸载 $1？"; return 0; }
  local a
  printf '  卸载 %s ？(y/N): ' "$1"
  read -r a
  [[ "$a" =~ ^[Yy] ]]
}

echo ""
warn "以下操作会逐个确认；公共组件（Node / PostgreSQL / Python）默认保留。"
[ "$PURGE" = 1 ] && bad "已指定 --purge：数据库也会被删除！"
[ "$KEEP_DB" = 1 ] && info "已指定 --keep-db：数据库一定保留"

# ---------- 1. 服务 ----------
step "停止并移除服务"
for svc in trade-journal stock-journal; do
  if systemctl list-unit-files 2>/dev/null | grep -qx "${svc}.service"; then
    run systemctl stop "$svc" 2>/dev/null || true
    run systemctl disable "$svc" 2>/dev/null || true
    run rm -f "/etc/systemd/system/${svc}.service"
    ok "已移除 ${svc}"
  fi
done
run systemctl daemon-reload
# 无 systemd 安装方式残留
if [ -f "$DEPLOY_DIR/.pid" ]; then
  PID="$(cat "$DEPLOY_DIR/.pid" 2>/dev/null || true)"
  [ -n "$PID" ] && kill "$PID" 2>/dev/null && ok "已停止后台进程 $PID"
  run rm -f "$DEPLOY_DIR/.pid"
fi

# ---------- 2. 应用文件 ----------
step "应用文件"
if [ -f "$ENV_FILE" ] && ask ".env（含数据库密码，删后需重新生成）"; then
  run rm -f "$ENV_FILE" && [ "$DRY" = 0 ] && ok ".env 已删除"
fi
if [ -d "$DEPLOY_DIR/node_modules" ] && ask "node_modules（后端依赖，重装= npm install）"; then
  run rm -rf "$DEPLOY_DIR/node_modules" && [ "$DRY" = 0 ] && ok "node_modules 已删除"
fi
if [ -d "$DEPLOY_DIR/packs" ] && ask "packs（已安装的 SKILL.md 技能包）"; then
  run rm -rf "$DEPLOY_DIR/packs" && [ "$DRY" = 0 ] && ok "packs 已删除"
fi
if [ -d "$DEPLOY_DIR/logs" ] && ask "logs（历史日志）"; then
  run rm -rf "$DEPLOY_DIR/logs" && [ "$DRY" = 0 ] && ok "logs 已删除"
fi
if [ -d "$REPO/backups" ] && ask "backups（备份文件，建议先拷走）"; then
  run rm -rf "$REPO/backups" && [ "$DRY" = 0 ] && ok "backups 已删除"
fi

# ---------- 3. 数据库 ----------
step "数据库（${DB_NAME}）"
if [ "$KEEP_DB" = 1 ]; then
  info "按 --keep-db 保留数据库"
else
  bad "删除数据库 = 交易记录 / 自选 / 问答历史 / 持仓全部清空，不可恢复！"
  if ask "删除数据库 ${DB_NAME} 与角色 ${DB_USER}"; then
    PG_VER="$(ls /etc/postgresql 2>/dev/null | head -1)"
    PG_BIN="/usr/lib/postgresql/${PG_VER}/bin"
    [ -x "${PG_BIN}/psql" ] || PG_BIN="$(dirname "$(command -v psql 2>/dev/null || echo /usr/bin/psql)")"
    run sudo -u postgres "${PG_BIN}/psql" -c "DROP DATABASE IF EXISTS ${DB_NAME};" && [ "$DRY" = 0 ] && ok "库已删除"
    run sudo -u postgres "${PG_BIN}/psql" -c "DROP ROLE IF EXISTS ${DB_USER};" && [ "$DRY" = 0 ] && ok "角色已删除"
  else
    info "已保留数据库（推荐——重装还能接着用）"
  fi
fi

# ---------- 4. Python 依赖 ----------
step "Python 依赖"
if ask "卸载 pip 包（requests pandas stockstats mootdx baostock xlrd openpyxl）"; then
  run python3 -m pip uninstall -y requests pandas stockstats mootdx baostock xlrd openpyxl >/dev/null 2>&1
  [ "$DRY" = 0 ] && ok "pip 包已卸载"
else
  info "保留 Python 依赖（别的项目可能也在用）"
fi

# ---------- 5. 公共组件 ----------
step "公共组件（默认保留，回车 = 保留）"
if ask "卸载 Node.js？（机器上可能有别的程序依赖）"; then
  run apt-get remove -y nodejs >/dev/null 2>&1 && [ "$DRY" = 0 ] && ok "Node.js 已卸载"
else
  info "保留 Node.js"
fi
if ask "卸载 PostgreSQL？⚠ 会删除服务器上全部数据库"; then
  run apt-get purge -y postgresql postgresql-contrib >/dev/null 2>&1 && [ "$DRY" = 0 ] && ok "PostgreSQL 已卸载"
else
  info "保留 PostgreSQL"
fi

if [ "$DRY" = 1 ]; then
  footer "以上为 dry-run，未实际改动任何东西。" "去掉 --dry-run 才会真正执行。"
else
  footer "重装： sudo ./install.sh（保留的组件会被复用）" "数据库保留的话，重装后数据还在。"
fi
