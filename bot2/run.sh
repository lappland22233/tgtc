#!/bin/bash

# Bot2 启动脚本

cd "$(dirname "$0")"

# 检查 Python3
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 python3"
    exit 1
fi

# 检查虚拟环境
if [ ! -d "venv" ]; then
    echo "错误: 虚拟环境不存在"
    echo "请先运行 ./init.sh 初始化项目"
    exit 1
fi

# 激活虚拟环境
source venv/bin/activate

# 检查配置文件
if [ ! -f "data.json" ]; then
    echo "错误: 配置文件 data.json 不存在"
    echo "请先复制 data.json.example 并填写配置"
    deactivate
    exit 1
fi

# 检查依赖
if ! python3 -c "import telebot" 2>/dev/null; then
    echo "依赖不完整，正在重新安装..."
    pip install -r requirements.txt -q
    pip install -r requirements_server.txt -q
fi

# 创建日志目录
mkdir -p logs

# 启动 Bot
echo "启动 Bot..."
nohup python3 bot.py > logs/bot.log 2>&1 &
BOT_PID=$!
echo $BOT_PID > bot.pid

# 启动 HTTP Server
echo "启动 HTTP Server..."
nohup python3 server.py > logs/server.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > server.pid

# 退出虚拟环境
deactivate

echo ""
echo "=========================================="
echo "Bot2 启动成功！"
echo "=========================================="
echo "Bot PID: $BOT_PID"
echo "HTTP Server PID: $SERVER_PID"
echo ""
echo "日志文件:"
echo "  - logs/bot.log"
echo "  - logs/server.log"
echo ""
echo "查看日志:"
echo "  tail -f logs/bot.log"
echo "  tail -f logs/server.log"
echo ""
echo "停止服务:"
echo "  ./stop.sh"
echo "=========================================="
