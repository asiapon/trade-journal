#!/usr/bin/env bash
# =============================================================================
#  publish.sh —— 顶层入口（Linux / macOS / Windows Git Bash）
# -----------------------------------------------------------------------------
#  这层只做三件事：检查 node、给菜单、把命令转给 scripts/cli.mjs。
#  真正的实现全在 scripts/ 下，改行为请改那里（见 scripts/OPS.md）。
#
#  用法：
#    ./publish.sh                 交互菜单
#    ./publish.sh check           体检（构建 + 产物校验 + 测试）
#    ./publish.sh cf              发布到 Cloudflare
#    ./publish.sh cf status       查 Cloudflare 状态
#    ./publish.sh self install    安装自托管服务
#    ./publish.sh wb sync         同步 WorkBuddy 发布目录
#    ./publish.sh help            完整命令列表
#
#  任意写法都行：./publish.sh cf deploy  ⇔  node scripts/cli.mjs cf deploy
# =============================================================================
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

if [ -t 1 ]; then
  C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[36m'; C_D=$'\033[90m'; C_BD=$'\033[1m'; C_0=$'\033[0m'
else
  C_G=''; C_R=''; C_Y=''; C_B=''; C_D=''; C_BD=''; C_0=''
fi

# ---------- 前置：node ----------
if ! command -v node >/dev/null 2>&1; then
  printf '  %s✗ 找不到 node%s\n' "$C_R" "$C_0" >&2
  printf '    请安装 Node.js 18+：https://nodejs.org/\n' >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  printf '  %s✗ Node 版本过低（当前 %s），需要 18+%s\n' "$C_R" "$(node -v)" "$C_0" >&2
  exit 1
fi

# ---------- 依赖 ----------
if [ ! -d node_modules ]; then
  printf '  %s! 还没装依赖，正在 npm install …%s\n' "$C_Y" "$C_0"
  npm install || { printf '  %s✗ npm install 失败%s\n' "$C_R" "$C_0" >&2; exit 1; }
fi

# ---------- 菜单 ----------
if [ $# -eq 0 ]; then
  printf '\n%s操作日志 · 发布与运维%s\n' "$C_BD" "$C_0"
  printf '%s\n' "$C_D────────────────────────────────────────────$C_0"
  cat <<'MENU'

    [1] 体检            构建 + 产物校验 + 测试（不改线上）
    [2] 发布 Cloudflare 纯命令行上线（Workers + D1）
    [3] Cloudflare 状态 Worker / D1 / 表数据量
    [4] 本地预览        构建后起服务看效果
    [5] 同步 WorkBuddy  构建 + 拷到发布目录（仍需界面点发布）
    [6] 自托管 · 安装   安装或升级服务器上的服务
    [7] 自托管 · 启停   启动 / 停止 / 重启
    [8] 自托管 · 状态   运行状态 / 日志
    [9] 自托管 · 备份   备份 / 恢复
   [10] 自托管 · 卸载   逐项确认后卸载
   [11] 开发模式        热更新（localhost:5173）
   [12] 生成凭据        .env.local 模板
    [h] 完整帮助
    [0] 退出

MENU
  printf '  请输入编号：'
  read -r SEL
  case "$SEL" in
    1)  set -- dev check ;;
    2)  set -- cf deploy ;;
    3)  set -- cf status ;;
    4)  set -- dev preview ;;
    5)  set -- wb sync ;;
    6)  set -- self install ;;
    7)  printf '  启动(1) / 停止(2) / 重启(3)：'
        read -r A
        case "$A" in
          1) set -- self start ;;
          2) set -- self stop ;;
          3) set -- self restart ;;
          *) printf '  %s✗ 无效%s\n' "$C_R" "$C_0"; exit 1 ;;
        esac ;;
    8)  printf '  状态(1) / 日志(2)：'
        read -r A
        case "$A" in
          1) set -- self status ;;
          2) set -- self logs ;;
          *) printf '  %s✗ 无效%s\n' "$C_R" "$C_0"; exit 1 ;;
        esac ;;
    9)  printf '  备份(1) / 恢复(2)：'
        read -r A
        case "$A" in
          1) set -- self backup ;;
          2) set -- self restore ;;
          *) printf '  %s✗ 无效%s\n' "$C_R" "$C_0"; exit 1 ;;
        esac ;;
    10) set -- self uninstall ;;
    11) set -- dev serve ;;
    12) set -- dev env ;;
    h|H) set -- help ;;
    0|'') exit 0 ;;
    *) printf '  %s✗ 编号无效：%s%s\n' "$C_R" "$SEL" "$C_0" >&2; exit 1 ;;
  esac
fi

# ---------- 转交 ----------
exec node scripts/cli.mjs "$@"
