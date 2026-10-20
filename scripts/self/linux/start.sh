#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/start.sh —— 启动自托管服务
# -----------------------------------------------------------------------------
#  用法： sudo ./start.sh
#  行为： 已运行则不重复启动；未运行则 systemctl start 并做健康检查
#         没有 systemd 的机器（容器/WSL 等）自动退化为后台 node 进程
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
require_deployed
title "自托管 · 启动"
detect_service
PORT="$(read_port)"

# ---------- 已有 systemd 服务 ----------
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -qx "${SERVICE}.service"; then
  if systemctl is-active "$SERVICE" >/dev/null 2>&1; then
    ok "服务已在运行（${SERVICE}），无需重复启动"
    info "重启请用：sudo ./restart.sh"
    exit 0
  fi
  step "启动 ${SERVICE}"
  systemctl start "$SERVICE" || die "启动失败，看日志：./logs.sh -n 80"
else
  # ---------- 无 systemd：后台拉起 ----------
  step "无 systemd，以后台进程方式启动"
  if [ -n "$(ss -lntp 2>/dev/null | grep -E "[:.]${PORT}\b")" ]; then
    warn "端口 ${PORT} 已被占用，可能服务已在跑（用 ./status.sh 确认）"
    exit 0
  fi
  mkdir -p "$DEPLOY_DIR/logs"
  cd "$DEPLOY_DIR" || die "无法进入 $DEPLOY_DIR"
  nohup node server.js >> "$DEPLOY_DIR/logs/server-out.log" 2>> "$DEPLOY_DIR/logs/server-err.log" &
  echo $! > "$DEPLOY_DIR/.pid"
  info "PID $(cat "$DEPLOY_DIR/.pid") 已写入 $DEPLOY_DIR/.pid"
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

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$OKFLAG" = 1 ]; then
  ok "启动成功"
  footer \
    "本机：  http://localhost:${PORT}" \
    "局域网：http://${IP:-<本机IP>}:${PORT}" \
    "日志：  ./logs.sh        停止： sudo ./stop.sh"
else
  bad "15 秒内健康检查未通过"
  info "排查：./logs.sh -n 80    或看 $DEPLOY_DIR/logs/server-err.log"
  if command -v systemctl >/dev/null 2>&1; then
    info "systemd 日志：journalctl -u ${SERVICE} -n 50"
  fi
  exit 1
fi
