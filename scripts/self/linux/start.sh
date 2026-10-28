#!/usr/bin/env bash
# =============================================================================
#  scripts/self/linux/start.sh —— 启动自托管服务（已在运行则重启）
# -----------------------------------------------------------------------------
#  用法： sudo ./start.sh
#  行为： 没在跑 → 启动
#         在跑   → 重启（改完 .env、拉了新代码，直接跑这个就行）
#         没有 systemd 的机器（容器 / WSL）自动退化为后台 node 进程
#  说明： 健康检查失败时会直接打印错误日志末尾，不用另找日志命令
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"
need_root
require_deployed
detect_service
PORT="$(read_port)"

# ---------- 判定当前状态 ----------
HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -qx "${SERVICE}.service"; then
  HAS_SYSTEMD=1
fi

port_busy() {
  { ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null; } | grep -qE "[:.]${PORT}\b"
}

RUNNING=0
if [ "$HAS_SYSTEMD" = 1 ]; then
  systemctl is-active "$SERVICE" >/dev/null 2>&1 && RUNNING=1
elif port_busy; then
  RUNNING=1
fi

if [ "$RUNNING" = 1 ]; then
  title "自托管 · 重启"
  info "服务已在运行，按重启处理（无需单独的重启命令）"
else
  title "自托管 · 启动"
fi

# ---------- 起 / 重启 ----------
if [ "$HAS_SYSTEMD" = 1 ]; then
  if [ "$RUNNING" = 1 ]; then
    step "重启 ${SERVICE}"
    systemctl restart "$SERVICE" || die "重启失败（下面会打印日志）"
  else
    step "启动 ${SERVICE}"
    systemctl start "$SERVICE" || die "启动失败（下面会打印日志）"
  fi
else
  if [ "$RUNNING" = 1 ]; then
    step "无 systemd，先停后起"
    bash "$_SELF_DIR/stop.sh" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      port_busy || break
      sleep 0.5
    done
  fi
  step "无 systemd，以后台进程方式启动"
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
    OKFLAG=1
    break
  fi
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$OKFLAG" = 1 ]; then
  ok "服务正常"
  footer \
    "本机：  http://localhost:${PORT}" \
    "局域网：http://${IP:-<本机IP>}:${PORT}" \
    "日志：  $DEPLOY_DIR/logs/" \
    "停止：  sudo ./stop.sh      卸载： sudo ./uninstall.sh"
else
  bad "15 秒内健康检查未通过"
  # 直接把日志尾巴打出来：省掉「再去跑另一个命令看日志」这一步
  ERRLOG="$DEPLOY_DIR/logs/server-err.log"
  if [ -s "$ERRLOG" ]; then
    echo
    printf '%s最近 20 行错误日志（%s）%s\n' "$C_D" "$ERRLOG" "$C_0"
    tail -n 20 "$ERRLOG" | sed 's/^/    /'
  fi
  if [ "$HAS_SYSTEMD" = 1 ] && command -v journalctl >/dev/null 2>&1; then
    echo
    printf '%s最近 20 行 systemd 日志%s\n' "$C_D" "$C_0"
    journalctl -u "$SERVICE" -n 20 --no-pager 2>/dev/null | sed 's/^/    /'
  fi
  echo
  info "常见原因：PostgreSQL 没跑 / .env 里数据库密码不对 / 端口 ${PORT} 被别的程序占用"
  exit 1
fi
