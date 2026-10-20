#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/restore.sh —— 从备份恢复
# -----------------------------------------------------------------------------
#  用法：
#    sudo ./restore.sh backups/trade-journal-20261020-113000.tgz
#    sudo ./restore.sh backups/xxx.dump          （只有数据库，不动 .env）
#    sudo ./restore.sh <文件> --yes              跳过确认（脚本调用）
#
#  恢复内容：
#    .tgz  → 数据库 + .env（+ packs）
#    .dump → 只恢复数据库
#
#  注意：数据库是「覆盖式」恢复 —— 会先删掉同名库再重建，当前数据全部丢失。
#        恢复前会自动先做一次备份，放在 backups/pre-restore-*.tgz。
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
title "自托管 · 恢复"

SRC=""
YES=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) [ -z "$SRC" ] && SRC="$a" || die "只能指定一个备份文件" ;;
  esac
done

[ -n "$SRC" ] || die "用法：sudo ./restore.sh <备份文件> [--yes]"
[ -f "$SRC" ] || die "文件不存在：$SRC"
SRC="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"

# ---------- 解析连接串（优先用备份里的 .env，没有再用现场 .env） ----------
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT

DBDUMP=""
case "$SRC" in
  *.tgz|*.tar.gz)
    step "解包"
    tar -xzf "$SRC" -C "$TMPD" || die "解包失败（文件损坏？）"
    [ -f "$TMPD/db.dump" ] || die "包里没有 db.dump，不是本脚本产出的备份"
    DBDUMP="$TMPD/db.dump"
    ok "已解包"
    if [ -f "$TMPD/app.env" ]; then
      DBURL="$(grep -E '^\s*DATABASE_URL\s*=' "$TMPD/app.env" | tail -1 | sed -E 's/^[^=]*=\s*//')"
      info "使用备份内的 .env 连接串"
    fi
    ;;
  *.dump)
    DBDUMP="$SRC"
    ;;
  *)
    die "不认识的格式：$SRC（支持 .tgz / .dump）" ;;
esac

if [ -z "${DBURL:-}" ]; then
  [ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE，且备份里也没有配置。请先 ./install.sh"
  DBURL="$(grep -E '^\s*DATABASE_URL\s*=' "$ENV_FILE" | tail -1 | sed -E 's/^[^=]*=\s*//')"
  info "使用当前 .env 的连接串"
fi
printf '%s' "$DBURL" | grep -q '^postgres' || die "DATABASE_URL 不是 PostgreSQL 连接串"

# ---------- 从连接串取库名 / 用户 ----------
DBNAME="$(printf '%s' "$DBURL" | sed -E 's|.*/([^?]+).*|\1|')"
DBUSER="$(printf '%s' "$DBURL" | sed -E 's|.*://([^:@]+).*|\1|')"
[ -n "$DBNAME" ] || die "无法从连接串解析库名"

# ---------- 确认 ----------
echo ""
bad "⚠ 这会覆盖数据库「${DBNAME}」，当前数据将全部丢失！"
info "来源：$SRC"
info "目标：$DBNAME（用户 $DBUSER）"

if [ "$YES" != 1 ]; then
  printf '\n  确认恢复请输入 %syes%s（其他任意键取消）：' "$C_Y" "$C_0"
  read -r ans
  [ "$ans" = "yes" ] || { echo "  已取消，什么都没改。"; exit 0; }
fi

command -v pg_restore >/dev/null 2>&1 || die "找不到 pg_restore。安装：apt-get install postgresql-client"
command -v psql >/dev/null 2>&1 || die "找不到 psql。安装：apt-get install postgresql-client"

# ---------- 恢复前先自保 ----------
step "恢复前自动备份当前数据"
if "$_SELF_DIR/backup.sh" --keep 0 >/dev/null 2>&1; then
  LATEST="$(find "$REPO/backups" -maxdepth 1 -name 'trade-journal-*.tgz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  if [ -n "$LATEST" ] && [ -f "$LATEST" ]; then
    mkdir -p "$REPO/backups"
    PRE="$REPO/backups/pre-restore-$(date +%Y%m%d-%H%M%S).tgz"
    mv "$LATEST" "$PRE" && ok "已保存当前数据：$PRE"
  fi
else
  warn "自动备份失败，继续恢复（风险自负）"
fi

# ---------- 执行恢复 ----------
step "重建数据库"
# 断开现有连接后删库重建，避免 "database is being accessed by other users"
psql "$DBURL" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DBNAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
psql "$DBURL" -d postgres -c "DROP DATABASE IF EXISTS ${DBNAME};" >/dev/null 2>&1 || die "删库失败（权限不足？）"
psql "$DBURL" -d postgres -c "CREATE DATABASE ${DBNAME} OWNER ${DBUSER};" >/dev/null 2>&1 || die "建库失败"
ok "数据库已重建"

step "导入数据"
if pg_restore -d "$DBURL" --no-owner --no-privileges "$DBDUMP" 2>"$TMPD/err.log"; then
  ok "导入完成"
else
  # pg_restore 对「对象已存在」类警告返回非 0，但数据其实导入了
  if grep -qiE 'error' "$TMPD/err.log"; then
    warn "导入有错误，前 10 行："
    head -10 "$TMPD/err.log" | sed 's/^/    /'
  else
    ok "导入完成（只有警告）"
  fi
fi

# ---------- 还原 .env ----------
if [ -f "$TMPD/app.env" ]; then
  step "还原配置"
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
    warn "原 .env 已备份为 .env.bak-*"
  fi
  cp "$TMPD/app.env" "$ENV_FILE" && chmod 600 "$ENV_FILE" && ok ".env 已还原"
fi

# ---------- 还原 packs ----------
if [ -d "$TMPD/packs" ]; then
  step "还原技能包"
  mkdir -p "$DEPLOY_DIR/packs"
  cp -r "$TMPD/packs/." "$DEPLOY_DIR/packs/" 2>/dev/null && ok "packs/ 已还原"
fi

# ---------- 校验 ----------
step "校验"
CNT="$(psql "$DBURL" -tAc "SELECT count(*) FROM trades" 2>/dev/null || true)"
case "$CNT" in
  ''|*[!0-9]*) bad "查不到 trades 表，恢复可能不完整" ;;
  *) ok "trades 表 ${CNT} 行" ;;
esac

footer \
  "重启服务使配置生效： sudo ./restart.sh" \
  "查看状态：          ./status.sh"
