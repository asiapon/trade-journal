#!/usr/bin/env bash
# =============================================================================
#  ops/self/linux/status.sh —— 查看自托管服务状态
# -----------------------------------------------------------------------------
#  用法： ./status.sh          （普通用户即可，不需要 sudo）
#  展示： 服务状态 / 端口监听 / 健康检查 / 数据库连通 / 磁盘与日志位置
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"

title "自托管 · 状态"
detect_service
PORT="$(read_port)"

# ---------- 1. 服务 ----------
step "systemd 服务"
if ! command -v systemctl >/dev/null 2>&1; then
  bad "本机没有 systemd，无法用服务方式管理"
  info "可以手动跑：node $DEPLOY_DIR/server.js"
else
  if systemctl list-unit-files 2>/dev/null | grep -qx "${SERVICE}.service"; then
    STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
    ENABLED="$(systemctl is-enabled "$SERVICE" 2>/dev/null || echo unknown)"
    case "$STATE" in
      active)   ok "运行中（${SERVICE}）" ;;
      inactive) warn "已停止（${SERVICE}）→ 启动：sudo ./start.sh" ;;
      failed)   bad "启动失败（${SERVICE}）→ 看日志：./logs.sh -n 80" ;;
      *)        warn "状态：${STATE:-未知}" ;;
    esac
    info "开机自启：${ENABLED}"
    info "启动时间：$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null || echo '未知')"
  else
    warn "未安装 ${SERVICE} 服务 → 运行 sudo ./install.sh"
  fi
fi

# ---------- 2. 端口 ----------
step "端口监听（${PORT}）"
if command -v ss >/dev/null 2>&1; then
  LINE="$(ss -lntp 2>/dev/null | grep -E "[:.]${PORT}\b" | head -1 || true)"
elif command -v netstat >/dev/null 2>&1; then
  LINE="$(netstat -lntp 2>/dev/null | grep -E "[:.]${PORT}\b" | head -1 || true)"
else
  LINE=""
fi
if [ -n "$LINE" ]; then ok "已监听"; info "$LINE"
else warn "无监听"; fi

# ---------- 3. 健康检查 ----------
step "健康检查"
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
if printf '%s' "$HEALTH" | grep -q '"ok"'; then
  ok "接口正常"
  info "$HEALTH"
else
  bad "接口无响应（服务没起或端口不对）"
fi

# ---------- 4. 数据库 ----------
step "数据库"
if [ -f "$ENV_FILE" ]; then
  DBURL="$(grep -E '^\s*DATABASE_URL\s*=' "$ENV_FILE" 2>/dev/null | tail -1 | sed -E 's/^[^=]*=\s*//')"
  if printf '%s' "$DBURL" | grep -q '^postgres'; then
    # 隐去密码再展示
    SAFE="$(printf '%s' "$DBURL" | sed -E 's|(://[^:]+:)[^@]+@|\1***@|')"
    info "连接串：$SAFE"
    if command -v psql >/dev/null 2>&1; then
      CNT="$(psql "$DBURL" -tAc "SELECT count(*) FROM trades" 2>/dev/null || true)"
      case "$CNT" in
        ''|*[!0-9]*) bad "连不上（密码错误 / PG 没跑 / 库不存在）" ;;
        *) ok "连通，trades 表 ${CNT} 行" ;;
      esac
    else
      warn "本机没有 psql 客户端，跳过连通性检查"
    fi
  else
    warn "DATABASE_URL 未配置或格式不对"
  fi
else
  bad "缺少 .env → 运行 sudo ./install.sh"
fi

# ---------- 5. 资源 ----------
step "资源占用"
if [ -n "${SERVICE:-}" ] && systemctl is-active "$SERVICE" >/dev/null 2>&1; then
  MEM="$(systemctl show -p MemoryCurrent --value "$SERVICE" 2>/dev/null || echo '')"
  case "$MEM" in
    ''|*[!0-9]*) : ;;
    *) info "内存：$((MEM / 1024 / 1024)) MB" ;;
  esac
fi
if [ -d "$DEPLOY_DIR/logs" ]; then
  SZ="$(du -sh "$DEPLOY_DIR/logs" 2>/dev/null | awk '{print $1}')"
  CNT="$(find "$DEPLOY_DIR/logs" -name '*.log' 2>/dev/null | wc -l | tr -d ' ')"
  info "日志：${CNT} 个文件 / ${SZ:-?}  （目录 $DEPLOY_DIR/logs）"
fi
DF="$(df -h "$DEPLOY_DIR" 2>/dev/null | awk 'NR==2{print $4" 可用 ("$5" 已用)"}')"
[ -n "$DF" ] && info "磁盘：$DF"

# ---------- 6. 访问地址 ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
step "访问地址"
info "本机：  http://localhost:${PORT}"
[ -n "$IP" ] && info "局域网：http://${IP}:${PORT}"

footer \
  "启动： sudo ./start.sh     停止： sudo ./stop.sh" \
  "重启： sudo ./restart.sh   日志： ./logs.sh" \
  "备份： sudo ./backup.sh    升级： git pull && sudo ./install.sh"
