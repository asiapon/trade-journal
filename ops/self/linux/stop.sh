#!/usr/bin/env bash
# =============================================================================
#  ops/self/linux/stop.sh —— 停止自托管服务
# -----------------------------------------------------------------------------
#  用法： sudo ./stop.sh
#  行为： systemctl stop；无 systemd 时按 .pid / 端口找进程杀掉
#         本来就没运行也会正常退出（退出码 0），可放心放进脚本
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
title "自托管 · 停止"
detect_service
PORT="$(read_port)"

STOPPED=0

# ---------- systemd ----------
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -qx "${SERVICE}.service"; then
  if systemctl is-active "$SERVICE" >/dev/null 2>&1; then
    step "停止 ${SERVICE}"
    systemctl stop "$SERVICE" && ok "服务已停止" && STOPPED=1
  else
    info "服务本来就没在运行"
  fi
fi

# ---------- 兜底：pid 文件 ----------
if [ -f "$DEPLOY_DIR/.pid" ]; then
  PID="$(cat "$DEPLOY_DIR/.pid" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    step "按 .pid 停止（PID $PID）"
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    ok "已停止 PID $PID"
    STOPPED=1
  fi
  rm -f "$DEPLOY_DIR/.pid"
fi

# ---------- 兜底：端口占用 ----------
if command -v ss >/dev/null 2>&1; then
  PIDS="$(ss -lntp 2>/dev/null | grep -E "[:.]${PORT}\b" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
  if [ -n "$PIDS" ]; then
    step "端口 ${PORT} 仍有监听，强制结束"
    for p in $PIDS; do
      kill -9 "$p" 2>/dev/null && ok "已结束 PID $p" && STOPPED=1
    done
  fi
fi

if [ "$STOPPED" = 1 ]; then
  footer "启动： sudo ./start.sh" "状态： ./status.sh"
else
  info "没有需要停止的进程（端口 ${PORT} 空闲）"
fi
