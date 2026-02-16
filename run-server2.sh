#!/bin/bash

# Server2 Go版本启动脚本

cd "$(dirname "$0")"

# 检查 Go
if ! command -v go &> /dev/null; then
    echo "错误: 未找到 go"
    exit 1
fi

# 查找 go.mod（可能在父目录）
SCRIPT_DIR="$(pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
if [ ! -f "$PROJECT_ROOT/go.mod" ]; then
    PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
fi

if [ ! -f "$PROJECT_ROOT/go.mod" ]; then
    echo "错误: 找不到 go.mod 文件"
    echo "请确保在项目根目录或 bot2 目录运行此脚本"
    exit 1
fi

# 检查配置文件
if [ ! -f "$PROJECT_ROOT/data.json" ]; then
    echo "错误: 配置文件 data.json 不存在"
    echo "请先复制 data.json.example 并填写配置"
    exit 1
fi

# 切换到项目根目录
cd "$PROJECT_ROOT"
echo "工作目录: $(pwd)"

# 检查依赖
echo "检查依赖..."
go mod download github.com/go-sql-driver/mysql
go mod download github.com/jmoiron/sqlx
go mod tidy

# 创建日志目录
mkdir -p logs

# 编译 Server
echo "编译 Server..."
go build -o server2 server2.go

if [ $? -ne 0 ]; then
    echo "编译失败"
    exit 1
fi

# 启动 Server
echo "启动 Server..."
nohup ./server2 > logs/server2.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > server2.pid

echo ""
echo "=========================================="
echo "Server2 启动成功！"
echo "=========================================="
echo "Server PID: $SERVER_PID"
echo ""
echo "日志文件:"
echo "  - logs/server2.log"
echo ""
echo "查看日志:"
echo "  tail -f logs/server2.log"
echo ""
echo "停止服务:"
echo "  kill $SERVER_PID"
echo "  或: kill \$(cat server2.pid)"
echo "=========================================="
