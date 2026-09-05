#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "$(basename "$(dirname "$ROOT_DIR")")" == releases ]]; then
  INSTALL_ROOT="$(dirname "$(dirname "$ROOT_DIR")")"
else
  INSTALL_ROOT="${TGTC_INSTALL_ROOT:-$(dirname "$ROOT_DIR")}" 
fi
CURRENT_ROOT="$INSTALL_ROOT/current"
RUNTIME_DIR="$INSTALL_ROOT/runtime"
BACKEND_DIR="$ROOT_DIR/backend"
BOT_DIR="$ROOT_DIR/telegram-bot-api"
BOT_DATA_DIR="$RUNTIME_DIR/telegram-bot-api/data"
NODE="$ROOT_DIR/runtime/bin/node"
APP_ENV="$RUNTIME_DIR/backend/.env"
BOT_ENV="$RUNTIME_DIR/telegram-bot-api/.env"
APP_SERVICE="tgtc.service"
BOT_SERVICE="tgtc-telegram-bot-api.service"

info() { printf '\033[1;34m[信息]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[完成]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[注意]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

on_error() {
  local exit_code=$?
  printf '\033[1;31m[失败]\033[0m 第 %s 行执行失败（退出码 %s）。\n' "${BASH_LINENO[0]:-未知}" "$exit_code" >&2
  exit "$exit_code"
}
trap on_error ERR

require_layout() {
  [[ "$(uname -s)" == "Linux" ]] || die "此脚本仅支持 Linux。"
  [[ "$(uname -m)" == "x86_64" ]] || die "此发布包仅支持 Linux x86_64。"
  [[ -f "$NODE" ]] || die "缺少内置 Node.js：$NODE"
  [[ -f "$BACKEND_DIR/dist/main.js" ]] || die "缺少后端入口：$BACKEND_DIR/dist/main.js"
  [[ -f "$ROOT_DIR/bin/tgtc" ]] || die "缺少后端启动器：$ROOT_DIR/bin/tgtc"
  [[ -x "$ROOT_DIR/scripts/release/health-check.sh" && -x "$ROOT_DIR/scripts/release/upgrade.sh" ]] || die '发行包缺少健康检查或升级脚本。'
  chmod +x "$NODE" "$ROOT_DIR/bin/tgtc"
  [[ ! -f "$BOT_DIR/bin/telegram-bot-api" ]] || chmod +x "$BOT_DIR/bin/telegram-bot-api"
  [[ "$ROOT_DIR" != *$'\n'* && "$ROOT_DIR" != *$'\r'* && "$ROOT_DIR" != *'%'* && "$ROOT_DIR" != *' '* && "$ROOT_DIR" != *$'\t'* ]] || die "安装路径不能包含空格、制表符、换行、回车或 % 字符。"
  command -v systemctl >/dev/null 2>&1 || die "系统未安装 systemd/systemctl。"
  [[ "$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]')" == "systemd" ]] || die "当前系统未以 systemd 启动。"
}

ensure_current_layout() {
  if [[ -L "$CURRENT_ROOT" ]]; then
    [[ "$(readlink -f "$CURRENT_ROOT")" == "$ROOT_DIR" ]] || die "current 已指向其他发行目录：$CURRENT_ROOT"
    return
  fi
  [[ ! -e "$CURRENT_ROOT" ]] || die "current 存在但不是符号链接：$CURRENT_ROOT"
  ln -s "$ROOT_DIR" "$CURRENT_ROOT"
}

ensure_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "写入 systemd 服务需要 sudo 权限。"
    info "仅写入 systemd 和管理服务时提升权限；程序继续使用当前用户 $(id -un) 运行。"
    exec sudo --preserve-env=TERM -- env TGTC_RUN_USER="$(id -un)" "$0" "$@"
  fi
  SERVICE_USER=${TGTC_RUN_USER:-${SUDO_USER:-root}}
  id "$SERVICE_USER" >/dev/null 2>&1 || die "执行用户不存在：$SERVICE_USER"
}

prompt_value() {
  local __name=$1 label=$2 default_value=${3-} value
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    value=${value:-$default_value}
  else
    while [[ -z "${value:-}" ]]; do
      read -r -p "$label: " value
    done
  fi
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label 不能包含换行符。"
  printf -v "$__name" '%s' "$value"
}

prompt_secret() {
  local __name=$1 label=$2 value=''
  while [[ -z "$value" ]]; do
    read -r -s -p "$label: " value
    printf '\n'
  done
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label 不能包含换行符。"
  printf -v "$__name" '%s' "$value"
}

yes_no() {
  local prompt=$1 default=${2:-n} answer suffix
  [[ "$default" == "y" ]] && suffix='Y/n' || suffix='y/N'
  read -r -p "$prompt [$suffix]: " answer
  answer=${answer:-$default}
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

choose_database() {
  local choice
  printf '\n数据库类型：\n  1) SQLite（单实例、低写并发，免安装数据库）\n  2) PostgreSQL（推荐生产环境）\n'
  while true; do
    read -r -p '请选择 [1]: ' choice
    case "${choice:-1}" in
      1) DB_TYPE=sqlite; return ;;
      2) DB_TYPE=postgres; return ;;
      *) warn "请输入 1 或 2。" ;;
    esac
  done
}

generate_hex() {
  local bytes=$1
  "$NODE" -e "process.stdout.write(require('crypto').randomBytes($bytes).toString('hex'))"
}

env_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/}
  printf '"%s"' "$value"
}

write_env_line() {
  local file=$1 key=$2 value=$3
  printf '%s=%s\n' "$key" "$(env_escape "$value")" >> "$file"
}

redis_cli_ping() {
  local host=$1 port=$2 password=${3-}
  local -a args=(-h "$host" -p "$port" --raw)
  [[ -z "$password" ]] || args+=(--no-auth-warning -a "$password")
  timeout 3 redis-cli "${args[@]}" PING 2>&1 || true
}

redis_try_endpoint() {
  local host=$1 port=$2 password=${3-} output
  output=$(redis_cli_ping "$host" "$port" "$password")
  [[ "$output" == *PONG* ]]
}

redis_detect_local() {
  command -v redis-cli >/dev/null 2>&1 || return 1

  local host port output config_file socket_port
  local -a hosts=(127.0.0.1 localhost ::1) ports=(6379) config_files=()
  for config_file in /etc/redis/redis.conf /etc/redis.conf /etc/redis/*.conf; do
    [[ -f "$config_file" ]] && config_files+=("$config_file")
  done
  if ((${#config_files[@]} > 0)); then
    while IFS= read -r port; do
      [[ "$port" =~ ^[0-9]+$ ]] && ports+=("$port")
    done < <(grep -hE '^[[:space:]]*port[[:space:]]+[0-9]+' "${config_files[@]}" 2>/dev/null | awk '{print $2}' | sort -u || true)
  fi
  if command -v ss >/dev/null 2>&1; then
    while IFS= read -r socket_port; do
      [[ "$socket_port" =~ ^[0-9]+$ ]] && ports+=("$socket_port")
    done < <(ss -ltnp 2>/dev/null | awk '/redis-server/ { n=split($4,a,":"); print a[n] }' | sort -u || true)
  fi

  for host in "${hosts[@]}"; do
    for port in "${ports[@]}"; do
      output=$(redis_cli_ping "$host" "$port")
      if [[ "$output" == *PONG* ]]; then
        REDIS_DETECTED_HOST=$host
        REDIS_DETECTED_PORT=$port
        REDIS_NEEDS_PASSWORD=false
        return 0
      fi
      if [[ "$output" == *NOAUTH* || "$output" == *AUTH*required* ]]; then
        REDIS_DETECTED_HOST=$host
        REDIS_DETECTED_PORT=$port
        REDIS_NEEDS_PASSWORD=true
        return 0
      fi
    done
  done
  return 1
}

redis_repair_runtime_paths() {
  id redis >/dev/null 2>&1 || return 1
  local redis_group
  redis_group=$(id -gn redis)
  install -d -m 0750 -o redis -g "$redis_group" /var/lib/redis /var/log/redis /run/redis
  touch /var/log/redis/redis-server.log
  chown redis:"$redis_group" /var/log/redis/redis-server.log
  chmod 0640 /var/log/redis/redis-server.log
  if ! pgrep -x redis-server >/dev/null 2>&1; then
    rm -f /run/redis/redis-server.pid /var/run/redis/redis-server.pid
  fi
}

redis_port_is_listening() {
  local port=$1
  "$NODE" -e 'const net=require("net");const p=Number(process.argv[1]);const s=net.createServer();s.unref();s.once("error",()=>process.exit(0));s.listen({host:"127.0.0.1",port:p,exclusive:true},()=>s.close(()=>process.exit(1)));' "$port"
}

redis_port_is_free() {
  local port=$1
  "$NODE" -e 'const net=require("net");const p=Number(process.argv[1]);const s=net.createServer();s.unref();s.once("error",()=>process.exit(1));s.listen({host:"127.0.0.1",port:p,exclusive:true},()=>s.close(()=>process.exit(0)));' "$port"
}

redis_find_free_port() {
  local port
  for port in $(seq 6380 6399); do
    redis_port_is_free "$port" && { printf '%s' "$port"; return 0; }
  done
  return 1
}

redis_configure_fallback_port() {
  local config=/etc/redis/redis.conf port
  [[ -f "$config" ]] || return 1
  port=$(redis_find_free_port) || return 1
  [[ -e "$config.tgtc-backup" ]] || cp -a "$config" "$config.tgtc-backup"
  if grep -qE '^[[:space:]]*port[[:space:]]+[0-9]+' "$config"; then
    sed -i -E "s/^[[:space:]]*port[[:space:]]+[0-9]+/port $port/" "$config"
  else
    printf '\nport %s\n' "$port" >> "$config"
  fi
  REDIS_FALLBACK_PORT=$port
  # 端口切换后必须同步检测到的端点，否则后续探测仍按 6379 写入 .env，应用将连错端口。
  REDIS_DETECTED_HOST=127.0.0.1
  REDIS_DETECTED_PORT=$port
  warn "6379 已被其他进程占用且无法作为 Redis 使用，已将系统 Redis 切换到空闲端口 $REDIS_FALLBACK_PORT。"
}

redis_reuse_port_owner() {
  local output
  redis_port_is_listening 6379 || return 1
  output=$(redis_cli_ping 127.0.0.1 6379)
  if [[ "$output" == *PONG* ]]; then
    REDIS_DETECTED_HOST=127.0.0.1
    REDIS_DETECTED_PORT=6379
    REDIS_NEEDS_PASSWORD=false
    success '6379 已有可用 Redis 实例，直接复用该实例。'
    return 0
  fi
  if [[ "$output" == *NOAUTH* || "$output" == *AUTH*required* ]]; then
    REDIS_DETECTED_HOST=127.0.0.1
    REDIS_DETECTED_PORT=6379
    REDIS_NEEDS_PASSWORD=true
    success '6379 已有需要认证的 Redis 实例，将复用该实例。'
    return 0
  fi
  return 1
}

redis_start_local_service() {
  local unit='' candidate pass log_marker
  redis_reuse_port_owner && return 0
  for candidate in redis-server.service redis.service; do
    if systemctl cat "$candidate" >/dev/null 2>&1; then
      unit=$(systemctl show -p Id --value "$candidate" 2>/dev/null || printf '%s' "$candidate")
      break
    fi
  done
  [[ -n "$unit" ]] || return 1

  for pass in 1 2 3; do
    log_marker=$(wc -c < /var/log/redis/redis-server.log 2>/dev/null || printf '0')
    systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    systemctl enable --now "$unit" >/dev/null 2>&1 || true
    for _ in {1..10}; do
      systemctl is-active --quiet "$unit" && return 0
      [[ "$(systemctl is-failed "$unit" 2>/dev/null || true)" == failed ]] && break
      sleep 1
    done
    case "$pass" in
      1)
        warn 'Redis 首次启动失败，正在修复标准运行目录权限并重试……'
        redis_repair_runtime_paths || true
        ;;
      2)
        if tail -c +$((log_marker + 1)) /var/log/redis/redis-server.log 2>/dev/null | grep -q 'Address already in use'; then
          redis_reuse_port_owner && return 0
          redis_configure_fallback_port || break
        else
          break
        fi
        ;;
      3) break ;;
    esac
  done
  return 1
}

redis_wait_until_ready() {
  local _attempt
  for _attempt in {1..15}; do
    redis_detect_local && return 0
    sleep 1
  done
  return 1
}

redis_print_diagnostics() {
  local unit
  for unit in redis-server.service redis.service; do
    if systemctl cat "$unit" >/dev/null 2>&1; then
      warn "Redis 服务状态：$(systemctl is-active "$unit" 2>/dev/null || true)"
      printf '\n--- Redis systemd 状态 ---\n' >&2
      systemctl --no-pager --full status "$unit" 2>&1 | tail -n 20 >&2 || true
      printf '\n--- Redis journal 最近日志 ---\n' >&2
      journalctl -u "$unit" -n 30 --no-pager >&2 || true
      if [[ -f /var/log/redis/redis-server.log ]]; then
        printf '\n--- Redis 文件日志 ---\n' >&2
        tail -n 30 /var/log/redis/redis-server.log >&2 || true
      fi
      return
    fi
  done
}

redis_install_local() {
  info '未检测到 Redis，正在自动安装……'
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server || return 1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y redis || return 1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y redis || return 1
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install redis || return 1
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm redis || return 1
  else
    warn '未识别受支持的包管理器，无法自动安装 Redis。'
    return 1
  fi

  redis_start_local_service || {
    warn 'Redis 已安装，但自动启动服务失败。'
    redis_print_diagnostics
    return 1
  }
  success 'Redis 已安装并启动。'
}

configure_redis() {
  local __host=$1 __port=$2 __password=$3 __db=$4 password=''

  if redis_detect_local; then
    success "检测到本机 Redis：$REDIS_DETECTED_HOST:$REDIS_DETECTED_PORT"
  elif command -v redis-server >/dev/null 2>&1 || command -v redis-cli >/dev/null 2>&1; then
    info '检测到 Redis 已安装，正在尝试启动本机服务并等待就绪……'
    redis_start_local_service || true
    if ! redis_wait_until_ready; then
      warn 'Redis 已安装，但在 15 秒内无法确认本机监听地址或端口。'
      redis_print_diagnostics
      warn '将改为手动填写；如果使用本机默认 Redis，可直接回车接受 127.0.0.1:6379。'
      configure_redis_manual "$__host" "$__port" "$__password" "$__db"
      return
    fi
    success "检测到本机 Redis：$REDIS_DETECTED_HOST:$REDIS_DETECTED_PORT"
  else
    if ! redis_install_local || ! redis_wait_until_ready; then
      warn 'Redis 自动安装、启动或连接检测失败。'
      redis_print_diagnostics
      warn '将改为手动填写。'
      configure_redis_manual "$__host" "$__port" "$__password" "$__db"
      return
    fi
    success "已自动配置本机 Redis：$REDIS_DETECTED_HOST:$REDIS_DETECTED_PORT"
  fi

  if [[ "$REDIS_NEEDS_PASSWORD" == true ]]; then
    while true; do
      prompt_secret password '本机 Redis 需要密码，请输入'
      redis_try_endpoint "$REDIS_DETECTED_HOST" "$REDIS_DETECTED_PORT" "$password" && break
      warn 'Redis 密码验证失败，请重新输入。'
    done
  fi
  printf -v "$__host" '%s' "$REDIS_DETECTED_HOST"
  printf -v "$__port" '%s' "$REDIS_DETECTED_PORT"
  printf -v "$__password" '%s' "$password"
  printf -v "$__db" '%s' '0'
}

configure_redis_manual() {
  local __host=$1 __port=$2 __password=$3 __db=$4 host port password db output
  while true; do
    prompt_value host 'Redis 主机' '127.0.0.1'
    prompt_value port 'Redis 端口' '6379'
    read -r -s -p 'Redis 密码（无密码直接回车）: ' password
    printf '\n'
    output=$(redis_cli_ping "$host" "$port" "$password")
    if [[ "$output" == *PONG* ]]; then
      break
    fi
    warn "无法连接 Redis $host:$port，返回：${output:-无响应}"
    warn '首次部署必须连接到可用 Redis，请检查服务后重新填写。'
  done
  prompt_value db 'Redis 数据库编号' '0'
  printf -v "$__host" '%s' "$host"
  printf -v "$__port" '%s' "$port"
  printf -v "$__password" '%s' "$password"
  printf -v "$__db" '%s' "$db"
}

configure() {
  local app_url cors_origins redis_host redis_port redis_password redis_db
  local bot_token chat_id secure_cookie jwt_secret code_hmac_secret
  local db_host db_port db_user db_password db_name db_ssl
  local smtp_host smtp_port smtp_secure smtp_user smtp_password smtp_from smtp_key smtp_salt
  local telegram_api_id telegram_api_hash

  printf '\n=== TGTC 首次配置 ===\n'
  choose_database

  if [[ "$DB_TYPE" == "postgres" ]]; then
    prompt_value db_host 'PostgreSQL 主机' '127.0.0.1'
    prompt_value db_port 'PostgreSQL 端口' '5432'
    prompt_value db_user 'PostgreSQL 用户名' 'postgres'
    prompt_secret db_password 'PostgreSQL 密码'
    prompt_value db_name 'PostgreSQL 数据库名' 'tgtc'
    if yes_no 'PostgreSQL 是否启用 SSL 证书校验？' n; then db_ssl=true; else db_ssl=false; fi
  else
    db_name='./data/tgtc.sqlite'
  fi

  configure_redis redis_host redis_port redis_password redis_db

  while true; do
    prompt_secret bot_token 'Telegram Bot Token'
    [[ "$bot_token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] && break
    warn 'Token 格式应为 <bot_id>:<token>，请重新输入。'
  done
  prompt_value chat_id 'Telegram 存储 Chat ID'

  if yes_no '是否启用发布包内置 Telegram Bot API？' y; then
    ENABLE_BOT_API=true
    while true; do
      prompt_value telegram_api_id 'Telegram API ID（纯数字）'
      [[ "$telegram_api_id" =~ ^[0-9]+$ ]] && break
      warn 'Telegram API ID 只能包含数字，请重新输入。'
    done
    while true; do
      prompt_secret telegram_api_hash 'Telegram API Hash（32 位十六进制）'
      [[ "$telegram_api_hash" =~ ^[0-9a-fA-F]{32}$ ]] && break
      warn 'Telegram API Hash 应为 32 位十六进制字符串，请重新输入。'
    done
  else
    ENABLE_BOT_API=false
  fi

  prompt_value app_url '站点公开 URL（含 http/https）' 'http://127.0.0.1:3000'
  prompt_value cors_origins '允许跨域来源（多个用逗号分隔）' "$app_url"
  if [[ "$app_url" == https://* ]]; then secure_cookie=true; else secure_cookie=false; fi

  jwt_secret=$(generate_hex 48)
  code_hmac_secret=$(generate_hex 48)
  info '已生成 384 位随机 JWT 密钥和验证码 HMAC 密钥。'

  if yes_no '是否启用 SMTP 邮件功能？' n; then
    ENABLE_SMTP=true
    prompt_value smtp_host 'SMTP 主机'
    prompt_value smtp_port 'SMTP 端口' '587'
    if yes_no 'SMTP 是否使用 TLS 直连（通常端口 465）？' n; then smtp_secure=true; else smtp_secure=false; fi
    prompt_value smtp_user 'SMTP 用户名'
    prompt_secret smtp_password 'SMTP 密码/授权码'
    prompt_value smtp_from '发件人地址' "$smtp_user"
    smtp_key=$(generate_hex 32)
    smtp_salt=$(generate_hex 16)
    info '已生成 256 位 SMTP 加密密钥和 128 位随机盐。'
  else
    ENABLE_SMTP=false
  fi

  umask 077
  : > "$APP_ENV"
  {
    printf '# 由 start.sh 生成。请妥善保管，禁止提交或分享。\n'
    printf 'NODE_ENV=production\nAPP_HOST=0.0.0.0\nAPP_PORT=3000\n'
  } >> "$APP_ENV"
  write_env_line "$APP_ENV" APP_URL "$app_url"
  write_env_line "$APP_ENV" FRONTEND_URL "$app_url"
  write_env_line "$APP_ENV" CORS_ORIGINS "$cors_origins"
  printf 'SECURE_COOKIE=%s\nTOKEN_EXTRACTION_MODE=both\n' "$secure_cookie" >> "$APP_ENV"
  write_env_line "$APP_ENV" JWT_SECRET "$jwt_secret"
  write_env_line "$APP_ENV" CODE_HMAC_SECRET "$code_hmac_secret"
  printf 'JWT_EXPIRES_IN=7d\n' >> "$APP_ENV"

  printf 'DB_TYPE=%s\nDB_SYNCHRONIZE=false\nDB_MIGRATIONS_RUN=true\n' "$DB_TYPE" >> "$APP_ENV"
  write_env_line "$APP_ENV" DB_DATABASE "$db_name"
  if [[ "$DB_TYPE" == "postgres" ]]; then
    write_env_line "$APP_ENV" DB_HOST "$db_host"
    write_env_line "$APP_ENV" DB_PORT "$db_port"
    write_env_line "$APP_ENV" DB_USERNAME "$db_user"
    write_env_line "$APP_ENV" DB_PASSWORD "$db_password"
    printf 'DB_SSL=%s\n' "$db_ssl" >> "$APP_ENV"
  else
    printf 'DB_SQLITE_BUSY_TIMEOUT_MS=5000\n' >> "$APP_ENV"
  fi
  cat >> "$APP_ENV" <<'EOF'
DB_POOL_SIZE=20
DB_CONNECTION_TIMEOUT_MS=5000
DB_STATEMENT_TIMEOUT_MS=30000
DB_QUERY_TIMEOUT_MS=35000
DB_LOCK_TIMEOUT_MS=3000
DB_IDLE_TRANSACTION_TIMEOUT_MS=30000
EOF

  write_env_line "$APP_ENV" REDIS_HOST "$redis_host"
  write_env_line "$APP_ENV" REDIS_PORT "$redis_port"
  write_env_line "$APP_ENV" REDIS_PASSWORD "$redis_password"
  write_env_line "$APP_ENV" REDIS_DB "$redis_db"
  write_env_line "$APP_ENV" TELEGRAM_BOT_TOKEN "$bot_token"
  write_env_line "$APP_ENV" TELEGRAM_CHAT_ID "$chat_id"

  if [[ "$ENABLE_BOT_API" == true ]]; then
    cat >> "$APP_ENV" <<EOF
TELEGRAM_API_BASE="http://127.0.0.1:8081"
TELEGRAM_FILE_STREAMING_ENABLED=true
TELEGRAM_FILE_STREAM_BASE="http://127.0.0.1:8081"
TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS=120
EOF
    write_env_line "$APP_ENV" TELEGRAM_LOCAL_FILE_DIR "$BOT_DATA_DIR"
    : > "$BOT_ENV"
    write_env_line "$BOT_ENV" TELEGRAM_API_ID "$telegram_api_id"
    write_env_line "$BOT_ENV" TELEGRAM_API_HASH "$telegram_api_hash"
    chmod 600 "$BOT_ENV"
  else
    rm -f "$BOT_ENV"
  fi

  if [[ "$ENABLE_SMTP" == true ]]; then
    write_env_line "$APP_ENV" SMTP_HOST "$smtp_host"
    write_env_line "$APP_ENV" SMTP_PORT "$smtp_port"
    write_env_line "$APP_ENV" SMTP_SECURE "$smtp_secure"
    write_env_line "$APP_ENV" SMTP_USER "$smtp_user"
    write_env_line "$APP_ENV" SMTP_PASSWORD "$smtp_password"
    write_env_line "$APP_ENV" SMTP_FROM "$smtp_from"
    write_env_line "$APP_ENV" SMTP_ENCRYPTION_KEY "$smtp_key"
    write_env_line "$APP_ENV" SMTP_ENCRYPTION_SALT "$smtp_salt"
  fi

  cat >> "$APP_ENV" <<'EOF'
MAX_FILE_SIZE=83886080
ACCESS_LOG_RETENTION_DAYS=30
AUDIT_LOG_RETENTION_DAYS=90
LOG_DIR=tmp/logs
LOG_ROTATION_INTERVAL=daily
LOG_MAX_FILE_SIZE=20971520
LOG_RETENTION_DAYS=7
EOF
  chmod 600 "$APP_ENV"
  success "配置已写入 $APP_ENV"
}

unit_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

install_services() {
  local service_user=$1 current_q backend_q app_env_q bot_dir_q bot_data_q bot_env_q
  current_q=$(unit_escape "$CURRENT_ROOT")
  backend_q=$(unit_escape "$RUNTIME_DIR/backend")
  app_env_q=$(unit_escape "$APP_ENV")
  bot_dir_q=$(unit_escape "$CURRENT_ROOT/telegram-bot-api")
  bot_data_q=$(unit_escape "$BOT_DATA_DIR")
  bot_env_q=$(unit_escape "$BOT_ENV")

  cat > "/etc/systemd/system/$APP_SERVICE" <<EOF
[Unit]
Description=TGTC File Distribution System ($current_q)
After=network-online.target
Wants=network-online.target
$(if [[ "$ENABLE_BOT_API" == true ]]; then printf 'Requires=%s\nAfter=%s\n' "$BOT_SERVICE" "$BOT_SERVICE"; fi)
[Service]
Type=simple
User=$service_user
Group=$(id -gn "$service_user")
WorkingDirectory=$backend_q
EnvironmentFile=-$app_env_q
ExecStart=$current_q/bin/tgtc
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0027
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  if [[ "$ENABLE_BOT_API" == true ]]; then
    [[ -x "$BOT_DIR/bin/telegram-bot-api" ]] || die "缺少内置 Telegram Bot API 可执行文件。"
    cat > "/etc/systemd/system/$BOT_SERVICE" <<EOF
[Unit]
Description=TGTC bundled Telegram Bot API ($current_q)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
Group=$(id -gn "$service_user")
EnvironmentFile=-$bot_env_q
ExecStart=$bot_dir_q/bin/telegram-bot-api --api-id=\${TELEGRAM_API_ID} --api-hash=\${TELEGRAM_API_HASH} --local --http-port=8081 --dir=$bot_data_q --enable-file-streaming
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
LimitNOFILE=1048576
UMask=0027
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  else
    systemctl disable --now "$BOT_SERVICE" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$BOT_SERVICE"
  fi

  local -a unit_files=("/etc/systemd/system/$APP_SERVICE")
  [[ "$ENABLE_BOT_API" != true ]] || unit_files+=("/etc/systemd/system/$BOT_SERVICE")
  if ! systemd-analyze verify "${unit_files[@]}"; then
    die '动态生成的 systemd 单元校验失败，未启动服务。请保留上方校验错误。'
  fi
  systemctl daemon-reload
  systemctl enable "$APP_SERVICE" >/dev/null
  [[ "$ENABLE_BOT_API" != true ]] || systemctl enable "$BOT_SERVICE" >/dev/null
}

prepare_permissions() {
  local service_user=$1
  install -d -m 0750 -o "$service_user" -g "$(id -gn "$service_user")" \
    "$RUNTIME_DIR/backend" "$RUNTIME_DIR/telegram-bot-api" "$RUNTIME_DIR/backend/data" "$RUNTIME_DIR/backend/tmp" "$BOT_DATA_DIR"
  chown "$service_user:$(id -gn "$service_user")" "$APP_ENV"
  [[ ! -f "$BOT_ENV" ]] || chown "$service_user:$(id -gn "$service_user")" "$BOT_ENV"
  chmod 600 "$APP_ENV"
  [[ ! -f "$BOT_ENV" ]] || chmod 600 "$BOT_ENV"

  local probe=$ROOT_DIR
  while [[ "$probe" != '/' ]]; do
    if ! runuser -u "$service_user" -- test -x "$probe"; then
      die "服务用户 $service_user 无法访问目录 $probe。请将发布包移到该用户可访问的位置后重试。"
    fi
    probe=$(dirname "$probe")
  done
}

existing_deployment_detected() {
  [[ -e "/etc/systemd/system/$APP_SERVICE" ]] && return 0
  systemctl is-enabled "$APP_SERVICE" >/dev/null 2>&1 && return 0
  [[ -s "$APP_ENV" ]] && return 0
  find "$RUNTIME_DIR/backend/data" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .
}

app_service_exists() {
  [[ -e "/etc/systemd/system/$APP_SERVICE" ]] || systemctl cat "$APP_SERVICE" >/dev/null 2>&1
}

bot_service_exists() {
  [[ -e "/etc/systemd/system/$BOT_SERVICE" ]] || systemctl cat "$BOT_SERVICE" >/dev/null 2>&1
}

require_managed_service() {
  app_service_exists || die "检测到配置或数据，但 $APP_SERVICE 不存在，无法执行服务管理。脚本不会自动覆盖部署或迁移，请先确认首次部署失败现场。"
}

manage_start() {
  require_managed_service
  bot_service_exists && systemctl start "$BOT_SERVICE"
  systemctl start "$APP_SERVICE"
  sleep 2
  systemctl is-active --quiet "$APP_SERVICE" || die "TGTC 启动失败，请选择日志查看原因。"
  success 'TGTC 已启动。'
}

manage_restart() {
  require_managed_service
  bot_service_exists && systemctl restart "$BOT_SERVICE"
  systemctl restart "$APP_SERVICE"
  sleep 2
  systemctl is-active --quiet "$APP_SERVICE" || die "TGTC 重启失败，请选择日志查看原因。"
  success 'TGTC 已重启。'
}

manage_stop() {
  require_managed_service
  systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
  bot_service_exists && systemctl stop "$BOT_SERVICE" >/dev/null 2>&1 || true
  success 'TGTC 已停止。'
}

manage_status() {
  require_managed_service
  systemctl --no-pager --full status "$APP_SERVICE" || true
  if bot_service_exists; then
    printf '\n'
    systemctl --no-pager --full status "$BOT_SERVICE" || true
  fi
}

manage_logs() {
  require_managed_service
  printf '\n最近 100 行后端日志：\n'
  journalctl -u "$APP_SERVICE" -n 100 --no-pager
  if bot_service_exists; then
    printf '\n最近 50 行 Telegram Bot API 日志：\n'
    journalctl -u "$BOT_SERVICE" -n 50 --no-pager
  fi
}

manage_repair_units() {
  [[ -s "$APP_ENV" ]] || die "缺少 $APP_ENV，无法修复服务单元。"
  ENABLE_BOT_API=false
  [[ -s "$BOT_ENV" ]] && ENABLE_BOT_API=true
  prepare_permissions "$SERVICE_USER"
  install_services "$SERVICE_USER"
  success 'systemd 服务单元已按当前目录重新生成并通过校验。'
}

management_menu() {
  local choice
  while true; do
    printf '\n=== TGTC 管理菜单 ===\n'
    printf '  1) 启动服务\n  2) 重启服务\n  3) 停止服务\n  4) 查看状态\n  5) 查看日志\n  6) 修复 systemd 服务单元\n  0) 退出\n'
    read -r -p '请选择: ' choice
    case "$choice" in
      1) manage_start ;;
      2) manage_restart ;;
      3) manage_stop ;;
      4) manage_status ;;
      5) manage_logs ;;
      6) manage_repair_units ;;
      0) return ;;
      *) warn '请输入 0-6。' ;;
    esac
  done
}

start_services() {
  info '正在启动服务……'
  if [[ "$ENABLE_BOT_API" == true ]]; then
    systemctl restart "$BOT_SERVICE"
  fi
  systemctl restart "$APP_SERVICE"
  sleep 2
  if ! systemctl is-active --quiet "$APP_SERVICE"; then
    systemctl --no-pager --full status "$APP_SERVICE" || true
    die "后端服务未保持运行，请使用 journalctl -u $APP_SERVICE -n 100 --no-pager 查看日志。"
  fi
  if [[ "$ENABLE_BOT_API" == true ]] && ! systemctl is-active --quiet "$BOT_SERVICE"; then
    systemctl --no-pager --full status "$BOT_SERVICE" || true
    die "Telegram Bot API 服务未保持运行。"
  fi
  success 'TGTC 服务已启动并处于 active 状态。'
  printf '\n服务状态：\n'
  systemctl --no-pager --full status "$APP_SERVICE" || true
  printf '\n常用命令：\n'
  printf '  查看状态：sudo systemctl status %s\n' "$APP_SERVICE"
  printf '  查看日志：sudo journalctl -u %s -f\n' "$APP_SERVICE"
  printf '  停止服务：sudo systemctl stop %s\n' "$APP_SERVICE"
}

main() {
  require_layout
  ensure_root "$@"
  ensure_current_layout

  case "${1:-}" in
    --help|-h)
      printf '用法：./start.sh\n全新环境进入首次部署；发现已有服务、配置或后端数据时进入服务管理菜单。脚本不提供升级、迁移或重配置功能。\n'
      exit
      ;;
    '') ;;
    *) die "首次部署脚本不接受参数：$1" ;;
  esac

  if existing_deployment_detected; then
    info '检测到已有 TGTC 服务、配置或后端数据，已切换到管理模式。'
    management_menu
    exit
  fi

  configure
  info "服务将直接使用执行用户 $SERVICE_USER 运行。"
  prepare_permissions "$SERVICE_USER"
  install_services "$SERVICE_USER"
  start_services
}

main "$@"
