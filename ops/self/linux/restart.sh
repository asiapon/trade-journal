#!/usr/bin/env bash
# =============================================================================
#  ops/self/linux/restart.sh —— 重启自托管服务
# -----------------------------------------------------------------------------
#  用法： sudo ./restart.sh
#  用途： 改完 .env / 拉了新代码 / 服务卡住时用
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
require_deployed
title "自托管 · 重启"
detect_service
PORT="$(read_port)"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -qx "${SERVICE}.service"; then
  step "重启 ${SERVICE}"
  systemctl restart "$SERVICE" || die "重启失败，看日志：./logs.sh -n 80"
else
  step "无 systemd，先停后起"
  "$_SELF_DIR/stop.sh" >/dev/null 2>&1 || true
  sleep 1
  exec "$_SELF_DIR/start.sh"
fi

# ---------- 健康检查 ----------
step "健康检查"
OKFLAG=0
for _ in $(seq 1 15); do
  sleep 1
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | grep -q '"ok"'; then
    OKFLAG=1; break
  fi
done

if [ "$OKFLAG" = 1 ]; then
  ok "重启成功，服务正常"
  info "http://localhost:${PORT}"
else
  bad "15 秒内健康检查未通过"
  info "./logs.sh -n 80   或   journalctl -u ${SERVICE} -n 50"
  exit 1
fi
