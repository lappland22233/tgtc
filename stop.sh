#!/bin/bash

# TG 图床系统停止脚本

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "\033[0;34m[INFO]\033[0m $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo "=========================================="
echo "  TG 图床系统 - 停止服务"
echo "=========================================="
echo ""

# 停止 HTTP 服务
if [ -f "http.pid" ]; then
    HTTP_PID=$(cat http.pid)
    if ps -p $HTTP_PID > /dev/null 2>&1; then
        log_info "停止 HTTP 服务 (PID: $HTTP_PID)..."
        kill $HTTP_PID
        sleep 1
        if ps -p $HTTP_PID > /dev/null 2>&1; then
            kill -9 $HTTP_PID
        fi
        log_success "HTTP 服务已停止"
    else
        log_warn "HTTP 服务未运行"
    fi
    rm -f http.pid
else
    log_warn "未找到 HTTP 服务 PID 文件"
fi

# 停止 Bot 服务
if [ -f "bot.pid" ]; then
    BOT_PID=$(cat bot.pid)
    if ps -p $BOT_PID > /dev/null 2>&1; then
        log_info "停止 Telegram Bot (PID: $BOT_PID)..."
        kill $BOT_PID
        sleep 1
        if ps -p $BOT_PID > /dev/null 2>&1; then
            kill -9 $BOT_PID
        fi
        log_success "Telegram Bot 已停止"
    else
        log_warn "Telegram Bot 未运行"
    fi
    rm -f bot.pid
else
    log_warn "未找到 Bot 服务 PID 文件"
fi

# 额外清理残留进程
log_info "清理残留进程..."
pkill -f "tg-imagebed" 2>/dev/null || true
pkill -f "python bot.py" 2>/dev/null || true

echo ""
log_success "所有服务已停止"
