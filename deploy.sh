#!/usr/bin/env bash
# =============================================================================
# 文件分发系统（File Distribution System）一键交互式部署脚本
# -----------------------------------------------------------------------------
# 适用系统：Ubuntu 22.04 / 24.04 LTS、Debian 12
# 使用方式：克隆仓库后执行  bash deploy.sh
#
# 功能：
#   1. 环境预检（root 权限 / 操作系统 / 网络 / 目录结构 / 磁盘空间）
#   2. 交互式收集部署配置（应用地址 / Telegram / PostgreSQL / Redis / SMTP）
#   3. 自动安装 Node.js 20 LTS、PostgreSQL、Redis、Bot API 编译工具链
#   4. 本机创建 PostgreSQL 数据库账号或对接外部数据库（部署时二选一）
#   5. 自动生成强随机密钥（JWT / SMTP 加密密钥与盐 / 数据库密码）
#   6. 生成生产版 backend/.env 配置文件
#   7. 可选编译仓库内 telegram-bot-api 并注册 systemd 服务
#   8. 并行构建前端与后端、执行数据库迁移
#   9. 创建并启用 systemd 服务、健康检查、输出部署摘要
#
# 幂等性：脚本可安全重跑；已存在的配置与服务会询问是否覆盖。
# 日志：  部署过程记录到 deploy-<时间戳>.log
# =============================================================================

set -euo pipefail
export LC_ALL=C.UTF-8
# SSH/终端断开时尽量继续执行已确认的部署阶段；完整过程始终写入部署日志。
trap '' HUP

# -----------------------------------------------------------------------------
# 全局变量
# -----------------------------------------------------------------------------
DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE=""
CURRENT_STAGE="初始化"
START_TS="$(date +%Y%m%d-%H%M%S)"

# ---- 颜色输出（非 TTY 时禁用） ----
if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'; C_BOLD=$'\e[1m'; C_RESET=$'\e[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""; C_RESET=""
fi

# ---- 交互收集的配置变量 ----
DEPLOY_DIR=""
APP_URL=""
APP_PORT="3000"
DB_MODE="local"            # local | remote
DB_HOST="127.0.0.1"
DB_PORT="5432"
DB_USER="tgtc"
DB_PASS=""
DB_NAME="tgtc"
DB_SSL="false"
REDIS_HOST="127.0.0.1"
REDIS_PORT="6379"
REDIS_PASS=""
REDIS_DB="0"
TG_TOKEN=""
TG_CHAT_ID=""
BUILD_BOT_API="no"         # yes | no
API_ID=""
API_HASH=""
BOT_API_PORT="8081"
BOT_API_DIR="/var/lib/telegram-bot-api"
BOT_API_BIN="/usr/local/bin/telegram-bot-api"
BOT_API_BASE=""            # 不编译本地 Bot API 时填写（留空 = 官方 API）
SMTP_ENABLE="no"
SMTP_HOST=""; SMTP_PORT=""; SMTP_SECURE="false"; SMTP_USER=""; SMTP_PASS=""; SMTP_FROM=""

# ---- 生成的密钥 ----
JWT_SECRET=""
SMTP_KEY=""; SMTP_SALT=""
DB_PASS_GEN=""

# ---- 重跑与确认标记 ----
ASSUME_YES="no"
EXISTING_ENV="no"
SERVICE_USER=""
SERVICE_GROUP=""

# -----------------------------------------------------------------------------
# 辅助函数：日志 / 错误 / 交互
# -----------------------------------------------------------------------------
init_log() {
  LOG_FILE="$DEPLOY_ROOT/deploy-${START_TS}.log"
  : > "$LOG_FILE"
  log "部署日志已写入: $LOG_FILE"
}

log()  { echo -e "$C_CYAN[部署]$C_RESET $*";  echo "[部署] $*" >> "$LOG_FILE"; }
info() { echo -e "$C_GREEN[信息]$C_RESET $*"; echo "[信息] $*" >> "$LOG_FILE"; }
step() { echo; echo -e "$C_BOLD${C_CYAN}── $* ──${C_RESET}"; echo "[步骤] $*" >> "$LOG_FILE"; }
warn() { echo -e "$C_YELLOW[警告]$C_RESET $*";  echo "[警告] $*" >> "$LOG_FILE"; }
die()  {
  echo -e "${C_RED}[错误] $*${C_RESET}" >&2
  echo "[错误] 阶段=$CURRENT_STAGE : $*" >> "$LOG_FILE"
  echo "[错误] 完整日志见: $LOG_FILE" >&2
  exit 1
}

# 带默认值的交互输入；结果写入全局变量 REPLY。输入 * 表示放弃部署
prompt() {
  local text="$1" default="$2"
  local full
  if [[ -n "$default" ]]; then
    full="$text [${default}]"
  else
    full="$text"
  fi
  local ans
  read -r -p "$full: " ans || ans="$default"
  if [[ "$ans" == "*" ]]; then
    die "用户放弃部署"
  fi
  REPLY="${ans:-$default}"
}

# 敏感输入不回显；结果写入全局变量 REPLY
prompt_secret() {
  local text="$1" ans
  read -r -s -p "$text: " ans || ans=""
  echo
  [[ "$ans" != "*" ]] || die "用户放弃部署"
  REPLY="$ans"
}

# 是/否交互，默认值在大写字母表示；返回 0=是 1=否
confirm() {
  local text="$1" default="${2:-n}"
  local opt
  case "$default" in
    y|Y) opt="Y/n" ;;
    *)   opt="y/N" ;;
  esac
  if [[ "$ASSUME_YES" == "yes" ]]; then
    log "[自动确认(--yes)] $text -> 是"
    return 0
  fi
  local ans
  read -r -p "$text [$opt]: " ans || ans=""
  ans="${ans:-$default}"
  [[ "$ans" == "y" || "$ans" == "Y" || "$ans" == "yes" || "$ans" == "YES" ]]
}

# -----------------------------------------------------------------------------
# 阶段 0：环境预检
# -----------------------------------------------------------------------------
preflight() {
  CURRENT_STAGE="环境预检"
  step "阶段 0/8：环境预检"

  # root 权限
  if [[ $EUID -ne 0 ]]; then
    die "需要 root 权限运行，请使用: sudo bash $0"
  fi

  # 交互终端
  if [[ ! -t 0 ]]; then
    die "检测到非交互终端。本脚本为交互式部署工具，请直接运行: bash deploy.sh"
  fi

  # 操作系统
  if [[ ! -f /etc/os-release ]]; then
    die "无法识别操作系统（缺少 /etc/os-release）。本脚本仅支持 Ubuntu / Debian。"
  fi
  . /etc/os-release
  case "$ID" in
    ubuntu)
      info "操作系统: Ubuntu $VERSION_ID"
      if [[ "${VERSION_ID%%.*}" -lt 22 ]]; then
        warn "建议使用 Ubuntu 22.04 LTS 或更高版本（当前 $VERSION_ID）"
      fi
      ;;
    debian)
      info "操作系统: Debian $VERSION_ID"
      if [[ "${VERSION_ID%%.*}" -lt 12 ]]; then
        warn "建议使用 Debian 12 或更高版本（当前 $VERSION_ID）"
      fi
      ;;
    *)
      die "不支持的操作系统: $ID（本脚本仅支持 Ubuntu / Debian）"
      ;;
  esac

  # 架构
  case "$(uname -m)" in
    x86_64|aarch64) info "架构: $(uname -m)" ;;
    *) die "不支持的 CPU 架构: $(uname -m)" ;;
  esac

  # 仓库目录结构
  local missing=""
  [[ -f "$DEPLOY_ROOT/backend/package.json" ]] || missing="$missing backend/package.json"
  [[ -f "$DEPLOY_ROOT/frontend/package.json" ]] || missing="$missing frontend/package.json"
  [[ -f "$DEPLOY_ROOT/backend/.env.example" ]] || missing="$missing backend/.env.example"
  if [[ -n "$missing" ]]; then
    die "仓库目录结构不完整，缺少:$missing。请确认在项目根目录运行本脚本。"
  fi
  info "目录结构: 通过（仓库根目录 $DEPLOY_ROOT）"

  # 磁盘空间（Bot API 编译需要较多空间，预留 5GB 告警）
  local free_kb free_gb
  free_kb="$(df -k "$DEPLOY_ROOT" | awk 'NR==2 {print $4}')"
  free_gb=$((free_kb / 1024 / 1024))
  if (( free_gb < 5 )); then
    warn "磁盘剩余空间不足 5GB（当前约 ${free_gb}GB），编译 telegram-bot-api 可能失败"
  else
    info "磁盘空间: 剩余约 ${free_gb}GB"
  fi

  # 网络连通性（不强制，仅提示）
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsS --max-time 8 -o /dev/null "https://deb.debian.org" 2>/dev/null && \
       ! curl -fsS --max-time 8 -o /dev/null "https://archive.ubuntu.com" 2>/dev/null; then
      warn "无法访问 Debian/Ubuntu 软件源，依赖安装阶段可能会失败，请检查网络"
    else
      info "网络连通性: 通过"
    fi
  fi
}

# -----------------------------------------------------------------------------
# 阶段 1：交互式收集配置
# -----------------------------------------------------------------------------
collect_inputs() {
  CURRENT_STAGE="收集配置"
  step "阶段 1/8：收集部署配置"
  info "以下配置项均可直接回车使用默认值；输入 * 表示放弃当前输入。"

  # ---- 部署目录 ----
  prompt "部署目录（仓库根目录）" "$DEPLOY_ROOT"
  DEPLOY_DIR="$REPLY"
  [[ "$DEPLOY_DIR" == /* ]] || die "部署目录必须是绝对路径: $DEPLOY_DIR"
  if [[ "$DEPLOY_DIR" != "$DEPLOY_ROOT" ]]; then
    if [[ ! -f "$DEPLOY_DIR/backend/package.json" ]]; then
      die "目录 $DEPLOY_DIR 中未找到 backend/package.json，请指定正确的仓库根目录"
    fi
    log "使用部署目录: $DEPLOY_DIR"
  fi

  # ---- 运行用户 ----
  local default_user="${SUDO_USER:-$(id -un)}"
  [[ "$default_user" != "root" ]] || default_user="root"
  prompt "systemd 服务与构建命令使用的系统用户" "$default_user"
  SERVICE_USER="$REPLY"
  id "$SERVICE_USER" >/dev/null 2>&1 || die "系统用户不存在: $SERVICE_USER"
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
  runuser -u "$SERVICE_USER" -- test -r "$DEPLOY_DIR/backend/package.json" \
    || die "用户 $SERVICE_USER 无法读取部署目录，请自行调整目录权限或选择其他用户"
  runuser -u "$SERVICE_USER" -- test -w "$DEPLOY_DIR/backend" \
    || die "用户 $SERVICE_USER 无法写入 backend 目录，请自行调整权限或选择其他用户"
  runuser -u "$SERVICE_USER" -- test -w "$DEPLOY_DIR/frontend" \
    || die "用户 $SERVICE_USER 无法写入 frontend 目录，请自行调整权限或选择其他用户"

  # ---- 应用地址与端口 ----
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$ip" ]] && ip="localhost"
  prompt "应用对外地址（分享链接使用）" "http://${ip}:3000"
  APP_URL="$REPLY"
  prompt "服务监听端口" "3000"
  APP_PORT="$REPLY"
  [[ "$APP_PORT" =~ ^[0-9]+$ ]] && (( APP_PORT >= 1 && APP_PORT <= 65535 )) || die "无效的端口号: $APP_PORT"
  [[ "$APP_URL" =~ ^https?://[^[:space:]]+$ ]] || die "应用对外地址必须是有效的 http:// 或 https:// 地址"

  # ---- Telegram Bot ----
  step "Telegram Bot 配置"
  info "请前往 @BotFather 创建 Bot 获取 Token，并私聊发送一条消息获取 Chat ID"
  prompt_secret "Telegram Bot Token（格式 123456:ABC...，输入不回显）"
  TG_TOKEN="$REPLY"
  if [[ ! "$TG_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
    die "Telegram Bot Token 格式错误（应为 <bot_id>:<token>）"
  fi
  prompt "Telegram Chat ID（文件存储目标，可为频道/群组/用户 ID）" ""
  TG_CHAT_ID="$REPLY"
  [[ -n "$TG_CHAT_ID" ]] || die "Telegram Chat ID 不能为空"

  # ---- PostgreSQL 与 Redis：本机安装 / 连接外部 二选一 ----
  step "PostgreSQL 与 Redis"
  if confirm "PostgreSQL / Redis 使用本机自动安装，还是连接已有外部服务？（本机安装输入 y）" "y"; then
    DB_MODE="local"
    log "选择：本机自动安装 PostgreSQL 与 Redis"
    info "本机将自动安装 PostgreSQL、Redis，并创建专用数据库账号 tgtc"
  else
    DB_MODE="remote"
    log "选择：连接已有外部服务"
    info "—— PostgreSQL ——"
    prompt "数据库地址" "127.0.0.1"; DB_HOST="$REPLY"
    prompt "数据库端口" "5432"; DB_PORT="$REPLY"
    prompt "数据库用户" "tgtc"; DB_USER="$REPLY"
    prompt "数据库密码" ""; DB_PASS="$REPLY"
    [[ -n "$DB_PASS" ]] || die "数据库密码不能为空"
    prompt "数据库名称" "tgtc"; DB_NAME="$REPLY"
    [[ "$DB_PORT" =~ ^[0-9]+$ ]] && (( DB_PORT >= 1 && DB_PORT <= 65535 )) || die "无效的数据库端口: $DB_PORT"
    [[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "数据库用户名包含不支持的字符"
    [[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "数据库名包含不支持的字符"
    if confirm "数据库是否启用 SSL 连接？（默认否）" "n"; then DB_SSL="true"; else DB_SSL="false"; fi
    info "—— Redis ——"
    prompt "Redis 地址" "127.0.0.1"; REDIS_HOST="$REPLY"
    prompt "Redis 端口" "6379"; REDIS_PORT="$REPLY"
    prompt_secret "Redis 密码（无密码直接回车，输入不回显）"; REDIS_PASS="$REPLY"
    prompt "Redis 数据库编号" "0"; REDIS_DB="$REPLY"
    [[ "$REDIS_PORT" =~ ^[0-9]+$ ]] && (( REDIS_PORT >= 1 && REDIS_PORT <= 65535 )) || die "无效的 Redis 端口: $REDIS_PORT"
    [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || die "Redis 数据库编号必须为非负整数"
  fi

  # ---- 本地 Bot API ----
  step "Telegram Bot API（文件存储后端）"
  if confirm "是否自动编译并部署仓库内的 telegram-bot-api（本地模式，支持大文件与流式下载）？\n  注意：编译需要 20~60 分钟。如选择否，将使用官方 API 或已有外部 API。" "n"; then
    BUILD_BOT_API="yes"
    log "选择：编译本地 telegram-bot-api"
    info "需要 Telegram API ID 与 API Hash，请前往 https://core.telegram.org/api/obtaining_api_id 获取"
    prompt "Telegram API ID" ""; API_ID="$REPLY"
    [[ "$API_ID" =~ ^[0-9]+$ ]] || die "API ID 应为纯数字"
    prompt "Telegram API Hash" ""; API_HASH="$REPLY"
    [[ "$API_HASH" =~ ^[A-Fa-f0-9]{32}$ ]] || die "API Hash 应为 32 位十六进制字符串"
    prompt "Bot API 监听端口" "8081"; BOT_API_PORT="$REPLY"
    prompt "Bot API 本地文件存储目录" "/var/lib/telegram-bot-api"; BOT_API_DIR="$REPLY"
    [[ "$BOT_API_PORT" =~ ^[0-9]+$ ]] && (( BOT_API_PORT >= 1 && BOT_API_PORT <= 65535 )) || die "无效的 Bot API 端口: $BOT_API_PORT"
    [[ "$BOT_API_PORT" != "$APP_PORT" ]] || die "Bot API 端口不能与应用端口相同"
    [[ "$BOT_API_DIR" == /* && ! "$BOT_API_DIR" =~ [[:space:]] ]] || die "Bot API 目录必须是无空格的绝对路径"
  else
    BUILD_BOT_API="no"
    prompt "Telegram API 基础地址（留空使用官方 https://api.telegram.org；\n  如有已运行的外部 Bot API 可填其地址，如 http://127.0.0.1:8081）" ""
    BOT_API_BASE="$REPLY"
    [[ -z "$BOT_API_BASE" || "$BOT_API_BASE" =~ ^https?://[^[:space:]]+$ ]] || die "Telegram API 基础地址格式无效"
  fi

  # ---- SMTP（可选）----
  step "SMTP 邮件服务（可选）"
  info "SMTP 用于邮箱验证码与密码重置；不使用请直接回车跳过"
  prompt "SMTP 服务器地址（跳过请留空）" ""
  SMTP_HOST="$REPLY"
  if [[ -n "$SMTP_HOST" ]]; then
    SMTP_ENABLE="yes"
    prompt "SMTP 端口" "587"; SMTP_PORT="$REPLY"
    if confirm "SMTP 是否使用 SSL/TLS 加密？（默认否）" "n"; then SMTP_SECURE="true"; else SMTP_SECURE="false"; fi
    prompt "SMTP 用户名" ""; SMTP_USER="$REPLY"
    prompt_secret "SMTP 密码（输入不回显）"; SMTP_PASS="$REPLY"
    prompt "发件人地址（From）" ""; SMTP_FROM="$REPLY"
    log "SMTP 已配置: $SMTP_HOST"
  else
    SMTP_ENABLE="no"
    log "SMTP 未配置（注册邮箱验证等功能将不可用）"
  fi

  # ---- 配置确认 ----
  step "配置确认"
  echo -e "${C_CYAN}请确认以下配置（部署完成后如需修改，可编辑 $DEPLOY_DIR/backend/.env 后重启服务）：${C_RESET}"
  echo "  ┌ 应用 ───────────────────────────────────────────"
  echo "  │ 部署目录        : $DEPLOY_DIR"
  echo "  │ 运行用户        : $SERVICE_USER（组=$SERVICE_GROUP）"
  echo "  │ 对外地址        : $APP_URL"
  echo "  │ 监听端口        : $APP_PORT"
  echo "  ├ 数据库与队列 ────────────────────────────────────"
  if [[ "$DB_MODE" == "local" ]]; then
    echo "  │ PostgreSQL      : 本机自动安装（用户=$DB_USER 数据库=$DB_NAME）"
    echo "  │ Redis           : 本机自动安装"
  else
    echo "  │ PostgreSQL      : $DB_HOST:$DB_PORT ($DB_USER@$DB_NAME) SSL=$DB_SSL"
    echo "  │ Redis           : $REDIS_HOST:$REDIS_PORT db=$REDIS_DB"
  fi
  echo "  ├ Telegram ────────────────────────────────────────"
  echo "  │ Bot Token       : ${TG_TOKEN:0:12}***（已脱敏）"
  echo "  │ Chat ID         : $TG_CHAT_ID"
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    echo "  │ Bot API         : 编译本地服务（端口 $BOT_API_PORT，目录 $BOT_API_DIR）"
  else
    echo "  │ Bot API         : ${BOT_API_BASE:-官方 https://api.telegram.org}"
  fi
  echo "  ├ SMTP ────────────────────────────────────────────"
  if [[ "$SMTP_ENABLE" == "yes" ]]; then
    echo "  │ SMTP            : $SMTP_HOST:$SMTP_PORT (secure=$SMTP_SECURE)"
  else
    echo "  │ SMTP            : 未配置"
  fi
  echo "  └──────────────────────────────────────────────────"
  confirm "以上配置是否正确？输入 y 继续，n 重新开始" "y" || { log "配置有误，重新收集"; collect_inputs; return 0; }
}

# -----------------------------------------------------------------------------
# 中断恢复：修复 dpkg/apt 未完成状态
# -----------------------------------------------------------------------------
repair_package_manager() {
  CURRENT_STAGE="修复软件包状态"
  step "检查上次中断遗留的软件包状态"
  export DEBIAN_FRONTEND=noninteractive

  local deadline=$((SECONDS + 300))
  while pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || \
        pgrep -x dpkg >/dev/null 2>&1 || pgrep -x unattended-upgrade >/dev/null 2>&1; do
    (( SECONDS < deadline )) || die "等待其他 apt/dpkg 进程超过 5 分钟，请检查是否有残留安装进程"
    info "检测到其他软件包进程仍在运行，等待其结束..."
    sleep 5
  done

  info "执行 dpkg --configure -a，完成被中断的软件包配置..."
  dpkg --configure -a || die "dpkg 修复失败；请检查是否有其他 apt/dpkg 进程或磁盘空间不足"
  info "执行 apt-get -f install，修复缺失依赖..."
  apt-get -f install -y || die "apt 依赖修复失败"

  if dpkg --audit | grep -q .; then
    dpkg --audit | tee -a "$LOG_FILE" >&2
    die "仍存在未完整安装的软件包，请根据以上 dpkg 审计结果处理"
  fi
  info "软件包管理器状态正常"
}

# Redis 服务诊断写入部署日志，失败时同时显示最近日志。
redis_diagnostics() {
  {
    echo "[诊断] systemctl status redis-server"
    systemctl status redis-server --no-pager -l 2>&1 || true
    echo "[诊断] journalctl -u redis-server"
    journalctl -u redis-server -n 80 --no-pager 2>&1 || true
    echo "[诊断] TCP 6379 监听情况"
    ss -ltnp 'sport = :6379' 2>&1 || true
  } | tee -a "$LOG_FILE" >&2
}

# Redis 首次启动失败时保留原配置和数据，再使用发行版默认配置重装。
repair_local_redis() {
  CURRENT_STAGE="修复 Redis"
  warn "Redis 服务启动失败，开始自动恢复安装"
  redis_diagnostics

  # 已有实例必须保留：PONG 表示可直接使用；NOAUTH 表示受密码保护，不得自动覆盖。
  local redis_probe
  redis_probe="$(redis-cli -h 127.0.0.1 -p 6379 ping 2>&1 || true)"
  if [[ "$redis_probe" == *PONG* ]]; then
    warn "检测到 6379 端口已有可用 Redis 实例；保留现有实例并继续部署"
    return 0
  fi
  if [[ "$redis_probe" == *NOAUTH* || "$redis_probe" == *WRONGPASS* ]]; then
    die "检测到受密码/ACL 保护的现有 Redis，已停止自动修复以保护数据。请重跑并选择外部服务模式填写 Redis 密码"
  fi
  if ss -ltn 'sport = :6379' 2>/dev/null | grep -q ':6379'; then
    die "6379 端口已被其他进程占用但未返回 Redis PONG，已停止自动修复以避免覆盖现有服务"
  fi

  local backup_root="/var/backups/tgtc-deploy/redis-${START_TS}"
  mkdir -p "$backup_root" || die "无法创建 Redis 备份目录: $backup_root"
  systemctl stop redis-server 2>/dev/null || true
  systemctl reset-failed redis-server 2>/dev/null || true

  if [[ -e /etc/redis ]]; then
    mv /etc/redis "$backup_root/etc-redis" || die "备份 /etc/redis 失败，未执行重装"
    [[ -e "$backup_root/etc-redis" && ! -e /etc/redis ]] || die "Redis 配置备份校验失败，未执行重装"
  fi
  if [[ -e /var/lib/redis ]]; then
    mv /var/lib/redis "$backup_root/lib-redis" || die "备份 /var/lib/redis 失败，未执行重装"
    [[ -e "$backup_root/lib-redis" && ! -e /var/lib/redis ]] || die "Redis 数据备份校验失败，未执行重装"
  fi
  info "原 Redis 配置和数据已隔离备份至 $backup_root（未删除）"

  export DEBIAN_FRONTEND=noninteractive
  # 二次确认源目录已经完成隔离；任何残留都禁止 purge。
  [[ ! -e /etc/redis && ! -e /var/lib/redis ]] || die "Redis 备份源仍有残留，拒绝执行 purge"
  apt-get purge -y redis-server redis-tools || die "清理损坏的 Redis 软件包失败"
  dpkg --configure -a || die "Redis 清理后 dpkg 配置失败"
  apt-get -f install -y || die "Redis 清理后依赖修复失败"
  apt-get install -y redis-server redis-tools || die "Redis 重新安装失败"

  systemctl daemon-reload
  systemctl enable redis-server >/dev/null || die "无法启用 redis-server 服务"
  systemctl restart redis-server || {
    redis_diagnostics
    die "Redis 使用干净配置重装后仍无法启动；备份位于 $backup_root"
  }
  redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG || {
    redis_diagnostics
    die "Redis 重装后未返回 PONG；备份位于 $backup_root"
  }
  info "Redis 已使用发行版默认配置重新安装并启动；旧数据未自动恢复"
}

# -----------------------------------------------------------------------------
# 阶段 2：安装依赖
# -----------------------------------------------------------------------------
install_deps() {
  CURRENT_STAGE="安装依赖"
  step "阶段 2/8：安装系统依赖"
  info "更新 apt 软件源并安装基础工具（首次运行需要几分钟）"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y

  local base_pkgs=(curl wget git ca-certificates gnupg lsb-release apt-transport-https)
  apt-get install -y "${base_pkgs[@]}"

  # ---- Node.js（>= 18 则跳过）----
  install_nodejs

  # ---- PostgreSQL 客户端（本机与外部模式验证都需要）----
  apt-get install -y postgresql-client redis-tools

  # ---- 本机安装 PostgreSQL 与 Redis ----
  if [[ "$DB_MODE" == "local" ]]; then
    info "安装 PostgreSQL 与 Redis..."
    apt-get install -y postgresql redis-server redis-tools
    systemctl enable postgresql >/dev/null || die "无法启用 PostgreSQL 服务"
    systemctl restart postgresql || die "PostgreSQL 服务启动失败"
    systemctl is-active --quiet postgresql || die "PostgreSQL 未处于 active 状态"

    systemctl enable redis-server >/dev/null 2>&1 || true
    if ! systemctl restart redis-server; then
      repair_local_redis
    fi
    if ! systemctl is-active --quiet redis-server; then
      repair_local_redis
    fi
    if ! redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
      repair_local_redis
    fi
    info "PostgreSQL 与 Redis 服务均已验证可用"
  fi

  # ---- 编译工具链（仅编译本地 Bot API 时需要）----
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    info "安装 telegram-bot-api 编译工具链（openssl/zlib/gperf/cmake/g++）..."
    apt-get install -y build-essential g++ cmake gperf zlib1g-dev libssl-dev openssl
  fi
}

install_nodejs() {
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -v | sed 's/^v//')"
    local major="${v%%.*}"
    if (( major >= 18 )); then
      info "检测到 Node.js v$v（>= 18），跳过 Node.js 安装"
      return 0
    fi
    warn "检测到 Node.js v$v 低于 18，将通过 NodeSource 升级到 20 LTS"
  fi
  info "通过 NodeSource 安装 Node.js 20 LTS..."
  if [[ "$ID" == "ubuntu" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || die "NodeSource 安装源配置失败，请检查网络"
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || die "NodeSource 安装源配置失败，请检查网络"
  fi
  apt-get install -y nodejs
  node -v || die "Node.js 安装失败"
  npm -v || die "npm 安装失败"
}

# -----------------------------------------------------------------------------
# 重跑预处理：在任何数据库凭据变更之前处理已有配置
# -----------------------------------------------------------------------------
prepare_existing_env() {
  local env_file="$DEPLOY_DIR/backend/.env"
  [[ -f "$env_file" ]] || return 0

  EXISTING_ENV="yes"
  warn "检测到已存在的 $env_file"
  confirm "是否覆盖已有配置并重新部署？" "n" || die "已取消，现有数据库凭据和服务均未修改"

  # 保留不可随重跑变化的密钥；仅显式手工修改 .env 才进行密钥轮换。
  local old_value
  old_value="$(sed -n 's/^JWT_SECRET=//p' "$env_file" | tail -n 1 | tr -d "'\"")"
  [[ -n "$old_value" ]] && JWT_SECRET="$old_value"
  old_value="$(sed -n 's/^SMTP_ENCRYPTION_KEY=//p' "$env_file" | tail -n 1 | tr -d "'\"")"
  [[ -n "$old_value" ]] && SMTP_KEY="$old_value"
  old_value="$(sed -n 's/^SMTP_ENCRYPTION_SALT=//p' "$env_file" | tail -n 1 | tr -d "'\"")"
  [[ -n "$old_value" ]] && SMTP_SALT="$old_value"

  if [[ "$DB_MODE" == "local" ]]; then
    old_value="$(sed -n 's/^DB_PASSWORD=//p' "$env_file" | tail -n 1 | tr -d "'\"")"
    [[ -n "$old_value" ]] && DB_PASS="$old_value"
  fi
  info "重跑将保留现有 JWT、SMTP 加密密钥及本机数据库密码"
}

# -----------------------------------------------------------------------------
# 阶段 3：配置数据库
# -----------------------------------------------------------------------------
setup_database() {
  CURRENT_STAGE="配置数据库"
  step "阶段 3/8：配置数据库"

  if [[ "$DB_MODE" == "local" ]]; then
    # ---- 本机 PostgreSQL：建库建号 + uuid-ossp 扩展 ----
    info "检查 PostgreSQL 状态..."
    systemctl is-active postgresql >/dev/null 2>&1 || systemctl start postgresql || die "PostgreSQL 无法启动"
    sleep 2

    [[ -n "$DB_PASS" ]] || DB_PASS="$(openssl rand -hex 16)"
    DB_PASS_GEN="$DB_PASS"
    DB_USER="$DB_USER"; DB_NAME="$DB_NAME"; DB_HOST="127.0.0.1"; DB_PORT="5432"

    # 重跑时复用原密码，不主动轮换正在使用的数据库凭据。
    if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1; then
      info "数据库用户 $DB_USER 已存在，同步为配置中的密码"
      su - postgres -c "psql -v ON_ERROR_STOP=1 -c \"ALTER ROLE $DB_USER LOGIN PASSWORD '$DB_PASS_GEN'\"" || die "同步数据库用户密码失败"
    else
      info "创建数据库用户 $DB_USER ..."
      su - postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS_GEN'\"" || die "创建数据库用户失败"
    fi

    if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1; then
      info "数据库 $DB_NAME 已存在，跳过创建"
    else
      info "创建数据库 $DB_NAME ..."
      su - postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER\"" || die "创建数据库失败"
    fi

    info "确保 uuid-ossp 扩展可用（迁移依赖）..."
    su - postgres -c "psql -v ON_ERROR_STOP=1 -d $DB_NAME -c \"CREATE EXTENSION IF NOT EXISTS \\\"uuid-ossp\\\"\"" || warn "uuid-ossp 扩展创建失败，请以超级用户手动执行"
    info "PostgreSQL 配置完成（用户=$DB_USER 数据库=$DB_NAME）"

    # ---- 本机 Redis ----
    systemctl is-active redis-server >/dev/null 2>&1 || systemctl start redis-server || die "Redis 无法启动"
    REDIS_HOST="127.0.0.1"; REDIS_PORT="6379"
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping | grep -q PONG || die "Redis 连通性检查失败"
    info "Redis 连通性: 通过"
  else
    # ---- 外部服务：验证连接 ----
    info "验证 PostgreSQL 连接..."
    local ssl_mode="disable"
    [[ "$DB_SSL" == "true" ]] && ssl_mode="verify-full"
    PGSSLMODE="$ssl_mode" PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tAc "SELECT 1" 2>/dev/null | grep -q 1 || die "PostgreSQL 连接失败，请检查连接信息、SSL 模式与服务器证书"
    info "PostgreSQL 连接: 通过"

    info "验证 Redis 连接..."
    local rpass_args=()
    [[ -n "$REDIS_PASS" ]] && rpass_args=(-a "$REDIS_PASS")
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "${rpass_args[@]}" --no-auth-warning ping 2>/dev/null \
      | grep -q PONG || die "Redis 连接检查失败，请检查地址、端口、密码与 ACL 配置"
    info "Redis 连接: 通过"
  fi
}

# -----------------------------------------------------------------------------
# 阶段 4：生成密钥与 backend/.env
# -----------------------------------------------------------------------------
generate_secrets() {
  CURRENT_STAGE="生成配置"
  step "阶段 4/8：生成安全密钥与配置文件"

  info "生成或复用安全密钥..."
  [[ -n "$JWT_SECRET" ]] || JWT_SECRET="$(openssl rand -hex 32)"
  [[ -n "$SMTP_KEY" ]] || SMTP_KEY="$(openssl rand -hex 32)"
  [[ -n "$SMTP_SALT" ]] || SMTP_SALT="$(openssl rand -hex 16)"
  if [[ "$DB_MODE" == "local" && -n "$DB_PASS_GEN" ]]; then
    DB_PASS="$DB_PASS_GEN"
  fi
  log "安全密钥准备完成"

  # ---- 原子生成 backend/.env ----
  local env_file="$DEPLOY_DIR/backend/.env"
  local env_tmp="${env_file}.deploy-tmp"
  info "生成 $env_file ..."
  # .env 值转义：含特殊字符时用双引号包裹，避免 # 被当作注释或值被截断
  env_quote() {
    local v="$1"
    if [[ "$v" =~ ^[A-Za-z0-9_.:/@+,-]*$ ]]; then
      printf '%s' "$v"
    else
      local esc
      esc="${v//\\/\\\\}"
      esc="${esc//\"/\\\"}"
      esc="${esc//\$/\\$}"
      esc="${esc//\`/\\\`}"
      printf '"%s"' "$esc"
    fi
  }
  {
    echo "# =========================================="
    echo "# 文件分发系统 生产环境配置（由 deploy.sh 生成）"
    echo "# 生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# 注意: 此文件包含敏感信息，请勿提交到版本库"
    echo "# =========================================="
    echo "NODE_ENV=production"
    echo "APP_HOST=0.0.0.0"
    echo "APP_PORT=$APP_PORT"
    echo "APP_URL=$APP_URL"
    echo "FRONTEND_URL=$APP_URL"
    echo "CORS_ORIGINS=$APP_URL"
    echo ""
    echo "# ---------- 数据库 (PostgreSQL) ----------"
    echo "DB_HOST=$DB_HOST"
    echo "DB_PORT=$DB_PORT"
    echo "DB_USERNAME=$DB_USER"
    echo "DB_PASSWORD=$(env_quote "$DB_PASS")"
    echo "DB_DATABASE=$(env_quote "$DB_NAME")"
    echo "DB_SYNCHRONIZE=false"
    echo "DB_POOL_SIZE=20"
    echo "DB_CONNECTION_TIMEOUT_MS=5000"
    echo "DB_STATEMENT_TIMEOUT_MS=30000"
    echo "DB_QUERY_TIMEOUT_MS=35000"
    echo "DB_LOCK_TIMEOUT_MS=3000"
    echo "DB_IDLE_TRANSACTION_TIMEOUT_MS=30000"
    if [[ "$DB_SSL" == "true" ]]; then
      echo "DB_SSL=true"
    fi
    echo ""
    echo "# ---------- JWT 认证 ----------"
    echo "JWT_SECRET=$JWT_SECRET"
    echo "JWT_EXPIRES_IN=7d"
    echo ""
    echo "# ---------- Redis (Bull 消息队列) ----------"
    echo "REDIS_HOST=$REDIS_HOST"
    echo "REDIS_PORT=$REDIS_PORT"
    if [[ -n "$REDIS_PASS" ]]; then
      echo "REDIS_PASSWORD=$(env_quote "$REDIS_PASS")"
    fi
    echo "REDIS_DB=$(env_quote "$REDIS_DB")"
    echo ""
    echo "# ---------- Telegram 文件存储 ----------"
    echo "TELEGRAM_BOT_TOKEN=$(env_quote "$TG_TOKEN")"
    echo "TELEGRAM_CHAT_ID=$(env_quote "$TG_CHAT_ID")"
    if [[ "$BUILD_BOT_API" == "yes" ]]; then
      echo "TELEGRAM_API_BASE=http://127.0.0.1:$BOT_API_PORT"
      echo "TELEGRAM_FILE_STREAMING_ENABLED=true"
      echo "TELEGRAM_FILE_STREAM_BASE=http://127.0.0.1:$BOT_API_PORT"
      echo "TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS=120"
      echo "TELEGRAM_LOCAL_FILE_DIR=$(env_quote "$BOT_API_DIR")"
    elif [[ -n "$BOT_API_BASE" ]]; then
      echo "TELEGRAM_API_BASE=$(env_quote "$BOT_API_BASE")"
    fi
    echo ""
    if [[ "$SMTP_ENABLE" == "yes" ]]; then
      echo "# ---------- SMTP 邮件 ----------"
      echo "SMTP_HOST=$SMTP_HOST"
      echo "SMTP_PORT=$SMTP_PORT"
      echo "SMTP_SECURE=$SMTP_SECURE"
      echo "SMTP_USER=$(env_quote "$SMTP_USER")"
      echo "SMTP_PASSWORD=$(env_quote "$SMTP_PASS")"
      echo "SMTP_FROM=$(env_quote "$SMTP_FROM")"
      echo "SMTP_ENCRYPTION_KEY=$SMTP_KEY"
      echo "SMTP_ENCRYPTION_SALT=$SMTP_SALT"
    fi
  } > "$env_tmp"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f "$env_tmp" "$env_file"
  info "$env_file 已原子生成（所有者 $SERVICE_USER，权限 600）"
}

# -----------------------------------------------------------------------------
# 阶段 5：编译 telegram-bot-api（可选）
# -----------------------------------------------------------------------------
build_bot_api() {
  CURRENT_STAGE="编译 Bot API"
  if [[ "$BUILD_BOT_API" != "yes" ]]; then
    log "跳过 telegram-bot-api 编译（使用官方/外部 API）"
    return 0
  fi

  step "阶段 5/8：编译并配置 telegram-bot-api"
  local src_dir="$DEPLOY_DIR/telegram-bot-api"
  if [[ ! -d "$src_dir" ]]; then
    die "未找到 telegram-bot-api 源码目录: $src_dir"
  fi
  info "源码目录: $src_dir"
  warn "TDLib 编译需要较长时间（20~60 分钟），请耐心等待，日志实时输出"

  mkdir -p "$BOT_API_DIR"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$BOT_API_DIR"
  chmod 750 "$BOT_API_DIR"

  if [[ -x "$BOT_API_BIN" ]]; then
    info "检测到已安装的 telegram-bot-api 二进制，跳过编译"
  else
    local build_dir="$src_dir/build"
    mkdir -p "$build_dir"
    cd "$build_dir"
    runuser -u "$SERVICE_USER" -- cmake -DCMAKE_BUILD_TYPE=Release .. || die "cmake 配置失败"
    runuser -u "$SERVICE_USER" -- cmake --build . || die "telegram-bot-api 编译失败，请查看上方日志"
    cmake --install . || die "telegram-bot-api 安装失败"
    cd "$DEPLOY_DIR"
  fi
  [[ -x "$BOT_API_BIN" ]] || die "telegram-bot-api 二进制不存在: $BOT_API_BIN"
  info "telegram-bot-api 编译完成: $BOT_API_BIN"
}

# -----------------------------------------------------------------------------
# 阶段 6：构建前后端
# -----------------------------------------------------------------------------
build_app() {
  CURRENT_STAGE="构建应用"
  step "阶段 6/8：构建前端与后端"

  local npm_install="yes"
  if [[ -d "$DEPLOY_DIR/frontend/node_modules" || -d "$DEPLOY_DIR/backend/node_modules" ]]; then
    if confirm "检测到已存在的 node_modules，是否跳过 npm ci（加快重跑）？" "n"; then
      npm_install="no"
    fi
  fi

  log "开始并行构建（前端构建 与 后端依赖安装同时进行）..."
  (
    cd "$DEPLOY_DIR/frontend"
    if [[ "$npm_install" == "yes" ]]; then
      log "[前端] 执行 npm ci ..."
      runuser -u "$SERVICE_USER" -- npm ci --no-audit --no-fund || exit 1
    fi
    log "[前端] 执行 npm run build ..."
    runuser -u "$SERVICE_USER" -- npm run build || exit 1
    log "[前端] 构建完成"
  ) &
  local pid_front=$!

  (
    cd "$DEPLOY_DIR/backend"
    if [[ "$npm_install" == "yes" ]]; then
      log "[后端] 执行 npm ci ..."
      runuser -u "$SERVICE_USER" -- npm ci --no-audit --no-fund || exit 1
    fi
    log "[后端] 依赖安装完成"
  ) &
  local pid_back=$!

  local rc1=0 rc2=0
  wait "$pid_front" || rc1=$?
  wait "$pid_back" || rc2=$?
  [[ $rc1 -eq 0 ]] || die "前端构建失败（退出码 $rc1）"
  [[ $rc2 -eq 0 ]] || die "后端依赖安装失败（退出码 $rc2）"

  info "构建后端（nest build）..."
  cd "$DEPLOY_DIR/backend"
  runuser -u "$SERVICE_USER" -- npm run build || die "后端构建失败"
  info "前后端构建完成"
}

# -----------------------------------------------------------------------------
# 阶段 7：运行数据库迁移
# -----------------------------------------------------------------------------
run_migrations() {
  CURRENT_STAGE="数据库迁移"
  step "阶段 7/8：执行数据库迁移"
  cd "$DEPLOY_DIR/backend"
  if systemctl is-active --quiet tgtc-backend 2>/dev/null; then
    info "停止旧后端服务，避免旧代码与新迁移并发运行..."
    systemctl stop tgtc-backend || die "无法停止旧后端服务"
  fi
  info "执行 npm run migration:run（读取 .env 连接数据库）..."
  if ! runuser -u "$SERVICE_USER" -- npm run migration:run; then
    die "数据库迁移失败，后端保持停止以避免新代码运行在不兼容的 schema 上；请检查并处理迁移后再启动服务"
  fi
  info "数据库迁移完成"
}

# -----------------------------------------------------------------------------
# 阶段 8：创建 systemd 服务并启动
# -----------------------------------------------------------------------------
setup_services() {
  CURRENT_STAGE="配置服务"
  step "阶段 8/8：创建并启用 systemd 服务"

  local unit_dir="/etc/systemd/system"

  # ---- 预建持久化目录并保证可写 ----
  mkdir -p "$DEPLOY_DIR/backend/tmp/Cache" \
           "$DEPLOY_DIR/backend/tmp/uploads" \
           "$DEPLOY_DIR/backend/tmp/thumbnails" \
           "$DEPLOY_DIR/backend/tmp/logs"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DEPLOY_DIR/backend/tmp"
  chmod -R 750 "$DEPLOY_DIR/backend/tmp"

  # ---- tgtc-backend.service ----
  local unit_file="$unit_dir/tgtc-backend.service"
  if [[ -f "$unit_file" ]]; then
    warn "检测到已存在的 $unit_file"
    confirm "是否重新生成并覆盖？（推荐，将应用本次配置）" "y" || die "已取消服务配置"
  fi
  cat > "$unit_file" <<EOF
[Unit]
Description=File Distribution System - Backend (NestJS)
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory="$DEPLOY_DIR/backend"
Environment=NODE_ENV=production
ExecStart=/usr/bin/node "$DEPLOY_DIR/backend/dist/main.js"
Restart=always
RestartSec=10
KillMode=mixed
MemoryHigh=3072M
MemoryMax=4096M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  info "生成 $unit_file"

  # ---- tgtc-telegram-bot-api.service（仅本地编译时）----
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    local bot_unit="$unit_dir/tgtc-telegram-bot-api.service"
    local bot_env="/etc/tgtc-telegram-bot-api.env"
    umask 077
    {
      echo "TELEGRAM_API_ID=$API_ID"
      echo "TELEGRAM_API_HASH=$API_HASH"
    } > "$bot_env"
    chmod 600 "$bot_env"
    if [[ -f "$bot_unit" ]]; then
      warn "检测到已存在的 $bot_unit"
      confirm "是否重新生成并覆盖？" "y" || die "已取消服务配置"
    fi
    cat > "$bot_unit" <<EOF
[Unit]
Description=Telegram Bot API Server (local)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
EnvironmentFile=$bot_env
ExecStart=$BOT_API_BIN --local --enable-file-streaming --http-port=$BOT_API_PORT --http-stat-port=0 --dir="$BOT_API_DIR"
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    info "生成 $bot_unit"
  fi

  # ---- 启动服务 ----
  systemctl daemon-reload
  systemd-analyze verify "$unit_file" >/dev/null || die "tgtc-backend systemd 单元校验失败"
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    systemd-analyze verify "$bot_unit" >/dev/null || die "tgtc-telegram-bot-api systemd 单元校验失败"
    systemctl enable tgtc-telegram-bot-api >/dev/null || die "无法启用 tgtc-telegram-bot-api 服务"
    systemctl restart tgtc-telegram-bot-api || die "tgtc-telegram-bot-api 启动失败，请检查 systemctl status"
    systemctl is-active --quiet tgtc-telegram-bot-api || die "tgtc-telegram-bot-api 未处于 active 状态"
    info "tgtc-telegram-bot-api 服务已启用并重启"
  fi
  systemctl enable tgtc-backend >/dev/null || die "无法启用 tgtc-backend 服务"
  systemctl restart tgtc-backend || die "tgtc-backend 启动失败，请检查 systemctl status"
  systemctl is-active --quiet tgtc-backend || die "tgtc-backend 未处于 active 状态"
  info "tgtc-backend 服务已启用并重启"
}

# -----------------------------------------------------------------------------
# 阶段 9：健康检查与部署摘要
# -----------------------------------------------------------------------------
health_check() {
  CURRENT_STAGE="健康检查"
  step "健康检查：等待服务就绪（最长 5 分钟）"

  local ok=0
  local deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$APP_PORT/" || echo 000)"
    if [[ "$code" == "200" ]]; then
      ok=1
      break
    fi
    sleep 3
  done

  if [[ "$ok" -eq 1 ]]; then
    info "Web 服务已就绪（HTTP 200）"
  else
    warn "5 分钟内服务未返回 HTTP 200，请检查以下日志:"
    echo -e "  ${C_YELLOW}journalctl -u tgtc-backend -n 100 --no-pager${C_RESET}"
    echo -e "  ${C_YELLOW}cat $DEPLOY_DIR/backend/tmp/logs/app.log${C_RESET}"
    return 1
  fi

  # 数据库连通性探针（/api/auth/status 会真实查询数据库）
  local db_ok=0
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local code2
    code2="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$APP_PORT/api/auth/status" || echo 000)"
    if [[ "$code2" == "200" ]]; then
      db_ok=1
      break
    fi
    sleep 3
  done
  if [[ "$db_ok" -eq 1 ]]; then
    info "数据库连接正常（/api/auth/status 通过）"
  else
    die "数据库探针未通过，请检查 PostgreSQL 连接与迁移是否成功"
  fi

  local telegram_base
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    telegram_base="http://127.0.0.1:$BOT_API_PORT"
  else
    telegram_base="${BOT_API_BASE:-https://api.telegram.org}"
  fi

  # URL 从 stdin 配置传入，避免 Bot Token 暴露在进程命令行。
  printf 'silent\nshow-error\nfail\nmax-time = 15\nurl = "%s/bot%s/getMe"\n' \
    "${telegram_base%/}" "$TG_TOKEN" | curl --config - >/dev/null \
    || die "Telegram Bot API getMe 验证失败，请检查 Bot Token、API 地址与服务器网络"
  printf 'silent\nshow-error\nfail\nmax-time = 15\nurl = "%s/bot%s/getChat"\ndata-urlencode = "chat_id=%s"\n' \
    "${telegram_base%/}" "$TG_TOKEN" "$TG_CHAT_ID" | curl --config - >/dev/null \
    || die "Telegram Chat ID 验证失败，请确认目标存在且 Bot 可访问"
  info "Telegram Bot API 与 Chat ID 验证通过"
}

summary() {
  step "部署完成"
  echo -e "${C_GREEN}${C_BOLD}"
  echo "  ┌──────────────────────────────────────────────────────┐"
  echo "  │           文件分发系统 部署完成                        │"
  echo "  └──────────────────────────────────────────────────────┘"
  echo -e "${C_RESET}"
  echo "  访问地址   : $APP_URL"
  echo "  服务状态   :"
  systemctl is-active tgtc-backend 2>/dev/null | sed 's/^/    tgtc-backend             /'
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    systemctl is-active tgtc-telegram-bot-api 2>/dev/null | sed 's/^/    tgtc-telegram-bot-api   /'
  fi
  echo ""
  echo -e "${C_BOLD}后续事项：${C_RESET}"
  echo "  1. 首次访问注册的账号将成为 super_admin"
  echo "  2. 建议部署 HTTPS 反向代理并将 SECURE_COOKIE=true 加入 backend/.env"
  echo "  3. 如启用了防火墙，请放行 TCP 端口 $APP_PORT"
  echo "  4. 常用命令:"
  echo "     systemctl restart tgtc-backend        重启后端"
  echo "     journalctl -u tgtc-backend -f         实时查看日志"
  if [[ "$BUILD_BOT_API" == "yes" ]]; then
    echo "     systemctl restart tgtc-telegram-bot-api  重启 Bot API"
  fi
  echo ""
  echo "  部署日志   : $LOG_FILE"
  echo "  配置文件   : $DEPLOY_DIR/backend/.env"
}

# -----------------------------------------------------------------------------
# 主流程
# -----------------------------------------------------------------------------
main() {
  # 解析参数（--yes 对确认问题统一回答“是”，配置项仍需交互输入）
  for arg in "$@"; do
    case "$arg" in
      --yes) ASSUME_YES="yes" ;;
      -h|--help)
        echo "用法: bash deploy.sh [--yes]"
        echo "  --yes   对所有确认问题自动回答“是”（配置项仍需交互输入）"
        exit 0
        ;;
      *)
        echo "未知参数: $arg" >&2
        echo "用法: bash deploy.sh [--yes]" >&2
        exit 2
        ;;
    esac
  done

  print_banner
  init_log
  preflight
  collect_inputs
  prepare_existing_env
  repair_package_manager
  install_deps
  setup_database
  generate_secrets
  build_bot_api
  build_app
  run_migrations
  setup_services
  health_check
  summary
  info "部署流程结束。如以上任一阶段失败，请根据日志修复后重新运行脚本（可安全重跑）。"
}

print_banner() {
  echo -e "${C_CYAN}${C_BOLD}"
  echo "  =============================================="
  echo "   文件分发系统 · 一键交互式部署脚本"
  echo "   Ubuntu / Debian  |  systemd  |  Node.js 20"
  echo "  =============================================="
  echo -e "${C_RESET}"
}

# 捕获退出码，失败时提示阶段
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && $rc -ne 130 ]]; then
    echo
    echo -e "${C_RED}[错误] 脚本在阶段[$CURRENT_STAGE]中断（退出码 $rc）${C_RESET}" >&2
    if [[ -n "$LOG_FILE" ]]; then
      echo "[错误] 阶段=$CURRENT_STAGE 退出码=$rc" >> "$LOG_FILE"
      echo "[错误] 完整日志见: $LOG_FILE" >&2
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

main "$@"
