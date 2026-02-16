#!/bin/bash

# TG 图床系统一键启动脚本
# 支持配置检查、依赖安装、虚拟环境创建、自动启动

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 检查配置文件
check_config() {
    log_info "检查配置文件..."

    if [ ! -f "data.json" ]; then
        log_warn "配置文件 data.json 不存在，开始交互式配置..."

        if [ -f "data.json.example" ]; then
            cp data.json.example data.json
            log_success "已创建配置文件模板"
        else
            log_error "找不到 data.json.example 模板文件"
            exit 1
        fi

        # 交互式填写配置
        echo ""
        log_info "请填写以下配置信息："
        echo "----------------------------------------"

        # Telegram Bot Token
        read -p "1. Telegram Bot Token (从 @BotFather 获取): " bot_token
        sed -i "s|\"bot_token\": \".*\"|\"bot_token\": \"$bot_token\"|" data.json

        # Channel ID
        read -p "2. Telegram Channel/Group ID (频道需为负数，如 -1001234567890): " channel_id
        sed -i "s|\"channel_id\": \".*\"|\"channel_id\": \"$channel_id\"|" data.json

        # MySQL 配置
        read -p "3. MySQL 主机地址 (默认: localhost): " mysql_host
        mysql_host=${mysql_host:-localhost}
        sed -i "s|\"host\": \".*\"|\"host\": \"$mysql_host\"|" data.json

        read -p "4. MySQL 端口 (默认: 3306): " mysql_port
        mysql_port=${mysql_port:-3306}
        sed -i "s|\"port\": .*|\"port\": $mysql_port,|" data.json

        read -p "5. MySQL 用户名: " mysql_user
        sed -i "s|\"username\": \".*\"|\"username\": \"$mysql_user\"|" data.json

        read -s -p "6. MySQL 密码: " mysql_pass
        echo
        sed -i "s|\"password\": \".*\"|\"password\": \"$mysql_pass\"|" data.json

        read -p "7. MySQL 数据库名 (默认: tg_imagebed): " mysql_db
        mysql_db=${mysql_db:-tg_imagebed}
        sed -i "s|\"database\": \".*\"|\"database\": \"$mysql_db\"|" data.json

        # 管理员 ID
        echo ""
        log_info "请输入管理员 Telegram ID (可从 @userinfobot 获取)"
        read -p "8. 管理员 ID (多个用逗号分隔): " admin_ids
        sed -i "s|\"user_ids\": \[.*\]|\"user_ids\": [$admin_ids]|" data.json

        echo "----------------------------------------"
        log_success "配置文件已生成！"
        echo ""
        log_info "配置文件内容预览："
        cat data.json | head -20
        echo ""
        read -p "请按 Enter 继续..."

    else
        log_success "配置文件已存在"
    fi
}

# 初始化数据库
init_database() {
    log_info "检查数据库连接..."

    # 检查 MySQL 客户端
    if ! command_exists mysql; then
        log_warn "未找到 mysql 命令，请手动执行 init_db.go.sql 初始化数据库"
        return
    fi

    # 读取配置
    if [ ! -f "data.json" ]; then
        log_error "配置文件不存在"
        exit 1
    fi

    mysql_host=$(grep -oP '(?<= "host": ")[^"]*' data.json)
    mysql_port=$(grep -oP '(?<= "port": )\d+' data.json)
    mysql_user=$(grep -oP '(?<= "username": ")[^"]*' data.json)
    mysql_pass=$(grep -oP '(?<= "password": ")[^"]*' data.json)
    mysql_db=$(grep -oP '(?<= "database": ")[^"]*' data.json)

    # 测试连接
    if mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" -p"$mysql_pass" -e "USE $mysql_db;" 2>/dev/null; then
        log_success "数据库连接成功，数据库已存在"
    else
        log_warn "数据库不存在，尝试初始化..."
        if [ -f "init_db.go.sql" ]; then
            mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" -p"$mysql_pass" < init_db.go.sql
            if [ $? -eq 0 ]; then
                log_success "数据库初始化成功"
            else
                log_error "数据库初始化失败，请手动执行 init_db.go.sql"
            fi
        else
            log_error "找不到 init_db.go.sql 文件"
        fi
    fi
}

# 安装 Go 依赖
install_go_deps() {
    log_info "安装 Go 依赖..."

    if ! command_exists go; then
        log_error "未找到 Go 环境，请先安装 Go 1.21+"
        exit 1
    fi

    if [ -f "go.mod" ]; then
        go mod tidy
        log_success "Go 依赖安装完成"
    else
        log_warn "未找到 go.mod 文件"
    fi
}

# 设置 Python 虚拟环境
setup_python_env() {
    log_info "设置 Python 虚拟环境..."

    if ! command_exists python3; then
        log_warn "未找到 Python3，跳过 Python Bot 环境设置"
        return
    fi

    # 创建虚拟环境
    if [ ! -d "venv" ]; then
        log_info "创建 Python 虚拟环境..."
        python3 -m venv venv
        log_success "虚拟环境创建成功"
    else
        log_success "虚拟环境已存在"
    fi

    # 激活虚拟环境并安装依赖
    log_info "安装 Python 依赖..."
    source venv/bin/activate

    if [ -f "requirements.txt" ]; then
        pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        log_success "Python 依赖安装完成"
    else
        log_warn "未找到 requirements.txt"
    fi

    deactivate
}

# 创建缓存目录
create_cache_dir() {
    log_info "创建缓存目录..."

    CACHE_DIR="/data/cache"
    if [ ! -d "$CACHE_DIR" ]; then
        sudo mkdir -p "$CACHE_DIR" 2>/dev/null || mkdir -p "$CACHE_DIR"
        if [ -d "$CACHE_DIR" ]; then
            log_success "缓存目录创建成功: $CACHE_DIR"
        else
            CACHE_DIR="./cache"
            mkdir -p "$CACHE_DIR"
            log_warn "创建本地缓存目录: $CACHE_DIR"
        fi
    else
        log_success "缓存目录已存在: $CACHE_DIR"
    fi
}

# 启动服务
start_services() {
    echo ""
    log_info "=========================================="
    log_info "      启动 TG 图床系统"
    log_info "=========================================="
    echo ""

    # 编译 Go 程序
    log_info "编译 HTTP 服务..."
    go build -o tg-imagebed main.go
    if [ $? -eq 0 ]; then
        log_success "编译成功"
    else
        log_error "编译失败"
        exit 1
    fi

    # 后台启动 Go HTTP 服务
    log_info "启动 Go HTTP 服务..."
    nohup ./tg-imagebed > http.log 2>&1 &
    HTTP_PID=$!
    echo $HTTP_PID > http.pid
    log_success "HTTP 服务已启动 (PID: $HTTP_PID)"

    # 启动 Python Bot
    if [ -d "venv" ] && [ -f "bot.py" ]; then
        log_info "启动 Telegram Bot..."
        source venv/bin/activate
        nohup python bot.py > bot.log 2>&1 &
        BOT_PID=$!
        echo $BOT_PID > bot.pid
        deactivate
        log_success "Telegram Bot 已启动 (PID: $BOT_PID)"
    else
        log_warn "Python Bot 环境未配置，跳过启动"
    fi

    echo ""
    log_info "=========================================="
    log_success "所有服务启动完成！"
    log_info "=========================================="
    echo ""
    echo "📋 服务状态："
    if [ -f "http.pid" ]; then
        echo "  ✅ HTTP 服务: 运行中 (PID: $(cat http.pid))"
    fi
    if [ -f "bot.pid" ]; then
        echo "  ✅ Telegram Bot: 运行中 (PID: $(cat bot.pid))"
    fi
    echo ""
    echo "📝 日志文件："
    echo "  • HTTP 服务日志: http.log"
    echo "  • Bot 服务日志: bot.log"
    echo ""
    echo "🔧 管理命令："
    echo "  • 查看日志: tail -f http.log"
    echo "  • 停止服务: ./stop.sh"
    echo "  • 重启服务: ./restart.sh"
    echo ""
}

# 主流程
main() {
    echo "=========================================="
    echo "  TG 图床系统 - 一键启动脚本"
    echo "=========================================="
    echo ""

    # 检查配置
    check_config

    # 初始化数据库
    init_database

    # 安装 Go 依赖
    install_go_deps

    # 设置 Python 环境
    setup_python_env

    # 创建缓存目录
    create_cache_dir

    # 启动服务
    start_services
}

# 执行主流程
main
