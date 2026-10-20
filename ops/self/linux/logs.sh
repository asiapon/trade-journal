#!/usr/bin/env bash
# =============================================================================
#  ops/self/linux/logs.sh —— 查看日志
# -----------------------------------------------------------------------------
#  用法：
#    ./logs.sh                 最近 40 行应用日志（最新那个文件）
#    ./logs.sh -n 200          最近 200 行
#    ./logs.sh -f              实时跟随
#    ./logs.sh --sys           只看 systemd 日志（journalctl）
#    ./logs.sh --err           只看错误日志（server-err.log）
#    ./logs.sh --list          列出所有日志文件
# =============================================================================
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

early_help "$0"

N=40
FOLLOW=0
MODE="app"
detect_service

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--lines) N="${2:-40}"; shift 2 ;;
    -f|--follow) FOLLOW=1; shift ;;
    --sys|--system) MODE="sys"; shift ;;
    --err|--error) MODE="err"; shift ;;
    --list|-l) MODE="list"; shift ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

LOGDIR="$DEPLOY_DIR/logs"

# ---------- 列出文件 ----------
if [ "$MODE" = list ]; then
  title "日志文件"
  if [ -d "$LOGDIR" ]; then
    find "$LOGDIR" -type f -name '*.log' -printf '%TY-%Tm-%Td %TH:%TM  %8s  %p\n' 2>/dev/null | sort -r
  else
    warn "还没有日志目录：$LOGDIR"
  fi
  if command -v journalctl >/dev/null 2>&1; then
    info "systemd 日志：journalctl -u ${SERVICE}"
  fi
  exit 0
fi

# ---------- systemd ----------
if [ "$MODE" = sys ]; then
  title "systemd 日志（${SERVICE}）"
  command -v journalctl >/dev/null 2>&1 || die "本机没有 journalctl"
  if [ "$FOLLOW" = 1 ]; then exec journalctl -u "$SERVICE" -n "$N" -f --no-pager
  else journalctl -u "$SERVICE" -n "$N" --no-pager; fi
  exit 0
fi

# ---------- 应用日志 ----------
title "应用日志"
if [ ! -d "$LOGDIR" ]; then
  bad "日志目录不存在：$LOGDIR"
  info "服务可能从未启动过。看 systemd：./logs.sh --sys"
  exit 1
fi

if [ "$MODE" = err ]; then
  F="$LOGDIR/server-err.log"
  [ -f "$F" ] || die "没有 server-err.log"
  info "$F"
  [ "$FOLLOW" = 1 ] && exec tail -n "$N" -f "$F"
  tail -n "$N" "$F"
else
  # 优先取当天 app-YYYY-MM-DD.log，没有再退回 server-out.log
  F="$(find "$LOGDIR" -maxdepth 1 -name 'app-*.log' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$F" ] && [ -f "$F" ] || F="$LOGDIR/server-out.log"
  [ -f "$F" ] || die "没有可读的日志文件（用 --list 看看）"
  info "$F"
  [ "$FOLLOW" = 1 ] && exec tail -n "$N" -f "$F"
  tail -n "$N" "$F"
fi
