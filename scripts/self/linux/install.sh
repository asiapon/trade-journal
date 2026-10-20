#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/install.sh —— 在 Linux 服务器上安装/升级自托管服务
# -----------------------------------------------------------------------------
#  用法：
#    sudo ./install.sh                       全新安装（缺依赖会用 apt 装）
#    sudo ./install.sh --no-deps             跳过系统依赖安装（已自备 Node/PG）
#    sudo ./install.sh --port 8080           指定端口（默认沿用 .env 或 3000）
#    ADMIN_USER=xxx ADMIN_PASSWORD=yyy sudo ./install.sh    指定管理员
#
#  幂等：重复跑是「升级」——保留数据库与 .env，只同步代码与 schema。
#  做的事：装依赖 → 建库建表 → 装 node 依赖 → 写 .env → 装 systemd 服务 → 启动
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
require_deployed
title "自托管 · 安装 / 升级"

NO_DEPS=0
PORT_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-deps) NO_DEPS=1; shift ;;
    --port) PORT_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

DB_NAME="${DB_NAME:-tradejournal}"
DB_USER="${DB_USER:-tradejournal}"
DB_PASSWORD="${DB_PASSWORD:-}"
PORT="${PORT_OVERRIDE:-$(read_port)}"
UPGRADE=0
[ -f "$ENV_FILE" ] && UPGRADE=1

echo "  仓库：$REPO"
[ "$UPGRADE" = 1 ] && info "检测到已有 .env，本次按「升级」处理（数据保留）"

# ---------- 1. 系统依赖 ----------
if [ "$NO_DEPS" = 0 ]; then
  step "系统依赖"
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    ok "基础工具就绪"

    # Node >= 18
    if command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)')" -ge 18 ]; then
      ok "已有 node $(node -v)"
    else
      info "安装 Node.js 20…"
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
      apt-get install -y -qq nodejs >/dev/null
      ok "已安装 node $(node -v)"
    fi

    # PostgreSQL
    if command -v psql >/dev/null 2>&1; then
      ok "已有 PostgreSQL 客户端"
    else
      info "安装 PostgreSQL…"
      apt-get install -y -qq postgresql postgresql-contrib >/dev/null
      ok "PostgreSQL 已安装"
    fi
    systemctl enable --now postgresql >/dev/null 2>&1 || service postgresql start || true
  else
    warn "非 apt 系发行版，跳过自动装依赖。需自备：node>=18 / postgresql / curl"
  fi
else
  step "系统依赖"
  info "已按 --no-deps 跳过"
fi

command -v node >/dev/null 2>&1 || die "找不到 node（需 18+）"
ok "node $(node -v)"

# ---------- 2. 数据库 ----------
step "数据库初始化"
PG_VER="$(ls /etc/postgresql 2>/dev/null | head -1)"
PG_BIN="/usr/lib/postgresql/${PG_VER}/bin"
[ -x "${PG_BIN}/psql" ] || PG_BIN="$(dirname "$(command -v psql 2>/dev/null || echo /usr/bin/psql)")"
PSQL_ADMIN() { sudo -u postgres "${PG_BIN}/psql" "$@"; }

if [ -z "$DB_PASSWORD" ]; then
  if [ "$UPGRADE" = 1 ]; then
    # 升级：沿用 .env 里的密码，不改动，避免服务连不上
    DB_PASSWORD="$(grep -E '^\s*DATABASE_URL\s*=' "$ENV_FILE" | tail -1 | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')"
    info "沿用现有 .env 里的数据库密码"
  else
    DB_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
    GENERATED_PW=1
  fi
fi

PSQL_ADMIN -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1 \
  || PSQL_ADMIN -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
# 角色已存在时同步密码——否则重装后 .env 与角色旧密码不一致，认证必失败
PSQL_ADMIN -qc "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'" 2>/dev/null || true
PSQL_ADMIN -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1 \
  || PSQL_ADMIN -qc "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
ok "角色与库就绪"

PSQL_ADMIN -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "$DEPLOY_DIR/schema.sql" >/dev/null 2>&1 \
  && ok "schema 已同步（幂等）" \
  || warn "schema 执行有告警（重复对象属正常）"

# 管理员：仅在库里一个账号都没有时才创建，升级不覆盖
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
RESP="$(PSQL_ADMIN -d "${DB_NAME}" -tAc "SELECT public.app_setup_admin('${ADMIN_USER}', '${ADMIN_PASSWORD}');" 2>/dev/null || true)"
if printf '%s' "$RESP" | grep -q '"ok" *: *true'; then
  ok "管理员 ${ADMIN_USER} 已创建"
elif printf '%s' "$RESP" | grep -qE '已初始化|已存在'; then
  info "已有管理员，保留现有账号"
else
  warn "管理员创建返回：${RESP:-无响应}（可打开网页用「首次初始化」创建）"
fi

# ---------- 3. Node 依赖 ----------
step "后端依赖"
( cd "$DEPLOY_DIR" && npm install --omit=dev --no-fund --no-audit >/dev/null 2>&1 ) \
  && ok "node_modules 就绪" || die "npm install 失败（$DEPLOY_DIR）"

# Python：SKILL.md 整包技能包需要
if command -v python3 >/dev/null 2>&1; then
  python3 -m pip install --quiet --break-system-packages requests pandas stockstats mootdx baostock xlrd openpyxl 2>/dev/null \
    || python3 -m pip install --quiet requests pandas stockstats mootdx baostock xlrd openpyxl 2>/dev/null \
    && ok "Python 依赖就绪" \
    || warn "Python 依赖安装失败（技能包功能受影响，其余不受影响）"
else
  warn "未安装 python3 —— SKILL.md 技能包不可用，其余功能正常"
fi

# ---------- 4. .env ----------
step "配置 .env"
if [ "$UPGRADE" = 1 ]; then
  ok ".env 已存在，保持不变"
  info "端口：${PORT}（改端口请编辑 $ENV_FILE 后 ./restart.sh）"
else
  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
SYNC_AT=17:30
REQUIRE_KEY=0
ACCESS_KEY=
EOF
  chmod 600 "$ENV_FILE"
  ok "已生成 .env（权限 600）"
  [ "${GENERATED_PW:-0}" = 1 ] && info "数据库密码已随机生成并写入，无需记忆"
fi

# ---------- 5. systemd ----------
step "systemd 服务"
# 旧版本装的是 stock-journal，先清掉避免两个服务抢同一端口
if systemctl list-unit-files 2>/dev/null | grep -qx 'stock-journal.service'; then
  warn "发现旧服务 stock-journal，正在迁移到 trade-journal"
  systemctl stop stock-journal 2>/dev/null || true
  systemctl disable stock-journal 2>/dev/null || true
  rm -f /etc/systemd/system/stock-journal.service
fi

cat > /etc/systemd/system/trade-journal.service <<EOF
[Unit]
Description=Trade Journal (操作日志) self-hosted server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${DEPLOY_DIR}
ExecStart=$(command -v node) ${DEPLOY_DIR}/server.js
Restart=always
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable trade-journal >/dev/null 2>&1
ok "服务单元已安装（trade-journal）"

# ---------- 6. 启动 ----------
step "启动服务"
systemctl restart trade-journal
OKFLAG=0
for _ in $(seq 1 15); do
  sleep 1
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '"ok"'; then
    OKFLAG=1; break
  fi
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$OKFLAG" = 1 ]; then
  ok "健康检查通过"
  footer \
    "本机：  http://localhost:${PORT}" \
    "局域网：http://${IP:-<本机IP>}:${PORT}" \
    "" \
    "启动 sudo ./start.sh   停止 sudo ./stop.sh   重启 sudo ./restart.sh" \
    "状态 ./status.sh       日志 ./logs.sh        备份 sudo ./backup.sh" \
    "" \
    "${UPGRADE:+升级已完成。}首次使用：打开网页 → 首次初始化 → 设置管理员"
else
  bad "健康检查未通过（端口 ${PORT}）"
  info "./logs.sh -n 80   或   journalctl -u trade-journal -n 50"
  info "常见原因：PostgreSQL 没跑 / .env 里密码与角色不一致"
  exit 1
fi
