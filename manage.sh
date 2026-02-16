#!/usr/bin/env bash

# TG 图床统一管理脚本
# 用法: ./manage.sh <command>
# command: init-db | install-deps | start | stop | restart | backup | status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

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

install_deps() {
    log_info "安装依赖..."

    if command_exists go && [ -f "$SCRIPT_DIR/go.mod" ]; then
        (cd "$SCRIPT_DIR" && go mod tidy)
        log_success "Go 依赖安装完成"
    else
        log_warn "跳过 Go 依赖安装（未检测到 go 或 go.mod）"
    fi

    if command_exists python3 && [ -f "$SCRIPT_DIR/requirements.txt" ]; then
        python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"
        log_success "Python 依赖安装完成"
    else
        log_warn "跳过 Python 依赖安装（未检测到 python3 或 requirements.txt）"
    fi
}

init_db() {
    log_info "执行数据库初始化/迁移..."
    bash "$SCRIPT_DIR/init-db.sh"
}

start_service() {
    require_file "$SCRIPT_DIR/data.json"

    if ! command_exists go; then
        log_error "未找到 go 命令"
        exit 1
    fi

    log_info "编译服务..."
    (cd "$SCRIPT_DIR" && go build -o tg-imagebed main.go)

    log_info "启动服务..."
    nohup "$SCRIPT_DIR/tg-imagebed" > "$SCRIPT_DIR/http.log" 2>&1 &
    echo $! > "$SCRIPT_DIR/http.pid"

    log_success "服务已启动，PID: $(cat "$SCRIPT_DIR/http.pid")"
}

stop_service() {
    if [ -f "$SCRIPT_DIR/http.pid" ]; then
        local pid
        pid="$(cat "$SCRIPT_DIR/http.pid")"
        if ps -p "$pid" >/dev/null 2>&1; then
            log_info "停止服务 PID: $pid"
            kill "$pid" || true
            sleep 1
            if ps -p "$pid" >/dev/null 2>&1; then
                kill -9 "$pid" || true
            fi
            log_success "服务已停止"
        else
            log_warn "PID 文件存在但进程未运行"
        fi
        rm -f "$SCRIPT_DIR/http.pid"
    else
        log_warn "未找到 http.pid"
    fi
}

restart_service() {
    stop_service
    start_service
}

status_service() {
    if [ -f "$SCRIPT_DIR/http.pid" ]; then
        local pid
        pid="$(cat "$SCRIPT_DIR/http.pid")"
        if ps -p "$pid" >/dev/null 2>&1; then
            log_success "服务运行中，PID: $pid"
            return 0
        fi
    fi
    log_warn "服务未运行"
    return 1
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

    for f in data.json data.json.example init_db.go.sql README.md; do
        if [ -f "$SCRIPT_DIR/$f" ]; then
            cp "$SCRIPT_DIR/$f" "$tmpdir/files/"
        fi
    done

    if [ -d "$SCRIPT_DIR/logs" ]; then
        cp -r "$SCRIPT_DIR/logs" "$tmpdir/files/"
    fi
    for f in http.log http.pid; do
        if [ -f "$SCRIPT_DIR/$f" ]; then
            cp "$SCRIPT_DIR/$f" "$tmpdir/files/"
        fi
    done

    if command_exists mysqldump && [ -f "$SCRIPT_DIR/data.json" ]; then
        read_mysql_config
        log_info "导出数据库备份..."
        mysqldump -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$tmpdir/files/db-${DB_NAME}.sql"
        log_success "数据库导出完成"
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
  start         启动服务
  stop          停止服务
  restart       重启服务
  status        查看运行状态
  backup        备份配置/日志/数据库为压缩包
USAGE
}

main() {
    local cmd="${1:-}"
    case "$cmd" in
        init-db) init_db ;;
        install-deps) install_deps ;;
        start) start_service ;;
        stop) stop_service ;;
        restart) restart_service ;;
        status) status_service ;;
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
