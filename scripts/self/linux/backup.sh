#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/backup.sh —— 备份数据库与配置
# -----------------------------------------------------------------------------
#  用法：
#    sudo ./backup.sh                    备份到 <仓库>/backups/
#    sudo ./backup.sh --out /data/bak    指定目录
#    sudo ./backup.sh --keep 7           只保留最近 7 份（默认 10，0=不清理）
#
#  产出： trade-journal-YYYYmmdd-HHMMSS.dump   数据库（pg_dump 自定义格式，压缩）
#         trade-journal-YYYYmmdd-HHMMSS.env    .env（含数据库密码）
#         trade-journal-YYYYmmdd-HHMMSS.tgz    上面两个 + packs 的打包（便于传走）
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
require_deployed
title "自托管 · 备份"

OUT="$REPO/backups"
KEEP=10
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-10}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE，无法备份"
DBURL="$(grep -E '^\s*DATABASE_URL\s*=' "$ENV_FILE" | tail -1 | sed -E 's/^[^=]*=\s*//')"
printf '%s' "$DBURL" | grep -q '^postgres' || die "DATABASE_URL 不是 PostgreSQL 连接串"

command -v pg_dump >/dev/null 2>&1 || die "找不到 pg_dump。安装：apt-get install postgresql-client"
command -v tar >/dev/null 2>&1 || die "找不到 tar"

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT" || die "无法创建目录 $OUT"
BASE="$OUT/trade-journal-$STAMP"

# ---------- 1. 数据库 ----------
step "导出数据库"
if pg_dump "$DBURL" -Fc -f "${BASE}.dump" 2>/dev/null; then
  ok "已导出 ${BASE}.dump（$(du -h "${BASE}.dump" | cut -f1)）"
else
  bad "pg_dump 失败"
  info "常见原因：DATABASE_URL 密码不对 / PostgreSQL 没跑 / 库不存在"
  info "排查：sudo systemctl status postgresql"
  rm -f "${BASE}.dump"
  exit 1
fi

# ---------- 2. 配置 ----------
step "备份配置"
cp "$ENV_FILE" "${BASE}.env" && chmod 600 "${BASE}.env" && ok ".env 已备份（权限 600）"

# ---------- 3. 打包 ----------
step "打包"
TMPD="$(mktemp -d)" || die "无法创建临时目录"
cp "${BASE}.dump" "$TMPD/db.dump"
cp "${BASE}.env"  "$TMPD/app.env"
[ -d "$DEPLOY_DIR/packs" ] && cp -r "$DEPLOY_DIR/packs" "$TMPD/packs" 2>/dev/null

if tar -czf "${BASE}.tgz" -C "$TMPD" . 2>/dev/null; then
  ok "已打包 ${BASE}.tgz（$(du -h "${BASE}.tgz" | cut -f1)）"
  info "内容：db.dump（数据库）+ app.env（配置）+ packs/（技能包，如有）"
  rm -f "${BASE}.dump" "${BASE}.env"     # 打包成功只留 tgz，避免重复占空间
else
  warn "打包失败，保留单独的 .dump 与 .env（仍然可用）"
fi
rm -rf "$TMPD"

# ---------- 4. 清理旧备份 ----------
if [ "$KEEP" -gt 0 ]; then
  step "清理旧备份（保留最近 ${KEEP} 份）"
  N="$(find "$OUT" -maxdepth 1 -name 'trade-journal-*' -type f | wc -l | tr -d ' ')"
  if [ "$N" -gt "$KEEP" ]; then
    find "$OUT" -maxdepth 1 -name 'trade-journal-*' -type f -printf '%T@ %p\n' \
      | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- \
      | while read -r f; do rm -f "$f" && info "已删除 $(basename "$f")"; done
  else
    info "当前 ${N} 份，未超过上限"
  fi
fi

TOTAL="$(du -sh "$OUT" 2>/dev/null | cut -f1)"
footer \
  "备份目录：$OUT" \
  "总占用：  ${TOTAL:-?}" \
  "恢复到本机： sudo ./restore.sh $OUT/trade-journal-$STAMP.tgz" \
  "拷到别处：   scp $OUT/trade-journal-$STAMP.tgz user@backup-host:/data/"
