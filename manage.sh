#!/usr/bin/env bash

# TG 图床统一管理脚本
# 用法: ./manage.sh <command>
# command: init-db | install-deps | build | start | stop | restart | backup | status | logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="tg-imagebed"
APP_BIN="$SCRIPT_DIR/$APP_NAME"
PID_FILE="$SCRIPT_DIR/$APP_NAME.pid"
LOG_FILE="$SCRIPT_DIR/$APP_NAME.log"
LEGACY_PID_FILE="$SCRIPT_DIR/http.pid"
LEGACY_LOG_FILE="$SCRIPT_DIR/http.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

require_file() {
    local path="$1"
    if [ ! -f "$path" ]; then
        log_error "缺少文件: $path"
        exit 1
    fi
}

read_mysql_config() {
    local cfg="$SCRIPT_DIR/data.json"
    require_file "$cfg"

    readarray -t DB_CONF < <(python3 - "$cfg" <<'PY'
import json, sys
from pathlib import Path
cfg_path = Path(sys.argv[1])
cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
mysql = cfg.get('mysql', {})
print(mysql.get('host', 'localhost'))
print(mysql.get('port', 3306))
print(mysql.get('username', 'root'))
print(mysql.get('password', ''))
print(mysql.get('database', ''))
PY
)

    DB_HOST="${DB_CONF[0]}"
    DB_PORT="${DB_CONF[1]}"
    DB_USER="${DB_CONF[2]}"
    DB_PASS="${DB_CONF[3]}"
    DB_NAME="${DB_CONF[4]}"

    if [ -z "$DB_NAME" ]; then
        log_error "配置缺失: mysql.database 不能为空"
        exit 1
    fi
}

normalize_legacy_files() {
    if [ -f "$LEGACY_PID_FILE" ] && [ ! -f "$PID_FILE" ]; then
        mv "$LEGACY_PID_FILE" "$PID_FILE"
        log_info "已迁移 PID 文件: http.pid -> ${APP_NAME}.pid"
    fi

    if [ -f "$LEGACY_LOG_FILE" ] && [ ! -f "$LOG_FILE" ]; then
        mv "$LEGACY_LOG_FILE" "$LOG_FILE"
        log_info "已迁移日志文件: http.log -> ${APP_NAME}.log"
    fi
}

install_deps() {
    log_info "安装依赖..."

    if command_exists go && [ -f "$SCRIPT_DIR/go.mod" ]; then
        if go mod download; then
            log_success "Go 依赖安装完成"
        else
            log_warn "Go 依赖安装失败（可能是网络或代理限制）"
        fi
    else
        log_warn "跳过 Go 依赖安装（未检测到 go 或 go.mod）"
    fi

    if command_exists python3 && [ -f "$SCRIPT_DIR/requirements.txt" ]; then
        if python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"; then
            log_success "Python 依赖安装完成"
        else
            log_warn "Python 依赖安装失败（请检查 pip/网络）"
        fi
    else
        log_warn "跳过 Python 依赖安装（未检测到 python3 或 requirements.txt）"
    fi
}

build_service() {
    require_file "$SCRIPT_DIR/main.go"

    if ! command_exists go; then
        log_error "未找到 go 命令"
        exit 1
    fi

    log_info "编译服务..."
    (cd "$SCRIPT_DIR" && go build -o "$APP_NAME" main.go)
    log_success "编译完成: $APP_BIN"
}

init_db() {
    log_info "执行数据库初始化/迁移..."
    bash "$SCRIPT_DIR/init-db.sh"
}

is_pid_running() {
    local pid="$1"
    ps -p "$pid" >/dev/null 2>&1
}

status_service() {
    normalize_legacy_files

    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE")"
        if is_pid_running "$pid"; then
            log_success "服务运行中，PID: $pid"
            log_info "日志文件: $LOG_FILE"
            return 0
        fi
        log_warn "PID 文件存在但进程不在运行，清理旧 PID 文件"
        rm -f "$PID_FILE"
    fi

    log_warn "服务未运行"
    return 1
}

start_service() {
    require_file "$SCRIPT_DIR/data.json"
    normalize_legacy_files

    if status_service >/dev/null 2>&1; then
        log_warn "服务已在运行，无需重复启动"
        return 0
    fi

    build_service

    log_info "启动服务..."
    nohup "$APP_BIN" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    sleep 1
    local pid
    pid="$(cat "$PID_FILE")"
    if is_pid_running "$pid"; then
        log_success "服务已启动，PID: $pid"
        log_info "日志输出: $LOG_FILE"
    else
        log_error "服务启动失败，请检查日志: $LOG_FILE"
        exit 1
    fi
}

stop_service() {
    normalize_legacy_files

    if [ ! -f "$PID_FILE" ]; then
        log_warn "未找到 ${APP_NAME}.pid"
        return 0
    fi

    local pid
    pid="$(cat "$PID_FILE")"

    if ! is_pid_running "$pid"; then
        log_warn "PID 文件存在但进程未运行"
        rm -f "$PID_FILE"
        return 0
    fi

    log_info "停止服务 PID: $pid"
    kill "$pid" || true
    sleep 1

    if is_pid_running "$pid"; then
        log_warn "进程未正常退出，执行强制终止"
        kill -9 "$pid" || true
    fi

    rm -f "$PID_FILE"
    log_success "服务已停止"
}

restart_service() {
    stop_service
    start_service
}

tail_logs() {
    normalize_legacy_files
    if [ -f "$LOG_FILE" ]; then
        tail -n 100 -f "$LOG_FILE"
    else
        log_warn "日志文件不存在: $LOG_FILE"
    fi
}

backup_package() {
    local timestamp backup_dir backup_file
    timestamp="$(date +%Y%m%d_%H%M%S)"
    backup_dir="$SCRIPT_DIR/backups"
    backup_file="$backup_dir/tg-imagebed-backup-${timestamp}.tar.gz"
    mkdir -p "$backup_dir"

    local tmpdir
    tmpdir="$(mktemp -d)"

    log_info "准备备份文件..."
    mkdir -p "$tmpdir/files"

    # 当前结构下建议保留的核心文件
    local include_files=(
        data.json
        data.json.example
        init_db.go.sql
        init-db.sh
        manage.sh
        README.md
        main.go
        go.mod
        go.sum
        admin/index.html
        admin/README.md
    )

    local f
    for f in "${include_files[@]}"; do
        if [ -f "$SCRIPT_DIR/$f" ]; then
            mkdir -p "$tmpdir/files/$(dirname "$f")"
            cp "$SCRIPT_DIR/$f" "$tmpdir/files/$f"
        fi
    done

    for f in "$LOG_FILE" "$PID_FILE" "$LEGACY_LOG_FILE" "$LEGACY_PID_FILE"; do
        if [ -f "$f" ]; then
            cp "$f" "$tmpdir/files/"
        fi
    done

    if [ -d "$SCRIPT_DIR/logs" ]; then
        cp -r "$SCRIPT_DIR/logs" "$tmpdir/files/"
    fi

    if command_exists mysqldump && [ -f "$SCRIPT_DIR/data.json" ]; then
        read_mysql_config
        log_info "导出数据库备份..."
        if mysqldump -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$tmpdir/files/db-${DB_NAME}.sql"; then
            log_success "数据库导出完成"
        else
            log_warn "数据库导出失败，继续打包文件备份"
        fi
    else
        log_warn "跳过数据库导出（未检测到 mysqldump 或 data.json）"
    fi

    tar -C "$tmpdir/files" -czf "$backup_file" .
    rm -rf "$tmpdir"
    log_success "备份完成: $backup_file"
}

usage() {
    cat <<USAGE
TG 图床统一管理脚本

用法:
  ./manage.sh <command>

命令:
  init-db       初始化/迁移数据库
  install-deps  安装依赖
  build         编译服务
  start         启动服务
  stop          停止服务
  restart       重启服务
  status        查看运行状态
  logs          实时查看日志（tail -f）
  backup        备份配置/日志/数据库为压缩包
USAGE
}

main() {
    local cmd="${1:-}"
    case "$cmd" in
        init-db) init_db ;;
        install-deps) install_deps ;;
        build) build_service ;;
        start) start_service ;;
        stop) stop_service ;;
        restart) restart_service ;;
        status) status_service ;;
        logs) tail_logs ;;
        backup) backup_package ;;
        ""|-h|--help|help) usage ;;
        *)
            log_error "未知命令: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
