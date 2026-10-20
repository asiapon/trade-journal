#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/reset-db.sh —— 快速重置应用数据库（秒级，不卸载任何组件）
# -----------------------------------------------------------------------------
#  用法：
#    sudo ./reset-db.sh                     默认管理员 admin / admin123
#    sudo ./reset-db.sh --user bob --pwd 新密码
#    sudo ./reset-db.sh --yes               跳过确认（脚本调用）
#
#  做的事：删应用库 → 重建空库 → 导 schema → 建管理员
#          Node / PostgreSQL / Python 全部不动。
#  反复实验请用这个，别走「卸载 PostgreSQL → 重装」（那是分钟级的）。
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
title "快速重置应用数据库"

DB_NAME="${DB_NAME:-tradejournal}"
DB_USER="${DB_USER:-tradejournal}"
ADMIN_USER="admin"
ADMIN_PASSWORD="admin123"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) ADMIN_USER="${2:-admin}"; shift 2 ;;
    --pwd|--password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

bad "即将清空数据库 ${DB_NAME} 的全部数据（交易/自选/问答/持仓），不可恢复！"
if [ "$YES" != 1 ]; then
  printf '  确认重置？(y/N): '
  read -r a
  [[ "$a" =~ ^[Yy] ]] || { echo "  已取消"; exit 0; }
fi

# ---------- 定位 psql ----------
PG_VER="$(ls /etc/postgresql 2>/dev/null | head -1)"
PG_BIN="/usr/lib/postgresql/${PG_VER}/bin"
[ -x "${PG_BIN}/psql" ] || PG_BIN="$(dirname "$(command -v psql 2>/dev/null || echo /usr/bin/psql)")"
PSQL() { sudo -u postgres "${PG_BIN}/psql" "$@"; }

# ---------- 角色密码：沿用 .env ----------
DB_PASSWORD=""
if [ -f "$ENV_FILE" ]; then
  DB_PASSWORD="$(grep -E '^\s*DATABASE_URL\s*=' "$ENV_FILE" | tail -1 | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')"
fi

# ---------- 1. 重建库 ----------
step "重建数据库"
# 先断开连接，否则 DROP DATABASE 会因 "being accessed by other users" 失败
PSQL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
PSQL -c "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null 2>&1 || die "删库失败（有活动连接？先 ./stop.sh）"

if ! PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1; then
  [ -n "$DB_PASSWORD" ] || die "角色不存在且 .env 里没密码，先跑 sudo ./install.sh"
  PSQL -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
elif [ -n "$DB_PASSWORD" ]; then
  # 角色在但密码可能和 .env 对不上 → 同步
  PSQL -qc "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'" 2>/dev/null || true
fi
PSQL -qc "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}" || die "建库失败"
ok "库已重建"

# ---------- 2. 导 schema ----------
step "导入 schema"
[ -f "$DEPLOY_DIR/schema.sql" ] || die "找不到 $DEPLOY_DIR/schema.sql"
PSQL -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "$DEPLOY_DIR/schema.sql" >/dev/null 2>&1 \
  && ok "schema 已导入" \
  || warn "schema 执行有告警（重复对象属正常）"

# ---------- 3. 建管理员 ----------
step "创建管理员"
RESP="$(PSQL -d "${DB_NAME}" -tAc "SELECT public.app_setup_admin('${ADMIN_USER}', '${ADMIN_PASSWORD}');" 2>/dev/null || true)"
if printf '%s' "$RESP" | grep -q '"ok" *: *true'; then
  ok "管理员 ${ADMIN_USER} 已创建"
else
  warn "创建返回：${RESP:-无响应}（可打开网页用「首次初始化」创建）"
fi

PORT="$(read_port)"
footer \
  "重置完成：库 ${DB_NAME} 重建 + schema 同步 + 管理员 ${ADMIN_USER} / ${ADMIN_PASSWORD}" \
  "重启服务： sudo ./restart.sh" \
  "然后打开 http://localhost:${PORT} 用上述账号登录"
