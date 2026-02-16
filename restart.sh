#!/bin/bash

# TG 图床系统重启脚本

# 颜色定义
GREEN='\033[0;32m'
NC='\033[0m'

log_info() {
    echo -e "\033[0;34m[INFO]\033[0m $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

echo "=========================================="
echo "  TG 图床系统 - 重启服务"
echo "=========================================="
echo ""

# 停止服务
log_info "停止现有服务..."
./stop.sh

# 等待进程完全停止
sleep 2

# 启动服务
log_info "启动服务..."
./start.sh

echo ""
log_success "重启完成"
