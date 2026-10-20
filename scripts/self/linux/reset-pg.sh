#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/reset-pg.sh —— 重置 PostgreSQL postgres 超级用户密码
# -----------------------------------------------------------------------------
#  用法：
#    sudo ./reset-pg.sh                     交互输入新密码
#    sudo ./reset-pg.sh --pwd 新密码
#
#  Linux 与 Windows 不同：本机走 peer 认证（sudo -u postgres）就能改密码，
#  不需要像 Windows 那样临时改 pg_hba.conf。这个脚本主要是给「忘了密码、
#  又要从别的机器/客户端连进来」的场景用。
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
title "重置 postgres 密码"

NEWPWD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pwd|--password) NEWPWD="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

if [ -z "$NEWPWD" ]; then
  printf '  输入 postgres 的新密码：'
  read -rs NEWPWD
  echo ""
  printf '  再输入一次确认：'
  read -rs AGAIN
  echo ""
  [ "$NEWPWD" = "$AGAIN" ] || die "两次输入不一致"
fi
[ -n "$NEWPWD" ] || die "密码不能为空"

# ---------- 定位 ----------
PG_VER="$(ls /etc/postgresql 2>/dev/null | head -1)"
[ -n "$PG_VER" ] || die "找不到 /etc/postgresql，确认 PostgreSQL 已安装"
PG_BIN="/usr/lib/postgresql/${PG_VER}/bin"
[ -x "${PG_BIN}/psql" ] || PG_BIN="$(dirname "$(command -v psql 2>/dev/null || echo /usr/bin/psql)")"

step "检查服务"
if ! systemctl is-active postgresql >/dev/null 2>&1; then
  info "PostgreSQL 没在运行，尝试启动…"
  systemctl start postgresql || die "启动失败：journalctl -u postgresql -n 30"
fi
ok "PostgreSQL 运行中"

step "修改密码"
# peer 认证：以 postgres 系统用户执行，无需旧密码
if sudo -u postgres "${PG_BIN}/psql" -qc "ALTER USER postgres PASSWORD '${NEWPWD}';" 2>/dev/null; then
  ok "密码已修改"
else
  die "修改失败。可能是 pg_hba.conf 配置了强制密码认证（少见），或 postgres 系统用户不存在"
fi

step "验证"
# 用新密码走 TCP 验证（而不是 peer，才能真正验证密码生效）
if PGPASSWORD="$NEWPWD" "${PG_BIN}/psql" -U postgres -h 127.0.0.1 -tAc "SELECT 'OK'::text" 2>/dev/null | grep -q OK; then
  ok "新密码验证通过（TCP 连接）"
  footer \
    "新密码已生效" \
    "如果自托管服务用的不是 postgres 账号，密码变更不影响它（.env 里的是 ${DB_USER:-tradejournal}）"
else
  warn "TCP 验证未通过"
  info "可能 pg_hba.conf 只允许特定来源连接；本机 peer 方式已可用"
  info "检查：sudo cat /etc/postgresql/${PG_VER}/main/pg_hba.conf"
fi
