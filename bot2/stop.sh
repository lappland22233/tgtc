#!/usr/bin/env bash

# Bot2 停止脚本

cd "$(dirname "$0")"

echo "正在停止 Bot2..."

# 停止 Bot
if [ -f "bot.pid" ]; then
    BOT_PID=$(cat bot.pid)
    if ps -p $BOT_PID > /dev/null; then
        kill $BOT_PID
        echo "Bot 已停止 (PID: $BOT_PID)"
    else
        echo "Bot 未运行"
    fi
    rm -f bot.pid
fi

# 停止 HTTP Server
if [ -f "server.pid" ]; then
    SERVER_PID=$(cat server.pid)
    if ps -p $SERVER_PID > /dev/null; then
        kill $SERVER_PID
        echo "HTTP Server 已停止 (PID: $SERVER_PID)"
    else
        echo "HTTP Server 未运行"
    fi
    rm -f server.pid
fi

echo ""
echo "Bot2 已停止"
